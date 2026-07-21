/**
 * Consolidated WASM collision-detection client tests.
 *
 * Replaces three previous files that all targeted the WASM SIMD
 * collision-detection surface:
 *   - wasm-collision-client.test.ts (init / null returns / ready gate)
 *   - silhouette-cache.test.ts (WeakMap + unlazy() re-sync)
 *   - batch-touching-drawables.test.ts (batch_touching_drawables arg layout + SIMD parity smoke)
 *
 * The three files share the same hoisted `fakeBatch` / `fakeBufferCtor`
 * mocks; they are now declared once at the top of this file. Tests
 * that exercise different layers of the surface are grouped together
 * so the contract reads as a single story.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  initWasmCollision,
  isWasmCollisionReady,
  resetSilhouetteCacheForTesting,
  resetWasmCollisionForTesting,
  wasmIsTouchingDrawables,
} from '@/runtime/tw-wasm/wasm-collision-client';
import type { RendererLike, SilhouetteLike } from '@/runtime/tw-wasm/wasm-collision-client';

interface SilhouetteSpec {
  visible: boolean;
  width: number;
  height: number;
  /** pixels where this returns true are opaque (alpha=255), others transparent. */
  opaque?: (x: number, y: number) => boolean;
  /** If true, the silhouette is fully opaque (every pixel alpha=255) unless overridden by `opaque`. */
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
        .map((id) => ({
          drawable: drawables[id] as { _inverseMatrix: Float32Array; skin: { _silhouette: { _width: number; _height: number; _colorData?: Uint8ClampedArray | null } }; _visible?: boolean; updateCPURenderAttributes?: () => void },
        })),
    _candidatesBounds: () => ({ left: 0, right: 3, bottom: 0, top: 3 }),
  };
}

function makeSilhouette(w: number, h: number, colorData: Uint8ClampedArray | null): SilhouetteLike {
  return { _width: w, _height: h, _colorData: colorData };
}

function makeRendererWithUnlazy(
  sil: SilhouetteLike,
  unlazy?: () => void,
): RendererLike {
  const drawable = {
    _inverseMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    _visible: true,
    enabledEffects: 0,
    skin: { _silhouette: sil },
    updateCPURenderAttributes: () => undefined,
  };
  if (unlazy) Object.defineProperty(sil, 'unlazy', { value: unlazy, configurable: true });
  return {
    _allDrawables: [drawable, drawable],
    _candidatesTouching: (_id: number, ids: number[]) => ids.map((id) => ({ id, drawable })),
    _candidatesBounds: () => ({ left: 0, right: 0, bottom: 0, top: 0 }),
  };
}

describe('wasm-collision-client: ready gate + null returns', () => {
  beforeEach(() => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    fakeBufferCtor.mockClear();
    resetWasmCollisionForTesting();
  });

  it('returns null and reports ready=false when WASM is not initialised', () => {
    const renderer = makeRenderer([{ visible: true, width: 4, height: 4 }]);
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBeNull();
    expect(isWasmCollisionReady()).toBe(false);
  });

  it('returns null when no drawables are attached after init', async () => {
    await initWasmCollision();
    const renderer: RendererLike = {};
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBeNull();
  });

  it('returns false when there are no candidates after init', async () => {
    await initWasmCollision();
    const renderer = makeRenderer([{ visible: true, width: 4, height: 4 }]);
    expect(wasmIsTouchingDrawables(renderer, 0, [])).toBe(false);
  });

  it('returns null when batch_touching_drawables throws', async () => {
    await initWasmCollision();
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    fakeBatch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBeNull();
  });

  it('returns false when visible-candidate filter leaves zero candidates', async () => {
    await initWasmCollision();
    fakeBatch.mockClear();
    // Two drawables but the second is invisible → candidates = 0.
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: false, width: 4, height: 4, fill: true },
    ]);
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBe(false);
    expect(fakeBatch).not.toHaveBeenCalled();
  });
});

describe('wasm-collision-client: live batch_touching_drawables contract', () => {
  beforeAll(async () => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    fakeBufferCtor.mockClear();
    resetWasmCollisionForTesting();
    await initWasmCollision();
  });

  it('returns true when batch reports an overlap and forwards bounds', () => {
    fakeBatch.mockReturnValueOnce(1);
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBe(true);
    expect(fakeBatch).toHaveBeenCalledTimes(1);
    const call = fakeBatch.mock.calls[0] as unknown[] | undefined;
    expect(call?.[0]).toBe(0);
    expect(call?.[1]).toBe(3);
    expect(call?.[2]).toBe(0);
    expect(call?.[3]).toBe(3);
  });

  it('returns false when WASM reports no overlap', () => {
    fakeBatch.mockReturnValueOnce(0);
    const renderer = makeRenderer([
      { visible: true, width: 4, height: 4, fill: true },
      { visible: true, width: 4, height: 4, fill: true },
    ]);
    expect(wasmIsTouchingDrawables(renderer, 0, [1])).toBe(false);
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
    for (let i = 0; i < 16; i += 1) {
      const expected = i % 5 === 0 ? 1 : 0;
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

  it('passes candidate count as the last argument', () => {
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

describe('silhouette cache (WeakMap + unlazy() re-sync)', () => {
  beforeEach(() => {
    fakeBatch.mockReset();
    fakeBatch.mockReturnValue(0);
    resetWasmCollisionForTesting();
    resetSilhouetteCacheForTesting();
  });

  it('is short-circuited for steady-state frames (no _colorData change)', async () => {
    await initWasmCollision();
    const color = new Uint8ClampedArray(4 * 4 * 4);
    const sil = makeSilhouette(4, 4, color);
    const r = makeRendererWithUnlazy(sil);
    wasmIsTouchingDrawables(r, 0, [1]);
    wasmIsTouchingDrawables(r, 0, [1]);
    wasmIsTouchingDrawables(r, 0, [1]);
    expect(isWasmCollisionReady()).toBe(true);
    expect(fakeBatch).toHaveBeenCalledTimes(3);
  });

  it('re-syncs when _colorData is reassigned to a new buffer', async () => {
    await initWasmCollision();
    const sil = makeSilhouette(4, 4, new Uint8ClampedArray(4 * 4 * 4));
    const r = makeRendererWithUnlazy(sil);
    wasmIsTouchingDrawables(r, 0, [1]);
    sil._colorData = new Uint8ClampedArray(4 * 4 * 4);
    wasmIsTouchingDrawables(r, 0, [1]);
    wasmIsTouchingDrawables(r, 0, [1]);
    wasmIsTouchingDrawables(r, 0, [1]);
    expect(fakeBatch).toHaveBeenCalledTimes(4);
  });

  it('re-syncs when unlazy() is invoked (lazy silhouette path)', async () => {
    await initWasmCollision();
    const sil = makeSilhouette(4, 4, null);
    let unlazyCalls = 0;
    const unlazy = vi.fn(() => {
      unlazyCalls += 1;
      sil._colorData = new Uint8ClampedArray(4 * 4 * 4);
    });
    const r = makeRendererWithUnlazy(sil, unlazy);
    wasmIsTouchingDrawables(r, 0, [1]);
    expect(unlazyCalls).toBe(1);
    wasmIsTouchingDrawables(r, 0, [1]);
    expect(unlazyCalls).toBe(1);
    sil._colorData = null;
    wasmIsTouchingDrawables(r, 0, [1]);
    expect(unlazyCalls).toBe(2);
  });
});
