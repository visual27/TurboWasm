#!/usr/bin/env node
/**
 * §Phase 5 (scheduler research) — bench harness.
 *
 * Compares three scheduler variants on `clone-storm-fixture.sb3`
 * (= high-frequency thread churn: 50 clones × 10 broadcasts/frame
 * × 1 tick thread per (broadcast, clone) pair = ~520 thread
 * starts/terminations per frame at steady state) and a few
 * baseline fixtures for cross-validation.
 *
 * Variants
 * --------
 * - `baseline` — current vendored scratch-vm. Sequencer inner-loop
 *   compaction handles STATUS_DONE; Runtime._step pre-step
 *   compaction handles `isKilled`. Two compaction passes per step.
 * - `eval-A` — Sequencer compaction removed (= sequencer only
 *   computes `doneThreads` for `_updateGlows` / `_lastStepDoneThreads`);
 *   Runtime._step pre-step compaction extended to cover STATUS_DONE
 *   threads as well as `isKilled`. Single compaction pass per step,
 *   owned by Runtime._step.
 * - `eval-B` — Runtime._step pre-step compaction removed; Sequencer
 *   inner-loop compaction extended to cover `isKilled` threads as
 *   well as STATUS_DONE. Single compaction pass per step, owned by
 *   Sequencer.
 *
 * Variants are installed via runtime monkey-patching (= vendored
 * scratch-vm Runtime + Sequencer prototypes). The reference patches
 * (`patches/vendored/scratch-vm-eval-scheduler-{A,B}.patch`) are
 * NOT auto-applied; the monkey-patches mirror their content so we
 * can A/B compare without rebuilding the UMD.
 *
 * Usage
 * -----
 *   node scripts/bench-scheduler-eval.mjs                  # all fixtures × all variants, N=10
 *   node scripts/bench-scheduler-eval.mjs --dry            # print config + exit
 *   node scripts/bench-scheduler-eval.mjs clone-storm      # one fixture × all variants
 *   node scripts/bench-scheduler-eval.mjs --variant baseline  # one variant × all fixtures
 *   BENCH_N=30 node scripts/bench-scheduler-eval.mjs        # N=30
 *
 * Output
 * ------
 * - Per-run samples appended to `./logs/bench-scheduler-eval.out`
 *   (regression history)
 * - Per-run JSON snapshots written to
 *   `C:/files/memo/scratch-vm-optimization/raw/bench-{fixture}-{variant}-{timestamp}.json`
 *   (= Phase 5 analysis raw data, picked up by the final report
 *   writer)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const FIXTURE_DIR = resolve(REPO_ROOT, 'test/.test-fixtures');
const LOG_DIR = resolve(REPO_ROOT, 'logs');
const MEMO_DIR = 'C:/files/memo/scratch-vm-optimization/raw';

const DEFAULT_WARMUP_RUNS = 5;
const DEFAULT_MEASURE_FRAMES = 300;
const DEFAULT_N = 15;

/**
 * @typedef {'baseline' | 'eval-A' | 'eval-B'} Variant
 */
const VARIANTS = ['baseline', 'eval-A', 'eval-B'];

const FIXTURES = [
  'clone-storm-fixture.sb3',
  'compare-equal-fixture.sb3',
  'expo-fixture.sb3',
  'bench-touching.sb3',
];

/**
 * @param {string} name
 */
function resolveFixture(name) {
  return resolve(FIXTURE_DIR, name);
}

/**
 * @param {number[]} sortedAsc
 * @param {number} q
 */
function quantile(sortedAsc, q) {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx];
}

/**
 * @param {number[]} samplesMs
 */
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
    samples: sorted,
  };
}

/**
 * Patch the vendored scratch-vm runtime + sequencer to mimic the
 * scheduler-eval-{A,B}.patch reference patches. Returns a teardown
 * function that restores the originals.
 */
function installVariant(
  /** @type {any} */ runtime,
  /** @type {any} */ sequencer,
  /** @type {Variant} */ variant,
) {
  const originalStepThreads = sequencer.stepThreads.bind(sequencer);
  const originalStep = runtime._step.bind(runtime);

  if (variant === 'baseline') {
    return () => undefined;
  }

  if (variant === 'eval-A') {
    // Sequencer compaction removed, Runtime._step extended.
    sequencer.stepThreads = function evalAStepThreads() {
      const WORK_TIME = 0.75 * this.runtime.currentStepTime;
      this.runtime.updateCurrentMSecs();
      this.timer.start();
      let numActiveThreads = Infinity;
      let ranFirstTick = false;
      const doneThreads = this._doneThreads;
      doneThreads.length = 0;
      while (
        this.runtime.threads.length > 0 &&
        numActiveThreads > 0 &&
        this.timer.timeElapsed() < WORK_TIME &&
        (this.runtime.turboMode || !this.runtime.redrawRequested)
      ) {
        if (this.runtime.profiler !== null) {
          this.runtime.profiler.stop();
        }
        numActiveThreads = 0;
        let stoppedThread = false;
        const threads = this.runtime.threads;
        for (let i = 0; i < threads.length; i++) {
          const activeThread = (this.activeThread = threads[i]);
          if (
            activeThread.stack.length === 0 ||
            activeThread.status === 4
          ) {
            stoppedThread = true;
            continue;
          }
          if (activeThread.status === 3 && !ranFirstTick) {
            activeThread.status = 0;
          }
          if (
            activeThread.status === 0 ||
            activeThread.status === 2
          ) {
            this.stepThread(activeThread);
            activeThread.warpTimer = null;
          }
          if (activeThread.status === 0) numActiveThreads++;
          if (
            activeThread.stack.length === 0 ||
            activeThread.status === 4
          ) {
            stoppedThread = true;
          }
        }
        ranFirstTick = true;
        if (stoppedThread) {
          for (let i = 0; i < this.runtime.threads.length; i++) {
            const thread = this.runtime.threads[i];
            if (
              thread.stack.length === 0 ||
              thread.status === 4
            ) {
              this.runtime.threadMap.delete(thread.getId());
              doneThreads.push(thread);
            }
          }
        }
      }
      this.activeThread = null;
      return doneThreads;
    };
    runtime._step = function evalAStep() {
      const threads = this.threads;
      let needsCompaction = false;
      for (let i = 0; i < threads.length; i++) {
        if (threads[i].isKilled || threads[i].status === 4) {
          needsCompaction = true;
          break;
        }
      }
      if (needsCompaction) {
        let writeIndex = 0;
        for (let readIndex = 0; readIndex < threads.length; readIndex++) {
          const thread = threads[readIndex];
          if (thread.isKilled || thread.status === 4) {
            if (!thread.stackClick && !thread.updateMonitor) {
              this.threadMap.delete(thread.getId());
            }
          } else {
            threads[writeIndex++] = thread;
          }
        }
        threads.length = writeIndex;
      }
      return originalStep.call(this);
    };
  }

  if (variant === 'eval-B') {
    // Runtime._step compaction removed, Sequencer compaction extended to isKilled.
    sequencer.stepThreads = function evalBStepThreads() {
      const WORK_TIME = 0.75 * this.runtime.currentStepTime;
      this.runtime.updateCurrentMSecs();
      this.timer.start();
      let numActiveThreads = Infinity;
      let ranFirstTick = false;
      const doneThreads = this._doneThreads;
      doneThreads.length = 0;
      while (
        this.runtime.threads.length > 0 &&
        numActiveThreads > 0 &&
        this.timer.timeElapsed() < WORK_TIME &&
        (this.runtime.turboMode || !this.runtime.redrawRequested)
      ) {
        if (this.runtime.profiler !== null) {
          this.runtime.profiler.stop();
        }
        numActiveThreads = 0;
        let stoppedThread = false;
        const threads = this.runtime.threads;
        for (let i = 0; i < threads.length; i++) {
          const activeThread = (this.activeThread = threads[i]);
          if (
            activeThread.stack.length === 0 ||
            activeThread.status === 4 ||
            activeThread.isKilled
          ) {
            stoppedThread = true;
            continue;
          }
          if (activeThread.status === 3 && !ranFirstTick) {
            activeThread.status = 0;
          }
          if (
            activeThread.status === 0 ||
            activeThread.status === 2
          ) {
            this.stepThread(activeThread);
            activeThread.warpTimer = null;
          }
          if (activeThread.status === 0) numActiveThreads++;
          if (
            activeThread.stack.length === 0 ||
            activeThread.status === 4
          ) {
            stoppedThread = true;
          }
        }
        ranFirstTick = true;
        if (stoppedThread) {
          let nextActiveThread = 0;
          for (let i = 0; i < this.runtime.threads.length; i++) {
            const thread = this.runtime.threads[i];
            if (
              thread.stack.length !== 0 &&
              thread.status !== 4 &&
              !thread.isKilled
            ) {
              this.runtime.threads[nextActiveThread] = thread;
              nextActiveThread++;
            } else {
              this.runtime.threadMap.delete(thread.getId());
              doneThreads.push(thread);
            }
          }
          this.runtime.threads.length = nextActiveThread;
        }
      }
      this.activeThread = null;
      return doneThreads;
    };
    // Eval-B _step — strip the pre-step compaction block. Same
    // approach as eval-B test: re-implement the post-compaction
    // body inline. The vendored scratch-vm's Runtime class is
    // imported lazily inside the override (= match `runtime.constructor`
    // for the static event names).
    const RuntimeCtor = runtime.constructor;
    const BEFORE_EXECUTE = RuntimeCtor.BEFORE_EXECUTE;
    const AFTER_EXECUTE = RuntimeCtor.AFTER_EXECUTE;
    const TARGETS_UPDATE = RuntimeCtor.TARGETS_UPDATE;
    runtime._step = function evalBStep() {
      if (this._hatsCache === null) {
        this._hatsCache = Object.entries(this._hats);
      }
      const hatsCache = this._hatsCache;
      for (let h = 0; h < hatsCache.length; h++) {
        const entry = hatsCache[h];
        if (entry[1].edgeActivated) {
          this.startHats(entry[0]);
        }
      }
      this.redrawRequested = false;
      this._pushMonitors();
      this.emit(BEFORE_EXECUTE);
      const doneThreads = this.sequencer.stepThreads();
      this.emit(AFTER_EXECUTE);
      this._updateGlows(doneThreads);
      this._emitProjectRunStatus(
        this.threads.length +
          doneThreads.length -
          this._getMonitorThreadCount(this.threads, doneThreads),
      );
      this._lastStepDoneThreads = doneThreads;
      if (this.renderer && !document.hidden && !this.frameLoop._interpolationAnimation) {
        this.renderer.draw();
      }
      if (this._refreshTargets) {
        this.emit(TARGETS_UPDATE, false);
        this._refreshTargets = false;
      }
      return undefined;
    };
  }

  return () => {
    sequencer.stepThreads = originalStepThreads;
    runtime._step = originalStep;
  };
}

/**
 * @param {{
 *   VirtualMachine: any,
 *   projectBuffer: Buffer,
 *   frames: number,
 *   variant: Variant,
 * }} params
 */
async function runOnce({ VirtualMachine, projectBuffer, frames, variant }) {
  const vm = new VirtualMachine();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: false });
  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);
  await vm.loadProject(ab);
  const teardown = installVariant(vm.runtime, vm.runtime.sequencer, variant);
  vm.runtime.greenFlag();
  const startedAt = process.hrtime.bigint();
  let maxThreads = 0;
  for (let i = 0; i < frames; i++) {
    vm.runtime._step();
    if (vm.runtime.threads.length > maxThreads) {
      maxThreads = vm.runtime.threads.length;
    }
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNs) / 1_000_000;
  const targetsAtEnd = vm.runtime.targets.length;
  teardown();
  vm.runtime.stopAll();
  return { elapsedMs, maxThreads, targetsAtEnd };
}

/**
 * @param {{
 *   VirtualMachine: any,
 *   projectBuffer: Buffer,
 *   warmupRuns: number,
 *   measureFrames: number,
 *   n: number,
 *   variant: Variant,
 * }} params
 */
async function benchVariant({ VirtualMachine, projectBuffer, warmupRuns, measureFrames, n, variant }) {
  for (let i = 0; i < warmupRuns; i++) {
    await runOnce({ VirtualMachine, projectBuffer, frames: measureFrames, variant });
  }
  const samples = [];
  const heapBefore = process.memoryUsage().heapUsed;
  let lastMaxThreads = 0;
  let lastTargetsAtEnd = 0;
  for (let i = 0; i < n; i++) {
    const r = await runOnce({
      VirtualMachine,
      projectBuffer,
      frames: measureFrames,
      variant,
    });
    samples.push(r.elapsedMs);
    lastMaxThreads = r.maxThreads;
    lastTargetsAtEnd = r.targetsAtEnd;
  }
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    variant,
    samples,
    stats: summarize(samples),
    heapDeltaMB: (heapAfter - heapBefore) / (1024 * 1024),
    maxThreads: lastMaxThreads,
    targetsAtEnd: lastTargetsAtEnd,
  };
}

/**
 * @param {{
 *   variant: Variant,
 *   samples: number[],
 *   stats: ReturnType<typeof summarize>,
 *   heapDeltaMB: number,
 *   maxThreads: number,
 *   targetsAtEnd: number,
 * }} result
 */
function renderSummary(result) {
  const s = result.stats;
  return (
    `variant=${result.variant}  n=${s.n}  median=${s.median.toFixed(2)}ms  ` +
    `p95=${s.p95.toFixed(2)}ms  min=${s.min.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  ` +
    `heapDelta=${result.heapDeltaMB.toFixed(2)}MB  ` +
    `maxThreads=${result.maxThreads}  targets=${result.targetsAtEnd}`
  );
}

/**
 * @param {any} baseline
 * @param {any} evaled
 */
function renderVerdict(baseline, evaled) {
  if (!baseline || !evaled) return '';
  const b = baseline.stats.median;
  const e = evaled.stats.median;
  const pct = ((b - e) / b) * 100;
  let label;
  if (pct >= 5) {
    label = `WIN (eval-A/B is ${pct.toFixed(1)}% faster than baseline)`;
  } else if (pct <= -5) {
    label = `LOSS (eval-A/B is ${Math.abs(pct).toFixed(1)}% slower than baseline)`;
  } else {
    label = `NEUTRAL (within ±5%)`;
  }
  return `verdict: ${label}\n  baseline median=${b.toFixed(2)}ms  evaled median=${e.toFixed(2)}ms`;
}

async function loadVendoredVm() {
  const vmDir = resolve(
    REPO_ROOT,
    'vendored/scaffolding/node_modules/scratch-vm',
  );
  if (!existsSync(vmDir)) {
    throw new Error(`vendored scratch-vm missing at ${vmDir}; run \`npm run setup\`.`);
  }
  const cjsRequire = createRequire(import.meta.url);
  const VirtualMachine = cjsRequire(resolve(vmDir, 'src/index.js'));
  return { VirtualMachine, vmDir };
}

/**
 * @param {string} fixturePath
 */
async function loadFixtureBuffer(fixturePath) {
  if (!existsSync(fixturePath)) {
    throw new Error(`fixture not found: ${fixturePath}. Run \`npm run fixtures:setup\`.`);
  }
  return readFileSync(fixturePath);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      dry: { type: 'boolean', default: false },
      variant: { type: 'string', default: '' },
      warmup: { type: 'string', default: String(DEFAULT_WARMUP_RUNS) },
      frames: { type: 'string', default: String(DEFAULT_MEASURE_FRAMES) },
      n: { type: 'string', default: process.env.BENCH_N ?? String(DEFAULT_N) },
    },
    allowPositionals: true,
  });

  const warmupRuns = Number.parseInt(values.warmup, 10);
  const measureFrames = Number.parseInt(values.frames, 10);
  const n = Number.parseInt(values.n, 10);
  const onlyVariant = values.variant ? values.variant : null;
  const onlyFixture = positionals[0] ?? null;

  const fixtures = onlyFixture ? [onlyFixture] : [...FIXTURES];
  const variants = onlyVariant ? [onlyVariant] : [...VARIANTS];

  if (values.dry) {
    // eslint-disable-next-line no-console
    console.log('[bench-scheduler-eval --dry]');
    // eslint-disable-next-line no-console
    console.log(
      `  BENCH_N=${n}  WARMUP_RUNS=${warmupRuns}  MEASURE_FRAMES=${measureFrames}`,
    );
    // eslint-disable-next-line no-console
    console.log(`  fixtures=${fixtures.join(', ')}`);
    // eslint-disable-next-line no-console
    console.log(`  variants=${variants.join(', ')}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[bench-scheduler-eval] BENCH_N=${n} WARMUP_RUNS=${warmupRuns} MEASURE_FRAMES=${measureFrames}`,
  );

  const { VirtualMachine } = await loadVendoredVm();
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(MEMO_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const logPath = resolve(LOG_DIR, 'bench-scheduler-eval.out');

  for (const fixtureName of fixtures) {
    const fixturePath = resolveFixture(fixtureName);
    const projectBuffer = await loadFixtureBuffer(fixturePath);
    const fixtureBase = fixtureName.replace(/\.sb3$/u, '');

    // eslint-disable-next-line no-console
    console.log(`\n=== fixture=${fixtureName} ===`);

    const results = {};
    for (const variant of variants) {
      const r = await benchVariant({
        VirtualMachine,
        projectBuffer,
        warmupRuns,
        measureFrames,
        n,
        variant,
      });
      results[variant] = r;
      // eslint-disable-next-line no-console
      console.log('  ' + renderSummary(r));

      // Per-variant JSON snapshot for the analysis report.
      const snapshot = {
        fixture: fixtureName,
        variant,
        warmupRuns,
        measureFrames,
        n,
        stats: r.stats,
        heapDeltaMB: r.heapDeltaMB,
        maxThreads: r.maxThreads,
        targetsAtEnd: r.targetsAtEnd,
        timestamp: new Date().toISOString(),
      };
      const jsonPath = resolve(
        MEMO_DIR,
        `bench-${fixtureBase}-${variant}-${timestamp}.json`,
      );
      writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
    }

    if (results.baseline && results['eval-A']) {
      // eslint-disable-next-line no-console
      console.log('  ' + renderVerdict(results.baseline, results['eval-A']));
    }
    if (results.baseline && results['eval-B']) {
      // eslint-disable-next-line no-console
      console.log('  ' + renderVerdict(results.baseline, results['eval-B']));
    }

    // Append to regression log.
    const body =
      `\n=== ${timestamp} ===\nfixture=${fixtureName}\n` +
      variants.map((v) => '  ' + renderSummary(results[v])).join('\n') +
      '\n';
    writeFileSync(logPath, body, { flag: 'a' });
  }
}

await main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench-scheduler-eval] FAILED:', err);
  process.exit(1);
});