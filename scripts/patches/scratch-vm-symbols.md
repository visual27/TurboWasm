# scratch-vm patch marker registry (Phase 0 — Foundation)

Phase 0 ships the **infrastructure** for tracking which `// TurboWasm:`
markers each Phase's scratch-vm patch introduces. Phase 1+ fills in
the table when its patches land.

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
`test/runtime/scratch-vm-patches-symbols.test.ts` (added in Phase 0).

## Marker table

| Feature area | Marker | Phase | Owner | Test pinning |
|---|---|---|---|---|
| _(Phase 0 ships no patches)_ | _(Phase 0 ships no markers)_ | — | — | — |

## Cross-references

- `scripts/apply-vendored-patches.mjs:extractUniqueMarkers` reads the
  markers from patch files at apply time.
- `test/runtime/scratch-vm-patches-symbols.test.ts` is the
  fixed-probe that fails CI when a marker is removed without
  updating the registry.
- `src/features/settings/constants.ts` is the UI-facing map of
  feature area → detailed toggle. New optimization IDs MUST be
  paired with a new marker in this table so the registry stays
  authoritative.