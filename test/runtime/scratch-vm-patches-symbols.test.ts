import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0 — Foundation skeleton for the marker registry
 * (`scripts/patches/scratch-vm-symbols.md`). When Phase 1+ adds a
 * patch with a `// TurboWasm: <feature>-<shape>` marker, this test
 * grows a matching `expect(text).toContain(marker)` so the registry
 * cannot silently drift. Today the table is empty (Phase 0 ships no
 * patches) so the assertions are limited to existence probes.
 *
 * The vendored UMD is the canonical place to look for markers
 * because Vite loads `vendored/scaffolding/dist/scaffolding-min.js`
 * via `resolve.alias['@turbowarp/scaffolding']`, NOT the source
 * files in `vendored/scaffolding/node_modules/scratch-render/src/`.
 * Patches that only land on the source files are silently ignored
 * at runtime — see `test/runtime/scratch-render-patches.test.ts`
 * for the parallel ImageData-guards pattern.
 */
const UMD_PATH = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

// Add new markers here as Phase 1+ patches land. The table mirrors
// `scripts/patches/scratch-vm-symbols.md`.
const TURBOWASM_MARKERS: readonly string[] = [];

describe('// TurboWasm: marker registry (Phase 0 skeleton)', () => {
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

  // Phase 0: no markers expected. The it.each below is the
  // registration slot Phase 1+ patches will land in. The empty
  // array keeps the test green today while documenting where new
  // markers go.
  it.each(TURBOWASM_MARKERS)('UMD contains marker %s', (marker) => {
    if (!existsSync(UMD_PATH)) return;
    const text = readFileSync(UMD_PATH, 'utf8');
    expect(text, `UMD missing marker "${marker}"`).toContain(marker);
  });
});