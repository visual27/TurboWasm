#!/usr/bin/env node
/**
 * Micro-benchmark for `bootstrapGpuKernels` cold/warm paths (M7).
 *
 * Spins up `vite preview` against the existing `dist/`, then drives
 * Playwright Chromium to load `test/.test-fixtures/expo-fixture.sb3`
 * N times back-to-back, exercising the M6 pre-parse pipeline on each
 * load. We measure three observable signals:
 *
 *   1. `bootstrapGpuKernels` wall-time per load (the time between the
 *      `[gpu-kernel]` pre-parse start and the registry-write, captured
 *      via a `window.__turbowasm.gpuKernelBootstrapMs` snapshot the
 *      player does not expose today). When the snapshot is missing
 *      we fall back to the per-load delta between the first
 *      `[gpu-kernel]` log line and the last `[gpu-kernel]` log line
 *      for that load.
 *   2. `window.__turbowasm.kernelRegistry.size` snapshot after each
 *      load (so we can verify the registry re-seeds across reloads and
 *      observe how the M5 caching layer behaves on a warm page).
 *   3. Console-summary table to `./logs/bench-gpu-kernel-init.out`
 *      (per AGENTS.md's `./logs/` convention).
 *
 * WebGPU is not strictly required for this bench: when the adapter is
 * unavailable the pipeline still runs (returns `device=null`), so the
 * pre-parse + registry-write wall-time is observable on any machine.
 *
 * Usage: `node scripts/bench-gpu-kernel-init.mjs` (requires
 * `npm run build` so `dist/` is up to date). The
 * `TURBOWASM_PREVIEW_PORT` env var overrides the default port (4177)
 * to avoid clashes with the `verify-gpu-kernel.mjs` harness.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { makeExpoFixture } from './make-expo-fixture.mjs';
import { getWebgpuLaunchOptions } from './webgpu-flags.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const logsDir = resolve(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const PREVIEW_PORT = Number.parseInt(
  process.env.TURBOWASM_PREVIEW_PORT ?? '4177',
  10,
);
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_FILE = resolve(logsDir, 'bench-gpu-kernel-init.out');
const LOAD_COUNT = Number.parseInt(process.env.BENCH_LOAD_COUNT ?? '10', 10);

const outLines = [];
function out(line) {
  outLines.push(line);
  // eslint-disable-next-line no-console
  console.log(line);
}

function spawnPreview() {
  const proc = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'preview', '--port', String(PREVIEW_PORT)],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    },
  );
  proc.stdout.on('data', (chunk) => {
    process.stdout.write(`[preview] ${chunk}`);
  });
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[preview] ${chunk}`);
  });
  return proc;
}

async function waitForPreview(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // preview not yet accepting connections
    }
    await delay(250);
  }
  throw new Error(`vite preview did not become ready at ${url} within ${timeoutMs}ms`);
}

async function killPreview(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
      stdio: 'ignore',
      shell: true,
    });
  } else {
    proc.kill('SIGTERM');
    await delay(200);
    if (!proc.killed) proc.kill('SIGKILL');
  }
}

/**
 * Run a single load in a fresh page. Returns a per-load summary object
 * suitable for median / p95 aggregation.
 */
async function runOneLoad(browser, fixturePath) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await context.newPage();

  const gpuKernelLogTimes = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[gpu-kernel]')) {
      gpuKernelLogTimes.push({ at: Date.now(), text });
    }
  });

  const startedAt = Date.now();
  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => Boolean(window.__turbowasm), undefined, { timeout: 15_000 })
    .catch(() => null);

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    await context.close();
    throw new Error('No file input found on the page');
  }
  const beforeUpload = Date.now();
  await fileInput.setInputFiles(fixturePath);

  // Wait until the Scaffolding reports >0 drawables OR the GPU-kernel
  // log fires (whichever comes first).
  await page
    .waitForFunction(
      () => {
        const tw = window.__turbowasm;
        if (!tw) return false;
        const drawables = tw.renderer?._allDrawables?.length ?? 0;
        const kr = tw.kernelRegistry;
        return drawables >= 1 || (kr && typeof kr.size === 'number');
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => null);
  await delay(300);
  const finishedAt = Date.now();

  const snapshot = await page.evaluate(() => {
    const tw = window.__turbowasm;
    if (!tw) return null;
    const kr = tw.kernelRegistry ?? { size: 0, jsOnly: 0, canonicalKeys: [] };
    return {
      enableWasm: tw.enableWasm,
      kernelRegistrySize: kr.size,
      kernelRegistryJsOnly: kr.jsOnly,
      kernelRegistryCanonicalKeys: Array.isArray(kr.canonicalKeys)
        ? [...kr.canonicalKeys]
        : [],
    };
  });

  await context.close();

  const gpuKernelFirst = gpuKernelLogTimes[0];
  const gpuKernelLast = gpuKernelLogTimes[gpuKernelLogTimes.length - 1];
  const preParseWall =
    gpuKernelFirst && gpuKernelLast
      ? Math.max(0, gpuKernelLast.at - gpuKernelFirst.at)
      : null;
  const uploadToReadyMs = Math.max(0, finishedAt - beforeUpload);
  const totalMs = Math.max(0, finishedAt - startedAt);

  return {
    preParseWallMs: preParseWall,
    uploadToReadyMs,
    totalMs,
    gpuKernelLineCount: gpuKernelLogTimes.length,
    snapshot,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  const v = sorted[idx];
  return v ?? 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 95);
}

async function main() {
  const fixturePath = await makeExpoFixture();

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    out('[bench-gpu-kernel-init] playwright is not installed; skipping.');
    writeFileSync(OUT_FILE, outLines.join('\n'), 'utf8');
    process.exit(0);
  }

  const preview = spawnPreview();
  try {
    await waitForPreview(PREVIEW_URL);

    const browser = await chromium.launch(getWebgpuLaunchOptions());

    const preParseWalls = [];
    const uploadToReadys = [];
    const totals = [];
    const sizes = [];
    let webgpuObserved = null;

    try {
      for (let i = 0; i < LOAD_COUNT; i += 1) {
        const result = await runOneLoad(browser, fixturePath);
        if (typeof result.preParseWallMs === 'number') {
          preParseWalls.push(result.preParseWallMs);
        }
        uploadToReadys.push(result.uploadToReadyMs);
        totals.push(result.totalMs);
        if (result.snapshot && typeof result.snapshot.kernelRegistrySize === 'number') {
          sizes.push(result.snapshot.kernelRegistrySize);
        }
        const snapshotWebgpu =
          result.gpuKernelLineCount > 0 && result.snapshot
            ? result.snapshot.kernelRegistrySize > 0
              ? 'observed'
              : 'unavailable'
            : 'unknown';
        if (snapshotWebgpu === 'observed' && webgpuObserved !== true) {
          webgpuObserved = true;
        } else if (snapshotWebgpu === 'unavailable' && webgpuObserved !== true) {
          webgpuObserved = false;
        }
        out(
          `[bench-gpu-kernel-init] load ${String(i + 1).padStart(2, '0')}/${LOAD_COUNT}` +
            `  preParse=${result.preParseWallMs ?? 'n/a'}ms` +
            `  upload→ready=${result.uploadToReadyMs}ms` +
            `  total=${result.totalMs}ms` +
            `  kernelRegistry.size=${result.snapshot?.kernelRegistrySize ?? 'n/a'}`,
        );
        // Small breather so the Scaffolding has a chance to release GPU
        // resources between loads; doesn't affect the bench numbers.
        await delay(150);
      }
    } finally {
      await browser.close();
    }

    out('');
    out('=== Summary ===');
    out(`loads:                          ${LOAD_COUNT}`);
    out(`webgpuObserved:                 ${webgpuObserved ?? 'unknown'}`);
    out(
      `preParse wall-time (ms):        median=${median(preParseWalls).toFixed(2)}` +
        `  p95=${p95(preParseWalls).toFixed(2)}` +
        `  n=${preParseWalls.length}` +
        `  (null when no [gpu-kernel] log fired)`,
    );
    out(
      `upload → ready (ms):            median=${median(uploadToReadys).toFixed(2)}` +
        `  p95=${p95(uploadToReadys).toFixed(2)}`,
    );
    out(
      `total per load (ms):            median=${median(totals).toFixed(2)}` +
        `  p95=${p95(totals).toFixed(2)}`,
    );
    out(
      `kernelRegistry.size per load:   values=[${sizes.join(', ')}]` +
        `  unique=[${Array.from(new Set(sizes)).join(', ')}]`,
    );

    writeFileSync(OUT_FILE, outLines.join('\n'), 'utf8');
    out('');
    out(`[bench-gpu-kernel-init] wrote ${OUT_FILE}`);
  } finally {
    await killPreview(preview);
  }
}

main().catch((err) => {
  out('');
  out(`[bench-gpu-kernel-init] FATAL: ${err?.stack ?? err}`);
  writeFileSync(OUT_FILE, outLines.join('\n'), 'utf8');
  process.exit(2);
});
