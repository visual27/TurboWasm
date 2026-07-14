import { beforeEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '@/lib/persistence';
import {
  STORAGE_KEYS,
  STORAGE_VERSION,
  DEFAULT_ADVANCED_SETTINGS,
  FPS_MAX,
} from '@/utils/constants';

describe('persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when storage empty', () => {
    const settings = readSettings();
    expect(settings).toMatchObject({
      theme: 'system',
      volume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
    });
  });

  it('round-trips through storage', () => {
    writeSettings({
      theme: 'dark',
      volume: 42,
      lastNonMuteVolume: 42,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 60, stageWidth: 800 },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, fps: 30 },
      allowedExtensionUrls: ['https://example.com/a.js'],
      performanceMode: 'auto',
      svgAccelerationMode: 'off',
      userExplicitFps: null,
    });
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.volume).toBe(42);
    expect(settings.lastNonMuteVolume).toBe(42);
    expect(settings.advanced.fps).toBe(60);
    expect(settings.advanced.stageWidth).toBe(800);
    expect(settings.defaultAdvanced.fps).toBe(30);
    expect(settings.allowedExtensionUrls).toEqual(['https://example.com/a.js']);
  });

  it('clamps out-of-range values when reading', () => {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        state: {
          theme: 'invalid',
          volume: 500,
          advanced: { fps: 9999, stageWidth: -1, stageHeight: NaN },
        },
        version: STORAGE_VERSION,
      }),
    );
    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(100);
    // FPS_MAX is defined in src/utils/constants; the persistence layer
    // must clamp against the same constant (the test value 9999 is
    // intentionally well above it).
    expect(settings.advanced.fps).toBe(FPS_MAX);
    expect(settings.advanced.stageWidth).toBe(1);
    expect(settings.advanced.stageHeight).toBeGreaterThanOrEqual(1);
  });

  it('returns defaults when version mismatch', () => {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({ state: { theme: 'dark', volume: 50, advanced: {} }, version: 99 }),
    );
    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(100);
  });

  it('returns defaults on malformed JSON', () => {
    localStorage.setItem(STORAGE_KEYS.settings, 'not-json');
    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.volume).toBe(100);
  });

  it('round-trips the extension sandbox mode field', () => {
    writeSettings({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: {
        ...DEFAULT_ADVANCED_SETTINGS,
        extensionSandboxMode: 'iframe',
      },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      performanceMode: 'auto',
      svgAccelerationMode: 'off',
      userExplicitFps: null,
    });
    const settings = readSettings();
    expect(settings.advanced.extensionSandboxMode).toBe('iframe');
  });

  it('falls back to safe defaults when extension fields are missing or invalid', () => {
    // Simulate a snapshot from before the extensionSandboxMode field
    // existed (the key is absent entirely).
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        state: {
          theme: 'system',
          volume: 100,
          lastNonMuteVolume: 100,
          advanced: { ...DEFAULT_ADVANCED_SETTINGS },
          defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        },
        version: STORAGE_VERSION,
      }),
    );
    const settings = readSettings();
    expect(settings.advanced.extensionSandboxMode).toBe('worker');

    // Now simulate the key being present but with a bogus value.
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        state: {
          theme: 'system',
          volume: 100,
          lastNonMuteVolume: 100,
          advanced: {
            ...DEFAULT_ADVANCED_SETTINGS,
            extensionSandboxMode: 'nonsense',
          },
          defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        },
        version: STORAGE_VERSION,
      }),
    );
    const settings2 = readSettings();
    expect(settings2.advanced.extensionSandboxMode).toBe('worker');
  });

  it('silently drops the legacy allowProjectExtensions field', () => {
    // Snapshots from before the rewrite stored allowProjectExtensions
    // inside `advanced`. The new shape no longer has that field; the
    // migration just ignores it.
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        state: {
          theme: 'dark',
          volume: 100,
          lastNonMuteVolume: 100,
          advanced: {
            ...DEFAULT_ADVANCED_SETTINGS,
            allowProjectExtensions: true,
          },
          defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        },
        version: STORAGE_VERSION,
      }),
    );
    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    // The legacy field is no longer part of the typed shape — verify
    // the surviving keys are exactly the post-rewrite ones.
    expect(Object.keys(settings.advanced).sort()).toEqual(
      [
        'disableCompiler',
        'extensionSandboxMode',
        'fps',
        'highQualityPen',
        'infiniteClones',
        'interpolation',
        'removeFencing',
        'removeMiscLimits',
        'stageHeight',
        'stageWidth',
        'svgAccelerationMode',
        'turboMode',
        'turboWasmAccelerationEnabled',
        'warpTimer',
      ].sort(),
    );
  });

  it('round-trips the persistent allow-list with de-duplication', () => {
    writeSettings({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: { ...DEFAULT_ADVANCED_SETTINGS },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [
        'https://example.com/a.js',
        'https://example.com/a.js', // duplicate
        '  https://example.com/b.js  ', // trimmed
      ],
      performanceMode: 'auto',
      svgAccelerationMode: 'off',
      userExplicitFps: null,
    });
    const settings = readSettings();
    expect(settings.allowedExtensionUrls).toEqual([
      'https://example.com/a.js',
      'https://example.com/b.js',
    ]);
  });

  it('drops empty / non-string entries from the persistent allow-list', () => {
    localStorage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({
        state: {
          theme: 'system',
          volume: 100,
          lastNonMuteVolume: 100,
          advanced: { ...DEFAULT_ADVANCED_SETTINGS },
          defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
          allowedExtensionUrls: [
            'https://example.com/a.js',
            '',
            '   ',
            42,
            null,
            'https://example.com/b.js',
          ],
        },
        version: STORAGE_VERSION,
      }),
    );
    const settings = readSettings();
    expect(settings.allowedExtensionUrls).toEqual([
      'https://example.com/a.js',
      'https://example.com/b.js',
    ]);
  });

  describe('v1 → v2 migration', () => {
    it('reads a v1 payload and seeds both advanced and defaultAdvanced from it', () => {
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'dark',
            volume: 80,
            lastNonMuteVolume: 80,
            advanced: {
              ...DEFAULT_ADVANCED_SETTINGS,
              fps: 60,
              stageWidth: 800,
            },
          },
          version: 1,
        }),
      );
      const settings = readSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.volume).toBe(80);
      expect(settings.advanced.fps).toBe(60);
      expect(settings.advanced.stageWidth).toBe(800);
      expect(settings.defaultAdvanced.fps).toBe(60);
      expect(settings.defaultAdvanced.stageWidth).toBe(800);
    });

    it('forces disableCompiler off in both advanced and defaultAdvanced on v1 load', () => {
      // A user previously persisted disableCompiler: true under v1. After
      // the schema split the toggle must always start as false.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: {
              ...DEFAULT_ADVANCED_SETTINGS,
              disableCompiler: true,
            },
          },
          version: 1,
        }),
      );
      const settings = readSettings();
      expect(settings.advanced.disableCompiler).toBe(false);
      expect(settings.defaultAdvanced.disableCompiler).toBe(false);
    });
  });

  describe('v2 → v3 migration (performanceMode field)', () => {
    it('seeds performanceMode to "auto" when reading a v2 payload without the field', () => {
      // A v2 payload predates the performanceMode field. The migration
      // must default it to 'auto' so a user upgrading their saved
      // settings picks up the recommended default.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'dark',
            volume: 50,
            lastNonMuteVolume: 50,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
          },
          version: 2,
        }),
      );
      const settings = readSettings();
      expect(settings.performanceMode).toBe('auto');
    });

    it('round-trips a persisted performanceMode through storage', () => {
      writeSettings({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        performanceMode: 'force-wasm',
        svgAccelerationMode: 'off',
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.performanceMode).toBe('force-wasm');
    });

    it('falls back to "auto" when reading a v3 payload with an unknown performanceMode', () => {
      // A future v4 might add a new performanceMode value. We must
      // gracefully fall back to the safe default so the viewer keeps
      // working until the user upgrades.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'totally-fake-mode',
          },
          version: STORAGE_VERSION,
        }),
      );
      const settings = readSettings();
      expect(settings.performanceMode).toBe('auto');
    });
  });

  describe('v3 → v4 migration (svgAccelerationMode field)', () => {
    it('seeds svgAccelerationMode to "off" when reading a v3 payload without the field', () => {
      // A v3 payload predates the svgAccelerationMode field. The migration
      // must default it to 'off' so a user upgrading their saved settings
      // picks up the Stage 1 baseline (bit-identical TurboWarp rendering).
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'dark',
            volume: 50,
            lastNonMuteVolume: 50,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'auto',
          },
          version: 3,
        }),
      );
      const settings = readSettings();
      expect(settings.svgAccelerationMode).toBe('off');
      // The field must also be seeded inside `advanced` so the runtime
      // `applySvgAcceleration` reads the default there too.
      expect(settings.advanced.svgAccelerationMode).toBe('off');
      expect(settings.defaultAdvanced.svgAccelerationMode).toBe('off');
    });

    it('round-trips a persisted svgAccelerationMode through storage', () => {
      writeSettings({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'cache-only' },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'cache-only' },
        allowedExtensionUrls: [],
        performanceMode: 'auto',
        svgAccelerationMode: 'cache-only',
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.svgAccelerationMode).toBe('cache-only');
      expect(settings.advanced.svgAccelerationMode).toBe('cache-only');
      expect(settings.defaultAdvanced.svgAccelerationMode).toBe('cache-only');
    });

    it('round-trips mip-chain through storage', () => {
      writeSettings({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'mip-chain' },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'mip-chain' },
        allowedExtensionUrls: [],
        performanceMode: 'auto',
        svgAccelerationMode: 'mip-chain',
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.svgAccelerationMode).toBe('mip-chain');
    });

    it('falls back to "off" when reading a v4 payload with an unknown svgAccelerationMode', () => {
      // A future Stage 3 / Stage 4 might add new modes. We must gracefully
      // fall back to the safe default so the viewer keeps working until
      // the user upgrades.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'totally-fake' },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'totally-fake' },
            performanceMode: 'auto',
            svgAccelerationMode: 'totally-fake',
          },
          version: STORAGE_VERSION,
        }),
      );
      const settings = readSettings();
      expect(settings.svgAccelerationMode).toBe('off');
      expect(settings.advanced.svgAccelerationMode).toBe('off');
    });

    it('v4 payload preserves both advanced and defaultAdvanced svgAccelerationMode', () => {
      // The user may have set the runtime to 'cache-only' but saved the
      // default as 'off'. Both must round-trip independently.
      writeSettings({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'cache-only' },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'off' },
        allowedExtensionUrls: [],
        performanceMode: 'auto',
        svgAccelerationMode: 'cache-only',
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.advanced.svgAccelerationMode).toBe('cache-only');
      expect(settings.defaultAdvanced.svgAccelerationMode).toBe('off');
    });
  });
});
