import type { DetailedCategoryId, DetailedOptimizationId } from './types';

/**
 * Phase 0 — Foundation. Ordering, labels and grouping for the detailed
 * settings screen. Adding a new optimization ID requires updating the
 * matching `DetailedOptimizationId` union in `types.ts`, this map, and
 * the master default map in `utils/constants.ts` — missing entries
 * surface as `enabled: false` until patched.
 *
 * After the v14 settings-dialog refactor only the IDs with an actual
 * runtime gate (= `setCompilerOptions` key in
 * `src/runtime/settings-bridge.ts`) survive in the visible UI. The
 * previously exposed categories `edge-detection` / `comparison` /
 * `compiler` were removed because every ID they contained was
 * cosmetic (= no vendored runtime gate, see
 * `scripts/patches/scratch-vm-symbols.md`). The remaining categories
 * each render their toggles inline (no drill-down).
 */
export const DETAILED_CATEGORY_LABELS: Readonly<Record<DetailedCategoryId, string>> = {
  'compat-layer': 'Compatibility Layer',
  'data-structures': 'Data Structures',
} as const;

export const DETAILED_CATEGORY_DESCRIPTIONS: Readonly<Record<DetailedCategoryId, string>> = {
  'compat-layer': 'Reduce memory use in compatible extension control blocks.',
  'data-structures': 'Speed up script preparation and fixed calculations.',
} as const;

export const DETAILED_CATEGORY_ORDER: readonly DetailedCategoryId[] = [
  'compat-layer',
  'data-structures',
] as const;

export const DETAILED_OPTIMIZATIONS_BY_CATEGORY: Readonly<
  Record<DetailedCategoryId, readonly DetailedOptimizationId[]>
> = {
  'compat-layer': ['compatLayer.branchInfoReuse'],
  'data-structures': ['data.mapConversionEvaluation', 'data.constantFolding'],
};

export const DETAILED_OPTIMIZATION_LABELS: Readonly<Record<DetailedOptimizationId, string>> = {
  'compatLayer.branchInfoReuse': 'Branch Info Reuse',
  'data.mapConversionEvaluation': 'Map Conversion Evaluation',
  'data.constantFolding': 'Constant Folding',
};

export const DETAILED_OPTIMIZATION_DESCRIPTIONS: Readonly<
  Record<DetailedOptimizationId, string>
> = {
  'compatLayer.branchInfoReuse':
    'Reduce memory use in compatible extension control blocks.',
  'data.mapConversionEvaluation': 'Speed up repeated script compilation.',
  'data.constantFolding': 'Speed up scripts with fixed calculations.',
};

/**
 * §Phase 7 — display labels for the five semantic flags + the four
 * presets that drive `AdvancedSettings.semantics`. The runtime key
 * (`semantics.truncatedModulo` etc.) lives on `SemanticOptions[flag]`
 * (= a nested field on `advanced.semantics`) so this map is the single
 * source of truth for the Semantics settings panel's labels.
 */
export const SEMANTIC_FLAG_LABELS: Readonly<Record<string, string>> = {
  strictNumericEquality: 'Strict Numeric Equality',
  caseSensitiveStrings: 'Case-sensitive Strings',
  propagateNaN: 'Propagate NaN',
  truncatedModulo: 'Truncated Modulo',
  jsTruthyBooleans: 'JS Truthy Booleans',
};

export const SEMANTIC_FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  strictNumericEquality: 'Treat numeric text and numbers as different values.',
  caseSensitiveStrings: 'Treat uppercase and lowercase text as different.',
  propagateNaN: 'Keep invalid-number results instead of replacing them with zero.',
  truncatedModulo: 'Use JavaScript-style results for negative modulo operations.',
  jsTruthyBooleans: 'Treat non-empty text, including "0" and "false", as true.',
};

export const SEMANTIC_FLAG_ORDER: readonly (keyof import('@/types/settings').SemanticOptions)[] = [
  'truncatedModulo',
  'caseSensitiveStrings',
  'strictNumericEquality',
  'jsTruthyBooleans',
  'propagateNaN',
] as const;

export const SEMANTIC_PRESET_LABELS: Readonly<Record<string, string>> = {
  scratch: 'Scratch (default)',
  'low-risk-js': 'Low-risk JS',
  'full-js': 'Full JS',
  custom: 'Custom',
};

export const SEMANTIC_PRESET_DESCRIPTIONS: Readonly<Record<string, string>> = {
  scratch: 'Preserve standard Scratch behavior.',
  'low-risk-js': 'Use case-sensitive text and JavaScript-style modulo.',
  'full-js': 'Align comparisons, numbers, text, and booleans with JavaScript.',
  custom: 'Configure each value behavior individually.',
};