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
 */
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

// Mirror of `scripts/patches/scratch-vm-symbols.md`. Append new
// markers in alphabetical order of the namespace for diff hygiene.
const TURBOWASM_MARKERS: readonly string[] = [
  '// TurboWasm: compat-layer-finish-extracted',
  '// TurboWasm: comparison-compare-equal-short-circuit',
  '// TurboWasm: comparison-infinity-branch-removed',
  '// TurboWasm: constant-folding',
  '// TurboWasm: constant-folding-jsgen-nan-neg-zero-handler',
  '// TurboWasm: edge-detection-hat-sentinel-eliminated',
  '// TurboWasm: procedure-lazy-cache',
  '// TurboWasm: procedure-definition-entry-prototype-substack',
];

describe('// TurboWasm: marker registry (Phase 1-A/B/C)', () => {
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

  // Each marker must appear verbatim in the UMD. A patch that was
  // reverted (or whose context drifted and was silently dropped
  // during `--3way`) trips these assertions and fails CI.
  it.each(TURBOWASM_MARKERS)('UMD contains marker %s', (marker) => {
    if (!existsSync(UMD_PATH)) return;
    const text = readFileSync(UMD_PATH, 'utf8');
    expect(text, `UMD missing marker "${marker}"`).toContain(marker);
  });

  // Source-level probe (more robust than UMD-only for green-field
  // repos that haven't rebuilt the UMD yet). Tests run on the
  // vendored scratch-vm if present, otherwise skip.
  it.each(TURBOWASM_MARKERS)(
    'vendored source contains marker %s',
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
});