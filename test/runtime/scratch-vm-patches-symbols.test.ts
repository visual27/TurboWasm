import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0+ — Marker registry for vendored scratch-vm patches. Each
 * row in `scripts/patches/scratch-vm-symbols.md` is mirrored here
 * so a marker removed from the source code (= patch reverted) fails
 * CI without requiring the maintainer to remember to update both
 * files in lockstep.
 *
 * The vendored UMD is the canonical place to look for markers
 * because Vite loads `vendored/scaffolding/dist/scaffolding-min.js`
 * via `resolve.alias['@turbowarp/scaffolding']`, NOT the source
 * files in `vendored/scaffolding/node_modules/scratch-vm/src/`.
 * Patches that only land on the source files are silently ignored
 * at runtime — see `test/runtime/scratch-render-patches.test.ts`
 * for the parallel ImageData-guards pattern.
 *
 * Phase 1-A / 1-B / 1-C ship the first three markers. Future Phases
 * append their markers here AND to the markdown registry in the
 * same commit.
 *
 * §Phase 5 introduced a new category: `REFERENCE_ONLY_MARKERS`.
 * Those live in `patches/vendored/scratch-vm-eval-scheduler-*.patch`
 * but are NOT applied to the vendored scratch-vm source by
 * `npm run setup`. The benchmark harness `scripts/bench-scheduler-
 * eval.mjs` evaluates each variant via runtime monkey-patching, so
 * the patches serve as reference documentation and the marker drift
 * detection only checks the patch-file probe for them — the UMD
 * and source probes would otherwise false-fail. See
 * `scripts/patches/scratch-vm-symbols.md` for the registry and
 * `C:/files/memo/scratch-vm-optimization/phase-05-scheduler-analysis.md`
 * for the verdict.
 */
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

// Applied markers — checked in UMD AND vendored source. Mirrors the
// rows of `scripts/patches/scratch-vm-symbols.md` whose Phase is not
// "research-only / reference". Append in alphabetical order of the
// namespace for diff hygiene.
const APPLIED_MARKERS: readonly string[] = [
  '// TurboWasm: blocks-cache-map',
  '// TurboWasm: branch-info-pool',
  '// TurboWasm: compat-layer-finish-extracted',
  '// TurboWasm: comparison-compare-equal-short-circuit',
  '// TurboWasm: comparison-infinity-branch-removed',
  '// TurboWasm: constant-folding',
  '// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler',
  '// TurboWasm: edge-detection-hat-sentinel-eliminated',
  '// TurboWasm: list / scalar buffer accessors',
  '// TurboWasm: procedure-lazy-cache',
  '// TurboWasm: procedure-definition-entry-prototype-substack',
  '// TurboWasm: semantics-compiler-options',
  // §Phase 8-A — truncated modulo (= JS `%` instead of Scratch
  // floored modulo). Wired in `jsgen.js:OP_MOD` (compiled) +
  // `scratch3_operators.js:mod` (interpreter). Both markers live in
  // `patches/vendored/scratch-vm.patch` and ship in the UMD.
  '// TurboWasm: truncated-modulo',
  '// TurboWasm: truncated-modulo-interpreter',
  // §Phase 9-A — strict numeric equality. Type-mixed comparisons return
  // a non-zero value (= never equal). Wired across 6 files:
  //   - `cast.js:compare` (interpreter path; signature gains `strictEqual`)
  //   - `jsexecute.js` (compareEqual / compareGreaterThan / compareLessThan
  //     + the existing `compareContains` helper, all gated by the
  //     captured `__semantics.strictNumericEquality`)
  //   - `scratch3_operators.js` (equals / lt / gt / contains — thread
  //     the `Cast.compare` 4-arg form through the interpreter path)
  //   - `scratch3_data.js` (listContainsItem / getItemNumOfList — same
  //     4-arg threading)
  //   - `iroptimizer.js:foldCompare` (constant-fold path must agree
  //     with the runtime helpers or folded comparisons would diverge
  //     from the runtime when the user flips the toggle)
  //   - `runtime.js` (no source change — `compilerOptions.semantics`
  //     was already seeded with `strictNumericEquality: false` in
  //     §Phase 7, so the gate key is purely a runtime read).
  // All markers in this row share the same `// TurboWasm: strict-numeric-equality`
  // name (= verified by the source-level regex).
  '// TurboWasm: strict-numeric-equality',
  // §Phase 8-B — case-sensitive strings. Wired across 5 files:
  //   - `jsgen.js:OP_CONTAINS` (compiled emit delegates to helper)
  //   - `jsexecute.js` (compare family + new `compareContains` helper,
  //     plus a `__semantics` capture in `baseRuntime`)
  //   - `cast.js:compare` (signature accepts `caseSensitive`)
  //   - `scratch3_operators.js:contains` (interpreter path)
  //   - `scratch3_data.js` (`listContainsItem` / `getItemNumOfList`)
  // All markers in this row share the same `// TurboWasm: case-sensitive-strings`
  // name (= verified by the source-level regex; the patch may be split
  // across multiple `+` blocks in `patches/vendored/scratch-vm.patch`).
  '// TurboWasm: case-sensitive-strings',
];

// Reference-only markers — checked in `patches/vendored/*.patch` ONLY.
// These markers document alternative compaction strategies that are
// not currently applied. The benchmark harness monkey-patches the
// vendored scratch-vm at runtime to evaluate them.
const REFERENCE_ONLY_MARKERS: readonly string[] = [
  '// TurboWasm: scheduler-eval-A',
  '// TurboWasm: scheduler-eval-B',
  // §Phase 6 (generator research). The benchmark harness
  // `scripts/bench-generator-eval.mjs` exposes `installVariantX` /
  // `installVariantY` (pure-interval extraction prototype + two-tier
  // emit prototype) via runtime monkey-patching against a temp copy
  // of the vendored scratch-vm. Both variants are pure telemetry —
  // they do not modify the emitted source, so the UMD / source probes
  // explicitly skip them.
  '// TurboWasm: generator-eval-X',
  '// TurboWasm: generator-eval-Y',
];

// Union for the patch-file probe (= every marker must land in
// either UMD/source or the patch file).
const TURBOWASM_MARKERS: readonly string[] = [
  ...APPLIED_MARKERS,
  ...REFERENCE_ONLY_MARKERS,
];

describe('// TurboWasm: marker registry (Phase 1+ / Phase 4)', () => {
  it('the vendored scaffolding UMD exists (npm run setup has run)', () => {
    if (!existsSync(UMD_PATH)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[scratch-vm-patches-symbols] UMD missing; marker probe skipped. ' +
          'Run `npm run setup` to regenerate vendored/.',
      );
      return;
    }
    expect(existsSync(UMD_PATH)).toBe(true);
  });

  // Applied markers must appear verbatim in the UMD. A patch that
  // was reverted (or whose context drifted and was silently dropped
  // during `--3way`) trips these assertions and fails CI. Reference-
  // only markers are explicitly skipped here because they live in
  // `patches/vendored/*.patch` only.
  it.each(APPLIED_MARKERS)('UMD contains applied marker %s', (marker) => {
    if (!existsSync(UMD_PATH)) return;
    const text = readFileSync(UMD_PATH, 'utf8');
    expect(text, `UMD missing marker "${marker}"`).toContain(marker);
  });

  // Source-level probe (more robust than UMD-only for green-field
  // repos that haven't rebuilt the UMD yet). Tests run on the
  // vendored scratch-vm if present, otherwise skip.
  it.each(APPLIED_MARKERS)(
    'vendored source contains applied marker %s',
    (marker) => {
      const srcDir = resolve(process.cwd(), 'vendored/scratch-vm/src');
      if (!existsSync(srcDir)) return;
      const stack: string[] = [srcDir];
      let found = false;
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = resolve(dir, entry.name);
          if (entry.isDirectory()) stack.push(p);
          else if (entry.isFile() && p.endsWith('.js')) {
            if (readFileSync(p, 'utf8').includes(marker)) {
              found = true;
              break;
            }
          }
        }
        if (found) break;
      }
      expect(found, `vendored source missing marker "${marker}"`).toBe(true);
    },
  );

  // Patch-file probe — covers both applied and reference-only
  // markers. The `+` lines in `patches/vendored/*.patch` are
  // already extracted at apply time by `apply-vendored-patches.mjs:
  // extractUniqueMarkers`, so this probe matches that pattern.
  it.each(TURBOWASM_MARKERS)(
    'patches/vendored/*.patch contains marker %s',
    (marker) => {
      const patchesDir = resolve(process.cwd(), 'patches/vendored');
      if (!existsSync(patchesDir)) return;
      let found = false;
      for (const entry of readdirSync(patchesDir)) {
        if (!entry.endsWith('.patch')) continue;
        const p = resolve(patchesDir, entry);
        if (readFileSync(p, 'utf8').includes(marker)) {
          found = true;
          break;
        }
      }
      expect(
        found,
        `patches/vendored/*.patch missing marker "${marker}"`,
      ).toBe(true);
    },
  );
});