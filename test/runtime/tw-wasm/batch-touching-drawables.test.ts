import { describe, expect, it, beforeAll, vi } from 'vitest';

const { fakeBatch, fakeBufferCtor } = vi.hoisted(() => {
  const fakeBatch = vi.fn(() => 0);
  const fakeBufferCtor = vi.fn(function FakeBuffer(this: {
    _w: number;
    _h: number;
    _ptr: number;
  }) {
    this._w = 0;
    this._h = 0;
    this._ptr = 0;
  });
  fakeBufferCtor.prototype.width = function width(this: { _w: number }) {
    return this._w;
  };
  fakeBufferCtor.prototype.height = function height(this: { _h: number }) {
    return this._h;
  };
  fakeBufferCtor.prototype.data_ptr = function data_ptr(this: { _ptr: number }) {
    return this._ptr;
  };
  fakeBufferCtor.prototype.clear = vi.fn();
  return { fakeBatch, fakeBufferCtor };
});

vi.mock('../../../wasm-collision/pkg/tw_viewer_wasm_collision', () => ({
  default: () =>
    Promise.resolve({
      memory: new WebAssembly.Memory({ initial: 1 }),
    }),
  batch_touching_drawables: fakeBatch,
  SilhouetteBuffer: fakeBufferCtor,
}));

import {
  initWasmCollision,
  resetWasmCollisionForTesting,
  wasmIsTouchingDrawables,
} from '@/runtime/tw-wasm/wasm-collision-client';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';

interface SilhouetteSpec {
  visible: boolean;
  width: number;
  height: number;
  /** pixels where this returns true are opaque (alpha=255), others transparent. */
  opaque?: (x: number, y: number) => boolean;
  /**
   * If true, the silhouette is "fully opaque" (every pixel alpha=255)
   * unless overridden by `opaque`. Useful for rectangles that fill the bounds.
   */
  fill?: boolean;
}

function makeRenderer(specs: SilhouetteSpec[]): RendererLike {
  const drawables = specs.map((s) => {
    const colorData = new Uint8ClampedArray(s.width * s.height * 4);
    for (let y = 0; y < s.height; y += 1) {
      for (let x = 0; x < s.width; x += 1) {
        const i = (y * s.width + x) * 4 + 3;
        if (s.fill || (s.opaque && s.opaque(x, y))) {
          colorData[i] = 255;
        }
      }
    }
    return {
      _inverseMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      _visible: s.visible,
      skin: {
        _silhouette: {
          _width: s.width,
          _height: s.height,
          _colorData: colorData,
        },
      },
      updateCPURenderAttributes: () => undefined,
    };
  });
  return {
    _allDrawables: drawables,
    _candidatesTouching: (drawableID: number, ids: number[]) =>
      ids
        .filter((id) => id !== drawableID && drawables[id]?._visible !== false)
        .map((id) => ({ drawable: drawables[id] as { _inverseMatrix: Float32Array; skin: { _silhouette: { _width: number; _height: number; _colorData?: Uint8ClampedArray | null } }; _visible?: boolean; updateCPURenderAttributes?: () => void } })),
    _candidatesBounds: () => ({ left: 0, right: 3, bottom: 0, top: 3 }),
  };
}

describe('wasm-collision-client (live batch_touching_drawables)', () => {
  beforeAll(async () => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    fakeBufferCtor.mockClear();
    resetWasmCollisionForTesting();
    await initWasmCollision();
  });

  it('invokes batch_touching_drawables with bounds-supplied args', async () => {
    fakeBatch.mockReturnValueOnce(1);
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    const r = wasmIsTouchingDrawables(renderer, 0, [1]);
    expect(r).toBe(true);
    expect(fakeBatch).toHaveBeenCalledTimes(1);
    const call = fakeBatch.mock.calls[0] as unknown[] | undefined;
    expect(call?.[0]).toBe(0); // bounds.left
    expect(call?.[1]).toBe(3); // bounds.right
    expect(call?.[2]).toBe(0); // bounds.bottom
    expect(call?.[3]).toBe(3); // bounds.top
  });

  it('returns false when WASM reports no overlap', async () => {
    fakeBatch.mockReturnValueOnce(0);
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    const r = wasmIsTouchingDrawables(renderer, 0, [1]);
    expect(r).toBe(false);
  });

  it('returns false when there are no candidates after init', async () => {
    fakeBatch.mockClear();
    // Two drawables but only the self is visible — the visibleCandidates
    // filter excludes the second (invisible) one, leaving 0 candidates.
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: false, width: 4, height: 4, fill: true },
    ]);
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBe(false);
    expect(fakeBatch).not.toHaveBeenCalled();
  });

  it('returns null when batch throws', async () => {
    fakeBatch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBeNull();
  });

  it('returns null when renderer has no drawables', async () => {
    const renderer: RendererLike = {};
    expect(wasmIsTouchingDrawables(renderer, 0, [0])).toBeNull();
  });
});

describe('wasm-collision-client: SIMD vs scalar parity (smoke)', () => {
  beforeAll(async () => {
    await initWasmCollision();
  });

  it('encodes 16-float inverse matrix in the SelfInv slot', () => {
    fakeBatch.mockClear();
    fakeBatch.mockReturnValue(0);
    const renderer = makeRenderer([
      { visible: true, width: 8, height: 8, fill: true },
      { visible: true, width: 8, height: 8, fill: true },
    ]);
    wasmIsTouchingDrawables(renderer, 0, [1]);
    expect(fakeBatch).toHaveBeenCalledTimes(1);
    const call = fakeBatch.mock.calls[0] as unknown[] | undefined;
    const selfInv = call?.[4] as Float32Array;
    expect(selfInv).toBeInstanceOf(Float32Array);
    expect(selfInv.length).toBe(16);
    // identity matrix preserved
    for (let i = 0; i < 16; i += 1) {
      const expected = i % 5 === 0 ? 1 : 0; // diagonal of 4x4 identity
      expect(selfInv[i]).toBe(expected);
    }
  });

  it('packs candidate inverse matrices back-to-back in candInv', () => {
    fakeBatch.mockClear();
    fakeBatch.mockReturnValue(0);
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    wasmIsTouchingDrawables(renderer, 0, [1, 2]);
    const call = fakeBatch.mock.calls[0] as unknown[] | undefined;
    const candInv = call?.[6] as Float32Array;
    expect(candInv.length).toBe(16 * 2);
  });

  it('passes candidate count as last argument', () => {
    fakeBatch.mockClear();
    fakeBatch.mockReturnValue(0);
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    wasmIsTouchingDrawables(renderer, 0, [1, 2, 3]);
    const call = fakeBatch.mock.calls[0] as unknown[] | undefined;
    expect(call?.[9]).toBe(3);
  });
});