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
  SilhouetteBuffer: fakeBufferCtor,
}));

import {
  isWasmCollisionReady,
  resetWasmCollisionForTesting,
  wasmIsTouchingDrawables,
} from '@/runtime/tw-wasm/wasm-collision-client';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';

function makeRenderer(silhouettes: Array<{
  visible: boolean;
  width: number;
  height: number;
  alpha?: (x: number, y: number) => number;
}>): RendererLike {
  const drawables = silhouettes.map((s) => ({
    _inverseMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    _visible: s.visible,
    skin: {
      _silhouette: {
        _width: s.width,
        _height: s.height,
        _colorData: new Uint8ClampedArray(s.width * s.height * 4),
      },
    },
    updateCPURenderAttributes: () => undefined,
  }));
  return {
    _allDrawables: drawables,
    _candidatesTouching: (_id: number, _ids: number[]) =>
      drawables
        .filter((d) => d._visible)
        .map((d) => ({ drawable: d })),
    _candidatesBounds: () => ({ left: 0, right: 0, bottom: 0, top: 0 }),
  };
}

describe('wasm-collision-client', () => {
  beforeEach(() => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    fakeBufferCtor.mockClear();
    resetWasmCollisionForTesting();
  });

  it('returns null when WASM is not initialised', async () => {
    const renderer = makeRenderer([{ visible: true, width: 4, height: 4 }]);
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBeNull();
    expect(isWasmCollisionReady()).toBe(false);
  });

  it('returns null when no drawables are attached', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer: RendererLike = {};
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBeNull();
  });

  it('returns false when no candidates are provided after init', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer = makeRenderer([{ visible: true, width: 4, height: 4 }]);
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBe(false);
  });

  it('invokes batch_touching_drawables when ready', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4 },
      { visible: true, width: 4, height: 4 },
    ]);
    fakeBatch.mockReturnValueOnce(1);
    const result = wasmIsTouchingDrawables(renderer, 0, [1]);
    expect(fakeBatch).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('returns null when batch throws', async () => {
    const { initWasmCollision } = await import('@/runtime/tw-wasm/wasm-collision-client');
    await initWasmCollision();
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4 },
      { visible: true, width: 4, height: 4 },
    ]);
    fakeBatch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBeNull();
  });
});
