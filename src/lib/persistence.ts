import { DEFAULT_ENABLE_WASM, STORAGE_KEYS, STORAGE_VERSION } from '@/utils/constants';
import type {
  AdvancedSettings,
  ExtensionSandboxMode,
  SettingsStoreSerialized,
  SettingsStoreShape,
  Theme,
} from '@/types/settings';
import { ALLOWED_EXTENSION_URLS_MAX } from '@/types/settings';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_ALLOWED_EXTENSION_URLS,
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
  // v7 → v8 migration: the WebGPU toggle was previously named
  // `enableGpuKernels`. Older payloads may still carry the old key —
  // prefer the renamed `enableWebgpu` and fall back to the legacy name
  // so a reload picks up the user's previous choice.
  const rawEnableWebgpu = (() => {
    if (typeof r.enableWebgpu === 'boolean') return r.enableWebgpu;
    if (typeof r.enableGpuKernels === 'boolean') return r.enableGpuKernels;
    return base.enableWebgpu;
  })();
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
    enableWebgpu: rawEnableWebgpu,
    // v8 → v9 migration: seed `nestedParallelizationEnabled` with `false`
    // (the safe default) for any payload that lacks the field. Existing
    // users keep the legacy outer-only behaviour until they explicitly
    // opt in via the Settings toggle — see
    // nested-parallelization-05-phase4.md §3.5.
    nestedParallelizationEnabled:
      typeof r.nestedParallelizationEnabled === 'boolean'
        ? r.nestedParallelizationEnabled
        : base.nestedParallelizationEnabled,
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
    enableWasm: DEFAULT_ENABLE_WASM,
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
 * v7 → v8 migration: collapse the v3..v7 `performanceMode` union
 * (`'auto' | 'force-wasm' | 'legacy-only'`) into the single
 * `enableWasm: boolean` switch. The runtime already treated `'auto'` and
 * `'force-wasm'` identically (both install the WASM hook when `wasmReady`
 * is true and fall back to the JS path otherwise), so collapsing them
 * into `true` preserves the existing behaviour for every user that picked
 * either value. `'legacy-only'` maps to `false`.
 *
 * Inputs outside the union (e.g. a stale `'force-webgpu'` payload that
 * slipped past the v5→v6 downgrade, or a future string the v8 type does
 * not list) fall back to `DEFAULT_ENABLE_WASM` so a malformed save never
 * silently disables the WASM hook.
 */
function migrateEnableWasm(raw: unknown): boolean {
  if (raw === 'legacy-only') return false;
  if (raw === 'auto' || raw === 'force-wasm') return true;
  return DEFAULT_ENABLE_WASM;
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
    // `advanced.enableGpuKernels`. v8 collapsed the top-level
    // `performanceMode` union into `enableWasm: boolean` and renamed
    // `advanced.enableGpuKernels` to `advanced.enableWebgpu`. v9 added
    // `advanced.nestedParallelizationEnabled` for the Phase 4 nested
    // `@compute` work. Anything outside this range (including untagged /
    // wrong-version / corrupt blobs) resets to defaults.
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
        enableWasm: DEFAULT_ENABLE_WASM,
        // v4 → v5 migration: seed `userExplicitFps` from the v1 fields.
        userExplicitFps: deriveUserExplicitFps(advanced, defaultAdvanced),
      };
    }

    // v2..v7. v2/v3/v4 share the `advanced` + `defaultAdvanced` shape;
    // v3 added the top-level `performanceMode`, v5 added the top-level
    // `userExplicitFps`. `sanitizeAdvanced` drops the now-retired
    // `svgAccelerationMode` field by ignoring it (the type no longer
    // includes it) and handles the v7→v8 rename of `enableGpuKernels`
    // → `enableWebgpu` inline.
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
    // v7 → v8 migration: collapse the v3..v7 `performanceMode` union
    // into `enableWasm`. v8 payloads carry `enableWasm` directly and a
    // stale `performanceMode` is ignored (the v3..v7 field is gone from
    // the type). Both `enableWasm` (v8) and `performanceMode` (v3..v7)
    // are accepted on read; the v8 value wins when present. The
    // `performanceMode` access is through the legacy `unknown` cast
    // because the v8 `SettingsStoreShape` no longer exposes the field.
    const enableWasm =
      typeof parsed.state?.enableWasm === 'boolean'
        ? parsed.state.enableWasm
        : migrateEnableWasm(
            (parsed.state as unknown as { performanceMode?: unknown })?.performanceMode,
          );
    return {
      theme,
      volume,
      lastNonMuteVolume,
      advanced,
      defaultAdvanced,
      allowedExtensionUrls,
      enableWasm,
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
