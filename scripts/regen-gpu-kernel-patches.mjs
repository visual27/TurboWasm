#!/usr/bin/env node
/**
 * Build patches/vendored/gpu-kernel-list-binding+0.1.0.patch
 * and patches/vendored/gpu-kernel-runtime+0.1.0.patch from scratch,
 * so they apply cleanly to upstream scratch-vm + patches/vendored/scratch-vm.patch.
 *
 * The previous patches assumed an intermediate state that was manually
 * constructed in the working tree (the methods were added by an older
 * version of the list-binding patch, which was deleted in 66a3dc8). The
 * current patches therefore fail to apply on a fresh clone from origin/develop.
 *
 * This script generates new patches that go from scratch-vm.patch-applied
 * state to the fully-patched state, producing a single combined diff per file.
 *
 * Source files (read from local vendored scratch-vm):
 *   vendored/scratch-vm/src/engine/runtime.js          (after: fully patched)
 *   vendored/scratch-vm/src/blocks/scratch3_control.js (after: fully patched)
 *
 * Target (pre-patch) state is reconstructed from:
 *   upstream scratch-vm at SCRATCH_VM_BASE_REF + patches/vendored/scratch-vm.patch
 *
 * We use a temp clone of upstream scratch-vm (no auth, no remote), apply
 * scratch-vm.patch there, then compute the diff against the local patched
 * files using raw byte comparison.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const scratchVmSrcDir = resolve(root, 'vendored', 'scratch-vm');
const runtimeSrcPath = resolve(scratchVmSrcDir, 'src', 'engine', 'runtime.js');
const controlSrcPath = resolve(scratchVmSrcDir, 'src', 'blocks', 'scratch3_control.js');
const scratchVmPatchPath = resolve(root, 'patches', 'vendored', 'scratch-vm.patch');
const outListBindingPatch = resolve(root, 'patches', 'vendored', 'gpu-kernel-list-binding+0.1.0.patch');
const outRuntimePatch = resolve(root, 'patches', 'vendored', 'gpu-kernel-runtime+0.1.0.patch');

// upstream commit that scratch-vm.patch was generated against
// (per scratch-vm.patch index 1df8dff..5c49ee5)
const SCRATCH_VM_BASE_REF = '925f1134001ada36572eeb35f9d83ba01c98081a';

function log(msg) {
  console.log('[regen-gpu-patches] ' + msg);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}\n${result.stderr}`);
  }
  return result;
}

const probeDir = resolve(tmpdir(), 'opencode', 'turbowasm-patchgen');

function setupBaseClone() {
  if (existsSync(resolve(probeDir, '.git'))) {
    log(`Reusing existing clone at ${probeDir}`);
    run('git', ['checkout', SCRATCH_VM_BASE_REF], { cwd: probeDir });
    run('git', ['reset', '--hard', 'HEAD'], { cwd: probeDir });
    return;
  }
  log(`Cloning scratch-vm into ${probeDir}`);
  if (existsSync(probeDir)) rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(probeDir, { recursive: true });
  run('git', ['clone', '--depth', '1', 'https://github.com/TurboWarp/scratch-vm.git', probeDir]);
  run('git', ['fetch', '--depth', '1', 'origin', SCRATCH_VM_BASE_REF], { cwd: probeDir });
  run('git', ['checkout', SCRATCH_VM_BASE_REF], { cwd: probeDir });
}

function applyScratchVmPatch() {
  log(`Applying scratch-vm.patch to base clone`);
  // Use --ignore-whitespace + --3way to handle CRLF/LF drift on Windows.
  // Restore autocrlf to false so the resulting files are LF-normalized.
  run('git', ['config', 'core.autocrlf', 'false'], { cwd: probeDir });
  const result = run('git', [
    'apply',
    '--3way',
    '--ignore-whitespace',
    scratchVmPatchPath,
  ], { cwd: probeDir });
  log('scratch-vm.patch applied');
}

/**
 * Produce a unified diff from basePath to patchedPath, with paths normalized to
 * `a/<rel>` and `b/<rel>` for git compatibility. We do this without invoking
 * `git diff` (which corrupts non-ASCII bytes on this Windows config) by
 * computing the diff manually using a simple LCS-style algorithm.
 *
 * This is a pragmatic implementation optimized for the two-file case we have:
 *   - runtime.js: pre-patch ~3563 lines, post-patch ~3732 lines
 *   - scratch3_control.js: pre-patch ~206 lines, post-patch ~350 lines
 *
 * We use git's own diff algorithm via `git diff-files --raw` after copying the
 * files into the working tree, but with diff filters disabled to preserve
 * UTF-8 bytes.
 */
function produceCleanDiff(basePath, patchedPath, relPath, outPath) {
  // Copy patched file into the base clone's working tree at relPath.
  const targetPath = resolve(probeDir, relPath);
  // Ensure dir exists.
  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(patchedPath, targetPath);

  // Build a custom git config that disables encoding transformations.
  // The Windows system gitconfig registers [diff "astextplain"] with a
  // textconv that interprets bytes as the active code page, corrupting
  // any multi-byte UTF-8 sequence outside ASCII. We override by writing
  // a local .git/config that drops the diff driver for .js files.
  const localCfgPath = resolve(probeDir, '.git', 'config');
  const cfg = readFileSync(localCfgPath, 'utf8');
  if (!cfg.includes('[diff "noencoding"]')) {
    const append = [
      '',
      '[diff "noencoding"]',
      '\ttextconv = cat',
      '\tbinary = false',
    ].join('\n');
    writeFileSync(localCfgPath, cfg + append);
  }
  // Write a per-repo .gitattributes that disables text conversion for runtime.js + scratch3_control.js
  const gitattributesPath = resolve(probeDir, '.gitattributes');
  const ga = [
    'src/engine/runtime.js -text',
    'src/blocks/scratch3_control.js -text',
  ].join('\n') + '\n';
  writeFileSync(gitattributesPath, ga);

  // Run git diff, filtering the output to only the target file.
  const result = run('git', [
    'diff',
    '--no-color',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--',
    relPath,
  ], { cwd: probeDir });

  writeFileSync(outPath, result.stdout);
  const bytes = readFileSync(outPath);
  const c2 = bytes.indexOf(0xC2);
  const ef = bytes.indexOf(0xEF);
  log(`Wrote ${outPath} (${bytes.length} bytes; C2=${c2}, EF=${ef})`);

  // Restore the file to base state for the next iteration.
  run('git', ['checkout', 'HEAD', '--', relPath], { cwd: probeDir });
}

function main() {
  setupBaseClone();
  applyScratchVmPatch();

  produceCleanDiff(
    resolve(probeDir, 'src', 'engine', 'runtime.js'),
    runtimeSrcPath,
    'src/engine/runtime.js',
    outListBindingPatch,
  );

  produceCleanDiff(
    resolve(probeDir, 'src', 'blocks', 'scratch3_control.js'),
    controlSrcPath,
    'src/blocks/scratch3_control.js',
    outRuntimePatch,
  );

  log('Done. Verify with: cd vendored/scaffolding && rm -rf node_modules && npm install && npm run build');
}

main();
