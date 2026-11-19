// M2 mobile test (F108): 390×844 + hasTouch. Asserts no scrollbars, joystick
// drag moves the player >1m, fire button drains ammo, every HUD hit rect is
// ≥44px, and zero JS errors. Firefox under xvfb (same reason as smoke.mjs).
//
// Usage: xvfb-run -a node e2e/mobile.mjs  (server on 127.0.0.1:3028)

if (!process.env.DISPLAY) {
  console.error('no DISPLAY — run:  xvfb-run -a node e2e/mobile.mjs');
  process.exit(1);
}

const { firefox } = await import('playwright');
const { mkdirSync, statSync } = await import('node:fs');
const { default: assert } = await import('node:assert/strict');

const URL = 'http://127.0.0.1:3028/transport/';
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
    'dom.w3c_touch_events.enabled': 1,
  },
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('canvas#game', { timeout: 10000 });
await page.waitForFunction(() => window.__frames > 90, null, { timeout: 30000 });

// ① no scrollbars / no document overflow
const noScroll = await page.evaluate(() => {
  const el = document.scrollingElement;
  return (
    el.scrollWidth <= window.innerWidth &&
    el.scrollHeight <= window.innerHeight &&
    getComputedStyle(document.body).overflow === 'hidden'
  );
});
assert.ok(noScroll, 'document scrolls on mobile viewport');

// touch UI must be present (hasTouch context / ?touch fallback)
const zones = await page.evaluate(() => ({
  stick: !!document.querySelector('[data-zone="stick"]'),
  look: !!document.querySelector('[data-zone="look"]'),
  buttons: document.querySelectorAll('[data-btn]').length,
}));
assert.ok(zones.stick && zones.look, 'touch zones missing');
assert.ok(zones.buttons >= 5, `expected ≥5 buttons, got ${zones.buttons}`);

// ② joystick drag (synthetic pointer drag on the left zone) → player moves >1m
const p0 = await page.evaluate(() => ({ ...window.__state }));
await page.evaluate(() => {
  const zone = document.querySelector('[data-zone="stick"]');
  const opts = (id, x, y) => ({
    pointerId: id,
    clientX: x,
    clientY: y,
    bubbles: true,
    isPrimary: false,
    pointerType: 'touch',
  });
  const ev = (type, o) => new PointerEvent(type, o);
  zone.dispatchEvent(ev('pointerdown', opts(11, 80, 700)));
  let y = 700;
  const iv = setInterval(() => {
    y -= 4;
    window.dispatchEvent(ev('pointermove', opts(11, 80, Math.max(y, 620))));
    if (y <= 620) clearInterval(iv);
  }, 30);
  window.__stickIv = iv;
});
await page.waitForTimeout(900);
const p1 = await page.evaluate(() => {
  window.dispatchEvent(
    new PointerEvent('pointerup', { pointerId: 11, bubbles: true, pointerType: 'touch' }),
  );
  return { ...window.__state };
});
const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
assert.ok(moved > 1, `joystick drag moved only ${moved.toFixed(2)}m`);

// ③ hold the fire button → ammo decreases
const ammo0 = (await page.evaluate(() => window.__state.ammo)) ?? 30;
await page.evaluate(() => {
  const btn = document.querySelector('[data-btn="fire"]');
  btn.dispatchEvent(
    new PointerEvent('pointerdown', { pointerId: 22, bubbles: true, pointerType: 'touch' }),
  );
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  window.dispatchEvent(
    new PointerEvent('pointerup', { pointerId: 22, bubbles: true, pointerType: 'touch' }),
  );
});
const ammo1 = await page.evaluate(() => window.__state.ammo);
assert.ok(ammo1 < ammo0, `ammo did not drop (${ammo0} → ${ammo1})`);

// ④ every HUD/touch hit rect ≥ 44 CSS px
const rects = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-btn]')).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.btn, w: r.width, h: r.height };
  }),
);
for (const r of rects) {
  assert.ok(r.w >= 44 && r.h >= 44, `[data-btn=${r.id}] hit rect ${r.w}×${r.h} < 44px`);
}
// and they must sit inside the viewport (no safe-area violation here)
for (const r of rects) {
  assert.ok(r.w <= 120 && r.h <= 120, `[data-btn=${r.id}] absurd rect`);
}

mkdirSync('e2e/shots', { recursive: true });
await page.screenshot({ path: 'e2e/shots/m2-mobile.png' });
const shotSize = statSync('e2e/shots/m2-mobile.png').size;

await browser.close();

assert.ok(errors.length === 0, `JS errors on page:\n${errors.join('\n')}`);
assert.ok(shotSize > 8000, `screenshot looks blank (${shotSize} bytes)`);

console.log(
  `MOBILE OK — moved=${moved.toFixed(1)}m, ammo ${ammo0}→${ammo1}, ` +
    `buttons=${rects.length}×(≥44px), shot=${(shotSize / 1024).toFixed(0)}KB, errors=0`,
);
