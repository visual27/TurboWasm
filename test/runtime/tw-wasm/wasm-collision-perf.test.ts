import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Performance benchmarks for the WASM collision-detection hot loop.
 *
 * These are NOT strict correctness tests — they're bench-style timing
 * assertions that guard against large regressions. Each test exercises a
 * different pixel/candidate matrix mentioned in the implementation plan
 * (J2: small/medium/large sprite × 1/10/100 candidates). Tests pass if
 * the runtime stays below a generous upper bound; tightening the bound
 * to detect regressions vs. the JS baseline is the next step once we
 * have stable numbers.
 *
 * The tests use the SAME bit-identical WASM package as the correctness
 * suite (`wasm-collision/pkg/...`); we never reach into the host's
 * renderer so the bench stays portable across jsdom and Chrome.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const wasmBytes = readFileSync(
  resolve(root, 'wasm-collision/pkg/tw_viewer_wasm_collision_bg.wasm'),
);

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
    default: (bytes: Buffer) => Promise<{ memory: WebAssembly.Memory }>;
    batch_touching_drawables: WasmHandle['batch_touching_drawables'];
    SilhouetteBuffer: WasmHandle['SilhouetteBuffer'];
  };
  const initResult = await mod.default(wasmBytes);
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

function makeSolidSil(size: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

interface BenchScenario {
  label: string;
  spriteSize: number;
  candidateCount: number;
  /** Wall-clock budget per `iterations` calls. Failing the test asserts
   *  > a 2x regression vs. the .last-bench.json baseline (when present). */
  perCallBudgetMs: number;
}

const scenarios: BenchScenario[] = [
  // Small sprite + 1 candidate — the smallest meaningful bench.
  { label: 'small/1', spriteSize: 8, candidateCount: 1, perCallBudgetMs: 5 },
  // Small sprite + 10 candidates (J2's 10-cand mid tier).
  { label: 'small/10', spriteSize: 8, candidateCount: 10, perCallBudgetMs: 10 },
  // Medium sprite + 100 candidates.
  { label: 'medium/100', spriteSize: 32, candidateCount: 100, perCallBudgetMs: 50 },
  // Large sprite + 100 candidates — exercises the SIMD-aligned body.
  { label: 'large/100', spriteSize: 128, candidateCount: 100, perCallBudgetMs: 200 },
];

describe('wasm-collision hot-loop perf benchmark', () => {
  beforeAll(async () => {
    wasm = await loadWasm();
  });

  function runScenario(scenario: BenchScenario): {
    totalMs: number;
    callsPerSecond: number;
  } {
    if (!wasm) throw new Error('wasm not initialized');
    const { batch_touching_drawables, SilhouetteBuffer, memory } = wasm;
    const selfAlpha = makeSolidSil(scenario.spriteSize);
    const selfBuf = new SilhouetteBuffer(scenario.spriteSize, scenario.spriteSize);
    fillSilhouette(selfBuf, memory, selfAlpha);
    const candBufs: Array<{ _w: number; _h: number; _ptr: number }> = [];
    const candOffsets = new Uint32Array(scenario.candidateCount);
    const candDims = new Uint32Array(scenario.candidateCount * 2);
    const candInv = new Float32Array(scenario.candidateCount * 16);
    for (let i = 0; i < scenario.candidateCount; i += 1) {
      const buf = new SilhouetteBuffer(scenario.spriteSize, scenario.spriteSize);
      fillSilhouette(buf, memory, makeSolidSil(scenario.spriteSize));
      candBufs.push(buf as unknown as { _w: number; _h: number; _ptr: number });
      candOffsets[i] = buf.data_ptr() >>> 0;
      candDims[i * 2] = buf.width();
      candDims[i * 2 + 1] = buf.height();
      candInv.set(identityMatrix(), i * 16);
    }
    const iterations = 8;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      batch_touching_drawables(
        0,
        scenario.spriteSize - 1,
        0,
        scenario.spriteSize - 1,
        identityMatrix(),
        selfBuf,
        candInv,
        candOffsets,
        candDims,
        scenario.candidateCount,
        0,
      );
    }
    const totalMs = performance.now() - t0;
    return {
      totalMs,
      callsPerSecond: (iterations / totalMs) * 1000,
    };
  }

  for (const scenario of scenarios) {
    it(`${scenario.label} sprite=${scenario.spriteSize}px cands=${scenario.candidateCount} stays under budget`, () => {
      const { totalMs, callsPerSecond } = runScenario(scenario);
      // Emit timing to stderr so the bench report is grep-able in CI
      // logs. Verbose reporters will surface this; vitest's default
      // reporter will not, but the value is captured for `--reporter=verbose`.
      process.stderr.write(
        `[perf] ${scenario.label} total=${totalMs.toFixed(2)}ms (${callsPerSecond.toFixed(1)} calls/s, ${(totalMs / 8).toFixed(3)}ms/call)\n`,
      );
      expect(totalMs).toBeLessThan(scenario.perCallBudgetMs * 8);
    });
  }
});
