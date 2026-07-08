/**
 * Subset of the vendored scratch-render `SVGSkin` surface that the SVG
 * acceleration layer needs. The full skin class is not exported from
 * scratch-render (vendored as a transitive npm dep), so we declare a
 * structural type covering the fields we read.
 *
 * Two fields are sufficient:
 *   - `_svgImage`: the browser's decoded HTMLImageElement carrying the
 *     SVG raster. `createImageBitmap(svgImage)` is the entry point that
 *     yields a GPU-uploadable `ImageBitmap`.
 *   - `_size`: the natural `[width, height]` of the SVG in Scratch
 *     units. Used as the cache key prefix so a costume swap invalidates
 *     every cached MIP.
 */
export interface SvgSkinLike {
  _svgImage?: HTMLImageElement | null;
  _size?: readonly [number, number] | number[];
}

export interface RendererLike {
  _twWasmSvgAcceleration?: SvgAccelerationHost | null;
}

export interface SvgAccelerationHost {
  /**
   * The active mode. `'off'` means the host is uninstalled (i.e. this
   * object is `null`); the property is here for defence-in-depth and to
   * give `__exposeForBrowserVerify` something readable to dump.
   */
  mode: 'cache-only' | 'mip-chain';
  /**
   * Look up a pre-decoded MIP at the given scale. Returns `null` on a
   * cache miss so the caller can fall back to the Stage 1 `drawImage`
   * path. The returned `ImageBitmap` is GPU-uploadable.
   */
  getOrCreateMip: (skin: SvgSkinLike, scale: number) => ImageBitmap | null;
  /**
   * Drop every cached MIP for `skin`. Called from `SVGSkin.resetMIPs`
   * via the patch hook so a costume swap invalidates the chain.
   */
  invalidate: (skin: SvgSkinLike) => void;
  /**
   * Effective strategy actually running on this host. Differs from
   * `mode` when `mip-chain` is selected but OffscreenCanvas is
   * unavailable — the host transparently downgrades to main-thread
   * `createImageBitmap` and reports `workerActive: false` so
   * `__exposeForBrowserVerify` / `!dump` can surface it.
   */
  workerActive: boolean;
}
