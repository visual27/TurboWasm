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
 *   - Shallow-clones vendored/scratch-vm from TurboWarp/scratch-vm (develop).
 *   - Shallow-clones vendored/scaffolding from TurboWarp/scaffolding (v0.4.0).
 *   - Installs vendored/scaffolding's deps while the scratch-vm dep is still
 *     the upstream `github:` reference, so npm hoists scratch-vm's transitive
 *     deps into vendored/scaffolding/node_modules (file: deps do not get
 *     hoisted, so we install first, then switch the reference).
 *   - Applies patches/vendored/scaffolding+0.4.0.patch (switches the
 *     scratch-vm dep to file:../scratch-vm).
 *   - Applies patches/vendored/scratch-vm.patch to vendored/scratch-vm
 *     (the source of truth) and then mirrors vendored/scratch-vm over
 *     vendored/scaffolding/node_modules/scratch-vm (the copy that webpack
 *     actually bundles).
 *   - Runs `npm run build` inside vendored/scaffolding.
 *   - The existing scratch-render node_modules patch is applied automatically
 *     by the project's postinstall hook (scripts/apply-vendored-patches.mjs).
 *
 * Usage:
 *   node scripts/setup-vendored.mjs
 *   node scripts/setup-vendored.mjs --force   # wipe vendored/ and re-bootstrap
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const vendoredDir = resolve(root, 'vendored');
const scaffoldingDir = resolve(vendoredDir, 'scaffolding');
const scratchVmDir = resolve(vendoredDir, 'scratch-vm');
const scaffoldingBuiltMarker = resolve(scaffoldingDir, 'dist', 'scaffolding-min.js');
const installedScratchVm = resolve(scaffoldingDir, 'node_modules', 'scratch-vm');

const SCAFFOLDING_REPO = 'https://github.com/TurboWarp/scaffolding.git';
const SCRATCH_VM_REPO = 'https://github.com/TurboWarp/scratch-vm.git';
const SCAFFOLDING_REF = 'v0.4.0';
const SCRATCH_VM_REF = 'develop';

const force = process.argv.includes('--force');

function log(msg) {
  console.log('[setup-vendored] ' + msg);
}

function run(cmd, args, opts = {}) {
  const finalCmd = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
  const needsShell = process.platform === 'win32' && /\.cmd$/i.test(finalCmd);
  const result = spawnSync(finalCmd, args, {
    stdio: 'inherit',
    shell: needsShell,
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
  log(`Creating ${vendoredDir}`);
  mkdirSync(vendoredDir, { recursive: true });
}

const scaffoldingPatch = resolve(
  root,
  'patches',
  'vendored',
  'scaffolding+0.4.0.patch',
);
const scratchVmPatch = resolve(root, 'patches', 'vendored', 'scratch-vm.patch');
if (!existsSync(scaffoldingPatch)) {
  throw new Error(`Missing patch: ${scaffoldingPatch}`);
}
if (!existsSync(scratchVmPatch)) {
  throw new Error(`Missing patch: ${scratchVmPatch}`);
}

// 1. Clone vendored/scratch-vm and apply the local fork patch.
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

log(`Applying ${scratchVmPatch} to vendored/scratch-vm`);
run('git', ['apply', '--3way', scratchVmPatch], { cwd: scratchVmDir });

// 2. Clone vendored/scaffolding (unpatched; the dep still points at the
//    upstream github: ref so npm will fetch and hoist scratch-vm + its deps).
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

// 3. Install vendored/scaffolding's deps (and scratch-vm from github) BEFORE
//    switching the dep reference. github: deps get their transitive deps
//    hoisted into vendored/scaffolding/node_modules; file: deps do not.
log(
  'Running npm install inside vendored/scaffolding (with upstream github: scratch-vm)',
);
run(
  'npm',
  ['install', '--no-audit', '--no-fund', '--ignore-scripts'],
  { cwd: scaffoldingDir },
);

// 4. Apply the scaffolding patch (now switches scratch-vm to file:).
log(`Applying ${scaffoldingPatch}`);
run('git', ['apply', '--3way', scaffoldingPatch], { cwd: scaffoldingDir });

// 5. Mirror the patched vendored/scratch-vm over the just-installed
//    vendored/scaffolding/node_modules/scratch-vm. npm strips .git and
//    node_modules when copying deps, so a plain file copy works.
//    git apply would also work, but only after `git init` in the target
//    since the npm-installed copy has no .git directory.
if (existsSync(installedScratchVm)) {
  log(
    'Mirroring vendored/scratch-vm into vendored/scaffolding/node_modules/scratch-vm',
  );
  rmSync(installedScratchVm, { recursive: true, force: true });
  // Filter out .git and node_modules so the copy is well-formed.
  cpSync(scratchVmDir, installedScratchVm, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = src.replace(/\\/g, '/');
      if (base.endsWith('/.git') || base.includes('/.git/')) return false;
      if (base.endsWith('/node_modules') || base.includes('/node_modules/')) {
        return false;
      }
      return true;
    },
  });
} else {
  throw new Error(
    `${installedScratchVm} not found after npm install. Did the dep change?`,
  );
}

// 6. Build vendored/scaffolding so vendored/scaffolding/dist/scaffolding-min.js
//    exists for vite's pre-bundling step.
log('Running npm run build inside vendored/scaffolding');
run('npm', ['run', 'build'], { cwd: scaffoldingDir });

log('Done. You can now run: npm run dev');