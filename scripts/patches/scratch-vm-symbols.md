# scratch-vm patch marker registry

Phase 0 ships the **infrastructure** for tracking which `// TurboWasm:`
markers each Phase's scratch-vm patch introduces. Phase 1 (1-A / 1-B /
1-C) fills in the first three rows below — all three are semantically
invariant, edge-case-optimised comparisons / edge-hat handling / Infinity
arithmetic in the compiled VM and `Cast.compare`. Phase 2+ will append
rows as new patches land.

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