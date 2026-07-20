import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const patchesDir = resolve(root, 'patches');
const scaffoldingDir = resolve(root, 'vendored', 'scaffolding');
const renderPkg = resolve(scaffoldingDir, 'node_modules', 'scratch-render', 'package.json');
const scratchRenderSrc = resolve(scaffoldingDir, 'node_modules', 'scratch-render', 'src');

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
 * times — `git apply --reverse --check --recount` is the primary "is this
 * patch already applied?" probe (status 0 means a clean reverse-apply
 * succeeds, which is true iff every hunk the patch defines is present in
 * the vendored source). When the reverse probe succeeds we mark the patch
 * as already-applied without re-touching the source.
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

    // 0. Probe with `git apply --reverse --check --recount`. The `--recount`
    //    flag re-derives hunk header line counts from the actual file
    //    content, and `--reverse --check` succeeds iff every change in the
    //    patch is currently present in the target tree. This is the most
    //    robust "is this patch applied?" detector we have: it works even
    //    when the source lacks our `// TurboWasm:` marker comments (e.g.
    //    a regenerated patch whose context shifted enough that marker-based
    //    detection returns false negatives), as long as the patch's own
    //    context matches reality.
    const reverseCheck = runGitApply(['apply', '--reverse', '--check', '--recount', '-p1', '-v', `../../patches/${patchFile}`], scaffoldingDir);
    if (reverseCheck.status === 0) {
      alreadyApplied.push(patchFile);
      log(`[apply-vendored-patches] ${patchFile} already applied; skipping.`);
      continue;
    }

    // 1. Fallback: marker-comment probe. Each patch introduces one or more
    //    unique `// TurboWasm:` annotations that survive file rewrites. If
    //    we can find every marker in the vendored source, the patch is
    //    effectively in place even though `git apply --reverse --check`
    //    disagrees (e.g. --recount failed on whitespace; or the patch was
    //    re-applied with --ignore-whitespace and the context bytes drift).
    //    Treat that as "already applied" to avoid corrupting the source.
    const patchSource = readFileSync(patchPath, 'utf8');
    const markers = extractUniqueMarkers(patchSource);
    if (markers.length > 0 && markers.every((m) => isMarkerInRenderSource(m))) {
      alreadyApplied.push(patchFile);
      log(
        `[apply-vendored-patches] ${patchFile} already applied (marker probe); skipping. ` +
          'Run `npm run apply:scratch-render-patch` only if `git apply --reverse --check` is also failing.',
      );
      continue;
    }

    // 2. Fresh apply. The forward `--check` is a strict superset of the
    //    reverse probe: we already know reverse failed, so a forward
    //    failure means the patch is genuinely out of date with the
    //    upstream source.
    const checkResult = runGitApply(['apply', '--check', '--recount', '-p1', '-v', `../../patches/${patchFile}`], scaffoldingDir);
    if (checkResult.status === 0) {
      const applyResult = runGitApply(['apply', '--recount', '-p1', `../../patches/${patchFile}`], scaffoldingDir);
      if (applyResult.status === 0) {
        applied.push(patchFile);
        log(`[apply-vendored-patches] applied ${patchFile}`);
      } else {
        failures.push({ patch: patchFile, reason: applyResult.stderr || applyResult.stdout });
        console.error(
          `[apply-vendored-patches] failed to apply ${patchFile}: ${applyResult.stderr || applyResult.stdout}`,
        );
      }
      continue;
    }

    const reason =
      `git apply --check failed:\n${checkResult.stderr || checkResult.stdout}\n` +
      `git apply --reverse --check failed:\n${reverseCheck.stderr || reverseCheck.stdout}\n` +
      'The vendored scratch-render was NOT patched. Common causes: malformed patch file ' +
      '(missing blank line between hunks, trailing newline, or out-of-date context), ' +
      'or a vendored scratch-render version that no longer matches the patch. ' +
      'Regenerate the patch (see scripts/regen-gpu-kernel-patches.mjs for GPU kernel patches; ' +
      'the wasm-collision-runtime patch is regenerated by hand against upstream ' +
      'TurboWarp/scaffolding@<SHA>).';
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
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number; stdout: string; stderr: string}}
 */
function runGitApply(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

/**
 * Extract unique marker comments from a patch file. We look for lines
 * inside `+` blocks that begin with `// TurboWasm:` — these are stable
 * annotations added by our patches and survive file rewrites.
 *
 * @param {string} patchText
 * @returns {string[]}
 */
export function extractUniqueMarkers(patchText) {
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
  if (!existsSync(scratchRenderSrc)) return false;
  // The wasm-collision-runtime patch carries hooks across RenderWebGL.js
  // and (historically) SVGSkin.js. Probe every JS file under
  // node_modules/scratch-render/src/ rather than hard-coding two filenames
  // so a future patch hunk landing in a new file doesn't false-negative
  // the marker check.
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
