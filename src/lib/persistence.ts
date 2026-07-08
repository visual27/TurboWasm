import { STORAGE_KEYS, STORAGE_VERSION } from '@/utils/constants';
import type {
  AdvancedSettings,
  ExtensionSandboxMode,
  PerformanceMode,
  SettingsStoreSerialized,
  SettingsStoreShape,
  SvgAccelerationMode,
  Theme,
} from '@/types/settings';
import {
  PERFORMANCE_MODES,
  SVG_ACCELERATION_MODES,
  ALLOWED_EXTENSION_URLS_MAX,
} from '@/types/settings';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_ALLOWED_EXTENSION_URLS,
  DEFAULT_PERFORMANCE_MODE,
  DEFAULT_SVG_ACCELERATION_MODE,
} from '@/utils/constants';
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

function isExtensionSandboxMode(v: unknown): v is ExtensionSandboxMode {
  return v === 'worker' || v === 'iframe' || v === 'unsandboxed';
}

function isPerformanceMode(v: unknown): v is PerformanceMode {
  return typeof v === 'string' && (PERFORMANCE_MODES as readonly string[]).includes(v);
}

function isSvgAccelerationMode(v: unknown): v is SvgAccelerationMode {
  return typeof v === 'string' && (SVG_ACCELERATION_MODES as readonly string[]).includes(v);
}

/**
 * Parse an arbitrary object into a sanitized AdvancedSettings. Used for both
 * the runtime `advanced` and the saved `defaultAdvanced`.
 *
 * @param forceDisableCompilerOff When true, the returned object's
 *   `disableCompiler` is always `false`. Used for the runtime advanced so
 *   the toggle never silently carries an old `true` from a pre-migration
 *   save into a fresh session.
 */
function sanitizeAdvanced(input: unknown, forceDisableCompilerOff: boolean): AdvancedSettings {
  const base = DEFAULT_ADVANCED_SETTINGS;
  if (!input || typeof input !== 'object') return { ...base };
  const r = input as Record<string, unknown>;
  const disableCompiler =
    forceDisableCompilerOff ? false : typeof r.disableCompiler === 'boolean' ? r.disableCompiler : base.disableCompiler;
  return {
    fps: typeof r.fps === 'number' ? clampFps(r.fps) : base.fps,
    interpolation: typeof r.interpolation === 'boolean' ? r.interpolation : base.interpolation,
    highQualityPen: typeof r.highQualityPen === 'boolean' ? r.highQualityPen : base.highQualityPen,
    warpTimer: typeof r.warpTimer === 'boolean' ? r.warpTimer : base.warpTimer,
    infiniteClones: typeof r.infiniteClones === 'boolean' ? r.infiniteClones : base.infiniteClones,
    removeFencing: typeof r.removeFencing === 'boolean' ? r.removeFencing : base.removeFencing,
    removeMiscLimits:
      typeof r.removeMiscLimits === 'boolean' ? r.removeMiscLimits : base.removeMiscLimits,
    turboMode: typeof r.turboMode === 'boolean' ? r.turboMode : base.turboMode,
    disableCompiler,
    stageWidth: typeof r.stageWidth === 'number' ? clampStageWidth(r.stageWidth) : base.stageWidth,
    stageHeight:
      typeof r.stageHeight === 'number' ? clampStageHeight(r.stageHeight) : base.stageHeight,
    // Pre-existing snapshots stored `allowProjectExtensions`; this is no
    // longer consulted — extension loading is now per-URL via the
    // Extension Permission dialog. We deliberately ignore the legacy field
    // here so the migration is silent for existing users.
    extensionSandboxMode: isExtensionSandboxMode(r.extensionSandboxMode)
      ? r.extensionSandboxMode
      : base.extensionSandboxMode,
    turboWasmAccelerationEnabled:
      typeof r.turboWasmAccelerationEnabled === 'boolean'
        ? r.turboWasmAccelerationEnabled
        : base.turboWasmAccelerationEnabled,
    svgAccelerationMode: isSvgAccelerationMode(r.svgAccelerationMode)
      ? r.svgAccelerationMode
      : base.svgAccelerationMode,
  };
}

function sanitizeAllowedExtensionUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_ALLOWED_EXTENSION_URLS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= ALLOWED_EXTENSION_URLS_MAX) break;
  }
  return out;
}

function emptyShape(): SettingsStoreShape {
  return {
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [...DEFAULT_ALLOWED_EXTENSION_URLS],
    performanceMode: DEFAULT_PERFORMANCE_MODE,
    svgAccelerationMode: DEFAULT_SVG_ACCELERATION_MODE,
  };
}

export function readSettings(): SettingsStoreShape {
  const raw = storage.get(STORAGE_KEYS.settings);
  if (!raw) return emptyShape();
  try {
    const parsed = JSON.parse(raw) as SettingsStoreSerialized;
    if (!parsed || typeof parsed !== 'object') return emptyShape();

    // v1 payloads (single `advanced` field) are accepted as long as the
    // payload was at least tagged version 1. v2 payloads use two distinct
    // fields (`advanced` + `defaultAdvanced`). v3 adds a top-level
    // `performanceMode`. v4 adds `advanced.svgAccelerationMode` (Stage 2
    // of the TurboWasm Acceleration plan). Anything else (including
    // untagged / wrong-version / corrupt blobs) resets to defaults.
    if (
      parsed.version !== 1 &&
      parsed.version !== 2 &&
      parsed.version !== 3 &&
      parsed.version !== STORAGE_VERSION
    ) {
      return emptyShape();
    }

    const theme = isTheme(parsed.state?.theme) ? parsed.state.theme : 'system';
    const volume =
      typeof parsed.state?.volume === 'number' ? clampVolume(parsed.state.volume) : 100;
    const lastNonMuteVolume =
      typeof parsed.state?.lastNonMuteVolume === 'number'
        ? clampVolume(parsed.state.lastNonMuteVolume)
        : volume;
    const allowedExtensionUrls = sanitizeAllowedExtensionUrls(parsed.state?.allowedExtensionUrls);
    const performanceMode = isPerformanceMode(parsed.state?.performanceMode)
      ? parsed.state.performanceMode
      : DEFAULT_PERFORMANCE_MODE;
    // v3 → v4 migration: `svgAccelerationMode` is a new per-skin field
    // inside `advanced` and `defaultAdvanced`. Older payloads do not
    // include it; we seed both with the safe default (`off`) so a user
    // upgrading from v3 keeps the Stage 1 baseline. Persisted as soon
    // as the user changes any other setting, but never re-persisted
    // automatically by this read.
    const svgAccelerationMode = isSvgAccelerationMode(
      parsed.state?.svgAccelerationMode ?? parsed.state?.advanced?.svgAccelerationMode,
    )
      ? (parsed.state?.svgAccelerationMode ?? parsed.state?.advanced?.svgAccelerationMode)
      : DEFAULT_SVG_ACCELERATION_MODE;

    if (parsed.version === 1) {
      // v1 → v2 migration: a single `advanced` field acted as both the
      // runtime and the default. Force `disableCompiler` off so a previously
      // saved `true` does not silently re-enable the toggle. v3 → v4
      // fields are seeded via the `defaultAdvanced` spread below.
      const advanced = sanitizeAdvanced(parsed.state?.advanced, true);
      return {
        theme,
        volume,
        lastNonMuteVolume,
        advanced,
        defaultAdvanced: { ...advanced, disableCompiler: false },
        allowedExtensionUrls,
        performanceMode,
        svgAccelerationMode,
      };
    }

    // v2 (or v3 or v4). v2/v3/v4 share the `advanced` + `defaultAdvanced`
    // shape; v3 added the top-level `performanceMode`, v4 added
    // `svgAccelerationMode` (we sanitised it above). Older payloads
    // without `svgAccelerationMode` inside `advanced` get the default
    // applied via `sanitizeAdvanced`'s `base.svgAccelerationMode` branch.
    const advanced = sanitizeAdvanced(parsed.state?.advanced, true);
    const defaultAdvanced = sanitizeAdvanced(
      parsed.state?.defaultAdvanced ?? parsed.state?.advanced,
      true,
    );
    return {
      theme,
      volume,
      lastNonMuteVolume,
      advanced,
      defaultAdvanced,
      allowedExtensionUrls,
      performanceMode,
      svgAccelerationMode,
    };
  } catch {
    return emptyShape();
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
