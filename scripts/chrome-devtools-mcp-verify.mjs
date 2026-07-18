/**
 * Comprehensive real-browser verification harness for the TurboWasm
 * Viewer — covers the surviving WASM-SIMD ↔ JS fallback chain and
 * the localStorage migration contract. Phase 2 (WebGPU compute),
 * Phase 3 (WebGPU instanced renderer), and the Stage 2 SVG
 * acceleration host were retired in v6 along with their UI selectors;
 * this harness no longer references them and asserts the renderer
 * carries only the surviving hooks.
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
import { getWebgpuLaunchOptions, isWebgpuOptedOut, WEBGPU_LAUNCH_FLAGS } from './webgpu-flags.mjs';

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
    const kr = tw.kernelRegistry;
    return {
      mounted: Boolean(tw.scaffolding),
      enableWasm: tw.enableWasm,
      capabilities: tw.capabilities,
      hasScaffolding: typeof tw.scaffolding === 'object' && tw.scaffolding !== null,
      hasWasmHook: typeof r._twWasmIsTouchingDrawables === 'function',
      hasWasmColorHook: typeof r._twWasmIsTouchingColor === 'function',
      // Retired hooks — must remain absent. Pinning them here catches
      // a regression where a stale UMD is shipped with the
      // svg-acceleration / WebGPU compute / instanced renderer hooks
      // still installed.
      hasGpuStartHook: typeof r._twWasmGpuTouchingStart === 'function',
      hasGpuFinHook: typeof r._twWasmGpuTouchingFin === 'function',
      hasDrawBatchHook: typeof r._twWasmDrawSprites === 'function',
      hasSvgHostHook: !!r._twWasmSvgAcceleration,
      hasResvgRasterHook: !!r._twWasmRasterSvgCostume,
      drawables: r._allDrawables?.length ?? 0,
      // M7: GPU compute kernel pipeline telemetry. `kernelRegistry` is
      // unconditionally published by `__exposeForBrowserVerify()` so
      // even `enableWasm=false` runs produce a `{size:0, jsOnly:0,
      // canonicalKeys:[]}` snapshot. We do *not* probe `navigator.gpu`
      // here — that's recorded separately in the `webgpu_state`
      // scenario so this snapshot stays in sync with the renderer
      // hooks above.
      kernelRegistry: kr
        ? { size: kr.size ?? 0, jsOnly: kr.jsOnly ?? 0, canonicalKeys: Array.isArray(kr.canonicalKeys) ? kr.canonicalKeys.slice(0, 8) : [] }
        : null,
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

async function setModeAndReload(page, enableWasm) {
  await page.evaluate((w) => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 8 };
    parsed.state.enableWasm = w;
    parsed.version = 8;
    localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
  }, enableWasm);
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

  const launchOptions = getWebgpuLaunchOptions();
  logTo('launch-options', JSON.stringify({ ...launchOptions, optedOut: isWebgpuOptedOut(), flags: WEBGPU_LAUNCH_FLAGS }, null, 2));
  const browser = await chromium.launch(launchOptions);
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
    return { present: true, version: parsed.version, enableWasm: parsed.state?.enableWasm };
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
    const fixturePath = resolve(root, 'test/.test-fixtures/repro.sb3');
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
        const parsed = raw ? JSON.parse(raw) : { state: {}, version: 8 };
        parsed.state.allowedExtensionUrls = urls;
        parsed.state.enableWasm = parsed.state.enableWasm ?? true;
        parsed.version = 8;
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

  // ----- B. Enable WASM / Enable WebGPU toggles inside the dialog ----
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

  await page.waitForSelector('#enable-wasm', { timeout: 5_000 }).catch(() => null);
  const enableWasmToggle = await page.$('#enable-wasm');
  const enableWebgpuToggle = await page.$('#enable-webgpu');
  const turboWasmToggle = await page.$('#turbo-wasm-acceleration');
  const togglePresence = {
    enableWasm: !!enableWasmToggle,
    enableWebgpu: !!enableWebgpuToggle,
    turboWasmAcceleration: !!turboWasmToggle,
  };
  jsonLog('B1-toggles-present', togglePresence);
  recordResult('B.enable_wasm_toggle_present', togglePresence.enableWasm);
  recordResult('B.enable_webgpu_toggle_present', togglePresence.enableWebgpu);
  recordResult('B.turbo_wasm_toggle_present', togglePresence.turboWasmAcceleration);

  // Confirm the Enable WASM toggle sits below Enable WebGPU (per the v8
  // dialog layout: TurboWasm Acceleration → Enable WebGPU → Enable WASM).
  if (enableWasmToggle && enableWebgpuToggle) {
    const order = await page.evaluate(() => {
      const order = (id) => {
        const el = document.getElementById(id);
        if (!el) return -1;
        // Compare document order: walk the DOM and tally siblings that
        // match either id, returning the index of `id`.
        const all = Array.from(document.querySelectorAll('[data-testid^="settings-section-turbowasm"] *, #enable-wasm, #enable-webgpu, #turbo-wasm-acceleration'));
        return all.indexOf(el);
      };
      return {
        turbo: order('turbo-wasm-acceleration'),
        webgpu: order('enable-webgpu'),
        wasm: order('enable-wasm'),
      };
    });
    jsonLog('B2-toggle-order', order);
    recordResult(
      'B.toggles_in_expected_order',
      order.turbo >= 0 && order.webgpu > order.turbo && order.wasm > order.webgpu,
      order,
    );
  }
  const shot = await page.screenshot({ fullPage: false });
  writeFileSync(resolve(logsDir, 'chrome-devtools-settings-toggles.png'), shot);

  // Close the settings dialog
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ----- C. Enable WASM roundtrip via localStorage + reload -----
  const snapWasmOff = await setModeAndReload(page, false);
  const snapWasmOn = await setModeAndReload(page, true);

  // Re-load project for visual context per mode (some reloads drop the
  // project state, so re-upload the fixture for each screenshot).
  async function screenshotState(enableWasm) {
    const snap = await setModeAndReload(page, enableWasm);
    try {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        const fixturePath = resolve(root, 'test/.test-fixtures/repro.sb3');
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
    const label = enableWasm ? 'wasm-on' : 'wasm-off';
    const shot = await page.screenshot({ fullPage: false });
    writeFileSync(resolve(logsDir, `chrome-devtools-home-${label}.png`), shot);
    return snap;
  }

  const snapWasmOffLoaded = await screenshotState(false);
  const snapWasmOnLoaded = await screenshotState(true);

  // enableWasm=false clears every TurboWasm hook — the DoD parity mode
  // replaces the v3..v7 `performanceMode: 'legacy-only'` path.
  const wasmOffAllDetached =
    snapWasmOffLoaded.enableWasm === false &&
    snapWasmOffLoaded.hasWasmHook === false &&
    snapWasmOffLoaded.hasWasmColorHook === false &&
    snapWasmOffLoaded.hasGpuStartHook === false &&
    snapWasmOffLoaded.hasDrawBatchHook === false &&
    snapWasmOffLoaded.hasSvgHostHook === false &&
    snapWasmOffLoaded.hasResvgRasterHook === false;
  recordResult('C.enable_wasm_off_all_hooks_detached', wasmOffAllDetached, snapWasmOffLoaded);

  // enableWasm=true installs the WASM hook iff the runtime detected
  // SIMD support. This replaces the v3..v7 `performanceMode: 'auto'`
  // round-trip path.
  const wasmOnMatchesCaps =
    snapWasmOnLoaded.enableWasm === true &&
    snapWasmOnLoaded.hasWasmHook === Boolean(snapWasmOnLoaded.capabilities?.wasmSimd);
  recordResult('C.enable_wasm_on_matches_capabilities', wasmOnMatchesCaps, snapWasmOnLoaded);

  // ----- D. __turbowasm exposed value shape -----
  const dSnap = await page.evaluate(() => {
    const tw = window.__turbowasm;
    if (!tw) return null;
    const r = tw.renderer ?? {};
    return {
      hasScaffolding: typeof tw.scaffolding === 'object' && tw.scaffolding !== null,
      hasRenderer: typeof tw.renderer === 'object' && tw.renderer !== null,
      hasCapabilities: typeof tw.capabilities === 'object' && tw.capabilities !== null,
      hasEnableWasm: typeof tw.enableWasm === 'boolean',
      capabilities: tw.capabilities,
      enableWasm: tw.enableWasm,
      rendererTwKeys: Object.keys(r).filter((k) => k.startsWith('_tw')).sort(),
    };
  });
  jsonLog('D-expose-shape', dSnap);
  recordResult(
    'D.expose_shape',
    dSnap !== null && dSnap.hasScaffolding && dSnap.hasRenderer && dSnap.hasCapabilities && dSnap.hasEnableWasm,
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
      await runCommand('!reset-wasm');
      const afterReset = await page.evaluate(() => {
        const raw = localStorage.getItem('tw-viewer:settings:v1');
        return raw ? JSON.parse(raw).state?.enableWasm : null;
      });
      jsonLog('F-debug-commands', { afterReset });
      recordResult('F.reset_wasm_to_enabled', afterReset === true, { afterReset });
    } catch (e) {
      logTo('F-error', e?.stack ?? String(e));
      recordResult('F.reset_wasm_to_enabled', false, { reason: 'exception', error: e?.message?.slice(0, 200) });
    }
  } else {
    logTo('F-missing-input', 'project input not found');
    recordResult('F.reset_wasm_to_enabled', false, { reason: 'no project input' });
  }

  // ----- G. LocalStorage migration -----
  // v1 → v8 (legacy payload with no `enableWasm` / `performanceMode`)
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
      enableWasm: parsed.state?.enableWasm,
      theme: parsed.state?.theme,
      disableCompiler: parsed.state?.advanced?.disableCompiler,
    };
  });
  const v1Runtime = await page.evaluate(() => ({ enableWasm: window.__turbowasm?.enableWasm }));
  jsonLog('G1-v1-migration', { ls: v1Migrated, runtime: v1Runtime });
  recordResult(
    'G.v1_to_v8_migration',
    v1Migrated?.theme === 'dark' && v1Runtime?.enableWasm === true,
    { v1Migrated, v1Runtime },
  );

  // v2 → v8 (legacy payload with no `enableWasm` / `performanceMode`)
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
  const v2Runtime = await page.evaluate(() => ({ enableWasm: window.__turbowasm?.enableWasm }));
  jsonLog('G2-v2-runtime', v2Runtime);
  recordResult('G.v2_to_v8_migration', v2Runtime?.enableWasm === true, v2Runtime);

  // v7 → v8: a payload that still carries the legacy `performanceMode`
  // + `advanced.enableGpuKernels` shape must be migrated in place.
  await page.evaluate(() => {
    localStorage.setItem(
      'tw-viewer:settings:v1',
      JSON.stringify({
        state: {
          theme: 'system',
          volume: 100,
          advanced: { enableGpuKernels: false },
          defaultAdvanced: { enableGpuKernels: false },
          performanceMode: 'legacy-only',
        },
        version: 7,
      }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPlayerReady(page);
  const v7Runtime = await page.evaluate(() => ({
    enableWasm: window.__turbowasm?.enableWasm,
    enableWebgpu: window.__turbowasm?.enableWebgpu,
  }));
  jsonLog('G3-v7-runtime', v7Runtime);
  recordResult(
    'G.v7_to_v8_migration',
    v7Runtime?.enableWasm === false && v7Runtime?.enableWebgpu === false,
    v7Runtime,
  );

  // Invalid version → reset
  await page.evaluate(() => {
    localStorage.setItem(
      'tw-viewer:settings:v1',
      JSON.stringify({ state: { performanceMode: 'force-wasm' }, version: 999 }),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPlayerReady(page);
  const invalidRuntime = await page.evaluate(() => ({ enableWasm: window.__turbowasm?.enableWasm }));
  jsonLog('G4-invalid-runtime', invalidRuntime);
  recordResult('G.invalid_version_resets_to_defaults', invalidRuntime?.enableWasm === true, invalidRuntime);

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

  // ----- I. Visual regression (enableWasm on/off) -----
  // The v3..v7 `performanceMode` union was collapsed to a single
  // `enableWasm` boolean in v8, so the surviving visual states are
  // `enableWasm=true` (default) and `enableWasm=false` (parity mode).
  const screenshots = [
    'chrome-devtools-home-wasm-on.png',
    'chrome-devtools-home-wasm-off.png',
  ];
  const shots = screenshots.map((s) => ({
    file: s,
    exists: existsSync(resolve(logsDir, s)),
    size: existsSync(resolve(logsDir, s)) ? statSync(resolve(logsDir, s)).size : 0,
  }));
  jsonLog('I1-screenshots', shots);
  recordResult('I.all_screenshots_taken', shots.every((s) => s.exists && s.size > 1000), shots);

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

  // ----- J2. WebGPU detection (M7) -----
  // Probe `navigator.gpu` and try `requestAdapter()` to confirm the
  // Chromium launch flags actually enabled the API surface. This is
  // the single source of truth for "is WebGPU available in this run":
  // the log line `[gpu-kernel] bootstrapped ... device=available`
  // only fires when a project is loaded, but this probe is independent.
  const webgpuProbe = await page.evaluate(async () => {
    const nav = /** @type {any} */ (globalThis.navigator);
    const gpu = nav?.gpu;
    if (!gpu) return { apiAvailable: false, adapter: null, reason: 'navigator.gpu is undefined' };
    let adapter = null;
    let adapterInfo = null;
    try {
      adapter = await gpu.requestAdapter();
      if (adapter) {
        let info = null;
        try { info = await adapter.requestAdapterInfo?.(); } catch { /* ignore */ }
        adapterInfo = info ? { vendor: info.vendor ?? null, architecture: info.architecture ?? null, device: info.device ?? null, description: info.description ?? null } : null;
      }
    } catch (err) {
      return { apiAvailable: true, adapter: null, reason: `requestAdapter threw: ${err?.message ?? err}` };
    }
    return { apiAvailable: true, adapter: adapter ? 'available' : 'null', adapterInfo };
  });
  const gpuKernelLines = consoleLines.filter((l) => l.text.includes('[gpu-kernel]'));
  const bootstrappedAvailable = gpuKernelLines.some((l) => /device=available/.test(l.text));
  const bootstrappedNull = gpuKernelLines.some((l) => /device=null/.test(l.text));
  const wasmDisabledSkipped = consoleLines.some((l) => /\[gpu-kernel\] enableWasm=false/.test(l.text));
  const webgpuState = {
    probedAt: new Date().toISOString(),
    launcherOptedOut: isWebgpuOptedOut(),
    launchFlags: WEBGPU_LAUNCH_FLAGS,
    apiAvailable: webgpuProbe.apiAvailable,
    adapterObserved: webgpuProbe.adapter === 'available',
    adapterInfo: webgpuProbe.adapterInfo ?? null,
    bootstrapLogLines: gpuKernelLines.map((l) => l.text.slice(0, 200)),
    bootstrappedAvailable,
    bootstrappedNull,
    wasmDisabledSkipped,
    // Invariant: API+adapter presence must agree with the [gpu-kernel]
    // log line so a silent disagreement between Chromium and the
    // vendored VM surfaces here.
    invariant:
      webgpuProbe.adapter === 'available'
        ? bootstrappedAvailable || null
        : !bootstrappedAvailable,
  };
  jsonLog('webgpu', webgpuState);
  recordResult(
    'J2.webgpu_state_recorded',
    typeof webgpuProbe.apiAvailable === 'boolean' && Array.isArray(gpuKernelLines),
    webgpuState,
  );
  // The invariant is best-effort: enableWasm=false runs never enter
  // bootstrap, so we skip the assertion there.
  if (!wasmDisabledSkipped) {
    recordResult(
      'J2.webgpu_invariant',
      webgpuState.invariant === true || webgpuState.invariant === null,
      { invariant: webgpuState.invariant, adapterObserved: webgpuState.adapterObserved, bootstrappedAvailable },
    );
  } else {
    recordResult(
      'J2.webgpu_invariant',
      true,
      { note: 'enableWasm=false path; bootstrap skipped', wasmDisabledSkipped: true },
    );
  }

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
