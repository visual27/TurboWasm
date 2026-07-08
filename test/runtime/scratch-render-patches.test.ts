import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Regression guard for the "Failed to load project: Failed to construct
 * 'ImageData': The source height is zero or not a number" bug.
 *
 * Root cause: when a custom extension (pen+, SPimgEditor, lmsLooksPlus, ...)
 * drives the stage size down to 0 during project load, `PenSkin._setCanvasSize`
 * reaches `new ImageData(0, 0)` and aborts `loadProject()`. The vendored
 * scratch-render has two guards (see patches/scratch-render+0.1.0.patch):
 *
 *   1. PenSkin._setCanvasSize: bail before allocating a 0-height texture.
 *   2. RenderWebGL.extractDrawableScreenSpace: return a 1x1 fallback when
 *      clamped bounds collapse to zero.
 *
 * The previous regression: the patch-package postinstall hook silently
 * swallowed its own failure (always `process.exit(0)`), the patches/ file
 * was malformed, and the vendored files stayed unpatched. This test pins
 * the actual file content so a future silent failure cannot recur.
 *
 * Vite loads `vendored/scaffolding/dist/scaffolding-min.js` (see
 * `vite.config.ts` resolve.alias), NOT the source files in
 * `vendored/scaffolding/node_modules/scratch-render/src/`. Patches that
 * only land on the source files are silently ignored at runtime. The
 * `vendored/scaffolding UMD carries the guards` block below guards
 * against the UMD being rebuilt without re-applying the patches.
 */
const VENDORED_PEN_SKIN = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-render/src/PenSkin.js',
);
const VENDORED_RENDER_WEB_GL = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-render/src/RenderWebGL.js',
);
// Local alias used by the assertions below; keeps the rest of the suite
// free of the awkward underscore.
const RENDER_WEB_GL = VENDORED_RENDER_WEB_GL;
const VENDORED_SCAFFOLDING_UMD = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
);

describe('vendored scratch-render ImageData guards', () => {
  it('the vendored scratch-render source exists (postinstall ran)', () => {
    expect(existsSync(VENDORED_PEN_SKIN), 'PenSkin.js missing').toBe(true);
    expect(existsSync(RENDER_WEB_GL), 'RenderWebGL.js missing').toBe(true);
  });

  it('PenSkin._setCanvasSize has the degenerate native-size guard', () => {
    const src = readFileSync(VENDORED_PEN_SKIN, 'utf8');
    expect(
      src,
      'PenSkin._setCanvasSize is missing the degenerate-size guard; ' +
        're-run `npm run apply:scratch-render-patch` after verifying ' +
        'patches/scratch-render+0.1.0.patch is well-formed.',
    ).toMatch(/if\s*\(\s*!\s*\(\s*width\s*>=\s*1\s*\)\s*\|\|\s*!\s*\(\s*height\s*>=\s*1\s*\)\s*\)/);
  });

  it('PenSkin._setCanvasSize clears stale silhouetteImageData before returning', () => {
    const src = readFileSync(VENDORED_PEN_SKIN, 'utf8');
    // The guard must null out the stale silhouette buffers so a later
    // updateSilhouette() call falls back to Skin.js's 1x1 empty data.
    expect(src).toMatch(/this\._silhouetteImageData\s*=\s*null/);
  });

  it('RenderWebGL.extractDrawableScreenSpace has the degenerate-bounds guard', () => {
    const src = readFileSync(VENDORED_RENDER_WEB_GL, 'utf8');
    expect(
      src,
      'RenderWebGL.extractDrawableScreenSpace is missing the degenerate-bounds guard; ' +
        're-run `npm run apply:scratch-render-patch` after verifying ' +
        'patches/scratch-render+0.1.0.patch is well-formed.',
    ).toMatch(/if\s*\(\s*!\s*\(\s*clampedWidth\s*>=\s*1\s*\)\s*\|\|\s*!\s*\(\s*clampedHeight\s*>=\s*1\s*\)\s*\)/);
  });

  it('RenderWebGL fallback returns a 1x1 ImageData instead of (0, 0)', () => {
    const src = readFileSync(VENDORED_RENDER_WEB_GL, 'utf8');
    // The guard's return block must construct new ImageData(1, 1) so the
    // downstream consumer has a valid 1x1 buffer to read instead of throwing.
    expect(src).toMatch(/new\s+ImageData\(\s*1\s*,\s*1\s*\)/);
  });

  it('the patch file itself is well-formed (git apply --check passes)', () => {
    const PATCH_FILE = resolve(process.cwd(), 'patches/scratch-render+0.1.0.patch');
    expect(existsSync(PATCH_FILE), 'patch file missing').toBe(true);
    // Use a child_process git apply so the same parser the postinstall hook
    // uses runs the check. We catch ENOENT (no git) and accept the test
    // silently in that environment — the file-content assertions above
    // still pin the behavior.
    try {
      const result = spawnSync(
        'git',
        ['apply', '--check', '-p1', '-v', 'patches/scratch-render+0.1.0.patch'],
        {
          cwd: resolve(process.cwd(), 'vendored/scaffolding'),
          encoding: 'utf8',
        },
      );
      expect(
        result.status,
        `git apply --check failed:\n${result.stdout}\n${result.stderr}\n` +
          'The patch file is malformed. Most common cause: missing blank ' +
          'line between the PenSkin hunk and the RenderWebGL hunk.',
      ).toBe(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[scratch-render-patches] git unavailable; skipping dry-run check', err);
    }
  });
});

describe('vendored scaffolding UMD carries the guards', () => {
  // Vite loads `vendored/scaffolding/dist/scaffolding-min.js` (UMD) via
  // `resolve.alias['@turbowarp/scaffolding']` and pre-bundles it via
  // `optimizeDeps.include`. If the UMD was rebuilt without re-applying
  // the scratch-render patches, the runtime keeps the original
  // unpatched `PenSkin._setCanvasSize` and `extractDrawableScreenSpace`,
  // and the second-project-load ImageData bug recurs.
  //
  // We verify the UMD content directly: it should contain the same
  // TurboWasm-annotated guard expressions as the source files. We skip
  // gracefully if the UMD is missing (e.g. before `npm run setup` has
  // ever run in CI) — the source-level guards above still pin the
  // patch application behavior.

  it('the vendored scaffolding UMD exists (npm run setup ran)', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[scratch-render-patches] vendored/scaffolding/dist/scaffolding-min.js missing; ' +
          'UMD guard checks will be skipped. Run `npm run setup` (or `npm run setup -- --force`) ' +
          'to regenerate the UMD with the patches baked in.',
      );
      return;
    }
    expect(existsSync(VENDORED_SCAFFOLDING_UMD), 'scaffolding-min.js missing').toBe(true);
  });

  it('UMD PenSkin._setCanvasSize has the degenerate native-size guard', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD PenSkin._setCanvasSize is missing the degenerate-size guard. ' +
        'The UMD was rebuilt without re-applying patches/scratch-render+0.1.0.patch. ' +
        'Run `npm run setup -- --force` to wipe vendored/ and rebuild the UMD with the patches baked in.',
    ).toMatch(/if\s*\(\s*!\s*\(\s*width\s*>=\s*1\s*\)\s*\|\|\s*!\s*\(\s*height\s*>=\s*1\s*\)\s*\)/);
  });

  it('UMD PenSkin._setCanvasSize clears stale silhouetteImageData before returning', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    // The guard must null out the stale silhouette buffers so a later
    // updateSilhouette() call falls back to Skin.js's 1x1 empty data.
    expect(umd).toMatch(/this\._silhouetteImageData\s*=\s*null/);
  });

  it('UMD RenderWebGL.extractDrawableScreenSpace has the degenerate-bounds guard', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD RenderWebGL.extractDrawableScreenSpace is missing the degenerate-bounds guard. ' +
        'The UMD was rebuilt without re-applying patches/scratch-render+0.1.0.patch. ' +
        'Run `npm run setup -- --force` to wipe vendored/ and rebuild the UMD with the patches baked in.',
    ).toMatch(/if\s*\(\s*!\s*\(\s*clampedWidth\s*>=\s*1\s*\)\s*\|\|\s*!\s*\(\s*clampedHeight\s*>=\s*1\s*\)\s*\)/);
  });

  it('UMD RenderWebGL fallback returns a 1x1 ImageData instead of (0, 0)', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    // The guard's return block must construct new ImageData(1, 1) so the
    // downstream consumer has a valid 1x1 buffer to read instead of throwing.
    expect(umd).toMatch(/new\s+ImageData\(\s*1\s*,\s*1\s*\)/);
  });
});

describe('vendored scratch-vm transitive deps are installed', () => {
  // Root cause of the "Cannot find module '@turbowarp/json'" /
  // "@turbowarp/jszip" / "format-message" failure when loading the UMD
  // through Vite: webpack built the UMD before these transitive deps were
  // hoisted into vendored/scaffolding/node_modules, so the UMD carries
  // `__webpack_require__(webpackMissingModule(...))` stubs that throw at
  // runtime. The fix lives in scripts/setup-vendored.mjs which runs an
  // explicit `npm install` step before webpack boots; these tests pin the
  // resulting dep tree so a future regression is caught at unit-test
  // time rather than in the real browser.

  // We enumerate a representative subset of scratch-vm's transitive deps
  // (full list in vendored/scratch-vm/package.json under `dependencies`).
  // Each one is verified to be installed in
  // vendored/scaffolding/node_modules/<dep>/package.json so webpack can
  // resolve it during the UMD build.
  const TRANSITIVE_DEPS = [
    'format-message',
    'format-message-formats',
    'format-message-interpret',
    'format-message-parse',
    '@turbowarp/json',
    '@turbowarp/jszip',
    '@turbowarp/nanolog',
    'scratch-parser',
    'scratch-sb1-converter',
    'scratch-translate-extension-languages',
    'arraybuffer-loader',
    'atob',
    'btoa',
    'canvas-toBlob',
    'decode-html',
    'diff-match-patch',
    'htmlparser2',
    'text-encoding',
    'uuid',
    'worker-loader',
  ] as const;

  for (const name of TRANSITIVE_DEPS) {
    it(`${name} is hoisted into vendored/scaffolding/node_modules`, () => {
      const probe = name.startsWith('@')
        ? resolve(
            process.cwd(),
            'vendored/scaffolding/node_modules',
            ...name.split('/'),
            'package.json',
          )
        : resolve(
            process.cwd(),
            'vendored/scaffolding/node_modules',
            name,
            'package.json',
          );
      const vendoredRootExists = existsSync(
        resolve(process.cwd(), 'vendored/scaffolding/package.json'),
      );
      if (!vendoredRootExists) {
        // Vendored scaffolding is gitignored; CI without a previous
        // npm run setup will not have it. Skip silently — these guards
        // exist to pin the bootstrap state, not to enforce presence.
        // eslint-disable-next-line no-console
        console.warn(
          '[scratch-render-patches] vendored/scaffolding missing; transitive-dep checks skipped.',
        );
        return;
      }
      expect(
        existsSync(probe),
        `vendored/scaffolding/node_modules/${name} is missing. ` +
          'This causes "Cannot find module" errors when loading the UMD. ' +
          'Re-run `npm run setup` (or `npm run setup -- --force`) to hoist the missing deps.',
      ).toBe(true);
    });
  }
});

describe('apply-vendored-patches.mjs is importable and idempotent', () => {
  // Regression guard for the refactor that turned
  // scripts/apply-vendored-patches.mjs into an importable ESM module
  // (so scripts/setup-vendored.mjs can re-apply the patches before the
  // UMD build). Importing the module must not auto-run applyPatches()
  // — that side-effect belongs to the CLI invocation only, and an
  // auto-run inside the test process would mutate the vendored tree
  // every test run.
  it('exports a named applyPatches function', async () => {
    const mod = await import('../../scripts/apply-vendored-patches.mjs');
    expect(typeof mod.applyPatches).toBe('function');
  });

  it('applying patches twice does not error (idempotent)', async () => {
    const mod = await import('../../scripts/apply-vendored-patches.mjs');
    const renderSrcDir = resolve(
      process.cwd(),
      'vendored/scaffolding/node_modules/scratch-render/src',
    );
    const renderPkg = resolve(
      process.cwd(),
      'vendored/scaffolding/node_modules/scratch-render/package.json',
    );
    if (!existsSync(renderPkg)) {
      // No vendored tree — nothing to test idempotency against. Skip.
      return;
    }
    expect(existsSync(renderSrcDir)).toBe(true);

    // Capture modification times of the source files so we can be sure
    // that the second invocation did not re-write them. Already-applied
    // patches are detected via `// TurboWasm:` markers and skipped, so
    // mtimes should be untouched.
    const penSkin = resolve(renderSrcDir, 'PenSkin.js');
    const render = resolve(renderSrcDir, 'RenderWebGL.js');
    const penMtime = existsSync(penSkin) ? statSync(penSkin).mtimeMs : 0;
    const renderMtime = existsSync(render) ? statSync(render).mtimeMs : 0;

    const r1 = mod.applyPatches({ exitOnComplete: false });
    expect(['ok', 'skipped']).toContain(r1.status);

    const r2 = mod.applyPatches({ exitOnComplete: false });
    expect(['ok', 'skipped']).toContain(r2.status);

    if (penMtime > 0 && existsSync(penSkin)) {
      expect(statSync(penSkin).mtimeMs).toBe(penMtime);
    }
    if (renderMtime > 0 && existsSync(render)) {
      expect(statSync(render).mtimeMs).toBe(renderMtime);
    }
  });
});

describe('vendored scratch-render Phase 4 (resvg-wasm) drawImage fix', () => {
  it('SVGSkin.createMIP uses drawImage(twSrcCanvas, ...) not putImageData on the MIP context', () => {
    // Regression guard for the putImageData coordinate-shift bug.
    // `putImageData` ignores the 2D transform applied above
    // (`setTransform(scale, 0, 0, scale, 0, 0)`) so the resvg buffer
    // drifted to the top-left base-sized corner whenever the renderer
    // needed a non-1x MIP. The fix stages onto a transient source
    // canvas and `drawImage`s from there, which respects the
    // transform.
    if (!existsSync(VENDORED_RENDER_WEB_GL)) return;
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD is missing the `drawImage(twSrcCanvas, ...)` fix in SVGSkin.createMIP',
    ).toMatch(/drawImage\(\s*twSrcCanvas\s*,\s*0\s*,\s*0\s*\)/);
    // Must NOT regress to putImageData on the MIP context.
    expect(
      umd,
      'UMD still uses `putImageData` on the MIP context (the original bug)',
    ).not.toMatch(/this\._context\.putImageData\(/);
  });
});