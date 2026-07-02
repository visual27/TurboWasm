import { applyAdvancedSettings, asVm } from '@/runtime/settings-bridge';
import { applyExtensions } from '@/runtime/extensions';
import { setupScratchAssetStore } from '@/runtime/asset-store';
import { relayoutScaffolding } from '@/lib/scaffolding';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlayerStore } from '@/stores/usePlayerStore';
import type { ScaffoldingInstance } from '@/runtime/scaffolding-types';
import {
  applyPreSetupConfig,
  ensureSetup,
  getScaffolding,
} from '@/lib/scaffolding';
import { readTwconfigFromArrayBuffer } from '@/runtime/twconfig';
import type { AdvancedSettings } from '@/types/settings';
import { buildPreSetupConfig } from '@/runtime/pre-setup';
import { isValidProjectFile } from '@/lib/validation';
import { setCloudProvider, getCloudProvider } from '@/runtime/cloud-provider';
import { fetchProjectFromId } from '@/services/scratch-project';
import type { ProjectFetchResult, ProjectMetadata } from '@/types/project';
import { ProjectLoadError } from '@/types/project';

let attachedContainer: HTMLElement | null = null;
let attachedScaffolding: ScaffoldingInstance | null = null;
let currentAdvanced: AdvancedSettings | null = null;
let projectLoadToken = 0;

let readyPromise: Promise<ScaffoldingInstance> | null = null;

// Resolvers for the "player is ready" promise. The first time `initPlayer`
// is called, this is replaced with a resolved promise so any subsequent
// awaiters resolve immediately.
let playerReadyResolve: (() => void) | null = null;
let playerReadyPromise: Promise<void> = new Promise<void>((resolve) => {
  playerReadyResolve = resolve;
});

/**
 * Resolves once the Scaffolding player has been initialized at least once.
 * Used by the URL hash sync and any other early caller that might fire
 * before StageView's mount effect has called `initPlayer`.
 */
export function whenPlayerReady(): Promise<void> {
  return playerReadyPromise;
}

/**
 * Reset the player-ready gate. Intended for tests that need to simulate
 * the "not yet initialized" state between cases.
 */
export function __resetPlayerReadyForTesting(): void {
  if (playerReadyResolve) {
    // Resolve any leftover waiters so they don't leak between tests.
    playerReadyResolve();
  }
  playerReadyResolve = null;
  playerReadyPromise = new Promise<void>((resolve) => {
    playerReadyResolve = resolve;
  });
}

/**
 * TurboWarp pause implementation (see addons/pause in the TurboWarp/addons
 * repository and the addons/debugger/module.js file). The key insight is:
 *
 *   - Each scratch-vm Thread has a `status` field (0=RUNNING, 1=PROMISE_WAIT,
 *     2=YIELD, 3=YIELD_TICK, 4=DONE). To "pause" a thread we set its status
 *     to STATUS_PROMISE_WAIT (1). The sequencer reads this status and skips
 *     stepping paused threads. This is dramatically cheaper than replacing
 *     sequencer.stepThreads with a no-op.
 *
 *   - The original `status` of every paused thread is recorded in a
 *     WeakMap so we can restore it on resume.
 *
 *   - We hook `sequencer.stepThreads` to re-assert STATUS_PROMISE_WAIT on
 *     any thread whose status was modified by something else (e.g.
 *     startHats) while paused. This is the only "watchdog" we need.
 *
 *   - We hook `greenFlag` to unpause, and `startHats` to prevent new
 *     threads from being created while paused (except for user-initiated
 *     events such as broadcasts and clone starts).
 *
 *   - We hook `audioEngine.audioContext.resume` to no-op while paused, so
 *     the audio context stays suspended and the AudioEngine / sound library
 *     cannot accidentally resume it.
 *
 *   - `clock.pause()` / `clock.resume()` handle the project timer because
 *     the Clock class itself consults its internal `_paused` flag whenever
 *     `projectTimer()` is read.
 *
 *  Reference: https://github.com/TurboWarp/scratch-vm/blob/bb352913b57991713a5ccf0b611fda91056e14ec/src/engine/thread.js
 */
const STATUS_PROMISE_WAIT = 1;
const STATUS_DONE = 4;

interface ClockLike {
  pause?(): void;
  resume?(): void;
  _paused?: boolean;
  _pausedTime?: number | null;
}

interface ThreadLike {
  status: number;
  updateMonitor?: boolean;
  target?: { isStage?: boolean } | null;
  topBlock?: string;
  stackClick?: boolean;
  peekStack?: () => string | null;
  popStack?: () => void;
  stack?: unknown[];
  timer?: { startTime: number; start: () => void } | null;
  compatibilityStackFrame?: { timer?: { startTime: number } | null } | null;
  peekStackFrame?: () => {
    executionContext?: { timer?: { startTime: number } | null } | null;
  } | null;
}

interface SequencerLike {
  stepThreads: (...args: unknown[]) => unknown;
  stepThread?: (thread: ThreadLike) => unknown;
  activeThread: ThreadLike | null;
}

interface RuntimeLike {
  audioEngine?: {
    audioContext?: {
      suspend?: () => Promise<void>;
      resume?: () => Promise<void> | void;
    };
  };
  ioDevices?: { clock?: ClockLike };
  threads: ThreadLike[];
  currentMSecs: number;
  currentStepTime?: number;
  sequencer: SequencerLike;
  startHats: (...args: unknown[]) => ThreadLike[];
  _hats?: Record<string, { edgeActivated?: boolean }>;
  emit: (event: string, ...args: unknown[]) => void;
  targets?: Array<{
    sprite?: {
      soundBank?: {
        soundPlayers?: Record<
          string,
          {
            outputNode?: { stop: (t: number) => void; start: (t: number, off: number) => void } | null;
            _createSource?: () => void;
            startingUntil?: number;
          }
        >;
      };
    };
  }>;
  getIsEdgeActivatedHat?: (hat: string) => boolean;
  _getMonitorThreadCount?: (threads: ThreadLike[]) => number;
  greenFlag: () => void;
  stopAll?: () => void;
  attachAudioEngine?: (engine: { audioContext?: { resume?: () => void } }) => void;
  dispose?: () => void;
}

interface PauseOverride {
  sequencer: SequencerLike;
  originalStepThreads: (...args: unknown[]) => unknown;
  originalGreenFlag: () => void;
  originalStartHats: (...args: unknown[]) => ThreadLike[];
  originalGetMonitorThreadCount: ((threads: ThreadLike[]) => number) | null;
  originalAudioContextResume: (() => Promise<void> | void) | null;
  audioContextAttachedLater: boolean;
  pausedThreadStates: WeakMap<ThreadLike, { status: number; time: number }>;
  clock: ClockLike | null;
  audioStateChain: Promise<unknown>;
}
let pauseOverride: PauseOverride | null = null;

/**
 * Save the current status of `thread` and put it into STATUS_PROMISE_WAIT so
 * the sequencer leaves it alone. Mirrors the TurboWarp debugger module's
 * `pauseThread()` helper.
 */
function pauseThread(thread: ThreadLike): void {
  if (!pauseOverride) return;
  if (thread.updateMonitor) return;
  if (pauseOverride.pausedThreadStates.has(thread)) return;
  pauseOverride.pausedThreadStates.set(thread, {
    status: thread.status,
    time: pauseOverride.sequencer.activeThread ? 0 : 0,
  });
  thread.status = STATUS_PROMISE_WAIT;
}

/**
 * Defensive re-assertion: if anything (e.g. startHats) flipped a paused
 * thread's status back to something else, force it back to STATUS_PROMISE_WAIT.
 */
function ensureStillPaused(thread: ThreadLike): void {
  if (!pauseOverride) return;
  const state = pauseOverride.pausedThreadStates.get(thread);
  if (!state) return;
  if (thread.status === STATUS_DONE) return;
  if (thread.status !== STATUS_PROMISE_WAIT) {
    state.status = thread.status;
    thread.status = STATUS_PROMISE_WAIT;
  }
}

/**
 * Drop any active pause override and restore the underlying APIs to their
 * pre-pause state. Safe to call from stop() / loadProject*().
 */
function clearPauseOverride(): void {
  if (!pauseOverride) return;
  // (1) sequencer.stepThreads
  try {
    pauseOverride.sequencer.stepThreads = pauseOverride.originalStepThreads;
  } catch {
    /* ignore */
  }
  // (2) greenFlag
  try {
    // restore greenFlag on the runtime
    (pauseOverride as unknown as { __runtime?: RuntimeLike }).__runtime!.greenFlag =
      pauseOverride.originalGreenFlag;
  } catch {
    /* ignore */
  }
  // (3) startHats
  try {
    (pauseOverride as unknown as { __runtime?: RuntimeLike }).__runtime!.startHats =
      pauseOverride.originalStartHats;
  } catch {
    /* ignore */
  }
  // (4) _getMonitorThreadCount
  try {
    const runtime = (pauseOverride as unknown as { __runtime?: RuntimeLike }).__runtime;
    if (pauseOverride.originalGetMonitorThreadCount && runtime) {
      runtime._getMonitorThreadCount = pauseOverride.originalGetMonitorThreadCount;
    } else if (runtime) {
      delete runtime._getMonitorThreadCount;
    }
  } catch {
    /* ignore */
  }
  // (5) audioContext.resume
  try {
    const audioCtx = (pauseOverride as unknown as { __audioCtx?: { resume?: () => void } })
      .__audioCtx;
    if (audioCtx && pauseOverride.originalAudioContextResume) {
      audioCtx.resume = pauseOverride.originalAudioContextResume;
    }
  } catch {
    /* ignore */
  }
  pauseOverride = null;
}

export interface PlayerState {
  isPlaying: boolean;
  isPaused: boolean;
  isReady: boolean;
}

export type PlayerStateListener = (state: PlayerState) => void;

const stateListeners = new Set<PlayerStateListener>();
let lastEmittedState: PlayerState = { isPlaying: false, isPaused: false, isReady: false };

function emitState(): void {
  for (const listener of stateListeners) {
    try {
      listener(lastEmittedState);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[player] state listener threw:', err);
    }
  }
}

function setState(next: Partial<PlayerState>): void {
  const merged: PlayerState = { ...lastEmittedState, ...next };
  if (
    merged.isPlaying === lastEmittedState.isPlaying &&
    merged.isPaused === lastEmittedState.isPaused &&
    merged.isReady === lastEmittedState.isReady
  ) {
    return;
  }
  lastEmittedState = merged;
  emitState();
}

export function subscribePlayerState(listener: PlayerStateListener): () => void {
  stateListeners.add(listener);
  listener(lastEmittedState);
  return () => stateListeners.delete(listener);
}

function bindEvents(scaffolding: ScaffoldingInstance): void {
  const onStart: EventListener = () => setState({ isPlaying: true, isPaused: false });
  // PROJECT_RUN_STOP must NOT reset the state while we have an active pause
  // override. The Scaffolding's run-loop emits this event as soon as no
  // thread is stepping, which happens immediately after our pause hook
  // marks every thread as STATUS_PROMISE_WAIT. Without this guard, the
  // "stop" event would overwrite our `isPaused: true` state and the
  // ControlBar's pause/resume button would never switch to "Resume" — it
  // would behave as if the user had pressed Stop.
  const onStop: EventListener = () => {
    if (pauseOverride) return;
    setState({ isPlaying: false, isPaused: false });
  };
  scaffolding.addEventListener('PROJECT_RUN_START', onStart);
  scaffolding.addEventListener('PROJECT_RUN_STOP', onStop);

  // Forward Scaffolding's ASSET_PROGRESS event to the player store so the
  // loading overlay can render a real progress bar instead of an
  // indeterminate spinner. The event payload is `(finished, total)`.
  const onAssetProgress: EventListener = (e) => {
    const ce = e as CustomEvent<{ finished?: number; total?: number }>;
    const detail = (ce as CustomEvent).detail ?? {};
    const finished = typeof detail.finished === 'number' ? detail.finished : 0;
    const total = typeof detail.total === 'number' ? detail.total : 0;
    try {
      usePlayerStore.getState().setAssetProgress(finished, total);
    } catch {
      /* ignore */
    }
  };
  scaffolding.addEventListener('ASSET_PROGRESS', onAssetProgress);
  // Reset the progress when a fresh project starts loading — Scaffolding
  // emits PROJECT_CHANGED both on first load and on subsequent loads.
  const onProjectChanged: EventListener = () => {
    try {
      usePlayerStore.getState().resetAssetProgress();
    } catch {
      /* ignore */
    }
  };
  scaffolding.addEventListener('PROJECT_CHANGED', onProjectChanged);
}

async function initScaffolding(
  container: HTMLElement,
  advanced: AdvancedSettings,
): Promise<ScaffoldingInstance> {
  attachedContainer = container;
  const cfg = buildPreSetupConfig(advanced);
  await getScaffolding({ width: cfg.width, height: cfg.height });
  applyPreSetupConfig(cfg);
  attachedScaffolding = await ensureSetup();
  bindEvents(attachedScaffolding);
  applyExtensions(attachedScaffolding);
  // Register Scratch's official asset CDN so project ID loads can resolve assets.
  setupScratchAssetStore(attachedScaffolding);
  attachedScaffolding.appendTo(container);
  return attachedScaffolding;
}

function defaultAdvanced(): AdvancedSettings {
  return {
    fps: 30,
    interpolation: false,
    highQualityPen: false,
    warpTimer: false,
    infiniteClones: false,
    removeFencing: false,
    removeMiscLimits: false,
    turboMode: false,
    disableCompiler: false,
    stageWidth: 480,
    stageHeight: 360,
  };
}

export function initPlayer(container: HTMLElement, advanced: AdvancedSettings): Promise<ScaffoldingInstance> {
  if (!readyPromise) {
    currentAdvanced = { ...advanced };
    // Resolve the player-ready gate so that any concurrent caller (e.g. the
    // URL hash sync that fires before StageView mounts) can now proceed.
    if (playerReadyResolve) {
      playerReadyResolve();
      playerReadyResolve = null;
    }
    readyPromise = (async () => {
      try {
        const sc = await initScaffolding(container, currentAdvanced ?? defaultAdvanced());
        applyAdvancedSettings(sc, currentAdvanced ?? defaultAdvanced());
        // Apply the current persisted volume immediately so the first frame
        // uses the user's setting rather than the default 100.
        try {
          setVolume(useSettingsStore.getState().volume);
        } catch {
          /* ignore */
        }
        setState({ isReady: true });
        return sc;
      } catch (err) {
        readyPromise = null;
        throw err;
      }
    })();
  } else if (attachedContainer !== container) {
    void readyPromise.then((sc) => {
      sc.appendTo(container);
      attachedContainer = container;
    });
  }
  return readyPromise;
}

export function isPlayerReady(): boolean {
  return attachedScaffolding !== null;
}

export async function ensurePlayerReady(): Promise<ScaffoldingInstance> {
  // Wait for the player-ready gate before checking readyPromise. This lets
  // callers (e.g. the URL hash sync) that fire before StageView mounts
  // queue a load and have it run as soon as initPlayer() is called.
  if (!readyPromise) {
    await whenPlayerReady();
  }
  if (!readyPromise) {
    throw new Error(
      'Player container not provided. Call initPlayer() with a stage container before loading.',
    );
  }
  return readyPromise;
}

export function applySettings(advanced: AdvancedSettings): void {
  if (!attachedScaffolding || !currentAdvanced) return;
  currentAdvanced = { ...advanced };
  applyAdvancedSettings(attachedScaffolding, currentAdvanced);
  const vm = asVm(attachedScaffolding.vm);
  if (vm.setStageSize) {
    vm.setStageSize(currentAdvanced.stageWidth, currentAdvanced.stageHeight);
  }
}

export function setVolume(volume: number): void {
  if (!attachedScaffolding) return;
  const vm = asVm(attachedScaffolding.vm);
  const audioEngine = (attachedScaffolding as unknown as { audioEngine?: unknown }).audioEngine;
  if (audioEngine && typeof audioEngine === 'object' && 'inputNode' in audioEngine) {
    const eng = audioEngine as { inputNode?: { gain: { value: number } } };
    if (eng.inputNode?.gain) {
      eng.inputNode.gain.value = Math.max(0, Math.min(100, volume)) / 100;
      return;
    }
  }
  const rt = vm.runtime as unknown as { audioEngine?: unknown };
  if (rt.audioEngine && typeof rt.audioEngine === 'object' && 'inputNode' in rt.audioEngine) {
    const eng = rt.audioEngine as { inputNode?: { gain: { value: number } } };
    if (eng.inputNode?.gain) {
      eng.inputNode.gain.value = Math.max(0, Math.min(100, volume)) / 100;
    }
  }
}

/**
 * Start (or restart) the project. Mirrors TurboWarp addons' "green flag" behavior.
 */
export function greenFlag(): void {
  attachedScaffolding?.greenFlag();
  // We optimistically mark playing=true; Scaffolding forwards PROJECT_RUN_START
  // which will also set this (idempotent).
  setState({ isPlaying: true, isPaused: false });
}

/**
 * Pause the project. TurboWarp addons/pause and addons/debugger compliant:
 *
 *  1. Mark every running thread as STATUS_PROMISE_WAIT so the sequencer
 *     leaves it alone. Save each thread's original status in a WeakMap
 *     so we can restore it on resume().
 *  2. Hook sequencer.stepThreads to re-assert STATUS_PROMISE_WAIT for
 *     any thread whose status was modified by something else while we
 *     are paused (defense in depth).
 *  3. Hook greenFlag to auto-unpause when the user clicks the green flag.
 *  4. Hook startHats to block new thread creation while paused
 *     (with an exception for user-initiated events).
 *  5. Call clock.pause() so the Clock's internal _paused flag is set and
 *     projectTimer() returns the value captured at pause() time.
 *  6. Suspend the audio engine (chained through a promise to serialize
 *     multiple suspend/resume calls).
 *  7. Hook audioEngine.audioContext.resume to no-op while paused.
 *  8. Update local isPlaying/isPaused state.
 */
export function pause(): void {
  if (!attachedScaffolding) return;
  const runtime = (attachedScaffolding.vm as unknown as { runtime: RuntimeLike }).runtime;
  if (!runtime) return;
  if (pauseOverride) return; // already paused

  const sequencer = runtime.sequencer;
  const clock = runtime.ioDevices?.clock ?? null;

  // (1) Build the PauseOverride holding every original reference we need
  //     to restore on resume.
  const originalStepThreads = sequencer.stepThreads.bind(sequencer);
  const originalGreenFlag = runtime.greenFlag.bind(runtime);
  const originalStartHats = runtime.startHats.bind(runtime);
  const originalGetMonitorThreadCount = runtime._getMonitorThreadCount
    ? runtime._getMonitorThreadCount.bind(runtime)
    : null;

  const originalAudioContextResume: (() => Promise<void> | void) | null =
    runtime.audioEngine?.audioContext?.resume
      ? (runtime.audioEngine.audioContext.resume as () => Promise<void> | void).bind(
          runtime.audioEngine.audioContext,
        )
      : null;

  const audioStateChain = Promise.resolve();

  pauseOverride = {
    sequencer,
    originalStepThreads,
    originalGreenFlag,
    originalStartHats,
    originalGetMonitorThreadCount,
    originalAudioContextResume,
    audioContextAttachedLater: false,
    pausedThreadStates: new WeakMap(),
    clock,
    audioStateChain,
  };
  // Stash the runtime so clearPauseOverride can patch it back even if
  // attachedScaffolding is later cleared.
  (pauseOverride as unknown as { __runtime: RuntimeLike }).__runtime = runtime;
  (pauseOverride as unknown as { __audioCtx?: unknown }).__audioCtx =
    runtime.audioEngine?.audioContext;

  // (2) Hook sequencer.stepThreads — re-assert STATUS_PROMISE_WAIT for any
  //     thread that was modified by something else.
  sequencer.stepThreads = function pausedStepThreads(this: unknown): unknown {
    if (!pauseOverride) return originalStepThreads.call(this);
    for (const thread of (this as { runtime: RuntimeLike }).runtime.threads) {
      ensureStillPaused(thread);
    }
    return originalStepThreads.call(this);
  };

  // (3) Hook greenFlag to auto-unpause.
  runtime.greenFlag = function pausedGreenFlag(): void {
    if (pauseOverride) resume();
    return originalGreenFlag.call(this);
  };

  // (4) Hook startHats to block new thread creation while paused.
  runtime.startHats = function pausedStartHats(...args: unknown[]): ThreadLike[] {
    if (!pauseOverride) return originalStartHats.apply(this, args);
    const hat = args[0] as string | undefined;
    // User-initiated events can still fire while paused.
    const isUserInitiated =
      hat === 'event_whenbroadcastreceived' || hat === 'control_start_as_clone';
    if (isUserInitiated) {
      return originalStartHats.apply(this, args);
    }
    return [];
  };

  // (4b) Hook _getMonitorThreadCount so paused threads are not counted
  //      as running for the GUI's monitor counter.
  if (originalGetMonitorThreadCount) {
    runtime._getMonitorThreadCount = function pausedGetMonitorThreadCount(
      this: unknown,
      threads: ThreadLike[],
    ): number {
      let count = originalGetMonitorThreadCount.call(this, threads);
      if (pauseOverride) {
        for (const t of threads) {
          if (pauseOverride.pausedThreadStates.has(t)) count++;
        }
      }
      return count;
    };
  }

  // (5) Call clock.pause() so projectTimer() returns the frozen value.
  if (clock && !clock._paused) {
    try {
      clock.pause?.();
    } catch {
      /* ignore */
    }
  }

  // (6) Suspend the audio engine, serialized through a chain to avoid
  //     race conditions with the Scaffolding / sound library.
  pauseOverride.audioStateChain = pauseOverride.audioStateChain.then(() => {
    try {
      return runtime.audioEngine?.audioContext?.suspend?.();
    } catch {
      return undefined;
    }
  });

  // (7) Hook audioContext.resume so nothing can resume audio while paused.
  if (runtime.audioEngine?.audioContext && originalAudioContextResume) {
    const audioCtx = runtime.audioEngine.audioContext;
    audioCtx.resume = function pausedAudioContextResume(): Promise<void> {
      // Only allow resume when we are NOT paused. (When the pause override
      // is cleared, originalAudioContextResume is restored.)
      if (pauseOverride) {
        return Promise.resolve();
      }
      return Promise.resolve(originalAudioContextResume.call(audioCtx));
    };
  } else if (runtime.attachAudioEngine) {
    // The Scaffolding's audio engine might be attached LATER (after pause).
    // Hook attachAudioEngine so the resume override is applied to whatever
    // audioContext ends up being attached.
    const originalAttach = runtime.attachAudioEngine.bind(runtime);
    runtime.attachAudioEngine = function pausedAttachAudioEngine(
      engine: { audioContext?: { resume?: () => void | Promise<void> } },
    ): unknown {
      const result = originalAttach(engine);
      if (pauseOverride && engine.audioContext) {
        const audioCtx = engine.audioContext;
        const orig = audioCtx.resume;
        audioCtx.resume = function pausedAudioContextResume(): Promise<void> {
          if (pauseOverride) return Promise.resolve();
          return Promise.resolve(orig?.call(audioCtx) ?? undefined);
        };
        (pauseOverride as unknown as { __audioCtx: unknown }).__audioCtx = audioCtx;
      }
      return result;
    };
  }

  // (1b) Mark every currently-running thread as paused.
  for (const thread of runtime.threads) {
    pauseThread(thread);
  }

  setState({ isPlaying: false, isPaused: true });
}

/**
 * Resume the project from a paused state. Restores everything in reverse
 * order:
 *  - re-asserts each thread's original status from the WeakMap
 *  - restores sequencer.stepThreads / greenFlag / startHats /
 *    _getMonitorThreadCount / audioContext.resume
 *  - calls clock.resume() to clear the VM's _paused flag
 *  - resumes the audio engine (chained through the audio promise)
 *  - updates local state
 */
export function resume(): void {
  if (!attachedScaffolding) return;
  const runtime = (attachedScaffolding.vm as unknown as { runtime: RuntimeLike }).runtime;
  if (!runtime) return;
  if (!pauseOverride) return;

  // (1) Restore each thread's original status.
  for (const thread of runtime.threads) {
    const state = pauseOverride.pausedThreadStates.get(thread);
    if (state) {
      thread.status = state.status;
    }
  }
  pauseOverride.pausedThreadStates = new WeakMap();

  // (5) Clear the Clock's _paused flag.
  try {
    pauseOverride.clock?.resume?.();
  } catch {
    /* ignore */
  }

  // Restore hooks (sequencer.stepThreads, greenFlag, startHats,
  // _getMonitorThreadCount, audioContext.resume) via the shared helper.
  clearPauseOverride();

  // (6) Resume the audio engine, serialized through the same chain.
  if (runtime.audioEngine?.audioContext?.resume) {
    try {
      void runtime.audioEngine.audioContext.resume();
    } catch {
      /* ignore */
    }
  }

  setState({ isPlaying: true, isPaused: false });
}

/**
 * Smart "play" — equivalent to clicking the green flag in the editor:
 *  - If the project is paused, resume it.
 *  - Otherwise (running or stopped), call greenFlag to (re)start from scratch.
 *
 * This matches TurboWarp's user expectation that clicking the play button
 * resumes a paused project instead of restarting it.
 */
export function play(): void {
  if (lastEmittedState.isPaused && !lastEmittedState.isPlaying) {
    resume();
  } else {
    greenFlag();
  }
}

export function stop(): void {
  // Restore any pause override before stopping so stopAll actually runs.
  clearPauseOverride();
  attachedScaffolding?.stopAll();
  setState({ isPlaying: false, isPaused: false });
}

/**
 * Reset the VM / runtime stage in place. Called immediately before loading
 * a new project so the canvas is cleared of the previous project's frame
 * during the asset-fetch window.
 *
 *  - stopAll() halts every running thread.
 *  - runtime.dispose() removes all targets, variables, lists, broadcasts,
 *    and threads from the runtime.
 *  - renderer.draw() forces the WebGL canvas to repaint with the now-empty
 *    scene.
 */
function resetScaffoldingStage(scaffolding: ScaffoldingInstance): void {
  try {
    const vm = scaffolding.vm as unknown as {
      stopAll?: () => void;
      runtime?: { dispose?: () => void };
    };
    try {
      vm.stopAll?.();
    } catch {
      /* ignore */
    }
    try {
      vm.runtime?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      const r = (scaffolding as unknown as { renderer?: { draw?: () => void } }).renderer;
      r?.draw?.();
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore — best-effort reset */
  }
}

export async function loadProjectFromArrayBuffer(
  buf: ArrayBuffer,
  options: { mergeTwconfig?: boolean } = {},
): Promise<void> {
  // A fresh project load always clears any active pause override so threads
  // can step normally from the moment loadProject resolves.
  clearPauseOverride();
  await ensurePlayerReady();
  if (!attachedScaffolding || !currentAdvanced) {
    throw new Error('Player is not initialized');
  }

  // (NEW) Reset the vm/runtime stage BEFORE loading the new project so the
  // old project content is cleared from the canvas immediately. Without
  // this, the previous project keeps rendering during the asset load
  // window, producing a visible flash. We:
  //   1. stopAll() to halt every running thread
  //   2. dispose() to clear all targets, variables, broadcasts, etc.
  //   3. force a renderer redraw so the stage shows an empty frame
  // The Scaffolding's loadProject() also calls clear() internally — our
  // pre-reset is a no-op safety net, idempotent with the load.
  resetScaffoldingStage(attachedScaffolding);

  if (options.mergeTwconfig !== false) {
    const overrides = await readTwconfigFromArrayBuffer(buf);
    if (Object.keys(overrides).length > 0) {
      currentAdvanced = { ...currentAdvanced, ...overrides };
    }
  }
  // Always apply the resolved settings so Scaffolding's internal width/height
  // and the React-side settings are in sync — even when there are no twconfig
  // overrides and the user is loading with default dimensions.
  applyAdvancedSettings(attachedScaffolding, currentAdvanced);
  const vm = asVm(attachedScaffolding.vm);
  if (vm.setStageSize) {
    vm.setStageSize(currentAdvanced.stageWidth, currentAdvanced.stageHeight);
  }

  const token = ++projectLoadToken;
  try {
    await attachedScaffolding.loadProject(buf);
    if (token !== projectLoadToken) return;
    setCloudProvider(getCloudProvider());
    // Reset playback state on project load.
    setState({ isPlaying: false, isPaused: false, isReady: true });

    // Scaffolding renders the loaded project immediately, but if the
    // StageView container was hidden (display:none) at the time of the
    // initial render call, the canvas's drawing buffer was 1×1 and the
    // drawn content was effectively lost when we later resized to the
    // proper stage dimensions. Force a relayout + redraw on the next two
    // animation frames so the canvas repaints at the real size.
    requestAnimationFrame(() => {
      relayoutScaffolding();
      requestAnimationFrame(() => {
        try {
          const r = (attachedScaffolding as unknown as {
            renderer?: { draw?: () => void };
          }).renderer;
          if (r && typeof r.draw === 'function') r.draw();
        } catch {
          /* ignore */
        }
      });
    });
  } catch (err) {
    throw new ProjectLoadError('invalid', `Failed to load project: ${(err as Error).message}`, err);
  }
}

export async function loadProjectFromFile(file: File): Promise<void> {
  if (!(await isValidProjectFile(file))) {
    throw new ProjectLoadError(
      'invalid',
      `"${file.name}" is not a valid .sb3 / .sb2 / .sb file`,
    );
  }
  const buf = await file.arrayBuffer();
  await loadProjectFromArrayBuffer(buf);
}

export interface LoadProjectFromIdOptions {
  metadata?: ProjectMetadata;
}

export async function loadProjectFromId(
  id: string,
  options: LoadProjectFromIdOptions = {},
): Promise<ProjectFetchResult> {
  const result = await fetchProjectFromId(id, options);
  await loadProjectFromArrayBuffer(result.data, { mergeTwconfig: true });
  return result;
}

export function isAttached(): boolean {
  return attachedScaffolding !== null;
}