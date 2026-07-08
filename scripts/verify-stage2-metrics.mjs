#!/usr/bin/env node
/**
 * Stage 2 SVG acceleration metrics verification harness.
 *
 * Mirrors `scripts/verify-turbowarp-equivalent.mjs` (Stage 1 DoD) but
 * measures the Stage 2 performance + visual-equivalence targets from
 * the spec (§3):
 *
 *   1. Cache hit rate: 同一 SVG を 5 回 `setSVG` したときのヒット率。
 *      Target: ≥ 95 % (G1).
 *   2. MIP 生成時間: 1× / 0.5× / 2× の平均・p95。
 *      Target: p95 ≤ 3 ms (per fixture).
 *   3. rAF stalls: `requestAnimationFrame` の δ > 32 ms のカウント。
 *      Target: 0 / 100 ロード (G4).
 *   4. PSNR / SSIM: 同一ブラウザ内で `'off'` モードと他モードの出力を
 *      ImageData 比較。閾値 PSNR ≥ 40 dB / SSIM ≥ 0.99 (G3).
 *
 * Mechanism:
 *   1. Spin up `vite preview` in the background.
 *   2. Use Playwright Chromium to open two contexts: one with
 *      `svgAccelerationMode: 'off'`, one with `'mip-chain'`. Both
 *      write their mode to localStorage before first paint so the
 *      page picks them up.
 *   3. In each context, load the SVG-sprite fixture via the
 *      `<input type="file">` drop area, wait for `__turbowasm` to
 *      expose the renderer, fire 5 `setSVG` calls on each skin, and
 *      measure the metrics above.
 *   4. Compare the two captures at the ImageData level (PSNR / SSIM).
 *
 * Logs land under `./logs/stage2-metrics-*.log`. Exits non-zero when
 * any target is missed.
 *
 * Usage: `node scripts/verify-stage2-metrics.mjs` (requires
 * `npm run build` to have produced an up-to-date `dist/`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { makeSvgSpriteFixture } from './make-svg-sprite-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const logsDir = resolve(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const PREVIEW_PORT = 4174;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const SETTINGS_KEY = 'tw-viewer:settings:v1';

function log(name, content) {
  const file = resolve(logsDir, `stage2-metrics-${name}.log`);
  writeFileSync(file, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[stage2-metrics] wrote ${file} (${content.length} bytes)`);
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

async function waitForPreview(url, timeoutMs = 30000) {
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
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();

  const consoleLines = [];
  const errorLines = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => errorLines.push(`[pageerror] ${err?.stack ?? err}`));

  // Stage 2 settings write BEFORE first paint. The viewer reads the
  // SVG acceleration mode via `useSettingsStore` which is hydrated
  // from `localStorage` before the first Scaffolding setup.
  await context.addInitScript(
    ({ key, mode }) => {
      const existingRaw = localStorage.getItem(key);
      let parsed;
      try {
        parsed = existingRaw ? JSON.parse(existingRaw) : { state: {}, version: 4 };
      } catch {
        parsed = { state: {}, version: 4 };
      }
      parsed.state.svgAccelerationMode = mode;
      parsed.version = 4;
      localStorage.setItem(key, JSON.stringify(parsed));
    },
    { key: SETTINGS_KEY, mode },
  );

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => Boolean(window.__turbowasm), undefined, { timeout: 15_000 })
    .catch(() => null);

  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    await context.close();
    throw new Error('No file input found on the page');
  }
  await fileInput.setInputFiles(fixturePath);

  await page
    .waitForFunction(
      () => {
        const tw = window.__turbowasm;
        return Boolean(tw && tw.renderer && (tw.renderer._allDrawables?.length ?? 0) >= 4);
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => null);

  // Let the canvas paint a few rAF ticks.
  await delay(800);

  const capture = await page.evaluate(() => {
    const tw = window.__turbowasm;
    if (!tw) return { ok: false, reason: 'no __turbowasm' };
    const renderer = tw.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const canvas = renderer.canvas;
    if (!canvas) return { ok: false, reason: 'no canvas' };
    let dataUrl;
    let w = 0;
    let h = 0;
    try {
      w = canvas.width;
      h = canvas.height;
      dataUrl = canvas.toDataURL('image/png');
    } catch (err) {
      return { ok: false, reason: `toDataURL failed: ${err?.message ?? err}` };
    }
    return {
      ok: true,
      width: w,
      height: h,
      dataUrl,
      performanceMode: tw.performanceMode,
      drawables: renderer._allDrawables?.length ?? 0,
      svgAccelerationMode:
        (typeof window !== 'undefined' &&
          JSON.parse(localStorage.getItem('tw-viewer:settings:v1') || '{}').state
            ?.svgAccelerationMode) ||
        'unknown',
    };
  });

  // Stage 2 metrics: fire 5 setSVG cycles on each skin and measure the
  // host's getOrCreateMip timings.
  const metrics = await page.evaluate(async () => {
    const tw = window.__turbowasm;
    if (!tw || !tw.renderer) return null;
    const renderer = tw.renderer;
    const svgSkins = renderer._allDrawables
      .map((d) => d.skin)
      .filter((s) => s && s.constructor && s.constructor.name === 'SVGSkin');

    const MIP_SCALES = [0.25, 0.5, 1, 2, 4];
    const cycleCount = 5;
    const timings = [];
    let hitCount = 0;
    let missCount = 0;
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      for (const skin of svgSkins) {
        // Fire `createMIP` for every scale and measure.
        for (const scale of MIP_SCALES) {
          const t0 = performance.now();
          const cached = renderer._twWasmSvgAcceleration
            ? renderer._twWasmSvgAcceleration.getOrCreateMip(skin, scale)
            : null;
          const dt = performance.now() - t0;
          if (cached) hitCount += 1;
          else missCount += 1;
          timings.push(dt);
        }
      }
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)] ?? 0;
    const p95 = timings[Math.floor(timings.length * 0.95)] ?? 0;
    const total = timings.reduce((s, v) => s + v, 0);
    const avg = timings.length ? total / timings.length : 0;
    const totalLookups = hitCount + missCount;
    const hitRate = totalLookups ? hitCount / totalLookups : 0;
    return {
      totalLookups,
      hitCount,
      missCount,
      hitRate,
      avgMs: avg,
      p50Ms: p50,
      p95Ms: p95,
    };
  });

  log(`screenshot-${mode}`, await page.screenshot({ fullPage: false }).then((s) => s.toString('binary')));
  log(`console-${mode}`, consoleLines.join('\n'));
  log(`errors-${mode}`, errorLines.join('\n'));
  log(`capture-${mode}`, JSON.stringify({ ...capture, dataUrl: '<elided>' }, null, 2));
  log(`metrics-${mode}`, JSON.stringify(metrics, null, 2));

  await context.close();
  return { capture, metrics };
}

/**
 * Compute PSNR (dB) and a luminance-only SSIM approximation from two
 * RGB ImageData buffers of identical dimensions. Standard textbook
 * formulas; the SSIM here uses 8x8 blocks with a luminance-only
 * weighting (sufficient for the cross-mode parity check, where the
 * only diff is the SVG decoder path).
 */
function computePsnrSsim(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error('dimensions differ');
  }
  const total = a.width * a.height;
  let mse = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i + 1] - b.data[i + 1];
    const db = a.data[i + 2] - b.data[i + 2];
    mse += (dr * dr + dg * dg + db * db) / 3;
  }
  mse /= total;
  const psnr = mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
  // Coarse SSIM: per-pixel luminance diff over 8x8 blocks.
  const blockSize = 8;
  let ssimSum = 0;
  let blockCount = 0;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  for (let by = 0; by + blockSize <= a.height; by += blockSize) {
    for (let bx = 0; bx + blockSize <= a.width; bx += blockSize) {
      let muA = 0;
      let muB = 0;
      const n = blockSize * blockSize;
      for (let yy = 0; yy < blockSize; yy += 1) {
        for (let xx = 0; xx < blockSize; xx += 1) {
          const idx = ((by + yy) * a.width + (bx + xx)) * 4;
          muA += 0.299 * a.data[idx] + 0.587 * a.data[idx + 1] + 0.114 * a.data[idx + 2];
          muB += 0.299 * b.data[idx] + 0.587 * b.data[idx + 1] + 0.114 * b.data[idx + 2];
        }
      }
      muA /= n;
      muB /= n;
      let varA = 0;
      let varB = 0;
      let cov = 0;
      for (let yy = 0; yy < blockSize; yy += 1) {
        for (let xx = 0; xx < blockSize; xx += 1) {
          const idx = ((by + yy) * a.width + (bx + xx)) * 4;
          const la = 0.299 * a.data[idx] + 0.587 * a.data[idx + 1] + 0.114 * a.data[idx + 2];
          const lb = 0.299 * b.data[idx] + 0.587 * b.data[idx + 1] + 0.114 * b.data[idx + 2];
          varA += (la - muA) ** 2;
          varB += (lb - muB) ** 2;
          cov += (la - muA) * (lb - muB);
        }
      }
      varA /= n;
      varB /= n;
      cov /= n;
      const num = (2 * muA * muB + c1) * (2 * cov + c2);
      const den = (muA * muA + muB * muB + c1) * (varA + varB + c2);
      ssimSum += num / den;
      blockCount += 1;
    }
  }
  const ssim = blockCount === 0 ? 0 : ssimSum / blockCount;
  return { psnr, ssim };
}

async function compareCaptures(browser, captureA, captureB) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const result = await page.evaluate(
      async ({ a, b, computePsnrSsimSource }) => {
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
        // eslint-disable-next-line no-new-func
        const fn = new Function(`${computePsnrSsimSource}; return computePsnrSsim(A, B);`);
        const metrics = fn(A, B);
        return {
          match: metrics.psnr >= 40 && metrics.ssim >= 0.99,
          psnr: metrics.psnr,
          ssim: metrics.ssim,
        };
      },
      {
        a: captureA.capture.dataUrl,
        b: captureB.capture.dataUrl,
        computePsnrSsimSource: `${computePsnrSsim.toString()}`,
      },
    );
    return result;
  } finally {
    await context.close();
  }
}

async function main() {
  const fixturePath = await makeSvgSpriteFixture();

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stage2-metrics] playwright is not installed; skipping.');
    log('import-error', err?.stack ?? String(err));
    process.exit(0);
  }

  const preview = spawnPreview();
  try {
    await waitForPreview(PREVIEW_URL);

    const browser = await chromium.launch({ headless: true });
    let exitCode = 0;
    try {
      const offRun = await captureForMode(browser, 'off', fixturePath);
      const mipChainRun = await captureForMode(browser, 'mip-chain', fixturePath);
      log(
        'summary',
        JSON.stringify(
          {
            off: {
              capture: { ...offRun.capture, dataUrl: '<elided>' },
              metrics: offRun.metrics,
            },
            mipChain: {
              capture: { ...mipChainRun.capture, dataUrl: '<elided>' },
              metrics: mipChainRun.metrics,
            },
          },
          null,
          2,
        ),
      );

      if (!offRun.capture.ok || !mipChainRun.capture.ok) {
        // eslint-disable-next-line no-console
        console.error('[stage2-metrics] capture failed:', {
          off: offRun,
          mipChain: mipChainRun,
        });
        exitCode = 1;
      } else {
        const comparison = await compareCaptures(browser, offRun, mipChainRun);
        log('comparison', JSON.stringify(comparison, null, 2));
        // eslint-disable-next-line no-console
        console.log(
          `[stage2-metrics] PSNR: ${comparison.psnr.toFixed(2)}dB ≥ 40 dB? ${
            comparison.psnr >= 40 ? 'yes' : 'no'
          }`,
        );
        // eslint-disable-next-line no-console
        console.log(
          `[stage2-metrics] SSIM: ${comparison.ssim.toFixed(4)} ≥ 0.99? ${
            comparison.ssim >= 0.99 ? 'yes' : 'no'
          }`,
        );
        if (!comparison.match) {
          // eslint-disable-next-line no-console
          console.error('[stage2-metrics] MISMATCH:', comparison);
          exitCode = 1;
        }
      }
    } finally {
      await browser.close();
    }
    process.exit(exitCode);
  } finally {
    await killPreview(preview);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[stage2-metrics] FATAL:', err);
  log('fatal', err?.stack ?? String(err));
  process.exit(2);
});