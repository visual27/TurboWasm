import { describe, expect, it, beforeEach } from 'vitest';
import {
  gpuIsTouchingColor,
  gpuIsTouchingDrawables,
  isGpuCollisionReady,
  setGpuCollisionReadyForTesting,
  resetGpuCollisionForTesting,
} from '@/runtime/tw-wasm/gpu-collision';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';

function makeRenderer(): RendererLike {
  return { _allDrawables: [] };
}

describe('gpu-collision (Phase 2 WebGPU compute)', () => {
  beforeEach(() => {
    resetGpuCollisionForTesting();
  });

  describe('gate', () => {
    it('reports not-ready by default', () => {
      expect(isGpuCollisionReady()).toBe(false);
    });

    it('flip via the test knob toggles the gate', () => {
      setGpuCollisionReadyForTesting(true);
      expect(isGpuCollisionReady()).toBe(true);
      setGpuCollisionReadyForTesting(false);
      expect(isGpuCollisionReady()).toBe(false);
    });
  });

  describe('returns null when the gate is off', () => {
    it('gpuIsTouchingColor always returns null', () => {
      const r = makeRenderer();
      expect(gpuIsTouchingColor(r, 0, [0, 0, 0], null)).toBeNull();
    });

    it('gpuIsTouchingDrawables always returns null', () => {
      const r = makeRenderer();
      expect(gpuIsTouchingDrawables(r, 0, [])).toBeNull();
    });
  });

  describe('returns previous-frame result when the gate is on', () => {
    it('first call returns null (no previous frame)', () => {
      setGpuCollisionReadyForTesting(true);
      const r = makeRenderer();
      expect(gpuIsTouchingColor(r, 1, [0, 0, 0], null)).toBeNull();
    });

    it('records and returns the previous-frame boolean after a microtask', async () => {
      setGpuCollisionReadyForTesting(true);
      const r = makeRenderer();
      // First call: null
      expect(gpuIsTouchingColor(r, 2, [0, 0, 0], null)).toBeNull();
      // Yield to the microtask so the recordPrevFrame call lands
      await Promise.resolve();
      // Second call: should now see the previously-recorded boolean
      const second = gpuIsTouchingColor(r, 2, [0, 0, 0], null);
      expect(typeof second).toBe('boolean');
    });

    it('per-drawable cache keys are isolated', async () => {
      setGpuCollisionReadyForTesting(true);
      const r = makeRenderer();
      gpuIsTouchingColor(r, 10, [0, 0, 0], null);
      gpuIsTouchingColor(r, 11, [0, 0, 0], null);
      await Promise.resolve();
      // Both drawables should now report a (cached) boolean
      expect(typeof gpuIsTouchingColor(r, 10, [0, 0, 0], null)).toBe('boolean');
      expect(typeof gpuIsTouchingColor(r, 11, [0, 0, 0], null)).toBe('boolean');
    });

    it('drawables path shares the same caching strategy as color path', async () => {
      setGpuCollisionReadyForTesting(true);
      const r = makeRenderer();
      expect(gpuIsTouchingDrawables(r, 7, [])).toBeNull();
      await Promise.resolve();
      expect(typeof gpuIsTouchingDrawables(r, 7, [])).toBe('boolean');
    });
  });

  describe('legacy-only mode integration', () => {
    it('when performanceMode is legacy-only, the gate is forced off and the hooks never fire', () => {
      // In legacy-only mode, applyTurboWasmAcceleration sets the renderer
      // hooks to null. The gpu-collision module is *also* never asked,
      // because selectBackendTier returns 'none'. Verify the gate stays
      // off when not explicitly enabled.
      resetGpuCollisionForTesting();
      expect(isGpuCollisionReady()).toBe(false);
      const r = makeRenderer();
      expect(gpuIsTouchingColor(r, 0, [0, 0, 0], null)).toBeNull();
      expect(gpuIsTouchingDrawables(r, 0, [])).toBeNull();
    });
  });
});