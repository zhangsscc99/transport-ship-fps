// Aim-while-firing regression: on touch, holding the fire button must not
// block camera control — the same finger drags the view (mobile-shooter
// standard: the fire key doubles as the look pointer).
// Simulates pointerdown on [data-btn=fire], then 3 pointermove events on the
// same pointerId (+40px x each) and asserts |yaw| changed > 0.05 rad — while
// the held button also drains ammo (fire still works).
// Chromium + SwiftShader, 390×844 portrait, hasTouch. No xvfb needed.
// Usage: node e2e/aim.mjs   (server on 127.0.0.1:3028, or TSF_URL=…)

const { chromium } = await import('playwright');
const { default: assert } = await import('node:assert/strict');
const { mkdirSync } = await import('node:fs');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox', // WSL blocks the chromium sandbox namespaces
];

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  // poll rather than waitForSelector — WebGL init under SwiftShader is slow
  let frames = 0;
  for (let i = 0; i < 40 && frames <= 30; i++) {
    await page.waitForTimeout(1500);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 30, 'page never rendered frames');

  // click 开始游戏 (deepest node whose text matches exactly)
  const started = await page.evaluate(() => {
    let best = null;
    let bestDepth = -1;
    for (const el of document.querySelectorAll('*')) {
      if ((el.textContent ?? '').trim() !== '开始游戏') continue;
      let depth = 0;
      for (let n = el; n.parentElement; n = n.parentElement) depth++;
      if (depth > bestDepth) {
        best = el;
        bestDepth = depth;
      }
    }
    if (!best) return false;
    best.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return true;
  });
  assert.ok(started, 'no 开始游戏 node found');
  await page.waitForFunction(
    () => window.__match?.phase === 'playing' && window.__frames > 90,
    null,
    { timeout: 30000 },
  );

  const yaw0 = await page.evaluate(() => window.__state.yaw);
  const ammo0 = await page.evaluate(() => window.__state.ammo);

  // press-and-hold the fire button (80px round button, bottom-right)
  const btn = await page.evaluate(() => {
    const el = document.querySelector('[data-btn="fire"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 42,
        clientX: cx,
        clientY: cy,
        bubbles: true,
        isPrimary: false,
        pointerType: 'touch',
      }),
    );
    return { x: cx, y: cy };
  });
  assert.ok(btn, 'fire button not found — touch overlay missing?');

  // let a couple of frames run so shots land while we steer
  await page.waitForTimeout(250);

  // 3 pointermove steps, +40px x each, same finger that holds fire
  await page.evaluate((base) => {
    const ev = (x) =>
      new PointerEvent('pointermove', {
        pointerId: 42,
        clientX: x,
        clientY: base.y,
        bubbles: true,
        isPrimary: false,
        pointerType: 'touch',
      });
    window.dispatchEvent(ev(base.x + 40));
    window.dispatchEvent(ev(base.x + 80));
    window.dispatchEvent(ev(base.x + 120));
  }, btn);
  await page.waitForTimeout(350);

  const yaw1 = await page.evaluate(() => window.__state.yaw);
  const ammo1 = await page.evaluate(() => window.__state.ammo);

  // release the hold
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: 42,
        bubbles: true,
        isPrimary: false,
        pointerType: 'touch',
      }),
    );
  });

  const dyaw = Math.abs(yaw1 - yaw0);
  mkdirSync('e2e/shots', { recursive: true });
  await page.screenshot({ path: 'e2e/shots/aim-fire-look.png' });

  assert.ok(dyaw > 0.05, `yaw did not move while firing (${yaw0} → ${yaw1}, Δ=${dyaw})`);
  assert.ok(ammo1 < ammo0, `ammo did not drop while steering (${ammo0} → ${ammo1})`);
  assert.ok(errors.length === 0, `JS errors on page:\n${errors.join('\n')}`);

  console.log(
    `AIM OK — yaw ${yaw0.toFixed(3)} → ${yaw1.toFixed(3)} (Δ=${dyaw.toFixed(3)} rad > 0.05), ` +
      `ammo ${ammo0} → ${ammo1}, errors=0`,
  );
} finally {
  await browser.close();
}
