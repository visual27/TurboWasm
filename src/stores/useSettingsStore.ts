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

function persist(state: SettingsState): void {
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
    persist(get());
  },
  setVolume: (volume) => {
    // Slider-driven changes do NOT touch lastNonMuteVolume — by design.
    const next = clampVolume(volume);
    set({ volume: next });
    persist(get());
  },
  toggleMute: () => {
    const { volume, lastNonMuteVolume } = get();
    const { volume: next, lastNonMuteVolume: nextLast } = computeMuteToggle(
      volume,
      lastNonMuteVolume,
    );
    set({ volume: next, lastNonMuteVolume: nextLast });
    persist(get());
    return next;
  },
  setAdvanced: (next) => {
    set({ advanced: next });
    persist(get());
  },
  patchAdvanced: (patch) => {
    const merged: AdvancedSettings = { ...get().advanced, ...patch };
    set({ advanced: merged });
    persist(get());
  },
  resetAdvanced: () => {
    set({ advanced: { ...DEFAULT_ADVANCED_SETTINGS } });
    persist(get());
  },
}));