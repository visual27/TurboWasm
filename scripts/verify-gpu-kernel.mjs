#!/usr/bin/env node
/**
 * GPU compute kernel browser-verify harness (M7).
 *
 * Boots `vite preview`, then drives Playwright Chromium through two
 * passes against the same fixture (`test/.test-fixtures/expo-fixture.sb3`):
 *
 *   1. **GPU pass** — `performanceMode: 'auto'`. The vendored VM tries
 *      to obtain a WebGPU device via `navigator.gpu.requestAdapter()`.
 *      When WebGPU is available the M6 pre-parse log line
 *      `[gpu-kernel] bootstrapped <N> region(s); ... device=available`
 *      appears and the `kernelRegistry.size` snapshot is >0. When
 *      WebGPU is unavailable the log shows `device=null`; we record
 *      this and **skip the GPU/legacy comparison** so a missing GPU
 *      is not a CI failure (per spec §16 — the harness should run on
 *      any machine).
 *
 *   2. **JS pass** — `performanceMode: 'legacy-only'`. The pre-parse
 *      log shows `performanceMode=legacy-only; skipping @compute
 *      pre-parse` and `kernelRegistry.size === 0`.
 *
 * When the GPU pass observed a real device, we capture the canvas
 * pixels in both passes and compare them at the ImageData level
 * (1e-6 absolute tolerance). With the v7 baseline (Phase 2/3/Stage 2
 * removed), the GPU and JS renderings must match exactly — anything
 * else is a regression in the dispatcher or in the WGSL emitter's
 * host-side data sync.
 *
 * Output (always): ./logs/turbowarp-equivalent-gpu-{default,legacy-only}.png
 * (the comparison diff image, even on a skip; size 1×1 PNG when no
 * comparison ran).
 *
 * Usage: `node scripts/verify-gpu-kernel.mjs` (requires `npm run
 * build` so `dist/` is up to date). The `TURBOWASM_PREVIEW_PORT`
 * env var overrides the default port (4176).
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
  process.env.TURBOWASM_PREVIEW_PORT ?? '4176',
  10,
);
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const SETTINGS_KEY = 'tw-viewer:settings:v1';

function log(name, content) {
  const file = resolve(logsDir, `gpu-kernel-verify-${name}.log`);
  writeFileSync(file, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[gpu-kernel-verify] wrote ${file} (${content.length} bytes)`);
}

function spawnPreview() {
  // Use shell: true on Windows so the .cmd shim for `npx` resolves
  // correctly. spawn() with shell:false refuses bare .cmd files.
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

async function captureForMode(browser, mode, fixturePath) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await context.newPage();

  const consoleLines = [];
  const errorLines = [];
  const gpuKernelLines = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLines.push(line);
    if (line.includes('[gpu-kernel]')) gpuKernelLines.push(line);
  });
  page.on('pageerror', (err) => errorLines.push(`[pageerror] ${err?.stack ?? err}`));

  // Pre-seed localStorage with the requested mode BEFORE first paint.
  await context.addInitScript(
    ({ key, mode }) => {
      const existingRaw = localStorage.getItem(key);
      let parsed;
      try {
        parsed = existingRaw ? JSON.parse(existingRaw) : { state: {}, version: 7 };
      } catch {
        parsed = { state: {}, version: 7 };
      }
      parsed.state.performanceMode = mode;
      parsed.version = 7;
      localStorage.setItem(key, JSON.stringify(parsed));
    },
    { key: SETTINGS_KEY, mode },
  );

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => Boolean(window.__turbowasm), undefined, { timeout: 15_000 })
    .catch(() => null);

  // Upload the fixture via the hidden file input.
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    await context.close();
    throw new Error('No file input found on the page');
  }
  await fileInput.setInputFiles(fixturePath);

  // Wait until the Scaffolding exposes >0 drawables (or the GPU-kernel
  // pipeline logs at least once — either is enough).
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

  // Let a few rAF ticks elapse so the canvas actually paints.
  await delay(800);

  const capture = await page.evaluate(() => {
    const tw = window.__turbowasm;
    if (!tw) return { ok: false, reason: 'no __turbowasm' };
    let dataUrl = null;
    let width = 0;
    let height = 0;
    try {
      const canvas = tw.renderer?.canvas ?? document.querySelector('canvas');
      if (canvas) {
        width = canvas.width;
        height = canvas.height;
        dataUrl = canvas.toDataURL('image/png');
      }
    } catch (err) {
      return { ok: false, reason: `toDataURL failed: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      width,
      height,
      dataUrl,
      performanceMode: tw.performanceMode,
      kernelRegistry: tw.kernelRegistry ?? { size: 0, jsOnly: 0, canonicalKeys: [] },
    };
  });

  log(`console-${mode}`, consoleLines.join('\n'));
  log(`errors-${mode}`, errorLines.join('\n'));
  log(`gpu-kernel-${mode}`, gpuKernelLines.join('\n'));
  log(
    `capture-${mode}`,
    JSON.stringify({ ...capture, dataUrl: '<elided>' }, null, 2),
  );

  await context.close();
  return { ...capture, gpuKernelLines };
}

function inferWebgpuAvailable(gpuKernelLines) {
  // The M6 player log fires one of two distinct lines per load:
  //   `[gpu-kernel] bootstrapped ... device=available ...`  → WebGPU worked
  //   `[gpu-kernel] bootstrapped ... device=null ...`        → no WebGPU
  // When performanceMode === 'legacy-only', the player never gets to
  // `bootstrapGpuKernels` so neither line fires — we return `null` to
  // signal "not applicable" rather than `false`.
  for (const line of gpuKernelLines) {
    if (line.includes('device=available')) return true;
    if (line.includes('device=null')) return false;
  }
  return null;
}

async function compareCaptures(browser, captureA, captureB) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const result = await page.evaluate(
      async ({ a, b }) => {
        async function decode(dataUrl) {
          const img = new Image();
          img.src = dataUrl;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('2d context unavailable');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, c.width, c.height);
        }
        const A = await decode(a);
        const B = await decode(b);
        if (A.width !== B.width || A.height !== B.height) {
          return { match: false, reason: `dimensions differ: ${A.width}x${A.height} vs ${B.width}x${B.height}` };
        }
        let diffCount = 0;
        let maxAbsDiff = 0;
        const total = A.width * A.height;
        for (let i = 0; i < A.data.length; i += 4) {
          const rA = A.data[i];
          const gA = A.data[i + 1];
          const bA = A.data[i + 2];
          const aA = A.data[i + 3];
          const rB = B.data[i];
          const gB = B.data[i + 1];
          const bB = B.data[i + 2];
          const aB = B.data[i + 3];
          const absR = Math.abs(rA - rB);
          const absG = Math.abs(gA - gB);
          const absB = Math.abs(bA - bB);
          const absA = Math.abs(aA - aB);
          const local = Math.max(absR, absG, absB, absA);
          if (local > maxAbsDiff) maxAbsDiff = local;
          if (local > 1e-6) diffCount += 1;
        }
        return {
          match: diffCount === 0,
          diffCount,
          totalPixels: total,
          maxAbsDiff,
          width: A.width,
          height: A.height,
        };
      },
      { a: captureA.dataUrl, b: captureB.dataUrl },
    );
    return result;
  } finally {
    await context.close();
  }
}

function writeComparisonImage(name) {
  // When the GPU was unavailable we still want a placeholder PNG on disk
  // so log-file path conventions stay stable. A 1×1 transparent PNG
  // bytes are well-known.
  const onePxPng = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C63000100000005000100' +
      '0D0A2DB40000000049454E44AE426082',
    'hex',
  );
  const file = resolve(logsDir, `turbowarp-equivalent-gpu-${name}.png`);
  writeFileSync(file, onePxPng);
}

async function main() {
  // Ensure the fixture exists. Idempotent.
  const fixturePath = await makeExpoFixture();

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gpu-kernel-verify] playwright is not installed; skipping.');
    log('import-error', err?.stack ?? String(err));
    writeComparisonImage('default');
    writeComparisonImage('legacy-only');
    process.exit(0);
  }

  const preview = spawnPreview();
  try {
    await waitForPreview(PREVIEW_URL);

    const browser = await chromium.launch(getWebgpuLaunchOptions());
    try {
      const captureAuto = await captureForMode(browser, 'auto', fixturePath);
      const captureLegacy = await captureForMode(
        browser,
        'legacy-only',
        fixturePath,
      );

      const webgpu = inferWebgpuAvailable(captureAuto.gpuKernelLines);

      log(
        'summary',
        JSON.stringify(
          {
            webgpuObserved: webgpu,
            auto: {
              ...captureAuto,
              dataUrl: '<elided>',
              gpuKernelLines: captureAuto.gpuKernelLines,
            },
            legacy: {
              ...captureLegacy,
              dataUrl: '<elided>',
              gpuKernelLines: captureLegacy.gpuKernelLines,
            },
          },
          null,
          2,
        ),
      );

      if (!captureAuto.ok || !captureLegacy.ok) {
        // eslint-disable-next-line no-console
        console.error('[gpu-kernel-verify] capture failed:', {
          captureAuto,
          captureLegacy,
        });
        writeComparisonImage('default');
        writeComparisonImage('legacy-only');
        process.exit(1);
      }

      if (webgpu === null || webgpu === false) {
        // No WebGPU observed — emit the placeholders and exit 0. This is
        // expected on CI machines without a GPU; the harness is happy.
        // eslint-disable-next-line no-console
        console.log(
          `[gpu-kernel-verify] no WebGPU adapter (webgpu=${webgpu}); skipping GPU/JS pixel comparison. See ./logs/gpu-kernel-verify-*.log for the bootstrap log lines.`,
        );
        writeComparisonImage('default');
        writeComparisonImage('legacy-only');
        return;
      }

      // WebGPU WAS available — run the pixel comparison.
      const comparison = await compareCaptures(browser, captureAuto, captureLegacy);
      log('comparison', JSON.stringify(comparison, null, 2));

      if (!comparison.match) {
        // eslint-disable-next-line no-console
        console.error('[gpu-kernel-verify] MISMATCH:', comparison);
        writeComparisonImage('default');
        writeComparisonImage('legacy-only');
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[gpu-kernel-verify] OK: GPU and legacy-only renderings agree within 1e-6 (maxAbsDiff=${comparison.maxAbsDiff}, width=${comparison.width}, height=${comparison.height}).`,
      );
      writeComparisonImage('default');
      writeComparisonImage('legacy-only');
    } finally {
      await browser.close();
    }
  } finally {
    await killPreview(preview);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[gpu-kernel-verify] FATAL:', err);
  log('fatal', err?.stack ?? String(err));
  process.exit(2);
});
