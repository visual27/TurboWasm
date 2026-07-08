import { describe, expect, it, beforeEach } from 'vitest';
import {
  initGpuBatchRenderer,
  renderGpuBatch,
  disposeGpuBatchRenderer,
  getGpuBatchRendererStats,
  selectRenderBackend,
  resetGpuBatchRendererForTesting,
  setGpuBatchRendererReadyForTesting,
  twWasmDrawSprites,
  isGpuBatchRendererReady,
} from '@/runtime/tw-wasm/gpu-batch-renderer';

describe('gpu-batch-renderer (Phase 3 WebGPU instanced rendering)', () => {
  beforeEach(() => {
    resetGpuBatchRendererForTesting();
  });

  describe('selectRenderBackend', () => {
    it('returns webgl-legacy when WebGPU is not available', () => {
      expect(
        selectRenderBackend({
          wasmSimd: true,
          webgpu: false,
          performanceMode: 'auto',
        }),
      ).toBe('webgl-legacy');
    });

    it('returns webgpu-instanced when WebGPU is available', () => {
      expect(
        selectRenderBackend({
          wasmSimd: true,
          webgpu: true,
          performanceMode: 'auto',
        }),
      ).toBe('webgpu-instanced');
    });

    it('returns webgl-legacy when legacy-only is selected regardless of WebGPU', () => {
      expect(
        selectRenderBackend({
          wasmSimd: true,
          webgpu: true,
          performanceMode: 'legacy-only',
        }),
      ).toBe('webgl-legacy');
    });
  });

  describe('initGpuBatchRenderer', () => {
    it('returns false when no container is supplied', async () => {
      expect(
        await initGpuBatchRenderer({
          // @ts-expect-error — exercising the runtime guard
          container: null,
          caps: { wasmSimd: true, webgpu: true },
          performanceMode: 'auto',
        }),
      ).toBe(false);
    });

    it('returns false when WebGPU is unavailable', async () => {
      const container = document.createElement('div');
      expect(
        await initGpuBatchRenderer({
          container,
          caps: { wasmSimd: true, webgpu: false },
          performanceMode: 'auto',
        }),
      ).toBe(false);
      expect(isGpuBatchRendererReady()).toBe(false);
    });

    it('returns false when performanceMode is legacy-only', async () => {
      const container = document.createElement('div');
      expect(
        await initGpuBatchRenderer({
          container,
          caps: { wasmSimd: true, webgpu: true },
          performanceMode: 'legacy-only',
        }),
      ).toBe(false);
      expect(getGpuBatchRendererStats().backend).toBe('webgl-legacy');
    });
  });

  describe('renderGpuBatch', () => {
    it('returns false when the renderer is not ready', () => {
      expect(renderGpuBatch([])).toBe(false);
      expect(renderGpuBatch([{ skin: { _id: 'a' } }])).toBe(false);
    });

    it('returns false even when "ready" because the GPU pipeline is staged (stub)', () => {
      setGpuBatchRendererReadyForTesting({
        initialized: true,
        backend: 'webgpu-instanced',
      });
      // Stub: render returns false. Real implementation lands behind
      // the same gate in a follow-up rollout.
      expect(renderGpuBatch([{ skin: { _id: 'a' } }])).toBe(false);
    });

    it('updates stats counters even on the stub path (for diagnostics)', () => {
      const drawables = [
        { skin: { _id: 'a' } },
        { skin: { _id: 'a' } },
        { skin: { _id: 'b' } },
        { skin: { _id: 'c' } },
      ];
      renderGpuBatch(drawables);
      const stats = getGpuBatchRendererStats();
      expect(stats.drawablesLastFrame).toBe(4);
      expect(stats.skinBatches).toBe(3);
      expect(stats.frameCount).toBe(1);
    });
  });

  describe('twWasmDrawSprites (the renderer hook)', () => {
    it('returns false when the renderer is not ready (fall through to WebGL)', () => {
      expect(twWasmDrawSprites({}, [])).toBe(false);
    });
  });

  describe('disposeGpuBatchRenderer', () => {
    it('clears state', () => {
      setGpuBatchRendererReadyForTesting({
        initialized: true,
        backend: 'webgpu-instanced',
      });
      disposeGpuBatchRenderer();
      const stats = getGpuBatchRendererStats();
      expect(stats.backend).toBe('webgl-legacy');
      expect(stats.initialized).toBe(false);
      expect(stats.frameCount).toBe(0);
      expect(stats.drawablesLastFrame).toBe(0);
      expect(stats.skinBatches).toBe(0);
    });
  });
});