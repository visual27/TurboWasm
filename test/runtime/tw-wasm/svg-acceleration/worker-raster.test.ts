import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSvgWorkerHost,
  initSvgWorker,
  resetSvgWorkerForTesting,
} from '@/runtime/tw-wasm/svg-acceleration/worker-raster';
import {
  canOffloadToSvgWorker,
  detectSvgWorkerCapabilities,
} from '@/runtime/tw-wasm/svg-acceleration/capabilities';

/**
 * Tests for the SVG decode Web Worker facade (Stage 2 of the
 * TurboWasm Acceleration plan). jsdom does not provide Worker or
 * OffscreenCanvas, so the production code path always returns the
 * no-op host. We assert the feature-detection probe + the no-op
 * host's behaviour; real-worker tests live behind `RUN_E2E=1` and
 * run in Playwright Chromium (see `test/e2e/stage2-metrics.test.ts`).
 */

describe('capabilities detection', () => {
  it('detectSvgWorkerCapabilities returns the expected boolean shape', () => {
    const c = detectSvgWorkerCapabilities();
    expect(typeof c.worker).toBe('boolean');
    expect(typeof c.offscreenCanvas).toBe('boolean');
    expect(typeof c.createImageBitmap).toBe('boolean');
    expect(typeof c.imageBitmapTransferable).toBe('boolean');
  });

  it('canOffloadToSvgWorker is false in jsdom (no Worker / OffscreenCanvas)', () => {
    // jsdom exposes neither Worker nor OffscreenCanvas, so the
    // canonical feature-detect must be false here.
    expect(canOffloadToSvgWorker()).toBe(false);
  });
});

describe('initSvgWorker (jsdom no-op path)', () => {
  beforeEach(async () => {
    await resetSvgWorkerForTesting();
  });

  afterEach(async () => {
    await resetSvgWorkerForTesting();
  });

  it('returns a host with workerActive=false in jsdom', async () => {
    const host = await initSvgWorker();
    expect(host.workerActive).toBe(false);
    expect(host.diagnostics.workerActive).toBe(false);
    expect(host.diagnostics.capabilities.worker).toBe(false);
  });

  it('request() resolves null in the no-op path (no worker is spawned)', async () => {
    const host = await initSvgWorker();
    const result = await host.request('<svg/>', 100, 100, 1);
    expect(result).toBeNull();
    expect(host.diagnostics.totalRequests).toBe(0);
  });

  it('request() with degenerate dimensions resolves null without consulting the worker', async () => {
    const host = await initSvgWorker();
    expect(await host.request('<svg/>', 0, 0, 1)).toBeNull();
    expect(await host.request('<svg/>', -1, 100, 1)).toBeNull();
  });

  it('getSvgWorkerHost returns the cached instance after init', async () => {
    const a = await initSvgWorker();
    const b = getSvgWorkerHost();
    expect(b).toBe(a);
  });

  it('resetSvgWorkerForTesting drops the host reference', async () => {
    const a = await initSvgWorker();
    expect(getSvgWorkerHost()).toBe(a);
    await resetSvgWorkerForTesting();
    expect(getSvgWorkerHost()).toBeNull();
  });

  it('dispose() drops the host reference and is idempotent', async () => {
    const host = await initSvgWorker();
    host.dispose();
    expect(getSvgWorkerHost()).toBeNull();
    // A second dispose is a no-op.
    host.dispose();
    expect(getSvgWorkerHost()).toBeNull();
  });

  it('a second initSvgWorker() returns the same no-op host', async () => {
    const a = await initSvgWorker();
    const b = await initSvgWorker();
    expect(b).toBe(a);
  });
});
