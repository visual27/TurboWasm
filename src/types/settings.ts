export type Theme = 'system' | 'dark' | 'light';

export type ScaffoldingResizeMode = 'preserve-ratio' | 'dynamic-resize' | 'stretch';

/**
 * Sandbox mode for custom extensions loaded from a project.
 *
 *  - 'worker':      run inside a Web Worker. Most isolated; same as
 *                   vanilla Scratch. This is the safe default.
 *  - 'iframe':      run inside a same-origin <iframe> with `sandbox` set.
 *                   Slightly less isolated than a worker (no separate
 *                   thread) but matches the historical TurboWarp behavior.
 *  - 'unsandboxed': run the extension inline in the main page. The
 *                   extension has full DOM/JS access to the viewer. Use
 *                   only with trusted projects.
 *  - 'disabled':    do not load any project extensions. The viewer
 *                   strips the `extensions` and `extensionURLs` fields
 *                   from `project.json` before handing the buffer to the
 *                   VM, so the project loads normally but extension
 *                   blocks are simply not available. Useful when a
 *                   trusted project ships extensions the user does not
 *                   want to evaluate.
 */
export type ExtensionSandboxMode =
  | 'worker'
  | 'iframe'
  | 'unsandboxed'
  | 'disabled';

export interface AdvancedSettings {
  fps: number;
  interpolation: boolean;
  highQualityPen: boolean;
  warpTimer: boolean;
  infiniteClones: boolean;
  removeFencing: boolean;
  removeMiscLimits: boolean;
  turboMode: boolean;
  disableCompiler: boolean;
  stageWidth: number;
  stageHeight: number;
  /**
   * Sandbox mode applied to extensions loaded from the project. See
   * {@link ExtensionSandboxMode} for the trade-offs. The user picks this
   * from inside the Extension Permission dialog the first time a project
   * requests custom extensions.
   *
   * Default: 'worker' (safe).
   */
  extensionSandboxMode: ExtensionSandboxMode;
  /**
   * Whether CPU-heavy collision detection (`isTouchingColor`,
   * `isTouchingDrawables`) is offloaded to the TurboWasm WebAssembly module.
   *
   * When `true` and the runtime detected `WASM SIMD` support, the vendored
   * scratch-render falls through to the WASM batch collision API. When
   * `false`, the original JavaScript loop in `RenderWebGL` is used
   * unconditionally (useful for debugging parity).
   *
   * This is an Others-section field: it persists across reloads via the
   * settings store, but `saveAdvancedAsDefault()` forces it back to `true`
   * so the user cannot accidentally lock themselves into the legacy path.
   */
  turboWasmAccelerationEnabled: boolean;
  /**
   * Whether compute-kernel regions marked with the `@compute` comment DSL
   * (see `src/runtime/gpu-kernel/comment-parser.ts`) are offloaded to
   * WebGPU compute shaders.
   *
   * `true` (default): the pre-parse pipeline parses the DSL, runs the
   * D1/D2/D3 static analyses, and tries to install WebGPU compute
   * pipelines for every eligible region. Failures fall back to the JS
   * path (D1/D3 demote the whole region; D4 demotes at runtime when the
   * device is lost).
   *
   * `false`: the pre-parse pipeline still runs (so D1 demoted regions
   * surface in the ErrorLogPanel as informational entries), but no
   * pipelines are created and the VM hook short-circuits straight to the
   * JS path.
   *
   * `saveAdvancedAsDefault()` forces this back to `true` for the same
   * reason as `turboWasmAccelerationEnabled`: the user cannot lock
   * themselves off the GPU path.
   *
   * Renamed from `enableGpuKernels` in v8 alongside the Performance Mode
   * simplification (the old dropdown was reduced to a single `enableWasm`
   * toggle, leaving the WebGPU path as a separate, independent switch).
   */
  enableWebgpu: boolean;
}

/**
 * Upper bound on the persisted allow-list size. Defends against a malicious
 * project that lists thousands of unique URLs from bloating localStorage.
 */
export const ALLOWED_EXTENSION_URLS_MAX = 1000;

export interface UISettings {
  theme: Theme;
  volume: number;
  lastNonMuteVolume: number;
  /**
   * Current effective advanced settings. May diverge from `defaultAdvanced`
   * after in-session edits or `project.json` runtime settings overrides.
   */
  advanced: AdvancedSettings;
  /**
   * Saved default advanced settings. Only updated when the user explicitly
   * presses the "Set as default" button in the Settings dialog, and it
   * excludes the Others-section fields (volume + disableCompiler). The
   * `disableCompiler` value here is always `false` regardless of what the
   * runtime `advanced.disableCompiler` happens to be.
   */
  defaultAdvanced: AdvancedSettings;
  /**
   * Persistent allow-list of custom extension URLs the user has previously
   * approved. These URLs are loaded automatically on subsequent project
   * loads without re-prompting.
   */
  allowedExtensionUrls: string[];
  /**
   * Whether the WASM-SIMD acceleration hooks are installed on the
   * renderer. `true` (default): the runtime picks WASM SIMD when
   * supported and falls back to the JS path otherwise (the previous
   * `performanceMode: 'auto'` behaviour). `false`: every TurboWasm hook
   * is cleared so the runtime behaves identically to unmodified
   * scratch-render (the previous `performanceMode: 'legacy-only'`
   * DoD parity mode).
   *
   * Replaces the v3..v7 `performanceMode: 'auto' | 'force-wasm' |
   * 'legacy-only'` union. The historical `'force-wasm'` value is
   * collapsed into `'auto'` because the runtime never differentiated
   * the two (both install the WASM hook when `wasmReady` is true and
   * silently fall back to the JS path otherwise — see
   * `src/runtime/tw-wasm/applyTurboWasmAcceleration.ts:selectBackendTier`).
   * Persisted across sessions so a power user can lock the parity mode
   * without losing it on reload.
   */
  enableWasm: boolean;
}

export interface SettingsStoreShape {
  theme: Theme;
  volume: number;
  lastNonMuteVolume: number;
  advanced: AdvancedSettings;
  defaultAdvanced: AdvancedSettings;
  allowedExtensionUrls: string[];
  enableWasm: boolean;
  /**
   * Most recent non-30 fps the user explicitly chose (via the Settings
   * dialog NumberField, "Set as default", or Alt+Flag from a non-30
   * value). Used as priority-1 of `useSettingsStore.cycleFpsShortcut`'s
   * "preferred FPS" computation so the Alt+Flag toggle round-trips
   * across both presses and reloads. `null` means the user has never
   * set an explicit non-30 fps; the toggle falls back to
   * `defaultAdvanced.fps` (when !== 30) or 60. Migrated from
   * `advanced.fps` / `defaultAdvanced.fps` on the v4 → v5 read.
   */
  userExplicitFps: number | null;
}

export interface SettingsStoreSerialized {
  state: SettingsStoreShape;
  version: number;
}
