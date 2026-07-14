import type { AdvancedSettings, PerformanceMode, SvgAccelerationMode } from '@/types/settings';

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
  turboWasmAccelerationEnabled: true,
  svgAccelerationMode: 'off',
};

export const DEFAULT_ALLOWED_EXTENSION_URLS: readonly string[] = [];

export const STAGE_MIN_WIDTH = 1;
export const STAGE_MAX_WIDTH = 8192;
export const STAGE_MIN_HEIGHT = 1;
export const STAGE_MAX_HEIGHT = 8192;
export const FPS_MIN = 1;
export const FPS_MAX = 1000;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;

export const STORAGE_KEYS = {
  settings: 'tw-viewer:settings:v1',
} as const;

// Bumped to 2 when the schema split `advanced` (runtime state) and
// `defaultAdvanced` (saved defaults) into separate fields, and forced
// `disableCompiler` to always start as `false`. Bumped to 3 when the
// schema added the top-level `performanceMode` field. Bumped to 4 when
// `advanced` gained the `svgAccelerationMode` field (Stage 2 of the
// TurboWasm Acceleration plan). Bumped to 5 when the top-level
// `userExplicitFps` field was added to remember the user's most recent
// non-30 fps across toggles and reloads (drives the Alt+Flag FPS
// shortcut's round-trip behavior). Older payloads are read and migrated
// on the fly — see `src/lib/persistence.ts`.
export const STORAGE_VERSION = 5;

/**
 * Default value for `performanceMode` when no user preference has been
 * persisted yet (or when the legacy migration runs). `auto` lets the
 * runtime pick the best backend per environment.
 */
export const DEFAULT_PERFORMANCE_MODE: PerformanceMode = 'auto';

/**
 * Default value for `svgAccelerationMode` when no user preference has
 * been persisted yet (or when the legacy v3 → v4 migration runs). `off`
 * keeps the runtime on the Stage 1 TurboWarp-native SVG path so a user
 * upgrading their saved settings picks up the recommended default with
 * zero visual change.
 */
export const DEFAULT_SVG_ACCELERATION_MODE: SvgAccelerationMode = 'off';

export const ENV = {
  githubRepoUrl:
    (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
    'https://github.com/visual27/TurboWasm',
} as const;
