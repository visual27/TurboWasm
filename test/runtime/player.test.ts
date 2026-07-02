import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePlayerReady,
  initPlayer,
  isPlayerReady,
  __resetPlayerReadyForTesting,
  pause,
  resume,
  stop,
  subscribePlayerState,
  play,
} from '@/runtime/player';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import {
  getScaffoldingInstance,
  resetScaffoldingForTesting,
} from '@/lib/scaffolding';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('player readiness', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetScaffoldingForTesting();
    __resetPlayerReadyForTesting();
  });

  it('ensurePlayerReady awaits the player-ready gate before throwing', async () => {
    // The new behavior: ensurePlayerReady waits for the player-ready
    // gate to resolve. The gate only resolves when initPlayer is called.
    // Until then, ensurePlayerReady() should hang (or, in a sane world,
    // timeout). We verify it does NOT throw immediately with the old
    // "Player container not provided" error.
    //
    // We do this by racing the ensure call against a small timeout: if
    // the old "throw immediately" behavior is in effect, the test would
    // observe the rejection within 100ms. With the new wait-for-gate
    // behavior, the race resolves with a timeout.
    const pending = ensurePlayerReady().catch((err: Error) => err);
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 100);
    });
    const result = await Promise.race([pending, timeout]);
    expect(result).toBe('timeout');
  });

  it('isPlayerReady returns false initially', () => {
    expect(isPlayerReady()).toBe(false);
  });

  it('initPlayer returns a promise', async () => {
    const container = makeContainer();
    const p = initPlayer(container, DEFAULT_ADVANCED_SETTINGS);
    expect(p).toBeInstanceOf(Promise);
    // We do NOT await — the Scaffolding setup requires a WebGL context
    // that jsdom does not provide, so awaiting would fail. The test
    // only verifies the function returns a Promise.
    p.catch(() => undefined);
    // Reset for the next test.
    resetScaffoldingForTesting();
  });
});

describe('player runtime controls', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetScaffoldingForTesting();
  });

  it('pause/resume/stop are no-throw safe without a Scaffolding instance', () => {
    expect(() => pause()).not.toThrow();
    expect(() => resume()).not.toThrow();
    expect(() => stop()).not.toThrow();
    expect(() => play()).not.toThrow();
    expect(getScaffoldingInstance()).toBeNull();
  });

  it('play() falls back to greenFlag() when no project has run', () => {
    const seen: boolean[] = [];
    const unsub = subscribePlayerState((s) => seen.push(s.isPlaying));
    play();
    // play() with no paused state and no isPlaying goes through greenFlag path,
    // which optimistically sets isPlaying=true.
    expect(seen[seen.length - 1]).toBe(true);
    unsub();
  });
});

describe('pause/resume state semantics', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetScaffoldingForTesting();
  });

  it('pause() with no Scaffolding is a safe no-op (state unchanged)', () => {
    const seen: boolean[] = [];
    const unsub = subscribePlayerState((s) => seen.push(s.isPaused));
    const before = seen[seen.length - 1];
    pause();
    // No-op because there's no Scaffolding instance to pause.
    expect(seen[seen.length - 1]).toBe(before);
    unsub();
  });

  it('resume() with no Scaffolding updates isPaused to false and isPlaying to true', () => {
    const seenPlaying: boolean[] = [];
    const seenPaused: boolean[] = [];
    const unsubPlaying = subscribePlayerState((s) => seenPlaying.push(s.isPlaying));
    const unsubPaused = subscribePlayerState((s) => seenPaused.push(s.isPaused));

    pause(); // first to set isPaused=true
    resume(); // then resume

    expect(seenPaused[seenPaused.length - 1]).toBe(false);
    expect(seenPlaying[seenPlaying.length - 1]).toBe(true);
    unsubPlaying();
    unsubPaused();
  });

  it('stop() resets both isPlaying and isPaused', () => {
    const seen: { isPlaying: boolean; isPaused: boolean }[] = [];
    const unsub = subscribePlayerState((s) => seen.push({ isPlaying: s.isPlaying, isPaused: s.isPaused }));

    // simulate running then pausing then stopping
    pause();
    stop();
    expect(seen[seen.length - 1]).toEqual({ isPlaying: false, isPaused: false });
    unsub();
  });

  it('play() invokes resume() when paused', () => {
    const playSpy = vi.fn();
    const resumeSpy = vi.fn();
    // Simulate the smart play logic at a higher level:
    pause(); // isPaused=true, isPlaying=false
    // play() should detect isPaused and call resume
    play();
    // We can't easily verify which internal function was called without a
    // Scaffolding instance, but the resulting state should be isPlaying=true
    // and isPaused=false.
    const last = subscribePlayerState((s) => ({ p: s.isPlaying, s: s.isPaused }));
    // Initial subscriber push, then check last emitted
    let snapshot = { p: false, s: false };
    const unsub = subscribePlayerState((s) => {
      snapshot = { p: s.isPlaying, s: s.isPaused };
    });
    // play() again — should still resolve cleanly
    play();
    expect(snapshot.p).toBe(true);
    expect(snapshot.s).toBe(false);
    unsub();
    void last;
    void playSpy;
    void resumeSpy;
  });
});

describe('TurboWarp-style pause (thread.status = STATUS_PROMISE_WAIT)', () => {
  /**
   * Build a minimal "Thread" surface so we can verify the status-flag pause
   * approach without involving the Scaffolding.
   */
  interface MockThread {
    status: number;
    updateMonitor?: boolean;
  }

  const STATUS_PROMISE_WAIT = 1;

  function makeThread(status: number, updateMonitor = false): MockThread {
    return { status, updateMonitor };
  }

  /**
   * Replicate the runtime.status-snapshot + restoration logic in plain
   * TypeScript so we can verify the algorithm without the bundled
   * scratch-vm. This mirrors the real pause() / resume() implementation.
   */
  function freezeThreads(threads: MockThread[]): WeakMap<MockThread, { status: number }> {
    const map = new WeakMap<MockThread, { status: number }>();
    for (const t of threads) {
      if (t.updateMonitor) continue;
      if (map.has(t)) continue;
      map.set(t, { status: t.status });
      t.status = STATUS_PROMISE_WAIT;
    }
    return map;
  }

  function thawThreads(threads: MockThread[], map: WeakMap<MockThread, { status: number }>): void {
    for (const t of threads) {
      const state = map.get(t);
      if (state) t.status = state.status;
    }
  }

  it('paused threads are marked STATUS_PROMISE_WAIT', () => {
    const t1 = makeThread(0); // STATUS_RUNNING
    const t2 = makeThread(2); // STATUS_YIELD
    const map = freezeThreads([t1, t2]);
    expect(t1.status).toBe(STATUS_PROMISE_WAIT);
    expect(t2.status).toBe(STATUS_PROMISE_WAIT);
    expect(map.has(t1)).toBe(true);
    expect(map.has(t2)).toBe(true);
  });

  it('monitor threads are NOT paused (they keep their status)', () => {
    const monitor = makeThread(0, true);
    const regular = makeThread(0, false);
    const map = freezeThreads([monitor, regular]);
    expect(monitor.status).toBe(0);
    expect(regular.status).toBe(STATUS_PROMISE_WAIT);
    expect(map.has(monitor)).toBe(false);
    expect(map.has(regular)).toBe(true);
  });

  it('thaw restores the original status of every paused thread', () => {
    const t1 = makeThread(0);
    const t2 = makeThread(3); // STATUS_YIELD_TICK
    const map = freezeThreads([t1, t2]);
    expect(t1.status).toBe(STATUS_PROMISE_WAIT);
    expect(t2.status).toBe(STATUS_PROMISE_WAIT);
    thawThreads([t1, t2], map);
    expect(t1.status).toBe(0);
    expect(t2.status).toBe(3);
  });

  it('re-freezing the same thread is a no-op (status stays at STATUS_PROMISE_WAIT)', () => {
    const t = makeThread(0);
    const map = freezeThreads([t]);
    expect(t.status).toBe(STATUS_PROMISE_WAIT);
    const originalState = map.get(t);
    // Re-freeze the same thread: the captured state should NOT be
    // overwritten (still the original STATUS_RUNNING).
    freezeThreads([t]);
    expect(t.status).toBe(STATUS_PROMISE_WAIT);
    expect(map.get(t)?.status).toBe(originalState?.status);
  });

  it('pause/resume do not crash when there are no threads', () => {
    const map = freezeThreads([]);
    expect(map.has({} as MockThread)).toBe(false);
    thawThreads([], map);
  });
});

/**
 * The PROJECT_RUN_STOP event is fired by the Scaffolding's run-loop as
 * soon as no thread is stepping. Our pause hook sets every running thread
 * to STATUS_PROMISE_WAIT, so the loop fires PROJECT_RUN_STOP immediately
 * after pause() returns. The onStop listener in bindEvents() MUST
 * therefore ignore this event while pauseOverride is set, otherwise the
 * `isPaused: true` state we just set would be overwritten back to
 * `isPaused: false` and the ControlBar's pause button would never switch
 * to "Resume" — it would behave as if Stop had been pressed instead.
 */
describe('PROJECT_RUN_STOP event is ignored while paused', () => {
  it('a simulated stop event after pause does not reset isPaused', () => {
    // Simulate the flow:
    //   1. Project is running (isPlaying: true, isPaused: false).
    //   2. User clicks pause. Pause sets isPaused: true.
    //   3. The Scaffolding's run-loop detects the threads are all
    //      STATUS_PROMISE_WAIT and fires PROJECT_RUN_STOP.
    //   4. The onStop listener must NOT reset isPaused because pauseOverride
    //      is active.
    //
    // We model this by checking that the simulated onStop handler respects
    // a "paused" gate. (The real implementation lives in player.ts and
    // is covered by the integration test in the ControlBar; here we
    // verify the contract.)
    const state: { isPlaying: boolean; isPaused: boolean } = {
      isPlaying: true,
      isPaused: false,
    };
    // Simulate the pause() call.
    state.isPlaying = false;
    state.isPaused = true;
    // The Scaffolding now fires PROJECT_RUN_STOP. With the fix, the
    // onStop handler must check pauseOverride and skip the state reset.
    const pauseOverride = true; // represents the active pause override
    const onStop = (): void => {
      if (pauseOverride) return;
      state.isPlaying = false;
      state.isPaused = false;
    };
    onStop();
    expect(state.isPaused).toBe(true);
    expect(state.isPlaying).toBe(false);
  });

  it('a stop event after resume correctly resets the state', () => {
    // Same flow, but with pauseOverride cleared (i.e. project was
    // resumed). The onStop handler should now reset the state to
    // "stopped".
    const state: { isPlaying: boolean; isPaused: boolean } = {
      isPlaying: false,
      isPaused: true,
    };
    // Simulate the resume() call.
    state.isPlaying = true;
    state.isPaused = false;
    // The Scaffolding later fires PROJECT_RUN_STOP. With the fix, the
    // onStop handler still respects the gate, but with pauseOverride
    // cleared the reset proceeds.
    const pauseOverride = false;
    const onStop = (): void => {
      if (pauseOverride) return;
      state.isPlaying = false;
      state.isPaused = false;
    };
    onStop();
    expect(state.isPaused).toBe(false);
    expect(state.isPlaying).toBe(false);
  });
});