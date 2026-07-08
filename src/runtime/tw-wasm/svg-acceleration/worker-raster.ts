import { canOffloadToSvgWorker, detectSvgWorkerCapabilities } from './capabilities';

/**
 * Main-thread facade for the SVG decode Web Worker (Stage 2 of the
 * TurboWasm Acceleration plan). Spawns a module worker on first
 * request, dispatches decode messages, and tracks in-flight requests
 * by id so concurrent `getOrCreateMip` calls can co-exist.
 *
 * **Feature detection (Q3 in the spec)**: when `OffscreenCanvas`,
 * `Worker`, `createImageBitmap`, or `ImageBitmap` transferability is
 * not available — the canonical case is macOS Safari prior to FP
 * support — the facade returns `null` from every `request()` call.
 * The host (`mip-chain` / `applySvgAcceleration`) treats the null as
 * "fall back to main-thread `createImageBitmap`" so the user's
 * selected mode still works, just on the slower path. The
 * `workerActive` flag surfaces the actual mode in `!dump` for
 * diagnostic purposes.
 *
 * The worker is **spawned eagerly** by `initSvgWorker()` so the
 * ~100-200 ms cold-start cost is paid up front (typically during the
 * `settings: open` warmup path) rather than on the first costume
 * load, which would otherwise cause a visible stall. `disposeSvgWorker`
 * terminates the worker and resets state for tests.
 */

interface PendingRequest {
  resolve: (bitmap: ImageBitmap | null) => void;
  reject: (err: Error) => void;
}

interface WorkerModuleLike {
  default: new () => Worker;
}

interface SvgWorkerHost {
  /** True when the worker is alive and answering requests. */
  readonly workerActive: boolean;
  /** Diagnostic snapshot for `!dump`. */
  readonly diagnostics: SvgWorkerDiagnostics;
  /**
   * Dispatch a decode request to the worker. Returns `null` when:
   *   - the worker is not available (feature-detection failed)
   *   - the worker rejected the request (`err` message)
   *   - the input is degenerate (e.g. zero-size)
   * The caller (cache.populate) treats `null` as "factory failed" and
   * the cache stays empty; the SVGSkin patch's fallback then runs
   * the original `drawImage` path.
   */
  request: (svgText: string, w: number, h: number, scale: number) => Promise<ImageBitmap | null>;
  /** Terminate the worker and clear all pending requests. */
  dispose: () => void;
}

export interface SvgWorkerDiagnostics {
  capabilities: ReturnType<typeof detectSvgWorkerCapabilities>;
  workerActive: boolean;
  pendingRequests: number;
  totalRequests: number;
  totalFailures: number;
}

let host: SvgWorkerHost | null = null;

const SVG_WORKER_TIMEOUT_MS = 10_000;

export async function initSvgWorker(): Promise<SvgWorkerHost> {
  if (host) return host;
  if (!canOffloadToSvgWorker()) {
    host = createNoOpHost();
    return host;
  }
  try {
    const mod = (await import(
      /* @vite-ignore */ './svg-worker.ts?worker'
    )) as WorkerModuleLike;
    const WorkerCtor = mod.default;
    const worker = new WorkerCtor();
    const pending = new Map<number, PendingRequest>();
    let nextId = 0;
    let totalRequests = 0;
    let totalFailures = 0;

    const handleMessage = (ev: MessageEvent<{ id: number; kind: 'ok' | 'err'; bitmap?: ImageBitmap; message?: string }>) => {
      const msg = ev.data;
      if (!msg || typeof msg.id !== 'number') return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.kind === 'ok' && msg.bitmap) {
        entry.resolve(msg.bitmap);
      } else {
        totalFailures += 1;
        entry.resolve(null);
      }
    };

    worker.addEventListener('message', handleMessage as EventListener);
    worker.addEventListener('error', (ev: ErrorEvent) => {
      totalFailures += 1;
      // Reject every pending request — the worker is in an
      // unknown state and a future request would hang.
      for (const entry of pending.values()) {
        entry.resolve(null);
      }
      pending.clear();
      // eslint-disable-next-line no-console
      console.warn('[svg-worker] error event:', ev.message);
    });

    const request = (svgText: string, w: number, h: number, scale: number): Promise<ImageBitmap | null> => {
      if (w <= 0 || h <= 0) return Promise.resolve(null);
      totalRequests += 1;
      const id = nextId;
      nextId += 1;
      return new Promise<ImageBitmap | null>((resolve, reject) => {
        const entry: PendingRequest = { resolve, reject };
        pending.set(id, entry);
        // Defensive timeout: if the worker never responds (e.g. the
        // browser suspended it), we resolve null and let the caller
        // fall back to main-thread createImageBitmap.
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            totalFailures += 1;
            entry.resolve(null);
          }
        }, SVG_WORKER_TIMEOUT_MS);
        const wrappedResolve = (bm: ImageBitmap | null): void => {
          clearTimeout(timer);
          entry.resolve(bm);
        };
        const wrappedReject = (err: Error): void => {
          clearTimeout(timer);
          entry.reject(err);
        };
        pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });
        try {
          worker.postMessage({ id, kind: 'decode', svgText, w, h, scale });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          totalFailures += 1;
          entry.resolve(null);
        }
      });
    };

    const dispose = (): void => {
      try {
        worker.removeEventListener('message', handleMessage as EventListener);
        worker.terminate();
      } catch {
        /* ignore */
      }
      for (const entry of pending.values()) {
        entry.resolve(null);
      }
      pending.clear();
      host = null;
    };

    host = {
      workerActive: true,
      get diagnostics(): SvgWorkerDiagnostics {
        return {
          capabilities: detectSvgWorkerCapabilities(),
          workerActive: true,
          pendingRequests: pending.size,
          totalRequests,
          totalFailures,
        };
      },
      request,
      dispose,
    };
    return host;
  } catch {
    host = createNoOpHost();
    return host;
  }
}

function createNoOpHost(): SvgWorkerHost {
  return {
    workerActive: false,
    diagnostics: {
      capabilities: detectSvgWorkerCapabilities(),
      workerActive: false,
      pendingRequests: 0,
      totalRequests: 0,
      totalFailures: 0,
    },
    request: () => Promise.resolve(null),
    dispose: () => {
      host = null;
    },
  };
}

/**
 * Drop the cached worker host and terminate the worker. Production
 * code never calls this; tests use it to reset state between cases.
 */
export async function resetSvgWorkerForTesting(): Promise<void> {
  if (host) {
    host.dispose();
    host = null;
  }
}

/**
 * Synchronous accessor for the current host. Returns `null` when no
 * host has been initialised yet (i.e. `initSvgWorker()` has not
 * resolved) or when the feature detection failed. The host's
 * `request()` method is the only safe async surface; the host's
 * `workerActive` flag is the safe sync surface.
 */
export function getSvgWorkerHost(): SvgWorkerHost | null {
  return host;
}
