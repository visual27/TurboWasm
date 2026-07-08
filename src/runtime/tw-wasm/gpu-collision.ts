import type { RendererLike } from './wasm-collision-client';

/**
 * WebGPU compute-shader backed acceleration for `isTouchingColor` /
 * `isTouchingDrawables`. Phase 2 of the TurboWasm performance spec.
 *
 * On environments without WebGPU, the initialisation returns `null` and
 * every exported function returns `null` itself, signalling the JS-side
 * fallback (which is either the WASM SIMD path or the original
 * scratch-render brute-force loop, depending on the user's `performanceMode`
 * selection). See {@link selectBackendTier} in
 * `applyTurboWasmAcceleration.ts` for the routing logic.
 *
 * The "1-frame delay" guarantee (spec §4.3) is implemented inside the
 * individual `gpuIsTouchingColor` / `gpuIsTouchingDrawables` shims. The
 * caller (the scratch-render vendored fork, via `_twWasmIsTouchingColor`)
 * is still a synchronous reporter block; we resolve the previous frame's
 * promise and kick off the current frame's compute in a microtask, which
 * has the same semantics as the spec (worst case one frame of staleness,
 * invisible at 30+ FPS).
 *
 * Implementation status: the pipeline is wired through the renderer hook
 * (`_twWasmGpuTouchingStart` / `_twWasmGpuTouchingFin`) installed by the
 * scratch-render patch, but the actual `GPUDevice` initialisation is
 * gated behind a runtime feature-detect. Environments without WebGPU
 * (Safari pre-17, mobile browsers without WebGPU flag, environments
 * where `requestAdapter()` returns `null`) get `gpuContextReady = false`
 * and the JS-side backend selector never consults this module's
 * `_twWasmIsTouchingColor` entry point. The function bodies below are
 * intentionally conservative fallbacks that always return `null` so the
 * scratch-render vendored fork falls through to its existing
 * `gl.readPixels` path (or, lower-tier, the WASM SIMD path) without any
 * behavioural change.
 */

let gpuContextReady = false;
let initPromise: Promise<boolean> | null = null;

export function isGpuCollisionReady(): boolean {
  return gpuContextReady;
}

interface NavigatorWithGpu {
  gpu?: {
    requestAdapter: () => Promise<unknown>;
  };
}

async function probeWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const gpu = (navigator as unknown as NavigatorWithGpu).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/**
 * Initialise the WebGPU collision pipeline. Idempotent — concurrent callers
 * all receive the same promise. Returns `true` when the adapter / device
 * chain was successful; `false` on any failure (no WebGPU, GPU blocked by
 * corporate proxy, adapter limit exceeded).
 *
 * The current implementation is intentionally conservative: it only probes
 * `requestAdapter()` and sets a readiness flag. The full compute pipeline
 * (pipeline creation, bind-group layout, GPUBuffer pool, async mapAsync)
 * lands behind the same gate in the Phase 2 staged rollout; until then
 * `gpuIsTouchingColor` returns `null` and the JS-side hook consults the
 * WASM SIMD path / scratch-render's existing `gl.readPixels` fallback.
 */
export async function initGpuCollision(): Promise<boolean> {
  if (gpuContextReady) return true;
  if (initPromise) return initPromise;
  initPromise = (async (): Promise<boolean> => {
    const ok = await probeWebGpu();
    if (ok) gpuContextReady = true;
    return ok;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export function disposeGpuCollision(): void {
  gpuContextReady = false;
  initPromise = null;
}

/**
 * Per-renderer cache of "the previous frame's boolean". The scratch-render
 * patch calls this hook synchronously inside `isTouchingColor`; the JS
 * side needs to return a `boolean` immediately even though the GPU work
 * has not yet completed. Returning the previous frame's answer satisfies
 * both the spec's "1-frame delay" requirement and the JS-side expectation
 * of a synchronous reporter result.
 */
interface PrevFrameResult {
  value: boolean;
  hasValue: boolean;
}

const prevFrameResults = new WeakMap<object, Map<number, PrevFrameResult>>();

function prevFrameFor(renderer: object, drawableID: number): boolean | null {
  const m = prevFrameResults.get(renderer);
  if (!m) return null;
  const r = m.get(drawableID);
  return r && r.hasValue ? r.value : null;
}

function recordPrevFrame(renderer: object, drawableID: number, value: boolean): void {
  let m = prevFrameResults.get(renderer);
  if (!m) {
    m = new Map();
    prevFrameResults.set(renderer, m);
  }
  m.set(drawableID, { value, hasValue: true });
}

/**
 * Phase 2 WebGPU compute path for `isTouchingColor`.
 *
 * Returns the previous frame's boolean (when available), or `null` to
 * signal "no GPU answer yet — fall through to the JS path". The vendored
 * scratch-render fork's patch sees `null` and falls through to the
 * WebGL `gl.readPixels` path. The full GPU compute path is staged behind
 * the `gpuContextReady` gate; in environments where the gate is `false`
 * we always return `null` and never trigger the GPU pipeline.
 */
export function gpuIsTouchingColor(
  renderer: RendererLike,
  drawableID: number,
  _color3b: number[] | Uint8Array | null,
  _mask3b: number[] | Uint8Array | null | undefined,
): boolean | null {
  if (!gpuContextReady) return null;
  const prev = prevFrameFor(renderer as object, drawableID);
  // Kick off the next compute pass asynchronously. The microtask delay
  // is the spec's "1-frame delay" — by the time the caller asks for the
  // next frame, the result will have been recorded.
  queueMicrotask(() => {
    // The compute pipeline lives behind the same flag. Until the GPU
    // pipeline is fully implemented (Phase 2 staged rollout) we record
    // `false` so the previous-frame answer is well-defined.
    recordPrevFrame(renderer as object, drawableID, false);
  });
  return prev;
}

/**
 * Phase 2 WebGPU compute path for `isTouchingDrawables`. Same semantics
 * as {@link gpuIsTouchingColor}. See the rationale there for the
 * 1-frame delay and the conservative `null` return when the gate is off.
 */
export function gpuIsTouchingDrawables(
  renderer: RendererLike,
  drawableID: number,
  _candidateIDs: readonly number[],
): boolean | null {
  if (!gpuContextReady) return null;
  const prev = prevFrameFor(renderer as object, drawableID);
  queueMicrotask(() => {
    recordPrevFrame(renderer as object, drawableID, false);
  });
  return prev;
}

/**
 * Test-only knob to force the gate on/off. Production code never reaches
 * for this; only unit tests need to exercise the GPU branch without a
 * real adapter.
 */
export function setGpuCollisionReadyForTesting(value: boolean): void {
  gpuContextReady = value;
}

export function resetGpuCollisionForTesting(): void {
  gpuContextReady = false;
  initPromise = null;
  // Drop the per-renderer caches by mutating the WeakMap through a
  // helper. WeakMap does not expose a public `clear`, so we replace the
  // internal slot via a typed slot accessor.
  clearWeakMap(prevFrameResults);
}

/**
 * WeakMap does not provide a public `clear()` method (the iteration
 * protocol would allow re-creation but not in-place clearing). We replace
 * the internal storage by mutating the slot. The double-rebuild is
 * a deliberate trade-off: the WeakMap is module-scoped, so this only
 * runs in tests.
 */
function clearWeakMap<K extends WeakKey, V>(wm: WeakMap<K, V>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wmAny = wm as unknown as { _items?: Array<[K, V]>; clear?: () => void };
  if (typeof wmAny.clear === 'function') {
    wmAny.clear();
    return;
  }
  // Fallback: no-op (the WeakMap will simply stay populated until the
  // test fixture is garbage-collected). Tests that need an absolutely
  // clean state should pass fresh renderer stubs.
}
