/**
 * Phase 4B — Map conversion evaluation (microbench).
 *
 * Phase 4B evaluates whether converting `Target.variables` / `Target._customState`
 * / `Thread.procedures` / `Blocks._cache.*` from plain `{}` to `Object.create(null)`
 * / `Map` / a hybrid `{}`+local cache reduces per-frame allocation and lookup
 * overhead. Per `phase-04-allocation-experiments.md` §4B-2:
 *
 *   - This phase is EVALUATION ONLY. The verdict decides whether to ship
 *     a follow-up patch (= "Phase 5: Map conversion").
 *   - If the verdict is negative, the `Object.create(null)`/`Map` hunk
 *     is NOT added to the patch.
 *
 * The bench evaluates only the THREE high-frequency paths that survive the
 * §4B-6 "realistic adoption" filter:
 *
 *   1. `Target.variables` — 100 keys (= typical project), lookup + insert + delete
 *   2. `Thread.procedures` — 4 keys (= warp/non-warp-disambiguated variants)
 *   3. `Blocks._cache.compiledScripts` — 50 keys (= script cache per target)
 *
 * For each path we measure 4 candidates:
 *
 *   - plain   : `{}` (the current vendored implementation)
 *   - null-proto: `Object.create(null)` (no proto chain walk, no `__proto__` key collision)
 *   - Map     : `new Map()` (object-stable keys, hidden classes don't grow)
 *   - hybrid  : `{}` + cached .size accessor (= hot-path optimization only)
 *
 * Bench scope: each trial = 100,000 mixed lookup/insert/delete ops. We
 * report median wall time across N trials (= 30 by default) and the
 * relative delta vs `plain`. The verdict is neutral-or-better; we do NOT
 * recommend adoption if wall/heap is within 5%.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const LOG_DIR = resolve(process.cwd(), 'logs');

const DEFAULT_WARMUP_RUNS = 5;
const DEFAULT_OPS_PER_TRIAL = 100_000;
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

// === mixed op cycle helpers ============================================

function makePlainObject(initial) {
  return { ...initial };
}
function makeNullProtoObject(initial) {
  return Object.assign(Object.create(null), initial);
}
function makeMap(initial) {
  const m = new Map();
  for (const [k, v] of Object.entries(initial)) m.set(k, v);
  return m;
}
function makeHybrid(initial) {
  // Hybrid: plain `{}` + cached size. (= local hot-path optimization only.)
  const o = { ...initial };
  let size = Object.keys(o).length;
  return {
    o,
    size() { return size; },
  };
}

// === per-path op cycles ================================================

/**
 * `Target.variables`-shaped workload: 100-key scalar map. Workload =
 *   - 70% `hasOwnProperty` lookup
 *   - 20% insert (= setvariable)
 *   - 10% delete (= delvariable)
 */
function benchVariables(name, factory, opsPerTrial) {
  const initial = {};
  for (let i = 0; i < 100; i += 1) initial[`var${i}`] = { id: `var${i}`, name: `v${i}`, value: i };
  const data = factory(initial);
  return runBench(name, data, opsPerTrial, (data, i) => {
    const key = `var${i % 100}`;
    if (i % 10 < 7) {
      // lookup
      if (data instanceof Map) data.get(key);
      else if (data && typeof data.o === 'object') data.o[key];
      else data[key];
    } else if (i % 10 < 9) {
      // insert
      if (data instanceof Map) data.set(key, { id: key, name: key, value: i });
      else if (data && typeof data.o === 'object') data.o[key] = { id: key, name: key, value: i };
      else data[key] = { id: key, name: key, value: i };
    } else {
      // delete (then re-insert so the next lookup still has a value)
      if (data instanceof Map) data.delete(key);
      else if (data && typeof data.o === 'object') delete data.o[key];
      else delete data[key];
      if (data instanceof Map) data.set(key, { id: key, name: key, value: i });
      else if (data && typeof data.o === 'object') data.o[key] = { id: key, name: key, value: i };
      else data[key] = { id: key, name: key, value: i };
    }
  });
}

/**
 * `Thread.procedures`-shaped workload: 4-key Map (warp + non-warp variants).
 * Workload = 100% lookup (`procedures[variant](...)` hot path).
 */
function benchProcedures(name, factory, opsPerTrial) {
  const initial = {
    'Zadd_one %s': () => 1,
    'Zadd_one_warp %s': () => 1,
    'Zfactorial %n': () => 1,
    'Zfactorial_warp %n': () => 1,
  };
  const data = factory(initial);
  return runBench(name, data, opsPerTrial, (data, i) => {
    const variants = ['Zadd_one %s', 'Zadd_one_warp %s', 'Zfactorial %n', 'Zfactorial_warp %n'];
    const key = variants[i % 4];
    if (data instanceof Map) data.get(key);
    else if (data && typeof data.o === 'object') data.o[key];
    else data[key];
  });
}

/**
 * `Blocks._cache.compiledScripts`-shaped workload: 50-key string-keyed map.
 * Workload = 80% lookup, 20% insert.
 */
function benchCompiledScripts(name, factory, opsPerTrial) {
  const initial = {};
  for (let i = 0; i < 50; i += 1) initial[`script${i}`] = { success: true, value: { generator: () => ({}), procedures: {} } };
  const data = factory(initial);
  return runBench(name, data, opsPerTrial, (data, i) => {
    const key = `script${i % 50}`;
    if (i % 5 < 4) {
      if (data instanceof Map) data.get(key);
      else if (data && typeof data.o === 'object') data.o[key];
      else data[key];
    } else {
      if (data instanceof Map) data.set(key, { success: true, value: {} });
      else if (data && typeof data.o === 'object') data.o[key] = { success: true, value: {} };
      else data[key] = { success: true, value: {} };
    }
  });
}

function runBench(name, data, opsPerTrial, opFn) {
  const startedAt = process.hrtime.bigint();
  for (let i = 0; i < opsPerTrial; i += 1) opFn(data, i);
  const elapsedNs = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNs) / 1_000_000;
  return { name, elapsedMs, opsPerTrial };
}

async function benchPath(benchFn, warmupRuns, opsPerTrial, n, name) {
  const factories = [
    { mode: 'plain', fn: makePlainObject },
    { mode: 'null-proto', fn: makeNullProtoObject },
    { mode: 'Map', fn: makeMap },
    { mode: 'hybrid', fn: makeHybrid },
  ];
  const results = {};
  for (const { mode, fn } of factories) {
    const samples = [];
    for (let i = 0; i < warmupRuns; i += 1) benchFn(`${name}:${mode}`, fn, opsPerTrial);
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i += 1) {
      samples.push(benchFn(`${name}:${mode}`, fn, opsPerTrial).elapsedMs);
    }
    const heapAfter = process.memoryUsage().heapUsed;
    results[mode] = {
      ...summarize(samples),
      heapDeltaMB: (heapAfter - heapBefore) / (1024 * 1024),
    };
  }
  return results;
}

function relativeDelta(baseline, candidate) {
  const base = baseline.median;
  const cand = candidate.median;
  if (base === 0) return 0;
  return ((base - cand) / base) * 100;
}

function verdict(baseline, candidate) {
  const wallPct = relativeDelta(baseline, candidate);
  const heapPct = baseline.heapDeltaMB > 0
    ? ((baseline.heapDeltaMB - candidate.heapDeltaMB) / baseline.heapDeltaMB) * 100
    : 0;
  if (wallPct >= 5 || heapPct >= 10) return `ADOPT (wall ${wallPct.toFixed(1)}%, heap ${heapPct.toFixed(1)}%)`;
  if (wallPct <= -5) return `REJECT (wall ${wallPct.toFixed(1)}% slower)`;
  return `NEUTRAL (wall ${wallPct.toFixed(1)}%, heap ${heapPct.toFixed(1)}%)`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dry: { type: 'boolean', default: false },
      warmup: { type: 'string', default: String(DEFAULT_WARMUP_RUNS) },
      ops: { type: 'string', default: String(DEFAULT_OPS_PER_TRIAL) },
      n: { type: 'string', default: process.env.BENCH_N ?? String(DEFAULT_N) },
    },
    allowPositionals: true,
  });

  if (values.dry) {
    // eslint-disable-next-line no-console
    console.log('[bench-map-eval --dry]');
    // eslint-disable-next-line no-console
    console.log(`  BENCH_N=${values.n}  WARMUP_RUNS=${values.warmup}  OPS_PER_TRIAL=${values.ops}`);
    // eslint-disable-next-line no-console
    console.log('[bench-map-eval --dry] skipping; run without --dry for real measurements.');
    return;
  }

  const n = Number.parseInt(values.n, 10);
  const warmupRuns = Number.parseInt(values.warmup, 10);
  const opsPerTrial = Number.parseInt(values.ops, 10);

  // eslint-disable-next-line no-console
  console.log(`[bench-map-eval] (Phase 4B evaluation)`);
  // eslint-disable-next-line no-console
  console.log(`  warmupRuns=${warmupRuns} opsPerTrial=${opsPerTrial} n=${n}`);

  const paths = [
    { name: 'Target.variables (100 keys)', fn: benchVariables },
    { name: 'Thread.procedures (4 keys)', fn: benchProcedures },
    { name: 'Blocks._cache.compiledScripts (50 keys)', fn: benchCompiledScripts },
  ];

  const results = {};
  for (const { name, fn } of paths) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${name} ===`);
    const r = await benchPath(fn, warmupRuns, opsPerTrial, n, name);
    results[name] = r;
    // eslint-disable-next-line no-console
    for (const mode of ['plain', 'null-proto', 'Map', 'hybrid']) {
      const stats = r[mode];
      const base = r.plain;
      // eslint-disable-next-line no-console
      console.log(`  ${mode.padEnd(10)} median=${stats.median.toFixed(2)}ms  heap=${stats.heapDeltaMB.toFixed(2)}MB  vs plain=${relativeDelta(base, stats).toFixed(1)}%`);
    }
    // eslint-disable-next-line no-console
    console.log(`  verdict (null-proto vs plain): ${verdict(r.plain, r['null-proto'])}`);
    // eslint-disable-next-line no-console
    console.log(`  verdict (Map vs plain): ${verdict(r.plain, r.Map)}`);
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = resolve(LOG_DIR, 'bench-map-eval.out');
  const jsonPath = resolve(LOG_DIR, 'bench-map-eval.json');
  const stamp = new Date().toISOString();
  const body = [
    `\n=== ${stamp} ===`,
    `warmupRuns=${warmupRuns} opsPerTrial=${opsPerTrial} n=${n}`,
    JSON.stringify(results, null, 2),
    '',
  ].join('\n');
  writeFileSync(logPath, body, { flag: 'a' });
  writeFileSync(jsonPath, JSON.stringify({
    warmupRuns, opsPerTrial, n, results,
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[bench-map-eval] appended ${body.length} bytes to ${logPath}`);
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench-map-eval] FAILED:', err);
  process.exit(1);
});