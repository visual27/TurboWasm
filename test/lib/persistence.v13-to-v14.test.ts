/**
 * §Phase 14 — v13 → v14 persistence migration test.
 *
 * The settings-dialog refactor retires seven `DetailedOptimizationId`
 * keys from the user-facing `DetailedOptimizationMap`. The retained
 * keys (= `data.constantFolding` / `compatLayer.branchInfoReuse` /
 * `data.mapConversionEvaluation`) are the only ones mapped 1:1 to a
 * `runtime.setCompilerOptions` key. The dropped IDs were either
 * cosmetic (= no runtime gate, the vendored runtime patch applied
 * unconditionally) or research-only (= never wired to a runtime hook):
 *
 *   - `comparison.shortCircuit`              (Phase 1-A, cosmetic)
 *   - `edgeHat.sentinelElimination`          (Phase 1-B, cosmetic)
 *   - `comparison.infinityBranchRemoval`     (Phase 1-C, cosmetic)
 *   - `compatLayer.closureReuse`             (Phase 2-A, cosmetic)
 *   - `compatLayer.procedureCache`           (Phase 2-B, cosmetic)
 *   - `compatLayer.procedureCacheThreadCompaction` (unwired)
 *   - `compiler.generatorGranularityResearch` (research-only)
 *
 * Migration rules (= all silent):
 *   - v13 payload that carries a dropped ID at `true` or `false` →
 *     the dropped key is absent from the v14 in-memory map (the
 *     runtime never read it, so neither value affects behaviour).
 *   - v13 payload with no `detailedOptimizations` field → seeded from
 *     `DEFAULT_DETAILED_OPTIMIZATIONS` (= the v14 3-key map).
 *   - v14 payload round-trip via `writeSettings` → `readSettings`
 *     preserves only the 3 wired keys.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '@/lib/persistence';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_DETAILED_OPTIMIZATIONS,
  STORAGE_KEYS,
} from '@/utils/constants';

describe('persistence: v13 → v14 migration (settings-dialog refactor)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drops the seven cosmetic IDs from a v13 payload on read', () => {
    const v13Payload = {
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
          // Mix of cosmetic IDs (the legacy v13 keys the user could
          // toggle) and wired IDs (the only ones that survive v14).
          'compatLayer.closureReuse': false,
          'compatLayer.procedureCache': false,
          'compatLayer.procedureCacheThreadCompaction': true,
          'comparison.shortCircuit': false,
          'edgeHat.sentinelElimination': false,
          'comparison.infinityBranchRemoval': false,
          'compiler.generatorGranularityResearch': true,
          'data.constantFolding': true,
          'compatLayer.branchInfoReuse': true,
          'data.mapConversionEvaluation': true,
        },
      },
      version: 13,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v13Payload));

    const settings = readSettings();
    // Only the three wired keys are present on the v14 output.
    expect(Object.keys(settings.detailedOptimizations).sort()).toEqual(
      [
        'compatLayer.branchInfoReuse',
        'data.constantFolding',
        'data.mapConversionEvaluation',
      ].sort(),
    );
    // Wired IDs carry through verbatim.
    expect(settings.detailedOptimizations['data.constantFolding']).toBe(true);
    expect(settings.detailedOptimizations['compatLayer.branchInfoReuse']).toBe(true);
    expect(settings.detailedOptimizations['data.mapConversionEvaluation']).toBe(true);
  });

  it('seeds missing IDs from DEFAULT_DETAILED_OPTIMIZATIONS when v13 carries only cosmetic keys', () => {
    // A v13 payload that only carries cosmetic IDs (= no surviving
    // v14 key) lands on the v14 defaults (= the three wired keys
    // with their `opt-in → false` / `default-on → true` polarity).
    const v13CosmeticOnly = {
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
          'comparison.shortCircuit': false,
          'edgeHat.sentinelElimination': false,
          'compatLayer.closureReuse': false,
        },
      },
      version: 13,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v13CosmeticOnly));

    const settings = readSettings();
    expect(settings.detailedOptimizations).toEqual(DEFAULT_DETAILED_OPTIMIZATIONS);
  });

  it('round-trips a v14 payload through write/read with explicit opt-in = true', () => {
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
        'compatLayer.branchInfoReuse': true,
      },
    });
    const settings = readSettings();
    expect(settings.detailedOptimizations['data.mapConversionEvaluation']).toBe(true);
    expect(settings.detailedOptimizations['compatLayer.branchInfoReuse']).toBe(true);
    expect(settings.detailedOptimizations['data.constantFolding']).toBe(true);
  });

  it('round-trips a v14 payload through write/read with explicit opt-in = false', () => {
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
        'data.constantFolding': false,
      },
    });
    const settings = readSettings();
    expect(settings.detailedOptimizations['data.constantFolding']).toBe(false);
    expect(settings.detailedOptimizations['compatLayer.branchInfoReuse']).toBe(false);
    expect(settings.detailedOptimizations['data.mapConversionEvaluation']).toBe(false);
  });

  it('does not corrupt non-detailedOptimizations fields during v13 → v14 migration', () => {
    const v13Payload = {
      state: {
        theme: 'dark',
        volume: 80,
        lastNonMuteVolume: 80,
        advanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          fps: 60,
          stageWidth: 640,
          stageHeight: 480,
          semantics: {
            preset: 'low-risk-js',
            strictNumericEquality: false,
            caseSensitiveStrings: true,
            propagateNaN: false,
            truncatedModulo: true,
            jsTruthyBooleans: false,
          },
        },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: ['https://example.com/ext.js'],
        enableWasm: false,
        userExplicitFps: 60,
        detailedOptimizations: {
          'comparison.shortCircuit': false,
          'compatLayer.branchInfoReuse': true,
          'data.constantFolding': true,
        },
      },
      version: 13,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v13Payload));

    const settings = readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.volume).toBe(80);
    expect(settings.advanced.fps).toBe(60);
    expect(settings.advanced.stageWidth).toBe(640);
    expect(settings.advanced.stageHeight).toBe(480);
    expect(settings.advanced.semantics.preset).toBe('low-risk-js');
    expect(settings.advanced.semantics.caseSensitiveStrings).toBe(true);
    expect(settings.advanced.semantics.truncatedModulo).toBe(true);
    expect(settings.allowedExtensionUrls).toEqual(['https://example.com/ext.js']);
    expect(settings.enableWasm).toBe(false);
    expect(settings.userExplicitFps).toBe(60);
    // The wired keys carry through; the cosmetic keys are gone.
    expect(settings.detailedOptimizations['compatLayer.branchInfoReuse']).toBe(true);
    expect(settings.detailedOptimizations['data.constantFolding']).toBe(true);
    expect(settings.detailedOptimizations['data.mapConversionEvaluation']).toBe(false);
  });
});