export type Theme = 'system' | 'dark' | 'light';

export type ScaffoldingResizeMode = 'preserve-ratio' | 'dynamic-resize' | 'stretch';

/**
 * Selects which collision-detection / rendering backend the runtime prefers.
 *
 *  - `'auto'`:         WebGPU when supported, then WASM SIMD, then the
 *                      original JavaScript path. The default for new users.
 *  - `'force-wasm'`:   WASM SIMD is always used when it initialised
 *                      successfully; never falls through to WebGPU. Falls
 *                      back to the JavaScript path when WASM SIMD is
 *                      unavailable.
 *  - `'force-webgpu'`: WebGPU when supported. Falls through to WASM SIMD,
 *                      then JavaScript, when WebGPU is unavailable. Useful
 *                      for benchmarking the GPU pipeline on a known-good
 *                      machine.
 *  - `'legacy-only'`:  All TurboWasm hooks are cleared; the runtime behaves
 *                      identically to the unmodified scratch-render. This
 *                      satisfies the Definition of Done parity requirement
 *                      (legacy output must be byte-identical to the
 *                      upstream renderer).
 */
export type PerformanceMode = 'auto' | 'force-wasm' | 'force-webgpu' | 'legacy-only';

export const PERFORMANCE_MODES: readonly PerformanceMode[] = [
  'auto',
  'force-wasm',
  'force-webgpu',
  'legacy-only',
] as const;

/**
 * Selects the SVG rendering acceleration strategy for the vendored
 * scratch-render. Stage 2 of the TurboWasm Acceleration plan. Default is
 * `off` so the runtime stays bit-identical with the TurboWarp native
 * `drawImage(this._svgImage, 0, 0)` path (Stage 1 baseline).
 *
 *  - `'off'`:      Stage 1 baseline. No TurboWasm SVG hooks are installed,
 *                  so SVGSkin falls through to the upstream `drawImage`
 *                  path exactly as shipped by TurboWarp. Pixel-identical
 *                  output to the unmodified renderer. Recommended default
 *                  for users who care about exact TurboWarp reproduction.
 *  - `'cache-only'`: Reuse the browser's decoded `ImageBitmap` for the
 *                  same SVG across `setSVG` calls. Cuts the browser
 *                  SVG-parse cost when the same costume is reloaded (e.g.
 *                  costume switching, project reload). Still uses
 *                  `drawImage` for the final rasterisation so the
 *                  pixel output is bit-identical to `'off'`.
 *  - `'mip-chain'`: Pre-decode multiple MIP scales (0.25x / 0.5x / 1x /
 *                  2x / 4x) and offload large SVG decode to a Web Worker
 *                  via `OffscreenCanvas` when available. Falls back to
 *                  the main thread on Safari FP (no OffscreenCanvas).
 *                  Pixel output is bit-identical to `'off'` because the
 *                  MIP rasterisation still uses the browser's native
 *                  decoder.
 *  - `'resvg-visual-equivalence'`: Reserved for a future Stage. When
 *                  implemented, will opt into a `resvg-wasm` SVG raster
 *                  path that targets PSNR ≥ 40 dB / SSIM ≥ 0.99 against
 *                  the browser-native path. The setting is exposed in the
 *                  schema for forward-compatibility but the UI does not
 *                  surface it and the runtime treats it as `'off'` until
 *                  a later commit wires the resvg hook.
 */
export type SvgAccelerationMode =
  | 'off'
  | 'cache-only'
  | 'mip-chain'
  | 'resvg-visual-equivalence';

export const SVG_ACCELERATION_MODES: readonly SvgAccelerationMode[] = [
  'off',
  'cache-only',
  'mip-chain',
  'resvg-visual-equivalence',
] as const;

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
   * SVG rendering acceleration strategy (Stage 2 of the TurboWasm
   * Acceleration plan). The default is `off` so the runtime stays
   * pixel-identical to the TurboWarp native `drawImage(this._svgImage)`
   * path. `cache-only` / `mip-chain` are opt-in speedups that preserve
   * bit-identity; `resvg-visual-equivalence` is reserved for a future
   * Stage and treated as `off` until the resvg hook is wired.
   *
   * Persists across reloads via the settings store. `saveAdvancedAsDefault()`
   * preserves the user's choice (unlike `turboWasmAccelerationEnabled`
   * which is always forced to `true`) because the field is a
   * pre-computed preference, not a "broken state" safety toggle.
   */
  svgAccelerationMode: SvgAccelerationMode;
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
   * Backend selection for the TurboWasm acceleration pipeline (Phase 0..3
   * of the performance spec). Persisted across sessions so the user does
   * not have to re-pick their preferred backend on every reload.
   *
   * `legacy-only` is intentionally persisted: power users may want to
   * compare against the unmodified scratch-render without losing that
   * choice to a "Set as default" reset.
   */
  performanceMode: PerformanceMode;
}

export interface SettingsStoreShape {
  theme: Theme;
  volume: number;
  lastNonMuteVolume: number;
  advanced: AdvancedSettings;
  defaultAdvanced: AdvancedSettings;
  allowedExtensionUrls: string[];
  performanceMode: PerformanceMode;
  /**
   * Top-level mirror of `advanced.svgAccelerationMode` so the runtime
   * can read the active mode without traversing the `advanced` shape.
   * Kept in sync via `useSettingsStore.setSvgAccelerationMode` and the
   * v3 → v4 migration in `src/lib/persistence.ts`.
   */
  svgAccelerationMode: SvgAccelerationMode;
}

export interface SettingsStoreSerialized {
  state: SettingsStoreShape;
  version: number;
}
