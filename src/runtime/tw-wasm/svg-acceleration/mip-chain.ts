import { getSharedSvgBitmapCache, SvgBitmapCache } from './cache';
import type { SvgSkinLike } from './types';

/**
 * Pre-decoded MIP chain for an SVGSkin. Stage 2 of the TurboWasm
 * Acceleration plan: the goal is to short-circuit the browser's per-`setSVG`
 * SVG-parse cost by pre-decoding the SVG at multiple scales (0.25x,
 * 0.5x, 1x, 2x, 4x) and storing each as an `ImageBitmap` in the LRU
 * cache. When `SVGSkin.createMIP(scale)` is called by the renderer, the
 * patch hook consults this cache and reuses the pre-decoded bitmap
 * instead of doing a fresh `drawImage(svgImage)` upscale.
 *
 * **Pixel identity**: every MIP is decoded via the browser's native
 * `createImageBitmap` or `OffscreenCanvas.drawImage`, which produces the
 * same pixels as the original `drawImage(svgImage, 0, 0)` path. The
 * cache only memoises the decode; the final upload still goes through
 * `twgl.createTexture` with the cached bitmap as the `src`. As long
 * as the raster bytes are identical, the Stage 1 bit-identical
 * contract is preserved.
 *
 * **Memory**: each `ImageBitmap` allocates one RGBA byte per pixel.
 * Worst case is 5 scales × 512×512 × 4 byte ≈ 5 MB per skin. With the
 * 64-entry LRU cap (`SvgBitmapCache`'s default), peak memory for the
 * entire cache is ~320 MB. The user can reduce this by picking a
 * smaller `maxTextureScale` for their project.
 */

const MIP_CHAIN_SCALES = [0.25, 0.5, 1, 2, 4] as const;

/**
 * Pre-decode the SVG into every scale in the chain and populate the
 * shared cache. Returns the number of bitmaps actually inserted (i.e.
 * the count of scales the browser successfully decoded). The function
 * never throws — `createImageBitmap` failures are silently swallowed
 * and the corresponding scale is skipped, matching the original
 * scratch-render "missing texture → super.getTexture()" fallback.
 *
 * `factoryFor(scale)` is the `createImageBitmap` factory for the given
 * scale. The default factory uses
 * `createImageBitmap(svgImage, { resizeWidth, resizeHeight, resizeQuality: 'high' })`
 * so the browser's native decoder handles the scaling — this is the
 * key invariant that keeps the output bit-identical to the Stage 1
 * TurboWarp `drawImage(svgImage, 0, 0)` path.
 */
export interface PrerenderOptions {
  /**
   * Override the default scale chain. The default is
   * `[0.25, 0.5, 1, 2, 4]`. Custom lists must use positive numbers
   * (the chain math is `ceil(log2(scale)) + INDEX_OFFSET` in the
   * vendored scratch-render, so non-power-of-two scales work but may
   * produce less common MIPs).
   */
  scales?: readonly number[];
  /**
   * The `ImageBitmap` factory for each scale. Defaults to
   * `createImageBitmap(svgImage, { resizeWidth, resizeHeight })`.
   * Tests inject a mock that returns a pre-built `ImageBitmap` without
   * touching the browser.
   */
  factoryFor?: (scale: number) => () => Promise<ImageBitmap | null>;
  /**
   * The cache instance to populate. Defaults to the shared singleton
   * (`getSharedSvgBitmapCache()`). Tests inject a fresh cache to
   * avoid cross-test pollution.
   */
  cache?: SvgBitmapCache;
  /**
   * Maximum texture dimension the renderer will ever ask for. Scales
   * whose resulting `baseW * scale` exceeds this are skipped so the
   * cache never holds a MIP the renderer would discard anyway. The
   * default is `Infinity` (no skip), matching Stage 1's "render at
   * every scale the renderer requests" behaviour.
   */
  maxTextureDimension?: number;
}

export interface PrerenderResult {
  /** Number of bitmaps actually inserted into the cache. */
  inserted: number;
  /** Scales that were skipped (e.g. browser refused `createImageBitmap`). */
  skipped: readonly number[];
}

/**
 * Detect whether `createImageBitmap` is available. The runtime path
 * always feature-detects before calling `prerender`; this function
 * exists as a single source of truth for the check.
 */
export function canCreateImageBitmap(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof Image !== 'undefined' &&
    typeof Image.prototype !== 'undefined'
  );
}

/**
 * Default factory: `createImageBitmap(svgImage, { resizeWidth, resizeHeight })`.
 * Uses the browser's high-quality resize (bilinear) so the MIP output
 * is bit-identical to the original `setTransform(scale,...)` +
 * `drawImage(svgImage, 0, 0)` path in scratch-render.
 */
function defaultFactoryFor(skin: SvgSkinLike, baseW: number, baseH: number) {
  return (scale: number) => async (): Promise<ImageBitmap | null> => {
    if (typeof createImageBitmap !== 'function') return null;
    const w = Math.max(1, Math.round(baseW * scale));
    const h = Math.max(1, Math.round(baseH * scale));
    const svgImage = skin._svgImage;
    if (!svgImage) return null;
    // The browser's `createImageBitmap` accepts an HTMLImageElement
    // source. We deliberately use `resizeQuality: 'high'` (the
    // default) to match the existing `drawImage(svgImage, 0, 0)` path
    // — switching to 'low' or 'pixelated' would change the MIP pixels
    // and break the Stage 1 bit-identity contract.
    return createImageBitmap(svgImage, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
  };
}

/**
 * Pre-decode the SVG into the MIP chain. Safe to call from `setSVG`'s
 * `onload` callback: it runs the `createImageBitmap` chain on the
 * current microtask and returns a `Promise<PrerenderResult>` the
 * caller can `await` (or fire-and-forget, since failures are
 * swallowed).
 *
 * The `canCreateImageBitmap` guard is **skipped** when the caller
 * provides a `factoryFor` option (the caller is asserting decode is
 * possible; the test suite uses this to inject mock factories in
 * jsdom where the global is absent).
 *
 * **Cache-friendly**: scales that already have a valid entry in the
 * cache (i.e. a bitmap that was decoded for the same `_size` tuple
 * earlier) are skipped — `factoryFor(scale)` is not invoked again.
 * This is the G1 (95%+) cache-hit-rate target from the spec: a
 * project that reloads the same SVG does not pay any decode cost on
 * the second pass.
 */
export async function prerenderMipChain(
  skin: SvgSkinLike,
  options: PrerenderOptions = {},
): Promise<PrerenderResult> {
  const scales = options.scales ?? MIP_CHAIN_SCALES;
  if (!options.factoryFor && !canCreateImageBitmap()) {
    return { inserted: 0, skipped: [...scales] };
  }
  const [baseW, baseH] = skin._size ?? [0, 0];
  if (baseW <= 0 || baseH <= 0) {
    return { inserted: 0, skipped: [...scales] };
  }
  const maxDim = options.maxTextureDimension ?? Number.POSITIVE_INFINITY;
  const factoryFor = options.factoryFor ?? defaultFactoryFor(skin, baseW, baseH);
  const cache = options.cache ?? getSharedSvgBitmapCache();

  let inserted = 0;
  const skipped: number[] = [];
  // Sequentially populate to bound peak memory. Parallel populate
  // would briefly hold 5× the GPU memory of the largest MIP.
  for (const scale of scales) {
    const w = Math.max(1, Math.round(baseW * scale));
    const h = Math.max(1, Math.round(baseH * scale));
    if (w > maxDim || h > maxDim) {
      skipped.push(scale);
      continue;
    }
    // Cache hit fast path: a prior `prerenderMipChain` (or a manual
    // `cache.populate`) already stored a bitmap for this skin+scale.
    // The size check inside `cache.get` covers the "stale entry"
    // case (costume swap without explicit invalidate) and returns
    // `null` so we fall through to the populate path below.
    if (cache.get(skin, scale)) {
      inserted += 1;
      continue;
    }
    const result = await cache.populate(skin, scale, factoryFor(scale));
    if (result) inserted += 1;
    else skipped.push(scale);
  }
  return { inserted, skipped };
}

/**
 * The default MIP scale chain. Exported so the Settings UI and
 * `!dump` can show the user what scales are being pre-decoded.
 */
export const DEFAULT_MIP_CHAIN_SCALES: readonly number[] = MIP_CHAIN_SCALES;

/**
 * Synchronous cache lookup. Used by the SVGSkin patch's `getOrCreateMip`
 * hook to consult the pre-decoded chain before falling back to the
 * Stage 1 `drawImage` path.
 */
export function lookupMip(skin: SvgSkinLike, scale: number): ImageBitmap | null {
  return getSharedSvgBitmapCache().get(skin, scale);
}
