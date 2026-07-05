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
}

export interface SettingsStoreShape {
  theme: Theme;
  volume: number;
  lastNonMuteVolume: number;
  advanced: AdvancedSettings;
  defaultAdvanced: AdvancedSettings;
  allowedExtensionUrls: string[];
}

export interface SettingsStoreSerialized {
  state: SettingsStoreShape;
  version: number;
}
