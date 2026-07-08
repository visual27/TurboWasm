import { create } from 'zustand';
import type {
  AdvancedSettings,
  ExtensionSandboxMode,
  PerformanceMode,
  SvgAccelerationMode,
  Theme,
} from '@/types/settings';
import { ALLOWED_EXTENSION_URLS_MAX } from '@/types/settings';
import {
  DEFAULT_ALLOWED_EXTENSION_URLS,
  DEFAULT_PERFORMANCE_MODE,
  DEFAULT_SVG_ACCELERATION_MODE,
  VOLUME_MAX,
  VOLUME_MIN,
} from '@/utils/constants';
import { clampVolume } from '@/utils/format';
import { readSettings, writeSettings } from '@/lib/persistence';
import { buildProjectAdvanced } from '@/runtime/twconfig';

export interface SettingsState {
  theme: Theme;
  volume: number;
  /**
   * The volume to restore when un-muting via the speaker button. We only
   * update this field when the user explicitly mutes via the button, NOT
   * when the slider is dragged to 0. This way:
   *
   *  - Button click when un-muted → save current as lastNonMuteVolume, set
   *    volume to 0.
   *  - Button click when muted → restore lastNonMuteVolume (if > 0),
   *    otherwise fall back to VOLUME_MAX.
   *  - Slider drag to 0 → does NOT touch lastNonMuteVolume, so the next
   *    button click falls back to VOLUME_MAX (the "previous value is
   *    unknown" case from the spec).
   */
  lastNonMuteVolume: number;
  /**
   * Current effective advanced settings. Reflects runtime `project.json`
   * overrides and in-session edits via the Settings dialog. The runtime
   * SettingsView subscribes to this slice.
   */
  advanced: AdvancedSettings;
  /**
   * Saved default advanced settings. Only updated when the user explicitly
   * presses the "Set as default" button in the Settings dialog. Excludes
   * the Others-section fields: `disableCompiler` is always `false` here.
   */
  defaultAdvanced: AdvancedSettings;
  /**
   * Persistent allow-list of custom extension URLs the user has previously
   * approved. These URLs are loaded automatically on subsequent project
   * loads without re-prompting. Bounded by
   * {@link ALLOWED_EXTENSION_URLS_MAX}.
   */
  allowedExtensionUrls: string[];
  /**
   * Backend selection for the TurboWasm acceleration pipeline. Persisted
   * (unlike `disableCompiler`) so a power user can pick `legacy-only` for a
   * parity test and have that choice survive a reload. See
   * {@link PerformanceMode} for the full set of values.
   */
  performanceMode: PerformanceMode;
  /**
   * SVG rendering acceleration strategy (Stage 2). The runtime applies
   * this via `applySvgAcceleration(scaffolding, { mode })`; the top-level
   * mirror here lets the Settings dialog and the `!dump` debug command
   * read the active mode without traversing the `advanced` shape. See
   * {@link SvgAccelerationMode} for the full set of values.
   */
  svgAccelerationMode: SvgAccelerationMode;
  setTheme: (theme: Theme) => void;
  setVolume: (volume: number) => void;
  /**
   * Toggle the mute state. If currently muted (volume === 0), restore
   * `lastNonMuteVolume`; if that is 0 or unknown, fall back to
   * `VOLUME_MAX`. If currently audible, save the current volume as
   * `lastNonMuteVolume` and set the volume to 0.
   *
   * Returns the new volume.
   */
  toggleMute: () => number;
  /**
   * Update one or more runtime advanced settings in memory. Does NOT write
   * to localStorage — the user must press "Set as default" to make the
   * change permanent. This is what the Settings dialog's switches / number
   * fields call.
   */
  patchAdvanced: (patch: Partial<AdvancedSettings>) => void;
  /**
   * Apply runtime settings overrides parsed from a `project.json`
   * `_twconfig_` comment. Merged into `advanced` (in memory only) so the
   * Settings dialog reflects the same values the VM is currently using.
   * Does NOT persist.
   */
  applyRuntimeOverrides: (overrides: Partial<AdvancedSettings>) => void;
  /**
   * Promote the current runtime `advanced` into the saved
   * `defaultAdvanced`. The Others-section fields are excluded:
   * `disableCompiler` is always forced to `false` (and volume lives at the
   * top level so it is not part of this snapshot either). All other
   * advanced settings — including the current `extensionSandboxMode` —
   * become the new defaults.
   *
   * Persists immediately.
   */
  saveAdvancedAsDefault: () => void;
  /**
   * Dedicated setter for `extensionSandboxMode`. Treated as a user
   * preference that should persist across reloads (mirroring how volume
   * persists immediately), so the call updates both the runtime
   * `advanced` AND the saved `defaultAdvanced`, then persists.
   */
  setExtensionSandboxMode: (mode: ExtensionSandboxMode) => void;
  /**
   * Reset runtime `advanced` to the saved `defaultAdvanced`. Forces
   * `disableCompiler` back to `false` so the runtime toggle is never
   * silently re-enabled by stale persisted state.
   *
   * Persists immediately.
   */
  resetAdvanced: () => void;
  /**
   * Append one URL to the persistent allow-list. No-op if already present
   * or if the list is at capacity. Returns true if the list changed.
   */
  addAllowedExtensionUrl: (url: string) => boolean;
  /**
   * Append many URLs to the persistent allow-list. Duplicates against
   * the existing list and within `urls` are dropped. Returns the number
   * of URLs that were newly added.
   */
  addAllowedExtensionUrls: (urls: readonly string[]) => number;
  /**
   * Remove a URL from the persistent allow-list. Returns true if the
   * list changed.
   */
  removeAllowedExtensionUrl: (url: string) => boolean;
  /**
   * Clear the entire allow-list. Used by the Settings reset action.
   */
  clearAllowedExtensionUrls: () => void;
  /**
   * Update the backend selection (`auto` / `force-wasm` / `force-webgpu` /
   * `legacy-only`). Persists immediately so the next reload picks up the
   * same backend without re-prompting the user.
   */
  setPerformanceMode: (mode: PerformanceMode) => void;
  /**
   * Update the SVG rendering acceleration strategy (Stage 2 of the
   * TurboWasm Acceleration plan). Persists immediately so a reload
   * picks up the same SVG acceleration path. The choice also
   * propagates into `advanced.svgAccelerationMode` so the
   * `applyRuntimeOverrides` / `buildProjectAdvanced` merge sees it.
   */
  setSvgAccelerationMode: (mode: SvgAccelerationMode) => void;
}

const initial = readSettings();

/**
 * Decide the new volume when the user clicks the speaker button.
 *
 *  - If currently muted (volume === 0): restore lastNonMuteVolume if it
 *    is > 0; otherwise fall back to VOLUME_MAX.
 *  - If currently audible (volume > 0): remember the current volume so we
 *    can restore it on the next toggle, and set volume to 0.
 */
export function computeMuteToggle(
  currentVolume: number,
  lastNonMuteVolume: number,
): { volume: number; lastNonMuteVolume: number } {
  if (currentVolume <= VOLUME_MIN) {
    // Currently muted. Restore the previous value if known, else 100.
    const restored = lastNonMuteVolume > VOLUME_MIN ? lastNonMuteVolume : VOLUME_MAX;
    return { volume: restored, lastNonMuteVolume: lastNonMuteVolume };
  }
  // Currently audible. Save the current value and mute.
  return { volume: VOLUME_MIN, lastNonMuteVolume: currentVolume };
}

// High-frequency setters (setVolume, setExtensionSandboxMode) coalesce their
// disk writes through this microtask + idle debouncer. The latest snapshot
// wins; intermediate states are skipped. We still flush synchronously on
// setTheme / saveAdvancedAsDefault / resetAdvanced / toggleMute so the rare
// but user-meaningful "Settings closed, expect the next page load to keep my
// choice" expectation is preserved.
//
// `patchAdvanced` and `applyRuntimeOverrides` are intentionally NOT
// debounced here: they only mutate the in-memory runtime `advanced` and
// must not touch localStorage until the user explicitly presses "Set as
// default".
let pendingSnapshot: SettingsState | null = null;
let scheduled = false;
function schedulePersist(snapshot: SettingsState): void {
  pendingSnapshot = snapshot;
  if (scheduled) return;
  scheduled = true;
  // Use queueMicrotask to coalesce synchronous bursts (e.g. a slider that
  // fires 60 events in 1s → one persist call), and requestIdleCallback to
  // defer the actual localStorage write off the critical render path.
  queueMicrotask(() => {
    const cb = (): void => {
      scheduled = false;
      if (pendingSnapshot) {
        const snap = pendingSnapshot;
        pendingSnapshot = null;
        writeSettings({
          theme: snap.theme,
          volume: snap.volume,
          lastNonMuteVolume: snap.lastNonMuteVolume,
          advanced: snap.advanced,
          defaultAdvanced: snap.defaultAdvanced,
          allowedExtensionUrls: snap.allowedExtensionUrls,
          performanceMode: snap.performanceMode,
          svgAccelerationMode: snap.svgAccelerationMode,
        });
      }
    };
    if (
      typeof (globalThis as { requestIdleCallback?: (cb: () => void) => void })
        .requestIdleCallback === 'function'
    ) {
      (globalThis as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(cb);
    } else {
      // Fallback for environments without requestIdleCallback (older Safari,
      // Node, jsdom). The 50 ms delay keeps it off the immediate paint path
      // while staying responsive on browsers that lack idle callbacks.
      setTimeout(cb, 50);
    }
  });
}

function persistImmediate(state: SettingsState): void {
  // Cancel any debounced write so we don't overwrite this one with stale data.
  pendingSnapshot = null;
  scheduled = false;
  writeSettings({
    theme: state.theme,
    volume: state.volume,
    lastNonMuteVolume: state.lastNonMuteVolume,
    advanced: state.advanced,
    defaultAdvanced: state.defaultAdvanced,
    allowedExtensionUrls: state.allowedExtensionUrls,
    performanceMode: state.performanceMode,
    svgAccelerationMode: state.svgAccelerationMode,
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: initial.theme,
  volume: initial.volume,
  // If the persisted volume is already 0 (e.g. the user muted last session
  // and never came back), we have no way to know what to restore. The
  // 100 % fallback is applied at toggle time, so we can keep this 0 here.
  lastNonMuteVolume: initial.lastNonMuteVolume ?? initial.volume,
  advanced: initial.advanced,
  defaultAdvanced: initial.defaultAdvanced,
  allowedExtensionUrls: [...initial.allowedExtensionUrls],
  performanceMode: initial.performanceMode ?? DEFAULT_PERFORMANCE_MODE,
  svgAccelerationMode:
    initial.svgAccelerationMode ?? initial.advanced.svgAccelerationMode ?? DEFAULT_SVG_ACCELERATION_MODE,
  setTheme: (theme) => {
    set({ theme });
    persistImmediate(get());
  },
  setVolume: (volume) => {
    // Slider-driven changes use the debounced writer so dragging a slider
    // doesn't stall the main thread on every tick.
    const next = clampVolume(volume);
    set({ volume: next });
    schedulePersist(get());
  },
  toggleMute: () => {
    const { volume, lastNonMuteVolume } = get();
    const { volume: next, lastNonMuteVolume: nextLast } = computeMuteToggle(
      volume,
      lastNonMuteVolume,
    );
    set({ volume: next, lastNonMuteVolume: nextLast });
    persistImmediate(get());
    return next;
  },
  patchAdvanced: (patch) => {
    // In-memory only. The Settings dialog edits the runtime `advanced`
    // without persisting — the user must press "Set as default" to make
    // changes survive a reload.
    const merged: AdvancedSettings = { ...get().advanced, ...patch };
    set({ advanced: merged });
  },
  applyRuntimeOverrides: (overrides) => {
    // Project-scoped runtime settings: always reset to the saved
    // `defaultAdvanced` first, then apply the project's overrides on
    // top. This is the canonical "TurboWarp twconfig takes priority"
    // merge: keys present in `overrides` win, keys absent fall back to
    // the saved defaults, and the previous project's overrides never
    // leak forward.
    //
    // We always reset (even with an empty `overrides`) so that loading
    // a project without a `// _twconfig_` comment still clears the
    // prior project's overrides from the runtime `advanced` — the
    // player calls this on every project load for that reason.
    //
    // The actual merge logic lives in
    // {@link buildProjectAdvanced} (src/runtime/twconfig.ts) so the
    // module-local `currentAdvanced` in player.ts and the store-side
    // `advanced` here are computed by the same function and can never
    // drift.
    const merged = buildProjectAdvanced(get().defaultAdvanced, overrides);
    set({ advanced: merged });
  },
  saveAdvancedAsDefault: () => {
    // "Set as default": snapshot the current runtime advanced into
    // `defaultAdvanced`, excluding the Others-section fields. Volume is
    // already persisted via `setVolume`; `disableCompiler` is always
    // forced off and `turboWasmAccelerationEnabled` is always forced on
    // so a user who disabled acceleration cannot lock themselves into the
    // legacy path via "Set as default".
    const { advanced } = get();
    const snapshot: AdvancedSettings = {
      ...advanced,
      disableCompiler: false,
      turboWasmAccelerationEnabled: true,
    };
    set({ defaultAdvanced: snapshot });
    persistImmediate(get());
  },
  setExtensionSandboxMode: (mode) => {
    // Special case: extension sandbox mode is treated like volume — it
    // persists immediately. Both the runtime `advanced` and the saved
    // `defaultAdvanced` are kept in sync so "Reset to defaults" keeps the
    // user's most recent sandbox choice.
    const nextAdvanced: AdvancedSettings = { ...get().advanced, extensionSandboxMode: mode };
    const nextDefault: AdvancedSettings = {
      ...get().defaultAdvanced,
      extensionSandboxMode: mode,
    };
    set({ advanced: nextAdvanced, defaultAdvanced: nextDefault });
    schedulePersist(get());
  },
  resetAdvanced: () => {
    // Reset the runtime to the saved defaults (with disableCompiler forced
    // off) and clear the extension allow-list.
    const next: AdvancedSettings = { ...get().defaultAdvanced, disableCompiler: false };
    set({
      advanced: next,
      allowedExtensionUrls: [...DEFAULT_ALLOWED_EXTENSION_URLS],
    });
    persistImmediate(get());
  },
  addAllowedExtensionUrl: (url) => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return false;
    const current = get().allowedExtensionUrls;
    if (current.includes(trimmed)) return false;
    if (current.length >= ALLOWED_EXTENSION_URLS_MAX) return false;
    set({ allowedExtensionUrls: [...current, trimmed] });
    persistImmediate(get());
    return true;
  },
  addAllowedExtensionUrls: (urls) => {
    const current = get().allowedExtensionUrls;
    const seen = new Set(current);
    const additions: string[] = [];
    for (const raw of urls) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (trimmed.length === 0) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      additions.push(trimmed);
      if (current.length + additions.length >= ALLOWED_EXTENSION_URLS_MAX) break;
    }
    if (additions.length === 0) return 0;
    set({ allowedExtensionUrls: [...current, ...additions] });
    persistImmediate(get());
    return additions.length;
  },
  removeAllowedExtensionUrl: (url) => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return false;
    const current = get().allowedExtensionUrls;
    const next = current.filter((u) => u !== trimmed);
    if (next.length === current.length) return false;
    set({ allowedExtensionUrls: next });
    persistImmediate(get());
    return true;
  },
  clearAllowedExtensionUrls: () => {
    set({ allowedExtensionUrls: [...DEFAULT_ALLOWED_EXTENSION_URLS] });
    persistImmediate(get());
  },
  setPerformanceMode: (mode) => {
    // The mode is a user preference that must persist across reloads (a
    // power user who picks `legacy-only` for a parity test expects that
    // choice to survive the next page load). Persist immediately so a
    // reload right after the toggle picks up the same backend.
    set({ performanceMode: mode });
    persistImmediate(get());
  },
  setSvgAccelerationMode: (mode) => {
    // Like `setPerformanceMode`, the SVG acceleration mode is a user
    // preference that must persist across reloads so a user who picks
    // `cache-only` for a benchmarking run does not have to re-pick it on
    // the next page load. The runtime side (`applySvgAcceleration`) is
    // called from the player's `applySettings` path, so the runtime
    // hook is kept in sync there — this action only updates the store
    // and persists.
    set({ svgAccelerationMode: mode });
    persistImmediate(get());
  },
}));

/**
 * Synchronously flush any pending debounced write. Call from `beforeunload`
 * / `pagehide` so the user's last settings change survives a navigation.
 */
export function flushSettingsPersistForTesting(): void {
  if (pendingSnapshot) {
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    scheduled = false;
    writeSettings({
      theme: snap.theme,
      volume: snap.volume,
      lastNonMuteVolume: snap.lastNonMuteVolume,
      advanced: snap.advanced,
      defaultAdvanced: snap.defaultAdvanced,
      allowedExtensionUrls: snap.allowedExtensionUrls,
      performanceMode: snap.performanceMode,
      svgAccelerationMode: snap.svgAccelerationMode,
    });
  }
}
