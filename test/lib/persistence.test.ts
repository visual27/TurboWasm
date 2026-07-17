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
      userExplicitFps: null,
    });
    const settings = readSettings();
    expect(settings.advanced.extensionSandboxMode).toBe('iframe');
  });

  it('falls back to safe defaults when extension fields are missing or invalid', () => {
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
    // the surviving keys are exactly the post-v6 ones (the retired
    // `svgAccelerationMode` is no longer present).
    expect(Object.keys(settings.advanced).sort()).toEqual(
      [
        'disableCompiler',
        'enableGpuKernels',
        'extensionSandboxMode',
        'fps',
        'highQualityPen',
        'infiniteClones',
        'interpolation',
        'removeFencing',
        'removeMiscLimits',
        'stageHeight',
        'stageWidth',
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
        'https://example.com/a.js',
        '  https://example.com/b.js  ',
      ],
      performanceMode: 'auto',
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
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.performanceMode).toBe('force-wasm');
    });

    it('falls back to "auto" when reading a payload with an unknown performanceMode', () => {
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

  describe('v5 → v6 migration (retire force-webgpu + svgAccelerationMode)', () => {
    it('downgrades force-webgpu to auto on read', () => {
      // A user had pinned WebGPU before the v6 retirement. The
      // migration must downgrade silently so they end up on the WASM
      // SIMD path instead of a no-op tier.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'force-webgpu',
          },
          version: 5,
        }),
      );
      const settings = readSettings();
      expect(settings.performanceMode).toBe('auto');
    });

    it('drops the retired svgAccelerationMode field on read', () => {
      // A v5 payload still carries the SVG acceleration mirror (top
      // level and inside `advanced`). The migration must strip both so
      // a user upgrading does not see a phantom field in the store
      // shape.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'cache-only' },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, svgAccelerationMode: 'cache-only' },
            performanceMode: 'auto',
            svgAccelerationMode: 'mip-chain',
          },
          version: 5,
        }),
      );
      const settings = readSettings();
      expect('svgAccelerationMode' in settings.advanced).toBe(false);
      expect('svgAccelerationMode' in settings.defaultAdvanced).toBe(false);
      // The top-level mirror is no longer part of the shape either.
      expect('svgAccelerationMode' in settings).toBe(false);
    });
  });
});