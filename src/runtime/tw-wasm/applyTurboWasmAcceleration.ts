import type { RuntimeCapabilities } from './capabilities';
import {
  wasmIsTouchingColor,
  wasmIsTouchingDrawables,
  isWasmCollisionReady,
} from './wasm-collision-client';
import type { RendererLike } from './wasm-collision-client';
import {
  gpuIsTouchingColor,
  gpuIsTouchingDrawables,
  isGpuCollisionReady,
} from './gpu-collision';
import {
  twWasmDrawSprites,
  isGpuBatchRendererReady,
} from './gpu-batch-renderer';
import type { PerformanceMode } from '@/types/settings';

/**
 * Public-facing description of the WebGPU instanced renderer. Set by
 * {@link initGpuBatchRenderer} on app startup, cleared on dispose. The
 * Settings dialog consults this for the diagnostic surfaces (e.g. showing
 * which backend served the last frame in `!dump`).
 */
export interface GpuBatchRendererSummary {
  /** Skin batch count currently allocated. */
  skinBatches: number;
  /** Total drawables rendered through the GPU batch in the most recent frame. */
  lastDrawables: number;
  /** Frame count since initialisation; useful for the per-frame cost log. */
  frameCount: number;
}

export interface ApplyTurboWasmArgs {
  enabled: boolean;
  caps: RuntimeCapabilities;
  /**
   * User-selected backend mode. Decides the order in which the JS-side
   * hook consults the WebGPU and WASM SIMD paths. `'legacy-only'` clears
   * every TurboWasm hook on the renderer so the runtime falls through to
   * the original scratch-render path with zero behavioural change.
   */
  performanceMode: PerformanceMode;
}

type TurboWasmCallback = (
  renderer: RendererLike,
  drawableID: number,
  candidateIDs: readonly number[],
) => boolean | null;

type TurboWasmColorCallback = (
  renderer: RendererLike,
  drawableID: number,
  color3b: number[] | Uint8Array | null,
  mask3b: number[] | Uint8Array | null | undefined,
) => boolean | null;

interface RendererWithHooks {
  _twWasmIsTouchingDrawables?: TurboWasmCallback | null;
  _twWasmIsTouchingColor?: TurboWasmColorCallback | null;
  _twWasmDrawSprites?: ((renderer: unknown, drawables: readonly number[]) => boolean) | null;
}

/**
 * Decide which JS-side path is consulted first for `isTouchingDrawables`.
 *
 * Priority is derived from `performanceMode`:
 *  - `'legacy-only'` returns `'none'` so the renderer falls through to its
 *    unmodified JS path.
 *  - `'force-wasm'` returns `'wasm'` and ignores WebGPU availability.
 *  - `'force-webgpu'` returns `'gpu'` when WebGPU is ready; otherwise it
 *    falls back to `'wasm'`, then `'none'`.
 *  - `'auto'` returns `'gpu'` when ready, else `'wasm'`, else `'none'`.
 *
 * The function is the single source of truth used by both the drawables
 * and the color hook constructors so the two endpoints stay in sync.
 */
export function selectBackendTier(
  args: ApplyTurboWasmArgs,
  gpuReady: boolean,
  wasmReady: boolean,
): 'gpu' | 'wasm' | 'none' {
  if (!args.enabled) return 'none';
  if (args.performanceMode === 'legacy-only') return 'none';
  if (args.performanceMode === 'force-wasm') {
    return wasmReady ? 'wasm' : 'none';
  }
  if (args.performanceMode === 'force-webgpu') {
    if (gpuReady) return 'gpu';
    if (wasmReady) return 'wasm';
    return 'none';
  }
  // 'auto'
  if (gpuReady) return 'gpu';
  if (wasmReady) return 'wasm';
  return 'none';
}

function patchRenderer(renderer: RendererWithHooks, args: ApplyTurboWasmArgs): void {
  const wasmReady = args.caps.wasmSimd && isWasmCollisionReady();
  const gpuReady = args.caps.webgpu && isGpuCollisionReady();
  const tier = selectBackendTier(args, gpuReady, wasmReady);
  if (tier === 'none') {
    renderer._twWasmIsTouchingDrawables = null;
    renderer._twWasmIsTouchingColor = null;
    renderer._twWasmDrawSprites = null;
    return;
  }
  if (tier === 'gpu') {
    renderer._twWasmIsTouchingDrawables = (rd, drawableID, candidateIDs) =>
      gpuIsTouchingDrawables(rd, drawableID, candidateIDs);
    renderer._twWasmIsTouchingColor = (rd, drawableID, color3b, mask3b) =>
      gpuIsTouchingColor(rd, drawableID, color3b, mask3b);
  } else {
    // 'wasm'
    renderer._twWasmIsTouchingDrawables = (rd, drawableID, candidateIDs) =>
      wasmIsTouchingDrawables(rd, drawableID, candidateIDs);
    renderer._twWasmIsTouchingColor = (rd, drawableID, color3b, mask3b) =>
      wasmIsTouchingColor(rd, drawableID, color3b, mask3b);
  }
  // Phase 3: the WebGPU instanced renderer is independent of the
  // collision-detection tier. When it is ready and the mode is not
  // legacy-only, attach the sprite-batch hook so `_drawThese` consults
  // the host pipeline for the `ShaderManager.DRAW_MODE.default` path.
  const drawBatchReady = isGpuBatchRendererReady();
  if (drawBatchReady && args.performanceMode !== 'legacy-only') {
    renderer._twWasmDrawSprites = (rd, drawables) => twWasmDrawSprites(rd, drawables);
  } else {
    renderer._twWasmDrawSprites = null;
  }
}

export interface ScaffoldingLike {
  renderer: unknown;
}

export function applyTurboWasmAcceleration(
  scaffolding: ScaffoldingLike | null | undefined,
  args: ApplyTurboWasmArgs,
): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithHooks | null | undefined;
  if (!renderer) return;
  patchRenderer(renderer, args);
}

export function removeTurboWasmAcceleration(scaffolding: ScaffoldingLike | null | undefined): void {
  if (!scaffolding) return;
  const renderer = scaffolding.renderer as RendererWithHooks | null | undefined;
  if (!renderer) return;
  renderer._twWasmIsTouchingDrawables = null;
  renderer._twWasmIsTouchingColor = null;
  renderer._twWasmDrawSprites = null;
}
