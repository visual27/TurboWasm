import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SvgBitmapCache, getSharedSvgBitmapCache, resetSvgBitmapCacheForTesting } from '@/runtime/tw-wasm/svg-acceleration/cache';
import type { SvgSkinLike } from '@/runtime/tw-wasm/svg-acceleration/types';

/**
 * Tests for the LRU ImageBitmap cache used by Stage 2 of the
 * TurboWasm Acceleration plan. The cache is a thin in-memory data
 * structure over `ImageBitmap`; we mock the bitmap with a plain
 * object that records `close()` calls so the eviction logic can be
 * asserted in jsdom.
 */

interface BitmapMock {
  closed: boolean;
  width: number;
  height: number;
  close(): void;
}

function makeBitmapMock(): BitmapMock {
  return { closed: false, width: 1, height: 1, close() { this.closed = true; } };
}

function makeBitmapLike(): { mock: BitmapMock; bitmap: ImageBitmap } {
  const mock = makeBitmapMock();
  const bitmap = mock as unknown as ImageBitmap;
  return { mock, bitmap };
}

function makeSkin(size: readonly [number, number] = [100, 100]): SvgSkinLike {
  return { _size: size };
}

describe('SvgBitmapCache', () => {
  let cache: SvgBitmapCache;

  beforeEach(() => {
    cache = new SvgBitmapCache();
  });

  it('returns null on a cache miss', () => {
    const skin = makeSkin();
    expect(cache.get(skin, 1)).toBeNull();
    expect(cache.entryCountFor(skin)).toBe(0);
  });

  it('stores a bitmap and returns it on a subsequent get', async () => {
    const skin = makeSkin();
    const { bitmap } = makeBitmapLike();
    const result = await cache.populate(skin, 1, async () => bitmap);
    expect(result).toBe(bitmap);
    const got = cache.get(skin, 1);
    expect(got).toBe(bitmap);
    expect(cache.entryCountFor(skin)).toBe(1);
  });

  it('keeps separate entries for different scales on the same skin', async () => {
    const skin = makeSkin();
    const bm1 = makeBitmapLike();
    const bm2 = makeBitmapLike();
    const bm3 = makeBitmapLike();
    await cache.populate(skin, 0.5, async () => bm1.bitmap);
    await cache.populate(skin, 1, async () => bm2.bitmap);
    await cache.populate(skin, 2, async () => bm3.bitmap);
    expect(cache.get(skin, 0.5)).toBe(bm1.bitmap);
    expect(cache.get(skin, 1)).toBe(bm2.bitmap);
    expect(cache.get(skin, 2)).toBe(bm3.bitmap);
    expect(cache.entryCountFor(skin)).toBe(3);
  });

  it('does not share entries between two skins', async () => {
    const skinA = makeSkin();
    const skinB = makeSkin();
    const bmA = makeBitmapLike();
    const bmB = makeBitmapLike();
    await cache.populate(skinA, 1, async () => bmA.bitmap);
    await cache.populate(skinB, 1, async () => bmB.bitmap);
    expect(cache.get(skinA, 1)).toBe(bmA.bitmap);
    expect(cache.get(skinB, 1)).toBe(bmB.bitmap);
  });

  it('evicts the LRU entry on a 65th insertion and calls close()', async () => {
    const skin = makeSkin();
    // Insert 64 bitmaps at distinct scales. The first one is the LRU.
    const first = makeBitmapLike();
    await cache.populate(skin, 1, async () => first.bitmap);
    for (let i = 2; i <= 64; i += 1) {
      await cache.populate(skin, i, async () => makeBitmapLike().bitmap);
    }
    // Touch scale=2 to push it ahead of scale=1 in LRU order.
    const touched = cache.get(skin, 2);
    expect(touched).not.toBeNull();
    // Insert the 65th — the LRU (scale=1) must be evicted.
    const sixtyFifth = makeBitmapLike();
    await cache.populate(skin, 65, async () => sixtyFifth.bitmap);
    expect(cache.get(skin, 1)).toBeNull();
    expect(first.mock.closed).toBe(true);
    expect(cache.get(skin, 65)).toBe(sixtyFifth.bitmap);
  });

  it('honours a custom capacity', async () => {
    const small = new SvgBitmapCache({ capacity: 2 });
    const skin = makeSkin();
    const bm1 = makeBitmapLike();
    const bm2 = makeBitmapLike();
    const bm3 = makeBitmapLike();
    await small.populate(skin, 1, async () => bm1.bitmap);
    await small.populate(skin, 2, async () => bm2.bitmap);
    await small.populate(skin, 3, async () => bm3.bitmap);
    expect(bm1.mock.closed).toBe(true);
    expect(small.get(skin, 1)).toBeNull();
    expect(small.get(skin, 2)).toBe(bm2.bitmap);
    expect(small.get(skin, 3)).toBe(bm3.bitmap);
  });

  it('rejects non-positive capacities', () => {
    expect(() => new SvgBitmapCache({ capacity: 0 })).toThrow(RangeError);
    expect(() => new SvgBitmapCache({ capacity: -1 })).toThrow(RangeError);
    expect(() => new SvgBitmapCache({ capacity: 1.5 })).toThrow(RangeError);
  });

  it('invalidate closes every entry for the skin and forgets the skin', async () => {
    const skin = makeSkin();
    const bm1 = makeBitmapLike();
    const bm2 = makeBitmapLike();
    await cache.populate(skin, 1, async () => bm1.bitmap);
    await cache.populate(skin, 2, async () => bm2.bitmap);
    cache.invalidate(skin);
    expect(bm1.mock.closed).toBe(true);
    expect(bm2.mock.closed).toBe(true);
    expect(cache.entryCountFor(skin)).toBe(0);
    expect(cache.get(skin, 1)).toBeNull();
  });

  it('invalidate is a no-op for unknown skins', () => {
    expect(() => cache.invalidate(makeSkin())).not.toThrow();
  });

  it('clear() drops every cached entry across every skin', async () => {
    const skinA = makeSkin();
    const skinB = makeSkin();
    const bmA = makeBitmapLike();
    const bmB = makeBitmapLike();
    await cache.populate(skinA, 1, async () => bmA.bitmap);
    await cache.populate(skinB, 1, async () => bmB.bitmap);
    cache.clear();
    expect(bmA.mock.closed).toBe(true);
    expect(bmB.mock.closed).toBe(true);
  });

  it('returns null and leaves the cache untouched when the factory returns null', async () => {
    const skin = makeSkin();
    const result = await cache.populate(skin, 1, async () => null);
    expect(result).toBeNull();
    expect(cache.entryCountFor(skin)).toBe(0);
  });

  it('detects a costume swap via _size change and returns a miss', async () => {
    const skin = makeSkin([100, 100]);
    const bm = makeBitmapLike();
    await cache.populate(skin, 1, async () => bm.bitmap);
    // The skin is now a different size — the cached bitmap is stale.
    skin._size = [200, 200];
    expect(cache.get(skin, 1)).toBeNull();
    expect(bm.mock.closed).toBe(true);
  });

  it('overwriting the same scale closes the previous bitmap', async () => {
    const skin = makeSkin();
    const bm1 = makeBitmapLike();
    const bm2 = makeBitmapLike();
    await cache.populate(skin, 1, async () => bm1.bitmap);
    await cache.populate(skin, 1, async () => bm2.bitmap);
    expect(bm1.mock.closed).toBe(true);
    expect(cache.get(skin, 1)).toBe(bm2.bitmap);
  });

  it('setCapacity re-bases the cap for future inserts', async () => {
    const skin = makeSkin();
    const bm1 = makeBitmapLike();
    const bm2 = makeBitmapLike();
    const bm3 = makeBitmapLike();
    await cache.populate(skin, 1, async () => bm1.bitmap);
    await cache.populate(skin, 2, async () => bm2.bitmap);
    cache.setCapacity(1);
    await cache.populate(skin, 3, async () => bm3.bitmap);
    // The slot is now at size 3 (> capacity 1), so enforceCapacity
    // evicts the LRU entry — bm1 (lowest tick).
    expect(bm1.mock.closed).toBe(true);
    expect(bm2.mock.closed).toBe(false);
    expect(bm3.mock.closed).toBe(false);
    expect(cache.get(skin, 1)).toBeNull();
    expect(cache.get(skin, 2)).toBe(bm2.bitmap);
    expect(cache.get(skin, 3)).toBe(bm3.bitmap);
  });
});

describe('getSharedSvgBitmapCache / resetSvgBitmapCacheForTesting', () => {
  afterEach(() => {
    resetSvgBitmapCacheForTesting();
  });

  it('returns the same instance across calls', () => {
    const a = getSharedSvgBitmapCache();
    const b = getSharedSvgBitmapCache();
    expect(a).toBe(b);
  });

  it('reset drops the reference and closes every cached bitmap', async () => {
    const cache = getSharedSvgBitmapCache();
    const skin = makeSkin();
    const bm = makeBitmapLike();
    await cache.populate(skin, 1, async () => bm.bitmap);
    resetSvgBitmapCacheForTesting();
    expect(bm.mock.closed).toBe(true);
    // Next call returns a fresh singleton.
    const next = getSharedSvgBitmapCache();
    expect(next).not.toBe(cache);
    expect(next.entryCountFor(skin)).toBe(0);
  });
});
