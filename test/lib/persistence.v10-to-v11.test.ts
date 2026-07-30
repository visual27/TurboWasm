/**
 * §Phase 5 (gpu-kernel-dsl-phase5-spec §5.7) — v10 → v11 persistence
 * migration test.
 *
 * v11 introduces `advanced.customBlockInliningEnabled` (default `true`).
 * Migration rules:
 *   - v10 payload missing `customBlockInliningEnabled` → field is
 *     silently seeded with `true`.
 *   - v10 payload with explicit `false` → preserved.
 *   - Non-`advanced` state (theme / volume / allowedExtensionUrls /
 *     userExplicitFps / enableWasm) is not corrupted.
 *   - v11 → v11 round-trip via `writeSettings` → `readSettings`
 *     preserves the explicit value.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '@/lib/persistence';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_DETAILED_OPTIMIZATIONS,
  STORAGE_KEYS,
  STORAGE_VERSION,
} from '@/utils/constants';

describe('persistence: v10 → v11 migration (§Phase 5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('STORAGE_VERSION is 14 (settings-dialog refactor bumped from 13)', () => {
    // §Phase 14 — the settings-dialog refactor (= navigation-state
    // retired + Detailed Settings restructured + cosmetic IDs dropped)
    // moved `STORAGE_VERSION` from 13 to 14. The new value is the
    // floor for `readSettings` so a payload tagged at the older 13 is
    // still accepted (= the v13 → v14 migration is silent and
    // cosmetic-only).
    expect(STORAGE_VERSION).toBe(14);
  });

  it('seeds customBlockInliningEnabled = true when missing from v10 payload', () => {
    // Construct a v10-shaped payload directly in storage. The
    // migration path treats this the same as a v10 entry that was
    // written before the v11 bump.
    const v10Payload = {
      state: {
        theme: 'dark',
        volume: 80,
        lastNonMuteVolume: 80,
        advanced: {
          fps: 60,
          interpolation: false,
          highQualityPen: false,
          warpTimer: false,
          infiniteClones: false,
          removeFencing: false,
          removeMiscLimits: false,
          turboMode: false,
          disableCompiler: false,
          stageWidth: 480,
          stageHeight: 360,
          extensionSandboxMode: 'worker',
          turboWasmAccelerationEnabled: true,
          enableWebgpu: true,
          // `customBlockInliningEnabled` deliberately omitted.
        },
        defaultAdvanced: {
          fps: 30,
          interpolation: false,
          highQualityPen: false,
          warpTimer: false,
          infiniteClones: false,
          removeFencing: false,
          removeMiscLimits: false,
          turboMode: false,
          disableCompiler: false,
          stageWidth: 480,
          stageHeight: 360,
          extensionSandboxMode: 'worker',
          turboWasmAccelerationEnabled: true,
          enableWebgpu: true,
        },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 10,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v10Payload));

    const settings = readSettings();
    expect(settings.advanced.customBlockInliningEnabled).toBe(true);
  });

  it('preserves customBlockInliningEnabled = false when explicitly set in v10', () => {
    const v10WithFalse = {
      state: {
        theme: 'light',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          customBlockInliningEnabled: false,
        },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 10,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v10WithFalse));

    const settings = readSettings();
    expect(settings.advanced.customBlockInliningEnabled).toBe(false);
  });

  it('does not corrupt non-advanced fields during v10 → v11 migration', () => {
    const v10Payload = {
      state: {
        theme: 'system',
        volume: 75,
        lastNonMuteVolume: 75,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
        defaultAdvanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          fps: 45,
        },
        allowedExtensionUrls: ['https://example.com/ext.js'],
        enableWasm: false,
        userExplicitFps: null,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 10,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v10Payload));

    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(75);
    expect(settings.lastNonMuteVolume).toBe(75);
    expect(settings.advanced.fps).toBe(30);
    expect(settings.defaultAdvanced.fps).toBe(45);
    expect(settings.allowedExtensionUrls).toEqual(['https://example.com/ext.js']);
    expect(settings.enableWasm).toBe(false);
    expect(settings.userExplicitFps).toBe(45);
    // The seeded migration value lands as `true` (default-on).
    expect(settings.advanced.customBlockInliningEnabled).toBe(true);
  });

  it('round-trips v11 payload through write/read with explicit false value', () => {
    writeSettings({
      theme: 'dark',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, customBlockInliningEnabled: false },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      userExplicitFps: null,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    });
    const settings = readSettings();
    expect(settings.advanced.customBlockInliningEnabled).toBe(false);
  });

  it('round-trips v11 payload through write/read with default true value', () => {
    writeSettings({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      userExplicitFps: null,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    });
    const settings = readSettings();
    expect(settings.advanced.customBlockInliningEnabled).toBe(true);
  });
});

/**
 * §Phase 1 — v11 → v12 migration. The detailed-optimization map
 * (`SettingsStoreShape.detailedOptimizations`) was added in this
 * phase. Older payloads are missing the field, so `readSettings`
 * seeds it from `DEFAULT_DETAILED_OPTIMIZATIONS` (= all
 * `DetailedOptimizationId`s default-on) instead of throwing.
 */
describe('persistence: v11 → v12 migration (§Phase 1)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('seeds detailedOptimizations from defaults when the v11 payload omits the field', () => {
    // Construct a v11-shaped payload (= everything pre-Phase 1 had)
    // and write it directly. The migration should fill
    // `detailedOptimizations` with the defaults so a freshly-bumped
    // payload keeps the default-on behaviour.
    const v11Payload = {
      state: {
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
      },
      version: 11,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v11Payload));

    const settings = readSettings();
    expect(settings.detailedOptimizations).toEqual(DEFAULT_DETAILED_OPTIMIZATIONS);
    // Every shipped ID should be on, except the §Phase 4A / 4B opt-ins
    // which default to `false` (= legacy byte-identical). The migration
    // seeds the new v11 payload by reading `DEFAULT_DETAILED_OPTIMIZATIONS`
    // (= the only source of truth for the per-ID default), so the
    // opt-in defaults propagate without code duplication here.
    const optInIds = new Set([
      'compatLayer.branchInfoReuse',
      'data.mapConversionEvaluation',
    ]);
    for (const id of Object.keys(DEFAULT_DETAILED_OPTIMIZATIONS) as Array<
      keyof typeof DEFAULT_DETAILED_OPTIMIZATIONS
    >) {
      const expected = optInIds.has(id) ? false : true;
      expect(
        settings.detailedOptimizations[id],
        `${id} must default to ${expected} (§Phase 4A/4B opt-in seed)`,
      ).toBe(expected);
    }
  });

  it('preserves explicit v11-persisted detailedOptimizations on read', () => {
    // A user who has flipped a few toggles under v11 (= Phase 0
    // in-memory only) does NOT have them persisted yet, but the
    // migration code path is permissive: any boolean-typed ID
    // passes through, missing IDs are filled from defaults.
    const v11Payload = {
      state: {
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
        detailedOptimizations: {
          ...DEFAULT_DETAILED_OPTIMIZATIONS,
          'data.mapConversionEvaluation': true,
        },
      },
      version: 11,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v11Payload));

    const settings = readSettings();
    expect(settings.detailedOptimizations['data.mapConversionEvaluation']).toBe(true);
    // Other IDs default-on (the v14 map's opt-in IDs default to
    // false — see `DEFAULT_DETAILED_OPTIMIZATIONS`).
    expect(settings.detailedOptimizations['compatLayer.branchInfoReuse']).toBe(false);
  });

  it('round-trips v12 payload through write/read', () => {
    writeSettings({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      userExplicitFps: null,
      detailedOptimizations: {
        ...DEFAULT_DETAILED_OPTIMIZATIONS,
        'data.mapConversionEvaluation': true,
      },
    });
    const settings = readSettings();
    expect(settings.detailedOptimizations['data.mapConversionEvaluation']).toBe(true);
    expect(settings.detailedOptimizations['compatLayer.branchInfoReuse']).toBe(false);
  });
});
