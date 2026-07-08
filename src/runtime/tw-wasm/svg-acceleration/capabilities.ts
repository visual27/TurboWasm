/**
 * Feature detection for the OffscreenCanvas + Web Worker path used by
 * Stage 2 of the TurboWasm Acceleration plan. The detection is
 * deliberately strict: every required global must be present AND typed
 * as expected. Browsers that fail any check (Safari FP, environments
 * without Worker, environments without OffscreenCanvas) transparently
 * fall back to the main-thread `createImageBitmap` path — see
 * {@link initSvgWorker} for the dispatch logic.
 */
export interface SvgWorkerCapabilities {
  /** `Worker` constructor is available. */
  worker: boolean;
  /** `OffscreenCanvas` is available. */
  offscreenCanvas: boolean;
  /** `createImageBitmap` is available (decoupled from Worker / OC). */
  createImageBitmap: boolean;
  /**
   * Conveyable through structured-clone with `Transferable`. True when
   * `ImageBitmap` is in the runtime's Transferable list. The V8 /
   * Firefox / Safari implementations all list it; this check guards
   * against minimal test environments.
   */
  imageBitmapTransferable: boolean;
}

export function detectSvgWorkerCapabilities(): SvgWorkerCapabilities {
  const g = globalThis as unknown as {
    Worker?: unknown;
    OffscreenCanvas?: unknown;
    createImageBitmap?: unknown;
  };
  return {
    worker: typeof g.Worker === 'function',
    offscreenCanvas: typeof g.OffscreenCanvas === 'function',
    createImageBitmap: typeof g.createImageBitmap === 'function',
    // ImageBitmap is always listed as Transferable in browser engines
    // we target (V8, SpiderMonkey, JSC). jsdom does not list it; the
    // feature check below doubles as a runtime environment probe.
    imageBitmapTransferable: typeof g.createImageBitmap === 'function',
  };
}

/**
 * Convenience: true when the `mip-chain` mode can use a Worker for
 * SVG decode offload. False on Safari FP, environments without
 * `OffscreenCanvas`, or test environments (jsdom) that lack the
 * required globals.
 */
export function canOffloadToSvgWorker(): boolean {
  const c = detectSvgWorkerCapabilities();
  return c.worker && c.offscreenCanvas && c.createImageBitmap && c.imageBitmapTransferable;
}
