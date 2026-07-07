import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * Visual-effects JS-fallback tests.
 *
 * When a sprite has any of mosaic / pixelate / whirl / fisheye active,
 * the WASM hook must return null so the patched `isTouchingDrawables`
 * can re-run the JS path that applies `EffectTransform.transformPoint`.
 * Color / brightness have a separate mask handled in Phase 6
 * (wasmIsTouchingColor); this file only covers the drawables path.
 *
 * `ghost` is intentionally NOT in the mask: the JS path already strips
 * ghost from `isTouchingColor` (via `effectMask: ~ShaderManager.EFFECT_INFO.ghost.mask`)
 * and the WASM path ignores ghost identically. Forcing JS fallback for
 * ghost-only sprites would burn cycles on the wrong condition.
 */

const { fakeBatch, fakeBufferCtor } = vi.hoisted(() => {
  const fakeBatch = vi.fn(() => 0);
  function FakeBuffer(this: { _w: number; _h: number; _ptr: number }) {
    this._w = 0;
    this._h = 0;
    this._ptr = 0;
  }
  FakeBuffer.prototype.width = function width(this: { _w: number }) {
    return this._w;
  };
  FakeBuffer.prototype.height = function height(this: { _h: number }) {
    return this._h;
  };
  FakeBuffer.prototype.data_ptr = function data_ptr(this: { _ptr: number }) {
    return this._ptr;
  };
  FakeBuffer.prototype.clear = vi.fn();
  return { fakeBatch, fakeBufferCtor: FakeBuffer as unknown as ReturnType<typeof vi.fn> };
});

vi.mock('../../../wasm-collision/pkg/tw_viewer_wasm_collision', () => ({
  default: () =>
    Promise.resolve({
      memory: new WebAssembly.Memory({ initial: 1 }),
    }),
  batch_touching_drawables: fakeBatch,
  batch_touching_color: vi.fn(() => 0),
  SilhouetteBuffer: fakeBufferCtor,
}));

import {
  resetWasmCollisionForTesting,
  resetSilhouetteCacheForTesting,
  wasmIsTouchingDrawables,
} from '@/runtime/tw-wasm/wasm-collision-client';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';
import { EFFECT_MASK, SHAPE_EFFECT_MASK } from '@/runtime/tw-wasm/effect-detection';

function makeSil(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

interface DrawableForTest {
  _inverseMatrix: Float32Array;
  _visible: boolean;
  enabledEffects?: number;
  skin: { _silhouette: { _width: number; _height: number; _colorData: Uint8ClampedArray } } | null;
  updateCPURenderAttributes: () => void;
}

function makeDrawable(enabledEffects: number): {
  d: DrawableForTest;
} {
  return {
    d: {
      _inverseMatrix: new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]),
      _visible: true,
      enabledEffects,
      skin: { _silhouette: { _width: 4, _height: 4, _colorData: makeSil(4, 4) } },
      updateCPURenderAttributes: () => undefined,
    },
  };
}

function makeRenderer(drawables: Array<ReturnType<typeof makeDrawable>['d']>): RendererLike {
  return {
    _allDrawables: drawables,
    _candidatesTouching: (_id: number, ids: number[]) =>
      ids.map((id) => ({ id, drawable: drawables[id]! })),
    _candidatesBounds: () => ({ left: 0, right: 3, bottom: 0, top: 3 }),
  };
}

describe('effects JS fallback', () => {
  beforeEach(() => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    resetWasmCollisionForTesting();
    resetSilhouetteCacheForTesting();
  });

  it('shape mask covers mosaic / pixelate / whirl / fisheye', () => {
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.mosaic).toBeTruthy();
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.pixelate).toBeTruthy();
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.whirl).toBeTruthy();
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.fisheye).toBeTruthy();
    // color / brightness / ghost must NOT trigger JS fallback for drawables
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.color).toBe(0);
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.brightness).toBe(0);
    expect(SHAPE_EFFECT_MASK & EFFECT_MASK.ghost).toBe(0);
  });

  it('returns null when self has mosaic active', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(EFFECT_MASK.mosaic);
    const cand = makeDrawable(0);
    const r = makeRenderer([self.d, cand.d]);
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBeNull();
    expect(fakeBatch).not.toHaveBeenCalled();
  });

  it('returns null when self has whirl active', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(EFFECT_MASK.whirl);
    const cand = makeDrawable(0);
    const r = makeRenderer([self.d, cand.d]);
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBeNull();
  });

  it('returns null when a candidate has fisheye active', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(0);
    const cand = makeDrawable(EFFECT_MASK.fisheye);
    const r = makeRenderer([self.d, cand.d]);
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBeNull();
  });

  it('returns null when a candidate has pixelate active', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(0);
    const cand = makeDrawable(EFFECT_MASK.pixelate);
    const r = makeRenderer([self.d, cand.d]);
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBeNull();
  });

  it('does NOT fallback for ghost-only drawable', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(EFFECT_MASK.ghost);
    const cand = makeDrawable(0);
    const r = makeRenderer([self.d, cand.d]);
    fakeBatch.mockReturnValueOnce(1);
    // Allowed because both paths skip ghost identically.
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBe(true);
    expect(fakeBatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT fallback for color/brightness-only drawable on the drawables path', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(EFFECT_MASK.color | EFFECT_MASK.brightness);
    const cand = makeDrawable(EFFECT_MASK.brightness);
    const r = makeRenderer([self.d, cand.d]);
    fakeBatch.mockReturnValueOnce(1);
    // `isTouchingDrawables` samples alpha only; color/brightness do not
    // change the silhouette boundary. The WASM result is therefore
    // identical to the JS path, so we don't force a fallback here.
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBe(true);
  });

  it('does NOT fallback when enabledEffects is undefined', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const drawables: DrawableForTest[] = [
      {
        _inverseMatrix: new Float32Array([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]),
        _visible: true,
        // No `enabledEffects` field at all.
        skin: { _silhouette: { _width: 4, _height: 4, _colorData: makeSil(4, 4) } },
        updateCPURenderAttributes: () => undefined,
      },
      {
        _inverseMatrix: new Float32Array([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]),
        _visible: true,
        skin: { _silhouette: { _width: 4, _height: 4, _colorData: makeSil(4, 4) } },
        updateCPURenderAttributes: () => undefined,
      },
    ];
    const r = makeRenderer(drawables);
    fakeBatch.mockReturnValueOnce(1);
    expect(wasmIsTouchingDrawables(r, 0, [1])).toBe(true);
  });
});
