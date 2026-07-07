import { describe, expect, it, beforeEach, vi } from 'vitest';

const { fakeBatch, fakeBufferCtor } = vi.hoisted(() => {
  const fakeBatch = vi.fn(() => 0);
  const fakeBufferCtor = vi.fn(function FakeBuffer(this: { _w: number; _h: number; _ptr: number }) {
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
  batch_touching_color: vi.fn(() => 0),
  SilhouetteBuffer: fakeBufferCtor,
}));

import {
  isWasmCollisionReady,
  resetWasmCollisionForTesting,
  wasmIsTouchingDrawables,
  type CandidateTuple,
} from '@/runtime/tw-wasm/wasm-collision-client';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';

function makeMockRenderer(
  candidates: Array<{
    id?: number;
    visible: boolean;
    hasSkin: boolean;
    bounds: { left: number; right: number; bottom: number; top: number };
    intersection?: { left: number; right: number; bottom: number; top: number };
  }>,
): RendererLike {
  const drawables = candidates.map((c, idx) => ({
    _id: idx,
    _inverseMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    _visible: c.visible,
    enabledEffects: 0,
    skin: c.hasSkin
      ? {
          _silhouette: {
            _width: 4,
            _height: 4,
            _colorData: new Uint8ClampedArray(4 * 4 * 4),
          },
        }
      : null,
    updateCPURenderAttributes: () => undefined,
  }));
  return {
    _allDrawables: drawables,
    _candidatesTouching: (_id: number, ids: number[]) =>
      ids
        .filter((i) => candidates[i])
        .map<CandidateTuple>((i) => ({
          id: candidates[i]!.id ?? i,
          drawable: drawables[i]!,
          intersection: candidates[i]!.intersection,
        })),
    _candidatesBounds: (cs: CandidateTuple[]) => {
      const result = { left: 0, right: 0, bottom: 0, top: 0 };
      for (const c of cs) {
        const b = c.intersection;
        if (!b) continue;
        result.left = b.left;
        result.right = b.right;
        result.bottom = b.bottom;
        result.top = b.top;
      }
      return result;
    },
  };
}

describe('wasm-collision-client candidates shape', () => {
  beforeEach(() => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    fakeBufferCtor.mockClear();
    resetWasmCollisionForTesting();
  });

  it('buildCallArgs tolerates candidates without id', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer = makeMockRenderer([
      { visible: true, hasSkin: true, bounds: { left: 0, right: 0, bottom: 0, top: 0 } },
      { visible: true, hasSkin: true, bounds: { left: 0, right: 0, bottom: 0, top: 0 } },
    ]);
    fakeBatch.mockReturnValueOnce(1);
    const result = wasmIsTouchingDrawables(renderer, 0, [1]);
    expect(result).toBe(true);
    expect(fakeBatch).toHaveBeenCalledTimes(1);
  });

  it('buildCallArgs passes intersection-derived bounds', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer = makeMockRenderer([
      { visible: true, hasSkin: true, bounds: { left: 0, right: 0, bottom: 0, top: 0 } },
      {
        visible: true,
        hasSkin: true,
        bounds: { left: 0, right: 0, bottom: 0, top: 0 },
        intersection: { left: -10, right: 10, bottom: -20, top: 20 },
      },
    ]);
    wasmIsTouchingDrawables(renderer, 0, [1]);
    const call = fakeBatch.mock.calls[0] as unknown as number[];
    expect(call[0]).toBe(-10);
    expect(call[1]).toBe(10);
    expect(call[2]).toBe(-20);
    expect(call[3]).toBe(20);
  });

  it('falls back to id-derived candidates when _candidatesTouching is missing', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const drawables = [
      {
        _inverseMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        _visible: true,
        enabledEffects: 0,
        skin: {
          _silhouette: { _width: 4, _height: 4, _colorData: new Uint8ClampedArray(4 * 4 * 4) },
        },
      },
    ];
    const renderer: RendererLike = { _allDrawables: drawables };
    // No candidates → returns false (not null) because the renderer is valid.
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBe(false);
    expect(isWasmCollisionReady()).toBe(true);
  });
});
