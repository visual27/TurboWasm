#!/usr/bin/env node
/**
 * Ensure the `test/.test-fixtures/` workspace exists and is populated.
 *
 * `test/.test-fixtures/` is gitignored: every file inside it is regenerated
 * on demand by the scripts under `scripts/`. This module is the single
 * entry point — `npm run fixtures:setup` and a gitignored `pretest`/CI
 * bootstrap step both go through here.
 *
 * The directory lives under `test/` (not at the repo root) so tests
 * and fixtures travel together for IDE grouping while staying out of
 * `src/` (which is reserved for production code under
 * `tsconfig.json`'s `include`).
 *
 * Idempotent: re-running overwrites each fixture with the canonical
 * generator output. Each generator is run in isolation so a single
 * failure surfaces immediately (instead of being swallowed by a `for`
 * loop that aborts on the first error).
 *
 * Exported as `ensureTestFixtures({ cwd })` so unit tests can drive it
 * against the real workspace without taking a sandbox dependency on
 * the module-load-time `outDir` constants in each generator.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import sb3fix from '@turbowarp/sb3fix';

/**
 * Resolve the project root from a script URL.
 *
 * Defaults to deriving it from this file's location (canonical `node`
 * invocation), but accepts an explicit override so tests can pin it to
 * a fixture sandbox.
 */
export function resolveRepoRoot(fromUrl = import.meta.url) {
  const here = dirname(fileURLToPath(fromUrl));
  return resolve(here, '..');
}

/**
 * List of fixture generators, declared as a record so each one can be
 * invoked by name (helps unit tests iterate them in isolation) and so
 * new fixtures plug in by adding a single entry.
 */
export const FIXTURE_GENERATORS = {
  'bench-touching.sb3': () =>
    import('./gen-bench-sb3.mjs').then((m) => m.writeBenchTouchingFixture()),
  'svg-sprite-fixture.sb3': () =>
    import('./make-svg-sprite-fixture.mjs').then((m) => m.makeSvgSpriteFixture()),
  'twconfig-fixture.sb3': () =>
    import('./make-twconfig-fixture.mjs').then((m) => m.makeTwconfigFixture()),
  'twconfig-640x480.sb3': () =>
    import('./make-twconfig-640x480.mjs').then((m) => m.makeTwconfig640x480()),
  'repro.sb3': () => import('./make-repro-fixture.mjs').then((m) => m.makeRepro()),
  'stage-size-sprite-repro.sb3': () =>
    import('./make-stage-size-sprite-repro.mjs').then((m) => m.writeStageSizeSpriteRepro()),
  'expo-fixture.sb3': () => import('./make-expo-fixture.mjs').then((m) => m.makeExpoFixture()),
  // Phase 4 (nested-parallelization-05-phase4 §3.2): the nested
  // variant shares the legacy `make-expo-fixture.mjs` module but uses a
  // different scratch layout (kernel container = ancestor control_repeat,
  // not the @compute candidate itself). Registered here so
  // `npm run fixtures:setup` produces both fixtures in one pass.
  'expo-fixture-nested.sb3': () =>
    import('./make-expo-fixture.mjs').then((m) => m.makeNestedExpoFixture()),
  // §Phase 4 (15.7) — byte-scalar variant. Same legacy layout but the
  // `@compute` region carries `@bind byte_state(3) ro byte, scalar` so
  // the WGSL↔host ABI byte→i32 mapping is exercised. Used by
  // `verify-gpu-kernel.mjs` and unit tests in
  // `test/runtime/gpu-kernel/scalar-uniform-binding.test.ts`.
  'expo-fixture-byte-scalar.sb3': () =>
    import('./make-expo-fixture.mjs').then((m) => m.makeByteScalarExpoFixture()),
  // §Phase 5 §15.9 / §15.14 — diagnostics fixture. Two `@compute`
  // markers in the same sprite (`gpu.multiple_compute_regions`, error)
  // plus a `@bind let(0) ...` that emits `gpu.identifier_collision`
  // (warn). Used to pin the shared `forwardGpuDiagnostics` path from
  // the extractor + emitter all the way to `ErrorLogPanel`.
  'gpu-kernel-diagnostics-fixture.sb3': () =>
    import('./make-gpu-kernel-diagnostics-fixture.mjs').then((m) =>
      m.makeGpuKernelDiagnosticsFixture(),
    ),
  // §Phase 3 (gpu-kernel-dsl-phase3-spec §3.6) — multi-region
  // fixture. Two `@compute` markers on distinct `control_repeat` blocks
  // in the same sprite; both regions are adopted without diagnostic,
  // and both share `@bind buff_r(2) rw f32` to exercise the cross-
  // region slot overlap `console.debug` path. Loaded by
  // `test/runtime/gpu-kernel/multi-region-fixture.test.ts`.
  'multi-region-fixture.sb3': () =>
    import('./make-multi-region-fixture.mjs').then((m) => m.makeMultiRegionFixture()),
  // §Phase 5 (gpu-kernel-dsl-phase5-spec §5.6) — custom-block fixture.
  // A `procedures_prototype` (`fn_apply_expo %s`) with an `@compute`
  // region inside its body, invoked 3 times via `procedure_call`. After
  // inlining we expect 3 regions sharing 1 canonical key. Loaded by
  // `test/runtime/gpu-kernel/custom-block-fixture.test.ts`.
  'custom-block-fixture.sb3': () =>
    import('./make-custom-block-fixture.mjs').then((m) => m.makeCustomBlockFixture()),
  // User-facing pixel-level expo calculation wrapped in a custom block
  // (`fn_expo %s`). The `@compute` marker sits on the middle
  // `repeat(aabb_h[aabb_idx0])` block (= Form A kernel container, per
  // gpu-kernel-dsl-phase4 §4.1) and the inner `repeat(aabb_tmp0)`
  // becomes the `global_x` dispatch axis via `repeatPath="0"`. Drives
  // `scripts/measure-expo-custom-block.mjs` (real-device chrome-devtools
  // benchmark) and the in-memory pipeline test in
  // `test/runtime/gpu-kernel/expo-custom-block-fixture.test.ts`.
  'expo-custom-block-fixture.sb3': () =>
    import('./make-expo-custom-block-fixture.mjs').then((m) => m.makeExpoCustomBlockFixture()),
  // §Phase 6 (gpu-kernel-scratch-temporary-let-binding.md) — auto-tmp
  // fixture. A single `@compute` region whose body carries scratch
  // `data_setvariableto` writes (`tmp0`, `tmp1`) without explicit
  // `@map` bindings. Drives `detectAutoTmpBindings` end-to-end and
  // pins the WGSL `let tmp0: f32 = ...; let tmp1: f32 = ...;`
  // emission. Loaded by
  // `test/runtime/gpu-kernel/auto-tmp-fixture-integration.test.tsx`.
  'auto-tmp-fixture.sb3': () =>
    import('./make-auto-tmp-fixture.mjs').then((m) => m.makeAutoTmpFixture()),
  // §Phase 0 — Foundation skeletons (phase-00-foundation.md §P0-1-B).
  // Each generator ships a schema-valid but minimal sb3 so
  // `npm run fixtures:setup` exercises the schema gate. Phase 1+
  // expands `buildProjectJson` per fixture to express the specific
  // scratch behaviour the underlying optimization needs.
  'compat-layer-loop-fixture.sb3': () =>
    import('./make-compat-layer-loop-fixture.mjs').then((m) => m.makeCompatLayerLoopFixture()),
  'edge-hat-fixture.sb3': () =>
    import('./make-edge-hat-fixture.mjs').then((m) => m.makeEdgeHatFixture()),
  'compare-equal-fixture.sb3': () =>
    import('./make-compare-equal-fixture.mjs').then((m) => m.makeCompareEqualFixture()),
  'infinity-branch-fixture.sb3': () =>
    import('./make-infinity-branch-fixture.mjs').then((m) => m.makeInfinityBranchFixture()),
  'truncated-modulo-fixture.sb3': () =>
    import('./make-truncated-modulo-fixture.mjs').then((m) => m.makeTruncatedModuloFixture()),
  'case-sensitive-strings-fixture.sb3': () =>
    import('./make-case-sensitive-strings-fixture.mjs').then((m) =>
      m.makeCaseSensitiveStringsFixture(),
    ),
  'strict-equality-fixture.sb3': () =>
    import('./make-strict-equality-fixture.mjs').then((m) => m.makeStrictEqualityFixture()),
  'js-truthy-fixture.sb3': () =>
    import('./make-js-truthy-fixture.mjs').then((m) => m.makeJsTruthyFixture()),
  'propagate-nan-fixture.sb3': () =>
    import('./make-propagate-nan-fixture.mjs').then((m) => m.makePropagateNanFixture()),
  'procedure-lazy-cache-fixture.sb3': () =>
    import('./make-procedure-lazy-cache-fixture.mjs').then((m) =>
      m.makeProcedureLazyCacheFixture(),
    ),
  'constant-folding-fixture.sb3': () =>
    import('./make-constant-folding-fixture.mjs').then((m) => m.makeConstantFoldingFixture()),
  'compat-layer-branch-info-fixture.sb3': () =>
    import('./make-compat-layer-branch-info-fixture.mjs').then((m) =>
      m.makeCompatLayerBranchInfoFixture(),
    ),
  // §Phase 5 (scheduler research) — high-frequency thread churn
  // fixture. 1 sprite × 50 clones × 5 broadcasts/frame × 1 tick thread
  // per (broadcast, clone) pair = ~250 thread starts + ~150 thread
  // ends per frame at steady state. Drives the Sequencer in-place
  // compaction loop and the Runtime._step pre-step `isKilled`
  // compaction at every step. Loaded by
  // `scripts/bench-scheduler-eval.mjs` and
  // `test/runtime/scratch-vm-scheduler-eval-{a,b}.test.ts`.
  'clone-storm-fixture.sb3': () =>
    import('./make-clone-storm-fixture.mjs').then((m) => m.makeCloneStormFixture()),
};

/**
 * Default "wired" list — fixtures that ship out-of-the-box. Each entry
 * maps to the generator function above; the keys double as the on-disk
 * filename in `test/.test-fixtures/`.
 */
export const DEFAULT_FIXTURES = Object.keys(FIXTURE_GENERATORS);

/**
 * Ensure `test/.test-fixtures/` exists and write every default fixture into it.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] Repo root override (test-only).
 * @param {string[]} [options.only] Subset of fixture names; defaults to all.
 * @returns {Promise<{outDir: string, written: string[], skipped: string[]}>}
 *   The directory, plus the fixture names that were (re)generated vs the
 *   ones whose requested generator was not in the registry.
 */
/**
 * §SB3 schema regression gate — re-open every freshly written `.sb3`,
 * unpack the embedded `project.json`, and run it through
 * `@turbowarp/sb3fix.fixJSON(platform: 'scratch')` so that any
 * shape-level regression (variables 4-tuple, list objects in
 * `variables`, missing list primitive on input descriptors, non-MD5
 * assetId, etc.) is surfaced at fixture-generation time rather than
 * at first load. Pure-Scratch and pure-TurboWarp platforms are both
 * validated.
 *
 * Skip when `options.skipSchemaValidate === true` so unit tests that
 * drive the generator with bad intent can opt out.
 */
async function validateFixtures(outDir, names) {
  const failures = [];
  for (const name of names) {
    const path = resolve(outDir, name);
    let buf;
    try {
      buf = readFileSync(path);
    } catch (e) {
      failures.push(`${name}: cannot read (${e.message})`);
      continue;
    }
    let zip;
    try {
      // Pass a fresh ArrayBuffer so JSZip sees exactly the bytes the
      // file claims to contain (Node 24's Buffer can carry trailing
      // metadata that confuses JSZip's reader).
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      zip = await new JSZip().loadAsync(ab);
    } catch (e) {
      failures.push(`${name}: zip unpack failed (${e.message})`);
      continue;
    }
    const entry = zip.file('project.json');
    if (!entry) {
      failures.push(`${name}: project.json missing`);
      continue;
    }
    const text = await entry.async('string');
    for (const platform of ['scratch', 'turbowarp']) {
      try {
        sb3fix.fixJSON(text, { platform });
      } catch (e) {
        failures.push(`${name}: sb3fix(${platform}) rejected — ${e.message.slice(0, 400)}`);
      }
    }
  }
  return failures;
}

export async function ensureTestFixtures(options = {}) {
  const root = options.cwd ?? resolveRepoRoot();
  const outDir = resolve(root, 'test/.test-fixtures');
  mkdirSync(outDir, { recursive: true });

  const requested = options.only ?? DEFAULT_FIXTURES;
  const written = [];
  const skipped = [];
  for (const name of requested) {
    const gen = FIXTURE_GENERATORS[name];
    if (!gen) {
      skipped.push(name);
      continue;
    }
    const result = await gen();
    if (result) {
      // Generators that resolve to an absolute on-disk path confirm they
      // wrote the artifact themselves; otherwise they return undefined
      // and are expected to have written to a known location.
      written.push(name);
    } else {
      written.push(name);
    }
  }
  if (!options.skipSchemaValidate) {
    const failures = await validateFixtures(outDir, written);
    if (failures.length > 0) {
      const summary = failures.map((f) => `  - ${f}`).join('\n');
      throw new Error(
        `[ensure-test-fixtures] SB3 schema validation failed for ${failures.length} fixture(s):\n${summary}`,
      );
    }
  }
  return { outDir, written, skipped };
}

// CLI entry — runs only when invoked directly via `node ensure-test-fixtures.mjs`,
// not when imported by the test suite (matches the dual-mode pattern used by
// `scripts/apply-vendored-patches.mjs`).
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  ensureTestFixtures()
    .then(({ written }) => {
      // eslint-disable-next-line no-console
      console.log(
        `[ensure-test-fixtures] wrote ${written.length} fixture(s) to test/.test-fixtures/: ${written.join(', ')}`,
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[ensure-test-fixtures] FAILED:', err);
      process.exit(1);
    });
}

// pathToFileURL is referenced so this module imports the same way apply-vendored-patches
// does — keeps the dual-mode (CLI vs library) pattern uniform across scripts/.
// eslint-disable-next-line no-unused-expressions
pathToFileURL;
