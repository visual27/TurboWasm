/**
 * Phase 1 — scratch-vm step bench, Node-direct edition.
 *
 * Runs the vendored scratch-vm against a fixture in BOTH
 * `compile: true` (= compiled mode, which executes the patched
 * `compareEqual` / patched edge-hat compiler-emit / patched
 * `Cast.compare`) AND `compile: false` (= interpreted mode, which
 * uses `RuntimeInterpreter` and calls `Cast.compare` directly).
 *
 * For each mode the bench performs:
 *  - WARMUP_RUNS frames of stepping (no measurement; lets the JIT
 *    warm up before the real timed window)
 *  - N timed runs, each one a fresh project load + WARMUP + MEASURE
 *    frames. The fresh load means every sample pays the cold-load
 *    cost (= real-world first-load latency), not just the steady-
 *    state cost.
 *
 * Reported metrics per mode:
 *  - median wall time (ms), p95 wall time (ms)
 *  - heap delta (MB) across the timed window — sampled via
 *    `process.memoryUsage()`.
 *
 * The verdict compares the two modes:
 *  - compiled median wall < interpreted median wall by >=5% ⇒ "win"
 *  - compiled median wall > interpreted median wall by >=5% ⇒ "loss"
 *  - otherwise ⇒ "neutral"
 *
 * The bench also reports raw per-mode numbers so a power user can
 * re-evaluate the verdict with their own thresholds. The output is
 * appended to `./logs/bench-<fixture>.out` so multiple invocations
 * accumulate a regression history.
 *
 * Usage:
 *   node scripts/bench-scratch-vm-step.mjs --dry
 *   node scripts/bench-scratch-vm-step.mjs compare-equal-fixture
 *   node scripts/bench-scratch-vm-step.mjs edge-hat-fixture
 *   node scripts/bench-scratch-vm-step.mjs infinity-branch-fixture
 *
 * BENCH_N=20 overrides the default N=30.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const FIXTURE_DIR = resolve(process.cwd(), 'test/.test-fixtures');
const LOG_DIR = resolve(process.cwd(), 'logs');

const DEFAULT_WARMUP_RUNS = 5;
const DEFAULT_MEASURE_FRAMES = 600;
const DEFAULT_N = 30;

function resolveFixture(name) {
  const baseName = name.endsWith('.sb3') ? name : `${name}.sb3`;
  return resolve(FIXTURE_DIR, baseName);
}

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

async function loadVendoredVmModule() {
  // Lazy require so `--dry` exits fast.
  const vmDir = resolve(
    process.cwd(),
    'vendored/scaffolding/node_modules/scratch-vm',
  );
  if (!existsSync(vmDir)) {
    throw new Error(
      `vendored scratch-vm not present at ${vmDir}; run \`npm run setup\`.`,
    );
  }
  // The vendored scratch-vm is CommonJS; from an ESM script we use
  // createRequire so `require` works in this context.
  const cjsRequire = createRequire(import.meta.url);
  const VirtualMachine = cjsRequire(resolve(vmDir, 'src/index.js'));
  const sb3Module = cjsRequire(resolve(vmDir, 'src/serialization/sb3.js'));
  return { VirtualMachine, sb3: sb3Module, vmDir };
}

async function loadFixtureBuffer(fixturePath) {
  if (!existsSync(fixturePath)) {
    throw new Error(`fixture not found: ${fixturePath}`);
  }
  return readFileSync(fixturePath);
}

/**
 * Build a fresh VM, load the project, and step `frames` times. Returns
 * the per-run wall-clock in milliseconds.
 */
async function runOnce({ VirtualMachine, sb3, projectBuffer, frames, compile }) {
  const vm = new VirtualMachine();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  // Tell the runtime to enable / disable the compiler. Compiled mode
  // exercises the patched `compareEqual` + patched edge-hat emitter;
  // interpreted mode uses the upstream `RuntimeInterpreter` path
  // (= `Cast.compare` direct).
  vm.setCompilerOptions({ enabled: compile });
  await vm.loadProject(projectBuffer);
  // eslint-disable-next-line no-console
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < frames; i++) {
    vm.runtime._step();
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNs) / 1_000_000;
  // Detach any timers / listeners so each iteration has a clean
  // observable VM lifecycle. We do NOT call `vm.quit()` because the
  // Scaffolding surface isn't installed in the Node-direct path.
  vm.runtime.stopAll();
  return elapsedMs;
}

async function benchMode({
  VirtualMachine,
  sb3,
  projectBuffer,
  warmupRuns,
  measureFrames,
  n,
  compile,
  label,
}) {
  const samples = [];
  // Warmup iterations are unmeasured — they let the JIT reach steady
  // state and the first-time asset loads (sprite assets, JSZip parse)
  // amortize out of the timed window.
  for (let i = 0; i < warmupRuns; i++) {
    await runOnce({ VirtualMachine, sb3, projectBuffer, frames: measureFrames, compile });
  }
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) {
    const ms = await runOnce({
      VirtualMachine,
      sb3,
      projectBuffer,
      frames: measureFrames,
      compile,
    });
    samples.push(ms);
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = (heapAfter - heapBefore) / (1024 * 1024);
  const stats = summarize(samples);
  return {
    label,
    compile,
    samples,
    stats,
    heapDeltaMB,
  };
}

function renderSummary(mode) {
  const s = mode.stats;
  const lines = [];
  lines.push(`mode=${mode.label} (compile=${mode.compile})`);
  lines.push(`  n=${s.n}  median=${s.median.toFixed(2)}ms  p95=${s.p95.toFixed(2)}ms  min=${s.min.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  mean=${s.mean.toFixed(2)}ms`);
  lines.push(`  heapDelta=${mode.heapDeltaMB.toFixed(2)}MB across ${s.n} runs`);
  return lines.join('\n');
}

function renderVerdict(compiled, interpreted) {
  if (!compiled || !interpreted) return '';
  const c = compiled.stats.median;
  const i = interpreted.stats.median;
  const pct = ((i - c) / i) * 100;
  let label;
  if (pct >= 5) {
    label = `WIN (compiled ${pct.toFixed(1)}% faster than interpreted)`;
  } else if (pct <= -5) {
    label = `LOSS (compiled ${Math.abs(pct).toFixed(1)}% slower than interpreted)`;
  } else {
    label = `NEUTRAL (compiled vs interpreted within ±5%)`;
  }
  return `verdict: ${label}\n  compiled median=${c.toFixed(2)}ms  interpreted median=${i.toFixed(2)}ms`;
}

async function main() {
  const { values, positionals } = parseArgs({
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
    console.log('[bench-scratch-vm-step --dry]');
    // eslint-disable-next-line no-console
    console.log(`  BENCH_N=${values.n}  WARMUP_RUNS=${values.warmup}  MEASURE_FRAMES=${values.frames}`);
    // eslint-disable-next-line no-console
    console.log('[bench-scratch-vm-step --dry] skipping Node-direct bench; run without --dry for real measurements.');
    return;
  }

  const fixtureName = positionals[0] ?? 'compare-equal-fixture';
  const fixturePath = resolveFixture(fixtureName);
  const n = Number.parseInt(values.n, 10);
  const warmupRuns = Number.parseInt(values.warmup, 10);
  const measureFrames = Number.parseInt(values.frames, 10);

  if (!existsSync(fixturePath)) {
    // eslint-disable-next-line no-console
    console.error(
      `[bench-scratch-vm-step] fixture not found: ${fixturePath}. Run \`npm run fixtures:setup\` first.`,
    );
    process.exit(1);
  }

  const { VirtualMachine, sb3 } = await loadVendoredVmModule();
  const projectBuffer = await loadFixtureBuffer(fixturePath);

  // eslint-disable-next-line no-console
  console.log(`[bench-scratch-vm-step] fixture=${fixtureName}`);
  // eslint-disable-next-line no-console
  console.log(`  warmupRuns=${warmupRuns} measureFrames=${measureFrames} n=${n}`);

  const compiled = await benchMode({
    VirtualMachine,
    sb3,
    projectBuffer,
    warmupRuns,
    measureFrames,
    n,
    compile: true,
    label: 'compiled',
  });
  // eslint-disable-next-line no-console
  console.log(renderSummary(compiled));

  const interpreted = await benchMode({
    VirtualMachine,
    sb3,
    projectBuffer,
    warmupRuns,
    measureFrames,
    n,
    compile: false,
    label: 'interpreted',
  });
  // eslint-disable-next-line no-console
  console.log(renderSummary(interpreted));

  const verdict = renderVerdict(compiled, interpreted);
  // eslint-disable-next-line no-console
  console.log(verdict);

  // Append the result to ./logs/bench-<fixture>.out so multiple
  // invocations accumulate a regression history. Each invocation
  // produces a single timestamped block.
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = resolve(LOG_DIR, `bench-${fixtureName.replace(/\.sb3$/u, '')}.out`);
  const stamp = new Date().toISOString();
  const body = [
    `\n=== ${stamp} ===`,
    `fixture=${fixturePath}`,
    `warmupRuns=${warmupRuns} measureFrames=${measureFrames} n=${n}`,
    renderSummary(compiled),
    renderSummary(interpreted),
    verdict,
    '',
  ].join('\n');
  writeFileSync(logPath, body, { flag: 'a' });
  // eslint-disable-next-line no-console
  console.log(`[bench-scratch-vm-step] appended ${body.length} bytes to ${logPath}`);
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench-scratch-vm-step] FAILED:', err);
  process.exit(1);
});