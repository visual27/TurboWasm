/**
 * §Phase 7 — v12 → v13 persistence migration test.
 *
 * v13 introduces `advanced.semantics: SemanticOptions` (= `preset`
 * + 5 per-flag booleans). Migration rules:
 *   - v12 payload missing `semantics` → field is silently seeded
 *     with `DEFAULT_SEMANTIC_OPTIONS` (= `'scratch'` preset, all
 *     flags off = byte-identical to upstream scratch-vm).
 *   - v12 payload with explicit `semantics: { ... }` → preserved.
 *   - The `preset` is a free-form string union; invalid presets
 *     fall back to `'scratch'`.
 *   - Per-flag fields with non-boolean values fall back to the
 *     default `false`.
 *   - Non-`advanced` state (theme / volume / allowedExtensionUrls /
 *     userExplicitFps / enableWasm / detailedOptimizations) is not
 *     corrupted.
 *   - v13 → v13 round-trip via `writeSettings` → `readSettings`
 *     preserves the explicit value.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '@/lib/persistence';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_DETAILED_OPTIMIZATIONS,
  DEFAULT_SEMANTIC_OPTIONS,
  STORAGE_KEYS,
  STORAGE_VERSION,
} from '@/utils/constants';

describe('persistence: v12 → v13 migration (§Phase 7)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('STORAGE_VERSION is 13 (§Phase 7 bumped from 12)', () => {
    expect(STORAGE_VERSION).toBe(13);
  });

  it('seeds semantics = DEFAULT_SEMANTIC_OPTIONS when missing from v12 payload', () => {
    const v12Payload = {
      state: {
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          // `semantics` deliberately omitted.
        },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
        detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 12,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v12Payload));

    const settings = readSettings();
    expect(settings.advanced.semantics).toEqual(DEFAULT_SEMANTIC_OPTIONS);
  });

  it('preserves explicit v12 semantics on read', () => {
    const customSemantics = {
      preset: 'low-risk-js' as const,
      strictNumericEquality: false,
      caseSensitiveStrings: true,
      propagateNaN: false,
      truncatedModulo: true,
      jsTruthyBooleans: false,
    };
    const v12WithSemantics = {
      state: {
        theme: 'dark',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          semantics: customSemantics,
        },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
        detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 12,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v12WithSemantics));

    const settings = readSettings();
    expect(settings.advanced.semantics).toEqual(customSemantics);
  });

  it('falls back to default for invalid preset strings (= silent defense)', () => {
    const v12BadPreset = {
      state: {
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          semantics: {
            preset: 'totally-isolated',
            strictNumericEquality: true,
            caseSensitiveStrings: true,
            propagateNaN: true,
            truncatedModulo: true,
            jsTruthyBooleans: true,
          },
        },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
        detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 12,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v12BadPreset));

    const settings = readSettings();
    // preset is the only field that gets the silent fall-back; the
    // per-flag booleans are individually valid so they pass through.
    expect(settings.advanced.semantics.preset).toBe('scratch');
    expect(settings.advanced.semantics.strictNumericEquality).toBe(true);
  });

  it('falls back to default boolean for non-boolean per-flag fields', () => {
    const v12BadFlags = {
      state: {
        theme: 'system',
        volume: 100,
        lastNonMuteVolume: 100,
        advanced: {
          ...DEFAULT_ADVANCED_SETTINGS,
          semantics: {
            preset: 'scratch',
            strictNumericEquality: 'yes',
            caseSensitiveStrings: 1,
            propagateNaN: null,
            truncatedModulo: undefined,
            jsTruthyBooleans: true,
          },
        },
        defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
        allowedExtensionUrls: [],
        enableWasm: true,
        userExplicitFps: null,
        detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
      },
      version: 12,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v12BadFlags));

    const settings = readSettings();
    expect(settings.advanced.semantics.strictNumericEquality).toBe(false);
    expect(settings.advanced.semantics.caseSensitiveStrings).toBe(false);
    expect(settings.advanced.semantics.propagateNaN).toBe(false);
    expect(settings.advanced.semantics.truncatedModulo).toBe(false);
    // jsTruthyBooleans IS a boolean — it passes through.
    expect(settings.advanced.semantics.jsTruthyBooleans).toBe(true);
  });

  it('does not corrupt non-advanced fields during v12 → v13 migration', () => {
    const v12Payload = {
      state: {
        theme: 'midnight',
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
      version: 12,
    };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(v12Payload));

    const settings = readSettings();
    expect(settings.theme).toBe('midnight');
    expect(settings.volume).toBe(75);
    expect(settings.lastNonMuteVolume).toBe(75);
    expect(settings.advanced.fps).toBe(30);
    expect(settings.defaultAdvanced.fps).toBe(45);
    expect(settings.allowedExtensionUrls).toEqual(['https://example.com/ext.js']);
    expect(settings.enableWasm).toBe(false);
    expect(settings.userExplicitFps).toBe(45);
    expect(settings.advanced.semantics).toEqual(DEFAULT_SEMANTIC_OPTIONS);
  });

  it('round-trips v13 payload through write/read with custom preset', () => {
    writeSettings({
      theme: 'system',
      volume: 100,
      lastNonMuteVolume: 100,
      advanced: {
        ...DEFAULT_ADVANCED_SETTINGS,
        semantics: {
          preset: 'full-js',
          strictNumericEquality: true,
          caseSensitiveStrings: true,
          propagateNaN: true,
          truncatedModulo: true,
          jsTruthyBooleans: true,
        },
      },
      defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
      allowedExtensionUrls: [],
      enableWasm: true,
      userExplicitFps: null,
      detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    });
    const settings = readSettings();
    expect(settings.advanced.semantics.preset).toBe('full-js');
    expect(settings.advanced.semantics.truncatedModulo).toBe(true);
  });

  it('round-trips v13 payload through write/read with default preset', () => {
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
    expect(settings.advanced.semantics).toEqual(DEFAULT_SEMANTIC_OPTIONS);
  });
});
