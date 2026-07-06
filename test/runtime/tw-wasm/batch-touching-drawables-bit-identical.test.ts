import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const wasmBytes = readFileSync(
  resolve(root, 'wasm-collision/pkg/tw_viewer_wasm_collision_bg.wasm'),
);

// Reference scalar implementation — mirrors the inner loop exactly.
// Returns 1 if any pixel pair collides, 0 otherwise.
function scalarBatch(
  boundsLeft: number,
  boundsRight: number,
  boundsBottom: number,
  boundsTop: number,
  selfInv: Float32Array,
  selfSil: { width: number; height: number; data: Uint8ClampedArray },
  candInv: Float32Array,
  candSils: Array<{ width: number; height: number; data: Uint8ClampedArray }>,
): number {
  const inv = (i: number) => selfInv[i] ?? 0;
  const cinv = (i: number) => candInv[i] ?? 0;
  function alphaAt(
    buf: { width: number; data: Uint8ClampedArray },
    x: number,
    y: number,
  ): number {
    if (x < 0 || y < 0 || x >= buf.width) return 0;
    return buf.data[(y * buf.width + x) * 4 + 3] ?? 0;
  }
  for (let x = boundsLeft; x <= boundsRight; x += 1) {
    for (let y = boundsBottom; y <= boundsTop; y += 1) {
      const xf = x;
      const yf = y;
      const d = xf * inv(3) + yf * inv(7) + inv(15);
      const invD = Math.abs(d) < 1e-6 ? 1 : 1 / d;
      const sx = 0.5 - ((xf * inv(0) + yf * inv(4) + inv(12)) * invD);
      const sy = (xf * inv(1) + yf * inv(5) + inv(13)) * invD + 0.5;
      const sxI = Math.trunc(sx * selfSil.width);
      const syI = Math.trunc(sy * selfSil.height);
      if (alphaAt(selfSil, sxI, syI) === 0) continue;
      for (const cand of candSils) {
        const cx = 0.5 - ((xf * cinv(0) + yf * cinv(4) + cinv(12)) * invD);
        const cy = (xf * cinv(1) + yf * cinv(5) + cinv(13)) * invD + 0.5;
        const cxI = Math.trunc(cx * cand.width);
        const cyI = Math.trunc(cy * cand.height);
        if (alphaAt(cand, cxI, cyI) !== 0) return 1;
      }
    }
  }
  return 0;
}

interface WasmHandle {
  batch_touching_drawables: (
    bl: number,
    br: number,
    bb: number,
    bt: number,
    selfInv: Float32Array,
    selfSil: unknown,
    candInv: Float32Array,
    candOffsets: Uint32Array,
    candDims: Uint32Array,
    candCount: number,
  ) => number;
  SilhouetteBuffer: new (w: number, h: number) => {
    width(): number;
    height(): number;
    data_ptr(): number;
  };
  memory: WebAssembly.Memory;
}

let wasm: WasmHandle | null = null;

async function loadWasm(): Promise<WasmHandle> {
  // The pkg is ESM; default export is the init function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import('../../../wasm-collision/pkg/tw_viewer_wasm_collision')) as any;
  const initResult = await mod.default(wasmBytes);
  return {
    batch_touching_drawables: mod.batch_touching_drawables,
    SilhouetteBuffer: mod.SilhouetteBuffer,
    memory: initResult.memory as WebAssembly.Memory,
  };
}

function fillSilhouette(
  buf: { data_ptr(): number; width(): number; height(): number },
  memory: WebAssembly.Memory,
  data: Uint8ClampedArray,
): void {
  const ptr = buf.data_ptr();
  const w = buf.width();
  const h = buf.height();
  const dst = new Uint8Array(memory.buffer, ptr, w * h * 4);
  dst.set(data);
}

function identityMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function translationMatrix(tx: number, ty: number): Float32Array {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -tx, -ty, 0, 1,
  ]);
}

function makeSolidSil(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

describe('batch_touching_drawables: SIMD vs scalar parity', () => {
  beforeAll(async () => {
    wasm = await loadWasm();
  });

  function runBoth(
    bl: number,
    br: number,
    bb: number,
    bt: number,
    selfInv: Float32Array,
    selfAlpha: Uint8ClampedArray,
    candInv: Float32Array,
    cands: Array<{ alpha: Uint8ClampedArray; w: number; h: number }>,
  ): { scalar: number; wasm: number } {
    if (!wasm) throw new Error('wasm not initialized');
    const { batch_touching_drawables, SilhouetteBuffer, memory } = wasm;
    const selfW = selfAlpha.length / 4;
    // All silhouettes are square in this test for simplicity:
    const selfH = selfW;
    const scalarSelf = { width: selfW, height: selfH, data: selfAlpha };
    const scalarCands = cands.map((c) => ({
      width: c.w,
      height: c.h,
      data: c.alpha,
    }));
    const scalarResult = scalarBatch(bl, br, bb, bt, selfInv, scalarSelf, candInv, scalarCands);
    const selfBuf = new SilhouetteBuffer(selfW, selfH);
    fillSilhouette(selfBuf, memory, selfAlpha);
    const candBufs = cands.map((c) => {
      const buf = new SilhouetteBuffer(c.w, c.h);
      fillSilhouette(buf, memory, c.alpha);
      return buf;
    });
    const offsets = new Uint32Array(candBufs.length);
    const dims = new Uint32Array(candBufs.length * 2);
    for (let i = 0; i < candBufs.length; i += 1) {
      const b = candBufs[i]!;
      const ptr = b.data_ptr();
      // Per the Rust fix: offsets are absolute pointers in WASM memory.
      offsets[i] = ptr >>> 0;
      dims[i * 2] = b.width();
      dims[i * 2 + 1] = b.height();
    }
    const wasmResult = batch_touching_drawables(
      bl,
      br,
      bb,
      bt,
      selfInv,
      selfBuf,
      candInv,
      offsets,
      dims,
      candBufs.length,
    );
    return { scalar: scalarResult, wasm: wasmResult };
  }

  function expectParity(label: string, bl: number, br: number, bb: number, bt: number,
    selfInv: Float32Array, selfAlpha: Uint8ClampedArray, candInv: Float32Array,
    cands: Array<{ alpha: Uint8ClampedArray; w: number; h: number }>) {
    const { scalar, wasm: w } = runBoth(bl, br, bb, bt, selfInv, selfAlpha, candInv, cands);
    expect(w, `${label}: WASM result`).toBe(scalar);
    expect(scalar, `${label}: scalar result is 0 or 1`).toBeGreaterThanOrEqual(0);
    expect(scalar, `${label}: scalar result is 0 or 1`).toBeLessThanOrEqual(1);
  }

  it('1x1 bounds, identity, full overlap', () => {
    expectParity('1x1-identity-full', 0, 0, 0, 0,
      identityMatrix(), makeSolidSil(1, 1),
      identityMatrix(), [{ alpha: makeSolidSil(1, 1), w: 1, h: 1 }]);
  });

  it('1x1 bounds, no overlap (translated)', () => {
    // Self translated to (10, 10) but bounds at origin — no candidate pixels
    // map inside the bounds.
    expectParity('1x1-identity-translated', 0, 0, 0, 0,
      translationMatrix(10, 10), makeSolidSil(4, 4),
      identityMatrix(), [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('4x4 bounds, SIMD-aligned, identity', () => {
    expectParity('4x4-identity', 0, 3, 0, 3,
      identityMatrix(), makeSolidSil(4, 4),
      identityMatrix(), [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('5x5 bounds, SIMD-aligned body + 1-pixel tail', () => {
    expectParity('5x5-identity', 0, 4, 0, 4,
      identityMatrix(), makeSolidSil(4, 4),
      identityMatrix(), [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('8x8 bounds, multiple SIMD iterations, no overlap', () => {
    // Self visible at origin, candidate far away (translated 100,100).
    const candInv = translationMatrix(100, 100);
    expectParity('8x8-no-overlap', 0, 7, 0, 7,
      identityMatrix(), makeSolidSil(4, 4),
      candInv, [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('multiple candidates (4)', () => {
    expectParity('4cands-identity', 0, 3, 0, 3,
      identityMatrix(), makeSolidSil(4, 4),
      identityMatrix(),
      [
        { alpha: makeSolidSil(4, 4), w: 4, h: 4 },
        { alpha: makeSolidSil(4, 4), w: 4, h: 4 },
        { alpha: makeSolidSil(4, 4), w: 4, h: 4 },
        { alpha: makeSolidSil(4, 4), w: 4, h: 4 },
      ]);
  });

  it('transparent self silhouette never collides', () => {
    const empty = new Uint8ClampedArray(4 * 4 * 4); // all zero
    expectParity('transparent-self', 0, 3, 0, 3,
      identityMatrix(), empty,
      identityMatrix(), [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('perspective matrix (m[3]=m[7]=0.01, m[15]=1) with identity candidate', () => {
    const inv = new Float32Array([
      1, 0, 0, 0.01,
      0, 1, 0, 0.01,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    expectParity('perspective', 0, 3, 0, 3,
      inv, makeSolidSil(4, 4),
      identityMatrix(), [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('wide bounds 32x1 forces long SIMD sweep', () => {
    // Self visible 0..31, candidate translated 16 px to the right.
    const candInv = translationMatrix(-16, 0);
    expectParity('32x1-shift', 0, 31, 0, 0,
      identityMatrix(), makeSolidSil(4, 4),
      candInv, [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }]);
  });

  it('empty bounds returns 0', () => {
    if (!wasm) throw new Error('wasm not initialized');
    const { batch_touching_drawables, SilhouetteBuffer, memory } = wasm;
    const buf = new SilhouetteBuffer(4, 4);
    fillSilhouette(buf, memory, makeSolidSil(4, 4));
    expect(batch_touching_drawables(0, -1, 0, 0,
      identityMatrix(), buf, new Float32Array(0),
      new Uint32Array(0), new Uint32Array(0), 0)).toBe(0);
  });
});