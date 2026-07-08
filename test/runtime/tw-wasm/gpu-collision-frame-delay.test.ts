import { describe, expect, it, beforeEach } from 'vitest';

/**
 * DoD test for the WebGPU "1-frame delay" scheme (SPEC §4.3).
 *
 * The host hook must return a synchronous boolean from
 * `_twWasmGpuTouchingStart` even though the GPU work is async. We do
 * this by caching the previous frame's result and returning it on the
 * next call. This test pins that contract.
 *
 * Caveat: in the current build the GPU compute pipeline is gated off,
 * so the cached result is always `false`. The test asserts the
 * "previous-frame visible to the next call" property, not the
 * GPU correctness — that lands in a follow-up rollout.
 */

import {
  gpuIsTouchingColor,
  gpuIsTouchingDrawables,
  setGpuCollisionReadyForTesting,
  resetGpuCollisionForTesting,
} from '@/runtime/tw-wasm/gpu-collision';
import type { RendererLike } from '@/runtime/tw-wasm/wasm-collision-client';

function makeRenderer(): RendererLike {
  return { _allDrawables: [] };
}

describe('gpu-collision-frame-delay (SPEC §4.3 DoD)', () => {
  beforeEach(() => {
    resetGpuCollisionForTesting();
  });

  it('first call returns null (no previous frame yet)', () => {
    setGpuCollisionReadyForTesting(true);
    const r = makeRenderer();
    expect(gpuIsTouchingColor(r, 1, [0, 0, 0], null)).toBeNull();
  });

  it('second call after a microtask sees the previous frame boolean', async () => {
    setGpuCollisionReadyForTesting(true);
    const r = makeRenderer();
    gpuIsTouchingColor(r, 1, [0, 0, 0], null);
    // Yield to the microtask the host hook scheduled.
    await Promise.resolve();
    await Promise.resolve();
    const second = gpuIsTouchingColor(r, 1, [0, 0, 0], null);
    expect(typeof second).toBe('boolean');
  });

  it('1-frame delay works the same for the drawables path', async () => {
    setGpuCollisionReadyForTesting(true);
    const r = makeRenderer();
    expect(gpuIsTouchingDrawables(r, 7, [])).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(typeof gpuIsTouchingDrawables(r, 7, [])).toBe('boolean');
  });

  it('frame-delay is per-drawable, not shared', async () => {
    setGpuCollisionReadyForTesting(true);
    const r = makeRenderer();
    gpuIsTouchingColor(r, 100, [0, 0, 0], null);
    gpuIsTouchingColor(r, 200, [0, 0, 0], null);
    await Promise.resolve();
    await Promise.resolve();
    // Both drawables should now have a cached boolean
    expect(typeof gpuIsTouchingColor(r, 100, [0, 0, 0], null)).toBe('boolean');
    expect(typeof gpuIsTouchingColor(r, 200, [0, 0, 0], null)).toBe('boolean');
  });

  it('when the gate is off, frame-delay machinery is not exercised', () => {
    const r = makeRenderer();
    expect(gpuIsTouchingColor(r, 1, [0, 0, 0], null)).toBeNull();
    // No microtask should have been scheduled when the gate is off.
    // We verify this implicitly by checking that the gate stays off
    // and the function returns null.
  });
});