import { getSharedSvgBitmapCache, resetSvgBitmapCacheForTesting as resetCacheForTesting } from './cache';
import { canOffloadToSvgWorker, detectSvgWorkerCapabilities } from './capabilities';
import { DEFAULT_MIP_CHAIN_SCALES } from './mip-chain';
import {
  getSvgWorkerHost,
  initSvgWorker,
  resetSvgWorkerForTesting,
} from './worker-raster';
import type { SvgAccelerationHost, SvgSkinLike } from './types';
import type { SvgAccelerationMode } from '@/types/settings';

/**
 * Main-thread entry point for the Stage 2 SVG acceleration layer.
 * Mirrors the `applyTurboWasmAcceleration` pattern: a single
 * `applySvgAcceleration(scaffolding, { mode })` call installs /
 * removes the host on the renderer. When `mode === 'off'`, the host
 * is uninstalled (the renderer property is `undefined`), and the
 * vendored `SVGSkin` patch's host branch is a no-op — pixel-identical
 * to the Stage 1 TurboWarp baseline.
 *
 * When `mode !== 'off'`, the host resolves `getOrCreateMip` to a
 * lookup against the LRU cache (`cache.ts`); on a miss, it falls
 * back to either the worker (`mip-chain` mode) or the main-thread
 * `createImageBitmap` path (`cache-only` mode or the Safari FP
 * fallback inside `mip-chain`).
 *
 * **Contract with the vendored SVGSkin patch (Step 7)**: the patch
 * reads `this._renderer._twWasmSvgAcceleration` synchronously inside
 * `createMIP`. The host exposes a synchronous `getOrCreateMip` that
 * returns `null` on a miss so the patch can fall through to the
 * Stage 1 `drawImage(svgImage, 0, 0)` path. The async `prerender`
 * is fire-and-forget; the host's `invalidate(skin)` is called from
 * the patch's `resetMIPs` path so a costume swap clears the chain.
 *
 * The host object is **shared across `apply` calls** so toggling
 * between `cache-only` and `mip-chain` does not blow away the
 * accumulated cache. Toggling back to `off` via
 * `removeSvgAcceleration` clears the cache and terminates the worker.
 */

export interface ApplySvgAccelerationArgs {
  /**
   * The active SVG acceleration mode. When `'off'`, the host is
   * uninstalled and the runtime falls through to the Stage 1
   * `drawImage` path. When `'resvg-visual-equivalence'`, treated as
   * `'off'` until a future Stage wires the resvg hook.
   */
  mode: SvgAccelerationMode;
}

export interface ScaffoldingLike {
  renderer: unknown;
}

interface RendererWithAcceleration {
  _twWasmSvgAcceleration?: SvgAccelerationHost | null;
}

export function applySvgAcceleration(
  scaffolding: ScaffoldingLike | null | undefined,
  args: ApplySvgAccelerationArgs,
): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithAcceleration | null | undefined;
  if (!renderer) return;
  // `'resvg-visual-equivalence'` is reserved for a future Stage.
  // Until then we treat it as `'off'` so the UI does not silently
  // hang the runtime on a not-yet-implemented mode.
  const mode: 'off' | 'cache-only' | 'mip-chain' =
    args.mode === 'resvg-visual-equivalence' ? 'off' : args.mode;
  if (mode === 'off') {
    renderer._twWasmSvgAcceleration = null;
    return;
  }
  renderer._twWasmSvgAcceleration = createHost(mode);
}

export function removeSvgAcceleration(
  scaffolding: ScaffoldingLike | null | undefined,
): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithAcceleration | null | undefined;
  if (!renderer) return;
  renderer._twWasmSvgAcceleration = null;
}

/**
 * Compute the effective mode actually running on the host. Differs
 * from `args.mode` when `mip-chain` is selected but OffscreenCanvas is
 * unavailable — the host transparently downgrades to main-thread
 * `createImageBitmap` and reports `workerActive: false`. Used by
 * `__exposeForBrowserVerify` and `!dump`.
 */
export function isSvgAccelerationReady(): boolean {
  return canOffloadToSvgWorker();
}

/**
 * Drop the host, clear the LRU cache, and terminate the worker. Use
 * for hard reset (e.g. project unload, settings reset). Mirrors
 * `removeTurboWasmAcceleration`'s lifecycle.
 */
export async function disposeSvgAcceleration(): Promise<void> {
  await resetSvgWorkerForTesting();
  resetCacheForTesting();
}

function createHost(mode: 'cache-only' | 'mip-chain'): SvgAccelerationHost {
  const cache = getSharedSvgBitmapCache();
  const capabilities = detectSvgWorkerCapabilities();
  const workerActive = mode === 'mip-chain' && capabilities.worker && capabilities.offscreenCanvas;

  // Eagerly initialise the worker when in `mip-chain` mode so the
  // first costume load does not pay the ~100-200 ms cold-start cost.
  // The init is fire-and-forget; until it resolves, the host's
  // `getOrCreateMip` falls back to main-thread `createImageBitmap`.
  let workerReady: Promise<unknown> | null = null;
  if (workerActive) {
    workerReady = initSvgWorker().catch(() => null);
  }

  const getOrCreateMip = (skin: SvgSkinLike, scale: number): ImageBitmap | null => {
    // Synchronous read path: the SVGSkin patch's hook is sync.
    const hit = cache.get(skin, scale);
    if (hit) return hit;
    // Cache miss: trigger an async fill. The patch's fallback runs
    // the Stage 1 `drawImage` path for THIS call, but the next
    // `createMIP` for the same (skin, scale) will hit the cache.
    void fillCacheAsync(skin, scale, mode, workerReady);
    return null;
  };

  const invalidate = (skin: SvgSkinLike): void => {
    cache.invalidate(skin);
  };

  return {
    mode,
    workerActive,
    getOrCreateMip,
    invalidate,
  };
}

async function fillCacheAsync(
  skin: SvgSkinLike,
  scale: number,
  mode: 'cache-only' | 'mip-chain',
  workerReady: Promise<unknown> | null,
): Promise<void> {
  const cache = getSharedSvgBitmapCache();
  if (cache.get(skin, scale)) return;
  const [baseW, baseH] = skin._size ?? [0, 0];
  if (baseW <= 0 || baseH <= 0) return;
  const targetW = Math.max(1, Math.round(baseW * scale));
  const targetH = Math.max(1, Math.round(baseH * scale));

  if (mode === 'cache-only') {
    // `cache-only` never pre-decodes; it fills the cache lazily on
    // the next `getOrCreateMip` call via the standard `createImageBitmap`
    // path. We rely on the patch's fallback (Stage 1 `drawImage`) for
    // the first call and let the next one hit the cache.
    return;
  }

  // `mip-chain` mode: the Worker path offloads the SVG decode.
  // When the worker is not available (Safari FP, etc.), we still
  // fall back to main-thread `createImageBitmap` so the chain
  // eventually fills.
  await workerReady;
  const host = getSvgWorkerHost();
  if (host && host.workerActive && skin._svgImage) {
    // The worker decodes the raw SVG text. We pull it from the
    // HTMLImageElement's src (always a `data:image/svg+xml;utf8,...`
    // URL set by SVGSkin.setSVG). Decoding the data URL via fetch
    // is the only cross-origin-safe way to recover the SVG text.
    const src = skin._svgImage.src;
    if (src.startsWith('data:image/svg+xml')) {
      const svgText = decodeSvgFromDataUrl(src);
      if (svgText) {
        const bitmap = await host.request(svgText, baseW, baseH, scale);
        if (bitmap) {
          await cache.populate(skin, scale, async () => bitmap);
        }
        return;
      }
    }
  }
  // Main-thread fallback.
  const bitmap = await createImageBitmap(skin, targetW, targetH);
  if (bitmap) {
    await cache.populate(skin, scale, async () => bitmap);
  }
}

async function createImageBitmap(
  skin: SvgSkinLike,
  width: number,
  height: number,
): Promise<ImageBitmap | null> {
  if (typeof globalThis.createImageBitmap !== 'function') return null;
  const img = skin._svgImage;
  if (!img) return null;
  try {
    return await globalThis.createImageBitmap(img, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
  } catch {
    return null;
  }
}

function decodeSvgFromDataUrl(url: string): string | null {
  // The SVGSkin sets `src = 'data:image/svg+xml;utf8,<encoded>'`. The
  // optional `;charset=...` and `;base64` forms are tolerated.
  const match = /^data:image\/svg\+xml(?:;[^,]+)?,(.*)$/.exec(url);
  if (!match) return null;
  const payload = match[1] ?? '';
  try {
    if (url.includes(';base64')) {
      return atob(payload);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

export { DEFAULT_MIP_CHAIN_SCALES };
