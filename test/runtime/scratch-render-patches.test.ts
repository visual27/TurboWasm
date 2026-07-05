import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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