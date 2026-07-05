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
 *     this script exits 0 with a hint. Re-run it once vendored deps are in
 *     place.
 *
 * Exit code:
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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const patchesDir = resolve(root, 'patches');
const scaffoldingDir = resolve(root, 'vendored', 'scaffolding');
const renderPkg = resolve(scaffoldingDir, 'node_modules', 'scratch-render', 'package.json');

if (process.env.SKIP_VENDORED_PATCHES && process.env.SKIP_VENDORED_PATCHES !== '0') {
  console.warn('[apply-vendored-patches] SKIP_VENDORED_PATCHES is set; skipping.');
  process.exit(0);
}

if (!existsSync(renderPkg)) {
  console.warn(
    '[apply-vendored-patches] vendored/scaffolding/node_modules/scratch-render not installed; skipping.\n' +
      '                Run `cd vendored/scaffolding && npm install`, then re-run `npm run apply:scratch-render-patch`.',
  );
  process.exit(0);
}

const PATCH_FILES = [
  'scratch-render+0.1.0.patch',
  'wasm-collision-runtime+0.1.0.patch',
];

let failures = 0;
for (const patchFile of PATCH_FILES) {
  const patchPath = resolve(patchesDir, patchFile);
  if (!existsSync(patchPath)) {
    console.warn(`[apply-vendored-patches] patch file not found, skipping: ${patchFile}`);
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
      console.log(`[apply-vendored-patches] applied ${patchFile}`);
    } else {
      console.error(`[apply-vendored-patches] failed to apply ${patchFile}: ${applyResult.stderr}`);
      failures += 1;
    }
    continue;
  }

  // 2b. Patch does not apply → check whether the patch is already applied.
  // We grep for a unique marker comment inside each patched file. If found,
  // the patch is already in place and the apply error is benign.
  const patchSource = readFileSync(patchPath, 'utf8');
  const markers = extractUniqueMarkers(patchSource);
  if (markers.length === 0) {
    console.warn(
      `[apply-vendored-patches] ${patchFile} does not apply and no marker comment found; ` +
        'treating as already-applied (best-effort).',
    );
    continue;
  }

  const allMarkersPresent = markers.every((m) => isMarkerInRenderSource(m));
  if (allMarkersPresent) {
    console.log(`[apply-vendored-patches] ${patchFile} already applied; skipping.`);
    continue;
  }

  console.error(
    `[apply-vendored-patches] failed to apply ${patchFile}:\n${checkResult.stderr}\n` +
      'The vendored scratch-render was NOT patched. Common causes: malformed patch file ' +
      '(missing blank line between hunks, trailing newline, or out-of-date context), ' +
      'or a vendored scratch-render version that no longer matches the patch.',
  );
  failures += 1;
}

if (failures > 0) {
  process.exit(1);
}

console.log('[apply-vendored-patches] vendored scratch-render patches applied.');

/**
 * Extract unique marker comments from a patch file. We look for lines
 * inside `+` blocks that begin with `// TurboWasm:` — these are stable
 * annotations added by our patches and survive file rewrites.
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

function isMarkerInRenderSource(marker) {
  const candidates = [
    resolve(scaffoldingDir, 'node_modules/scratch-render/src/RenderWebGL.js'),
    resolve(scaffoldingDir, 'node_modules/scratch-render/src/PenSkin.js'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(marker)) return true;
  }
  return false;
}
