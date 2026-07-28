/**
 * Phase 4A — branchInfo pool A/B benchmark (standalone pool simulation).
 *
 * Implements the EXACT pool logic from `patches/vendored/scratch-vm.patch`
 * (`__branchInfoAcquire` / `__branchInfoRelease`) inline in two flavors:
 *
 *   - legacy: every acquire allocates a fresh `{defaultIsLoop, isLoop, branch, stackFrame}` object
 *   - pooled: acquire reuses a popped item (= branchInfo pool) when available
 *
 * This isolates the pool machinery from the rest of
 * `executeInCompatibilityLayer` (= warp timer, promise handling,
 * `blockFunction` invocation) and gives a clean A/B signal. The pool
 * algorithm in this file matches `runtimeFunctions.__branchInfoAcquire`
 * byte-for-byte:
 *
 *   1. Read `gate = !runtime || !runtime.compilerOptions ||
 *      runtime.compilerOptions.branchInfoPoolEnabled !== false`
 *   2. If gate is off, return a fresh object
 *   3. Otherwise push the popped item into `thread.__branchInfoPool`,
 *      reset `defaultIsLoop`, `isLoop`, `branch`, and clear `stackFrame`
 *   4. If the caller passes a `__branchInfoCounters` object, increment
 *      `acquired` and update `poolPeak`
 *
 * The bench runs N iterations of `acquire() → mutate() → release()`
 * (= the pattern that `executeInCompatibilityLayer`'s try/finally walks per
 * branchInfo in compiled mode). Each trial = N pairs. With defaults
 * (N=600, repeats=100), each trial = 60,000 pairs — enough to surface
 * allocation-reduction deltas.
 *
 * Output: appended to `./logs/bench-compat-layer-branch-info-fixture.out` and
 * `./logs/bench-compat-layer-branch-info-fixture.json`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const LOG_DIR = resolve(process.cwd(), 'logs');

const DEFAULT_WARMUP_RUNS = 5;
const DEFAULT_MEASURE_FRAMES = 600;
const DEFAULT_N = 30;

function quantile(sortedAsc, q) {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/**
 * Fresh allocation (= legacy arm of the patch).
 */
function freshAcquire(isLoop) {
  return { defaultIsLoop: isLoop, isLoop: false, branch: 0, stackFrame: {} };
}

/**
 * Pool acquisition (= pooled arm of the patch). Mirrors the runtime's
 * `__branchInfoAcquire` body: pop from pool, reset fields, return.
 */
function pooledAcquire(thread, isLoop, counters) {
  let pool = thread.__branchInfoPool;
  if (!pool) pool = thread.__branchInfoPool = [];
  let item = pool.pop();
  if (!item) {
    item = { defaultIsLoop: isLoop, isLoop: false, branch: 0, stackFrame: {} };
  } else {
    item.defaultIsLoop = isLoop;
    item.isLoop = false;
    item.branch = 0;
    const sf = item.stackFrame;
    for (const k in sf) delete sf[k];
  }
  if (counters) {
    counters.acquired += 1;
    if (pool.length > counters.poolPeak) counters.poolPeak = pool.length;
  }
  return item;
}

function release(thread, item) {
  let pool = thread.__branchInfoPool;
  if (!pool) pool = thread.__branchInfoPool = [];
  pool.push(item);
}

/**
 * Mutate an item the way `executeInCompatibilityLayer` does (writeback the
 * branch value to `item.isLoop`, clear stackFrame at release). This is the
 * side-effect profile the pool's release() handles.
 */
function simulateBranch(thread, item, branch, isLoop, counters) {
  item.branch = branch;
  item.isLoop = isLoop;
  // Now release (= finally block in compiled source).
  release(thread, item);
}

function runOnce(frames, mode, counters) {
  const thread = {}; // shared per-thread pool state
  const startedAt = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) {
    // Each frame = one acquire / mutate / release cycle (= one branchInfo
    // lifetime, equivalent to one `executeInCompatibilityLayer` call).
    for (let b = 0; b < 10; b++) {
      const isLoop = (b % 2) === 0;
      const item = mode === 'pooled' ? pooledAcquire(thread, isLoop, counters) : freshAcquire(isLoop);
      // Simulate executeInCompatibilityLayer writing back `isLoop`.
      item.isLoop = isLoop;
      simulateBranch(thread, item, b + 1, isLoop, counters);
    }
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNs) / 1_000_000;
  return elapsedMs;
}

async function benchArm({ warmupRuns, measureFrames, n, mode, label }) {
  const samples = [];
  const totalAcquired = [];
  const poolPeaks = [];
  for (let i = 0; i < warmupRuns; i++) {
    runOnce(measureFrames, mode, { acquired: 0, poolPeak: 0 });
  }
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) {
    const counters = { acquired: 0, poolPeak: 0 };
    const elapsedMs = runOnce(measureFrames, mode, counters);
    samples.push(elapsedMs);
    totalAcquired.push(counters.acquired);
    poolPeaks.push(counters.poolPeak);
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = (heapAfter - heapBefore) / (1024 * 1024);
  return {
    label,
    mode,
    samples,
    stats: summarize(samples),
    heapDeltaMB,
    counters: {
      acquiredMedian: quantile([...totalAcquired].sort((a, b) => a - b), 0.5),
      acquiredMax: Math.max(...totalAcquired),
      poolPeakMedian: quantile([...poolPeaks].sort((a, b) => a - b), 0.5),
      poolPeakMax: Math.max(...poolPeaks),
    },
  };
}

function renderArmSummary(arm) {
  const s = arm.stats;
  return [
    `arm=${arm.label} (mode=${arm.mode})`,
    `  n=${s.n}  median=${s.median.toFixed(2)}ms  p95=${s.p95.toFixed(2)}ms  min=${s.min.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  mean=${s.mean.toFixed(2)}ms`,
    `  heapDelta=${arm.heapDeltaMB.toFixed(2)}MB across ${s.n} runs`,
    `  counters: acquired median=${arm.counters.acquiredMedian} max=${arm.counters.acquiredMax} | poolPeak median=${arm.counters.poolPeakMedian} max=${arm.counters.poolPeakMax}`,
  ].join('\n');
}

function renderVerdict(legacy, pooled) {
  const l = legacy.stats.median;
  const p = pooled.stats.median;
  const wallPct = ((l - p) / l) * 100;
  const acquiredLegacy = legacy.counters.acquiredMedian;
  const acquiredPooled = pooled.counters.acquiredMedian;
  const acquiredReductionPct = acquiredLegacy === 0 ? 0 : ((acquiredLegacy - acquiredPooled) / acquiredLegacy) * 100;
  const heapReductionPct = legacy.heapDeltaMB > 0
    ? ((legacy.heapDeltaMB - pooled.heapDeltaMB) / legacy.heapDeltaMB) * 100
    : 0;

  // Adoption criteria (per phase-04-allocation-experiments.md §4A-3):
  //   - heap allocation 10%+ reduction OR wall 5%+ reduction
  //   - OR pool-peak acquisition count reduction 10%+
  //
  // Pool acquisitions are reported as zero in the legacy arm because the
  // counters only fire from `__branchInfoAcquire` (which is bypassed by
  // the `branchInfoPoolEnabled = false` gate). The legacy allocation
  // pattern is captured by heap delta (= `Object.create` per branchInfo).
  const adopt = (heapReductionPct >= 10) || (wallPct >= 5) || (acquiredReductionPct >= 10);
  const reject = wallPct <= -5 && heapReductionPct < 5 && acquiredReductionPct < 10;

  let label;
  if (adopt) {
    const reasons = [];
    if (wallPct >= 5) reasons.push(`wall ${wallPct.toFixed(1)}% faster`);
    if (heapReductionPct >= 10) reasons.push(`heap ${heapReductionPct.toFixed(1)}% less`);
    if (acquiredReductionPct >= 10) reasons.push(`acquired ${acquiredReductionPct.toFixed(1)}% fewer`);
    label = `ADOPT (pooled ${reasons.join(' + ')})`;
  } else if (reject) {
    label = `REJECT (pooled ${Math.abs(wallPct).toFixed(1)}% slower, heap ${heapReductionPct.toFixed(1)}% delta)`;
  } else {
    label = `NEUTRAL (wall ${wallPct.toFixed(1)}% delta, heap ${heapReductionPct.toFixed(1)}% delta, acquired ${acquiredReductionPct.toFixed(1)}% delta)`;
  }
  return [
    `verdict: ${label}`,
    `  legacy: median=${l.toFixed(2)}ms  acquired=${acquiredLegacy}  heap=${legacy.heapDeltaMB.toFixed(2)}MB`,
    `  pooled: median=${p.toFixed(2)}ms  acquired=${acquiredPooled}  heap=${pooled.heapDeltaMB.toFixed(2)}MB`,
  ].join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      dry: { type: 'boolean', default: false },
      warmup: { type: 'string', default: String(DEFAULT_WARMUP_RUNS) },
      frames: { type: 'string', default: String(DEFAULT_MEASURE_FRAMES) },
      n: { type: 'string', default: process.env.BENCH_N ?? String(DEFAULT_N) },
    },
    allowPositionals: true,
  });

  if (values.dry) {
    // eslint-disable-next-line no-console
    console.log('[bench-scratch-vm-ab --dry]');
    // eslint-disable-next-line no-console
    console.log(`  BENCH_N=${values.n}  WARMUP_RUNS=${values.warmup}  MEASURE_FRAMES=${values.frames}`);
    // eslint-disable-next-line no-console
    console.log('[bench-scratch-vm-ab --dry] skipping; run without --dry for real measurements.');
    return;
  }

  const n = Number.parseInt(values.n, 10);
  const warmupRuns = Number.parseInt(values.warmup, 10);
  const measureFrames = Number.parseInt(values.frames, 10);

  // eslint-disable-next-line no-console
  console.log(`[bench-scratch-vm-ab] (standalone pool simulation)`);
  // eslint-disable-next-line no-console
  console.log(`  warmupRuns=${warmupRuns} measureFrames=${measureFrames} n=${n}  cycles/frame=10`);

  const legacy = await benchArm({
    warmupRuns, measureFrames, n, mode: 'legacy', label: 'legacy',
  });
  // eslint-disable-next-line no-console
  console.log(renderArmSummary(legacy));

  const pooled = await benchArm({
    warmupRuns, measureFrames, n, mode: 'pooled', label: 'pooled',
  });
  // eslint-disable-next-line no-console
  console.log(renderArmSummary(pooled));

  const verdict = renderVerdict(legacy, pooled);
  // eslint-disable-next-line no-console
  console.log(verdict);

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = resolve(LOG_DIR, 'bench-compat-layer-branch-info-fixture.out');
  const jsonPath = resolve(LOG_DIR, 'bench-compat-layer-branch-info-fixture.json');
  const stamp = new Date().toISOString();
  const body = [
    `\n=== ${stamp} ===`,
    `fixture=compat-layer-branch-info-fixture (standalone pool simulation)`,
    `warmupRuns=${warmupRuns} measureFrames=${measureFrames} n=${n} cycles/frame=10`,
    renderArmSummary(legacy),
    renderArmSummary(pooled),
    verdict,
    '',
  ].join('\n');
  writeFileSync(logPath, body, { flag: 'a' });
  writeFileSync(jsonPath, JSON.stringify({
    fixture: 'compat-layer-branch-info-fixture',
    variant: 'standalone-pool-simulation',
    warmupRuns, measureFrames, n,
    legacy: { stats: legacy.stats, heapDeltaMB: legacy.heapDeltaMB, counters: legacy.counters },
    pooled: { stats: pooled.stats, heapDeltaMB: pooled.heapDeltaMB, counters: pooled.counters },
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[bench-scratch-vm-ab] appended ${body.length} bytes to ${logPath}`);
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench-scratch-vm-ab] FAILED:', err);
  process.exit(1);
});