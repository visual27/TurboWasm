import { create } from 'zustand';
import type { AdvancedSettings, Theme } from '@/types/settings';
import { DEFAULT_ADVANCED_SETTINGS, VOLUME_MAX, VOLUME_MIN } from '@/utils/constants';
import { clampVolume } from '@/utils/format';
import { readSettings, writeSettings } from '@/lib/persistence';

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
  advanced: AdvancedSettings;
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
  setAdvanced: (next: AdvancedSettings) => void;
  patchAdvanced: (patch: Partial<AdvancedSettings>) => void;
  resetAdvanced: () => void;
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

// High-frequency setters (setVolume, patchAdvanced) coalesce their disk
// writes through this microtask + idle debouncer. The latest snapshot wins;
// intermediate states are skipped. We still flush synchronously on
// setTheme / setAdvanced / resetAdvanced / toggleMute so the rare but
// user-meaningful "Settings closed, expect the next page load to keep my
// choice" expectation is preserved.
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
        });
      }
    };
    if (typeof (globalThis as { requestIdleCallback?: (cb: () => void) => void })
      .requestIdleCallback === 'function') {
      (globalThis as { requestIdleCallback: (cb: () => void) => void })
        .requestIdleCallback(cb);
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
  setAdvanced: (next) => {
    set({ advanced: next });
    persistImmediate(get());
  },
  patchAdvanced: (patch) => {
    const merged: AdvancedSettings = { ...get().advanced, ...patch };
    set({ advanced: merged });
    schedulePersist(get());
  },
  resetAdvanced: () => {
    set({ advanced: { ...DEFAULT_ADVANCED_SETTINGS } });
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
    });
  }
}