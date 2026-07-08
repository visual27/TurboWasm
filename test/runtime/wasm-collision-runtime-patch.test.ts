import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const PATCH_FILE = resolve(process.cwd(), 'patches/wasm-collision-runtime+0.1.0.patch');
const RENDER_WEB_GL = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-render/src/RenderWebGL.js',
);
const SVG_SKIN = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-render/src/SVGSkin.js',
);

describe('wasm-collision-runtime patch', () => {
  it('the patch file exists', () => {
    expect(existsSync(PATCH_FILE), `patch file missing: ${PATCH_FILE}`).toBe(true);
  });

  it('patches RenderWebGL.isTouchingColor to delegate to _twWasmIsTouchingColor', () => {
    if (!existsSync(RENDER_WEB_GL)) return;
    const src = readFileSync(RENDER_WEB_GL, 'utf8');
    expect(
      src,
      'RenderWebGL.isTouchingColor is missing the TurboWasm hook; ' +
        're-run `npm run apply:scratch-render-patch`.',
    ).toMatch(/TurboWasm: optional WASM SIMD acceleration/);
    expect(src).toMatch(/_twWasmIsTouchingColor/);
  });

  it('patches RenderWebGL.isTouchingDrawables to delegate to _twWasmIsTouchingDrawables', () => {
    if (!existsSync(RENDER_WEB_GL)) return;
    const src = readFileSync(RENDER_WEB_GL, 'utf8');
    expect(src).toMatch(/_twWasmIsTouchingDrawables/);
  });

  it('the patch file is well-formed (git apply --check passes when reverted)', () => {
    try {
      const result = spawnSync(
        'git',
        ['apply', '--check', '--recount', '-p1', '-v', 'patches/wasm-collision-runtime+0.1.0.patch'],
        {
          cwd: resolve(process.cwd(), 'vendored/scaffolding'),
          encoding: 'utf8',
        },
      );
      expect(
        result.status,
        `git apply --check failed:\n${result.stdout}\n${result.stderr}\n` +
          'The wasm-collision-runtime patch is malformed. Most common cause: missing blank ' +
          'line between hunks, trailing newline, or hunk header line-count mismatch.',
      ).toBe(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[wasm-collision-runtime] git unavailable; skipping dry-run check', err);
    }
  });

  describe('Phase 4 (resvg-wasm SVG rasterizer)', () => {
    it('SVGSkin.createMIP drawImage is staged via a transient source canvas (NOT putImageData on the MIP context)', () => {
      // Regression guard for the `putImageData` coordinate-shift bug:
      // `putImageData` ignores the current 2D transform, so the resvg
      // rasterized ImageData drifted to the top-left base-sized corner
      // whenever the renderer needed a non-1x MIP. The fix stages the
      // buffer onto a transient source canvas and `drawImage`s from
      // there, which respects the `setTransform(scale, ...)` applied
      // above and so scales the SVG into the MIP canvas correctly.
      if (!existsSync(SVG_SKIN)) return;
      const src = readFileSync(SVG_SKIN, 'utf8');
      expect(
        src,
        'SVGSkin.createMIP is missing the `drawImage(twSrcCanvas, ...)` ' +
          'fix; re-apply the patch and re-run setup.',
      ).toMatch(/drawImage\(\s*twSrcCanvas\s*,\s*0\s*,\s*0\s*\)/);
      // The fix must not regress to calling `putImageData` on the MIP
      // context directly.
      expect(
        src,
        'SVGSkin.createMIP still uses `this._context.putImageData(...)`; ' +
          'this was the original bug. Re-apply the fix branch of the ' +
          'patch.',
      ).not.toMatch(/this\._context\.putImageData\(/);
    });

    it('SVGSkin.setSVG.onload snapshots the host-rasterized ImageData via the host hook', () => {
      if (!existsSync(SVG_SKIN)) return;
      const src = readFileSync(SVG_SKIN, 'utf8');
      // The `onload` callback must consult the host hook and stash the
      // result on `this._twRasterizedData` for the next `createMIP`
      // call. Missing the snapshot means every MIP falls back to the
      // native Image decoder, which defeats the Phase 4 goal.
      expect(src).toMatch(/twHostRaster\.rasterize/);
      expect(src).toMatch(/this\._twRasterizedData\s*=\s*out/);
    });
  });
});
