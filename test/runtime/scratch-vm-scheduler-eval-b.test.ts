import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §Phase 5 (scheduler research) — eval-B semantic-regression guard.
 *
 * Variant B drops the Runtime._step pre-step compaction
 * (= the patched `runtime.js:2582-2607`) into the Sequencer
 * and extends the Sequencer's in-place compaction to also cover
 * `isKilled` threads. The marker is `// TurboWasm: scheduler-
 * eval-B`; see `patches/vendored/scratch-vm-eval-scheduler-B.patch`
 * for the reference implementation. The patch is NOT auto-
 * applied; the test installs the variant via runtime monkey-
 * patching against the vendored scratch-vm.
 *
 * Same fixture and same invariants as `scratch-vm-scheduler-
 * eval-a.test.ts`:
 *
 *   I1. The VM completes 80 frames without throwing.
 *   I2. `runtime.threadMap.size` and `runtime.threads.length`
 *       stay within ±3 of each other across the steady-state
 *       window.
 *   I3. Final `target.variables.x` value matches baseline (±10
 *       tolerance).
 *
 * Eval-B differs structurally from eval-A: with eval-B, Runtime._step
 * does NOT walk the threads array at the top of the step. The
 * Sequencer's inner-loop compaction loop owns both STATUS_DONE
 * and isKilled removal, so threads marked killed mid-step (= via
 * `_stopThread` / `runtime.stopForTarget`) are still cleaned up
 * before the next step begins.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, '../.test-fixtures/clone-storm-fixture.sb3');

const VENDORED_VM_DIR = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-vm',
);

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
 * Install the eval-B monkey-patch. Two changes vs baseline:
 *
 *   - `Sequencer.stepThreads` — extend the inner-loop compaction
 *     to also catch `isKilled` threads. With eval-B the runtime
 *     no longer has a pre-step compaction pass, so the Sequencer
 *     is the single owner of all `runtime.threads` shrinking.
 *   - `Runtime._step` — replace the pre-step `isKilled` compaction
 *     block with a no-op (= just defer to the original _step).
 *     The vendored source's `runtime.js:2582-2607` block runs
 *     before `originalStep.call(this)` so we need to skip it; the
 *     simplest way is to override `_step` entirely and bypass the
 *     patched upstream.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installEvalB(runtime: any, sequencer: any): () => void {
  const originalStepThreads = sequencer.stepThreads.bind(sequencer);
  const originalStep = runtime._step.bind(runtime);
  // Resolve vendored Runtime static constants once (= the
  // patched upstream uses `Runtime.BEFORE_EXECUTE`, etc.). These
  // are string literals (= e.g. 'BEFORE_EXECUTE') but reading
  // them from the class keeps the eval-B step in sync with any
  // future scratch-vm rename.
  const RUNTIME_EVENTS = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BEFORE_EXECUTE: (runtime.constructor as any).BEFORE_EXECUTE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    AFTER_EXECUTE: (runtime.constructor as any).AFTER_EXECUTE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TARGETS_UPDATE: (runtime.constructor as any).TARGETS_UPDATE,
  };
  void RUNTIME_EVENTS;

  // Eval-B override of Sequencer.stepThreads — keep the in-place
  // compaction (= shrunken `runtime.threads` per inner-loop pass),
  // but extend the "skip" condition to also drop `isKilled` threads.
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
        // Eval-B diff: also treat `isKilled` threads as "stopped"
        // (= they get compacted out of runtime.threads here, not in
        // Runtime._step's pre-step pass which we've removed).
        if (
          activeThread.stack.length === 0 ||
          activeThread.status === 4 /* STATUS_DONE */ ||
          activeThread.isKilled
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
      // Eval-B diff: in-place compaction now also catches isKilled.
      if (stoppedThread) {
        let nextActiveThread = 0;
        for (let i = 0; i < this.runtime.threads.length; i++) {
          const thread = this.runtime.threads[i];
          if (
            thread.stack.length !== 0 &&
            thread.status !== 4 /* STATUS_DONE */ &&
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

  // Eval-B override of Runtime._step — strip the pre-step
  // `isKilled` compaction block (= the patched `runtime.js:2582-2607`)
  // and defer to the rest of upstream _step (hat dispatch,
  // Sequencer.stepThreads call, _updateGlows, project-run-status
  // emission).
  runtime._step = function evalBStep() {
    // The vendored source has the patched pre-step compaction
    // (= in-place compaction of `isKilled` threads at the top of
    // `_step`). With eval-B, the Sequencer owns compaction, so
    // we need to skip that block. The cleanest way is to wrap the
    // original _step in a function that runs only the post-step
    // (= hat dispatch + sequencer + glow). The simplest way to do
    // that without rewriting the patched runtime.js is to
    // selectively execute the original _step up to the point
    // where Sequencer.stepThreads would be called.
    //
    // The vendored _step has this shape:
    //   1. interpolate setup (if enabled)
    //   2. profiler start
    //   3. *** PATCHED pre-step compaction (we skip) ***
    //   4. edge-activated hat dispatch (hatsCache loop)
    //   5. pushMonitors
    //   6. emit BEFORE_EXECUTE
    //   7. const doneThreads = this.sequencer.stepThreads()
    //   8. emit AFTER_EXECUTE
    //   9. _updateGlows(doneThreads)
    //  10. project-run-status emit
    //  11. _lastStepDoneThreads = doneThreads
    //  12. renderer.draw() etc.
    //
    // Steps 1-2 and 4-12 are kept (= no profiler / hat dispatch /
    // glow merge change). Step 3 is the only thing we want to
    // drop. We can't selectively skip it via a wrapper, so we
    // duplicate the structure here.
    if (this.interpolationEnabled) {
      // Re-import the vendored interpolate module via the runtime's
      // existing setup path. Most fixtures don't enable interpolation
      // so this is normally a no-op; we still wire it up for parity
      // with the upstream _step.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const interpolate = require(
        resolve(VENDORED_VM_DIR, 'src/tw-interpolate.js'),
      );
      interpolate.setupInitialState(this);
    }
    // Note: we do NOT call the vendored profiler frame
    // bookkeeping here (= `_step` profiler frame, `RenderWebGL.draw`
    // profiler frame) because re-implementing it in this
    // monkey-patch is fragile (= profiler frame IDs are cached
    // inside the upstream _step). The cost is a missing profiler
    // frame for the parts we re-implemented, which is acceptable
    // for a non-applied reference patch.
    //
    // Edge-activated hat dispatch — reproduce the patched
    // `runtime.js:2613-2622` (= hatsCache iteration).
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
    this.emit(RUNTIME_EVENTS.BEFORE_EXECUTE);
    const doneThreads = this.sequencer.stepThreads();
    this.emit(RUNTIME_EVENTS.AFTER_EXECUTE);
    this._updateGlows(doneThreads);
    this._emitProjectRunStatus(
      this.threads.length +
        doneThreads.length -
        this._getMonitorThreadCount(this.threads, doneThreads),
    );
    this._lastStepDoneThreads = doneThreads;
    if (this.renderer) {
      if (!document.hidden && !this.frameLoop._interpolationAnimation) {
        this.renderer.draw();
      }
    }
    if (this._refreshTargets) {
      this.emit(RUNTIME_EVENTS.TARGETS_UPDATE, false);
      this._refreshTargets = false;
    }
    return undefined;
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
        console.error('[eval-B] step threw:', err);
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

describe('§Phase 5 — eval-B semantic regression (clone-storm fixture)', () => {
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

  it('eval-B completes 80 frames without throwing (I1)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalB);
    expect(result.threw).toBe(false);
  });

  it('eval-B keeps threadMap/threads drift ≤ 3 in steady state (I2)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalB);
    expect(result.maxDrift).toBeLessThanOrEqual(3);
  });

  it('eval-B keeps thread count bounded (≤200) in steady state (I2.5)', async () => {
    const result = await runProjectWithVariant(VirtualMachine, installEvalB);
    expect(result.threadsBounded).toBe(true);
  });

  it('eval-B end-state x value matches baseline (±10, I3)', async () => {
    const baseline = await runProjectWithVariant(VirtualMachine, null);
    const evaled = await runProjectWithVariant(VirtualMachine, installEvalB);
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