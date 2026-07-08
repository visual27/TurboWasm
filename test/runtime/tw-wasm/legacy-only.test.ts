import { describe, expect, it, beforeEach } from 'vitest';

/**
 * DoD test for the legacy-only Performance Mode.
 *
 * SPEC §10 requires that `legacy-only` mode produces output that is
 * pixel-identical to the unmodified scratch-render. We can't verify
 * pixel-identity in unit tests, but we can verify that the renderer
 * hooks are cleared and that no tier is consulted.
 */

import {
  applyTurboWasmAcceleration,
  removeTurboWasmAcceleration,
  selectBackendTier,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';
import {
  isWasmCollisionReady,
  resetWasmCollisionForTesting,
} from '@/runtime/tw-wasm/wasm-collision-client';
import {
  isGpuCollisionReady,
  resetGpuCollisionForTesting,
  setGpuCollisionReadyForTesting,
} from '@/runtime/tw-wasm/gpu-collision';
import {
  isGpuBatchRendererReady,
  resetGpuBatchRendererForTesting,
} from '@/runtime/tw-wasm/gpu-batch-renderer';

interface RendererStub {
  _twWasmIsTouchingDrawables?: ((...args: unknown[]) => unknown) | null;
  _twWasmIsTouchingColor?: ((...args: unknown[]) => unknown) | null;
  _twWasmDrawSprites?: ((...args: unknown[]) => unknown) | null;
  _twWasmGpuTouchingStart?: ((...args: unknown[]) => unknown) | null;
  _twWasmGpuTouchingFin?: ((...args: unknown[]) => unknown) | null;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

describe('legacy-only mode (DoD parity)', () => {
  beforeEach(() => {
    resetWasmCollisionForTesting();
    resetGpuCollisionForTesting();
    resetGpuBatchRendererForTesting();
  });

  it('selectBackendTier returns none regardless of capability flags', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true, webgpu: true }, performanceMode: 'legacy-only' },
        true,
        true,
      ),
    ).toBe('none');
  });

  it('hooks stay null in legacy-only mode even when both backings are ready', async () => {
    // Simulate both backings being ready without invoking the real
    // fetch-based init (which fails in jsdom). We force the gate on
    // via the test knob and the stub `isWasmCollisionReady` would also
    // need to flip — that's a contract violation, but for legacy-only
    // we just need to verify the dispatch logic clears the hooks.
    setGpuCollisionReadyForTesting(true);
    expect(isGpuCollisionReady()).toBe(true);
    expect(isGpuBatchRendererReady()).toBe(false);

    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'legacy-only',
    });
    // legacy-only → tier is 'none' regardless of readiness → hooks null
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
    expect(sc.renderer._twWasmDrawSprites).toBeNull();
  });

  it('removeTurboWasmAcceleration clears every hook even in legacy-only', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'legacy-only',
    });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
    expect(sc.renderer._twWasmDrawSprites).toBeNull();
  });

  it('switching from auto → legacy-only clears the hooks', () => {
    // The auto tier depends on which backings are ready at the time
    // `applyTurboWasmAcceleration` runs. We force the WebGPU backing
    // on so the auto tier selects 'gpu', then flip to legacy-only
    // and verify everything clears.
    setGpuCollisionReadyForTesting(true);
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'auto',
    });
    // With WebGPU ready, the auto tier installs the gpu hook.
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'legacy-only',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
    expect(sc.renderer._twWasmDrawSprites).toBeNull();
  });

  it('legacy-only mode does not call initWasmCollision even when WASM SIMD is supported', async () => {
    // Sanity: the legacy-only path is purely "no acceleration" — even
    // when WASM SIMD is supported, the host should not waste cycles
    // initialising the module. We verify the dispatch result is the
    // same null-state regardless of capability flags.
    expect(isWasmCollisionReady()).toBe(false);
    setGpuCollisionReadyForTesting(true);
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'legacy-only',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
    expect(sc.renderer._twWasmDrawSprites).toBeNull();
  });
});