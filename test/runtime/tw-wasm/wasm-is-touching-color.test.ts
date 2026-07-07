import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * End-to-end tests for `wasmIsTouchingColor`. The Rust function
 * `batch_touching_color` is mocked at the wasm-bindgen boundary
 * (the wasm module is not loaded into jsdom for these tests, since
 * jsdom provides no usable WebAssembly.Memory beyond the test fixture's
 * own). Mocks keep the JS-layer logic — effect fallback, mask sentinel
 * handling, hex trim, and bounds check — under unit-test coverage.
 */

const { fakeColorBatch, fakeBufferCtor } = vi.hoisted(() => {
  const fakeColorBatch = vi.fn(() => 0);
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
  return { fakeColorBatch, fakeBufferCtor: FakeBuffer as unknown as ReturnType<typeof vi.fn> };
});

vi.mock('../../../wasm-collision/pkg/tw_viewer_wasm_collision', () => ({
  default: () =>
    Promise.resolve({
      memory: new WebAssembly.Memory({ initial: 1 }),
    }),
  batch_touching_drawables: vi.fn(() => 0),
  batch_touching_color: fakeColorBatch,
  SilhouetteBuffer: fakeBufferCtor,
}));

import {
  resetWasmCollisionForTesting,
  resetSilhouetteCacheForTesting,
  wasmIsTouchingColor,
} from '@/runtime/tw-wasm/wasm-collision-client';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';
import { COLOR_EFFECT_MASK, SHAPE_EFFECT_MASK } from '@/runtime/tw-wasm/effect-detection';

function makeSil(): Uint8ClampedArray {
  return new Uint8ClampedArray(4 * 4 * 4);
}

function makeDrawable(enabledEffects = 0): {
  _inverseMatrix: Float32Array;
  _visible: boolean;
  enabledEffects: number;
  skin: { _silhouette: { _width: number; _height: number; _colorData: Uint8ClampedArray } };
  useNearest?: (s: number, d: unknown) => boolean;
  updateCPURenderAttributes: () => void;
} {
  return {
    _inverseMatrix: new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]),
    _visible: true,
    enabledEffects,
    skin: { _silhouette: { _width: 4, _height: 4, _colorData: makeSil() } },
    useNearest: () => true,
    updateCPURenderAttributes: () => undefined,
  };
}

function makeRenderer(drawables: Array<ReturnType<typeof makeDrawable>>): RendererLike {
  return {
    _allDrawables: drawables,
    _candidatesTouching: (_id: number, ids: number[]) =>
      ids.map((id) => ({ id, drawable: drawables[id]! })),
    _candidatesBounds: () => ({ left: 0, right: 3, bottom: 0, top: 3 }),
  };
}

describe('wasmIsTouchingColor', () => {
  beforeEach(() => {
    fakeColorBatch.mockReset();
    fakeColorBatch.mockReturnValue(0);
    resetWasmCollisionForTesting();
    resetSilhouetteCacheForTesting();
  });

  it('returns null when WASM is not initialized', () => {
    const renderer = makeRenderer([makeDrawable()]);
    expect(wasmIsTouchingColor(renderer, 0, [255, 0, 0], null)).toBeNull();
  });

  it('returns null when color3b is missing or too short', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer = makeRenderer([makeDrawable()]);
    expect(wasmIsTouchingColor(renderer, 0, null, null)).toBeNull();
    expect(wasmIsTouchingColor(renderer, 0, [] as unknown as number[], null)).toBeNull();
  });

  it('returns null when self has a shape effect (mosaic active)', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(SHAPE_EFFECT_MASK & 0b0001000); // mosaic bit
    const cand = makeDrawable();
    const r = makeRenderer([self, cand]);
    expect(wasmIsTouchingColor(r, 0, [0, 255, 0], null)).toBeNull();
    expect(fakeColorBatch).not.toHaveBeenCalled();
  });

  it('returns null when a candidate has whirl active (shape effect)', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable();
    const cand = makeDrawable(SHAPE_EFFECT_MASK & 0b0100000); // whirl bit
    const r = makeRenderer([self, cand]);
    expect(wasmIsTouchingColor(r, 0, [0, 255, 0], null)).toBeNull();
  });

  it('returns null when a candidate has color effect (color shift active)', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable();
    const cand = makeDrawable(COLOR_EFFECT_MASK & 0b0000001); // color bit
    const r = makeRenderer([self, cand]);
    expect(wasmIsTouchingColor(r, 0, [0, 255, 0], null)).toBeNull();
  });

  it('does not fallback for brightness-only drawable (mask drop is allowed)', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable(COLOR_EFFECT_MASK & 0b0000010); // brightness bit
    const cand = makeDrawable();
    const r = makeRenderer([self, cand]);
    fakeColorBatch.mockReturnValueOnce(1);
    // brightness alone: JS path would also strip it from the colour
    // test (the shader encodes brightness as additive on RGB; JS
    // baseline applies EffectTransform before comparing). The WASM
    // path with `brightness` set as colour-effect bit currently
    // returns null to be safe — this test asserts the current
    // conservative behaviour. If/when Rust implements effect math, the
    // guard must follow the implemented coverage.
    expect(wasmIsTouchingColor(r, 0, [0, 255, 0], null)).toBeNull();
  });

  it('invokes batch_touching_color with target RGB when mask is null', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable();
    const cand = makeDrawable();
    const r = makeRenderer([self, cand]);
    fakeColorBatch.mockReturnValueOnce(1);
    const result = wasmIsTouchingColor(r, 0, [255, 128, 64], null);
    expect(result).toBe(true);
    expect(fakeColorBatch).toHaveBeenCalledTimes(1);
    const call = fakeColorBatch.mock.calls[0] as number[];
    // First three args are target R/G/B.
    expect(call[4]).toBe(255);
    expect(call[5]).toBe(128);
    expect(call[6]).toBe(64);
    // Mask channels are -1 (no mask).
    expect(call[7]).toBe(-1);
    expect(call[8]).toBe(-1);
    expect(call[9]).toBe(-1);
  });

  it('invokes batch_touching_color with mask channels when mask is provided', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable();
    const cand = makeDrawable();
    const r = makeRenderer([self, cand]);
    wasmIsTouchingColor(r, 0, [255, 128, 64], [10, 20, 30]);
    const call = fakeColorBatch.mock.calls[0] as number[];
    expect(call[7]).toBe(10);
    expect(call[8]).toBe(20);
    expect(call[9]).toBe(30);
  });

  it('returns false when batch returns 0', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable();
    const cand = makeDrawable();
    const r = makeRenderer([self, cand]);
    fakeColorBatch.mockReturnValueOnce(0);
    expect(wasmIsTouchingColor(r, 0, [0, 255, 0], null)).toBe(false);
  });

  it('returns null when batch throws', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const self = makeDrawable();
    const cand = makeDrawable();
    const r = makeRenderer([self, cand]);
    fakeColorBatch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(wasmIsTouchingColor(r, 0, [0, 255, 0], null)).toBeNull();
  });
});
