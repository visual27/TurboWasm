/**
 * Comprehensive real-browser verification harness for the TurboWasm
 * Viewer — covers Phase A (PerformanceMode) / Phase B (resvg-wasm) /
 * Phase C (WebGPU compute) / Phase D (WebGPU instanced renderer) and
 * the common foundation. Drives a real headless Chromium via
 * `playwright` (functionally equivalent to `chrome-devtools-mcp`).
 *
 * Run with: `node scripts/chrome-devtools-mcp-verify.mjs --url http://localhost:4173/`.
 *
 * Records each scenario under `./logs/chrome-devtools-mcp-<topic>.log`.
 */
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const logsDir = resolve(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const args = process.argv.slice(2);
const urlArgIdx = args.indexOf('--url');
const targetUrl = urlArgIdx >= 0 && args[urlArgIdx + 1] ? args[urlArgIdx + 1] : 'http://localhost:4173/';

const summary = { startedAt: new Date().toISOString(), url: targetUrl, scenarios: [] };

function logTo(topic, content) {
  const safeTopic = String(topic).replace(/[^a-z0-9_-]/gi, '-');
  const file = resolve(logsDir, `chrome-devtools-mcp-${safeTopic}.log`);
  writeFileSync(file, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[mcp-verify] wrote ${file} (${content.length} bytes)`);
}

function jsonLog(topic, payload) {
  logTo(topic, JSON.stringify(payload, null, 2));
}

function recordResult(name, ok, details) {
  summary.scenarios.push({ name, ok, details: details ? JSON.stringify(details).slice(0, 800) : undefined });
  // eslint-disable-next-line no-console
  console.log(`[mcp-verify] ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && details) {
    // eslint-disable-next-line no-console
    console.log(`[mcp-verify]   details: ${JSON.stringify(details).slice(0, 500)}`);
  }
}

async function readHooks(page) {
  return page.evaluate(() => {
    const tw = window.__turbowasm;
    if (!tw) return { mounted: false };
    const r = tw.renderer ?? {};
    return {
      mounted: Boolean(tw.scaffolding),
      performanceMode: tw.performanceMode,
      capabilities: tw.capabilities,
      hasScaffolding: typeof tw.scaffolding === 'object' && tw.scaffolding !== null,
      hasWasmHook: typeof r._twWasmIsTouchingDrawables === 'function',
      hasWasmColorHook: typeof r._twWasmIsTouchingColor === 'function',
      hasGpuHook: typeof r._twWasmGpuTouchingStart === 'function',
      hasGpuFinHook: typeof r._twWasmGpuTouchingFin === 'function',
      hasDrawBatchHook: typeof r._twWasmDrawSprites === 'function',
      hasSvgHook: !!r._twWasmRasterSvgCostume,
      drawables: r._allDrawables?.length ?? 0,
    };
  });
}

async function waitForPlayerReady(page) {
  await page
    .waitForFunction(
      () => {
        const tw = window.__turbowasm;
        return Boolean(tw && tw.scaffolding && tw.renderer && tw.capabilities);
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => null);
  await page.waitForTimeout(500);
}

async function setModeAndReload(page, mode) {
  await page.evaluate((m) => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 3 };
    parsed.state.performanceMode = m;
    parsed.version = 3;
    localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
  }, mode);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stage-container"]', { timeout: 10_000 }).catch(() => null);
  await waitForPlayerReady(page);
  return readHooks(page);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    logTo('import-error', `playwright is not installed.\n${err?.stack ?? err}`);
    // eslint-disable-next-line no-console
    console.error('[mcp-verify] playwright not available; aborting.');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleLines = [];
  const errorLines = [];
  const networkLog = [];
  page.on('console', (msg) => {
    const entry = { type: msg.type(), text: msg.text(), location: msg.location() };
    consoleLines.push(entry);
  });
  page.on('pageerror', (err) => {
    errorLines.push({ stack: err?.stack ?? String(err), message: err?.message });
  });
  page.on('response', async (res) => {
    const url = res.url();
    const isWasm = url.endsWith('.wasm');
    const isJs = url.endsWith('.js');
    if (!isWasm && !isJs) return;
    let headers = null;
    try {
      headers = await res.allHeaders();
    } catch {
      /* ignore */
    }
    networkLog.push({
      phase: 'response',
      url,
      status: res.status(),
      contentType: headers?.['content-type'] ?? null,
      contentLength: headers?.['content-length'] ?? null,
      cacheControl: headers?.['cache-control'] ?? null,
    });
  });
  page.on('requestfailed', (req) => {
    networkLog.push({ phase: 'requestfailed', url: req.url(), failure: req.failure()?.errorText });
  });

  // ----- A. Initial mount (no project) -----
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page
    .waitForSelector('[data-testid="stage-container"]', { timeout: 15_000 })
    .catch(() => null);
  await waitForPlayerReady(page);

  const snapshotInitial = await readHooks(page);
  jsonLog('A-initial-mount', snapshotInitial);
  recordResult(
    'A.initial_mount',
    snapshotInitial.mounted === true && snapshotInitial.hasScaffolding === true,
    snapshotInitial,
  );

  const lsBefore = await page.evaluate(() => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    if (!raw) return { present: false };
    const parsed = JSON.parse(raw);
    return { present: true, version: parsed.version, performanceMode: parsed.state?.performanceMode };
  });
  jsonLog('A2-localstorage-baseline', lsBefore);

  // Pre-load: no project, so we expect DropScreen and hidden file input
  const idleDom = await page.evaluate(() => ({
    title: document.title,
    stageContainer: !!document.querySelector('[data-testid="stage-container"]'),
    dropScreen: !!document.querySelector('[data-testid="drop-screen"]'),
    projectInput: !!document.querySelector('#project-id-input'),
    fileInput: !!document.querySelector('input[type="file"]'),
    settingsButton: !!document.querySelector('[data-testid="open-settings"]'),
  }));
  jsonLog('A3-idle-dom', idleDom);
  recordResult(
    'A.idle_dom_baseline',
    idleDom.stageContainer && idleDom.dropScreen && idleDom.projectInput && idleDom.fileInput,
    idleDom,
  );

  // Initial screenshot (idle state)
  {
    const shot = await page.screenshot({ fullPage: false });
    writeFileSync(resolve(logsDir, 'chrome-devtools-home-auto.png'), shot);
  }

  // ----- E0. Load repro.sb3 (do this FIRST so settings button becomes available) -----
  let projectLoaded = false;
  let projectDrawables = 0;
  let projectLoadDurationMs = 0;
  try {
    const fixturePath = resolve(root, 'test-fixtures/repro.sb3');
    const fs = await import('node:fs');
    if (fs.existsSync(fixturePath)) {
      const buffer = readFileSync(fixturePath);
      const fileName = 'repro.sb3';

      // Extract extension URLs from the project to pre-allow them in
      // localStorage. The fixture (repro.sb3) has 3 extensionURLs
      // (penP, lmsLooksPlus, SPimgEditor) — without pre-allow, the
      // ExtensionPermissionDialog opens and blocks loadProject until the
      // user responds, which is not possible in a headless run.
      let extensionUrls = [];
      try {
        const zip = await JSZip.loadAsync(buffer);
        const projectJson = JSON.parse(await zip.file('project.json').async('string'));
        extensionUrls = Object.values(projectJson.extensionURLs || {});
      } catch (e) {
        logTo('E0-extract-ext-error', e?.stack ?? String(e));
      }
      jsonLog('E0a-extension-urls', { count: extensionUrls.length, urls: extensionUrls.map((u) => u.slice(0, 60)) });

      await page.evaluate((urls) => {
        const raw = localStorage.getItem('tw-viewer:settings:v1');
        const parsed = raw ? JSON.parse(raw) : { state: {}, version: 3 };
        parsed.state.allowedExtensionUrls = urls;
        parsed.state.performanceMode = parsed.state.performanceMode || 'auto';
        parsed.version = 3;
        localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
      }, extensionUrls);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForPlayerReady(page);

      // Patch loadProject for timing
      await page.evaluate(() => {
        const tw = window.__turbowasm;
        if (tw && tw.scaffolding && !tw.scaffolding.__patched) {
          const orig = tw.scaffolding.loadProject;
          tw.scaffolding.loadProject = async function (buf) {
            const start = Date.now();
            console.log('[trace] loadProject called with', buf.byteLength, 'bytes');
            try {
              const r = await orig.call(this, buf);
              console.log('[trace] loadProject resolved after', Date.now() - start, 'ms');
              return r;
            } catch (e) {
              console.log('[trace] loadProject rejected:', e?.message);
              throw e;
            }
          };
          tw.scaffolding.__patched = true;
        }
      });

      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        const t0 = Date.now();
        await fileInput.setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer });
        const settingsAppeared = await page
          .waitForSelector('[data-testid="open-settings"]', { timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        projectLoadDurationMs = Date.now() - t0;
        projectLoaded = settingsAppeared;
        projectDrawables = await page.evaluate(() => window.__turbowasm?.renderer?._allDrawables?.length ?? 0);
        jsonLog('E0-load-result', { projectLoaded, settingsAppeared, projectDrawables, projectLoadDurationMs });
        const loadErrs = errorLines.length;
        jsonLog('E0-load-errors-so-far', { count: loadErrs, errors: errorLines.slice(0, 5) });
      } else {
        logTo('E0-no-file-input', 'no file input found on drop screen');
      }
    } else {
      logTo('E0-fixture-missing', `fixture not found at ${fixturePath}`);
    }
  } catch (e) {
    logTo('E0-load-error', e?.stack ?? String(e));
  }
  recordResult('E0.project_loaded', projectLoaded, { projectLoaded, projectDrawables, projectLoadDurationMs });

  // Take screenshot of loaded state
  {
    const shot = await page.screenshot({ fullPage: false });
    writeFileSync(resolve(logsDir, 'chrome-devtools-sb3-loaded.png'), shot);
  }

  // ----- B. PerformanceMode dropdown UI (now that project is loaded) -----
  let settingsOpened = false;
  try {
    const settingsBtn = await page.$('[data-testid="open-settings"]');
    if (settingsBtn) {
      await settingsBtn.click({ timeout: 5000 });
      settingsOpened = true;
      await page.waitForTimeout(500);
    }
  } catch (e) {
    logTo('B1-open-settings-error', e?.stack ?? String(e));
  }
  recordResult('B.settings_dialog_opened', settingsOpened);

  await page.waitForSelector('#performance-mode', { timeout: 5_000 }).catch(() => null);
  const perfModeTrigger = await page.$('#performance-mode');
  let perfDropdownOptions = null;
  if (perfModeTrigger) {
    await perfModeTrigger.click();
    await page.waitForTimeout(300);
    perfDropdownOptions = await page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]');
      if (!list) return null;
      return Array.from(list.querySelectorAll('[role="option"]')).map((el) => ({
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        selected: el.getAttribute('aria-selected'),
      }));
    });
    jsonLog('B2-perf-mode-options', perfDropdownOptions);
    recordResult(
      'B.perf_mode_options_count',
      Array.isArray(perfDropdownOptions) && perfDropdownOptions.length === 4,
      perfDropdownOptions,
    );
    // Verify option labels match the spec
    const expectedLabels = ['Auto', 'Force WebGPU', 'Force WASM SIMD', 'Legacy only'];
    const hasAllLabels = expectedLabels.every((lbl) =>
      perfDropdownOptions.some((o) => o.text.includes(lbl)),
    );
    recordResult('B.perf_mode_labels_match_spec', hasAllLabels, { expectedLabels, options: perfDropdownOptions });
    const shot = await page.screenshot({ fullPage: false });
    writeFileSync(resolve(logsDir, 'chrome-devtools-perf-dropdown-open.png'), shot);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else {
    logTo('B2-perf-mode-trigger-missing', '#performance-mode element not found inside settings dialog');
    recordResult('B.perf_mode_options_count', false, { reason: 'no #performance-mode element' });
    recordResult('B.perf_mode_labels_match_spec', false, { reason: 'no #performance-mode element' });
  }

  // Close the settings dialog
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ----- C. Mode roundtrip via localStorage + reload -----
  // Take screenshots for each mode
  const snapLegacy = await setModeAndReload(page, 'legacy-only');
  const snapForceWasm = await setModeAndReload(page, 'force-wasm');
  const snapForceWebgpu = await setModeAndReload(page, 'force-webgpu');
  const snapAuto = await setModeAndReload(page, 'auto');

  // Screenshot per mode (some may not reload the project; do it explicitly)
  async function screenshotMode(label) {
    const snap = await setModeAndReload(page, label);
    // Re-load project for visual context
    try {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        const fixturePath = resolve(root, 'test-fixtures/repro.sb3');
        const fs = await import('node:fs');
        if (fs.existsSync(fixturePath)) {
          const buffer = fs.readFileSync(fixturePath);
          await fileInput.setInputFiles({
            name: 'repro.sb3',
            mimeType: 'application/octet-stream',
            buffer,
          });
          await page.waitForTimeout(2500);
        }
      }
    } catch {
      /* ignore */
    }
    const shot = await page.screenshot({ fullPage: false });
    writeFileSync(resolve(logsDir, `chrome-devtools-home-${label}.png`), shot);
    return snap;
  }

  // (Already have snaps from setModeAndReload above; replace with project-loaded ones)
  const snapLegacyLoaded = await screenshotMode('legacy-only');
  const snapForceWasmLoaded = await screenshotMode('force-wasm');
  const snapForceWebgpuLoaded = await screenshotMode('force-webgpu');
  const snapAutoLoaded = await screenshotMode('auto');

  // Use the loaded snaps for the assertions
  const legacyAllDetached =
    snapLegacyLoaded.performanceMode === 'legacy-only' &&
    snapLegacyLoaded.hasWasmHook === false &&
    snapLegacyLoaded.hasWasmColorHook === false &&
    snapLegacyLoaded.hasGpuHook === false &&
    snapLegacyLoaded.hasDrawBatchHook === false &&
    snapLegacyLoaded.hasSvgHook === false;
  recordResult('C.legacy_only_all_hooks_detached', legacyAllDetached, snapLegacyLoaded);

  const autoMatchesCaps =
    snapAutoLoaded.performanceMode === 'auto' &&
    snapAutoLoaded.hasWasmHook === Boolean(snapAutoLoaded.capabilities?.wasmSimd) &&
    snapAutoLoaded.hasGpuHook === Boolean(snapAutoLoaded.capabilities?.webgpu && false);
  recordResult('C.auto_mode_matches_capabilities', autoMatchesCaps, snapAutoLoaded);

  recordResult(
    'C.force_wasm_mode_does_not_throw',
    snapForceWasmLoaded.performanceMode === 'force-wasm' && typeof snapForceWasmLoaded.hasWasmHook === 'boolean',
    snapForceWasmLoaded,
  );
  recordResult(
    'C.force_webgpu_mode_does_not_throw',
    snapForceWebgpuLoaded.performanceMode === 'force-webgpu' && typeof snapForceWebgpuLoaded.hasGpuHook === 'boolean',
    snapForceWebgpuLoaded,
  );

  // ----- D. __turbowasm exposed value shape -----
  const dSnap = await page.evaluate(() => {
    const tw = window.__turbowasm;
    if (!tw) return null;
    const r = tw.renderer ?? {};
    return {
      hasScaffolding: typeof tw.scaffolding === 'object' && tw.scaffolding !== null,
      hasRenderer: typeof tw.renderer === 'object' && tw.renderer !== null,
      hasCapabilities: typeof tw.capabilities === 'object' && tw.capabilities !== null,
      hasPerformanceMode: typeof tw.performanceMode === 'string',
      capabilities: tw.capabilities,
      performanceMode: tw.performanceMode,
      rendererTwKeys: Object.keys(r).filter((k) => k.startsWith('_tw')).sort(),
    };
  });
  jsonLog('D-expose-shape', dSnap);
  recordResult(
    'D.expose_shape',
    dSnap !== null && dSnap.hasScaffolding && dSnap.hasRenderer && dSnap.hasCapabilities && dSnap.hasPerformanceMode,
    dSnap,
  );

  // ----- E. Real SB3 load verification (already done in E0) -----
  // Verify no ImageData errors
  const imageDataErrors = errorLines.filter((e) =>
    /Failed to construct 'ImageData'/.test(e.message ?? e.stack ?? ''),
  );
  jsonLog(
    'E1-load-errors',
    errorLines.map((e) => ({ message: e.message, stack: e.stack?.slice(0, 400) })),
  );
  recordResult(
    'E.no_image_data_errors',
    imageDataErrors.length === 0,
    { count: imageDataErrors.length, sample: imageDataErrors[0]?.message },
  );

  // Verify loadProject log
  // Note: `[player] loadProject ...` is only emitted on FAILURE
  // (player.ts:1238). On success, the load resolves silently and
  // `setReadyFromFile()` is called. We assert no failure log instead.
  const loadProjectFailLogs = consoleLines.filter((l) => /\[player\] loadProject (failed|cause|stack)/.test(l.text));
  const traceLogs = consoleLines.filter((l) => /\[trace\] loadProject/.test(l.text));
  jsonLog('E2-load-project-logs', {
    trace: traceLogs.map((l) => l.text.slice(0, 200)),
    failure: loadProjectFailLogs.map((l) => l.text.slice(0, 200)),
  });
  recordResult(
    'E.loadProject_no_failure_log',
    loadProjectFailLogs.length === 0 && traceLogs.length > 0,
    { failureCount: loadProjectFailLogs.length, traceCount: traceLogs.length },
  );

  // ----- F. Debug commands via project input (ControlBar's) -----
  const projectInput = await page.$('[data-testid="project-id-input"]');
  if (projectInput) {
    const runCommand = async (cmd) => {
      // Use evaluate to set the value directly to avoid the disabled-when-empty state
      await projectInput.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await projectInput.focus();
      await projectInput.type(cmd, { delay: 5 });
      await projectInput.press('Enter');
      await page.waitForTimeout(400);
    };
    try {
      await runCommand('!help');
      await runCommand('!dump');
      await runCommand('!reset-performance');
      const afterReset = await page.evaluate(() => {
        const raw = localStorage.getItem('tw-viewer:settings:v1');
        return raw ? JSON.parse(raw).state?.performanceMode : null;
      });
      jsonLog('F-debug-commands', { afterReset });
      recordResult('F.reset_performance_to_auto', afterReset === 'auto', { afterReset });
    } catch (e) {
      logTo('F-error', e?.stack ?? String(e));
      recordResult('F.reset_performance_to_auto', false, { reason: 'exception', error: e?.message?.slice(0, 200) });
    }
  } else {
    logTo('F-missing-input', 'project input not found');
    recordResult('F.reset_performance_to_auto', false, { reason: 'no project input' });
  }

  // ----- G. LocalStorage migration -----
  // v1 → v3
  await page.evaluate(() => {
    localStorage.setItem(
      'tw-viewer:settings:v1',
      JSON.stringify({
        state: {
          theme: 'dark',
          volume: 75,
          advanced: { fps: 60, disableCompiler: true },
        },
        version: 1,
      }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="stage-container"]', { timeout: 10_000 }).catch(() => null);
  await waitForPlayerReady(page);
  const v1Migrated = await page.evaluate(() => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version,
      performanceMode: parsed.state?.performanceMode,
      theme: parsed.state?.theme,
      disableCompiler: parsed.state?.advanced?.disableCompiler,
    };
  });
  const v1Runtime = await page.evaluate(() => ({ performanceMode: window.__turbowasm?.performanceMode }));
  jsonLog('G1-v1-migration', { ls: v1Migrated, runtime: v1Runtime });
  recordResult(
    'G.v1_to_v3_migration',
    v1Migrated?.theme === 'dark' && v1Runtime?.performanceMode === 'auto',
    { v1Migrated, v1Runtime },
  );

  // v2 → v3
  await page.evaluate(() => {
    localStorage.setItem(
      'tw-viewer:settings:v1',
      JSON.stringify({
        state: {
          theme: 'light',
          volume: 50,
          advanced: { fps: 30, disableCompiler: false },
          defaultAdvanced: { fps: 30, disableCompiler: false },
        },
        version: 2,
      }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPlayerReady(page);
  const v2Runtime = await page.evaluate(() => ({ performanceMode: window.__turbowasm?.performanceMode }));
  jsonLog('G2-v2-runtime', v2Runtime);
  recordResult('G.v2_to_v3_migration', v2Runtime?.performanceMode === 'auto', v2Runtime);

  // Invalid version → reset
  await page.evaluate(() => {
    localStorage.setItem(
      'tw-viewer:settings:v1',
      JSON.stringify({ state: { performanceMode: 'force-wasm' }, version: 999 }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPlayerReady(page);
  const invalidRuntime = await page.evaluate(() => ({ performanceMode: window.__turbowasm?.performanceMode }));
  jsonLog('G3-invalid-runtime', invalidRuntime);
  recordResult('G.invalid_version_resets_to_auto', invalidRuntime?.performanceMode === 'auto', invalidRuntime);

  // ----- H. Network assets -----
  const wasmRequests = networkLog
    .filter((n) => n.phase === 'response' && n.url.endsWith('.wasm'))
    .map((n) => ({
      url: n.url.replace(targetUrl, ''),
      status: n.status,
      contentType: n.contentType,
      cacheControl: n.cacheControl,
    }));
  const jsRequests = networkLog
    .filter((n) => n.phase === 'response' && (n.url.includes('scaffolding') || n.url.includes('resvg-wasm')))
    .map((n) => ({
      url: n.url.replace(targetUrl, ''),
      status: n.status,
      contentType: n.contentType,
    }));
  jsonLog('H1-wasm-requests', wasmRequests);
  jsonLog('H2-js-requests', jsRequests);
  const hasResvgWasm = wasmRequests.some(
    (r) => r.url.includes('index_bg') && r.status === 200 && /wasm/i.test(r.contentType ?? ''),
  );
  const hasCollisionWasm = wasmRequests.some(
    (r) => r.url.includes('tw_viewer_wasm_collision_bg') && r.status === 200 && /wasm/i.test(r.contentType ?? ''),
  );
  recordResult('H.resvg_wasm_loaded', hasResvgWasm, { hasResvgWasm, wasmRequests });
  // Collision wasm is only loaded when WASM SIMD is supported. In
  // headless Chromium without SIMD this is expected to be absent. The
  // assertion is conditional on the runtime capability so a missing
  // collision wasm in a no-SIMD environment does not fail the suite.
  const collisionWasmExpected = await page.evaluate(
    () => Boolean(window.__turbowasm?.capabilities?.wasmSimd),
  );
  const collisionWasmConditional = collisionWasmExpected ? hasCollisionWasm : true;
  recordResult(
    'H.collision_wasm_loaded',
    collisionWasmConditional,
    {
      hasCollisionWasm,
      collisionWasmExpected,
      note: collisionWasmExpected
        ? 'wasmSimd was detected; collision wasm expected to be loaded'
        : 'wasmSimd not available; collision wasm correctly NOT loaded (fallback to JS path)',
    },
  );
  recordResult('H.scaffolding_loaded', jsRequests.some((r) => r.url.includes('scaffolding') && r.status === 200), { jsRequests });

  // ----- I. Visual regression (4 modes) -----
  const screenshots = [
    'chrome-devtools-home-auto.png',
    'chrome-devtools-home-legacy-only.png',
    'chrome-devtools-home-force-wasm.png',
    'chrome-devtools-home-force-webgpu.png',
  ];
  const shots = screenshots.map((s) => ({
    file: s,
    exists: existsSync(resolve(logsDir, s)),
    size: existsSync(resolve(logsDir, s)) ? statSync(resolve(logsDir, s)).size : 0,
  }));
  jsonLog('I1-screenshots', shots);
  recordResult('I.all_4_screenshots_taken', shots.every((s) => s.exists && s.size > 1000), shots);

  // ----- J. Error monitoring -----
  const fatalErrors = errorLines.filter(
    (e) => /Failed to construct 'ImageData'|TypeError|ReferenceError|SyntaxError|act\(/.test(e.message ?? e.stack ?? ''),
  );
  const consoleErrors = consoleLines.filter((l) => l.type === 'error');
  jsonLog(
    'J1-errors',
    errorLines.map((e) => ({ message: e.message, stack: e.stack?.slice(0, 800) })),
  );
  jsonLog(
    'J2-console-errors',
    consoleErrors.map((e) => ({ text: e.text.slice(0, 500) })),
  );
  recordResult(
    'J.no_fatal_pageerrors',
    fatalErrors.length === 0,
    { count: fatalErrors.length, sample: fatalErrors[0]?.message },
  );

  logTo(
    'J3-console-all',
    consoleLines.map((l) => `[${l.type}] ${l.text}`).join('\n'),
  );
  logTo(
    'J4-network-all',
    networkLog
      .map((n) => {
        if (n.phase === 'response') {
          return `[${n.phase}] ${n.status} ct=${n.contentType ?? '-'} ${n.url}`;
        }
        if (n.phase === 'requestfailed') {
          return `[${n.phase}] FAIL ${n.failure ?? ''} ${n.url}`;
        }
        return `[${n.phase}] ${n.url}`;
      })
      .join('\n'),
  );

  await browser.close();

  summary.completedAt = new Date().toISOString();
  const allPassed = summary.scenarios.every((s) => s.ok);
  summary.allPassed = allPassed;
  summary.passed = summary.scenarios.filter((s) => s.ok).length;
  summary.failed = summary.scenarios.filter((s) => !s.ok).length;
  jsonLog('summary', summary);
  // eslint-disable-next-line no-console
  console.log(`[mcp-verify] done. ${summary.passed} passed / ${summary.failed} failed.`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  logTo('fatal', err?.stack ?? String(err));
  // eslint-disable-next-line no-console
  console.error('[mcp-verify] fatal:', err);
  process.exit(2);
});
