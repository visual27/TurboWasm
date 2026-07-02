import { create } from 'zustand';

export interface PlayerStoreState {
  isPlaying: boolean;
  /** True when the project is paused (threads frozen via vm.pause() but still loaded). */
  isPaused: boolean;
  isFullscreen: boolean;
  containerSize: { width: number; height: number };
  stageScale: number;
  /**
   * Asset loading progress reported by the Scaffolding's ASSET_PROGRESS
   * event. finished = 0 and total = 0 means the loader has not yet
   * reported a total (indeterminate).
   */
  assetProgress: { finished: number; total: number };
  setPlaying: (isPlaying: boolean) => void;
  setPaused: (isPaused: boolean) => void;
  setFullscreen: (isFullscreen: boolean) => void;
  setContainerSize: (size: { width: number; height: number }) => void;
  setStageScale: (scale: number) => void;
  setAssetProgress: (finished: number, total: number) => void;
  resetAssetProgress: () => void;
}

export const usePlayerStore = create<PlayerStoreState>((set) => ({
  isPlaying: false,
  isPaused: false,
  isFullscreen: false,
  containerSize: { width: 0, height: 0 },
  stageScale: 1,
  assetProgress: { finished: 0, total: 0 },
  setPlaying: (isPlaying) => set({ isPlaying }),
  setPaused: (isPaused) => set({ isPaused }),
  setFullscreen: (isFullscreen) => set({ isFullscreen }),
  setContainerSize: (containerSize) => set({ containerSize }),
  setStageScale: (stageScale) => set({ stageScale }),
  setAssetProgress: (finished, total) => set({ assetProgress: { finished, total } }),
  resetAssetProgress: () => set({ assetProgress: { finished: 0, total: 0 } }),
}));