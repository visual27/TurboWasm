import type { AdvancedSettings } from '@/types/settings';

export const APP_NAME = 'TurboWasm Viewer';

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
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

export const STAGE_MIN_WIDTH = 1;
export const STAGE_MAX_WIDTH = 8192;
export const STAGE_MIN_HEIGHT = 1;
export const STAGE_MAX_HEIGHT = 8192;
export const FPS_MIN = 1;
export const FPS_MAX = 240;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;

export const STORAGE_KEYS = {
  settings: 'tw-viewer:settings:v1',
} as const;

export const STORAGE_VERSION = 1;

export const ENV = {
  githubRepoUrl:
    (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
    'https://github.com/visual27/TurboWasm',
} as const;