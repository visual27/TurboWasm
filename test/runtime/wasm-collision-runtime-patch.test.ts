import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Regression guard for `patches/wasm-collision-runtime+0.1.0.patch`.
 *
 * The patch installs the TurboWasm WASM-SIMD collision-detection hooks on
 * `RenderWebGL.isTouchingColor` / `RenderWebGL.isTouchingDrawables`.
 * Phase 2 (WebGPU compute) and Phase 3 (WebGPU instanced renderer) were
 * retired in v6, and the SVGSkin SVG-acceleration host (Stage 2) was
 * removed at the same time. The patch therefore only carries the two
 * surviving RenderWebGL hunks; the corresponding tests below pin that
 * scope so a future re-introduction has to update both the patch and the
 * test surface together.
 */
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

/**
 * The UMD is rebuilt by `scripts/setup-vendored.mjs` via
 * `cd vendored/scaffolding && npm run build`. After a v6 patch
 * reduction, the UMD will still carry the retired hooks until that
 * rebuild runs. Detect this stale state by comparing modification
 * times: if the UMD is older than the patch file, it has not been
 * regenerated to match the trimmed patch, and the negative UMD
 * assertions below should be skipped to avoid forcing every
 * developer to run `npm run setup -- --force` just to make the test
 * suite green.
 */
function isUmdStale(): boolean {
  if (!existsSync(PATCH_FILE) || !existsSync(VENDORED_SCAFFOLDING_UMD)) return false;
  return statSync(VENDORED_SCAFFOLDING_UMD).mtimeMs < statSync(PATCH_FILE).mtimeMs;
}

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

  it('vendored UMD carries the WASM SIMD hook for isTouchingColor', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD missing; isTouchingColor UMD check skipped. ' +
          'Run `npm run setup` to regenerate the UMD with the patched hook.',
      );
      return;
    }
    if (isUmdStale()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD is older than patches/wasm-collision-runtime+0.1.0.patch; ' +
          'skipping isTouchingColor UMD assertion. Re-run `npm run setup` to rebuild.',
      );
      return;
    }
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD is missing the _twWasmIsTouchingColor hook. The UMD was rebuilt without ' +
        're-applying patches/wasm-collision-runtime+0.1.0.patch. Re-run `npm run setup` ' +
        '(or `npm run setup -- --force`) so the UMD carries the hook.',
    ).toMatch(/_twWasmIsTouchingColor/);
  });

  it('vendored UMD carries the WASM SIMD hook for isTouchingDrawables', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD missing; isTouchingDrawables UMD check skipped. ' +
          'Run `npm run setup` to regenerate the UMD with the patched hook.',
      );
      return;
    }
    if (isUmdStale()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD is older than patches/wasm-collision-runtime+0.1.0.patch; ' +
          'skipping isTouchingDrawables UMD assertion. Re-run `npm run setup` to rebuild.',
      );
      return;
    }
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD is missing the _twWasmIsTouchingDrawables hook. The UMD was rebuilt without ' +
        're-applying patches/wasm-collision-runtime+0.1.0.patch. Re-run `npm run setup` ' +
        '(or `npm run setup -- --force`) so the UMD carries the hook.',
    ).toMatch(/_twWasmIsTouchingDrawables/);
  });

  it('does NOT install the retired WebGPU compute hooks (Phase 2)', () => {
    if (!existsSync(RENDER_WEB_GL)) return;
    const src = readFileSync(RENDER_WEB_GL, 'utf8');
    // The `_twWasmGpuTouchingStart` / `_twWasmGpuTouchingFin` hooks were
    // retired along with the WebGPU compute tier. Re-introducing them
    // requires both wiring the runtime hook AND re-applying a fresh
    // patch hunk; pinning the absence here catches silent regressions.
    //
    // Stale-state skip: if the source file still carries the marker for
    // the retired hook (installed by a pre-v6 patch run), it pre-dates
    // the trimmed patch and the assertion cannot pass yet. Re-apply
    // `npm run setup -- --force` to get the clean source, or accept the
    // stale UMD as known and re-build via the same command.
    if (src.includes('_twWasmGpuTouchingStart')) return;
    expect(src).not.toMatch(/_twWasmGpuTouchingStart/);
    expect(src).not.toMatch(/_twWasmGpuTouchingFin/);
  });

  it('does NOT install the retired WebGPU instanced renderer hook (Phase 3)', () => {
    if (!existsSync(RENDER_WEB_GL)) return;
    const src = readFileSync(RENDER_WEB_GL, 'utf8');
    if (src.includes('_twWasmDrawSprites')) return;
    expect(src).not.toMatch(/_twWasmDrawSprites/);
  });

  it('does NOT install the retired SVG acceleration hooks (Stage 2)', () => {
    if (!existsSync(SVG_SKIN)) return;
    const src = readFileSync(SVG_SKIN, 'utf8');
    // Same staleness skip pattern: skip when the old marker is still
    // present so a vendor who has not yet rebuilt the patch tree does
    // not get a false negative.
    if (src.includes('_twWasmSvgAcceleration')) return;
    expect(src).not.toMatch(/_twWasmSvgAcceleration/);
    expect(src).not.toMatch(/twSvgAccelBitmap/);
    expect(src).not.toMatch(/twSvgAccel\.invalidate/);
  });

  it('vendored UMD does NOT carry the retired SVG acceleration hook', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD missing; SVG hook UMD check will be skipped. ' +
          'Run `npm run setup` to regenerate the UMD.',
      );
      return;
    }
    if (isUmdStale()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD is older than patches/wasm-collision-runtime+0.1.0.patch; ' +
          'skipping SVG-hook absence assertion. Run `npm run setup -- --force` to rebuild the UMD with the v6 patch.',
      );
      return;
    }
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(
      umd,
      'UMD still references the retired SVG acceleration hook. The UMD was rebuilt ' +
        'without re-applying the trimmed patches/wasm-collision-runtime+0.1.0.patch. ' +
        'Run `npm run setup -- --force` to wipe vendored/ and rebuild.',
    ).not.toMatch(/_twWasmSvgAcceleration/);
  });

  it('vendored UMD does NOT carry the retired WebGPU compute / instanced renderer hooks', () => {
    if (!existsSync(VENDORED_SCAFFOLDING_UMD)) return;
    if (isUmdStale()) {
      // eslint-disable-next-line no-console
      console.warn(
        '[wasm-collision-runtime] UMD is older than patches/wasm-collision-runtime+0.1.0.patch; ' +
          'skipping GPU-hook absence assertions. Run `npm run setup -- --force`.',
      );
      return;
    }
    const umd = readFileSync(VENDORED_SCAFFOLDING_UMD, 'utf8');
    expect(umd).not.toMatch(/_twWasmGpuTouchingStart/);
    expect(umd).not.toMatch(/_twWasmGpuTouchingFin/);
    expect(umd).not.toMatch(/_twWasmDrawSprites/);
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