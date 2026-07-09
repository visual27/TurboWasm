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
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
