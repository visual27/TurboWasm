import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * DoD test for the `enableWasm: false` parity mode.
 *
 * SPEC §10 requires that disabling the WASM toggle produces output that
 * is pixel-identical to the unmodified scratch-render. We can't verify
 * pixel-identity in unit tests, but we can verify that the renderer
 * hooks are cleared and that no tier is consulted.
 *
 * Phase 2 (WebGPU compute) and Phase 3 (WebGPU instanced renderer)
 * were retired along with their UI selectors; this file used to mock
 * the `gpu-collision` and `gpu-batch-renderer` modules to exercise
 * the legacy-only dispatch logic. With those modules removed, the
 * tests now verify the same DoD parity contract against the surviving
 * WASM hook surface only.
 */

const fakeWasmReady = { value: false };

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => {
    fakeWasmReady.value = true;
    return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
  },
  isWasmCollisionReady: () => fakeWasmReady.value,
  wasmIsTouchingDrawables: () => null,
  wasmIsTouchingColor: () => null,
  resetWasmCollisionForTesting: () => {
    fakeWasmReady.value = false;
  },
}));

import {
  applyTurboWasmAcceleration,
  removeTurboWasmAcceleration,
  selectBackendTier,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';

interface RendererStub {
  _twWasmIsTouchingDrawables?: ((...args: unknown[]) => unknown) | null;
  _twWasmIsTouchingColor?: ((...args: unknown[]) => unknown) | null;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

describe('enableWasm=false (DoD parity)', () => {
  beforeEach(() => {
    fakeWasmReady.value = false;
  });

  it('selectBackendTier returns none regardless of capability flags', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true }, enableWasm: false },
        true,
      ),
    ).toBe('none');
  });

  it('hooks stay null in enableWasm=false mode even when WASM is ready', () => {
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      enableWasm: false,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('removeTurboWasmAcceleration clears every hook even with enableWasm=false', () => {
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      enableWasm: false,
    });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('switching enableWasm true → false clears the hooks', () => {
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      enableWasm: true,
    });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      enableWasm: false,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});
