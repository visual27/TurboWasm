import init, {
  batch_touching_drawables,
  batch_touching_color,
  SilhouetteBuffer,
  type InitOutput,
} from '../../../wasm-collision/pkg/tw_viewer_wasm_collision';
import {
  anyDrawableHasShapeEffects,
  COLOR_EFFECT_MASK,
  SHAPE_EFFECT_MASK,
  type EffectsAware,
} from './effect-detection';

export type { SilhouetteBuffer };

interface InitResult {
  memory: WebAssembly.Memory;
}

let readyPromise: Promise<InitResult | null> | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let hasLoggedError = false;

export function isWasmCollisionReady(): boolean {
  return wasmMemory !== null;
}

export function initWasmCollision(): Promise<InitResult | null> {
  if (!readyPromise) {
    readyPromise = (async (): Promise<InitResult | null> => {
      try {
        const module = (await init()) as InitOutput;
        wasmMemory = module.memory;
        return { memory: module.memory };
      } catch (err) {
        readyPromise = null;
        if (!hasLoggedError) {
          hasLoggedError = true;
          // eslint-disable-next-line no-console
          console.warn('[turbowasm] wasm init failed; using JS fallback.', err);
        }
        return null;
      }
    })();
  }
  return readyPromise;
}

export interface DrawableLike {
  _inverseMatrix: Float32Array | number[] | unknown;
  skin?: SilhouetteSkin | null;
  _visible?: boolean;
  updateCPURenderAttributes?: () => void;
  /**
   * Bitmask of enabled Scratch visual effects. Mirrors scratch-render's
   * `Drawable.enabledEffects` (see `ShaderManager.EFFECT_INFO`). The
   * fallback layer in `effect-detection.ts` reads this to decide whether
   * the JS path must run instead of the WASM one for sprite effects
   * (mosaic / pixelate / whirl / fisheye) or color-affecting effects
   * (color / brightness).
   */
  enabledEffects?: number;
  useNearest?: (scale: number, drawable: unknown) => boolean;
}

export interface SilhouetteLike {
  _colorData?: Uint8ClampedArray | null;
  _width?: number;
  _height?: number;
}

export interface SilhouetteSkin {
  _silhouette?: SilhouetteLike;
}

/**
 * Rectangle intersection used by `_candidatesTouching`. Mirrors scratch-render's
 * `Rectangle.intersect` and is reused across calls — the host must read its
 * fields before any subsequent `_candidatesTouching` invocation that may clobber
 * the same instance.
 */
export interface RectangleLike {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * Shape returned by `RenderWebGL._candidatesTouching`.
 *
 * Implementation contract (verified against vendored scratch-render
 * `RenderWebGL.js:_candidatesTouching`, lines 1695-1734):
 *   - The renderer always returns a non-null array (empty when no overlap).
 *   - Each tuple has at least `drawable`; newer scratch-render versions
 *     also expose `id` and `intersection` (a Rectangle).
 *   - `intersection` is the static-buffer instance reused on subsequent
 *     calls, so it MUST be consumed (read fields) before the next
 *     `_candidatesTouching` invocation.
 */
export interface CandidateTuple {
  id?: number;
  drawable: DrawableLike;
  intersection?: RectangleLike;
}

export interface BoundsLike {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export interface RendererLike {
  _allDrawables?: DrawableLike[];
  _candidatesTouching?: (drawableID: number, candidateIDs: number[]) => CandidateTuple[];
  _candidatesBounds?: (candidates: CandidateTuple[]) => BoundsLike;
}

function ensure16(m: Float32Array | number[] | unknown): Float32Array | null {
  if (m instanceof Float32Array) return m.length >= 16 ? m.subarray(0, 16) : null;
  if (Array.isArray(m) && m.length >= 16) {
    const out = new Float32Array(16);
    for (let i = 0; i < 16; i += 1) {
      const v = m[i];
      out[i] = typeof v === 'number' ? v : 0;
    }
    return out;
  }
  return null;
}

/**
 * Cache key for the WASM-side silhouette buffer.
 *
 * `lastSeenColorData` is the previous `_colorData` reference. Scratch's
 * `Silhouette.update()` reassigns `_colorData` to a freshly-generated
 * `Uint8ClampedArray` whenever the silhouette is updated (costume change,
 * scale change, color effect change, etc.), so identity comparison against
 * the cached value tells us whether the silhouette content actually moved
 * since the last `syncSilhouette` call. Identity-stable lazy silhouettes
 * (those whose `_colorData` is a single `Uint8ClampedArray` shared across
 * frames via the lazy generator) skip the copy entirely.
 *
 * `lastSeenUnlazyCount` increments every time `unlazy()` was needed; this
 * is a defense-in-depth counter for engines that mutate `_colorData`
 * in-place rather than reassigning the reference.
 */
interface SilhouetteCacheEntry {
  buf: SilhouetteBuffer;
  lastSeenColorData: Uint8ClampedArray | null;
  lastSeenUnlazyCount: number;
  w: number;
  h: number;
}

let silhouetteCache: WeakMap<object, SilhouetteCacheEntry> = new WeakMap();

/**
 * `unlazy()` invocation counter keyed by silhouette instance. The hook
 * detection uses this to invalidate the silhouette cache whenever
 * `unlazy()` actually had to run — otherwise a costume whose lazy
 * generator mutates the buffer in-place would silently desync from
 * what we cached on an earlier frame.
 */
let unlazyCounts: WeakMap<object, number> = new WeakMap();

function currentUnlazyCount(silhouette: object): number {
  return unlazyCounts.get(silhouette) ?? 0;
}

function bumpUnlazyCount(silhouette: object): number {
  const next = (unlazyCounts.get(silhouette) ?? 0) + 1;
  unlazyCounts.set(silhouette, next);
  return next;
}

export function resetSilhouetteCacheForTesting(): void {
  // Drop entries by replacing the WeakMap reference. Tests that hold
  // their own silhouette mocks will be re-populated on the next
  // syncSilhouette call. We intentionally do not iterate (WeakMap does
  // not expose that); replacing the reference is sufficient and clears
  // the orphaned slots.
  silhouetteCache = new WeakMap();
  unlazyCounts = new WeakMap();
}

function getOrCreateSilhouette(silhouette: SilhouetteLike): SilhouetteBuffer | null {
  const w = silhouette._width ?? 0;
  const h = silhouette._height ?? 0;
  if (w <= 0 || h <= 0) return null;
  const cached = silhouetteCache.get(silhouette as object);
  if (cached && cached.w === w && cached.h === h) {
    return cached.buf;
  }
  let buf: SilhouetteBuffer;
  try {
    buf = new SilhouetteBuffer(w, h);
  } catch {
    return null;
  }
  silhouetteCache.set(silhouette as object, {
    buf,
    lastSeenColorData: null,
    lastSeenUnlazyCount: 0,
    w,
    h,
  });
  return buf;
}

function syncSilhouette(
  buf: SilhouetteBuffer,
  silhouette: SilhouetteLike | null | undefined,
  w: number,
  h: number,
): boolean {
  const memory = wasmMemory;
  if (!memory) {
    buf.clear();
    return false;
  }
  const ptr = buf.data_ptr();
  const dst = new Uint8Array(memory.buffer, ptr, w * h * 4);
  if (!silhouette) {
    dst.fill(0);
    return false;
  }
  // Lazy silhouettes keep `_colorData = null` until the first `unlazy()`
  // call from the JS collision path. Without forcing it here, the very
  // first frame after a costume change sees an empty silhouette and
  // our WASM path reports a false negative for any touching block. The
  // JS baseline does this implicitly via `_isTouchingNearest` ->
  // `colorAtNearest`, so the WASM hook has to match.
  let colorData = silhouette._colorData;
  let unlazyInvoked = 0;
  if (!colorData && typeof (silhouette as { unlazy?: () => void }).unlazy === 'function') {
    try {
      (silhouette as { unlazy: () => void }).unlazy();
      unlazyInvoked = 1;
      bumpUnlazyCount(silhouette as object);
    } catch {
      /* ignore — worst case we sync zeros */
    }
    colorData = silhouette._colorData;
  }

  const entry = silhouetteCache.get(silhouette as object);
  const prevUnlazyCount = entry ? entry.lastSeenUnlazyCount : currentUnlazyCount(silhouette as object);

  if (
    entry &&
    entry.buf === buf &&
    entry.w === w &&
    entry.h === h &&
    colorData !== null &&
    colorData !== undefined &&
    entry.lastSeenColorData === colorData &&
    unlazyInvoked === 0 &&
    prevUnlazyCount === (unlazyCounts.get(silhouette as object) ?? 0)
  ) {
    // Silhouette content is identical to what we already mirrored into
    // the WASM buffer (same `_colorData` reference, no `unlazy()` called
    // this call). Skip the copy entirely. This is the hot-path
    // optimisation: on a steady-state frame (no costume change, no effect
    // change) the per-frame silhouette sync drops to a single
    // identity compare.
    return true;
  }

  if (!colorData || colorData.length < w * h * 4) {
    dst.fill(0);
  } else {
    dst.set(colorData.subarray(0, w * h * 4));
  }

  if (entry) {
    entry.lastSeenColorData = colorData ?? null;
    entry.lastSeenUnlazyCount = unlazyCounts.get(silhouette as object) ?? 0;
  }
  return true;
}

interface BuildArgs {
  bounds: BoundsLike;
  selfInv: Float32Array;
  selfBuf: SilhouetteBuffer;
  candInv: Float32Array;
  candOffsets: Uint32Array;
  candDims: Uint32Array;
  candCount: number;
  /**
   * The filtered candidate list actually used for the WASM call. This is
   * exposed so callers (notably the effects JS-fallback guard) can
   * re-inspect the candidates without rebuilding them; the original
   * `_candidatesTouching` invocation may have been expensive.
   */
  candidates: CandidateTuple[];
  /**
   * Sampling strategy forwarded to the Rust side as `use_linear`:
   * `0` means nearest-neighbour (matches scratch-render's
   * `_isTouchingNearest`), `1` means bilinear 4-corner weighted
   * sampling (matches `_isTouchingLinear`). The TS side picks this
   * from `Drawable.skin.useNearest(scale, drawable)` (B1/B2).
   */
  useLinear: boolean;
}

/**
 * Decide whether the WASM hot-loop should use nearest or bilinear
 * sampling for the silhouette. Mirrors scratch-render's
 * `Drawable.updateCPURenderAttributes()` which switches between
 * `_isTouchingNearest` and `_isTouchingLinear` based on
 * `Drawable.skin.useNearest(scale, drawable)`.
 *
 *   - `useNearest(scale)` returns true  -> texture is integer-ratio
 *     scaled (no fractional UV); nearest sampling is sufficient.
 *   - `useNearest(scale)` returns false -> arbitrary scale; the JS path
 *     falls back to bilinear 4-texel weighted blending.
 *
 * The WASM `use_linear` flag is `0` for nearest and `1` for linear.
 */
function shouldUseLinearSampling(
  self: { skin?: SilhouetteSkin | null; useNearest?: (scale: number, drawable: unknown) => boolean },
  candidates: ReadonlyArray<{ drawable: { skin?: SilhouetteSkin | null; useNearest?: (scale: number, drawable: unknown) => boolean } }>,
  scale: number,
): boolean {
  if (self.skin && self.useNearest && !self.useNearest(scale, self)) return true;
  for (const cand of candidates) {
    const d = cand.drawable;
    if (d.skin && d.useNearest && !d.useNearest(scale, d)) return true;
  }
  return false;
}

function buildCallArgs(
  renderer: RendererLike,
  drawableID: number,
  candidateIDs: readonly number[],
): BuildArgs | null {
  const drawables = renderer._allDrawables;
  if (!drawables) return null;
  const self = drawables[drawableID];
  if (!self || !self.skin || !self.skin._silhouette) return null;
  const selfInv = ensure16(self._inverseMatrix);
  if (!selfInv) return null;
  const selfSil = self.skin._silhouette;
  const selfBuf = getOrCreateSilhouette(selfSil);
  if (!selfBuf) return null;
  syncSilhouette(selfBuf, selfSil, selfBuf.width(), selfBuf.height());

  const visibleCandidates = candidateIDs.filter(
    (id) => drawables[id]?._visible === undefined || Boolean(drawables[id]?._visible),
  );
  const candidates = typeof renderer._candidatesTouching === 'function'
    ? renderer._candidatesTouching(drawableID, visibleCandidates as number[])
    : visibleCandidates.map((id) => ({ drawable: drawables[id] as DrawableLike }));

  const bounds: BoundsLike = typeof renderer._candidatesBounds === 'function'
    ? renderer._candidatesBounds(candidates)
    : { left: 0, right: 0, bottom: 0, top: 0 };

  if (candidates.length === 0) {
    return {
      bounds,
      selfInv,
      selfBuf,
      candInv: new Float32Array(0),
      candOffsets: new Uint32Array(0),
      candDims: new Uint32Array(0),
      candCount: 0,
      candidates,
      useLinear: false,
    };
  }

  const candInv = new Float32Array(candidates.length * 16);
  const candOffsets = new Uint32Array(candidates.length);
  const candDims = new Uint32Array(candidates.length * 2);
  const memory = wasmMemory;
  if (!memory) return null;
  const buf = memory.buffer;
  const base: number = typeof buf === 'object' && buf && 'byteOffset' in buf && typeof (buf as { byteOffset?: unknown }).byteOffset === 'number' ? (buf as { byteOffset: number }).byteOffset : 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    if (!cand) continue;
    const sil = cand.drawable.skin?._silhouette;
    const entry = sil ? silhouetteCache.get(sil) : null;
    if (!entry || !sil) continue;
    const buf = entry.buf;
    const inv = ensure16(cand.drawable._inverseMatrix);
    if (inv) candInv.set(inv, i * 16);
    const ptr = buf.data_ptr();
    syncSilhouette(buf, sil, buf.width(), buf.height());
    candOffsets[i] = (ptr - base) >>> 0;
    candDims[i * 2] = buf.width();
    candDims[i * 2 + 1] = buf.height();
  }

  // B1/B2: pick nearest vs bilinear sampling. `use_linear = false` is
  // the fast path (default for integer-ratio scaled sprites); true only
  // when either self or any candidate reports `useNearest` as false.
  const useLinear = shouldUseLinearSampling(self, candidates as ReadonlyArray<{ drawable: DrawableLike }>, 1);

  return {
    bounds,
    selfInv,
    selfBuf,
    candInv,
    candOffsets,
    candDims,
    candCount: candidates.length,
    candidates,
    useLinear,
  };
}

/**
 * Decide whether the WASM touch-drawables path can be safely invoked
 * given the per-sprite visual effects of the self drawable + the
 * candidate set. Returns null to signal "fall back to the JS path",
 * mirroring the original scratch-render CPU loop semantics.
 *
 * The shape-effects check covers mosaic/pixelate/whirl/fisheye (all of
 * which `EffectTransform.transformPoint` warps onto the silhouette
 * boundary before sampling). When any sprite has one of those on, we
 * cannot reproduce the answer in the WASM inner loop — the per-pixel
 * UV would be wrong — so we hand off to the JS path to stay bit-exact.
 */
function effectsBlockTouchingDrawables(
  self: EffectsAware | undefined,
  candidates: ReadonlyArray<{ drawable: EffectsAware }>,
): boolean {
  if (self && anyDrawableHasShapeEffects([self])) return true;
  for (const c of candidates) {
    if (anyDrawableHasShapeEffects([c.drawable])) return true;
  }
  return false;
}

export function wasmIsTouchingDrawables(
  renderer: RendererLike,
  drawableID: number,
  candidateIDs: readonly number[],
): boolean | null {
  if (!wasmMemory) return null;
  try {
    renderer._allDrawables?.[drawableID]?.updateCPURenderAttributes?.();
  } catch {
    /* ignore */
  }
  const args = buildCallArgs(renderer, drawableID, candidateIDs);
  if (!args) return null;
  // Visual effect fallback: shape-changing effects (mosaic / pixelate /
  // whirl / fisheye) warp the silhouette UV in the JS path. The WASM
  // hot-loop only does affine/perspective mapping, so its output would
  // disagree with the JS path when these effects are on. Return null so
  // the patched `RenderWebGL.isTouchingDrawables` falls back to the
  // original brute-force CPU loop.
  if (
    effectsBlockTouchingDrawables(
      renderer._allDrawables?.[drawableID],
      args.candidates as ReadonlyArray<{ drawable: EffectsAware }>,
    )
  ) {
    return null;
  }
  if (args.candCount === 0) return false;
  try {
    const r = batch_touching_drawables(
      args.bounds.left,
      args.bounds.right,
      args.bounds.bottom,
      args.bounds.top,
      args.selfInv,
      args.selfBuf,
      args.candInv,
      args.candOffsets,
      args.candDims,
      args.candCount,
      args.useLinear ? 1 : 0,
    );
    return r === 1;
  } catch {
    return null;
  }
}

export function wasmIsTouchingColor(
  renderer: RendererLike,
  drawableID: number,
  color3b: number[] | Uint8Array | null,
  mask3b: number[] | Uint8Array | null | undefined,
): boolean | null {
  if (!wasmMemory) return null;
  // Defensive: when the JS side never provided a color we fall back to
  // the JS path. The Scaffolding layer forwards null/empty as 'no match
  // possible' — the JS path returns false in that case, but it's safer
  // to also short-circuit here so we never call into Rust with bad
  // arguments.
  if (!color3b || color3b.length < 3) return null;

  // F1 (initial implementation): wired through the new Rust
  // `batch_touching_color` entry point. Guard rails for visual effects
  // mirror the `wasmIsTouchingDrawables` case: shape-changing effects
  // (mosaic / pixelate / whirl / fisheye) warp the silhouette UV via
  // `EffectTransform.transformPoint`, and color/brightness effects
  // shift the sampled RGBA before our colour test would run — both
  // would diverge from the JS path. We return `null` to fall back.
  const drawables = renderer._allDrawables;
  if (!drawables) return null;
  const self = drawables[drawableID];
  if (!self) return null;

  const selfEffects = self.enabledEffects ?? 0;
  if ((selfEffects & SHAPE_EFFECT_MASK) !== 0) return null;
  if ((selfEffects & COLOR_EFFECT_MASK) !== 0) return null;

  // Refresh `updateCPURenderAttributes` to mirror what the JS
  // RenderWebGL path does just before the colour loop.
  try {
    self.updateCPURenderAttributes?.();
  } catch {
    /* ignore */
  }

  // Build the candidate set. We accept the renderer's view (filtered by
  // visibility) and re-run the same per-candidate effect guard as the
  // drawables path.
  const candidates = renderer._candidatesTouching
    ? renderer._candidatesTouching(drawableID, drawables.map((_, i) => i).filter((i) => i !== drawableID))
    : [];

  for (const cand of candidates) {
    const ce = cand.drawable.enabledEffects ?? 0;
    if ((ce & SHAPE_EFFECT_MASK) !== 0) return null;
    if ((ce & COLOR_EFFECT_MASK) !== 0) return null;
  }

  // Build the silhouette buffer pair (self + each candidate), reusing
  // the cache machinery from `buildCallArgs`. Reuse `buildCallArgs` and
  // adapt its outputs.
  const args = buildCallArgs(renderer, drawableID, candidates.map((c) => c.id ?? -1));
  if (!args) return null;

  // `mask3b` may be null/undefined/empty: pass -1 sentinel channels to
  // signal "no mask".
  let maskR = -1;
  let maskG = -1;
  let maskB = -1;
  if (mask3b && mask3b.length >= 3) {
    maskR = (mask3b[0] ?? -1) | 0;
    maskG = (mask3b[1] ?? -1) | 0;
    maskB = (mask3b[2] ?? -1) | 0;
  }

  try {
    const r = batch_touching_color(
      args.bounds.left,
      args.bounds.right,
      args.bounds.bottom,
      args.bounds.top,
      (color3b[0] ?? 0) & 0xff,
      (color3b[1] ?? 0) & 0xff,
      (color3b[2] ?? 0) & 0xff,
      maskR,
      maskG,
      maskB,
      args.selfInv,
      args.selfBuf,
      args.candInv,
      args.candOffsets,
      args.candDims,
      args.candCount,
      args.useLinear ? 1 : 0,
    );
    return r === 1;
  } catch {
    return null;
  }
}

export function resetWasmCollisionForTesting(): void {
  readyPromise = null;
  wasmMemory = null;
  hasLoggedError = false;
}
