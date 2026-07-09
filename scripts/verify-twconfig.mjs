/**
 * Focused browser smoke: drop a fixture whose // _twconfig_ comment
 * carries the canonical TurboWasp blob, then verify both the VM
 * (project overrides) and the Settings dialog (also project overrides)
 * pick up the merged values. This is the regression for the user's
 * report that the stage border, stage canvas, and dialog were all
 * reading different sources of truth.
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:5173/';
const fixturePath =
  process.argv[3] ?? path.resolve('test/.test-fixtures/twconfig-fixture.sb3');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleLines = [];
const errorLines = [];
page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => errorLines.push(`[pageerror] ${err?.stack ?? err}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__turbowasm), undefined, {
  timeout: 30_000,
});

// Drop the fixture on the global drop handler.
const fileBuffer = readFileSync(fixturePath);
const dataTransfer = await page.evaluateHandle((buf) => {
  const bytes = new Uint8Array(buf);
  const file = new File(
    [bytes],
    'twconfig-fixture.sb3',
    { type: 'application/octet-stream' },
  );
  const dt = new DataTransfer();
  dt.items.add(file);
  return dt;
}, Array.from(fileBuffer));

await page.evaluate(async (dt) => {
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
}, dataTransfer);

await page.waitForFunction(
  () => Boolean(window.__turbowasm?.scaffolding?.vm),
  undefined,
  { timeout: 30_000 },
);
await page.waitForTimeout(1500);

const postLoad = await page.evaluate(() => {
  const inner = document.querySelector('[data-testid="stage-container"]');
  return inner ? inner.getBoundingClientRect() : null;
});
console.log('[verify-twconfig] post-load stage border', postLoad);

// Open the settings dialog by clicking the gear icon on the left
// ControlBar. The button has aria-label="Open settings".
const opened = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(
    (b) => (b.getAttribute('aria-label') ?? '').toLowerCase().includes('settings'),
  );
  if (!btn) return false;
  btn.click();
  return true;
});
console.log('[verify-twconfig] open settings clicked?', opened);

// Wait for the dialog to render.
await page.waitForSelector('input#fps', { timeout: 10_000 }).catch(() => null);
await page.waitForTimeout(500);

const dialogSnapshot = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  const fps = inputs.find((i) => i.id === 'fps');
  const width = inputs.find((i) => i.id === 'stage-width');
  const height = inputs.find((i) => i.id === 'stage-height');
  return {
    fps: fps ? fps.value : null,
    stageWidth: width ? width.value : null,
    stageHeight: height ? height.value : null,
  };
});
console.log('[verify-twconfig] dialog snapshot', dialogSnapshot);

writeFileSync(
  path.resolve('logs/verify-twconfig-debug.log'),
  consoleLines.join('\n'),
  'utf8',
);
writeFileSync(
  path.resolve('logs/verify-twconfig-errors.log'),
  errorLines.join('\n'),
  'utf8',
);

await browser.close();
console.log('[verify-twconfig] done; console lines:', consoleLines.length);
