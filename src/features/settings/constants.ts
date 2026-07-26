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
    '§Phase 2-A — adopted. The per-call `finish(returnValue)` closure inside `executeInCompatibilityLayer` is hoisted to a baseRuntime-level `finishCompatibilityCall(returnValue, branchInfo, blockUtility)` function; the `executeBlock` closure is inlined into `blockUtility.init` + `blockFunction(...)`. The hunk is semantically invariant (= identical observable behaviour for every status transition: promise resolve / reject, STATUS_PROMISE_WAIT, STATUS_DONE, STATUS_YIELD, STATUS_YIELD_TICK, branch returns) and ships with no runtime gate, so the UI toggle is cosmetic. Phase 1 MVP bench on `compat-layer-loop-fixture.sb3` measured heapDelta ≈ 4.42 MB vs the legacy 5.01 MB (≈12% reduction) with no measurable wall-clock win; the reduction is below the §2A-8 15% heap threshold, so a future phase may revisit with `--trace-opt` data, but the patch stays in production because removing it would require `npm run setup -- --force` (re-clone + UMD rebuild) and there is no functional regression. Spec: `phase-02-compat-layer.md` §2A-2 / §2A-7 / §2A-8.',
  'compatLayer.procedureCache':
    '§Phase 2-B — adopted. `JSGenerator.evaluateOnce(`thread.procedures["<variant>"]`)` replaces the per-call string-keyed lookup in both `InputOpcode.PROCEDURE_CALL` and `StackOpcode.PROCEDURE_CALL`. The factory-level setup block emits `const bN = thread.procedures["<variant>"];` once per variant, and every call site in the same compiled script (including recursion, warp, and multi-site invocations) reads the captured const. Variant keys are already warp/non-warp-disambiguated upstream so `b0` and `b1` are distinct. The hunk is semantically invariant (= same function reference as the inline lookup) and ships with no runtime gate, so the UI toggle is cosmetic. Phase 1 MVP bench on `procedure-lazy-cache-fixture.sb3` reported a 10% compiled-vs-interpreted wall win on a 1-trial, low-absolute-value run (≈0.07 ms / 200 frames); the result is consistent with the optimization but the bench window is small, so the row is `adopted` on the basis of "no regression + semantically invariant" rather than on the wall delta. Spec: `phase-02-compat-layer.md` §2B-2 / §2B-3 / §2B-4.',
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