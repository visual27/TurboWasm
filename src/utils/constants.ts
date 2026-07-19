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
  turboWasmAccelerationEnabled: true,
  enableWebgpu: true,
  /**
   * Phase 4 (nested-parallelization-05-phase4 §3.5). Default `false` —
   * existing users keep the legacy outer-only `@compute` layout until they
   * explicitly opt in. The toggle in the Settings dialog (TurboWasm
   * section) flips the runtime path that
   * {@link import('@/runtime/player.ts').bootstrapGpuKernels} uses when a
   * project's `@compute` marker sits on a nested `control_repeat`
   * (= kernel container is the candidate's nearest `control_repeat`
   * ancestor, not the candidate itself). `false` keeps the legacy JS path
   * for nested layouts; `true` lets the new nested-parallelization path
   * attempt GPU dispatch.
   */
  nestedParallelizationEnabled: false,
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
// shortcut's round-trip behavior). Bumped to 6 when the
// `svgAccelerationMode` field and its top-level mirror were retired
// along with the WebGPU compute tier (Phase 2) and the WebGPU instanced
// renderer (Phase 3) — both were never wired beyond feature detection.
// v5 → v6 migration downgrades any `performanceMode: 'force-webgpu'`
// payload to `'auto'` so a user who had pinned WebGPU before the
// removal does not silently end up on a no-op path. Bumped to 7 when
// `advanced.enableGpuKernels` was added for the GPU compute kernel
// pipeline (M1 of the GPU kernel plan, see
// `src/runtime/gpu-kernel/`). v6 → v7 migration fills the field with
// `true` for existing payloads; the field is otherwise identical in
// shape to `turboWasmAccelerationEnabled`. Bumped to 8 when the
// top-level `performanceMode` union was collapsed into a single
// `enableWasm: boolean` (the three-way `'auto' | 'force-wasm' |
// 'legacy-only'` choice was reduced to a single switch — `force-wasm`
// was functionally identical to `auto`, so it was removed to avoid
// confusing dead-end options) and `advanced.enableGpuKernels` was
// renamed to `advanced.enableWebgpu` to align the field name with the
// user-facing label. v7 → v8 migration converts both fields in place:
// `performanceMode` collapses to `enableWasm` (`auto`/`force-wasm` →
// `true`, `legacy-only` → `false`), and `advanced.enableGpuKernels`
// is renamed to `advanced.enableWebgpu` while keeping the same boolean
// value. Bumped to 9 when `advanced.nestedParallelizationEnabled` was
// added (Phase 4 of the nested-parallelization plan). The toggle gates
// the GPU compute path for projects whose `@compute` marker sits on a
// nested `control_repeat` (kernel container promoted to the candidate's
// nearest ancestor). v8 → v9 migration seeds the field with `false`
// so existing users keep the legacy outer-only behaviour until they
// explicitly opt in. Older payloads are read and migrated on the fly —
// see `src/lib/persistence.ts`.
export const STORAGE_VERSION = 9;

/**
 * Default value for `enableWasm` when no user preference has been
 * persisted yet (or when the legacy migration runs). `true` lets the
 * runtime pick WASM SIMD when supported and fall back to the JS path
 * otherwise (the previous `'auto'` behaviour, which is also what the
 * now-deleted `'force-wasm'` mode did).
 */
export const DEFAULT_ENABLE_WASM = true;

export const ENV = {
  githubRepoUrl:
    (import.meta.env.VITE_GITHUB_REPO_URL as string | undefined) ??
    'https://github.com/visual27/TurboWasm',
} as const;
