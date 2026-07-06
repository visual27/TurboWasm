import init, {
  batch_touching_drawables,
  SilhouetteBuffer,
  type InitOutput,
} from '../../../wasm-collision/pkg/tw_viewer_wasm_collision';

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
}

export interface SilhouetteLike {
  _colorData?: Uint8ClampedArray | null;
  _width?: number;
  _height?: number;
}

export interface SilhouetteSkin {
  _silhouette?: SilhouetteLike;
}

export interface CandidateTuple {
  drawable: DrawableLike;
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

const silhouetteCache = new WeakMap<object, SilhouetteBuffer>();

function getOrCreateSilhouette(silhouette: SilhouetteLike): SilhouetteBuffer | null {
  const w = silhouette._width ?? 0;
  const h = silhouette._height ?? 0;
  if (w <= 0 || h <= 0) return null;
  let buf = silhouetteCache.get(silhouette);
  if (buf && buf.width() === w && buf.height() === h) {
    return buf;
  }
  try {
    buf = new SilhouetteBuffer(w, h);
  } catch {
    return null;
  }
  silhouetteCache.set(silhouette, buf);
  return buf;
}

function syncSilhouette(
  buf: SilhouetteBuffer,
  silhouette: SilhouetteLike | null | undefined,
  w: number,
  h: number,
): void {
  const memory = wasmMemory;
  if (!memory) {
    buf.clear();
    return;
  }
  const ptr = buf.data_ptr();
  const dst = new Uint8Array(memory.buffer, ptr, w * h * 4);
  if (!silhouette) {
    dst.fill(0);
    return;
  }
  // Lazy silhouettes keep `_colorData = null` until the first `unlazy()`
  // call from the JS collision path. Without forcing it here, the very
  // first frame after a costume change sees an empty silhouette and
  // our WASM path reports a false negative for any touching block. The
  // JS baseline does this implicitly via `_isTouchingNearest` ->
  // `colorAtNearest`, so the WASM hook has to match.
  let colorData = silhouette._colorData;
  if (!colorData && typeof (silhouette as { unlazy?: () => void }).unlazy === 'function') {
    try {
      (silhouette as { unlazy: () => void }).unlazy();
    } catch {
      /* ignore — worst case we sync zeros */
    }
    colorData = silhouette._colorData;
  }
  if (!colorData || colorData.length < w * h * 4) {
    dst.fill(0);
    return;
  }
  dst.set(colorData.subarray(0, w * h * 4));
}

interface BuildArgs {
  bounds: BoundsLike;
  selfInv: Float32Array;
  selfBuf: SilhouetteBuffer;
  candInv: Float32Array;
  candOffsets: Uint32Array;
  candDims: Uint32Array;
  candCount: number;
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
    const buf = sil ? silhouetteCache.get(sil) : null;
    if (!buf || !sil) continue;
    const inv = ensure16(cand.drawable._inverseMatrix);
    if (inv) candInv.set(inv, i * 16);
    const ptr = buf.data_ptr();
    syncSilhouette(buf, sil, buf.width(), buf.height());
    candOffsets[i] = (ptr - base) >>> 0;
    candDims[i * 2] = buf.width();
    candDims[i * 2 + 1] = buf.height();
  }

  return {
    bounds,
    selfInv,
    selfBuf,
    candInv,
    candOffsets,
    candDims,
    candCount: candidates.length,
  };
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
  void renderer;
  void drawableID;
  void color3b;
  void mask3b;
  return null;
}

export function resetWasmCollisionForTesting(): void {
  readyPromise = null;
  wasmMemory = null;
  hasLoggedError = false;
}
