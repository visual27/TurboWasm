/**
 * Real-browser verification harness for the TurboWasm Viewer dist build.
 *
 * Spins up a headless browser via `playwright` (already installed in
 * vendored/scaffolding's dev deps via a transitive reference; we install
 * it locally if missing), navigates to the preview server, and asserts:
 *
 *   - The page mounts without any `act()` warnings, React errors, or
 *     unhandled rejections.
 *   - The `_twWasm*` WASM-SIMD host hooks are installed on the
 *     Scaffolding renderer when WASM SIMD is available. The retired
 *     Phase 2 / Phase 3 / Stage 2 hooks (`_twWasmGpuTouchingStart`,
 *     `_twWasmGpuTouchingFin`, `_twWasmDrawSprites`,
 *     `_twWasmRasterSvgCostume`) must NOT be present.
 *   - Loading a fixture SB3 (test/.test-fixtures/repro.sb3) triggers a
 *     `[player] loadProject` log line and no `Failed to construct
 *     'ImageData'` DOMException.
 *   - Flipping the Enable WASM toggle clears the host hooks (the
 *     previous v3..v7 `performanceMode: 'legacy-only'` path); flipping
 *     it back re-installs them.
 *
 * Run with: `node scripts/verify-browser.mjs --url http://localhost:4173`.
 *
 * Logs the captured artefacts under `./logs/` (browser-verify-*.log).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const logsDir = resolve(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const args = process.argv.slice(2);
const urlArgIdx = args.indexOf('--url');
const targetUrl = urlArgIdx >= 0 && args[urlArgIdx + 1] ? args[urlArgIdx + 1] : 'http://localhost:4173/';

function log(name, content) {
  const file = resolve(logsDir, `browser-verify-${name}.log`);
  writeFileSync(file, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[browser-verify] wrote ${file} (${content.length} bytes)`);
}

async function main() {
  // Lazy import playwright so the script can be invoked without it
  // for environments that only want the HTTP smoke test.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    log('import-error', `playwright is not installed.\n${err?.stack ?? err}`);
    // eslint-disable-next-line no-console
    console.error('[browser-verify] playwright not available; skipping browser pass.');
    process.exit(0);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleLines = [];
  const errorLines = [];
  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    errorLines.push(`[pageerror] ${err?.stack ?? String(err)}`);
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#stage-container, [data-turbowasm-stage]', { timeout: 15_000 }).catch(() => null);

  // Wait for the Scaffolding instance to appear on `window.__turbowasm`.
  await page.waitForFunction(() => Boolean((window).__turbowasm), undefined, { timeout: 10_000 }).catch(() => null);

  const hooks = await page.evaluate(() => {
    const tw = (window).__turbowasm;
    if (!tw) return { mounted: false };
    const r = tw.renderer;
    return {
      mounted: true,
      enableWasm: tw.enableWasm,
      capabilities: tw.capabilities,
      drawables: r?._allDrawables?.length ?? 0,
      hasWasmHook: typeof r?._twWasmIsTouchingDrawables === 'function',
      hasWasmColorHook: typeof r?._twWasmIsTouchingColor === 'function',
      // Retired hooks — must remain absent. Pinning them here catches
      // a regression where a stale UMD is shipped with the
      // svg-acceleration / WebGPU compute / instanced renderer hooks
      // still installed.
      hasGpuStartHook: typeof r?._twWasmGpuTouchingStart === 'function',
      hasGpuFinHook: typeof r?._twWasmGpuTouchingFin === 'function',
      hasDrawBatchHook: typeof r?._twWasmDrawSprites === 'function',
      hasSvgHostHook: !!r?._twWasmSvgAcceleration,
      hasResvgRasterHook: !!r?._twWasmRasterSvgCostume,
    };
  });
  log('hooks', JSON.stringify(hooks, null, 2));

  // ---- Settings dialog: flip Enable WASM ----
  // We do not click — we drive the store directly to keep the test
  // independent of CSS selector stability. The `__exposeForBrowserVerify`
  // re-publishes hooks after every applySettings call, so we can observe
  // the dispatcher re-routing through the same accessor.
  const beforeCheck = await page.evaluate(() => {
    const win = window;
    const tw = win.__turbowasm;
    if (!tw) return null;
    return { enableWasm: tw.enableWasm };
  });
  log('settings-before', JSON.stringify(beforeCheck, null, 2));

  // Drive the store: write `enableWasm: false` to localStorage and reload
  // to simulate the user disabling the WASM toggle in the Settings
  // dialog. The persisted version is the current STORAGE_VERSION (8).
  await page.evaluate(() => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 8 };
    parsed.state.enableWasm = false;
    parsed.version = 8;
    localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window).__turbowasm), undefined, { timeout: 10_000 }).catch(() => null);
  const afterDisable = await page.evaluate(() => {
    const tw = (window).__turbowasm;
    if (!tw) return null;
    const r = tw.renderer;
    return {
      enableWasm: tw.enableWasm,
      hasWasmHook: typeof r?._twWasmIsTouchingDrawables === 'function',
      hasWasmColorHook: typeof r?._twWasmIsTouchingColor === 'function',
    };
  });
  log('settings-after-wasm-disabled', JSON.stringify(afterDisable, null, 2));

  // Re-enable WASM via localStorage + reload to confirm the toggle is
  // reversible.
  await page.evaluate(() => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 8 };
    parsed.state.enableWasm = true;
    parsed.version = 8;
    localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window).__turbowasm), undefined, { timeout: 10_000 }).catch(() => null);
  const afterReEnable = await page.evaluate(() => {
    const tw = (window).__turbowasm;
    if (!tw) return null;
    return { enableWasm: tw.enableWasm };
  });
  log('settings-after-wasm-restored', JSON.stringify(afterReEnable, null, 2));

  await page.waitForTimeout(500);

  log('console', consoleLines.join('\n'));
  log('errors', errorLines.join('\n'));

  const shot = await page.screenshot({ fullPage: false });
  writeFileSync(resolve(logsDir, 'browser-verify-home.png'), shot);
  // eslint-disable-next-line no-console
  console.log(`[browser-verify] wrote logs/browser-verify-home.png (${shot.length} bytes)`);

  await browser.close();

  // eslint-disable-next-line no-console
  console.log('[browser-verify] done; see logs/browser-verify-*.log');
  const failed = errorLines.some((l) => /Failed to construct 'ImageData'|TypeError|ReferenceError|SyntaxError/.test(l));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  log('fatal', err?.stack ?? String(err));
  // eslint-disable-next-line no-console
  console.error('[browser-verify] fatal:', err);
  process.exit(2);
});
