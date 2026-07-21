/**
 * Consolidated WASM-SIMD ↔ JS collision-detection fallback tests.
 *
 * Replaces three previous files that all targeted `applyTurboWasmAcceleration`
 * and `selectBackendTier`:
 *   - applyTurboWasmAcceleration.test.ts (hook install / remove / no-op safety)
 *   - three-tier-fallback.test.ts (DoD parity for the surviving WASM path)
 *   - legacy-only.test.ts (enableWasm=false DoD parity)
 *
 * Phase 2 (WebGPU compute) and Phase 3 (WebGPU instanced renderer) were
 * retired along with their UI selectors; the tier chain is two-way
 * (WASM-SIMD ↔ JS) and `enableWasm: false` is the DoD parity mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeWasmReady = { value: true };

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => {
    fakeWasmReady.value = true;
    return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
  },
  isWasmCollisionReady: () => fakeWasmReady.value,
  wasmIsTouchingDrawables: vi.fn(() => false),
  wasmIsTouchingColor: vi.fn(() => false),
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
  _twWasmIsTouchingDrawables?: ((...args: unknown[]) => unknown) | null;
  _twWasmIsTouchingColor?: ((...args: unknown[]) => unknown) | null;
  /**
   * Phase 3 (WebGPU instanced renderer) used to install this hook. It
   * was retired when the GPU compute tier was removed; the regression
   * assertion below verifies the hook is *never* set, even when the
   * runtime would otherwise consult a higher-tier backend.
   */
  _twWasmDrawSprites?: unknown;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

const WASM_CAPS: RuntimeCapabilities = { wasmSimd: true };
const NO_CAPS: RuntimeCapabilities = { wasmSimd: false };

describe('applyTurboWasmAcceleration: hook install / clear', () => {
  beforeEach(() => {
    fakeWasmReady.value = true;
  });

  it('installs the WASM hooks when enabled, SIMD supported, WASM ready, enableWasm=true', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: true });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
  });

  it('skips install when SIMD is unsupported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: NO_CAPS, enableWasm: true });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('skips install when WASM is not ready', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: true });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('clears every hook when toggling enabled → false', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: true });
    applyTurboWasmAcceleration(sc, { enabled: false, caps: WASM_CAPS, enableWasm: true });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('removeTurboWasmAcceleration clears the hooks', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: true });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('is a safe no-op when scaffolding is null/undefined', () => {
    expect(() =>
      applyTurboWasmAcceleration(null, { enabled: true, caps: WASM_CAPS, enableWasm: true }),
    ).not.toThrow();
    expect(() =>
      applyTurboWasmAcceleration(undefined, { enabled: true, caps: WASM_CAPS, enableWasm: true }),
    ).not.toThrow();
  });

  it('never installs the retired Phase 3 instanced-renderer hook', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: true });
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: false });
    expect(sc.renderer._twWasmDrawSprites).toBeUndefined();
  });
});

describe('applyTurboWasmAcceleration: enableWasm=false (DoD parity)', () => {
  beforeEach(() => {
    fakeWasmReady.value = false;
  });

  it('clears every hook even when WASM is ready', () => {
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: false });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('removeTurboWasmAcceleration is a no-op against enableWasm=false', () => {
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: false });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('switching enableWasm true → false clears the hooks', () => {
    fakeWasmReady.value = true;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: true });
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    applyTurboWasmAcceleration(sc, { enabled: true, caps: WASM_CAPS, enableWasm: false });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});

describe('selectBackendTier: 2-way tier resolution', () => {
  it("returns 'none' when enabled is false", () => {
    expect(
      selectBackendTier({ enabled: false, caps: WASM_CAPS, enableWasm: true }, true),
    ).toBe('none');
  });

  it("returns 'none' when enableWasm is false regardless of readiness", () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: false }, true),
    ).toBe('none');
  });

  it("returns 'wasm' when enableWasm is true and WASM is ready", () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: true }, true),
    ).toBe('wasm');
  });

  it("returns 'none' when enableWasm is true but WASM is not ready", () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: true }, false),
    ).toBe('none');
  });

  it('enableWasm=false always returns none regardless of capability flags', () => {
    expect(
      selectBackendTier({ enabled: true, caps: { wasmSimd: false }, enableWasm: false }, true),
    ).toBe('none');
  });

  it('enableWasm=true: wasm when ready, none otherwise', () => {
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: true }, true),
    ).toBe('wasm');
    expect(
      selectBackendTier({ enabled: true, caps: WASM_CAPS, enableWasm: true }, false),
    ).toBe('none');
  });
});
