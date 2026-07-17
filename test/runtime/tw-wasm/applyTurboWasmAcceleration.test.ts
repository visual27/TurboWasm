import { describe, expect, it, beforeEach, vi } from 'vitest';

const fakeWasmReady = { value: true };

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) }),
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
  selectBackendTier,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';
import type { RuntimeCapabilities } from '@/runtime/tw-wasm/capabilities';

interface RendererStub {
  _twWasmIsTouchingDrawables?: unknown;
  _twWasmIsTouchingColor?: unknown;
  // Phase 3 (WebGPU instanced renderer) used to install this hook. It
  // was retired when the GPU compute tier was removed; the regression
  // tests now verify the hook is *never* set, even when the runtime
  // would otherwise consult a higher-tier backend.
  _twWasmDrawSprites?: unknown;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

const WASM_CAPS: RuntimeCapabilities = { wasmSimd: true };
const NO_CAPS: RuntimeCapabilities = { wasmSimd: false };

describe('applyTurboWasmAcceleration', () => {
  beforeEach(() => {
    fakeWasmReady.value = true;
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
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    // Sanity: hook is active before the toggle.
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'legacy-only',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('force-wasm installs the hook when WASM is ready', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'force-wasm',
    });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
  });

  it('force-wasm falls back to no hook when WASM is not ready', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'force-wasm',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('never installs the retired Phase 3 instanced-renderer hook', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'auto',
    });
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'force-wasm',
    });
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      performanceMode: 'legacy-only',
    });
    // The WebGPU instanced renderer hook is dead code now. Keeping a
    // regression test so a future re-introduction that wires it up
    // again has to update both this test and the comment in
    // applyTurboWasmAcceleration.ts.
    expect(sc.renderer._twWasmDrawSprites).toBeUndefined();
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
      ),
    ).toBe('none');
  });

  it('returns none for legacy-only regardless of readiness', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'legacy-only' },
        true,
      ),
    ).toBe('none');
  });

  it('force-wasm returns wasm when ready, none when not', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-wasm' },
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: WASM_CAPS, performanceMode: 'force-wasm' },
        false,
      ),
    ).toBe('none');
  });

  it('auto returns wasm when ready and none otherwise', () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, performanceMode: 'auto' }, true),
    ).toBe('wasm');
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, performanceMode: 'auto' }, false),
    ).toBe('none');
  });
});