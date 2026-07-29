# scratch-vm patch marker registry

Phase 0 ships the **infrastructure** for tracking which `// TurboWasm:`
markers each Phase's scratch-vm patch introduces. Phase 1 (1-A / 1-B /
1-C) fills in the first three rows below — all three are semantically
invariant, edge-case-optimised comparisons / edge-hat handling / Infinity
arithmetic in the compiled VM and `Cast.compare`. Phase 2 (2-A / 2-B)
appends the two allocation-reduction rows; both are semantically
invariant and ship with no runtime gate (the UI toggle is cosmetic).

## Naming convention

Each marker comment has the shape:

```text
// TurboWasm: <feature-area>-<shape>
```

- `<feature-area>` mirrors a `DetailedOptimizationId` namespace (e.g.
  `comparison`, `semantics`, `compat-layer`) so a marker table scan
  maps cleanly to a UI toggle.
- `<shape>` describes the concrete edit (`short-circuit`,
  `infinity-branch-removal`, `sentinel-eliminated`, …).

The `extractUniqueMarkers` helper in `scripts/apply-vendored-patches.mjs`
already extracts these markers from `+` lines inside patch files, so
the table below is the source-of-truth consumed by
`test/runtime/scratch-vm-patches-symbols.test.ts`.

## Marker table

| Feature area | Marker | Phase | Owner | Test pinning |
|---|---|---|---|---|
| Comparison (compareEqual short-circuit) | `// TurboWasm: comparison-compare-equal-short-circuit` | 1-A | `vendored/scratch-vm/src/compiler/jsexecute.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-compare-equal.test.ts` |
| Edge Detection (hat sentinel elimination) | `// TurboWasm: edge-detection-hat-sentinel-eliminated` | 1-B | `vendored/scratch-vm/src/engine/execute.js` + `vendored/scratch-vm/src/compiler/jsgen.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-edge-hat.test.ts` |
| Comparison (Infinity branch removal) | `// TurboWasm: comparison-infinity-branch-removed` | 1-C | `vendored/scratch-vm/src/util/cast.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-cast-compare.test.ts` |
| Compatibility layer (closure finish extraction) | `// TurboWasm: compat-layer-finish-extracted` | 2-A | `vendored/scratch-vm/src/compiler/jsexecute.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-compat-layer-finish-extracted.test.ts` |
| Procedure call (lazy reference cache) | `// TurboWasm: procedure-lazy-cache` | 2-B | `vendored/scratch-vm/src/compiler/jsgen.js` (reporter + command paths) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-procedure-lazy-cache.test.ts` |
| Procedure definition (entry via prototype SUBSTACK) | `// TurboWasm: procedure-definition-entry-prototype-substack` | 2-B companion | `vendored/scratch-vm/src/compiler/irgen.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/compiler-procedure-body.test.ts` |
| Compiler (constant folding) | `// TurboWasm: constant-folding` | 3 | `vendored/scratch-vm/src/compiler/iroptimizer.js` + `vendored/scratch-vm/src/compiler/compile.js` + `vendored/scratch-vm/src/engine/runtime.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-constant-folding.test.ts` |
| Compiler (NaN / -0 constant emit) | `// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler` | 3 follow-up | `vendored/scratch-vm/src/compiler/jsgen.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-constant-folding.test.ts` |
| GPU kernel runtime adapter (list / scalar buffer accessors) | `// TurboWasm: list / scalar buffer accessors` | M2 | `vendored/scratch-vm/src/engine/runtime.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/gpu-kernel-patches.test.ts` |
| Compat layer (branch-info pool) | `// TurboWasm: branch-info-pool` | 4-A (opt-in) | `vendored/scratch-vm/src/compiler/jsexecute.js` + `vendored/scratch-vm/src/compiler/jsgen.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-compat-layer-branch-info-pool.test.ts` |
| Engine blocks (compiledScripts Map backing) | `// TurboWasm: blocks-cache-map` | 4-B (opt-in) | `vendored/scratch-vm/src/engine/blocks.js` | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-blocks-cache-map.test.ts` |
| Engine runtime (semantics compiler-options bag) | `// TurboWasm: semantics-compiler-options` | 7 | `vendored/scratch-vm/src/engine/runtime.js` (compilerOptions init) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-semantics-compiler-options.test.ts` |
| Compiler (truncated modulo JS %) | `// TurboWasm: truncated-modulo` | 8-A | `vendored/scratch-vm/src/compiler/jsgen.js` (OP_MOD case) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-truncated-modulo.test.ts` |
| Interpreter (truncated modulo JS %) | `// TurboWasm: truncated-modulo-interpreter` | 8-A | `vendored/scratch-vm/src/blocks/scratch3_operators.js` (`mod` block) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-truncated-modulo.test.ts` |
| Compiler (case-sensitive strings) | `// TurboWasm: case-sensitive-strings` | 8-B | `vendored/scratch-vm/src/compiler/jsgen.js` (OP_CONTAINS) + `vendored/scratch-vm/src/compiler/jsexecute.js` (compare family + `compareContains` + `__semantics` capture) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-case-sensitive-strings.test.ts` |
| Util (case-sensitive strings) | `// TurboWasm: case-sensitive-strings` | 8-B | `vendored/scratch-vm/src/util/cast.js` (`compare` signature) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Interpreter (case-sensitive strings contains) | `// TurboWasm: case-sensitive-strings` | 8-B | `vendored/scratch-vm/src/blocks/scratch3_operators.js` (`contains` block) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Interpreter (case-sensitive strings list search) | `// TurboWasm: case-sensitive-strings` | 8-B | `vendored/scratch-vm/src/blocks/scratch3_data.js` (`listContainsItem` / `getItemNumOfList`) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Compiler (JS truthy booleans) | `// TurboWasm: js-truthy-booleans` | 9-B | `vendored/scratch-vm/src/compiler/jsexecute.js` (`runtimeFunctions.toBoolean` + the existing Phase 8-B `__semantics` capture, which now also reads `jsTruthyBooleans`) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-js-truthy-booleans.test.ts` |
| Util (JS truthy booleans) | `// TurboWasm: js-truthy-booleans` | 9-B | `vendored/scratch-vm/src/util/cast.js` (`toBoolean` static flag + `setSemanticFlags` setter) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Engine runtime (setCompilerOptions → Cast.setSemanticFlags) | `// TurboWasm: js-truthy-booleans` | 9-B | `vendored/scratch-vm/src/engine/runtime.js` (`setCompilerOptions`) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Compiler (propagate NaN) | `// TurboWasm: propagate-nan` | 9-C | `vendored/scratch-vm/src/compiler/jsexecute.js` (`runtimeFunctions.toNotNaN`) | `test/runtime/scratch-vm-patches-symbols.test.ts` + `test/runtime/scratch-vm-tap-bridge-propagate-nan.test.ts` |
| Util (propagate NaN) | `// TurboWasm: propagate-nan` | 9-C | `vendored/scratch-vm/src/util/cast.js` (`_propagateNaNFlag` static + `setSemanticFlags` setter + `toNumber` short-circuit) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Engine runtime (propagate-nan mirror — Phase 9-C extension) | `// TurboWasm: propagate-nan` | 9-C | `vendored/scratch-vm/src/engine/runtime.js` (`setCompilerOptions` extended comment block) | `test/runtime/scratch-vm-patches-symbols.test.ts` (source probe) |
| Scheduler (eval-A reference patch) | `// TurboWasm: scheduler-eval-A` | 5 (research-only) | `patches/vendored/scratch-vm-eval-scheduler-A.patch` (sequencer.js + runtime.js; not auto-applied) | `test/runtime/scratch-vm-patches-symbols.test.ts` (patches-dir probe) + `test/runtime/scratch-vm-scheduler-eval-a.test.ts` |
| Scheduler (eval-B reference patch) | `// TurboWasm: scheduler-eval-B` | 5 (research-only) | `patches/vendored/scratch-vm-eval-scheduler-B.patch` (sequencer.js + runtime.js; not auto-applied) | `test/runtime/scratch-vm-patches-symbols.test.ts` (patches-dir probe) + `test/runtime/scratch-vm-scheduler-eval-b.test.ts` |
| Generator (eval-X reference patch) | `// TurboWasm: generator-eval-X` | 6 (research-only) | `patches/vendored/scratch-vm-eval-generator-X.patch` (jsgen.js; not auto-applied) | `test/runtime/scratch-vm-patches-symbols.test.ts` (patches-dir probe) + `test/runtime/scratch-vm-generator-eval-x.test.ts` |
| Generator (eval-Y reference patch) | `// TurboWasm: generator-eval-Y` | 6 (research-only) | `patches/vendored/scratch-vm-eval-generator-Y.patch` (irgen.js; not auto-applied) | `test/runtime/scratch-vm-patches-symbols.test.ts` (patches-dir probe) + `test/runtime/scratch-vm-generator-eval-y.test.ts` |

The M2 row was previously shipped via the standalone
`patches/vendored/gpu-kernel-list-binding+0.1.0.patch` (created at `6da15a7`,
regenerated by `74fb3fd` / `d5843aa`). At commit `263378e` the content
was absorbed into `patches/vendored/scratch-vm.patch` and the standalone
patch was removed; see AGENTS.md "`SCRATCH_VM_REF` の pin（必須）"
for the migration note and `scripts/regen-gpu-kernel-patches.mjs` for
the regenerated single-patch helper scope.

The §Phase 5 scheduler-eval-A / eval-B rows are **reference-only**
patches. They document two alternative compaction strategies
(= `// TurboWasm: scheduler-eval-A` lifts Sequencer's in-place
compaction to Runtime._step and extends it to STATUS_DONE;
`// TurboWasm: scheduler-eval-B` drops Runtime._step's pre-step
compaction into Sequencer and extends it to `isKilled`) but they
are **not auto-applied** by `setup-vendored.mjs`. The benchmark
harness `scripts/bench-scheduler-eval.mjs` evaluates each variant
by monkey-patching the vendored scratch-vm at runtime, which lets
both reference patches coexist in the repository without forcing a
mutually-exclusive apply. The marker registry scans
`patches/vendored/*.patch` (in addition to the UMD and vendored
source) so these reference-only markers trip the same
drift-detection path as applied markers — see the
`patches/vendored/*.patch` probe in
`test/runtime/scratch-vm-patches-symbols.test.ts`. Analysis
output: `C:/files/memo/scratch-vm-optimization/phase-05-scheduler-analysis.md`.

## Cross-references

- `scripts/apply-vendored-patches.mjs:extractUniqueMarkers` reads the
  markers from patch files at apply time.
- `test/runtime/scratch-vm-patches-symbols.test.ts` is the
  fixed-probe that fails CI when a marker is removed without
  updating the registry.
- `src/features/settings/constants.ts` is the UI-facing map of
  feature area → detailed toggle. Each marker in this table maps 1:1
  to a `DetailedOptimizationId` so a UI toggle, the source marker,
  and the vendored runtime gate all live under the same namespace.