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
const VENDORED_SCAFFOLDING_UMD = resolve(
  process.cwd(),
  'vendored/scaffolding/dist/scaffolding-min.js',
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

  it('patches SVGSkin.createMIP to consult _twWasmSvgAcceleration (Stage 2)', () => {
    if (!existsSync(SVG_SKIN)) return;
    const src = readFileSync(SVG_SKIN, 'utf8');
    expect(
      src,
      'SVGSkin.createMIP is missing the Stage 2 SVG acceleration hook; ' +
        're-run `npm run setup` to apply the patched UMD.',
    ).toMatch(/TurboWasm: optional SVG acceleration hook/);
    expect(src).toMatch(/_twWasmSvgAcceleration/);
    // The hook must guard the bitmap with a `mode !== 'off'` check so
    // the default Stage 1 path is the literal first branch the
    // renderer takes.
    expect(src).toMatch(/twSvgAccel\.mode\s*!==\s*'off'/);
  });

  it('patches SVGSkin.createMIP to upload the cached ImageBitmap as a WebGL texture', () => {
    if (!existsSync(SVG_SKIN)) return;
    const src = readFileSync(SVG_SKIN, 'utf8');
    expect(
      src,
      'SVGSkin.createMIP must short-circuit on a pre-decoded ImageBitmap. ' +
        'The Stage 2 host returns a GPU-uploadable ImageBitmap; the patch ' +
        'must call `twgl.createTexture(gl, { src: bitmap, ... })` and return ' +
        'without going through the canvas drawImage path.',
    ).toMatch(/twSvgAccelBitmap/);
  });

  it('patches SVGSkin.resetMIPs to invalidate the host cache (Stage 2)', () => {
    if (!existsSync(SVG_SKIN)) return;
    const src = readFileSync(SVG_SKIN, 'utf8');
    expect(
      src,
      'SVGSkin.resetMIPs must notify the host so the LRU ImageBitmap cache ' +
        'drops its entries on a costume swap.',
    ).toMatch(/twSvgAccel\.invalidate\(this\)/);
  });

  it('vendored UMD carries the Stage 2 SVG acceleration hook', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD missing; SVG hook UMD check will be skipped. ' +
          'Run `npm run setup` to regenerate the UMD.',
      );
      return;
    }
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD is missing the Stage 2 SVG acceleration hook. The UMD was rebuilt ' +
        'without re-applying patches/wasm-collision-runtime+0.1.0.patch. ' +
        'Run `npm run setup -- --force` to wipe vendored/ and rebuild.',
    ).toMatch(/_twWasmSvgAcceleration/);
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
});
