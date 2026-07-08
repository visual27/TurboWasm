/**
 * Host-side glue that exposes the resvg-wasm rasteriser to the vendored
 * `SVGSkin.setSVG` flow. Phase 4 of the TurboWasm performance spec.
 *
 * The vendored scratch-render is patched (see
 * `patches/wasm-collision-runtime+0.1.0.patch`) to call back into this
 * module via a host-attached property, conventionally
 * `renderer._twWasmRasterSvgCostume` for the per-call sync variant.
 *
 * Until `initSvgRaster` succeeds, the hook returns `null` so the vendored
 * skin keeps using the native browser Image decoder. That fallback is
 * fully transparent to downstream consumers (Silhouette reads the same
 * `Uint8ClampedArray` either way), so the cost of having the hook
 * installed but disabled is essentially zero.
 */

import {
  rasterizeSvgToImageData,
  isSvgRasterReady,
  type RasterizedSvg,
} from './svg-raster';

export interface SvgRasterHook {
  /**
   * Synchronous readiness flag. `false` means the vendored `SVGSkin` falls
   * through to its native browser Image decoder; `true` means the hook
   * is consulted on every `setSVG` call.
   */
  isReady(): boolean;
  /**
   * Try to rasterise `svgString` at `targetWidth` pixels wide. Returns
   * `null` on any failure (invalid SVG, resvg internal error, ...).
   *
   * The vendored SVGSkin writes the returned `data: Uint8ClampedArray`
   * straight into a scratch `ImageData` and then proceeds through the
   * existing `Silhouette.update(...)` pipeline; the downstream behaviour
   * is therefore identical to the native Image decoder path.
   */
  rasterize(svgString: string, targetWidth: number): RasterizedSvg | null;
}

export function createSvgRasterHook(): SvgRasterHook {
  return {
    isReady: () => isSvgRasterReady(),
    rasterize: (svgString, targetWidth) =>
      rasterizeSvgToImageData(svgString, targetWidth),
  };
}

/**
 * Attach the hook to a renderer-like object so the vendored SVGSkin can
 * consult it from its patched `setSVG` / `createMIP` paths. Existing
 * attachments are overwritten — this is intentional so a settings change
 * that toggles `legacy-only` / `force-wasm` can re-wire the hook.
 */
export function attachSvgRasterHook(renderer: unknown, hook: SvgRasterHook): void {
  if (!renderer || typeof renderer !== 'object') return;
  Object.defineProperty(renderer, '_twWasmRasterSvgCostume', {
    value: hook,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function detachSvgRasterHook(renderer: unknown): void {
  if (!renderer || typeof renderer !== 'object') return;
  try {
    // `delete` is the safe path; `Object.defineProperty` with `value:
    // undefined` would leave the field readable as `undefined`, which
    // would still trigger the patch's branch and skip the resvg path.
    delete (renderer as { _twWasmRasterSvgCostume?: unknown })._twWasmRasterSvgCostume;
  } catch {
    /* ignore */
  }
}
