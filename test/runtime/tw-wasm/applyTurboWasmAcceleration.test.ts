import { describe, expect, it, beforeEach, vi } from 'vitest';

const fakeWasmReady = { value: true };
const fakeInit = vi.fn(() => {
  fakeWasmReady.value = true;
  return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
});

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => fakeInit(),
  isWasmCollisionReady: () => fakeWasmReady.value,
  wasmIsTouchingDrawables: vi.fn(() => null),
  wasmIsTouchingColor: vi.fn(() => null),
  resetWasmCollisionForTesting: () => {
    fakeWasmReady.value = false;
  },
}));

import {
  applyTurboWasmAcceleration,
  removeTurboWasmAcceleration,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';
import type { RuntimeCapabilities } from '@/runtime/tw-wasm/capabilities';

interface RendererStub {
  _twWasmIsTouchingDrawables?: unknown;
  _twWasmIsTouchingColor?: unknown;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

describe('applyTurboWasmAcceleration', () => {
  beforeEach(() => {
    fakeWasmReady.value = true;
    fakeInit.mockClear();
  });

  it('installs the WASM hook when enabled and SIMD is supported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: false },
    });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
  });

  it('clears the WASM hook when disabled', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: false },
    });
    applyTurboWasmAcceleration(sc, {
      enabled: false,
      caps: { wasmSimd: true, webgpu: false },
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('does not install the hook when SIMD is unsupported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: false, webgpu: false },
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('does not install the hook when WASM is not ready', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: false },
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('is a safe no-op when scaffolding is null/undefined', () => {
    expect(() => applyTurboWasmAcceleration(null, { enabled: true, caps: { wasmSimd: true, webgpu: false } as RuntimeCapabilities })).not.toThrow();
    expect(() => applyTurboWasmAcceleration(undefined, { enabled: true, caps: { wasmSimd: true, webgpu: false } as RuntimeCapabilities })).not.toThrow();
  });

  it('removeTurboWasmAcceleration clears hooks', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: { wasmSimd: true, webgpu: false } });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});
