import { describe, expect, it, beforeEach, vi } from 'vitest';

const fakeWasmReady = { value: true };
const fakeGpuReady = { value: false };
const fakeInit = vi.fn(() => {
  fakeWasmReady.value = true;
  return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
});
const fakeGpuIsTouchingDrawables = vi.fn((_a?: unknown, _b?: unknown, _c?: unknown) => null);
const fakeGpuIsTouchingColor = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown) => null,
);

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => fakeInit(),
  isWasmCollisionReady: () => fakeWasmReady.value,
  wasmIsTouchingDrawables: vi.fn(() => null),
  wasmIsTouchingColor: vi.fn(() => null),
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
  gpuIsTouchingDrawables: (a: unknown, b: unknown, c: unknown) =>
    fakeGpuIsTouchingDrawables(a, b, c),
  gpuIsTouchingColor: (a: unknown, b: unknown, c: unknown, d: unknown) =>
    fakeGpuIsTouchingColor(a, b, c, d),
}));

import {
  applyTurboWasmAcceleration,
  removeTurboWasmAcceleration,
  selectBackendTier,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';
import type { RuntimeCapabilities } from '@/runtime/tw-wasm/capabilities';

interface RendererStub {
  _twWasmIsTouchingDrawables?: unknown;
  _twWasmIsTouchingColor?: unknown;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

const WASM_CAPS: RuntimeCapabilities = { wasmSimd: true, webgpu: false };
const NO_CAPS: RuntimeCapabilities = { wasmSimd: false, webgpu: false };

describe('applyTurboWasmAcceleration', () => {
  beforeEach(() => {
    fakeWasmReady.value = true;
    fakeGpuReady.value = false;
    fakeInit.mockClear();
    fakeGpuIsTouchingDrawables.mockClear();
    fakeGpuIsTouchingColor.mockClear();
  });

  it('installs the WASM hook when enabled and SIMD is supported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
  });

  it('clears the WASM hook when disabled', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    applyTurboWasmAcceleration(sc, {
      enabled: false,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('does not install the hook when SIMD is unsupported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: NO_CAPS,
      performanceMode: 'auto',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('does not install the hook when WASM is not ready', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('clears every hook in legacy-only mode', () => {
    fakeGpuReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'auto',
    });
    // WebGPU path should be active
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    // Now flip to legacy-only
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'legacy-only',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('routes through the WebGPU tier when force-webgpu is selected and GPU is ready', () => {
    fakeGpuReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'force-webgpu',
    });
    const hook = sc.renderer._twWasmIsTouchingDrawables as (
      ...args: unknown[]
    ) => unknown;
    hook(sc, 0, []);
    expect(fakeGpuIsTouchingDrawables).toHaveBeenCalledTimes(1);
  });

  it('force-wasm ignores WebGPU even when it is ready', () => {
    fakeGpuReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true, webgpu: true },
      performanceMode: 'force-wasm',
    });
    const hook = sc.renderer._twWasmIsTouchingDrawables as (
      ...args: unknown[]
    ) => unknown;
    hook(sc, 0, []);
    expect(fakeGpuIsTouchingDrawables).not.toHaveBeenCalled();
  });

  it('is a safe no-op when scaffolding is null/undefined', () => {
    expect(() =>
      applyTurboWasmAcceleration(null, {
        enabled: true,
        caps: WASM_CAPS,
        performanceMode: 'auto',
      }),
    ).not.toThrow();
    expect(() =>
      applyTurboWasmAcceleration(undefined, {
        enabled: true,
        caps: WASM_CAPS,
        performanceMode: 'auto',
      }),
    ).not.toThrow();
  });

  it('removeTurboWasmAcceleration clears hooks', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});

describe('selectBackendTier', () => {
  it('returns none when disabled', () => {
    expect(
      selectBackendTier(
        { enabled: false, caps: WASM_CAPS, performanceMode: 'auto' },
        true,
        true,
      ),
    ).toBe('none');
  });

  it('returns none for legacy-only regardless of readiness', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'legacy-only' },
        true,
        true,
      ),
    ).toBe('none');
  });

  it('force-wasm ignores WebGPU and falls back to wasm when ready', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-wasm' },
        true,
        true,
      ),
    ).toBe('wasm');
  });

  it('force-wasm falls through to none when wasm is not ready', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-wasm' },
        true,
        false,
      ),
    ).toBe('none');
  });

  it('force-webgpu prefers WebGPU then wasm', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-webgpu' },
        true,
        true,
      ),
    ).toBe('gpu');
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-webgpu' },
        false,
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-webgpu' },
        false,
        false,
      ),
    ).toBe('none');
  });

  it('auto picks the best available tier', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'auto' },
        true,
        true,
      ),
    ).toBe('gpu');
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'auto' },
        false,
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'auto' },
        false,
        false,
      ),
    ).toBe('none');
  });
});