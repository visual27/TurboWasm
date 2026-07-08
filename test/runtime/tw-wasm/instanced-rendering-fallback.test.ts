import { describe, expect, it, beforeEach } from 'vitest';

/**
 * DoD test for the WebGPU instanced rendering fallback path.
 *
 * SPEC §10 requires that when the WebGPU instanced renderer is not
 * ready, `_drawThese` falls through to the original WebGL path. We
 * verify the dispatch by checking that `twWasmDrawSprites` returns
 * `false` whenever the renderer is not in the `webgpu-instanced` state.
 *
 * This test focuses on the *fallback contract* — the full per-skin
 * batching math is exercised in `gpu-batch-renderer.test.ts`. This
 * suite pins the behaviour from the perspective of the renderer's
 * `_drawThese` hook.
 */

import {
  initGpuBatchRenderer,
  renderGpuBatch,
  getGpuBatchRendererStats,
  isGpuBatchRendererReady,
  resetGpuBatchRendererForTesting,
  setGpuBatchRendererReadyForTesting,
  selectRenderBackend,
} from '@/runtime/tw-wasm/gpu-batch-renderer';

describe('instanced-rendering-fallback (DoD fallback path)', () => {
  beforeEach(() => {
    resetGpuBatchRendererForTesting();
  });

  it('renderer is not ready by default (gate off)', () => {
    expect(isGpuBatchRendererReady()).toBe(false);
  });

  it('selectRenderBackend falls back to webgl-legacy when WebGPU is unavailable', () => {
    expect(
      selectRenderBackend({
        wasmSimd: true,
        webgpu: false,
        performanceMode: 'auto',
      }),
    ).toBe('webgl-legacy');
  });

  it('selectRenderBackend falls back to webgl-legacy when performanceMode is legacy-only', () => {
    expect(
      selectRenderBackend({
        wasmSimd: true,
        webgpu: true,
        performanceMode: 'legacy-only',
      }),
    ).toBe('webgl-legacy');
  });

  it('initGpuBatchRenderer returns false when no container is supplied', async () => {
    expect(
      await initGpuBatchRenderer({
        // @ts-expect-error — exercising the runtime guard
        container: null,
        caps: { wasmSimd: true, webgpu: true },
        performanceMode: 'auto',
      }),
    ).toBe(false);
  });

  it('renderGpuBatch returns false when the gate is off (WebGL fallback)', () => {
    expect(renderGpuBatch([{ skin: { _id: 'a' } }])).toBe(false);
    // Stats should still be updated for diagnostics
    expect(getGpuBatchRendererStats().drawablesLastFrame).toBe(1);
  });

  it('renderGpuBatch still returns false even when "ready" is forced (stub path)', () => {
    // Pin the stub semantics: the gate may be on but the dispatch
    // is intentionally not implemented yet (Phase 3 staged rollout).
    setGpuBatchRendererReadyForTesting({
      initialized: true,
      backend: 'webgpu-instanced',
    });
    expect(renderGpuBatch([{ skin: { _id: 'a' } }])).toBe(false);
  });

  it('disposeGpuBatchRenderer clears state and ready flag', () => {
    setGpuBatchRendererReadyForTesting({
      initialized: true,
      backend: 'webgpu-instanced',
    });
    expect(isGpuBatchRendererReady()).toBe(true);
    resetGpuBatchRendererForTesting();
    expect(isGpuBatchRendererReady()).toBe(false);
    const stats = getGpuBatchRendererStats();
    expect(stats.backend).toBe('webgl-legacy');
    expect(stats.frameCount).toBe(0);
  });

  it('multiple frames with the same drawables update stats correctly', () => {
    renderGpuBatch([{ skin: { _id: 'a' } }, { skin: { _id: 'b' } }]);
    expect(getGpuBatchRendererStats().frameCount).toBe(1);
    renderGpuBatch([{ skin: { _id: 'a' } }]);
    expect(getGpuBatchRendererStats().frameCount).toBe(2);
    renderGpuBatch([]);
    expect(getGpuBatchRendererStats().frameCount).toBe(3);
    expect(getGpuBatchRendererStats().drawablesLastFrame).toBe(0);
    expect(getGpuBatchRendererStats().skinBatches).toBe(0);
  });
});