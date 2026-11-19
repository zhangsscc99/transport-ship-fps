// Screenshot helper: drives the deployed build into a match and saves a few
// viewport shots for eyeballing. Uses the touch look zone (hasTouch context)
// so the camera can be aimed without pointer lock.
// Server must run on 127.0.0.1:3028. Usage: node scripts/shoot.mjs [outDir]

import { mkdirSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const OUT = process.argv[2] ?? 'e2e/shots';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const page = await browser.newPage({
  viewport: { width: 844, height: 390 },
  hasTouch: true,
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  if (frames > 30) break;
}

// click 开始游戏
await page.evaluate(() => {
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
  best?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
});
await page.waitForTimeout(2500);

await page.screenshot({ path: `${OUT}/look-spawn.png` });

// Drag on the right-half look zone: dx dy in CSS px (0.35°/px → yaw/pitch).
async function look(dx, dy, name, settle = 600) {
  await page.evaluate(
    ([DX, DY]) => {
      const zone = document.querySelector('[data-zone="look"]');
      if (!zone) return;
      const opts = (x, y) => ({
        pointerId: 33,
        clientX: x,
        clientY: y,
        bubbles: true,
        isPrimary: false,
        pointerType: 'touch',
      });
      const ev = (type, o) => new PointerEvent(type, o);
      const x0 = 640;
      const y0 = 200;
      zone.dispatchEvent(ev('pointerdown', opts(x0, y0)));
      const STEPS = 12;
      for (let i = 1; i <= STEPS; i++) {
        window.dispatchEvent(ev('pointermove', opts(x0 + (DX * i) / STEPS, y0 + (DY * i) / STEPS)));
      }
      window.dispatchEvent(ev('pointerup', opts(x0 + DX, y0 + DY)));
    },
    [dx, dy],
  );
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

await look(360, 0, 'look-toward-sun'); // ~yaw toward the sun azimuth (+x+z)
await look(0, -200, 'look-sky'); // pitch up: cloud deck + aureole
await look(-360, 240, 'look-sea'); // back around + down at the water/foam

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
