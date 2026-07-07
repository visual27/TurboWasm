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
 * Reference scalar implementation that mirrors the JS baseline
 * `RenderWebGL.isTouchingColor` (without the per-sprite visual effects —
 * see `effect-detection.ts` for why those are JS-fallback territory).
 *
 *   - Target color in `[target_r, target_g, target_b]`.
 *   - Optional mask color in `[mask_r, mask_g, mask_b]`.
 *   - For each pixel `(x, y)` of bounds:
 *       - Sample self silhouette RGBA at the perspective-mapped UV.
 *       - If `hasMask`, require `RGBA ≈ mask_color` AND `alpha > 0`.
 *       - Otherwise require only `alpha > 0`.
 *       - Sample each candidate silhouette; on any candidate pixel with
 *         `RGB ≈ target_color` AND `alpha > 0`, return 1.
 *   - Otherwise return 0.
 *
 * Tolerance = 2 (matches scratch-render's `colorMatches`).
 */
function scalarColorBatch(
  boundsLeft: number,
  boundsRight: number,
  boundsBottom: number,
  boundsTop: number,
  targetR: number,
  targetG: number,
  targetB: number,
  maskR: number,
  maskG: number,
  maskB: number,
  selfInv: Float32Array,
  selfSil: { width: number; height: number; data: Uint8ClampedArray },
  candInv: Float32Array,
  candSils: Array<{ width: number; height: number; data: Uint8ClampedArray }>,
): number {
  const inv = (i: number) => selfInv[i] ?? 0;
  const cinv = (i: number) => candInv[i] ?? 0;
  const tol = 2;
  const hasMask = maskR >= 0 && maskG >= 0 && maskB >= 0;
  function rgbaAt(
    buf: { width: number; height: number; data: Uint8ClampedArray },
    x: number,
    y: number,
  ): [number, number, number, number] {
    if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return [0, 0, 0, 0];
    const off = (y * buf.width + x) * 4;
    return [buf.data[off] ?? 0, buf.data[off + 1] ?? 0, buf.data[off + 2] ?? 0, buf.data[off + 3] ?? 0];
  }
  for (let x = boundsLeft; x <= boundsRight; x += 1) {
    for (let y = boundsBottom; y <= boundsTop; y += 1) {
      const xf = x;
      const yf = y;
      const d = xf * inv(3) + yf * inv(7) + inv(15);
      const invD = Math.abs(d) < 1e-6 ? 1 : 1 / d;
      const u = 0.5 - ((xf * inv(0) + yf * inv(4) + inv(12)) * invD);
      const v = (xf * inv(1) + yf * inv(5) + inv(13)) * invD + 0.5;
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      const px = Math.trunc(u * selfSil.width);
      const py = Math.trunc(v * selfSil.height);
      const selfRgba = rgbaAt(selfSil, px, py);
      if (selfRgba[3] === 0) continue;
      if (hasMask) {
        if (Math.abs(selfRgba[0] - maskR) > tol) continue;
        if (Math.abs(selfRgba[1] - maskG) > tol) continue;
        if (Math.abs(selfRgba[2] - maskB) > tol) continue;
      }
      for (const cand of candSils) {
        const cx = 0.5 - ((xf * cinv(0) + yf * cinv(4) + cinv(12)) * invD);
        const cy = (xf * cinv(1) + yf * cinv(5) + cinv(13)) * invD + 0.5;
        if (cx < 0 || cy < 0 || cx > 1 || cy > 1) continue;
        const cp = rgbaAt(cand, Math.trunc(cx * cand.width), Math.trunc(cy * cand.height));
        if (cp[3] === 0) continue;
        if (Math.abs(cp[0] - targetR) <= tol
          && Math.abs(cp[1] - targetG) <= tol
          && Math.abs(cp[2] - targetB) <= tol) {
          return 1;
        }
      }
    }
  }
  return 0;
}

interface WasmHandle {
  batch_touching_color: (
    bl: number,
    br: number,
    bb: number,
    bt: number,
    tr: number, tg: number, tb: number,
    mr: number, mg: number, mb: number,
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
    default: (bytes: Buffer) => Promise<{ memory: WebAssembly.Memory }>;
    batch_touching_color: WasmHandle['batch_touching_color'];
    SilhouetteBuffer: WasmHandle['SilhouetteBuffer'];
  };
  const initResult = await mod.default(wasmBytes);
  return {
    batch_touching_color: mod.batch_touching_color,
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

// A 4x4 RGBA silhouette: green pixels (0, 255, 0, 255). All target-color
// collision tests use this — with an identical candidate, every pixel
// should hit exactly the target color.
function makeGreenSil(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 255;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  return data;
}

describe('batch_touching_color: SIMD vs scalar parity', () => {
  beforeAll(async () => {
    wasm = await loadWasm();
  });

  function runBoth(
    bl: number, br: number, bb: number, bt: number,
    tr: number, tg: number, tb: number,
    mr: number, mg: number, mb: number,
    selfInv: Float32Array,
    selfAlpha: Uint8ClampedArray,
    candInv: Float32Array,
    cands: Array<{ alpha: Uint8ClampedArray; w: number; h: number }>,
  ): { scalar: number; wasm: number } {
    if (!wasm) throw new Error('wasm not initialized');
    const { batch_touching_color, SilhouetteBuffer, memory } = wasm;
    const selfW = 4;
    const selfH = 4;
    const scalarSelf = { width: selfW, height: selfH, data: selfAlpha };
    const scalarCands = cands.map((c) => ({
      width: c.w, height: c.h, data: c.alpha,
    }));
    const scalarResult = scalarColorBatch(
      bl, br, bb, bt,
      tr, tg, tb, mr, mg, mb,
      selfInv, scalarSelf,
      candInv, scalarCands,
    );
    const selfBuf = new SilhouetteBuffer(selfW, selfH);
    fillSilhouette(selfBuf, memory, selfAlpha);
    const candBufs = cands.map((c) => {
      const buf = new SilhouetteBuffer(c.w, c.h);
      fillSilhouette(buf, memory, c.alpha);
      return buf;
    });
    // Replicate the same candInv for every candidate index the WASM
    // consumes (see batch-touching-drawables-bit-identical.test.ts
    // runBoth for the same rationale).
    const candInvForWasm =
      cands.length > 1
        ? (() => {
            const packed = new Float32Array(cands.length * 16);
            for (let i = 0; i < cands.length; i += 1) packed.set(candInv, i * 16);
            return packed;
          })()
        : candInv;
    const offsets = new Uint32Array(candBufs.length);
    const dims = new Uint32Array(candBufs.length * 2);
    for (let i = 0; i < candBufs.length; i += 1) {
      offsets[i] = candBufs[i]!.data_ptr() >>> 0;
      dims[i * 2] = candBufs[i]!.width();
      dims[i * 2 + 1] = candBufs[i]!.height();
    }
    const wasmResult = batch_touching_color(
      bl, br, bb, bt,
      tr, tg, tb, mr, mg, mb,
      selfInv, selfBuf,
      candInvForWasm, offsets, dims, candBufs.length, 0,
    );
    return { scalar: scalarResult, wasm: wasmResult };
  }

  it('target color present in self-and-candidate overlap (no mask)', () => {
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      0, 255, 0, -1, -1, -1,
      identityMatrix(), makeGreenSil(),
      identityMatrix(),
      [{ alpha: makeGreenSil(), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(1);
  });

  it('target color absent — no collision', () => {
    // Target red, candidate green.
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      255, 0, 0, -1, -1, -1,
      identityMatrix(), makeGreenSil(),
      identityMatrix(),
      [{ alpha: makeGreenSil(), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(0);
  });

  it('mask matches self but no candidate target pixel — no collision', () => {
    // Target red, mask == self color. Self passes the mask, but no
    // candidate pixel is red.
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      255, 0, 0,
      0, 255, 0, // mask = green
      identityMatrix(), makeGreenSil(),
      identityMatrix(),
      [{ alpha: makeGreenSil(), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(0);
  });

  it('perspective matrix with small m[3] still lands pixel (0,0) on target — collision', () => {
    // (xf=0, yf=0) maps to uv (0.5, 0.5) on the self silhouette; the
    // candidate likewise. Both pixels are (0, 255, 0, 255), matching
    // the target. So this case still produces a collision, even with
    // m[3]=m[7]=0.01. We use it to verify the perspective-divide
    // plumbing without divergence — the scalar and WASM should agree.
    const inv = new Float32Array([
      1, 0, 0, 0.01,
      0, 1, 0, 0.01,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      0, 255, 0, -1, -1, -1,
      inv, makeGreenSil(),
      identityMatrix(),
      [{ alpha: makeGreenSil(), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(1);
  });

  it('large translation pushes candidates off-stage — no collision', () => {
    const candFar = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      -100, -100, 0, 1,
    ]);
    const { scalar, wasm: w } = runBoth(
      0, 3, 0, 3,
      0, 255, 0, -1, -1, -1,
      identityMatrix(), makeGreenSil(),
      candFar,
      [{ alpha: makeGreenSil(), w: 4, h: 4 }],
    );
    expect(w).toBe(scalar);
    expect(scalar).toBe(0);
  });

  it('empty candidate list → returns 0', () => {
    if (!wasm) throw new Error('wasm not initialized');
    const { batch_touching_color, SilhouetteBuffer, memory } = wasm;
    const buf = new SilhouetteBuffer(4, 4);
    fillSilhouette(buf, memory, makeGreenSil());
    const r = batch_touching_color(
      0, 3, 0, 3,
      0, 255, 0, -1, -1, -1,
      identityMatrix(), buf,
      new Float32Array(0),
      new Uint32Array(0),
      new Uint32Array(0),
      0,
      0,
    );
    expect(r).toBe(0);
  });
});
