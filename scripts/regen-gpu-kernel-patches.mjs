/**
 * Regenerate patches/vendored/gpu-kernel-list-binding+0.1.0.patch
 * and patches/vendored/gpu-kernel-runtime+0.1.0.patch from scratch.
 *
 * The regenerated patches are produced against the vendored scratch-vm
 * state of (upstream TurboWarp/scratch-vm at SCRATCH_VM_BASE_REF) +
 * (patches/vendored/scratch-vm.patch). The hunk headers and the
 * `index <blob>..<blob>` line are recomputed from the actual file
 * contents so the output applies cleanly with `git apply` (no
 * `--recount` workaround needed).
 *
 * This script is self-contained: it always clones a fresh scratch-vm
 * at the pinned SHA into a temp directory, applies scratch-vm.patch
 * to obtain the pre-patch state, and uses the *existing* patch files
 * as the source of truth for the post-patch state. The previous
 * regen-gpu-kernel-patches.mjs read the post-patch state from
 * vendored/scratch-vm/, which only happened to be correct when both
 * GPU kernel patches had already been applied — that assumption broke
 * after the list-binding patch began failing on a fresh clone, so the
 * regen produced patches that could not be applied either.
 *
 * Inputs (post-patch state, in order of preference):
 *   1. --runtime-patched <path> / --control-patched <path> flags
 *   2. vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js
 *      vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_control.js
 *      (these are the working tree state at the time the GPU kernel
 *      patches last applied cleanly; an authoritative copy lives here)
 *   3. If neither is available, fall back to a manual reconstruction
 *      from the existing patch's `+` lines (parses the existing patch,
 *      finds the context anchor in the pre-patch source, and inserts
 *      the additions at the hunk's `-` start position). This is the
 *      last-resort path that lets the script work even when no
 *      previously-built UMD is available.
 *
 * Outputs:
 *   - patches/vendored/gpu-kernel-list-binding+0.1.0.patch
 *   - patches/vendored/gpu-kernel-runtime+0.1.0.patch
 *
 * Verification (mandatory before exit 0):
 *   - `git apply --check -p1` on each regenerated patch (no --recount).
 *     Any failure aborts with a non-zero status; the patches are NOT
 *     written in that case (writes happen only after both verifications
 *     pass on a fresh temp clone).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const SCRATCH_VM_REPO = 'https://github.com/TurboWarp/scratch-vm.git';
// Pin per AGENTS.md "SCRATCH_VM_REF の pin（必須）". The
// vendored/scaffolding bootstrap reads the same pin, so the temp
// clone and the eventual `npm run setup` build always match.
const SCRATCH_VM_BASE_REF = '925f1134001ada36572eeb35f9d83ba01c98081a';

const SCRATCH_VM_PATCH = resolve(root, 'patches/vendored/scratch-vm.patch');
const LIST_BINDING_PATCH = resolve(root, 'patches/vendored/gpu-kernel-list-binding+0.1.0.patch');
const RUNTIME_PATCH = resolve(root, 'patches/vendored/gpu-kernel-runtime+0.1.0.patch');

const SCAFFOLDING_MIRRORED_RUNTIME = resolve(
  root,
  'vendored/scaffolding/node_modules/scratch-vm/src/engine/runtime.js',
);
const SCAFFOLDING_MIRRORED_CONTROL = resolve(
  root,
  'vendored/scaffolding/node_modules/scratch-vm/src/blocks/scratch3_control.js',
);

const TMP_ROOT = resolve(tmpdir(), 'opencode', 'turbowasm-patchgen');

function log(msg) {
  console.log('[regen-gpu-patches] ' + msg);
}

function die(msg, err) {
  console.error('[regen-gpu-patches] FATAL: ' + msg);
  if (err) console.error(err.stack || String(err));
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    const stderr = result.stderr || result.stdout || '';
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}\n${stderr}`);
  }
  return result;
}

function runCapture(cmd, args, opts = {}) {
  return run(cmd, args, { ...opts });
}

function gitBlobHash(buffer) {
  // git blob hash = sha1("blob " + length + "\0" + content)
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, buffer])).digest('hex');
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i += 1;
        } else {
          out[a.slice(2)] = true;
        }
      }
    }
  }
  return out;
}

function setupBaseClone() {
  // Always start from a clean temp dir; we never want a stale probe
  // interfering with regeneration. AGENTS.md "完全にクリーンな状態"
  // — this includes the script's own scratch area.
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
  log(`Cloning scratch-vm into ${TMP_ROOT}`);
  run('git', ['clone', SCRATCH_VM_REPO, TMP_ROOT]);
  run('git', ['checkout', SCRATCH_VM_BASE_REF], { cwd: TMP_ROOT });
  // Disable autocrlf so the temp clone uses LF (matches the patches
  // generated on Linux/macOS and prevents Windows from re-introducing
  // CRLF mismatches during the git diff round-trip).
  run('git', ['config', 'core.autocrlf', 'false'], { cwd: TMP_ROOT });
  // Disable the Windows `astextplain` diff driver that would corrupt
  // multi-byte UTF-8 bytes (e.g. `§`) in `git diff` output.
  const cfgPath = resolve(TMP_ROOT, '.git', 'config');
  const cfg = readFileSync(cfgPath, 'utf8');
  if (!cfg.includes('[diff "noencoding"]')) {
    const append = [
      '',
      '[diff "noencoding"]',
      '\ttextconv = cat',
      '\tbinary = false',
    ].join('\n');
    writeFileSync(cfgPath, cfg + append);
  }
  const attrPath = resolve(TMP_ROOT, '.gitattributes');
  writeFileSync(
    attrPath,
    ['src/engine/runtime.js -text', 'src/blocks/scratch3_control.js -text'].join('\n') + '\n',
  );
}

function applyScratchVmPatch() {
  log('Applying scratch-vm.patch to base clone');
  run('git', ['apply', '--3way', '--ignore-whitespace', SCRATCH_VM_PATCH], { cwd: TMP_ROOT });
}

/**
 * Parse a unified-diff patch file into structured hunks.
 *
 * Returns:
 *   {
 *     headerLines: [...],          // diff --git / index / --- / +++
 *     filePath: 'src/...',         // the b/ path
 *     oldBlob: '<sha-hex>',        // from the index line (may be missing)
 *     newBlob: '<sha-hex>',
 *     hunks: [
 *       {
 *         origStart, origCount, newStart, newCount,
 *         contextBefore, // leading context lines (text)
 *         contextAfter,  // trailing context lines (text)
 *         removed,       // ['- line', ...]
 *         added,         // ['+ line', ...]
 *         rawLines,      // original body lines (with leading ' ', '+', '-')
 *       },
 *       ...
 *     ],
 *   }
 */
function parsePatch(patchPath) {
  const text = readFileSync(patchPath, 'utf8');
  const lines = text.split('\n');
  const result = {
    headerLines: [],
    filePath: '',
    oldBlob: '',
    newBlob: '',
    hunks: [],
  };
  let i = 0;

  // Header: diff --git a/X b/X
  while (i < lines.length && !lines[i].startsWith('@@')) {
    const line = lines[i];
    result.headerLines.push(line);
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) result.filePath = m[2];
    } else if (line.startsWith('index ')) {
      const m = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/);
      if (m) {
        result.oldBlob = m[1];
        result.newBlob = m[2];
      }
    } else if (line.startsWith('--- ')) {
      // ignore
    } else if (line.startsWith('+++ ')) {
      // ignore
    }
    i += 1;
  }

  // Hunks
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('@@')) break;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      // Malformed hunk header — surface the raw line to help diagnose.
      throw new Error(`[regen-gpu-patches] malformed hunk header in ${patchPath}:\n  ${line}`);
    }
    const hunk = {
      origStart: parseInt(m[1], 10),
      origCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
      newStart: parseInt(m[3], 10),
      newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
      contextBefore: [],
      contextAfter: [],
      removed: [],
      added: [],
      rawLines: [line],
    };
    i += 1;
    // Hunk body: leading context, then alternating (remove, add) /
    // add blocks, then trailing context. We split on the run of `-`
    // and `+` lines, but keep the raw line order for the rebuilt
    // patch.
    let bodyLines = [];
    while (i < lines.length && !lines[i].startsWith('@@') && lines[i] !== '\\ No newline at end of file') {
      bodyLines.push(lines[i]);
      i += 1;
    }
    // Classify each body line.
    for (const bl of bodyLines) {
      if (bl.startsWith('-')) {
        hunk.removed.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        hunk.added.push(bl.slice(1));
      } else {
        // Context line: leading ' ' (may be an empty context line that
        // is just a single space, or a normal context line). When the
        // hunk has both - and + blocks, we split the context into
        // `contextBefore` (before the first - or +) and `contextAfter`
        // (after the last - or +). When the hunk is purely additive
        // (no - lines), everything is `contextBefore` so the rebuilt
        // diff keeps the order intact.
        hunk.contextBefore.push(bl.slice(1));
      }
    }
    // Split contextBefore/After: find the index of the first non-context
    // line in the raw body and use that to slice.
    let firstNonCtx = bodyLines.findIndex((l) => l.startsWith('-') || l.startsWith('+'));
    if (firstNonCtx < 0) {
      // Pure context (unusual but possible if the patch is a no-op
      // around added lines elsewhere). Leave everything in
      // contextBefore.
      firstNonCtx = bodyLines.length;
    }
    const before = bodyLines.slice(0, firstNonCtx).map((l) => (l.startsWith(' ') ? l.slice(1) : l));
    // After-part: starts after the last add line.
    let lastAddOrRemove = -1;
    for (let j = bodyLines.length - 1; j >= 0; j -= 1) {
      if (bodyLines[j].startsWith('-') || bodyLines[j].startsWith('+')) {
        lastAddOrRemove = j;
        break;
      }
    }
    const after = lastAddOrRemove >= 0 ? bodyLines.slice(lastAddOrRemove + 1).map((l) => (l.startsWith(' ') ? l.slice(1) : l)) : [];
    hunk.contextBefore = before;
    hunk.contextAfter = after;
    hunk.rawLines = hunk.rawLines.concat(bodyLines);
    result.hunks.push(hunk);
  }

  return result;
}

/**
 * Manually apply a parsed patch's hunks to a source string. This is
 * the last-resort path used when `git apply` cannot match the
 * existing patch's context (e.g. upstream added new code between
 * context lines). The algorithm:
 *
 *   For each hunk:
 *     1. Find the position in the source where the contextBefore lines
 *        are followed by the removed lines (or, if there are no
 *        removed lines, just the contextBefore lines). We search for
 *        the first occurrence of contextBefore[0] in the source; if
 *        that doesn't anchor, scan forward.
 *     2. Verify the next len(contextBefore) + len(removed) lines
 *        match. If not, the patch is genuinely incompatible — abort
 *        with a clear diagnostic.
 *     3. Splice in the contextBefore + added + contextAfter lines in
 *        place of the matched range.
 *     4. Track the line offset so subsequent hunks apply to the
 *        post-edit source.
 *
 * Returns the new source string.
 */
function applyHunksManually(source, hunks) {
  let lines = source.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    // `split('\n')` on a trailing-newline file leaves a final empty
    // element. Drop it so line numbers line up with `wc -l` counts.
    lines.pop();
  }
  let offset = 0;

  for (const hunk of hunks) {
    const origStart = hunk.origStart - 1; // 0-indexed
    const anchor = origStart + offset;
    const ctxBefore = hunk.contextBefore;
    const removed = hunk.removed;
    const added = hunk.added;
    const ctxAfter = hunk.contextAfter;

    // Find the actual insertion position. Try the recorded anchor
    // first; if it doesn't match, search forward for the first
    // matching line.
    let insertAt = -1;
    if (ctxBefore.length === 0 && removed.length === 0) {
      // Pure insertion with no anchor context: insert at the
      // hunk's recorded `origStart` position (which is the line
      // BEFORE which to insert).
      insertAt = anchor;
    } else {
      // Search forward for a window matching the contextBefore
      // (followed by the removed lines, if any). The match position
      // is the start of the `contextBefore` block in the source.
      const start = Math.max(0, anchor - 4);
      const end = Math.min(lines.length, anchor + ctxBefore.length + removed.length + 4);
      for (let pos = start; pos <= end; pos += 1) {
        if (pos + ctxBefore.length + removed.length > lines.length) break;
        let ok = true;
        for (let k = 0; k < ctxBefore.length; k += 1) {
          if (lines[pos + k] !== ctxBefore[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        for (let k = 0; k < removed.length; k += 1) {
          if (lines[pos + ctxBefore.length + k] !== removed[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          insertAt = pos;
          break;
        }
      }
      if (insertAt < 0) {
        const sample = lines.slice(anchor, Math.min(lines.length, anchor + 10)).join('\n');
        throw new Error(
          `[regen-gpu-patches] could not anchor hunk at origStart=${hunk.origStart}\n` +
            `  contextBefore: ${JSON.stringify(ctxBefore.slice(0, 3))}\n` +
            `  removed: ${JSON.stringify(removed.slice(0, 3))}\n` +
            `  expected around line ${anchor + 1}:\n${sample}`,
        );
      }
    }

    // Splice. The semantics depend on whether removed lines exist:
    //   - removed.length > 0: this is a real replacement. The
    //     `contextBefore + removed` window in the source is replaced
    //     by `contextBefore + added + contextAfter`.
    //   - removed.length === 0: this is a pure insertion. The
    //     `contextBefore` lines stay where they are, and the
    //     `added` (+ optional contextAfter) lines are inserted
    //     immediately after the last contextBefore line. The
    //     recorded `contextAfter` (if any) is already part of the
    //     source right after the contextBefore; we must NOT
    //     re-emit it (it would duplicate).
    if (removed.length > 0) {
      const removalLen = ctxBefore.length + removed.length;
      const insertion = [...ctxBefore, ...added, ...ctxAfter];
      lines.splice(insertAt, removalLen, ...insertion);
      offset += insertion.length - removalLen;
    } else {
      // Pure addition: keep contextBefore as-is, insert `added`
      // after it. The trailing `contextAfter` is *already* in the
      // source (since removed was 0) — re-emitting it would
      // duplicate, so we drop it from the splice.
      const insertPos = insertAt + ctxBefore.length;
      lines.splice(insertPos, 0, ...added);
      offset += added.length;
    }
  }

  return lines.join('\n') + '\n';
}

function reconstructPostPatchFromPatch(parsed, preSource) {
  // Use the parsed hunks (context + removed + added) to build the
  // post-patch source via applyHunksManually. This is the
  // last-resort path used when no vendored mirror is available.
  return applyHunksManually(preSource, parsed.hunks);
}

function getPostPatchState(preRelPath, args, mirrorPath, parsedExistingPatch, preSource) {
  // Order of preference:
  //   1. --<role>-patched CLI flag (absolute path)
  //   2. vendored/scaffolding/node_modules/scratch-vm mirror, *if* it
  //      differs from the pre-patch state. A previous broken build
  //      can leave the mirror identical to the pre-patch state (e.g.
  //      when the GPU runtime hook patch has never applied cleanly),
  //      in which case using it would produce an empty diff.
  //   3. Manual reconstruction from the existing patch's `+` lines
  //      (parses the existing patch, finds the context anchor in the
  //      pre-patch source, and inserts the additions at the hunk's
  //      `-` start position). This is the last-resort path that
  //      lets the script work even when no previously-built UMD is
  //      available.
  const flagKey = preRelPath.includes('runtime.js') ? 'runtime-patched' : 'control-patched';
  if (args[flagKey] && existsSync(args[flagKey])) {
    log(`Using CLI override for ${preRelPath}: ${args[flagKey]}`);
    return readFileSync(args[flagKey], 'utf8');
  }
  if (mirrorPath && existsSync(mirrorPath)) {
    const mirrorSource = readFileSync(mirrorPath, 'utf8');
    if (mirrorSource !== preSource) {
      log(`Using scaffolding mirror for ${preRelPath}: ${mirrorPath}`);
      return mirrorSource;
    }
    log(`Scaffolding mirror for ${preRelPath} matches pre-patch state; falling through to reconstruction`);
  }
  log(`Reconstructing post-patch state for ${preRelPath} from existing patch`);
  return reconstructPostPatchFromPatch(parsedExistingPatch, preSource);
}

function writePostPatchInTemp(relPath, content) {
  const target = resolve(TMP_ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runGitDiff(relPath) {
  const result = runCapture('git', [
    'diff',
    '--no-color',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--',
    relPath,
  ], { cwd: TMP_ROOT });
  return result.stdout;
}

function restorePrePatchInTemp(relPath) {
  run('git', ['checkout', 'HEAD', '--', relPath], { cwd: TMP_ROOT });
}

/**
 * Recount hunk headers from the actual body of `git diff` output.
 *
 * The `git diff` output's hunk headers (`@@ -A,B +C,D @@`) come from
 * git's own line tracking and are usually correct, but the previous
 * regen script had a known off-by-N issue (git's diff algorithm can
 * be confused by multi-byte UTF-8 characters in context lines on
 * Windows). We defensively re-derive `B` (original line count) and
 * `D` (new line count) from the body so the output survives a
 * strict `git apply` without `--recount`.
 *
 * Also updates the offsets of subsequent hunks so they remain valid
 * after a hunk's count changes.
 */
function recountHunkHeaders(diffText) {
  const lines = diffText.split('\n');
  const out = [];
  let i = 0;

  // Walk: file header lines first (diff --git / index / --- / +++).
  while (i < lines.length && !lines[i].startsWith('@@')) {
    out.push(lines[i]);
    i += 1;
  }

  // Track running offsets so we can rewrite origStart/newStart of
  // each subsequent hunk when earlier hunks' counts change.
  let runningOrigOffset = 0;
  let runningNewOffset = 0;

  while (i < lines.length) {
    const header = lines[i];
    if (!header.startsWith('@@')) {
      // Stray non-hunk line (rare). Push it verbatim.
      out.push(header);
      i += 1;
      continue;
    }
    const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      out.push(header);
      i += 1;
      continue;
    }
    const origStart = parseInt(m[1], 10);
    const origCountClaimed = m[2] === undefined ? 1 : parseInt(m[2], 10);
    const newStart = parseInt(m[3], 10);
    const newCountClaimed = m[4] === undefined ? 1 : parseInt(m[4], 10);

    // Collect the body until the next hunk header or EOF. The
    // last `split('\n')` element is an empty string (trailing
    // newline) — keep it as part of the body so we round-trip
    // the file terminator faithfully.
    const body = [];
    i += 1;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      body.push(lines[i]);
      i += 1;
    }

    // Recount the hunk's original/new line counts.
    let origCountActual = 0;
    let newCountActual = 0;
    for (const l of body) {
      if (l === '\\ No newline at end of file' || l === '' || l.startsWith('\\')) {
        continue;
      } else if (l.startsWith('-')) {
        origCountActual += 1;
      } else if (l.startsWith('+')) {
        newCountActual += 1;
      } else if (l.startsWith(' ')) {
        origCountActual += 1;
        newCountActual += 1;
      } else {
        // Unknown prefix — be safe and count as context.
        origCountActual += 1;
        newCountActual += 1;
      }
    }

    // Compute the corrected origStart/newStart using the running
    // offsets (so the relative spacing between hunks matches the
    // actual body sizes, not the previously-claimed ones).
    const newOrigStart = origStart + runningOrigOffset;
    const newNewStart = newStart + runningNewOffset;
    runningOrigOffset += origCountActual - origCountClaimed;
    runningNewOffset += newCountActual - newCountClaimed;

    // Emit the rewritten header, then the (unchanged) body.
    const origCountStr = origCountActual === 1 ? '' : `,${origCountActual}`;
    const newCountStr = newCountActual === 1 ? '' : `,${newCountActual}`;
    out.push(`@@ -${newOrigStart}${origCountStr} +${newNewStart}${newCountStr} @@${header.slice(header.indexOf('@@', 2) + 2)}`);
    for (const l of body) out.push(l);
  }

  return out.join('\n');
}

function setIndexLine(diffText, preHash, postHash) {
  // Replace the `index OLD..NEW` line with the supplied pre/post
  // blob hashes. Preserves the mode suffix (e.g. `100644`). The
  // hashes must be computed by the caller BEFORE the post state is
  // written to the temp dir (so the temp file still holds the pre
  // state at the time of `readFileSync`).
  const lines = diffText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('index ')) {
      lines[i] = `index ${preHash}..${postHash} 100644`;
      return lines.join('\n');
    }
  }
  // No index line — inject one after the `diff --git` line.
  const injected = [];
  for (let i = 0; i < lines.length; i += 1) {
    injected.push(lines[i]);
    if (lines[i].startsWith('diff --git ')) {
      injected.push(`index ${preHash}..${postHash} 100644`);
    }
  }
  return injected.join('\n');
}

function verifyPatchApplies(patchPath) {
  // Run `git apply --check` on a fresh temp clone of scratch-vm with
  // scratch-vm.patch already applied. We use a *separate* temp dir
  // for verification so a partial regen cannot leave the diff tree
  // in a corrupted state.
  //
  // Forward --check is the strict gate: the regenerated patch must
  // apply cleanly (no --recount, no --3way) to a fresh clone of
  // upstream scratch-vm + scratch-vm.patch. Reverse --check is
  // optional and only runs if the forward check passes — it requires
  // us to first apply the patch (so the file is in the post-patch
  // state) and then reverse-apply to verify the round-trip.
  const verifyRoot = resolve(tmpdir(), 'opencode', 'turbowasm-patchgen-verify');
  if (existsSync(verifyRoot)) rmSync(verifyRoot, { recursive: true, force: true });
  mkdirSync(verifyRoot, { recursive: true });
  try {
    run('git', ['clone', SCRATCH_VM_REPO, verifyRoot]);
    run('git', ['checkout', SCRATCH_VM_BASE_REF], { cwd: verifyRoot });
    run('git', ['apply', '--3way', '--ignore-whitespace', SCRATCH_VM_PATCH], { cwd: verifyRoot });
    // Forward --check: pre-patch state -> post-patch state.
    const fwd = runCapture('git', ['apply', '--check', '-p1', '-v', patchPath], {
      cwd: verifyRoot,
      stdio: 'pipe',
    });
    if (fwd.status !== 0) {
      return { forward: fwd, reverse: null, ok: false };
    }
    // Apply the patch (not just --check) so we can test reverse.
    run('git', ['apply', '-p1', patchPath], { cwd: verifyRoot });
    // Reverse --check: post-patch state -> pre-patch state.
    const rev = runCapture('git', ['apply', '--reverse', '--check', '-p1', '-v', patchPath], {
      cwd: verifyRoot,
      stdio: 'pipe',
    });
    return { forward: fwd, reverse: rev, ok: rev.status === 0 };
  } finally {
    rmSync(verifyRoot, { recursive: true, force: true });
  }
}

function processPatch({ label, relPath, mirrorPath, existingPatchPath, args }) {
  log(`--- ${label} ---`);
  const prePath = resolve(TMP_ROOT, relPath);
  const preSource = readFileSync(prePath, 'utf8');
  const parsed = parsePatch(existingPatchPath);
  const postSource = getPostPatchState(relPath, args, mirrorPath, parsed, preSource);
  // Compute pre/post blob hashes BEFORE writing the post state to
  // the temp dir, so the pre state is still pristine on disk.
  const preBlobHash = gitBlobHash(Buffer.from(preSource, 'utf8'));
  const postBlobHash = gitBlobHash(Buffer.from(postSource, 'utf8'));
  writePostPatchInTemp(relPath, postSource);
  let diff = runGitDiff(relPath);
  // Restore the temp dir to the pre state before continuing (we
  // may need it for subsequent patches).
  restorePrePatchInTemp(relPath);
  diff = recountHunkHeaders(diff);
  diff = setIndexLine(diff, preBlobHash, postBlobHash);
  // Verify against a fresh clone before writing.
  const tmpOut = existingPatchPath + '.new';
  writeFileSync(tmpOut, diff);
  const v = verifyPatchApplies(tmpOut);
  if (!v.ok) {
    rmSync(tmpOut, { force: true });
    const fwd = v.forward.stderr || v.forward.stdout;
    const rev = v.reverse ? (v.reverse.stderr || v.reverse.stdout) : '(reverse not run)';
    throw new Error(
      `[regen-gpu-patches] regenerated ${label} failed verification:\n--- forward --check ---\n${fwd}\n--- reverse --check ---\n${rev}`,
    );
  }
  writeFileSync(existingPatchPath, diff);
  rmSync(tmpOut, { force: true });
  log(`Wrote ${existingPatchPath} (${diff.length} bytes; forward + reverse --check OK)`);
}

function main() {
  const args = parseCliArgs(process.argv);

  setupBaseClone();
  applyScratchVmPatch();

  processPatch({
    label: 'gpu-kernel-list-binding',
    relPath: 'src/engine/runtime.js',
    mirrorPath: SCAFFOLDING_MIRRORED_RUNTIME,
    existingPatchPath: LIST_BINDING_PATCH,
    args,
  });

  processPatch({
    label: 'gpu-kernel-runtime',
    relPath: 'src/blocks/scratch3_control.js',
    mirrorPath: SCAFFOLDING_MIRRORED_CONTROL,
    existingPatchPath: RUNTIME_PATCH,
    args,
  });

  log('Done. Verifications passed: forward `git apply --check` on a fresh clone.');
  log('Suggested next steps:');
  log('  - `cd vendored/scratch-vm && git apply --check --recount -p1 -v ../../patches/vendored/gpu-kernel-list-binding+0.1.0.patch`');
  log('  - `cd vendored/scratch-vm && git apply --check --recount -p1 -v ../../patches/vendored/gpu-kernel-runtime+0.1.0.patch`');
  log('  - `npm test` to confirm the gpu-kernel-patches / scratch3-control-hook tests pass.');
}

try {
  main();
} catch (err) {
  die(err.message, err);
}
