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
import { STORAGE_KEYS, STORAGE_VERSION, DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

describe('persistence: v10 → v11 migration (§Phase 5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('STORAGE_VERSION is 11', () => {
    expect(STORAGE_VERSION).toBe(11);
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
        userExplicitFps: 45,
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
    });
    const settings = readSettings();
    expect(settings.advanced.customBlockInliningEnabled).toBe(true);
  });
});
