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
  extensionSandboxMode: 'worker',
};

export const DEFAULT_ALLOWED_EXTENSION_URLS: readonly string[] = [];

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

// Bumped to 2 when the schema split `advanced` (runtime state) and
// `defaultAdvanced` (saved defaults) into separate fields, and forced
// `disableCompiler` to always start as `false`. v1 payloads are read and
// migrated on the fly — see `src/lib/persistence.ts`.
export const STORAGE_VERSION = 2;

export const ENV = {
  githubRepoUrl:
    (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
    'https://github.com/visual27/TurboWasm',
} as const;
