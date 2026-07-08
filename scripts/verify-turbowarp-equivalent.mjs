#!/usr/bin/env node
/**
 * Verify that the rendered sprite output is *bit-identical* between the
 * default PerformanceMode and `legacy-only`.
 *
 * After Stage 1 of the TurboWasm Acceleration plan, Phase 4 (resvg-wasm)
 * is removed. The remaining rendering path is identical to the upstream
 * TurboWarp Scaffolding `drawImage(this._svgImage, ...)` flow regardless
 * of which PerformanceMode is selected, so the canvas pixels produced by
 * the two modes must match exactly.
 *
 * Mechanism:
 *   1. Spin up `vite preview` in the background (Windows: `taskkill /f /t`
 *      on teardown).
 *   2. Use Playwright Chromium to open two browser contexts: one with
 *      default mode, one with `performanceMode: 'legacy-only'` written
 *      to `localStorage` before page load.
 *   3. In each context, navigate to the preview, load the SVG-sprite
 *      fixture via `#<project-id>` URL syntax, wait for `__turbowasm` to
 *      expose a renderer, and capture the rendered canvas pixels with
 *      `page.evaluate(() => canvas.toDataURL(...))` or
 *      `canvas.getContext('webgl').readPixels(...)`.
 *   4. Compare the two captures at the ImageData level. Any non-zero
 *      delta exits with code 1.
 *   5. Capture artefacts (screenshots, console logs) under `./logs/`.
 *
 * Usage: `node scripts/verify-turbowarp-equivalent.mjs` (requires
 * `npm run build` to have been run so `dist/` is up to date).
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

const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const SETTINGS_KEY = 'tw-viewer:settings:v1';

function log(name, content) {
  const file = resolve(logsDir, `turbowarp-equivalent-${name}.log`);
  writeFileSync(file, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[turbowarp-equivalent] wrote ${file} (${content.length} bytes)`);
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
    // Hard kill the tree; vite preview doesn't always honor SIGTERM on
    // Windows when launched via npx.
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

  // Stage 1 sets `performanceMode` via localStorage BEFORE first paint.
  await context.addInitScript(
    ({ key, mode }) => {
      const existingRaw = localStorage.getItem(key);
      let parsed;
      try {
        parsed = existingRaw ? JSON.parse(existingRaw) : { state: {}, version: 3 };
      } catch {
        parsed = { state: {}, version: 3 };
      }
      parsed.state.performanceMode = mode;
      parsed.version = 3;
      localStorage.setItem(key, JSON.stringify(parsed));
    },
    { key: SETTINGS_KEY, mode },
  );

  await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__turbowasm), undefined, { timeout: 15_000 }).catch(() => null);

  // Upload the fixture via the hidden file input. The Viewer has two
  // <input type="file"> elements (one in the DropScreen idle state and
  // one in the post-load UI); the first one is sufficient.
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    await context.close();
    throw new Error('No file input found on the page');
  }
  await fileInput.setInputFiles(fixturePath);

  // Wait until the renderer exposes >0 drawables (the stage is the 0th).
  // The fixture loads synchronously: 3 sprite drawables + 1 stage = 4.
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

  // Let a few rAF ticks elapse so the canvas actually paints.
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
      // Scratch renders to a WebGL-backed canvas; toDataURL goes through
      // the composited readback path.
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
    };
  });

  const shot = await page.screenshot({ fullPage: false });
  log(`screenshot-${mode}`, shot.toString('binary'));
  log(`console-${mode}`, consoleLines.join('\n'));
  log(`errors-${mode}`, errorLines.join('\n'));
  log(`capture-${mode}`, JSON.stringify({ ...capture, dataUrl: '<elided>' }, null, 2));

  await context.close();
  return capture;
}

/**
 * Reserved for future use if we want to do the comparison outside the
 * browser. Currently we delegate to `compareCaptures` which uses an
 * in-page ImageData pipeline.
 */
async function decodeDataUrlToRgba(dataUrl) {
  const bufferMatch = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!bufferMatch) throw new Error(`unexpected data url: ${dataUrl.slice(0, 40)}`);
  return Buffer.from(bufferMatch[1], 'base64');
}

async function compareCaptures(browser, captureA, captureB) {
  // Build a temporary HTML page that decodes both PNGs and produces a
  // pixel-by-pixel diff. This avoids needing pngjs as a runtime dep.
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
        let firstDiff = null;
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
          if (rA !== rB || gA !== gB || bA !== bB || aA !== aB) {
            diffCount += 1;
            if (!firstDiff) {
              firstDiff = {
                offset: i / 4,
                x: (i / 4) % A.width,
                y: Math.floor(i / 4 / A.width),
                a: [rA, gA, bA, aA],
                b: [rB, gB, bB, aB],
              };
            }
          }
        }
        return {
          match: diffCount === 0,
          diffCount,
          totalPixels: total,
          width: A.width,
          height: A.height,
          firstDiff,
        };
      },
      { a: captureA.dataUrl, b: captureB.dataUrl },
    );
    return result;
  } finally {
    await context.close();
  }
}

async function main() {
  // Make sure the fixture exists. Idempotent.
  const fixturePath = await makeSvgSpriteFixture();

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[turbowarp-equivalent] playwright is not installed; skipping.');
    log('import-error', err?.stack ?? String(err));
    process.exit(0);
  }

  const preview = spawnPreview();
  try {
    await waitForPreview(PREVIEW_URL);

    const browser = await chromium.launch({ headless: true });
    try {
      const captureDefault = await captureForMode(browser, 'auto', fixturePath);
      const captureLegacy = await captureForMode(browser, 'legacy-only', fixturePath);
      log(
        'summary',
        JSON.stringify(
          {
            default: { ...captureDefault, dataUrl: '<elided>' },
            legacy: { ...captureLegacy, dataUrl: '<elided>' },
          },
          null,
          2,
        ),
      );

      if (!captureDefault.ok || !captureLegacy.ok) {
        // eslint-disable-next-line no-console
        console.error('[turbowarp-equivalent] capture failed:', { captureDefault, captureLegacy });
        process.exit(1);
      }

      const comparison = await compareCaptures(browser, captureDefault, captureLegacy);
      log('comparison', JSON.stringify(comparison, null, 2));

      if (!comparison.match) {
        // eslint-disable-next-line no-console
        console.error('[turbowarp-equivalent] MISMATCH:', comparison);
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log('[turbowarp-equivalent] OK: default and legacy-only rendered bit-identically.');
    } finally {
      await browser.close();
    }
  } finally {
    await killPreview(preview);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[turbowarp-equivalent] FATAL:', err);
  log('fatal', err?.stack ?? String(err));
  process.exit(2);
});