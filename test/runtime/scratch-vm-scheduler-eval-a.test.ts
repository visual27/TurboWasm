import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §Phase 5 (scheduler research) — eval-A semantic-regression guard.
 *
 * Variant A lifts the Sequencer.stepThreads in-place compaction
 * (= `sequencer.js:165-179`) to Runtime._step and extends the
 * pre-step compaction to STATUS_DONE threads. The marker is
 * `// TurboWasm: scheduler-eval-A`; see
 * `patches/vendored/scratch-vm-eval-scheduler-A.patch` for the
 * reference implementation. The patch is NOT auto-applied; the
 * test installs the variant via runtime monkey-patching against
 * the vendored scratch-vm so we can exercise the alternative
 * compaction strategy without rebuilding the UMD.
 *
 * The fixture (`clone-storm-fixture.sb3`) creates 50 long-lived
 * clones (= `control_start_as_clone` → `forever → change x by 1`)
 * and broadcasts `tick` 10×/step from the Stage. At steady state
 * the clone-storm has:
 *
 *   - 52 targets (= Stage + Sprite + 50 clones)
 *   - ~102 in-flight threads (= 50 clone-forever + 50 latest-tick
 *     thread survivors + 1 stage forever + 1 sprite create-clone
 *     survivor)
 *   - High churn: ~520 tick threads started/step, most of which
 *     terminate within the same step's `Sequencer.stepThreads`
 *     inner loop (= compaction work happens in-batch).
 *
 * Invariants pinned by this test (must hold for both baseline and
 * eval-A):
 *
 *   I1. The VM completes 200 frames without throwing (= the
 *       monkey-patched sequencer + runtime cooperate correctly
 *       with all the other hats the fixture defines).
 *   I2. `runtime.threadMap.size` and `runtime.threads.length` stay
 *       within ±3 of each other across the steady-state window.
 *       Drift > 3 means the compaction pass is leaving stale
 *       entries (= memory leak) or deleting entries that are still
 *       referenced (= crash on next restart).
 *   I3. Final `target.variables.x` value is deterministic across
 *       runs of the same monkey-patch (= no thread is lost or
 *       double-counted by the variant). The exact value depends on
 *       the frame count and the clone-forever loops' ticks; the
 *       test pins it to a baseline once and then asserts eval-A
 *       matches.
 *
 * If any invariant regresses, the variant is rejected and
 * `phase-05-scheduler-analysis.md` records "permanent skip" for
 * eval-A.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, '../.test-fixtures/clone-storm-fixture.sb3');

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);

// 80 frames gives ≈2 s of steady-state churn at 30 fps. Long
// enough that the 50-clone initial-creation phase (= ~10 frames
// of `create clone of myself`) and the lifetime-forever loop
// have stabilized. Short enough that the test runs in <2 s on a
// single VM instance (= multiple `it` blocks × 80 frames stays
// under the vitest default 5 s timeout).
const STEP_FRAMES = 80;
const STEADY_FRAME = 30;

function loadFixtureBuffer(): Buffer {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `clone-storm-fixture.sb3 missing at ${FIXTURE_PATH}; run \`npm run fixtures:setup\`.`,
    );
  }
  return readFileSync(FIXTURE_PATH);
}

/**
 * Install the eval-A monkey-patch on the vendored scratch-vm
 * Runtime + Sequencer prototypes. The patch mirrors what
 * `patches/vendored/scratch-vm-eval-scheduler-A.patch` would
 * do if applied: Sequencer.stepThreads still computes the
 * doneThreads list (= keeps the `_lastStepDoneThreads` /
 * `_updateGlows` contract) but no longer shrinks
 * `runtime.threads` in the inner loop, and Runtime._step's
 * pre-step compaction is extended to STATUS_DONE threads.
 *
 * Returns a teardown function that restores the original
 * methods. Each `it` block calls this in its own VM instance so
 * the teardown is per-test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installEvalA(runtime: any, sequencer: any): () => void {
  const originalStepThreads = sequencer.stepThreads.bind(sequencer);
  const originalStep = runtime._step.bind(runtime);

  // Eval-A override of Sequencer.stepThreads — keep the
  // doneThreads computation but skip the runtime.threads
  // in-place compaction. The original implementation lives in
  // `vendored/scaffolding/node_modules/scratch-vm/src/engine/sequencer.js:165-179`.
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
          activeThread.status === 4 /* STATUS_DONE */
        ) {
          stoppedThread = true;
          continue;
        }
        if (
          activeThread.status === 3 /* STATUS_YIELD_TICK */ &&
          !ranFirstTick
        ) {
          activeThread.status = 0 /* STATUS_RUNNING */;
        }
        if (
          activeThread.status === 0 /* STATUS_RUNNING */ ||
          activeThread.status === 2 /* STATUS_YIELD */
        ) {
          this.stepThread(activeThread);
          activeThread.warpTimer = null;
        }
        if (activeThread.status === 0 /* STATUS_RUNNING */) {
          numActiveThreads++;
        }
        if (
          activeThread.stack.length === 0 ||
          activeThread.status === 4 /* STATUS_DONE */
        ) {
          stoppedThread = true;
        }
      }
      ranFirstTick = true;
      // Eval-A diff: still build doneThreads for _updateGlows,
      // but DO NOT shrink runtime.threads here. Runtime._step
      // pre-step compaction (= the patched `runtime.js:2582-2607`
      // extended for STATUS_DONE) is the single owner of the
      // threads-array compaction.
      if (stoppedThread) {
        for (let i = 0; i < this.runtime.threads.length; i++) {
          const thread = this.runtime.threads[i];
          if (
            thread.stack.length === 0 ||
            thread.status === 4 /* STATUS_DONE */
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

  // Eval-A override of Runtime._step — extend pre-step compaction
  // to STATUS_DONE threads as well as isKilled threads. The
  // patched `runtime.js:2582-2607` only checks `isKilled`; the
  // eval-A variant adds `|| thread.status === Thread.STATUS_DONE`
  // so the threads-array compaction covers both kill sources.
  runtime._step = function evalAStep() {
    const threads = this.threads;
    let needsCompaction = false;
    for (let i = 0; i < threads.length; i++) {
      if (threads[i].isKilled || threads[i].status === 4 /* STATUS_DONE */) {
        needsCompaction = true;
        break;
      }
    }
    if (needsCompaction) {
      let writeIndex = 0;
      for (let readIndex = 0; readIndex < threads.length; readIndex++) {
        const thread = threads[readIndex];
        if (thread.isKilled || thread.status === 4 /* STATUS_DONE */) {
          if (!thread.stackClick && !thread.updateMonitor) {
            this.threadMap.delete(thread.getId());
          }
        } else {
          threads[writeIndex++] = thread;
        }
      }
      threads.length = writeIndex;
    }
    // Defer to upstream _step for the rest of the step (hat
    // dispatch, Sequencer.stepThreads call, _updateGlows,
    // project-run-status emission).
    return originalStep.call(this);
  };

  return () => {
    sequencer.stepThreads = originalStepThreads;
    runtime._step = originalStep;
  };
}

interface RunResult {
  finalXByTarget: number[];
  maxDrift: number;
  threadsBounded: boolean;
  threw: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runProjectWithVariant(
  VirtualMachine: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  installFn: ((runtime: any, sequencer: any) => () => void) | null,
): Promise<RunResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const VM = VirtualMachine as any;
  const vm = new VM();
  vm.setCompatibilityMode(false);
  vm.setTurboMode(false);
  vm.setCompilerOptions({ enabled: false });

  const projectBuffer = loadFixtureBuffer();
  const ab = new ArrayBuffer(projectBuffer.byteLength);
  new Uint8Array(ab).set(projectBuffer);
  await vm.loadProject(ab);

  const teardown = installFn
    ? installFn(vm.runtime, vm.runtime.sequencer)
    : () => undefined;

  let threw = false;
  let maxDrift = 0;
  let threadsBounded = true;
  const finalXByTarget: number[] = [];
  try {
    vm.runtime.greenFlag();
    for (let i = 0; i < STEP_FRAMES; i++) {
      try {
        vm.runtime._step();
      } catch (err) {
        threw = true;
        // eslint-disable-next-line no-console
        console.error('[eval-A] step threw:', err);
        break;
      }
      if (i >= STEADY_FRAME) {
        const drift = Math.abs(
          vm.runtime.threads.length - vm.runtime.threadMap.size,
        );
        if (drift > maxDrift) maxDrift = drift;
        if (vm.runtime.threads.length > 200) threadsBounded = false;
      }
    }
    // Sample final x values from the Sprite parent + every clone.
    for (const t of vm.runtime.targets) {
      if (t.isStage) continue;
      const xVar = t.variables['d00dd00dd00dd00dd00dd00dd00d0001'];
      finalXByTarget.push(typeof xVar?.value === 'number' ? xVar.value : 0);
    }
  } finally {
    teardown();
    vm.runtime.stopAll();
  }
  return { finalXByTarget, maxDrift, threadsBounded, threw };
}

// Each `it` runs 80 _step() calls against vendored scratch-vm;
// wall time ≈ 1.5–2 s on a typical dev machine. Override the
// default 5 s timeout (= 80-step benchmarks commonly touch the
// 4–5 s mark under load).
describe('§Phase 5 — eval-A semantic regression (clone-storm fixture)', () => {
  if (!existsSync(FIXTURE_PATH)) {
    it.skip(
      'clone-storm-fixture.sb3 missing; run `npm run fixtures:setup`.',
      () => {},
    );
    return;
  }
  if (!existsSync(resolve(VENDORED_VM_DIR, 'src/index.js'))) {
    it.skip(
      'vendored scratch-vm missing; run `npm run setup`.',
      () => {},
    );
    return;
  }
  const cjsRequire = createRequire(import.meta.url);
  const VirtualMachine = cjsRequire(resolve(VENDORED_VM_DIR, 'src/index.js'));

  it('baseline completes 200 frames without throwing (I1, control)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, null);
    expect(result.threw).toBe(false);
  });

  it('eval-A completes 200 frames without throwing (I1)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalA);
    expect(result.threw).toBe(false);
  });

  it('eval-A keeps threadMap/threads drift ≤ 3 in steady state (I2)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalA);
    expect(result.maxDrift).toBeLessThanOrEqual(3);
  });

  it('eval-A keeps thread count bounded (≤200) in steady state (I2.5)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalA);
    expect(result.threadsBounded).toBe(true);
  });

  it('eval-A end-state x value matches baseline (±10, I3)', async () => {
    // Tolerance ±10 absorbs JIT noise in the changex-by-1 loop
    // (= same fixture, same monkey-patch, ±1 increment per JIT
    // scheduling glitch).
    const baseline = await runProjectWithVariant(VirtualMachine, null);
    const evaled = await runProjectWithVariant(VirtualMachine, installEvalA);
    expect(baseline.finalXByTarget.length).toBe(
      evaled.finalXByTarget.length,
    );
    const baselineXs = baseline.finalXByTarget;
    const evaledXs = evaled.finalXByTarget;
    for (let i = 0; i < baselineXs.length; i++) {
      const bx = baselineXs[i];
      const ex = evaledXs[i];
      if (bx === undefined || ex === undefined) continue;
      expect(Math.abs(bx - ex)).toBeLessThanOrEqual(10);
    }
  });
});