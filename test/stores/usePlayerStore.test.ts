import { describe, expect, it, beforeEach } from 'vitest';
import { usePlayerStore } from '@/stores/usePlayerStore';

describe('usePlayerStore', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      isPlaying: false,
      isPaused: false,
      isFullscreen: false,
      assetProgress: { finished: 0, total: 0 },
    });
  });

  it('exposes the expected public fields', () => {
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.isPaused).toBe(false);
    expect(state.isFullscreen).toBe(false);
    expect(state.assetProgress).toEqual({ finished: 0, total: 0 });
    expect(typeof state.setPlaying).toBe('function');
    expect(typeof state.setPaused).toBe('function');
    expect(typeof state.setFullscreen).toBe('function');
    expect(typeof state.setAssetProgress).toBe('function');
    expect(typeof state.resetAssetProgress).toBe('function');
  });

  it('does not expose the removed containerSize / stageScale fields (Phase 2-2 regression)', () => {
    // The Phase 2-2 cleanup removed these unused state slots. Guard against
    // any re-introduction that would re-trigger per-resize store writes.
    const state = usePlayerStore.getState() as unknown as Record<string, unknown>;
    expect(state['containerSize']).toBeUndefined();
    expect(state['setContainerSize']).toBeUndefined();
    expect(state['stageScale']).toBeUndefined();
    expect(state['setStageScale']).toBeUndefined();
  });

  it('setAssetProgress replaces the assetProgress object', () => {
    usePlayerStore.getState().setAssetProgress(7, 20);
    expect(usePlayerStore.getState().assetProgress).toEqual({ finished: 7, total: 20 });
  });

  it('resetAssetProgress zeros both finished and total', () => {
    usePlayerStore.getState().setAssetProgress(99, 100);
    usePlayerStore.getState().resetAssetProgress();
    expect(usePlayerStore.getState().assetProgress).toEqual({ finished: 0, total: 0 });
  });

  it('setFullscreen flips the flag', () => {
    usePlayerStore.getState().setFullscreen(true);
    expect(usePlayerStore.getState().isFullscreen).toBe(true);
    usePlayerStore.getState().setFullscreen(false);
    expect(usePlayerStore.getState().isFullscreen).toBe(false);
  });
});
