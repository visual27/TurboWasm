#!/usr/bin/env node
/**
 * Chrome DevTools MCP-based real-device benchmark for the user-facing
 * pixel-level expo calculation wrapped in a custom block
 * (`expo-custom-block-fixture.sb3`).
 *
 * What it measures
 * ----------------
 * For each mode (`enableWebgpu=true` vs `false`):
 *   1. Spawns `vite preview` on `TURBOWASM_PREVIEW_PORT` (default 4188).
 *   2. Drives Playwright Chromium with WebGPU launch flags.
 *   3. Loads the fixture via the file input.
 *   4. Resets the kernel dispatch accumulator and JS-side `performance.now()`
 *      baselines, then presses the green flag.
 *   5. Polls `window.__turbowasm.gpuKernelTiming` (live handle) and
 *      scratch-thread completion via the green-flag button's class
 *      change until either the scratch VM thread has stopped, the
 *      kernel has dispatched N times, or a timeout fires.
 *   6. Reports wall-time totals / per-frame averages / per-dispatch
 *      averages.
 *
 * The two runs are written to `./logs/expo-custom-block-measure-<mode>.json`
 * so a separate `node` post-processor can diff GPU vs JS performance.
 *
 * Usage
 * -----
 *   node scripts/measure-expo-custom-block.mjs
 *   # override:
 *   TURBOWASM_PREVIEW_PORT=4188 SCRATCH_FRAMES=500 node scripts/measure-expo-custom-block.mjs
 *
 * Why a custom benchmark instead of `verify-gpu-kernel.mjs`?
 * ------------------------------------------------------------
 * `verify-gpu-kernel.mjs` measures *visual* correctness (1e-6 ImageData
 * tolerance) and `bench-gpu-kernel-init.mjs` measures pre-parse wall-time.
 * Neither instrument the per-dispatch path that the user is asking
 * about. The `apply-gpu-kernels.ts` installer now records per-dispatch
 * timing into `window.__turbowasm.gpuKernelTiming`, which this script
 * reads via `chrome-devtools-mcp evaluate_script` (or `evaluate_script`
 * fallback).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { makeExpoCustomBlockFixture } from './make-expo-custom-block-fixture.mjs';
import { getWebgpuLaunchOptions } from './webgpu-flags.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const logsDir = resolve(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const PREVIEW_PORT = Number.parseInt(
  process.env.TURBOWASM_PREVIEW_PORT ?? '4188',
  10,
);
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}/`;
const SETTINGS_KEY = 'tw-viewer:settings:v1';
const FRAMES_TARGET = Number.parseInt(process.env.SCRATCH_FRAMES ?? '60', 10);
// StepCount stabilization: poll `runtime.stepCount()` every
// `STEPCOUNT_POLL_INTERVAL_MS` (=50 ms) and declare done when
// `STEPCOUNT_STABLE_SAMPLES` (=5) consecutive samples show Δ=0.
// The vendor's scratch-vm keeps an idle `event_whenflagclicked`
// thread alive in `runtime.threads` after the work finishes, so
// the old `runtime.threads.length === 0` end condition never
// fired and the harness always timed out at the old 60 s
// default. With the JS baseline completing in ~5 ms in pure
// TurboWarp (per the user's `C:\files\scratch\test\exposure.sb3`
// reference), 30 s is plenty of headroom.
const FRAME_TIMEOUT_MS = Number.parseInt(
  process.env.MEASURE_TIMEOUT_MS ?? '30000',
  10,
);
const STEPCOUNT_POLL_INTERVAL_MS = 50;
const STEPCOUNT_STABLE_SAMPLES = 5;
const STEPCOUNT_POLL_BUDGET_MS = 500;

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
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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

async function measureMode(browser, mode, fixturePath) {
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    consoleLines.push(`[pageerror] ${err?.stack ?? err}`);
  });

  // Mode-localStorage pre-seed. `enableWebgpu` is the GPU/JS switch;
  // `enableWasm` stays `true` so the JS baseline runs through the same
  // hook layer (the @compute hook returns demoted-true when
  // `enableWebgpu=false`, which is identical to JS execution without
  // WASM hooks installed).
  const enableWebgpu = mode === 'gpu';
  await context.addInitScript(
    ({ key, enableWebgpu }) => {
      const existingRaw = localStorage.getItem(key);
      let parsed;
      try {
        parsed = existingRaw ? JSON.parse(existingRaw) : { state: {}, version: 11 };
      } catch {
        parsed = { state: {}, version: 11 };
      }
      parsed.state.enableWasm = true;
      parsed.state.advanced = parsed.state.advanced || {};
      parsed.state.advanced.enableWebgpu = enableWebgpu;
      parsed.version = 11;
      localStorage.setItem(key, JSON.stringify(parsed));
    },
    { key: SETTINGS_KEY, enableWebgpu },
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
        if (!tw) return false;
        const drawables = tw.renderer?._allDrawables?.length ?? 0;
        return drawables >= 1;
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => null);
  await delay(800);

  // Wait for the kernel registry to settle (= bootstrap log fires).
  await page
    .waitForFunction(
      () => {
        const tw = window.__turbowasm;
        return Boolean(tw?.kernelRegistry);
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => null);
  await delay(200);

  // Reset the live kernel-timing accumulator and the JS wall-clock
  // baseline. Reading `gpuKernelTiming` here returns the live handle
  // (NOT a frozen snapshot), so subsequent `evaluate_script` polls
  // observe every dispatch the dispatcher records.
  await page.evaluate(() => {
    if (window.__turbowasm?.gpuKernelTiming?.reset) {
      window.__turbowasm.gpuKernelTiming.reset();
    }
    window.__twMeasureStart = performance.now();
  });

  // Click the green flag to start the scratch-thread loop.
  const flag = await page.$('[data-testid="green-flag"]');
  if (flag) await flag.click();
  const startedAt = Date.now();

  // StepCount stabilization end condition (§M7) — see the JSDoc on
  // STEPCOUNT_* constants above for why the old `runtime.threads`
  // check was broken. The completion signal is "the Scaffolding VM's
  // `_nonMonitorThreadCount` returns to 0 (= the sequencer has
  // filtered out every active script thread) AND stays at 0 for
  // STEPCOUNT_STABLE_SAMPLES (= 5 = 250 ms) consecutive polls". This
  // works in both modes:
  //   - JS baseline: every `repeat` runs on the scratch VM, so
  //     `_nonMonitorThreadCount` returns to 0 only after the inner
  //     pixel loop finishes.
  //   - GPU kernel: each dispatch hijacks the `repeat` via the M2
  //     hook, but the script thread still completes once the
  //     `repeat` block is done (= the kernel finished synchronously),
  //     so `_nonMonitorThreadCount` returns to 0 normally.
  // We deliberately do NOT use `runtime.stepCount` (= does not exist
  // in vendored scratch-vm) or `runtime.threads.length` (= idle
  // threads linger there post-completion).
  let lastNonMonitorThreadCount = -1;
  let stableStreak = 0;
  let completionReason = 'timeout';
  while (Date.now() - startedAt < FRAME_TIMEOUT_MS) {
    const snapshot = await page.evaluate(() => {
      const tw = window.__turbowasm;
      const timing = tw?.gpuKernelTiming ?? {
        count: 0,
        totalMs: 0,
        lastMs: 0,
        minMs: Number.POSITIVE_INFINITY,
        maxMs: 0,
      };
      const elapsedMs = performance.now() - (window.__twMeasureStart ?? performance.now());
      const vm = tw?.scaffolding?.vm;
      const nonMonitor =
        typeof vm?._nonMonitorThreadCount === 'number'
          ? vm._nonMonitorThreadCount
          : typeof vm?.runtime?.threads?.length === 'number'
            ? vm.runtime.threads.length
            : -1;
      return { timing, elapsedMs, nonMonitor };
    });
    if (snapshot.nonMonitor !== lastNonMonitorThreadCount) {
      lastNonMonitorThreadCount = snapshot.nonMonitor;
      stableStreak = 0;
    } else if (snapshot.nonMonitor >= 0) {
      stableStreak += 1;
      // First stable sample arrives STEPCOUNT_POLL_INTERVAL_MS after
      // the click; require STEPCOUNT_STABLE_SAMPLES (=5 = 250 ms) of
      // zero delta to declare done.
      if (stableStreak >= STEPCOUNT_STABLE_SAMPLES) {
        completionReason = 'non_monitor_threads_idle';
        break;
      }
    }
    // GPU-mode short-circuit: if the dispatcher has reached the
    // dispatch target AND stepCount has been stable for one full
    // poll cycle (= STEPCOUNT_POLL_BUDGET_MS / STEPCOUNT_POLL_INTERVAL_MS
    // ticks), end early so the harness doesn't sit idle while the
    // scratch VM keeps ticking its monitor update / `runtime.redraw()`
    // loop.
    if (
      mode === 'gpu' &&
      snapshot.timing.count >= FRAMES_TARGET &&
      stableStreak >= Math.ceil(STEPCOUNT_POLL_BUDGET_MS / STEPCOUNT_POLL_INTERVAL_MS)
    ) {
      completionReason = 'gpu_dispatch_target';
      break;
    }
    await delay(STEPCOUNT_POLL_INTERVAL_MS);
  }
  const finalSnapshot = await page.evaluate((finalNonMonitorArg) => {
    const tw = window.__turbowasm;
    const timing = tw?.gpuKernelTiming ?? {
      count: 0,
      totalMs: 0,
      lastMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
    };
    const elapsedMs = performance.now() - (window.__twMeasureStart ?? performance.now());
    return {
      timing,
      elapsedMs,
      finalNonMonitorThreadCount: finalNonMonitorArg,
      kernelRegistry: tw?.kernelRegistry ?? { size: 0, jsOnly: 0, canonicalKeys: [] },
      enableWasm: tw?.enableWasm ?? null,
      enableWebgpu: tw?.enableWebgpu ?? null,
    };
  }, lastNonMonitorThreadCount);

  writeFileSync(
    resolve(logsDir, `expo-custom-block-measure-${mode}.json`),
    JSON.stringify(
      {
        mode,
        framesTarget: FRAMES_TARGET,
        completionReason,
        ...finalSnapshot,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(logsDir, `expo-custom-block-console-${mode}.log`),
    consoleLines.join('\n'),
  );

  await context.close();
  return { completionReason, ...finalSnapshot };
}

async function main() {
  const fixturePath = await makeExpoCustomBlockFixture();

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    out(`[measure-expo-custom-block] playwright not installed: ${err?.message ?? err}`);
    process.exit(0);
  }

  const preview = spawnPreview();
  try {
    await waitForPreview(PREVIEW_URL);
    const browser = await chromium.launch(getWebgpuLaunchOptions());
    try {
      out(`[measure-expo-custom-block] fixture=${fixturePath}`);
      out(`[measure-expo-custom-block] frames target per mode: ${FRAMES_TARGET}`);
      out(`[measure-expo-custom-block] preview port: ${PREVIEW_PORT}`);
      out('');

      out('[measure-expo-custom-block] === JS baseline (enableWebgpu=false) ===');
      const jsResult = await measureMode(browser, 'js', fixturePath);
      out(
        `[measure-expo-custom-block] js: elapsedMs=${jsResult.elapsedMs.toFixed(2)} ` +
          `kernelDispatchCount=${jsResult.timing.count} ` +
          `kernelRegistry.size=${jsResult.kernelRegistry.size} ` +
          `finalNonMonitorThreadCount=${jsResult.finalNonMonitorThreadCount} ` +
          `completion=${jsResult.completionReason}`,
      );
      out('');

      out('[measure-expo-custom-block] === GPU kernel (enableWebgpu=true) ===');
      const gpuResult = await measureMode(browser, 'gpu', fixturePath);
      // No-WebGPU graceful skip. When the vendored VM's WebGPU
      // adapter is unavailable (SwiftShader / headless / older
      // Chromium), `[gpu-kernel] bootstrapped ... device=null` fires
      // and `kernelRegistry.size` stays 0. Recording this as a
      // documented skip rather than a CI failure matches the
      // behaviour of `verify-gpu-kernel.mjs` (§M7 — "the harness
      // should run on any machine").
      const gpuNoAdapter =
        gpuResult.enableWebgpu === true && gpuResult.kernelRegistry.size === 0;
      if (gpuNoAdapter) {
        out(
          '[measure-expo-custom-block] gpu: SKIP — no WebGPU adapter available ' +
            '(device=null). Pass WebGPU launch flags or run on a browser with ' +
            'real GPU access to enable kernel-dispatch measurement.',
        );
        gpuResult.timing.count = 0;
        gpuResult.timing.totalMs = 0;
      } else {
        out(
          `[measure-expo-custom-block] gpu: elapsedMs=${gpuResult.elapsedMs.toFixed(2)} ` +
            `kernelDispatchCount=${gpuResult.timing.count} ` +
            `kernelRegistry.size=${gpuResult.kernelRegistry.size} ` +
            `finalNonMonitorThreadCount=${gpuResult.finalNonMonitorThreadCount} ` +
            `completion=${gpuResult.completionReason}`,
        );
      }

      if (gpuResult.timing.count > 0) {
        out('');
        out('=== GPU kernel timing ===');
        out(`  dispatch count     : ${gpuResult.timing.count}`);
        out(`  total dispatch ms  : ${gpuResult.timing.totalMs.toFixed(2)}`);
        out(
          `  per-dispatch ms    : ${(gpuResult.timing.totalMs / gpuResult.timing.count).toFixed(3)}`,
        );
        out(`  min dispatch ms    : ${gpuResult.timing.minMs.toFixed(3)}`);
        out(`  max dispatch ms    : ${gpuResult.timing.maxMs.toFixed(3)}`);
      }
      // Speedup calculation: only meaningful when both modes have a
      // non-zero observation. GPU-dispatch totalMs / JS wallTimeMs is
      // the wall-time speedup (the JS baseline includes the per-tick
      // overhead of the scratch VM, so a smaller ratio = more
      // efficient per-AABB dispatch).
      const gpuTotalDispatchMs = gpuResult.timing.totalMs;
      if (jsResult.elapsedMs > 0 && gpuTotalDispatchMs > 0) {
        out('');
        out(
          `Wall-time speedup (js wallTimeMs vs gpu totalDispatchMs): ` +
            `${(jsResult.elapsedMs / gpuTotalDispatchMs).toFixed(2)}x`,
        );
      } else if (jsResult.elapsedMs > 0 && gpuNoAdapter) {
        out('');
        out(
          `JS wall-time: ${jsResult.elapsedMs.toFixed(2)} ms. GPU kernel dispatch could not be measured on this machine.`,
        );
      }
    } finally {
      await browser.close();
    }
  } finally {
    await killPreview(preview);
  }

  writeFileSync(resolve(logsDir, 'expo-custom-block-measure.out'), outLines.join('\n'), 'utf8');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[measure-expo-custom-block] FATAL:', err);
  writeFileSync(
    resolve(logsDir, 'expo-custom-block-measure.out'),
    outLines.join('\n') + '\n' + (err?.stack ?? err),
    'utf8',
  );
  process.exit(2);
});
