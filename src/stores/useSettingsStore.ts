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
import { clampFps, clampVolume } from '@/utils/format';
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
  /**
   * The user's most recent non-30 FPS — the value that
   * {@link cycleFpsShortcut} should round-trip back to when the runtime
   * FPS is at {@link FPS_SHORTCUT_DEFAULT}. Updated by:
   *
   *  - `patchAdvanced` when the patch explicitly sets a non-30 FPS.
   *  - `saveAdvancedAsDefault` when the runtime FPS is non-30.
   *  - `cycleFpsShortcut` itself, when toggling from a non-30 FPS back
   *    to 30 (so the next press can return).
   *
   * `null` means the user has never set an explicit non-30 FPS; the
   * shortcut falls back to `defaultAdvanced.fps` (when !== 30) or 60.
   * Persisted across reloads so a user who toggled to e.g. 45 last
   * session picks up where they left off.
   */
  userExplicitFps: number | null;
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
   * Toggle the runtime Turbo Mode flag. In-memory only — the user must
   * press "Set as default" to make the change survive a reload. Returns
   * the new value of `advanced.turboMode`.
   */
  toggleTurboMode: () => boolean;
  /**
   * Cycle the runtime FPS between the system default (30) and the
   * "preferred FPS" computed by {@link computePreferredFps}. Pressed
   * while FPS is 30 it switches to the preferred value; pressed while
   * FPS is anything else it switches back to 30. In-memory only.
   * Returns the new FPS.
   */
  cycleFpsShortcut: () => number;
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

/**
 * The system default FPS used by the Alt+Flag shortcut as one of the two
 * cycle endpoints. Kept as a constant so the implementation lives next to
 * {@link DEFAULT_ADVANCED_SETTINGS.fps} without depending on the runtime
 * store.
 */
export const FPS_SHORTCUT_DEFAULT = 30;

/**
 * The fallback FPS used when neither the user's explicit override nor
 * the saved default differs from {@link FPS_SHORTCUT_DEFAULT}. Matches
 * the priority order documented on {@link SettingsState.cycleFpsShortcut}.
 */
export const FPS_SHORTCUT_FALLBACK = 60;

/**
 * Compute the "preferred FPS" the Alt+Flag shortcut should switch to
 * whenever the runtime FPS is currently the system default (30). The
 * priority order is:
 *
 *  1. {@link SettingsState.userExplicitFps}, the most recent non-30 FPS
 *     the user explicitly chose (via the Settings dialog NumberField,
 *     "Set as default", or Alt+Flag itself). This is the strongest
 *     signal because it captures user intent across toggles and reloads,
 *     even when the runtime `advanced.fps` has just been snapped back
 *     to 30 by the shortcut.
 *  2. The saved default FPS, unless it equals {@link FPS_SHORTCUT_DEFAULT}.
 *     A non-30 default means the user pressed "Set as default" with a
 *     non-default value and we should respect that.
 *  3. {@link FPS_SHORTCUT_FALLBACK} (60), when neither of the above is
 *     available.
 */
export function computePreferredFps(
  userExplicitFps: number | null,
  defaultAdvancedFps: number,
): number {
  if (userExplicitFps !== null && userExplicitFps !== FPS_SHORTCUT_DEFAULT) {
    return userExplicitFps;
  }
  if (defaultAdvancedFps !== FPS_SHORTCUT_DEFAULT) {
    return defaultAdvancedFps;
  }
  return FPS_SHORTCUT_FALLBACK;
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
          userExplicitFps: snap.userExplicitFps,
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
    userExplicitFps: state.userExplicitFps,
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
  // The persistence layer derives this on read for legacy payloads, so
  // the value here is always either the user's saved choice or a
  // sensible fallback (null = no preference). We accept null because the
  // v4 → v5 migration in persistence.ts uses `deriveUserExplicitFps`
  // and that helper returns `null` when both `advanced.fps` and
  // `defaultAdvanced.fps` are 30.
  userExplicitFps: initial.userExplicitFps ?? null,
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
  toggleTurboMode: () => {
    // Mirrors `patchAdvanced({ turboMode })` semantics: in-memory only,
    // no localStorage write. The Settings dialog stays the single
    // source of truth for "Set as default" persistence — the user must
    // press that button there to make the change survive a reload.
    const next = !get().advanced.turboMode;
    set({ advanced: { ...get().advanced, turboMode: next } });
    return next;
  },
  cycleFpsShortcut: () => {
    // Mirrors `patchAdvanced({ fps })` semantics for `advanced.fps`
    // (in-memory only — the user must press "Set as default" to make
    // the change survive a reload). Two endpoints: the system default
    // (30) and the "preferred FPS" computed by `computePreferredFps`.
    //
    // When toggling *to* 30 from a non-30 value, we also remember the
    // previous value in `userExplicitFps` and persist it via
    // `schedulePersist` so a reload picks up the round-trip endpoint.
    // This is what makes the Alt+Flag latch robust across reloads;
    // without it, after the first toggle the runtime `advanced.fps`
    // becomes 30 and the priority check would lose track of the
    // user's actual preference. We persist *only* the latch field —
    // the runtime fps stays in-memory and gets overwritten by
    // `applyRuntimeOverrides` on the next project load anyway.
    const { advanced, defaultAdvanced, userExplicitFps } = get();
    if (advanced.fps === FPS_SHORTCUT_DEFAULT) {
      const next = clampFps(computePreferredFps(userExplicitFps, defaultAdvanced.fps));
      set({ advanced: { ...advanced, fps: next } });
      return next;
    }
    set({
      advanced: { ...advanced, fps: FPS_SHORTCUT_DEFAULT },
      userExplicitFps: advanced.fps,
    });
    // Persist only the latch by writing the current snapshot through the
    // debounced path. The runtime fps is included too, but
    // `applyRuntimeOverrides` resets it on the next project load — and
    // until a project loads, the runtime fps is the one we just set
    // (30), which is exactly what the user sees on the in-memory toggle.
    schedulePersist(get());
    return FPS_SHORTCUT_DEFAULT;
  },
  patchAdvanced: (patch) => {
    // In-memory only. The Settings dialog edits the runtime `advanced`
    // without persisting — the user must press "Set as default" to make
    // changes survive a reload.
    const merged: AdvancedSettings = { ...get().advanced, ...patch };
    // Remember any explicit FPS the user types into the Settings dialog
    // NumberField (or any other non-30 patchAdvanced call site). 30 is
    // the system default and would only reset `userExplicitFps` to a
    // value the priority check would skip anyway.
    const userExplicitFpsUpdate =
      typeof patch.fps === 'number' && patch.fps !== FPS_SHORTCUT_DEFAULT
        ? clampFps(patch.fps)
        : get().userExplicitFps;
    set({ advanced: merged, userExplicitFps: userExplicitFpsUpdate });
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
    // A non-30 runtime FPS at "Set as default" time is also the user's
    // explicit preference — keep the Alt+Flag latched value in sync so
    // a reload picks up the same round-trip endpoint.
    const userExplicitFps =
      advanced.fps !== FPS_SHORTCUT_DEFAULT ? clampFps(advanced.fps) : get().userExplicitFps;
    set({ defaultAdvanced: snapshot, userExplicitFps });
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
    // off) and clear the extension allow-list. Also clear the Alt+Flag
    // FPS latch so the shortcut falls back to the saved default (or 60)
    // instead of a stale preference from before the reset.
    const next: AdvancedSettings = { ...get().defaultAdvanced, disableCompiler: false };
    const userExplicitFps =
      next.fps !== FPS_SHORTCUT_DEFAULT ? clampFps(next.fps) : null;
    set({
      advanced: next,
      allowedExtensionUrls: [...DEFAULT_ALLOWED_EXTENSION_URLS],
      userExplicitFps,
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
      userExplicitFps: snap.userExplicitFps,
    });
  }
}
