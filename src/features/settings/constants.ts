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
    '§Phase 2-A — Permanently skipped at MVP. The proposed hoisting of the per-call `finish(returnValue)` closure out of `executeInCompatibilityLayer` produced a marginal heapDelta improvement (≈12% in compiled mode) but **no wall-clock win** against the legacy shape on `compat-layer-loop-fixture.sb3` (200-iteration `motion_movesteps` repeat; n=30, warmup=5, frames=600). Both versions report compiled mode as **slower** than the interpreted baseline (V8 deopts on the new control-flow shape inside the per-call generator). The UI toggle is therefore cosmetic (= no runtime gate), no patch is applied, and the detailed-row description deliberately documents the bench verdict so a future phase can re-evaluate with `--trace-opt` data. Spec: `phase-02-compat-layer.md` §2A-2, §2A-7, §2A-8.',
  'compatLayer.procedureCache':
    '§Phase 2-B — Placeholder. The procedural-frame cache prototype was permanently skipped at MVP because the JSON-key-parse cost of `thread.procedures[key]` is amortised below the 1% bench threshold by V8 JIT inside the typical procedure-call frequency. Reserved for a future phase with browser-side / `--trace-opt` validation.',
  'compatLayer.branchInfoReuse':
    'Reuse branch-info snapshots across procedures that share a callee.',
  'compatLayer.procedureCacheThreadCompaction':
    'Compact the procedure cache on thread exit to bound memory under long loops.',
  'edgeHat.sentinelElimination':
    'Skip the explicit `hasEdgeActivatedValue` probe when evaluating an edge-activated hat by relying on `updateEdgeActivatedValue` returning `undefined` (= falsy) on first access. Subsequent accesses return the previously stored value and reduce to the same `!old && new` expression as the legacy ternary.',
  'comparison.shortCircuit':
    'Replace the double `typeof fast-path || v1 === v2` expression in compiled `compareEqual` with a block-form short-circuit: `v1 === v2` → true; both numbers non-NaN → false; otherwise fall through to `compareEqualSlow`. Identical output, fewer branches per call.',
  'comparison.infinityBranchRemoval':
    'Remove the Infinity special branch in Cast.compare by replacing the legacy `n1 - n2` subtraction-based path with direct `<` / `>` / `=== 0` comparison. Operators care only about the sign so the result is identical for every input pair.',
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