import type { DetailedCategoryId, DetailedOptimizationId } from './types';

/**
 * Phase 0 — Foundation. Ordering, labels and grouping for the
 * detailed settings screen. Adding a new optimization ID requires
 * updating the matching `DetailedOptimizationId` union in `types.ts`,
 * this map, and the master default map in `utils/constants.ts` —
 * missing entries surface as `enabled: false` until patched.
 */
export const DETAILED_CATEGORY_LABELS: Readonly<Record<DetailedCategoryId, string>> = {
  'compat-layer': 'Compatibility Layer',
  'edge-detection': 'Edge Detection',
  comparison: 'Comparison',
  'data-structures': 'Data Structures',
  compiler: 'Compiler',
  semantics: 'Semantics',
} as const;

export const DETAILED_CATEGORY_DESCRIPTIONS: Readonly<Record<DetailedCategoryId, string>> = {
  'compat-layer':
    'Reduce per-step allocations in the scratch-vm compatibility-layer closure paths.',
  'edge-detection':
    'Lower per-frame overhead for edge-activated hat detection in the runtime.',
  comparison:
    'Short-circuit redundant comparisons in jsexecute / runtime operators.',
  'data-structures':
    'Evaluate maps and constants eagerly when the inputs are compile-time-known.',
  compiler: 'Research rows for upcoming compiler-side experiments.',
  semantics:
    'Adjust equality / modulo / NaN semantics. These change observable project output.',
} as const;

export const DETAILED_CATEGORY_ORDER: readonly DetailedCategoryId[] = [
  'compat-layer',
  'edge-detection',
  'comparison',
  'data-structures',
  'compiler',
  'semantics',
] as const;

export const DETAILED_OPTIMIZATIONS_BY_CATEGORY: Readonly<
  Record<DetailedCategoryId, readonly DetailedOptimizationId[]>
> = {
  'compat-layer': [
    'compatLayer.closureReuse',
    'compatLayer.procedureCache',
    'compatLayer.branchInfoReuse',
    'compatLayer.procedureCacheThreadCompaction',
  ],
  'edge-detection': ['edgeHat.sentinelElimination'],
  comparison: ['comparison.shortCircuit', 'comparison.infinityBranchRemoval'],
  'data-structures': ['data.mapConversionEvaluation', 'data.constantFolding'],
  compiler: ['compiler.generatorGranularityResearch'],
  semantics: [
    'semantics.truncatedModulo',
    'semantics.caseSensitiveStrings',
    'semantics.strictNumericEquality',
    'semantics.jsTruthyBooleans',
    'semantics.propagateNaN',
  ],
};

export const DETAILED_OPTIMIZATION_LABELS: Readonly<Record<DetailedOptimizationId, string>> = {
  'compatLayer.closureReuse': 'Closure Reuse',
  'compatLayer.procedureCache': 'Procedure Cache',
  'compatLayer.branchInfoReuse': 'Branch Info Reuse',
  'compatLayer.procedureCacheThreadCompaction': 'Procedure Cache Thread Compaction',
  'edgeHat.sentinelElimination': 'Edge Hat Sentinel Elimination',
  'comparison.shortCircuit': 'Comparison Short-Circuit',
  'comparison.infinityBranchRemoval': 'Infinity Branch Removal',
  'data.mapConversionEvaluation': 'Map Conversion Evaluation',
  'data.constantFolding': 'Constant Folding',
  'compiler.generatorGranularityResearch': 'Generator Granularity (Research)',
  'semantics.truncatedModulo': 'Truncated Modulo',
  'semantics.caseSensitiveStrings': 'Case-Sensitive Strings',
  'semantics.strictNumericEquality': 'Strict Numeric Equality',
  'semantics.jsTruthyBooleans': 'JS-Truthy Booleans',
  'semantics.propagateNaN': 'Propagate NaN',
};

export const DETAILED_OPTIMIZATION_DESCRIPTIONS: Readonly<
  Record<DetailedOptimizationId, string>
> = {
  'compatLayer.closureReuse':
    'Reuse compatibility-layer closure objects across steps instead of allocating per-thread.',
  'compatLayer.procedureCache':
    'Cache resolved procedure frames so repeat calls skip the lookup walk.',
  'compatLayer.branchInfoReuse':
    'Reuse branch-info snapshots across procedures that share a callee.',
  'compatLayer.procedureCacheThreadCompaction':
    'Compact the procedure cache on thread exit to bound memory under long loops.',
  'edgeHat.sentinelElimination':
    'Replace the !oldEdgeValue sentinel path with a tighter in-place branch.',
  'comparison.shortCircuit':
    'Short-circuit `compareEqual` when both sides are already identical JS values.',
  'comparison.infinityBranchRemoval':
    'Remove the Infinity branch in compareGreaterThan/LessThan via bitselect.',
  'data.mapConversionEvaluation':
    'Evaluate map conversions at compile time when all keys are literals.',
  'data.constantFolding':
    'Fold boolean / arithmetic / string constants emitted by the compiler.',
  'compiler.generatorGranularityResearch':
    'Research row for upcoming generator-granularity experiments. Off by default.',
  'semantics.truncatedModulo':
    'Apply truncated modulo semantics to `%` (changes sign of result for negative inputs).',
  'semantics.caseSensitiveStrings':
    'Make string contains / index-of / equals case-sensitive.',
  'semantics.strictNumericEquality':
    'Reject type coercion in `=` when one operand is a numeric string.',
  'semantics.jsTruthyBooleans':
    'Treat "0" / "false" / empty strings as JS-truthy (matches upstream).',
  'semantics.propagateNaN':
    'Propagate NaN through chained operators without short-circuiting.',
};