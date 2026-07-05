#!/usr/bin/env node
/**
 * Bootstrap vendored/scaffolding and vendored/scratch-vm from upstream and
 * apply the local patches under patches/vendored/. Run once after a fresh
 * clone to make the project runnable per README's Quick Start.
 *
 * vendored/ is intentionally .gitignore'd (local forks for VM perf work).
 * This script is the canonical way to materialize it from scratch.
 *
 * Behavior:
 *   - Idempotent: if vendored/scaffolding/dist/scaffolding-min.js already
 *     exists, the script prints a hint and exits 0 without touching the tree.
 *   - Clones vendored/scratch-vm from TurboWarp/scratch-vm (shallow).
 *   - Clones vendored/scaffolding from TurboWarp/scaffolding (shallow).
 *   - Applies patches/vendored/scratch-vm.patch and
 *     patches/vendored/scaffolding+0.4.0.patch via `git apply --3way`.
 *   - Runs `npm install` then `npm run build` inside vendored/scaffolding.
 *   - The existing scratch-render node_modules patch is applied automatically
 *     by the project's postinstall hook (scripts/apply-vendored-patches.mjs).
 *
 * Usage:
 *   node scripts/setup-vendored.mjs
 *   node scripts/setup-vendored.mjs --force   # wipe vendored/ and re-bootstrap
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const vendoredDir = resolve(root, 'vendored');
const scaffoldingDir = resolve(vendoredDir, 'scaffolding');
const scratchVmDir = resolve(vendoredDir, 'scratch-vm');
const scaffoldingBuiltMarker = resolve(scaffoldingDir, 'dist', 'scaffolding-min.js');

const SCAFFOLDING_REPO = 'https://github.com/TurboWarp/scaffolding.git';
const SCRATCH_VM_REPO = 'https://github.com/TurboWarp/scratch-vm.git';
const SCAFFOLDING_REF = '0.4.0';
const SCRATCH_VM_REF = 'develop';

const force = process.argv.includes('--force');

function log(msg) {
  console.log('[setup-vendored] ' + msg);
}

function run(cmd, args, opts = {}) {
  const finalCmd = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
  const result = spawnSync(finalCmd, args, {
    stdio: 'inherit',
    shell: false,
    ...opts,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
  return result;
}

if (!force && existsSync(scaffoldingBuiltMarker)) {
  log(
    `vendored/scaffolding already built (${scaffoldingBuiltMarker}). Skipping setup.`,
  );
  log('Run with --force to wipe vendored/ and re-bootstrap from upstream.');
  process.exit(0);
}

if (force) {
  log('--force: removing vendored/scaffolding and vendored/scratch-vm.');
  rmSync(scaffoldingDir, { recursive: true, force: true });
  rmSync(scratchVmDir, { recursive: true, force: true });
}

if (!existsSync(vendoredDir)) {
  throw new Error(`${vendoredDir} does not exist. Check that you are running from the project root.`);
}

// 1. Clone vendored/scratch-vm first because vendored/scaffolding/package.json
//    references it via file:../scratch-vm after the scaffolding patch is applied.
if (!existsSync(resolve(scratchVmDir, '.git'))) {
  log(`Cloning ${SCRATCH_VM_REPO} (${SCRATCH_VM_REF}) into vendored/scratch-vm`);
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    SCRATCH_VM_REF,
    SCRATCH_VM_REPO,
    scratchVmDir,
  ]);
} else {
  log('vendored/scratch-vm already cloned; skipping clone.');
}

const scratchVmPatch = resolve(root, 'patches', 'vendored', 'scratch-vm.patch');
if (!existsSync(scratchVmPatch)) {
  throw new Error(`Missing patch: ${scratchVmPatch}`);
}
log(`Applying ${scratchVmPatch}`);
run('git', ['apply', '--3way', scratchVmPatch], { cwd: scratchVmDir });

// 2. Clone vendored/scaffolding.
if (!existsSync(resolve(scaffoldingDir, '.git'))) {
  log(
    `Cloning ${SCAFFOLDING_REPO} (${SCAFFOLDING_REF}) into vendored/scaffolding`,
  );
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    SCAFFOLDING_REF,
    SCAFFOLDING_REPO,
    scaffoldingDir,
  ]);
} else {
  log('vendored/scaffolding already cloned; skipping clone.');
}

const scaffoldingPatch = resolve(
  root,
  'patches',
  'vendored',
  'scaffolding+0.4.0.patch',
);
if (!existsSync(scaffoldingPatch)) {
  throw new Error(`Missing patch: ${scaffoldingPatch}`);
}
log(`Applying ${scaffoldingPatch}`);
run('git', ['apply', '--3way', scaffoldingPatch], { cwd: scaffoldingDir });

// 3. Install vendored/scaffolding dependencies. The project's root postinstall
//    hook re-applies patches/scratch-render+0.1.0.patch to scratch-render
//    inside vendored/scaffolding/node_modules.
log('Running npm install inside vendored/scaffolding');
run('npm', ['install', '--no-audit', '--no-fund'], { cwd: scaffoldingDir });

// 4. Build vendored/scaffolding so vendored/scaffolding/dist/scaffolding-min.js
//    exists for vite's pre-bundling step.
log('Running npm run build inside vendored/scaffolding');
run('npm', ['run', 'build'], { cwd: scaffoldingDir });

log('Done. You can now run: npm run dev');