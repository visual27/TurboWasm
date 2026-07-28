import { describe, expect, it } from 'vitest';
import {
  applySemanticPreset,
  buildProjectAdvanced,
  parseTwconfigFromComments,
} from '@/runtime/twconfig';
import { DEFAULT_ADVANCED_SETTINGS, DEFAULT_SEMANTIC_OPTIONS } from '@/utils/constants';

describe('twconfig — semantics (§Phase 7)', () => {
  it('parses semanticsPreset from a flat key', () => {
    const comments = [{ text: '// _twconfig_\n{"semanticsPreset": "full-js"}' }];
    const result = parseTwconfigFromComments(comments);
    expect(result.semantics).toEqual({ preset: 'full-js' });
  });

  it('parses per-flag semantics keys at the top level', () => {
    const comments = [
      {
        text: '// _twconfig_\n{"truncatedModulo": true, "caseSensitiveStrings": true}',
      },
    ];
    const result = parseTwconfigFromComments(comments);
    // The parser only collects the per-flag keys — `preset` is set
    // by `buildProjectAdvanced` (= the merge site) when the patch
    // contains per-flag changes without a preset. See the
    // `buildProjectAdvanced falls back to baseline ...` test below.
    expect(result.semantics).toEqual({
      truncatedModulo: true,
      caseSensitiveStrings: true,
    });
  });

  it('parses semantics as a nested object', () => {
    const comments = [
      {
        text:
          '// _twconfig_\n{"semantics": {"preset": "low-risk-js", "truncatedModulo": true}}',
      },
    ];
    const result = parseTwconfigFromComments(comments);
    expect(result.semantics).toEqual({
      preset: 'low-risk-js',
      truncatedModulo: true,
    });
  });

  it('silently drops invalid preset values', () => {
    const comments = [
      { text: '// _twconfig_\n{"semanticsPreset": "totally-isolated"}' },
    ];
    const result = parseTwconfigFromComments(comments);
    expect(result).toEqual({});
  });

  it('silently drops invalid preset values nested in the semantics object', () => {
    const comments = [
      {
        text:
          '// _twconfig_\n{"semantics": {"preset": "no-such-preset", "truncatedModulo": true}}',
      },
    ];
    const result = parseTwconfigFromComments(comments);
    // preset is dropped, per-flag still passes through
    expect(result.semantics).toEqual({ truncatedModulo: true });
  });

  it('buildProjectAdvanced deep-merges semantics from the override', () => {
    const baseline = DEFAULT_ADVANCED_SETTINGS;
    const result = buildProjectAdvanced(baseline, {
      semantics: { ...DEFAULT_SEMANTIC_OPTIONS, preset: 'low-risk-js' },
    });
    expect(result.semantics.preset).toBe('low-risk-js');
    // Preset bundle wins over baseline per-flag fields.
    expect(result.semantics.caseSensitiveStrings).toBe(true);
    expect(result.semantics.truncatedModulo).toBe(true);
    expect(result.semantics.strictNumericEquality).toBe(false);
  });

  it('buildProjectAdvanced flips preset to "custom" when override has only per-flag fields (= no preset)', () => {
    // When the override does NOT specify a preset but flips a per-flag
    // field, the merged semantics auto-flips `preset` to `'custom'`
    // (= the user owns the per-flag combination). The cast is necessary
    // because `AdvancedSettings['semantics']` is a full SemanticOptions
    // (= `preset` is required) but the test wants to assert the
    // "override has no preset" branch, which is what the runtime path
    // actually feeds in (= `patchSemantic({ truncatedModulo: true })`
    // sets the per-flag field without `preset` and the store merge
    // flips to `'custom'`).
    const baseline = DEFAULT_ADVANCED_SETTINGS;
    const override = {
      strictNumericEquality: false,
      caseSensitiveStrings: false,
      propagateNaN: false,
      truncatedModulo: true,
      jsTruthyBooleans: false,
    } as unknown as typeof baseline.semantics;
    const result = buildProjectAdvanced(baseline, { semantics: override });
    expect(result.semantics.preset).toBe('custom');
    expect(result.semantics.truncatedModulo).toBe(true);
  });

  it('buildProjectAdvanced preserves the baseline when override has no semantics', () => {
    const baseline = DEFAULT_ADVANCED_SETTINGS;
    const result = buildProjectAdvanced(baseline, {});
    expect(result.semantics).toEqual(DEFAULT_SEMANTIC_OPTIONS);
  });

  it('buildProjectAdvanced preserves a custom baseline preset (= no override semantics)', () => {
    const baseline = {
      ...DEFAULT_ADVANCED_SETTINGS,
      semantics: {
        preset: 'full-js' as const,
        strictNumericEquality: true,
        caseSensitiveStrings: true,
        propagateNaN: true,
        truncatedModulo: true,
        jsTruthyBooleans: true,
      },
    };
    const result = buildProjectAdvanced(baseline, { fps: 60 });
    expect(result.semantics).toEqual(baseline.semantics);
  });

  it('applySemanticPreset keeps the baseline per-flag fields for the "custom" preset', () => {
    const baseline = {
      preset: 'scratch' as const,
      strictNumericEquality: false,
      caseSensitiveStrings: false,
      propagateNaN: false,
      truncatedModulo: false,
      jsTruthyBooleans: false,
    };
    const result = applySemanticPreset('custom', baseline);
    expect(result.preset).toBe('custom');
    expect(result.caseSensitiveStrings).toBe(false);
  });

  it('applySemanticPreset replaces per-flag fields for "low-risk-js"', () => {
    const baseline = DEFAULT_SEMANTIC_OPTIONS;
    const result = applySemanticPreset('low-risk-js', baseline);
    expect(result.preset).toBe('low-risk-js');
    expect(result.caseSensitiveStrings).toBe(true);
    expect(result.truncatedModulo).toBe(true);
    expect(result.strictNumericEquality).toBe(false);
  });

  it('applySemanticPreset replaces per-flag fields for "full-js"', () => {
    const baseline = DEFAULT_SEMANTIC_OPTIONS;
    const result = applySemanticPreset('full-js', baseline);
    expect(result.preset).toBe('full-js');
    expect(result.strictNumericEquality).toBe(true);
    expect(result.propagateNaN).toBe(true);
    expect(result.jsTruthyBooleans).toBe(true);
  });
});
