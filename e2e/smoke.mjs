// M1 smoke test: load the deployed build, screenshot, assert render health.
// Usage: node e2e/smoke.mjs  (server must be running on 127.0.0.1:3028)
//
// Chromium's WebGL hangs in this WSL (no working GPU path), so the test runs
// Playwright Firefox with software rendering under xvfb when DISPLAY is unset.

// A display is required: firefox must run headed (headless builds get no GL
// here). Spawning Xvfb from inside this script proved unreliable — the
// browser launch hangs — so we run under xvfb-run instead.
if (!process.env.DISPLAY) {
  console.error('no DISPLAY — run:  xvfb-run -a node e2e/smoke.mjs');
  process.exit(1);
}

const { firefox } = await import('playwright');
const { mkdirSync, statSync } = await import('node:fs');
const { default: assert } = await import('node:assert/strict');

const URL = 'http://127.0.0.1:3028/';
const errors = [];

const browser = await firefox.launch({
  headless: false,
  timeout: 90000,
  firefoxUserPrefs: {
    'webgl.force-enabled': true,
    'webgl.disabled': false,
    'gfx.webrender.software': true,
    'webgl.software-rendering': true,
    'layers.acceleration.disabled': true,
  },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('canvas#game', { timeout: 10000 });
await page.waitForFunction(() => window.__frames > 90, null, { timeout: 30000 });

const fps = await page.evaluate(() => window.__fps);
const canvasBox = await page.locator('canvas#game').boundingBox();
assert.ok(canvasBox && canvasBox.width > 0 && canvasBox.height > 0, 'canvas has no layout box');

mkdirSync('e2e/shots', { recursive: true });
await page.screenshot({ path: 'e2e/shots/m1.png' });
const shotSize = statSync('e2e/shots/m1.png').size;

await browser.close();

assert.ok(errors.length === 0, `JS errors on page:\n${errors.join('\n')}`);
assert.ok(fps > 30, `fps too low: ${fps}`);
// A uniform-color 1280×720 PNG compresses to ~2-5KB; the (intentionally dark)
// rendered scene lands ~14KB. Threshold sits between the two.
assert.ok(shotSize > 8000, `screenshot looks blank (${shotSize} bytes)`);

console.log(`SMOKE OK — fps=${fps.toFixed(1)}, shot=${(shotSize / 1024).toFixed(0)}KB, errors=0`);
