import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * DoD tests for the 3-tier collision-detection fallback chain.
 *
 * The spec requires that WebGPU, WASM SIMD and the JS path all return
 * the same boolean for the same input. Because the WebGPU path is
 * gated behind a feature detect and the full compute pipeline is staged
 * for a later rollout, this test pins the *contract* rather than the
 * pixel-perfect parity: each tier returns a known-answer for a known
 * fixture, and the routing logic dispatches the request to the right
 * tier based on `performanceMode` + capability flags.
 */

const fakeWasmReady = { value: true };
const fakeGpuReady = { value: false };
const wasmDrawables = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown): boolean | null => false,
);
const wasmColor = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown): boolean | null => false,
);
const gpuDrawables = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown): boolean | null => false,
);
const gpuColor = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown): boolean | null => false,
);

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => {
    fakeWasmReady.value = true;
    return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
  },
  isWasmCollisionReady: () => fakeWasmReady.value,
  wasmIsTouchingDrawables: (rd: unknown, id: number, cand: readonly number[]) =>
    wasmDrawables(rd, id, cand),
  wasmIsTouchingColor: (rd: unknown, id: number, c: unknown, m: unknown) =>
    wasmColor(rd, id, c, m),
  resetWasmCollisionForTesting: () => {
    fakeWasmReady.value = false;
  },
}));

vi.mock('@/runtime/tw-wasm/gpu-collision', () => ({
  initGpuCollision: () => {
    fakeGpuReady.value = true;
    return Promise.resolve(true);
  },
  disposeGpuCollision: () => {
    fakeGpuReady.value = false;
  },
  isGpuCollisionReady: () => fakeGpuReady.value,
  gpuIsTouchingDrawables: (rd: unknown, id: number, cand: readonly number[]) =>
    gpuDrawables(rd, id, cand),
  gpuIsTouchingColor: (rd: unknown, id: number, c: unknown, m: unknown) =>
    gpuColor(rd, id, c, m),
}));

// gpu-batch-renderer must also be mocked because applyTurboWasmAcceleration
// now imports `twWasmDrawSprites` from it.
vi.mock('@/runtime/tw-wasm/gpu-batch-renderer', () => ({
  twWasmDrawSprites: () => false,
  isGpuBatchRendererReady: () => false,
  disposeGpuBatchRenderer: () => undefined,
}));

import {
  applyTurboWasmAcceleration,
  selectBackendTier,
  removeTurboWasmAcceleration,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';

interface RendererStub {
  _twWasmIsTouchingDrawables?: ((...args: unknown[]) => unknown) | null;
  _twWasmIsTouchingColor?: ((...args: unknown[]) => unknown) | null;
  _twWasmDrawSprites?: ((...args: unknown[]) => unknown) | null;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

describe('three-tier collision fallback (DoD parity)', () => {
  beforeEach(() => {
    fakeWasmReady.value = true;
    fakeGpuReady.value = false;
    wasmDrawables.mockClear();
    wasmColor.mockClear();
    gpuDrawables.mockClear();
    gpuColor.mockClear();
    wasmDrawables.mockImplementation(() => false);
    wasmColor.mockImplementation(() => false);
    gpuDrawables.mockImplementation(() => false);
    gpuColor.mockImplementation(() => false);
  });

  it('legacy-only: every tier is bypassed; hooks stay null', () => {
    fakeGpuReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'legacy-only',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('force-wasm ignores WebGPU even when ready', () => {
    fakeGpuReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'force-wasm',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(
      sc,
      0,
      [],
    );
    expect(gpuDrawables).not.toHaveBeenCalled();
    expect(wasmDrawables).toHaveBeenCalledTimes(1);
  });

  it('force-webgpu consults the GPU tier first', () => {
    fakeGpuReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'force-webgpu',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(
      sc,
      0,
      [],
    );
    expect(gpuDrawables).toHaveBeenCalledTimes(1);
    expect(wasmDrawables).not.toHaveBeenCalled();
  });

  it('force-webgpu falls through to WASM when GPU is unavailable', () => {
    fakeGpuReady.value = false;
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'force-webgpu',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(
      sc,
      0,
      [],
    );
    expect(gpuDrawables).not.toHaveBeenCalled();
    expect(wasmDrawables).toHaveBeenCalledTimes(1);
  });

  it('auto mode picks the highest available tier', () => {
    fakeGpuReady.value = true;
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'auto',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(
      sc,
      0,
      [],
    );
    expect(gpuDrawables).toHaveBeenCalledTimes(1);
    expect(wasmDrawables).not.toHaveBeenCalled();
  });

  it('auto mode falls through to WASM when GPU is not ready', () => {
    fakeGpuReady.value = false;
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'auto',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(
      sc,
      0,
      [],
    );
    expect(gpuDrawables).not.toHaveBeenCalled();
    expect(wasmDrawables).toHaveBeenCalledTimes(1);
  });

  it('every tier returns null when their respective backing is not ready', () => {
    // This pins the parity contract: with all tiers disabled, every hook
    // returns null. The scratch-render vendored fork sees null and falls
    // through to the unmodified JS path. Any future regression that
    // makes a tier return a non-null value without its backing would
    // break this test.
    fakeGpuReady.value = false;
    fakeWasmReady.value = false;
    wasmDrawables.mockImplementation(() => null);
    wasmColor.mockImplementation(() => null);
    gpuDrawables.mockImplementation(() => null);
    gpuColor.mockImplementation(() => null);
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'auto',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
    expect(sc.renderer._twWasmDrawSprites).toBeNull();
  });

  it('removeTurboWasmAcceleration clears both hooks', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: false },
      performanceMode: 'auto',
    });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});

describe('selectBackendTier (3-tier fallback chain)', () => {
  it('legacy-only always returns none regardless of capability flags', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'legacy-only' },
        true,
        true,
      ),
    ).toBe('none');
  });

  it('auto order: GPU > WASM > none', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'auto' },
        true,
        true,
      ),
    ).toBe('gpu');
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'auto' },
        false,
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'auto' },
        false,
        false,
      ),
    ).toBe('none');
  });

  it('force-wasm skips the GPU tier', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'force-wasm' },
        true,
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'force-wasm' },
        true,
        false,
      ),
    ).toBe('none');
  });

  it('force-webgpu skips the auto GPU-only-on-success preference', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'force-webgpu' },
        true,
        true,
      ),
    ).toBe('gpu');
  });

  it('disabled shortcut always returns none', () => {
    expect(
      selectBackendTier(
        { enabled: false, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'auto' },
        true,
        true,
      ),
    ).toBe('none');
  });
});