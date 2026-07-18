// Real-browser smoke for the v8 settings refactor.
// Boots a chromium page, loads the repro SB3, opens the Settings
// dialog, and verifies the three TurboWasm toggles exist with the
// expected labels (Enable WASM + Enable WebGPU + TurboWasm
// Acceleration) and that flipping Enable WASM propagates to
// window.__turbowasm.enableWasm and the persisted settings blob.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const logsDir = resolve(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const TARGET = 'http://localhost:4180/';
const SETTINGS_KEY = 'tw-viewer:settings:v1';

function log(name, content) {
  const file = resolve(logsDir, `smoke-v8-${name}.log`);
  writeFileSync(file, content, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[smoke-v8] wrote ${file}`);
}

let pass = true;
function check(cond, label, details) {
  if (cond) {
    // eslint-disable-next-line no-console
    console.log(`[smoke-v8] PASS ${label}`);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[smoke-v8] FAIL ${label}`, details ?? '');
    pass = false;
  }
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    log('import-error', `playwright is not installed.\n${err?.stack ?? err}`);
    // eslint-disable-next-line no-console
    console.error('[smoke-v8] playwright not available; skipping.');
    process.exit(0);
  }

  const fixturePath = resolve(root, 'test/.test-fixtures/repro.sb3');
  if (!existsSync(fixturePath)) {
    log('fatal', `fixture not found at ${fixturePath}`);
    process.exit(2);
  }
  const fixtureBuffer = readFileSync(fixturePath);

  // Extract the fixture's extensionURLs so we can pre-allow them in
  // localStorage (otherwise the ExtensionPermissionDialog would block
  // the load).
  let extensionUrls = [];
  try {
    const zip = await JSZip.loadAsync(fixtureBuffer);
    const projectJson = JSON.parse(await zip.file('project.json').async('string'));
    extensionUrls = Object.values(projectJson.extensionURLs || {});
  } catch (e) {
    log('extract-ext-error', e?.stack ?? String(e));
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleLines = [];
  const pageErrors = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) =>
    pageErrors.push({ message: err?.message, stack: err?.stack }),
  );

  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await page
    .waitForSelector('[data-testid="stage-container"]', { timeout: 15_000 })
    .catch(() => null);
  await page
    .waitForFunction(() => Boolean(globalThis.__turbowasm?.scaffolding), undefined, {
      timeout: 10_000,
    })
    .catch(() => null);

  check(
    true === (await page.evaluate(() => Boolean(globalThis.__turbowasm))),
    '__turbowasm mounted',
  );

  // Pre-seed localStorage: pre-allow extension URLs and clear `enableWasm` so
  // we start from a known state.
  await page.evaluate(
    ({ urls }) => {
      const raw = localStorage.getItem('tw-viewer:settings:v1');
      const parsed = raw ? JSON.parse(raw) : { state: {}, version: 8 };
      parsed.state.allowedExtensionUrls = urls;
      parsed.state.enableWasm = true;
      parsed.version = 8;
      localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
    },
    { urls: extensionUrls },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => Boolean(globalThis.__turbowasm?.scaffolding), undefined, {
      timeout: 10_000,
    })
    .catch(() => null);

  // Load the fixture via the hidden file input so the
  // ExtensionPermissionDialog is bypassed (extension URLs were
  // pre-allowed above) and the green-flag / settings button becomes
  // visible.
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    await fileInput.setInputFiles({
      name: 'repro.sb3',
      mimeType: 'application/octet-stream',
      buffer: fixtureBuffer,
    });
    await page
      .waitForSelector('[data-testid="open-settings"]', { timeout: 20_000 })
      .catch(() => null);
  }

  const initial = await page.evaluate(() => Boolean(globalThis.__turbowasm?.enableWasm));
  check(initial === true, 'initial enableWasm=true after fixture load', { initial });

  const settingsBtn = await page.$('[data-testid="open-settings"]');
  check(Boolean(settingsBtn), 'settings button present after fixture load');
  if (settingsBtn) {
    await settingsBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(400);
  }

  const togglePresence = await page.evaluate(() => ({
    turboWasmAcceleration: !!document.getElementById('turbo-wasm-acceleration'),
    enableWebgpu: !!document.getElementById('enable-webgpu'),
    enableWasm: !!document.getElementById('enable-wasm'),
    // The retired Performance Mode dropdown must be absent.
    performanceMode: !!document.getElementById('performance-mode'),
  }));
  check(
    togglePresence.turboWasmAcceleration,
    'turbo-wasm-acceleration toggle present',
    togglePresence,
  );
  check(
    togglePresence.enableWebgpu,
    'enable-webgpu toggle present',
    togglePresence,
  );
  check(togglePresence.enableWasm, 'enable-wasm toggle present', togglePresence);
  check(
    !togglePresence.performanceMode,
    'performance-mode dropdown is gone',
    togglePresence,
  );

  // Order check: locate each toggle by its `id` attribute inside the
  // TurboWasm section and compare document positions. The toggle
  // buttons themselves carry those `id`s (set on the button's
  // closest FieldRow), so this walks the DOM in the same order the
  // user sees.
  const order = await page.evaluate(() => {
    const section = Array.from(document.querySelectorAll('section')).find((el) =>
      el.querySelector('[data-testid="settings-section-turbowasm"]'),
    );
    if (!section) return { tw: -1, webgpu: -1, wasm: -1 };
    const all = Array.from(section.querySelectorAll('*'));
    return {
      tw: all.findIndex((el) => el.id === 'turbo-wasm-acceleration'),
      webgpu: all.findIndex((el) => el.id === 'enable-webgpu'),
      wasm: all.findIndex((el) => el.id === 'enable-wasm'),
    };
  });
  check(
    order.tw >= 0 && order.webgpu > order.tw && order.wasm > order.webgpu,
    'toggles are ordered TurboWasm Acceleration → Enable WebGPU → Enable WASM',
    order,
  );

  // Click the Enable WASM toggle to flip it off, then verify the
  // runtime and persisted state both reflect the new value.
  const wasmToggle = await page.$('#enable-wasm');
  if (wasmToggle) {
    await wasmToggle.click();
    await page.waitForTimeout(400);
  }
  const afterClick = await page.evaluate(() => ({
    runtime: Boolean(globalThis.__turbowasm?.enableWasm),
    ls: JSON.parse(localStorage.getItem('tw-viewer:settings:v1') ?? '{}')?.state?.enableWasm,
  }));
  check(
    afterClick.runtime === false && afterClick.ls === false,
    'enableWasm=false propagates to runtime + localStorage',
    afterClick,
  );

  // Toggle it back on for a clean baseline.
  if (wasmToggle) {
    await wasmToggle.click();
    await page.waitForTimeout(400);
  }
  const restored = await page.evaluate(() => Boolean(globalThis.__turbowasm?.enableWasm));
  check(restored === true, 'enableWasm=true after re-flip', { restored });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Drive !reset-wasm via the project-id input to confirm the renamed
  // debug command still sets the toggle back to enabled.
  await page.evaluate(() => {
    const raw = localStorage.getItem('tw-viewer:settings:v1');
    const parsed = raw ? JSON.parse(raw) : { state: {}, version: 8 };
    parsed.state.enableWasm = false;
    parsed.version = 8;
    localStorage.setItem('tw-viewer:settings:v1', JSON.stringify(parsed));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(() => Boolean(globalThis.__turbowasm?.scaffolding), undefined, {
      timeout: 10_000,
    })
    .catch(() => null);
  const afterReload = await page.evaluate(
    () => Boolean(globalThis.__turbowasm?.enableWasm),
  );
  check(afterReload === false, 'persisted enableWasm=false survives reload', { afterReload });

  const projectInput = await page.$('[data-testid="project-id-input"]');
  if (projectInput) {
    const runCommand = async (cmd) => {
      await projectInput.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await projectInput.focus();
      await projectInput.type(cmd, { delay: 5 });
      await projectInput.press('Enter');
      await page.waitForTimeout(400);
    };
    await runCommand('!reset-wasm');
    const afterReset = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('tw-viewer:settings:v1') ?? '{}')?.state?.enableWasm,
    );
    check(afterReset === true, '!reset-wasm restores enableWasm=true', { afterReset });
  }

  const hasImageDataError = pageErrors.some((e) =>
    /Failed to construct 'ImageData'/.test(e.message ?? e.stack ?? ''),
  );
  check(!hasImageDataError, 'no ImageData page errors during smoke', pageErrors);
  check(
    !consoleLines.some((l) => /act\(/.test(l)),
    'no React act() warnings during smoke',
  );

  log(
    'result',
    `pass=${pass}\nconsoleLinesTail=${JSON.stringify(
      consoleLines.slice(-20),
      null,
      2,
    )}\nerrors=${JSON.stringify(pageErrors, null, 2)}`,
  );

  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`[smoke-v8] done; pass=${pass}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-v8] FATAL:', err);
  log('fatal', err?.stack ?? String(err));
  process.exit(2);
});
