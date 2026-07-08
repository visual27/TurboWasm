import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIP_CHAIN_SCALES,
  canCreateImageBitmap,
  lookupMip,
  prerenderMipChain,
} from '@/runtime/tw-wasm/svg-acceleration/mip-chain';
import { SvgBitmapCache } from '@/runtime/tw-wasm/svg-acceleration/cache';
import { resetSvgBitmapCacheForTesting } from '@/runtime/tw-wasm/svg-acceleration/cache';
import type { SvgSkinLike } from '@/runtime/tw-wasm/svg-acceleration/types';

/**
 * Tests for the MIP pre-decode chain (Stage 2 of the TurboWasm
 * Acceleration plan). We never invoke the browser's `createImageBitmap`
 * in jsdom — every test injects a mock factory that returns a stub
 * `ImageBitmap` and counts invocations.
 */

interface BitmapMock {
  scale: number;
  closed: boolean;
  close(): void;
}

function makeBitmapMock(scale: number): ImageBitmap {
  const mock: BitmapMock = {
    scale,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  return mock as unknown as ImageBitmap;
}

function makeSkin(
  size: readonly [number, number] = [100, 100],
  hasImage = true,
): SvgSkinLike {
  return {
    _size: size,
    _svgImage: hasImage ? ({} as unknown as HTMLImageElement) : null,
  };
}

describe('mip-chain', () => {
  let cache: SvgBitmapCache;

  beforeEach(() => {
    cache = new SvgBitmapCache();
    resetSvgBitmapCacheForTesting();
  });

  afterEach(() => {
    resetSvgBitmapCacheForTesting();
  });

  it('canCreateImageBitmap reflects the global availability', () => {
    // jsdom does not provide createImageBitmap; we expect either
    // `true` (in a real browser / node with polyfill) or `false`.
    // The assertion is structural: it must be a boolean.
    expect(typeof canCreateImageBitmap()).toBe('boolean');
  });

  it('prerenderMipChain inserts every default scale via the factory', async () => {
    const skin = makeSkin([100, 100]);
    const factoryCalls: number[] = [];
    const result = await prerenderMipChain(skin, {
      cache,
      factoryFor: (scale) => () => {
        factoryCalls.push(scale);
        return Promise.resolve(makeBitmapMock(scale));
      },
    });
    expect(result.inserted).toBe(DEFAULT_MIP_CHAIN_SCALES.length);
    expect(result.skipped).toEqual([]);
    expect(factoryCalls.sort((a, b) => a - b)).toEqual([...DEFAULT_MIP_CHAIN_SCALES].sort((a, b) => a - b));
    // The cache now has 5 entries keyed by scale.
    expect(cache.size).toBe(DEFAULT_MIP_CHAIN_SCALES.length);
    for (const scale of DEFAULT_MIP_CHAIN_SCALES) {
      expect(cache.get(skin, scale)).not.toBeNull();
    }
  });

  it('skips scales the factory returns null for', async () => {
    const skin = makeSkin([100, 100]);
    const result = await prerenderMipChain(skin, {
      cache,
      factoryFor: (scale) => () => Promise.resolve(scale === 1 ? null : makeBitmapMock(scale)),
    });
    expect(result.inserted).toBe(DEFAULT_MIP_CHAIN_SCALES.length - 1);
    expect(result.skipped).toContain(1);
  });

  it('returns zero inserted when the skin has no natural size', async () => {
    const skin = makeSkin([0, 0]);
    const result = await prerenderMipChain(skin, { cache });
    expect(result.inserted).toBe(0);
  });

  it('returns zero inserted when the skin has no _svgImage', async () => {
    const skin = makeSkin([100, 100], /* hasImage */ false);
    const result = await prerenderMipChain(skin, { cache });
    expect(result.inserted).toBe(0);
  });

  it('honours a custom scale list', async () => {
    const skin = makeSkin([100, 100]);
    const result = await prerenderMipChain(skin, {
      cache,
      scales: [0.5, 1, 2],
      factoryFor: (scale) => () => Promise.resolve(makeBitmapMock(scale)),
    });
    expect(result.inserted).toBe(3);
    expect(cache.size).toBe(3);
    expect(cache.get(skin, 0.5)).not.toBeNull();
    expect(cache.get(skin, 1)).not.toBeNull();
    expect(cache.get(skin, 2)).not.toBeNull();
    expect(cache.get(skin, 4)).toBeNull();
  });

  it('skips scales whose resized dimension exceeds maxTextureDimension', async () => {
    const skin = makeSkin([100, 100]);
    const result = await prerenderMipChain(skin, {
      cache,
      maxTextureDimension: 150, // 4× scale → 400 px, exceeds 150
      factoryFor: (scale) => () => Promise.resolve(makeBitmapMock(scale)),
    });
    expect(result.skipped).toContain(2);
    expect(result.skipped).toContain(4);
    // The 0.25 / 0.5 / 1 scales still fit.
    expect(cache.get(skin, 0.25)).not.toBeNull();
    expect(cache.get(skin, 0.5)).not.toBeNull();
    expect(cache.get(skin, 1)).not.toBeNull();
  });

  it('lookupMip returns null for an unpopulated scale', () => {
    const skin = makeSkin();
    expect(lookupMip(skin, 1)).toBeNull();
  });

  it('2nd prerender against the same skin reuses the cache (no new factory calls on hit)', async () => {
    const skin = makeSkin([100, 100]);
    const calls: number[] = [];
    const factory = (scale: number) => () => {
      calls.push(scale);
      return Promise.resolve(makeBitmapMock(scale));
    };
    await prerenderMipChain(skin, { cache, factoryFor: factory });
    const callsAfterFirst = calls.length;
    // Second prerender: every scale should hit the cache; the factory
    // is NOT consulted on a hit. We assert by checking that no further
    // calls were made.
    await prerenderMipChain(skin, { cache, factoryFor: factory });
    expect(calls.length).toBe(callsAfterFirst);
  });

  it('uses the shared singleton cache when no cache is provided', async () => {
    const skin = makeSkin([100, 100]);
    await prerenderMipChain(skin, {
      // No cache option: must default to getSharedSvgBitmapCache().
      factoryFor: (scale) => () => Promise.resolve(makeBitmapMock(scale)),
    });
    // lookupMip consults the shared singleton, so we can read it back.
    expect(lookupMip(skin, 1)).not.toBeNull();
  });
});
