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
      enableWasm: true,
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
      enableWasm: true,
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
    // the surviving keys are exactly the post-v9 ones (the retired
    // `svgAccelerationMode` and `enableGpuKernels` are no longer
    // present, replaced by `enableWebgpu`; `nestedParallelizationEnabled`
    // was added in v9).
    expect(Object.keys(settings.advanced).sort()).toEqual(
      [
        'disableCompiler',
        'enableWebgpu',
        'extensionSandboxMode',
        'fps',
        'highQualityPen',
        'infiniteClones',
        'interpolation',
        'nestedParallelizationEnabled',
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
      enableWasm: true,
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
    it('seeds enableWasm to true when reading a v2 payload without the field', () => {
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
      expect(settings.enableWasm).toBe(true);
    });

    it('round-trips a persisted enableWasm through storage', () => {
      writeSettings({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: false,
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.enableWasm).toBe(false);
    });
  });

  describe('v5 → v6 migration (retire force-webgpu + svgAccelerationMode)', () => {
    it('downgrades force-webgpu performanceMode to enableWasm=true on read', () => {
      // A user had pinned WebGPU before the v6 retirement. The
      // migration must downgrade silently so they end up on the WASM
      // SIMD path instead of a no-op tier. The v8 collapse then maps
      // any non-`legacy-only` value to `enableWasm=true`.
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
      expect(settings.enableWasm).toBe(true);
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

  describe('v7 → v8 migration (collapse performanceMode + rename enableGpuKernels)', () => {
    it('collapses performanceMode="auto" into enableWasm=true', () => {
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'auto',
          },
          version: 7,
        }),
      );
      const settings = readSettings();
      expect(settings.enableWasm).toBe(true);
    });

    it('collapses performanceMode="force-wasm" into enableWasm=true', () => {
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'force-wasm',
          },
          version: 7,
        }),
      );
      const settings = readSettings();
      expect(settings.enableWasm).toBe(true);
    });

    it('collapses performanceMode="legacy-only" into enableWasm=false', () => {
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'legacy-only',
          },
          version: 7,
        }),
      );
      const settings = readSettings();
      expect(settings.enableWasm).toBe(false);
    });

    it('renames advanced.enableGpuKernels to advanced.enableWebgpu', () => {
      // v7 payloads do NOT carry `enableWebgpu`; emulate that exactly by
      // stripping it from the spread so `sanitizeAdvanced` falls back to
      // the legacy `enableGpuKernels` key for the rename.
      const v7AdvancedBase = (() => {
        const { enableWebgpu: _ignored, ...rest } = DEFAULT_ADVANCED_SETTINGS;
        return rest;
      })();
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...v7AdvancedBase, enableGpuKernels: false },
            defaultAdvanced: { ...v7AdvancedBase, enableGpuKernels: false },
            performanceMode: 'auto',
          },
          version: 7,
        }),
      );
      const settings = readSettings();
      expect(settings.advanced.enableWebgpu).toBe(false);
      expect('enableGpuKernels' in settings.advanced).toBe(false);
      expect(settings.defaultAdvanced.enableWebgpu).toBe(false);
    });

    it('prefers an explicit enableWasm over a stale performanceMode when both are present', () => {
      // Defensive: a malformed payload that carries both the v3..v7
      // `performanceMode` field and the v8 `enableWasm` field must
      // honour the new field — the v8 write path always emits
      // `enableWasm`, so seeing both usually means a hand-crafted
      // payload or a leftover localStorage entry.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS },
            defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
            performanceMode: 'legacy-only',
            enableWasm: true,
          },
          version: 8,
        }),
      );
      const settings = readSettings();
      expect(settings.enableWasm).toBe(true);
    });
  });

  describe('v8 → v9 migration (nestedParallelizationEnabled opt-in)', () => {
    it('seeds advanced.nestedParallelizationEnabled=false on a v8 payload that lacks the field', () => {
      // A user upgrading from v8 must not silently see nested
      // parallelization enabled. The migration seeds the field with the
      // safe default `false` so the legacy outer-only `@compute`
      // behaviour is preserved until they opt in via Settings.
      // We strip the new field from DEFAULT_ADVANCED_SETTINGS to emulate
      // a true v8 payload shape.
      const v8AdvancedBase = (() => {
        const { nestedParallelizationEnabled: _ignored, ...rest } = DEFAULT_ADVANCED_SETTINGS;
        return rest;
      })();
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: v8AdvancedBase,
            defaultAdvanced: v8AdvancedBase,
            enableWasm: true,
          },
          version: 8,
        }),
      );
      const settings = readSettings();
      expect(settings.advanced.nestedParallelizationEnabled).toBe(false);
      expect(settings.defaultAdvanced.nestedParallelizationEnabled).toBe(false);
    });

    it('honours an explicit nestedParallelizationEnabled=true from a v9 payload', () => {
      // A user who already opted in on a previous session must see the
      // toggle re-enable itself on the next read.
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({
          state: {
            theme: 'system',
            volume: 100,
            lastNonMuteVolume: 100,
            advanced: { ...DEFAULT_ADVANCED_SETTINGS, nestedParallelizationEnabled: true },
            defaultAdvanced: {
              ...DEFAULT_ADVANCED_SETTINGS,
              nestedParallelizationEnabled: true,
            },
            enableWasm: true,
          },
          version: 9,
        }),
      );
      const settings = readSettings();
      expect(settings.advanced.nestedParallelizationEnabled).toBe(true);
      expect(settings.defaultAdvanced.nestedParallelizationEnabled).toBe(true);
    });

    it('round-trips nestedParallelizationEnabled through writeSettings', () => {
      writeSettings({
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: { ...DEFAULT_ADVANCED_SETTINGS, nestedParallelizationEnabled: true },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS, nestedParallelizationEnabled: true },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
      });
      const settings = readSettings();
      expect(settings.advanced.nestedParallelizationEnabled).toBe(true);
      expect(settings.defaultAdvanced.nestedParallelizationEnabled).toBe(true);
    });

    it('the new field appears in the post-v8 advanced key set', () => {
      // Guards the docs/UI contract that the Settings dialog field is
      // actually persisted (otherwise the toggle would silently no-op
      // across reloads).
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
      expect(Object.keys(settings.advanced).sort()).toContain('nestedParallelizationEnabled');
    });
  });
});