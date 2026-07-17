import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * DoD tests for the WASM-SIMD ↔ JS collision-detection fallback.
 *
 * Phase 2 (WebGPU compute) was retired when the runtime stub never
 * progressed past `requestAdapter()` probing, so the tier chain is now
 * two-way: WASM SIMD when available, otherwise the original JS path.
 * `legacy-only` clears every hook (Definition of Done parity mode).
 */

const fakeWasmReady = { value: true };
const wasmDrawables = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown): boolean | null => false,
);
const wasmColor = vi.fn(
  (_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown): boolean | null => false,
);

vi.mock('@/runtime/tw-wasm/wasm-collision-client', () => ({
  initWasmCollision: () => {
    fakeWasmReady.value = true;
    return Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) });
  },
  isWasmCollisionReady: () => fakeWasmReady.value,
  wasmIsTouchingDrawables: (rd: unknown, id: number, cand: readonly number[]) =>
    wasmDrawables(rd, id, cand),
  wasmIsTouchingColor: (rd: unknown, id: number, c: unknown, m: unknown) =>
    wasmColor(rd, id, c, m),
  resetWasmCollisionForTesting: () => {
    fakeWasmReady.value = false;
  },
}));

import {
  applyTurboWasmAcceleration,
  selectBackendTier,
  removeTurboWasmAcceleration,
} from '@/runtime/tw-wasm/applyTurboWasmAcceleration';

interface RendererStub {
  _twWasmIsTouchingDrawables?: ((...args: unknown[]) => unknown) | null;
  _twWasmIsTouchingColor?: ((...args: unknown[]) => unknown) | null;
  _twWasmDrawSprites?: ((...args: unknown[]) => unknown) | null;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

describe('WASM-SIMD ↔ JS collision fallback (DoD parity)', () => {
  beforeEach(() => {
    fakeWasmReady.value = true;
    wasmDrawables.mockClear();
    wasmColor.mockClear();
    wasmDrawables.mockImplementation(() => false);
    wasmColor.mockImplementation(() => false);
  });

  it('legacy-only: hooks stay null', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'legacy-only',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('auto mode installs the WASM hook when SIMD is supported', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'auto',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(sc, 0, []);
    expect(wasmDrawables).toHaveBeenCalledTimes(1);
  });

  it('auto mode does not install the hook when WASM is not ready', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'auto',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('force-wasm installs the hook when WASM is ready', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'force-wasm',
    });
    (sc.renderer._twWasmIsTouchingDrawables as (...a: unknown[]) => unknown)(sc, 0, []);
    expect(wasmDrawables).toHaveBeenCalledTimes(1);
  });

  it('force-wasm falls through to no hook when WASM is not ready', () => {
    fakeWasmReady.value = false;
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'force-wasm',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
  });

  it('hooks stay null when WASM backing is not ready in auto mode', () => {
    fakeWasmReady.value = false;
    wasmDrawables.mockImplementation(() => null);
    wasmColor.mockImplementation(() => null);
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'auto',
    });
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });

  it('removeTurboWasmAcceleration clears both hooks', () => {
    const sc = makeScaffolding();
    applyTurboWasmAcceleration(sc, {
      enabled: true,
      caps: { wasmSimd: true },
      performanceMode: 'auto',
    });
    removeTurboWasmAcceleration(sc);
    expect(sc.renderer._twWasmIsTouchingDrawables).toBeNull();
    expect(sc.renderer._twWasmIsTouchingColor).toBeNull();
  });
});

describe('selectBackendTier (WASM ↔ JS fallback)', () => {
  it('legacy-only always returns none regardless of capability flags', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true }, performanceMode: 'legacy-only' },
        true,
      ),
    ).toBe('none');
  });

  it('auto order: wasm when ready, none otherwise', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true }, performanceMode: 'auto' },
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true }, performanceMode: 'auto' },
        false,
      ),
    ).toBe('none');
  });

  it('force-wasm follows readiness', () => {
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true }, performanceMode: 'force-wasm' },
        true,
      ),
    ).toBe('wasm');
    expect(
      selectBackendTier(
        { enabled: true, caps: { wasmSimd: true }, performanceMode: 'force-wasm' },
        false,
      ),
    ).toBe('none');
  });

  it('disabled shortcut always returns none', () => {
    expect(
      selectBackendTier(
        { enabled: false, caps: { wasmSimd: true }, performanceMode: 'auto' },
        true,
      ),
    ).toBe('none');
  });
});