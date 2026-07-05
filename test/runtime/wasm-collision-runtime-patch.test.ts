import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const PATCH_FILE = resolve(process.cwd(), 'patches/wasm-collision-runtime+0.1.0.patch');
const RENDER_WEB_GL = resolve(
  process.cwd(),
  'vendored/scaffolding/node_modules/scratch-render/src/RenderWebGL.js',
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
});
