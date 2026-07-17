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
 *     exists, the script prints a hint and validates that the scratch-vm
 *     transitive deps (format-message, @turbowarp/json, @turbowarp/jszip,
 *     ...) are still present in vendored/scaffolding/node_modules. Any
 *     missing dep is re-installed. The scratch-render patches are then
 *     re-applied (idempotent) so a freshly built UMD carries the
 *     `// TurboWasm:` guards, and `node_modules/.vite/deps` is invalidated
 *     so a future `npm run dev` does not load a stale esbuild pre-bundle.
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
 *   - Re-imports `applyPatches` from apply-vendored-patches.mjs so the
 *     scratch-render `// TurboWasm:` guards are in node_modules before the
 *     UMD is built (otherwise the UMD ships without them).
 *   - Runs `npm run build` inside vendored/scaffolding.
 *   - Invalidates Vite's optimizeDeps cache so the next `npm run dev` does
 *     not load a pre-bundle built against a stale UMD.
 *
 * Usage:
 *   node scripts/setup-vendored.mjs
 *   node scripts/setup-vendored.mjs --force   # wipe vendored/ and re-bootstrap
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { applyPatches } from './apply-vendored-patches.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const vendoredDir = resolve(root, 'vendored');
const scaffoldingDir = resolve(vendoredDir, 'scaffolding');
const scratchVmDir = resolve(vendoredDir, 'scratch-vm');
const scaffoldingBuiltMarker = resolve(scaffoldingDir, 'dist', 'scaffolding-min.js');
const installedScratchVm = resolve(scaffoldingDir, 'node_modules', 'scratch-vm');
const viteDepsDir = resolve(root, 'node_modules', '.vite', 'deps');

const SCAFFOLDING_REPO = 'https://github.com/TurboWarp/scaffolding.git';
const SCRATCH_VM_REPO = 'https://github.com/TurboWarp/scratch-vm.git';
const SCAFFOLDING_REF = 'v0.4.0';
const SCRATCH_VM_REF = 'develop';

// Representative subset of scratch-vm's transitive deps. Used as a spot
// check for "the vendored setup has been completely bootstrapped". We do not
// enumerate every dep — the goal is to detect the common shape of the failure
// where the missing-deps list above has drifted (e.g. scratch-vm addes a new
// @turbowarp/* helper and we don't notice until `npm run build` fails with
// `Can't resolve '@turbowarp/foo'`). Anything missing here triggers the
// recovery path which installs whatever scratch-vm's package.json says it
// needs.
const REQUIRED_TRANSITIVE_DEPS = [
  'format-message',
  '@turbowarp/json',
  '@turbowarp/jszip',
  '@turbowarp/nanolog',
  'scratch-parser',
];

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

/**
 * Spot-check the vendored scaffolding's node_modules for a representative set
 * of scratch-vm transitive deps. Returns the names of any missing entries so
 * the caller can decide whether to trigger a recovery flow.
 */
function findMissingTransitiveDeps() {
  const missing = [];
  for (const name of REQUIRED_TRANSITIVE_DEPS) {
    let probe;
    if (name.startsWith('@')) {
      const [scope, pkg] = name.split('/');
      probe = resolve(scaffoldingDir, 'node_modules', scope, pkg, 'package.json');
    } else {
      probe = resolve(scaffoldingDir, 'node_modules', name, 'package.json');
    }
    if (!existsSync(probe)) missing.push(name);
  }
  return missing;
}

/**
 * Read scratch-vm's package.json and re-install each of its `dependencies`
 * into `vendored/scaffolding/node_modules` so that webpack can resolve them
 * at UMD build time. Used both for the `--force` reinstall (which already
 * handles this via the github: ref trick) and for the lightweight recovery
 * path triggered when the spot check above finds missing deps.
 *
 * We deliberately do NOT touch `vendored/scaffolding/package.json`. Adding
 * the deps to its own package.json would change the resolved dep graph
 * unnecessarily — git hoisting is non-deterministic and adding all of
 * scratch-vm's transitive deps to scaffolding's package.json could mask
 * future upstream changes (e.g. scratch-vm bumps a dep, we'd silently keep
 * the old version until someone manually re-runs this script).
 */
function reinstallScratchVmTransitiveDeps() {
  const pkgPath = resolve(scratchVmDir, 'package.json');
  if (!existsSync(pkgPath)) {
    log(
      `vendored/scratch-vm/package.json missing; cannot reinstall its deps. ` +
        'Re-run with --force to re-clone.',
    );
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const entries = Object.entries(pkg.dependencies || {});
  if (entries.length === 0) return;

  log(
    `Reinstalling ${entries.length} scratch-vm transitive deps into vendored/scaffolding/node_modules`,
  );
  const specs = entries.map(([name, range]) => `${name}@${range}`);
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...specs], {
    cwd: scaffoldingDir,
  });
}

/**
 * Idempotent post-setup tail: ensure patches are applied, and invalidate Vite's
 * optimizeDeps cache so the next `npm run dev` does not serve a pre-bundle
 * built against a stale UMD.
 */
function finalizeAfterUmDBuild() {
  log('Re-applying scratch-render patches (idempotent) so UMD stays in sync');
  applyPatches({ exitOnComplete: false });
  log('Invalidating Vite optimizeDeps cache so the rebuilt UMD is picked up');
  if (existsSync(viteDepsDir)) {
    rmSync(viteDepsDir, { recursive: true, force: true });
  }
}

if (!force && existsSync(scaffoldingBuiltMarker)) {
  // UMD exists from a prior setup. Don't redo the full bootstrap (clone,
  // npm install, mirror). Instead, validate that scratch-vm's transitive deps
  // are still installed — they sometimes go missing when a developer runs
  // `npm install --no-scripts` or installs scratch-vm by hand — and reapply
  // patches / clear Vite's cache.
  const missing = findMissingTransitiveDeps();
  if (missing.length === 0) {
    log(
      `vendored/scaffolding already built (${scaffoldingBuiltMarker}). Skipping full setup.`,
    );
    log('Run with --force to wipe vendored/ and re-bootstrap from upstream.');
    finalizeAfterUmDBuild();
    process.exit(0);
  }
  log(
    `vendored/scaffolding UMD exists but transitive deps are missing: ${missing.join(', ')}. ` +
      'Recovering without a full re-clone.',
  );
  if (!existsSync(scratchVmDir)) {
    throw new Error(
      `vendored/scratch-vm is missing; cannot recover deps. Re-run with --force to re-clone.`,
    );
  }
  reinstallScratchVmTransitiveDeps();
  // Re-mirror the scratch-vm nested copy in case it became a stale symlink
  // through any number of intervening `npm install` calls.
  if (existsSync(installedScratchVm)) {
    rmSync(installedScratchVm, { recursive: true, force: true });
  }
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
  // The UMD on disk is stale: it was built when the now-restored deps were
  // missing, so webpack inlined `Cannot find module 'X'` stubs for them.
  // Re-applying patches is not enough — rebuild the UMD so it carries the
  // now-correct scratch-vm resolution graph. Without this step, the next
  // `npm run build` would still see the same stubs.
  log('Rebuilding vendored/scaffolding UMD after dep recovery');
  applyPatches({ exitOnComplete: false });
  run('npm', ['run', 'build'], { cwd: scaffoldingDir });
  log('Invalidating Vite optimizeDeps cache so the rebuilt UMD is picked up');
  if (existsSync(viteDepsDir)) {
    rmSync(viteDepsDir, { recursive: true, force: true });
  }
  log('Recovery complete. You can now run: npm run dev');
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
// GPU compute kernel pipeline (M2): two extra patches to vendored/scratch-vm.
// `gpu-kernel-list-binding+0.1.0.patch` adds the four list/scalar accessor
// APIs (`__getListBuffer`, `__getListBufferById`, `__getScalarValue`,
// `__setScalarValue`) on `runtime.js`. `gpu-kernel-runtime+0.1.0.patch`
// adds the per-primitive GPU hook to `scratch3_control.js`. Both are
// optional — when missing we skip without aborting so older setups that
// haven't migrated yet still complete.
const gpuKernelListBindingPatch = resolve(
  root,
  'patches',
  'vendored',
  'gpu-kernel-list-binding+0.1.0.patch',
);
const gpuKernelRuntimePatch = resolve(
  root,
  'patches',
  'vendored',
  'gpu-kernel-runtime+0.1.0.patch',
);
if (!existsSync(scaffoldingPatch)) {
  throw new Error(`Missing patch: ${scaffoldingPatch}`);
}
if (!existsSync(scratchVmPatch)) {
  throw new Error(`Missing patch: ${scratchVmPatch}`);
}

// 1. Clone vendored/scratch-vm and apply the local fork patch.
//
// Use package.json as the sentinel: `.git` alone could be a leftover from a
// previous failed setup (or a copied `.git` with no working tree), which
// the naive `.git`-exists check would treat as "already cloned" and then
// the subsequent `git apply` would fail with missing-file context. When the
// sentinel is missing, remove the stale directory before re-cloning so
// `git clone` does not bail out on a non-empty target.
const scratchVmSentinel = resolve(scratchVmDir, 'package.json');
if (!existsSync(scratchVmSentinel)) {
  if (existsSync(scratchVmDir)) {
    log('Stale vendored/scratch-vm (no package.json); removing before re-clone.');
    rmSync(scratchVmDir, { recursive: true, force: true });
  }
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
// `--ignore-whitespace`: the upstream `.gitattributes` marks `*.js` as
// `text eol=lf` and the global `core.autocrlf=true` setting on Git for
// Windows normalizes line endings at checkout time. When both `git clone`
// and `git apply` are invoked from this Node process via `spawnSync`, the
// rehydrated working tree can end up with whitespace that does not
// byte-equal the patch context (which was generated against the raw blob
// content). `--ignore-whitespace` accepts whitespace-incompatible context
// and makes the patch apply cleanly. We keep `--3way` so any genuine
// non-whitespace conflict still surfaces.
run('git', ['apply', '--3way', '--ignore-whitespace', scratchVmPatch], { cwd: scratchVmDir });

// GPU compute kernel pipeline (M2): the two extra patches below are
// optional. When missing the script proceeds without them so a developer
// who hasn't migrated yet can still bootstrap. The runtime side of
// `__turboWasmGpuKernelDispatch` (window global) is only installed when
// the TS pipeline registers kernels, so the absence of these patches is
// a graceful no-op at runtime.
if (existsSync(gpuKernelListBindingPatch)) {
  log(`Applying ${gpuKernelListBindingPatch} (GPU list binding APIs)`);
  run(
    'git',
    ['apply', '--3way', '--ignore-whitespace', gpuKernelListBindingPatch],
    { cwd: scratchVmDir },
  );
} else {
  log(
    `GPU list-binding patch not present at ${gpuKernelListBindingPatch}; skipping.`,
  );
}
if (existsSync(gpuKernelRuntimePatch)) {
  log(`Applying ${gpuKernelRuntimePatch} (GPU kernel runtime hooks)`);
  run(
    'git',
    ['apply', '--3way', '--ignore-whitespace', gpuKernelRuntimePatch],
    { cwd: scratchVmDir },
  );
} else {
  log(
    `GPU kernel-runtime patch not present at ${gpuKernelRuntimePatch}; skipping.`,
  );
}

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
// `--ignore-whitespace` for the same reason as the scratch-vm patch
// above: Git for Windows + `core.autocrlf=true` + the auto-attached
// npm-regenerated package-lock.json contents cause context bytes to
// mismatch the recorded patch if both clone and apply run via spawnSync.
run('git', ['apply', '--3way', '--ignore-whitespace', scaffoldingPatch], { cwd: scaffoldingDir });

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

// 6. Sanity-check: even after the github: install, scratch-vm's transitive
//    deps must be present. If anything went wrong with the hoist (e.g. the
//    user interrupted the previous run mid-way), fall back to an explicit
//    reinstall of those packages before we build the UMD.
const missingAfterBootstrap = findMissingTransitiveDeps();
if (missingAfterBootstrap.length > 0) {
  log(
    `After bootstrap, transitive deps are still missing: ${missingAfterBootstrap.join(', ')}. ` +
      'Falling back to an explicit reinstall.',
  );
  reinstallScratchVmTransitiveDeps();
}

// 7. Apply the in-tree scratch-render patches to vendored/scaffolding's
//    node_modules BEFORE running the UMD build. The shipped artifact at
//    vendored/scaffolding/dist/scaffolding-min.js is what Vite actually
//    loads (see vite.config.ts resolve.alias), so patches that only land
//    on the source files in node_modules/scratch-render/src are silently
//    ignored at runtime. The postinstall hook
//    (scripts/apply-vendored-patches.mjs) only re-applies the patches to
//    the source files, which is correct for development but insufficient
//    when the UMD must be regenerated from scratch.
//
//    Re-importing `applyPatches()` here guarantees a freshly built UMD
//    carries the TurboWasm guards in PenSkin._setCanvasSize and
//    RenderWebGL.extractDrawableScreenSpace. The marker-based already-
//    applied detection makes this safe to run more than once.
log('Applying scratch-render patches before UMD build');
applyPatches({ exitOnComplete: false });

// 8. Build vendored/scaffolding so vendored/scaffolding/dist/scaffolding-min.js
//    exists for vite's pre-bundling step.
log('Running npm run build inside vendored/scaffolding');
run('npm', ['run', 'build'], { cwd: scaffoldingDir });

// 9. Invalidate Vite's optimizeDeps cache so the freshly built UMD is picked
//    up by the next `npm run dev` (vite pre-bundles UMD on startup; without
//    this the browser would load a pre-bundle built from the *previous*
//    UMD and throw `Cannot find module '@turbowarp/json'` at runtime).
finalizeAfterUmDBuild();

log('Done. You can now run: npm run dev');
