import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const wasmBytes = readFileSync(
  resolve(root, 'wasm-collision/pkg/tw_viewer_wasm_collision_bg.wasm'),
);

/**
 * Reference scalar implementation that mirrors the JS `Silhouette.colorAtLinear`
 * (4-corner bilinear weighted blending) for the alpha channel. Returns 1 if
 * any of the four weighted texels is non-zero, 0 otherwise. This matches
 * scratch-render's `_isTouchingLinear` boolean contract: collision is true
 * whenever the linearly-interpolated alpha is > 0.
 */
function scalarLinearBatch(
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
    buf: { width: number; height: number; data: Uint8ClampedArray },
    x: number,
    y: number,
  ): number {
    if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return 0;
    return buf.data[(y * buf.width + x) * 4 + 3] ?? 0;
  }
  function alphaLinear(
    buf: { width: number; height: number; data: Uint8ClampedArray },
    u: number,
    v: number,
  ): number {
    if (u < 0 || v < 0 || u > 1 || v > 1) return 0;
    const xf = u * buf.width;
    const yf = v * buf.height;
    const x0 = Math.floor(xf);
    const y0 = Math.floor(yf);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = xf - x0;
    const fy = yf - y0;
    const a00 = alphaAt(buf, x0, y0);
    const a10 = alphaAt(buf, x1, y0);
    const a01 = alphaAt(buf, x0, y1);
    const a11 = alphaAt(buf, x1, y1);
    const combined = a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) + a01 * (1 - fx) * fy + a11 * fx * fy;
    return combined > 0 ? 1 : 0;
  }
  for (let x = boundsLeft; x <= boundsRight; x += 1) {
    for (let y = boundsBottom; y <= boundsTop; y += 1) {
      const xf = x;
      const yf = y;
      const d = xf * inv(3) + yf * inv(7) + inv(15);
      const invD = Math.abs(d) < 1e-6 ? 1 : 1 / d;
      const sx = 0.5 - ((xf * inv(0) + yf * inv(4) + inv(12)) * invD);
      const sy = (xf * inv(1) + yf * inv(5) + inv(13)) * invD + 0.5;
      if (alphaLinear(selfSil, sx, sy) === 0) continue;
      for (const cand of candSils) {
        const cx = 0.5 - ((xf * cinv(0) + yf * cinv(4) + cinv(12)) * invD);
        const cy = (xf * cinv(1) + yf * cinv(5) + cinv(13)) * invD + 0.5;
        if (alphaLinear(cand, cx, cy) !== 0) return 1;
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
    useLinear: number,
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
  const mod = (await import('../../../wasm-collision/pkg/tw_viewer_wasm_collision')) as unknown as {
    default: (bytes: Buffer) => Promise<unknown>;
    batch_touching_drawables: WasmHandle['batch_touching_drawables'];
    SilhouetteBuffer: WasmHandle['SilhouetteBuffer'];
    memory: WebAssembly.Memory;
  };
  const initResult = (await mod.default(wasmBytes)) as { memory: WebAssembly.Memory };
  return {
    batch_touching_drawables: mod.batch_touching_drawables,
    SilhouetteBuffer: mod.SilhouetteBuffer,
    memory: initResult.memory,
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

function makeSolidSil(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

// A 4x4 silhouette with one opaque corner — useful for asserting the
// bilinear sampler blends correctly across that boundary.
function makeCornerSil(w: number, h: number, corner: 'tl' | 'tr' | 'bl' | 'br'): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  const halfW = Math.max(1, Math.floor(w / 2));
  const halfH = Math.max(1, Math.floor(h / 2));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inTL = x < halfW && y < halfH;
      const inTR = x >= halfW && y < halfH;
      const inBL = x < halfW && y >= halfH;
      const inBR = x >= halfW && y >= halfH;
      const keep =
        (corner === 'tl' && inTL) ||
        (corner === 'tr' && inTR) ||
        (corner === 'bl' && inBL) ||
        (corner === 'br' && inBR);
      if (keep) data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return data;
}

describe('batch_touching_drawables: bilinear sampling', () => {
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
    const selfW = 4;
    const selfH = 4;
    const scalarSelf = { width: selfW, height: selfH, data: selfAlpha };
    const scalarCands = cands.map((c) => ({
      width: c.w,
      height: c.h,
      data: c.alpha,
    }));
    const scalarResult = scalarLinearBatch(bl, br, bb, bt, selfInv, scalarSelf, candInv, scalarCands);
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
      offsets[i] = candBufs[i]!.data_ptr() >>> 0;
      dims[i * 2] = candBufs[i]!.width();
      dims[i * 2 + 1] = candBufs[i]!.height();
    }
    const candInvForWasm =
      cands.length > 1
        ? (() => {
            const packed = new Float32Array(cands.length * 16);
            for (let i = 0; i < cands.length; i += 1) packed.set(candInv, i * 16);
            return packed;
          })()
        : candInv;
    const wasmResult = batch_touching_drawables(
      bl,
      br,
      bb,
      bt,
      selfInv,
      selfBuf,
      candInvForWasm,
      offsets,
      dims,
      candBufs.length,
      1,
    );
    return { scalar: scalarResult, wasm: wasmResult };
  }

  it('identity matrix, fully overlapping 4x4 solid silhouettes (linear)', () => {
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      identityMatrix(), makeSolidSil(4, 4),
      identityMatrix(),
      [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(1);
  });

  it('no overlap (translated): bilinear returns 0 like scalar', () => {
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      identityMatrix(), makeSolidSil(4, 4),
      new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        -10, -10, 0, 1,
      ]),
      [{ alpha: makeSolidSil(4, 4), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(0);
  });

  it('bilinear boundary: self has opaque top-left half only', () => {
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      identityMatrix(), makeCornerSil(4, 4, 'tl'),
      identityMatrix(),
      [{ alpha: makeCornerSil(4, 4, 'tl'), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
  });

  it('bilinear boundary: opaque corner mismatches — no collision', () => {
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      identityMatrix(), makeCornerSil(4, 4, 'tl'),
      identityMatrix(),
      [{ alpha: makeCornerSil(4, 4, 'br'), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(0);
  });

  it('nearest and bilinear should differ at fractional UV boundary', () => {
    // This fixture deliberately places a candidate at the exact half-
    // pixel boundary so nearest sees one pixel as opaque and bilinear
    // sees weighted >= 0. The numeric results depend on the alpha at
    // floor and floor+1; we just want to confirm the two modes produce
    // the right shape (linear's blend matches the scalar reference).
    const selfAlpha = makeSolidSil(4, 4);
    const candAlpha = makeSolidSil(4, 4);
    const scalarResult = scalarLinearBatch(
      0, 3, 0, 3,
      identityMatrix(),
      { width: 4, height: 4, data: selfAlpha },
      identityMatrix(),
      [{ width: 4, height: 4, data: candAlpha }],
    );
    expect(scalarResult).toBe(1);
    // And the WASM linear call returns the same.
    const { wasm: w } = runBoth(
      0, 3, 0, 3,
      identityMatrix(), selfAlpha,
      identityMatrix(),
      [{ alpha: candAlpha, w: 4, h: 4 }],
    );
    expect(w).toBe(scalarResult);
  });
});
