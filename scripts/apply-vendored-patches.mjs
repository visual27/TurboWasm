#!/usr/bin/env node
/**
 * Reapply the vendored scratch-render patches after `npm install`.
 *
 * The vendored scratch-vm and scratch-render are tracked outside the main
 * dependency tree (see vendored/ in .gitignore). We carry two patch sets:
 *
 *   1. `patches/scratch-render+0.1.0.patch` and
 *      `patches/wasm-collision-runtime+0.1.0.patch` target
 *      `vendored/scaffolding/node_modules/scratch-render`. The
 *      scratch-render patch adds two guards against a
 *      `Failed to construct 'ImageData': The source height is zero or not a
 *      number` DOMException that aborts loadProject() when a custom extension
 *      drives the stage size to 0 during load. The wasm-collision patch
 *      installs optional TurboWasm SIMD hooks in `isTouchingColor` and
 *      `isTouchingDrawables`.
 *
 *   2. The `patches/vendored/*` patches are applied to the vendored
 *      scaffolding / scratch-vm sources via `git apply` inside
 *      `npm run setup`, not here.
 *
 * Patch application policy:
 *   - The patches are applied via `git apply --check` first; if the source
 *     already has the patch (as is the case after `npm run setup` has
 *     pre-patched the vendored tree), `git apply --check` fails and we
 *     consider the patch already applied.
 *   - The vendored scratch-render patch in `patches/scratch-render+0.1.0.patch`
 *     predates patch-package's stricter `verifyHunkIntegrity` parser and
 *     fails to parse under patch-package 8.x. We work around this by
 *     applying patches with `git apply --recount` instead of patch-package,
 *     which tolerates already-applied context.
 *
 * Behavior:
 *   - If vendored/scaffolding/node_modules/scratch-render is not installed
 *     yet (e.g. the user has not run `cd vendored/scaffolding && npm install`),
 *     applyPatches() returns `{ status: 'skipped', reason: 'no-render' }` and
 *     exits 0. Callers should re-run once vendored deps are in place.
 *   - Can be imported from another ESM script via
 *     `import { applyPatches } from './apply-vendored-patches.mjs'`. The
 *     standalone `node scripts/apply-vendored-patches.mjs` invocation runs
 *     `applyPatches({ exitOnComplete: true })` so postinstall / cron /
 *     manual use stays in sync with the import path.
 *
 * Exit code (standalone invocation only):
 *   - 0 on success (all patches applied or already-applied)
 *   - non-zero (postinstall propagates) only if a patch actually fails to
 *     apply to a fresh tree. patch-package's stricter parser is bypassed.
 *
 * Escape hatch:
 *   - Set `SKIP_VENDORED_PATCHES=1` (or any non-empty value) to opt out.
 *     Useful for `npm install --ignore-scripts` users who manually manage
 *     the vendored tree.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const patchesDir = resolve(root, 'patches');
const scaffoldingDir = resolve(root, 'vendored', 'scaffolding');
const renderPkg = resolve(scaffoldingDir, 'node_modules', 'scratch-render', 'package.json');

const PATCH_FILES = [
  'scratch-render+0.1.0.patch',
  'wasm-collision-runtime+0.1.0.patch',
];

/**
 * @typedef {{ status: 'ok', applied: string[], alreadyApplied: string[] }} ApplyOk
 * @typedef {{ status: 'skipped', reason: 'env' | 'no-render' }} ApplySkipped
 * @typedef {{ status: 'failed', failures: { patch: string, reason: string }[] }} ApplyFailed
 * @typedef {ApplyOk | ApplySkipped | ApplyFailed} ApplyPatchesResult
 */

/**
 * @typedef {Object} ApplyPatchesOptions
 * @property {boolean} [exitOnComplete] When `true` (the standalone default),
 *   print status to stdout and exit the process with non-zero status on
 *   failure. Library callers should pass `false`.
 * @property {boolean} [verbose] When `true` (default), log a one-line
 *   summary per patch.
 */

/**
 * Idempotently apply all vendored scratch-render patches. Safe to call many
 * times — the marker-comment based detection skips patches that are already
 * applied.
 *
 * Returns a structured result rather than throwing, so library callers can
 * decide what to do with failures (e.g. abort the setup script vs. fall
 * back to a known-good UMD).
 *
 * @param {ApplyPatchesOptions} [options]
 * @returns {ApplyPatchesResult}
 */
export function applyPatches(options = {}) {
  const exitOnComplete = options.exitOnComplete ?? false;
  const verbose = options.verbose ?? true;
  const log = (msg) => {
    if (verbose) console.log(msg);
  };

  if (process.env.SKIP_VENDORED_PATCHES && process.env.SKIP_VENDORED_PATCHES !== '0') {
    log('[apply-vendored-patches] SKIP_VENDORED_PATCHES is set; skipping.');
    if (exitOnComplete) process.exit(0);
    return { status: 'skipped', reason: 'env' };
  }

  if (!existsSync(renderPkg)) {
    log(
      '[apply-vendored-patches] vendored/scaffolding/node_modules/scratch-render not installed; skipping.\n' +
        '                Run `cd vendored/scaffolding && npm install`, then re-run `npm run apply:scratch-render-patch`.',
    );
    if (exitOnComplete) process.exit(0);
    return { status: 'skipped', reason: 'no-render' };
  }

  const applied = [];
  const alreadyApplied = [];
  /** @type {{ patch: string, reason: string }[]} */
  const failures = [];

  for (const patchFile of PATCH_FILES) {
    const patchPath = resolve(patchesDir, patchFile);
    if (!existsSync(patchPath)) {
      log(`[apply-vendored-patches] patch file not found, skipping: ${patchFile}`);
      continue;
    }

    // 1. Probe with `git apply --check --recount` (tolerant of already-applied context).
    const checkResult = spawnSync(
      'git',
      ['apply', '--check', '--recount', '-p1', '-v', `../../patches/${patchFile}`],
      { cwd: scaffoldingDir, encoding: 'utf8', shell: false },
    );

    if (checkResult.status === 0) {
      // 2a. Patch applies cleanly → actually apply it.
      const applyResult = spawnSync(
        'git',
        ['apply', '--recount', '-p1', `../../patches/${patchFile}`],
        { cwd: scaffoldingDir, encoding: 'utf8', shell: false },
      );
      if (applyResult.status === 0) {
        applied.push(patchFile);
        log(`[apply-vendored-patches] applied ${patchFile}`);
      } else {
        failures.push({ patch: patchFile, reason: applyResult.stderr });
        console.error(
          `[apply-vendored-patches] failed to apply ${patchFile}: ${applyResult.stderr}`,
        );
      }
      continue;
    }

    // 2b. Patch does not apply → check whether the patch is already applied.
    // We grep for a unique marker comment inside each patched file. If found,
    // the patch is already in place and the apply error is benign.
    const patchSource = readFileSync(patchPath, 'utf8');
    const markers = extractUniqueMarkers(patchSource);
    if (markers.length === 0) {
      log(
        `[apply-vendored-patches] ${patchFile} does not apply and no marker comment found; ` +
          'treating as already-applied (best-effort).',
      );
      alreadyApplied.push(patchFile);
      continue;
    }

    if (markers.every((m) => isMarkerInRenderSource(m))) {
      alreadyApplied.push(patchFile);
      log(`[apply-vendored-patches] ${patchFile} already applied; skipping.`);
      continue;
    }

    const reason =
      `git apply --check failed:\n${checkResult.stderr}\n` +
      'The vendored scratch-render was NOT patched. Common causes: malformed patch file ' +
      '(missing blank line between hunks, trailing newline, or out-of-date context), ' +
      'or a vendored scratch-render version that no longer matches the patch.';
    failures.push({ patch: patchFile, reason });
    console.error(`[apply-vendored-patches] failed to apply ${patchFile}:\n${reason}`);
  }

  if (failures.length > 0) {
    if (exitOnComplete) process.exit(1);
    return { status: 'failed', failures };
  }

  log('[apply-vendored-patches] vendored scratch-render patches applied.');
  if (exitOnComplete) process.exit(0);
  return { status: 'ok', applied, alreadyApplied };
}

/**
 * Extract unique marker comments from a patch file. We look for lines
 * inside `+` blocks that begin with `// TurboWasm:` — these are stable
 * annotations added by our patches and survive file rewrites.
 *
 * @param {string} patchText
 * @returns {string[]}
 */
function extractUniqueMarkers(patchText) {
  const lines = patchText.split('\n');
  const markers = new Set();
  for (const line of lines) {
    if (!line.startsWith('+')) continue;
    const trimmed = line.slice(1).trim();
    if (trimmed.startsWith('// TurboWasm:')) {
      markers.add(trimmed);
    }
  }
  return Array.from(markers);
}

/**
 * @param {string} marker
 * @returns {boolean}
 */
function isMarkerInRenderSource(marker) {
  // The wasm-collision-runtime patch carries hooks across RenderWebGL.js
  // AND SVGSkin.js, plus other source files that may be added later. Probe
  // every JS file under node_modules/scratch-render/src/ rather than
  // hard-coding two filenames so a future patch hunk landing in a new
  // file doesn't false-negative the marker check.
  const scratchRenderSrc = resolve(scaffoldingDir, 'node_modules', 'scratch-render', 'src');
  const candidates = [
    resolve(scratchRenderSrc, 'RenderWebGL.js'),
    resolve(scratchRenderSrc, 'PenSkin.js'),
    resolve(scratchRenderSrc, 'SVGSkin.js'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(marker)) return true;
  }
  return false;
}

// Standalone CLI entrypoint: when this file is invoked directly via `node
// scripts/apply-vendored-patches.mjs`, run the patches with exitOnComplete so
// the postinstall hook / cron use-case gets the original non-zero exit on
// failure. When the file is imported by another ESM module, the function is
// available but never auto-invoked.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  applyPatches({ exitOnComplete: true });
}
