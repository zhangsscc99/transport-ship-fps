// M2 smoke test: load the deployed build, hold mouse1 to fire, screenshot,
// assert render health + combat loop (ammo drops), zero JS errors.
// Usage: node e2e/smoke.mjs  (server must be running on 127.0.0.1:3028)
//
// Chromium's WebGL hangs in this WSL (no working GPU path), so the test runs
// Playwright Firefox with software rendering under xvfb when DISPLAY is unset.
// A display is required: firefox must run headed (headless builds get no GL
// here) — we run under xvfb-run instead.
if (!process.env.DISPLAY) {
  console.error('no DISPLAY — run:  xvfb-run -a node e2e/smoke.mjs');
  process.exit(1);
}

const { firefox } = await import('playwright');
const { mkdirSync, statSync } = await import('node:fs');
const { default: assert } = await import('node:assert/strict');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const errors = [];

const browser = await firefox.launch({
  headless: false,
  timeout: 90000,
  // WSL2 blocks firefox's sandbox namespaces — the browser hangs at startup
  // without these. (See: MOZ sandbox + unprivileged userns.)
  env: {
    ...process.env,
    MOZ_DISABLE_CONTENT_SANDBOX: '1',
    MOZ_DISABLE_GMP_SANDBOX: '1',
    MOZ_DISABLE_RDD_SANDBOX: '1',
    MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: '1',
  },
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
await page.waitForFunction(() => window.__match, null, { timeout: 10000 });

// drive to playing: poll-click the menu start button, then wait out the countdown
for (let i = 0; i < 10; i++) {
  const phase = await page.evaluate(() => window.__match.phase);
  if (phase !== 'menu') break;
  await page.click('[data-btn="start"]').catch(() => {});
  await page.waitForTimeout(200);
}
await page.waitForFunction(
  () => window.__match.phase === 'playing' && window.__frames > 90,
  null,
  { timeout: 30000 },
);

const fps = await page.evaluate(() => window.__fps);
const canvasBox = await page.locator('canvas#game').boundingBox();
assert.ok(canvasBox && canvasBox.width > 0 && canvasBox.height > 0, 'canvas has no layout box');

// combat loop: hold LMB → the rifle fires and the mag drains
const ammo0 = await page.evaluate(() => window.__state?.ammo ?? 30);
await page.mouse.move(640, 360);
await page.mouse.down();
await page.waitForTimeout(400);
await page.mouse.up();
const ammo1 = await page.evaluate(() => window.__state.ammo);
assert.ok(ammo1 < ammo0, `ammo did not drop on desktop fire (${ammo0} → ${ammo1})`);

mkdirSync('e2e/shots', { recursive: true });
await page.screenshot({ path: 'e2e/shots/m2-desktop.png' });
const shotSize = statSync('e2e/shots/m2-desktop.png').size;

await browser.close();

assert.ok(errors.length === 0, `JS errors on page:\n${errors.join('\n')}`);
assert.ok(fps > 30, `fps too low: ${fps}`);
assert.ok(shotSize > 8000, `screenshot looks blank (${shotSize} bytes)`);

console.log(
  `SMOKE OK — fps=${fps.toFixed(1)}, ammo ${ammo0}→${ammo1}, shot=${(shotSize / 1024).toFixed(0)}KB, errors=0`,
);
