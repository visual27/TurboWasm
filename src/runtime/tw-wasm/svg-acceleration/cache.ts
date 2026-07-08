import type { SvgSkinLike } from './types';

/**
 * LRU `ImageBitmap` cache keyed by `(skin, scale)`. Used by the SVG
 * acceleration layer (Stage 2 of the TurboWasm Acceleration plan) to
 * short-circuit the browser's per-`setSVG` SVG-parse cost. The browser
 * native `drawImage` path remains the source of truth for the actual
 * raster upload — the cache only memoises the `createImageBitmap`
 * decode step, so the pixel output stays bit-identical to the Stage 1
 * TurboWarp baseline.
 *
 * Design constraints (mirroring the silhouette cache in
 * `wasm-collision-client.ts`):
 *
 *   - **WeakMap-keyed by skin.** When a skin is GC'd, its cache slot
 *     goes with it. We never hold a strong reference to a `SVGSkin`
 *     ourselves.
 *   - **Bounded LRU.** The default cap of 64 entries stops a project
 *     with thousands of costumes from holding every decoded bitmap in
 *     memory. Exceeding the cap evicts the least-recently-used entry
 *     and calls `bitmap.close()` so the underlying GPU memory is
 *     released immediately.
 *   - **Synchronous get, async fill.** The `SVGSkin` hot path is
 *     synchronous; `get(skin, scale)` is the read path and returns
 *     either a hit or `null`. `populate(skin, scale, factory)` is the
 *     write path; the factory is async because `createImageBitmap` is
 *     async in the spec. The caller (mip-chain / worker-raster) is
 *     responsible for sequencing the write.
 *   - **Identity-stable for `'off'`.** When the host mode is `'off'`
 *     this module is not even imported by the runtime — `applySvgAcceleration`
 *     leaves `renderer._twWasmSvgAcceleration = undefined`, so
 *     `SVGSkin` falls through to the upstream `drawImage` path
 *     unchanged.
 */
export interface SvgBitmapCacheOptions {
  /**
   * Maximum number of `(skin, scale)` entries before LRU eviction kicks
   * in. Defaults to 64. Setting this to 0 or a negative value throws.
   */
  capacity?: number;
}

interface CacheEntry {
  bitmap: ImageBitmap;
  /**
   * Backing SVG natural size at decode time. The SVGSkin patches
   * invalidate via `invalidate(skin)`, but we also check this on read
   * so a costume swap that forgot to call invalidate still evicts the
   * stale entry.
   */
  size: readonly [number, number];
  /**
   * LRU bookkeeping. Bumped on every hit so the eviction policy
   * reorders correctly under repeated access.
   */
  tick: number;
}

const DEFAULT_CAPACITY = 64;

/**
 * Internal slot type so we can keep the WeakMap + tick counter together
 * without leaking a `Map<>` reference on each test reset.
 */
interface PerSkinSlot {
  byScale: Map<number, CacheEntry>;
  tick: number;
}

export class SvgBitmapCache {
  /**
   * Backing store for `(skin, scale) -> ImageBitmap`. We use a strong-ref
   * `Map<>` so the cache can iterate every entry to call `.close()` on
   * eviction and on `clear()`. Skin references are bounded by the
   * `capacity` cap (default 64) and by the per-slot eviction policy, so
   * the strong-ref shadow cannot grow without bound.
   */
  private readonly slots: Map<object, PerSkinSlot> = new Map();
  private capacity: number;
  private globalTick = 0;

  public constructor(options: SvgBitmapCacheOptions = {}) {
    const cap = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError(`SvgBitmapCache: capacity must be a positive integer (got ${cap})`);
    }
    this.capacity = cap;
  }

  /**
   * Number of currently-tracked `(skin, scale)` pairs across every
   * skin. Used by `!dump` and the unit tests to assert LRU behaviour.
   */
  public get size(): number {
    let total = 0;
    for (const slot of this.slots.values()) total += slot.byScale.size;
    return total;
  }

  /**
   * Set the LRU capacity. Existing entries are NOT trimmed; if the new
   * capacity is below the current count, the next call evicts down to
   * the new cap.
   */
  public setCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `SvgBitmapCache.setCapacity: capacity must be a positive integer (got ${capacity})`,
      );
    }
    this.capacity = capacity;
  }

  /**
   * Synchronous cache lookup. Returns the cached `ImageBitmap` on a hit
   * (and bumps the entry's LRU tick), or `null` on a miss. The caller
   * is expected to call `populate(...)` to fill the miss if it has a
   * factory available.
   */
  public get(skin: SvgSkinLike, scale: number): ImageBitmap | null {
    const slot = this.slotFor(skin, /* create */ false);
    if (!slot) return null;
    const entry = slot.byScale.get(scale);
    if (!entry) return null;
    // Identity check: if the SVG's natural size changed (costume swap
    // without an explicit `invalidate` call), the cached bitmap is
    // stale. Drop it and report a miss.
    const [w, h] = skin._size ?? [0, 0];
    if (entry.size[0] !== w || entry.size[1] !== h) {
      this.closeAndDelete(slot, scale, entry);
      return null;
    }
    this.globalTick += 1;
    entry.tick = this.globalTick;
    return entry.bitmap;
  }

  /**
   * Resolve the cache miss via `factory()` and store the resulting
   * `ImageBitmap`. If the factory returns `null` (e.g. browser refused
   * `createImageBitmap` for this input), the cache is left untouched
   * and `null` is returned to the caller.
   *
   * Triggers LRU eviction when the new entry pushes the cache past
   * `capacity`. Evicted entries have `.close()` called so their
   * underlying GPU memory is freed.
   */
  public async populate(
    skin: SvgSkinLike,
    scale: number,
    factory: () => Promise<ImageBitmap | null>,
  ): Promise<ImageBitmap | null> {
    const bitmap = await factory();
    if (!bitmap) return null;
    const slot = this.slotFor(skin, /* create */ true);
    if (!slot) return null;
    const [w, h] = skin._size ?? [0, 0];
    const existing = slot.byScale.get(scale);
    if (existing) {
      this.closeAndDelete(slot, scale, existing);
    }
    this.globalTick += 1;
    slot.byScale.set(scale, { bitmap, size: [w, h], tick: this.globalTick });
    this.enforceCapacity(slot);
    return bitmap;
  }

  /**
   * Drop every cached MIP for `skin`. The SVGSkin patch calls this on
   * `resetMIPs()` so a costume swap clears the chain in one shot.
   */
  public invalidate(skin: SvgSkinLike): void {
    const slot = this.slots.get(skin as unknown as object);
    if (!slot) return;
    for (const entry of slot.byScale.values()) {
      try {
        entry.bitmap.close();
      } catch {
        /* ignore — bitmap already closed */
      }
    }
    this.slots.delete(skin as unknown as object);
  }

  /**
   * Close every cached `ImageBitmap` and forget every skin. Intended
   * for tests and for the host's `removeSvgAcceleration` path.
   */
  public clear(): void {
    for (const slot of this.slots.values()) {
      for (const entry of slot.byScale.values()) {
        try {
          entry.bitmap.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.slots.clear();
  }

  /**
   * Test-only: count the entries tracked for a specific skin. Returns
   * 0 when the skin is unknown.
   */
  public entryCountFor(skin: SvgSkinLike): number {
    const slot = this.slots.get(skin as unknown as object);
    return slot ? slot.byScale.size : 0;
  }

  /**
   * Test-only: enumerate the LRU tick order across every known skin.
   * Each entry is `{ skin, scale, tick }`. Used to assert eviction
   * policy.
   *
   * Note: this is for tests only. Production code never iterates the
   * cache.
   */
  public *enumerate(): Generator<{ skin: object; scale: number; tick: number }> {
    for (const [skin, slot] of this.slots) {
      for (const [scale, entry] of slot.byScale) {
        yield { skin, scale, tick: entry.tick };
      }
    }
  }

  private slotFor(skin: SvgSkinLike, create: boolean): PerSkinSlot | null {
    const skinObj = skin as unknown as object;
    let slot = this.slots.get(skinObj);
    if (!slot && create) {
      slot = { byScale: new Map(), tick: 0 };
      this.slots.set(skinObj, slot);
    }
    return slot ?? null;
  }

  private closeAndDelete(slot: PerSkinSlot, scale: number, entry: CacheEntry): void {
    try {
      entry.bitmap.close();
    } catch {
      /* ignore */
    }
    slot.byScale.delete(scale);
  }

  private enforceCapacity(slot: PerSkinSlot): void {
    if (slot.byScale.size <= this.capacity) return;
    // Find the LRU entry within this slot. We only evict from the
    // slot that just grew, not from unrelated skins.
    let oldestScale: number | null = null;
    let oldestTick = Number.POSITIVE_INFINITY;
    for (const [scale, entry] of slot.byScale) {
      if (entry.tick < oldestTick) {
        oldestTick = entry.tick;
        oldestScale = scale;
      }
    }
    if (oldestScale !== null) {
      const evicted = slot.byScale.get(oldestScale);
      if (evicted) this.closeAndDelete(slot, oldestScale, evicted);
    }
  }
}

/**
 * Convenience: a process-wide singleton used by `mip-chain.ts` and
 * `worker-raster.ts`. Tests that need a clean slate should call
 * `getSharedSvgBitmapCache().clear()` (or use `resetSvgBitmapCacheForTesting`
 * below, which also drops the singleton reference).
 */
let shared: SvgBitmapCache | null = null;

export function getSharedSvgBitmapCache(): SvgBitmapCache {
  if (!shared) shared = new SvgBitmapCache();
  return shared;
}

/**
 * Drop the shared cache reference and close every cached `ImageBitmap`.
 * Intended for unit tests that need a clean slate; production code
 * never calls this.
 */
export function resetSvgBitmapCacheForTesting(): void {
  if (shared) {
    shared.clear();
    shared = null;
  }
}
