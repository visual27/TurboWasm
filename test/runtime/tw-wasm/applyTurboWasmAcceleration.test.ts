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

  it('installs the WASM hook when enabled, SIMD is supported, and enableWasm is true', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
  });

  it('clears the WASM hook when disabled', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    applyTurboWasmAcceleration(sc, {
      enabled: false,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('does not install the hook when SIMD is unsupported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: NO_CAPS,
      enableWasm: true,
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
      enableWasm: true,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('clears every hook when enableWasm is false (DoD parity)', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    // Sanity: hook is active before the toggle.
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: false,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('enableWasm=false clears hooks even when WASM is ready', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: false,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('enableWasm=true with WASM not ready still falls back to no hook', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('never installs the retired Phase 3 instanced-renderer hook', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: false,
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
        enableWasm: true,
      }),
    ).not.toThrow();
    expect(() =>
      applyTurboWasmAcceleration(undefined, {
        enabled: true,
        caps: WASM_CAPS,
        enableWasm: true,
      }),
    ).not.toThrow();
  });

  it('removeTurboWasmAcceleration clears hooks', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: WASM_CAPS,
      enableWasm: true,
    });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});

describe('selectBackendTier', () => {
  it('returns none when disabled', () => {
    expect(
      selectBackendTier({ enabled: false, caps: WASM_CAPS, enableWasm: true }, true),
    ).toBe('none');
  });

  it('returns none when enableWasm is false regardless of readiness', () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: false }, true),
    ).toBe('none');
  });

  it('returns wasm when enableWasm is true and WASM is ready', () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: true }, true),
    ).toBe('wasm');
  });

  it('returns none when enableWasm is true but WASM is not ready', () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: true }, false),
    ).toBe('none');
  });
});
