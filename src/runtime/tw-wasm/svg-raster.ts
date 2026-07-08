/**
 * resvg-wasm backed SVG costume rasterisation. Phase 4 of the TurboWasm
 * performance spec. The motivation is *cross-environment consistency*:
 * browsers render the same SVG via different layout / font engines, so a
 * costume that looks correct on Chrome can look subtly different on
 * Safari or Firefox. `resvg` is a single Rust implementation that the
 * Viewer can pin across all environments.
 *
 * On environments without `@resvg/resvg-wasm` (or where the WASM fetch
 * fails), `initSvgRaster` returns `false` and `rasterizeSvgToImageData`
 * returns `null`. The vendored `SVGSkin` continues to use the native
 * browser Image decoder for those cases, which keeps the hook transparent
 * to the rest of the renderer.
 */

interface ResvgLike {
  new (svg: string, options?: ResvgRenderOptions): {
    render(): { width: number; height: number; pixels: Uint8Array; free(): void };
    free(): void;
  };
}

interface ResvgRenderOptions {
  fitTo?: { mode: 'original' } | { mode: 'width'; value: number };
  background?: string;
}

interface ResvgModule {
  initWasm: (input: Promise<Response> | Response) => Promise<void>;
  Resvg: ResvgLike;
}

let resvgModule: ResvgModule | null = null;
let resvgReady = false;
let initPromise: Promise<boolean> | null = null;

export function isSvgRasterReady(): boolean {
  return resvgReady;
}

/**
 * Initialise the resvg-wasm module. Loads
 * `@resvg/resvg-wasm/index_bg.wasm` via Vite's `?url` import so the
 * hashed filename survives the production build. Idempotent: concurrent
 * callers all receive the same promise.
 *
 * Returns `true` when the WASM module was successfully initialised,
 * `false` on any failure (missing dependency, network failure, unsupported
 * environment). The caller should fall through to the native browser
 * Image decoder when this returns `false`.
 */
export async function initSvgRaster(): Promise<boolean> {
  if (resvgReady) return true;
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<boolean> => {
    try {
      const mod = (await import('@resvg/resvg-wasm')) as unknown as ResvgModule;
      const wasmUrl = (
        await import('@resvg/resvg-wasm/index_bg.wasm?url')
      ).default as string;
      await mod.initWasm(fetch(wasmUrl));
      resvgModule = mod;
      resvgReady = true;
      return true;
    } catch (err) {
      resvgModule = null;
      resvgReady = false;
      // eslint-disable-next-line no-console
      console.warn('[svg-raster] resvg-wasm initialisation failed:', err);
      return false;
    }
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export interface RasterizedSvg {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const rasterizeCache = new Map<string, RasterizedSvg>();

function cacheKey(svgString: string, targetWidth: number): string {
  // A fast non-cryptographic hash. We don't need cryptographic strength —
  // collisions just mean a re-rasterize, which is correct but slower.
  let h = 0x811c9dc5;
  for (let i = 0; i < svgString.length; i += 1) {
    h ^= svgString.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${targetWidth}`;
}

/**
 * Rasterise an SVG string into a fixed-width RGBA buffer.
 *
 * Returns `null` when resvg-wasm isn't ready (host hook not initialised
 * or the init failed). The vendored `SVGSkin.setSVG` path then keeps
 * using the browser's native Image decoder, which keeps the hook
 * transparent.
 *
 * The result is **cached** keyed by `(svgString, targetWidth)` — costume
 * costumes typically rasterise the same SVG string multiple times when
 * the silhouette is regenerated, so caching is essential to keep the
 * resvg path competitive with the native path's `data:` URL → Image
 * pipeline.
 */
export function rasterizeSvgToImageData(
  svgString: string,
  targetWidth: number,
): RasterizedSvg | null {
  if (!resvgReady || !resvgModule) return null;
  if (typeof svgString !== 'string' || svgString.length === 0) return null;
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) return null;
  const key = cacheKey(svgString, targetWidth);
  const cached = rasterizeCache.get(key);
  if (cached) return cached;
  try {
    const resvg = new resvgModule.Resvg(svgString, {
      fitTo: { mode: 'width', value: targetWidth },
      background: 'rgba(0,0,0,0)',
    });
    const rendered = resvg.render();
    try {
      const out: RasterizedSvg = {
        width: rendered.width,
        height: rendered.height,
        data: new Uint8ClampedArray(rendered.pixels),
      };
      rasterizeCache.set(key, out);
      return out;
    } finally {
      rendered.free();
      resvg.free();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[svg-raster] rasterize failed:', err);
    return null;
  }
}

/**
 * Test-only helper that re-arms the readiness flag. Production code never
 * reaches for this; only unit tests that want to exercise the "ready"
 * branch of the SVGSkin TW hook need it.
 */
export function resetSvgRasterForTesting(): void {
  resvgModule = null;
  resvgReady = false;
  rasterizeCache.clear();
  initPromise = null;
}

export function setSvgRasterReadyForTesting(value: boolean): void {
  resvgReady = value;
}
