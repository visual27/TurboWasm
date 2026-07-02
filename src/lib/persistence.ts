import { STORAGE_KEYS, STORAGE_VERSION } from '@/utils/constants';
import type { SettingsStoreSerialized, SettingsStoreShape } from '@/types/settings';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';
import type { AdvancedSettings, Theme } from '@/types/settings';
import { clampFps, clampStageHeight, clampStageWidth, clampVolume } from '@/utils/format';

type Listener = () => void;

class SafeStorage {
  private readonly storage: Storage | null;

  public constructor() {
    try {
      this.storage = typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
      this.storage = null;
    }
  }

  public get(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  public set(key: string, value: string): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, value);
    } catch {
      /* quota exceeded or storage disabled; ignore */
    }
  }

  public remove(key: string): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

const storage = new SafeStorage();

function isTheme(v: unknown): v is Theme {
  return v === 'system' || v === 'dark' || v === 'light';
}

function sanitizeAdvanced(input: unknown): AdvancedSettings {
  const base = DEFAULT_ADVANCED_SETTINGS;
  if (!input || typeof input !== 'object') return { ...base };
  const r = input as Record<string, unknown>;
  return {
    fps: typeof r.fps === 'number' ? clampFps(r.fps) : base.fps,
    interpolation:
      typeof r.interpolation === 'boolean' ? r.interpolation : base.interpolation,
    highQualityPen:
      typeof r.highQualityPen === 'boolean' ? r.highQualityPen : base.highQualityPen,
    warpTimer: typeof r.warpTimer === 'boolean' ? r.warpTimer : base.warpTimer,
    infiniteClones:
      typeof r.infiniteClones === 'boolean' ? r.infiniteClones : base.infiniteClones,
    removeFencing:
      typeof r.removeFencing === 'boolean' ? r.removeFencing : base.removeFencing,
    removeMiscLimits:
      typeof r.removeMiscLimits === 'boolean' ? r.removeMiscLimits : base.removeMiscLimits,
    turboMode: typeof r.turboMode === 'boolean' ? r.turboMode : base.turboMode,
    disableCompiler:
      typeof r.disableCompiler === 'boolean' ? r.disableCompiler : base.disableCompiler,
    stageWidth: typeof r.stageWidth === 'number' ? clampStageWidth(r.stageWidth) : base.stageWidth,
    stageHeight:
      typeof r.stageHeight === 'number' ? clampStageHeight(r.stageHeight) : base.stageHeight,
  };
}

export function readSettings(): SettingsStoreShape {
  const raw = storage.get(STORAGE_KEYS.settings);
  if (!raw) {
    return {
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    };
  }
  try {
    const parsed = JSON.parse(raw) as SettingsStoreSerialized;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORAGE_VERSION) {
      return {
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      };
    }
    const theme = isTheme(parsed.state?.theme) ? parsed.state.theme : 'system';
    const volume =
      typeof parsed.state?.volume === 'number' ? clampVolume(parsed.state.volume) : 100;
    const lastNonMuteVolume =
      typeof parsed.state?.lastNonMuteVolume === 'number'
        ? clampVolume(parsed.state.lastNonMuteVolume)
        : volume;
    const advanced = sanitizeAdvanced(parsed.state?.advanced);
    return { theme, volume, lastNonMuteVolume, advanced };
  } catch {
    return {
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    };
  }
}

export function writeSettings(snapshot: SettingsStoreShape): void {
  const payload: SettingsStoreSerialized = {
    state: snapshot,
    version: STORAGE_VERSION,
  };
  storage.set(STORAGE_KEYS.settings, JSON.stringify(payload));
}

export function subscribeSettings(_listener: Listener): () => void {
  // placeholder for future cross-tab sync (storage event listener)
  return () => {
    /* noop */
  };
}