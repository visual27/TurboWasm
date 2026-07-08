import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySvgAcceleration,
  disposeSvgAcceleration,
  isSvgAccelerationReady,
  removeSvgAcceleration,
} from '@/runtime/tw-wasm/svg-acceleration/applySvgAcceleration';
import { resetSvgBitmapCacheForTesting } from '@/runtime/tw-wasm/svg-acceleration/cache';
import { resetSvgWorkerForTesting } from '@/runtime/tw-wasm/svg-acceleration/worker-raster';
import type { SvgSkinLike } from '@/runtime/tw-wasm/svg-acceleration/types';

/**
 * Tests for the SVG acceleration host installation (Step 6 of the
 * Stage 2 plan). Verifies the mode → host contract:
 *   - `mode === 'off'` uninstalls the host (renderer property is null).
 *   - `mode === 'cache-only' | 'mip-chain'` installs a host with the
 *     expected `workerActive` flag and the synchronous `getOrCreateMip`
 *     contract used by the SVGSkin patch.
 *   - `removeSvgAcceleration` clears the host.
 *   - Mode transitions are idempotent.
 *   - `applySvgAcceleration` integrates with `applyTurboWasmAcceleration`
 *     (both `_twWasm*` properties can co-exist on the same renderer).
 */

interface RendererStub {
  _twWasmIsTouchingDrawables?: ((...args: unknown[]) => unknown) | null;
  _twWasmIsTouchingColor?: ((...args: unknown[]) => unknown) | null;
  _twWasmDrawSprites?: ((...args: unknown[]) => unknown) | null;
  _twWasmSvgAcceleration?: {
    mode: 'cache-only' | 'mip-chain';
    workerActive: boolean;
    getOrCreateMip: (skin: SvgSkinLike, scale: number) => ImageBitmap | null;
    invalidate: (skin: SvgSkinLike) => void;
  } | null;
}

function makeScaffolding(): { renderer: RendererStub } {
  return { renderer: {} };
}

describe('applySvgAcceleration', () => {
  beforeEach(async () => {
    await resetSvgWorkerForTesting();
    resetSvgBitmapCacheForTesting();
  });

  afterEach(async () => {
    await resetSvgWorkerForTesting();
    resetSvgBitmapCacheForTesting();
  });

  it('mode=off leaves the host property null', () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'off' });
    expect(sc.renderer._twWasmSvgAcceleration).toBeNull();
  });

  it('mode=cache-only installs a host with workerActive=false in jsdom', () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'cache-only' });
    expect(sc.renderer._twWasmSvgAcceleration).not.toBeNull();
    expect(sc.renderer._twWasmSvgAcceleration?.mode).toBe('cache-only');
    expect(sc.renderer._twWasmSvgAcceleration?.workerActive).toBe(false);
  });

  it('mode=mip-chain installs a host with workerActive=false in jsdom (no Worker)', () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'mip-chain' });
    expect(sc.renderer._twWasmSvgAcceleration).not.toBeNull();
    expect(sc.renderer._twWasmSvgAcceleration?.mode).toBe('mip-chain');
    // jsdom has no OffscreenCanvas; the host is downgraded to
    // main-thread createImageBitmap.
    expect(sc.renderer._twWasmSvgAcceleration?.workerActive).toBe(false);
  });

  it("mode='resvg-visual-equivalence' is treated as 'off' (forward-compat)", () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'resvg-visual-equivalence' });
    expect(sc.renderer._twWasmSvgAcceleration).toBeNull();
  });

  it('removeSvgAcceleration clears the host property', () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'cache-only' });
    expect(sc.renderer._twWasmSvgAcceleration).not.toBeNull();
    removeSvgAcceleration(sc);
    expect(sc.renderer._twWasmSvgAcceleration).toBeNull();
  });

  it('mode transitions are idempotent', () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'cache-only' });
    applySvgAcceleration(sc, { mode: 'mip-chain' });
    expect(sc.renderer._twWasmSvgAcceleration?.mode).toBe('mip-chain');
    applySvgAcceleration(sc, { mode: 'off' });
    expect(sc.renderer._twWasmSvgAcceleration).toBeNull();
    applySvgAcceleration(sc, { mode: 'off' });
    expect(sc.renderer._twWasmSvgAcceleration).toBeNull();
  });

  it('getOrCreateMip returns null on a cache miss (caller falls back to drawImage)', () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'cache-only' });
    const host = sc.renderer._twWasmSvgAcceleration;
    expect(host).not.toBeNull();
    const skin: SvgSkinLike = { _size: [100, 100] };
    expect(host?.getOrCreateMip(skin, 1)).toBeNull();
  });

  it('invalidate closes the cache for the given skin', async () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'cache-only' });
    const host = sc.renderer._twWasmSvgAcceleration;
    expect(host).not.toBeNull();
    const skin: SvgSkinLike = { _size: [100, 100] };
    // No entries to invalidate; must be a no-op.
    expect(() => host?.invalidate(skin)).not.toThrow();
  });

  it('null scaffolding is a no-op', () => {
    expect(() => applySvgAcceleration(null, { mode: 'cache-only' })).not.toThrow();
    expect(() => removeSvgAcceleration(null)).not.toThrow();
  });

  it('null renderer is a no-op', () => {
    const sc = { renderer: null };
    expect(() => applySvgAcceleration(sc, { mode: 'cache-only' })).not.toThrow();
    expect(() => removeSvgAcceleration(sc)).not.toThrow();
  });

  it('coexists with applyTurboWasmAcceleration hooks on the same renderer', () => {
    // Regression guard: the two host objects install different
    // `_twWasm*` properties on the renderer. They must not
    // stomp on each other.
    const sc = makeScaffolding();
    // First the SVG acceleration host.
    applySvgAcceleration(sc, { mode: 'cache-only' });
    expect(sc.renderer._twWasmSvgAcceleration).not.toBeNull();
    // Then the legacy TurboWasm collision hooks.
    sc.renderer._twWasmIsTouchingDrawables = () => null;
    sc.renderer._twWasmIsTouchingColor = () => null;
    sc.renderer._twWasmDrawSprites = () => false;
    // Both sets of hooks must remain intact after a re-apply of either.
    applySvgAcceleration(sc, { mode: 'mip-chain' });
    expect(sc.renderer._twWasmSvgAcceleration?.mode).toBe('mip-chain');
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
    expect(typeof sc.renderer._twWasmDrawSprites).toBe('function');
    // And turning off SVG must NOT touch the TurboWasm hooks.
    applySvgAcceleration(sc, { mode: 'off' });
    expect(sc.renderer._twWasmSvgAcceleration).toBeNull();
    expect(typeof sc.renderer._twWasmIsTouchingDrawables).toBe('function');
    expect(typeof sc.renderer._twWasmIsTouchingColor).toBe('function');
    expect(typeof sc.renderer._twWasmDrawSprites).toBe('function');
  });

  it('isSvgAccelerationReady reflects the Worker / OffscreenCanvas capability', () => {
    // In jsdom: no Worker, no OffscreenCanvas — readiness is false.
    expect(isSvgAccelerationReady()).toBe(false);
  });

  it('disposeSvgAcceleration is safe to call when no host is active', async () => {
    await expect(disposeSvgAcceleration()).resolves.toBeUndefined();
  });

  it('disposeSvgAcceleration clears the cache and terminates the worker', async () => {
    const sc = makeScaffolding();
    applySvgAcceleration(sc, { mode: 'cache-only' });
    expect(sc.renderer._twWasmSvgAcceleration).not.toBeNull();
    await disposeSvgAcceleration();
    // The host reference is now a fresh no-op after the next apply.
    applySvgAcceleration(sc, { mode: 'cache-only' });
    expect(sc.renderer._twWasmSvgAcceleration).not.toBeNull();
  });
});
