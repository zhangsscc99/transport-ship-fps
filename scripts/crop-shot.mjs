// Crop helper: loads the page into a match, screenshots, then crops a region
// (default bottom-right where the viewmodel sits) to inspect it up close.
// Usage: node scripts/crop-shot.mjs [x y w h out]   (server on 127.0.0.1:3028)

import { writeFileSync, mkdirSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const [X, Y, W, H, OUT] = [
  Number(process.argv[2] ?? 380),
  Number(process.argv[3] ?? 130),
  Number(process.argv[4] ?? 460),
  Number(process.argv[5] ?? 260),
  process.argv[6] ?? 'e2e/shots/gun-crop.png',
];
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror:', String(e)));
await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1500);
  const frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  if (frames > 30) break;
}
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
await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 30000 });
await page.waitForTimeout(500);

// look up slightly so the gun crosses a bright background
await page.evaluate(() => {
  const zone = document.querySelector('[data-zone="look"]');
  const opts = (x, y) => ({
    pointerId: 33,
    clientX: x,
    clientY: y,
    bubbles: true,
    isPrimary: false,
    pointerType: 'touch',
  });
  const ev = (t, o) => new PointerEvent(t, o);
  zone.dispatchEvent(ev('pointerdown', opts(640, 200)));
  for (let i = 1; i <= 12; i++) {
    window.dispatchEvent(ev('pointermove', opts(640 - i * 10, 200 - i * 8)));
  }
  window.dispatchEvent(ev('pointerup', opts(520, 104)));
});
await page.waitForTimeout(500);

const png = await page.screenshot();
const b64 = await page.evaluate(
  async ([b64png, x, y, w, h]) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = `data:image/png;base64,${b64png}`;
    });
    const c = document.createElement('canvas');
    c.width = w * 2;
    c.height = h * 2;
    const ctx = c.getContext('2d');
    // 2x zoom for readability
    ctx.drawImage(img, x, y, w, h, 0, 0, w * 2, h * 2);
    return c.toDataURL('image/png').split(',')[1];
  },
  [png.toString('base64'), X, Y, W, H],
);
mkdirSync('e2e/shots', { recursive: true });
writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log('wrote', OUT);
await browser.close();
