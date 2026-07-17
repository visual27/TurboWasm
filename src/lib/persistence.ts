import { STORAGE_KEYS, STORAGE_VERSION } from '@/utils/constants';
import type {
  AdvancedSettings,
  ExtensionSandboxMode,
  PerformanceMode,
  SettingsStoreSerialized,
  SettingsStoreShape,
  Theme,
} from '@/types/settings';
import { PERFORMANCE_MODES, ALLOWED_EXTENSION_URLS_MAX } from '@/types/settings';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_ALLOWED_EXTENSION_URLS,
  DEFAULT_PERFORMANCE_MODE,
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
    // v6 → v7 migration: a previous payload might not have
    // `enableGpuKernels`. Default to `true` (same default as
    // `turboWasmAccelerationEnabled`) so the user does not silently land
    // on the JS path. Following the spec, `saveAdvancedAsDefault()` will
    // also force this field back to `true` on the saved-default side.
    enableGpuKernels:
      typeof r.enableGpuKernels === 'boolean' ? r.enableGpuKernels : base.enableGpuKernels,
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
    // No user history yet; the Alt+Flag shortcut falls back to
    // defaultAdvanced.fps (when !== 30) or 60.
    userExplicitFps: null,
  };
}

/**
 * Derive the v5 `userExplicitFps` seed from a v4-or-earlier payload. The
 * most recent non-30 fps the user had set is whichever of `advanced.fps`
 * and `defaultAdvanced.fps` differs from 30, preferring `advanced.fps`
 * (the user's most recent runtime intent). Returns `null` when both are
 * 30 (no user preference).
 */
function deriveUserExplicitFps(
  advanced: AdvancedSettings,
  defaultAdvanced: AdvancedSettings,
): number | null {
  if (advanced.fps !== 30) return advanced.fps;
  if (defaultAdvanced.fps !== 30) return defaultAdvanced.fps;
  return null;
}

/**
 * v5 → v6 migration helper: `'force-webgpu'` was retired when the WebGPU
 * compute tier (Phase 2) was removed (the JS-side hook always returned
 * `null`). A user who had pinned WebGPU before the removal would silently
 * end up on the `'none'` (JS) tier otherwise. Downgrading to `'auto'`
 * keeps WASM SIMD as the highest tier consulted, which matches the
 * pre-removal behaviour for users who never relied on the GPU path.
 *
 * The comparison uses `(mode as string)` because the post-v6
 * `PerformanceMode` union does not include `'force-webgpu'`; the
 * migration check still needs to recognise the legacy value in v5
 * payloads that reached storage before this commit.
 */
function migratePerformanceMode(mode: PerformanceMode): PerformanceMode {
  return (mode as string) === 'force-webgpu' ? DEFAULT_PERFORMANCE_MODE : mode;
}

export function readSettings(): SettingsStoreShape {
  const raw = storage.get(STORAGE_KEYS.settings);
  if (!raw) return emptyShape();
  try {
    const parsed = JSON.parse(raw) as SettingsStoreSerialized;
    if (!parsed || typeof parsed !== 'object') return emptyShape();

    // v1 payloads (single `advanced` field) are accepted as long as the
    // payload was at least tagged version 1. v2 payloads use two distinct
    // fields (`advanced` + `defaultAdvanced`). v3 added a top-level
    // `performanceMode`. v4 added `advanced.svgAccelerationMode` (later
    // retired in v6). v5 added the top-level `userExplicitFps`. v6
    // dropped `svgAccelerationMode` (and its top-level mirror) and the
    // `'force-webgpu'` performance mode. v7 added
    // `advanced.enableGpuKernels`. Anything outside this range
    // (including untagged / wrong-version / corrupt blobs) resets to
    // defaults.
    if (
      typeof parsed.version !== 'number' ||
      parsed.version < 1 ||
      parsed.version > STORAGE_VERSION
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
    // v5 → v6 migration: `'force-webgpu'` is no longer a valid value
    // (downgraded to `'auto'`). The `isPerformanceMode` guard rejects the
    // string entirely, so the explicit downgrade runs *before* the guard.
    // The cast widens the type comparison to any string so the legacy
    // value is still recognised even though it's no longer part of the
    // narrowed `PerformanceMode` union.
    const rawPerformanceMode: unknown = parsed.state?.performanceMode;
    const performanceMode =
      rawPerformanceMode === 'force-webgpu'
        ? DEFAULT_PERFORMANCE_MODE
        : isPerformanceMode(rawPerformanceMode)
          ? rawPerformanceMode
          : DEFAULT_PERFORMANCE_MODE;

    if (parsed.version === 1) {
      // v1 → v2 migration: a single `advanced` field acted as both the
      // runtime and the default. Force `disableCompiler` off so a previously
      // saved `true` does not silently re-enable the toggle.
      const advanced = sanitizeAdvanced(parsed.state?.advanced, true);
      const defaultAdvanced = { ...advanced, disableCompiler: false };
      return {
        theme,
        volume,
        lastNonMuteVolume,
        advanced,
        defaultAdvanced,
        allowedExtensionUrls,
        performanceMode: migratePerformanceMode(performanceMode),
        // v4 → v5 migration: seed `userExplicitFps` from the v1 fields.
        userExplicitFps: deriveUserExplicitFps(advanced, defaultAdvanced),
      };
    }

    // v2 / v3 / v4 / v5. v2/v3/v4 share the `advanced` + `defaultAdvanced`
    // shape; v3 added the top-level `performanceMode`, v5 added the
    // top-level `userExplicitFps`. `sanitizeAdvanced` drops the now-
    // retired `svgAccelerationMode` field by ignoring it (the type no
    // longer includes it).
    const advanced = sanitizeAdvanced(parsed.state?.advanced, true);
    const defaultAdvanced = sanitizeAdvanced(
      parsed.state?.defaultAdvanced ?? parsed.state?.advanced,
      true,
    );
    // v4 → v5 migration: derive userExplicitFps from the v4 fields if
    // not already present on the payload. A v5+ payload must always
    // have the field (writeSettings emits it), but we sanitise
    // defensively.
    const userExplicitFps =
      typeof parsed.state?.userExplicitFps === 'number' && parsed.state.userExplicitFps !== 30
        ? clampFps(parsed.state.userExplicitFps)
        : deriveUserExplicitFps(advanced, defaultAdvanced);
    return {
      theme,
      volume,
      lastNonMuteVolume,
      advanced,
      defaultAdvanced,
      allowedExtensionUrls,
      performanceMode: migratePerformanceMode(performanceMode),
      userExplicitFps,
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