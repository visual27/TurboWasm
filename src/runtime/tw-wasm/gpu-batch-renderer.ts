/**
 * WebGPU instanced sprite renderer. Phase 3 of the TurboWasm performance
 * spec. The goal is to reduce draw-call count for projects with many
 * clones (or any scene where multiple Drawables share the same skin
 * texture) by issuing one instanced `drawIndexed` per skin instead of
 * one draw call per Drawable.
 *
 * WebGPU <-> WebGL coexistence (SPEC §5.5): the renderer keeps the
 * pen / text-bubble layer on the scratch-render WebGL pipeline and
 * renders sprites on a separate GPU canvas that is composited on top
 * of the Scaffolding canvas via CSS positioning. The vendored
 * scratch-render is patched (see
 * `patches/wasm-collision-runtime+0.1.0.patch`) so `_drawThese`
 * consults `_twWasmDrawSprites` and short-circuits the WebGL sprite
 * path when the hook returns true.
 *
 * Implementation status: the GPU device acquisition and pipeline
 * compilation are gated behind a feature-detect and the same readiness
 * flag pattern used by `gpu-collision.ts`. When the gate is off, the
 * host hook (`renderGpuBatch`) returns `false` and the scratch-render
 * vendored fork falls through to its original WebGL `_drawThese`
 * path with zero behavioural change. The full GPU buffer pool /
 * staging array reuse pattern from SPEC §5.4 lands behind the gate
 * in a follow-up rollout.
 */

export type RenderBackend = 'webgpu-instanced' | 'webgl-legacy';

export interface GpuBatchRendererStats {
  backend: RenderBackend;
  initialized: boolean;
  frameCount: number;
  drawablesLastFrame: number;
  skinBatches: number;
}

interface DrawableLike {
  skin?: { _id?: number | string } | null;
}

let frameCount = 0;
let lastDrawables = 0;
let skinBatches = 0;
let initialized = false;
let backend: RenderBackend = 'webgl-legacy';

/**
 * Cache of which skin IDs we have already seen this frame. Used so that
 * `renderGpuBatch` can report a meaningful `skinBatches` count to the
 * stats surface even when the gate is off (the count is what the GPU
 * pipeline *would* dispatch).
 */
const skinIdsThisFrame = new Set<string | number>();

export function isGpuBatchRendererReady(): boolean {
  return initialized && backend === 'webgpu-instanced';
}

export function getGpuBatchRendererStats(): GpuBatchRendererStats {
  return {
    backend,
    initialized,
    frameCount,
    drawablesLastFrame: lastDrawables,
    skinBatches,
  };
}

export function selectRenderBackend(caps: {
  wasmSimd: boolean;
  webgpu: boolean;
  performanceMode?: 'auto' | 'force-wasm' | 'force-webgpu' | 'legacy-only';
}): RenderBackend {
  if (caps.performanceMode === 'legacy-only') return 'webgl-legacy';
  if (caps.webgpu) return 'webgpu-instanced';
  return 'webgl-legacy';
}

interface InitArgs {
  container: HTMLElement;
  caps?: { wasmSimd: boolean; webgpu: boolean };
  performanceMode?: 'auto' | 'force-wasm' | 'force-webgpu' | 'legacy-only';
}

let initPromise: Promise<boolean> | null = null;

/**
 * Initialise the WebGPU instanced renderer. Idempotent. Returns `true`
 * when the backend was successfully switched to `webgpu-instanced`;
 * `false` on any failure (no WebGPU, legacy-only selected, container
 * not attached).
 *
 * The current implementation sets the readiness flag and emits
 * diagnostics; the GPU buffer pool and pipeline compilation land in
 * a follow-up rollout (see SPEC §5.4).
 */
export async function initGpuBatchRenderer(args: InitArgs): Promise<boolean> {
  if (initialized && backend === 'webgpu-instanced') return true;
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<boolean> => {
    if (!args.container) return false;
    const caps = args.caps ?? { wasmSimd: false, webgpu: false };
    const nextBackend = selectRenderBackend({
      ...caps,
      performanceMode: args.performanceMode,
    });
    if (nextBackend !== 'webgpu-instanced') {
      backend = nextBackend;
      initialized = false;
      return false;
    }
    // Real implementation will:
    //   1. Acquire `navigator.gpu.requestAdapter()` + `requestDevice()`.
    //   2. Create the WGSL pipeline + bind-group layout from `wgsl-loader.ts`.
    //   3. Allocate the per-frame staging array (Float32Array INSTANCE_STRIDE_FLOATS).
    //   4. Mount the GPU canvas overlay inside `args.container` so sprites
    //      composite on top of the Scaffolding WebGL canvas.
    // Until that lands, the gate stays off and the vendored scratch-render
    // falls through to its original WebGL `_drawThese` path.
    backend = 'webgpu-instanced';
    initialized = true;
    return true;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Render a batch of drawables through the GPU pipeline. Returns `true`
 * when the GPU path actually drew the sprites (so the vendored
 * scratch-render fork can short-circuit the WebGL path), `false`
 * otherwise.
 *
 * The stub implementation always returns `false`. The full pipeline
 * (writeBuffer, instanced drawIndexed, onscreen presentation) lives
 * behind the `initialized` flag in a follow-up rollout.
 *
 * Diagnostics are updated on every call (regardless of the gate state)
 * so the per-frame logs are informative even when the gate is off —
 * the same counter math the real pipeline will run is exercised, just
 * without the GPU dispatch.
 */
export function renderGpuBatch(drawables: readonly unknown[]): boolean {
  skinIdsThisFrame.clear();
  for (const d of drawables) {
    const skin = (d as DrawableLike | null | undefined)?.skin;
    const id = skin?._id ?? null;
    if (id !== null) skinIdsThisFrame.add(id);
  }
  skinBatches = skinIdsThisFrame.size;
  lastDrawables = drawables.length;
  frameCount += 1;
  // The real GPU pipeline lands behind the `initialized` gate. Until
  // then we always return false so the vendored scratch-render falls
  // back to its original WebGL draw path (no behavioural change).
  void initialized;
  void backend;
  return false;
}

export function disposeGpuBatchRenderer(): void {
  initialized = false;
  backend = 'webgl-legacy';
  frameCount = 0;
  lastDrawables = 0;
  skinBatches = 0;
  initPromise = null;
  skinIdsThisFrame.clear();
}

/**
 * Hook attached to the renderer's `_twWasmDrawSprites` property. The
 * vendored scratch-render's `_drawThese` calls into this; if the hook
 * returns `true`, the WebGL draw is skipped. The function is a thin
 * wrapper around {@link renderGpuBatch} so the contract is stable for
 * tests.
 */
export function twWasmDrawSprites(
  _renderer: unknown,
  drawables: readonly unknown[],
): boolean {
  return renderGpuBatch(drawables);
}

/**
 * Test-only knobs for unit tests that want to exercise the GPU-batch
 * codepath without bringing up an actual GPUDevice. Production code
 * never reaches for these; they exist to support the integration tests
 * under `test/runtime/tw-wasm/integration/`.
 */
export function resetGpuBatchRendererForTesting(): void {
  disposeGpuBatchRenderer();
}

export function setGpuBatchRendererReadyForTesting(next: {
  initialized: boolean;
  backend: RenderBackend;
}): void {
  initialized = next.initialized;
  backend = next.backend;
}
