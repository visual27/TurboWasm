/**
 * Web Worker that decodes an SVG into an `ImageBitmap` and posts the
 * bitmap back to the main thread. Used by Stage 2 of the TurboWasm
 * Acceleration plan to offload large SVG decode (G4 target: 0 rAF
 * stalls on a 512×512+ costume load).
 *
 * Vite bundles this file via `new Worker(new URL('./svg-worker.ts',
 * import.meta.url), { type: 'module' })`. The worker communicates with
 * the host through a tagged-union message protocol:
 *
 *   host → worker: `{ id, kind: 'decode', svgText, w, h, scale }`
 *   worker → host: `{ id, kind: 'ok', bitmap }`
 *   worker → host: `{ id, kind: 'err', message }`
 *
 * The worker creates an `OffscreenCanvas` per call (cheap, reused
 * internally) and uses `transferToImageBitmap()` to ship the result
 * back as a Transferable — the bitmap's pixel data is moved, not
 * copied, so the host receives a ready-to-use GPU texture with no
 * extra `createImageBitmap` round-trip.
 *
 * **Why a dedicated file?** Vite's worker bundler reads
 * `new URL('./svg-worker.ts', import.meta.url)` to detect the worker
 * entry. The file MUST be its own module (not re-exported from
 * another file) so the bundler can give it the `{ type: 'module' }`
 * treatment and emit a chunked worker bundle.
 */

interface DecodeRequest {
  id: number;
  kind: 'decode';
  svgText: string;
  w: number;
  h: number;
  scale: number;
}

interface DecodeOk {
  id: number;
  kind: 'ok';
  bitmap: ImageBitmap;
}

interface DecodeErr {
  id: number;
  kind: 'err';
  message: string;
}

type WorkerOutbound = DecodeOk | DecodeErr;

interface DedicatedWorkerGlobalScopeLike {
  addEventListener(
    type: 'message',
    listener: (ev: MessageEvent<DecodeRequest>) => void,
  ): void;
  postMessage(msg: WorkerOutbound, transfer?: Transferable[]): void;
}

const ctx = self as unknown as DedicatedWorkerGlobalScopeLike;

ctx.addEventListener('message', (ev: MessageEvent<DecodeRequest>) => {
  const msg = ev.data;
  if (!msg || msg.kind !== 'decode') return;
  const { id, svgText, w, h, scale } = msg;
  try {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const targetW = Math.max(1, Math.round(w * scale));
        const targetH = Math.max(1, Math.round(h * scale));
        const canvas = new OffscreenCanvas(targetW, targetH);
        const context = canvas.getContext('2d');
        if (!context) {
          URL.revokeObjectURL(url);
          postError(id, 'OffscreenCanvas 2d context unavailable');
          return;
        }
        context.drawImage(img, 0, 0, targetW, targetH);
        const bitmap = canvas.transferToImageBitmap();
        URL.revokeObjectURL(url);
        const ok: WorkerOutbound = { id, kind: 'ok', bitmap };
        ctx.postMessage(ok, [bitmap]);
      } catch (err) {
        URL.revokeObjectURL(url);
        postError(id, errorMessage(err));
      }
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      postError(id, `Image decode failed: ${errorMessage(err)}`);
    };
    img.src = url;
  } catch (err) {
    postError(id, errorMessage(err));
  }
});

function postError(id: number, message: string): void {
  const err: WorkerOutbound = { id, kind: 'err', message };
  ctx.postMessage(err);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}
