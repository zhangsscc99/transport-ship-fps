// Weapon-viewmodel screenshot helper: starts a match, pitches the camera down
// ~25° so the gun sits against the sunlit deck, then captures each of the
// three weapons + a firing pose. Chromium + SwiftShader, no xvfb.
// Usage: node scripts/shot-weapon.mjs [outDir]   (server on 127.0.0.1:3028)

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
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
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

// touch-look drag: dy>0 pitches the camera down (y toward the deck)
async function look(dx, dy) {
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
      const ev = (t, o) => new PointerEvent(t, o);
      const x0 = 640;
      const y0 = 150;
      zone.dispatchEvent(ev('pointerdown', opts(x0, y0)));
      for (let i = 1; i <= 12; i++) {
        window.dispatchEvent(ev('pointermove', opts(x0 + (DX * i) / 12, y0 + (DY * i) / 12)));
      }
      window.dispatchEvent(ev('pointerup', opts(x0 + DX, y0 + DY)));
    },
    [dx, dy],
  );
  await page.waitForTimeout(400);
}

await look(0, 260); // pitch down ~1.5 rad clamped to deck view
await look(150, 0); // slight yaw for a 3/4 view of the scene

const names = ['rifle', 'sniper', 'shotgun'];
for (let i = 0; i < names.length; i++) {
  await page.screenshot({ path: `${OUT}/gun-${names[i]}.png` });
  // tap the touch 切枪 button to swap
  await page.evaluate(() => {
    document
      .querySelector('[data-btn="swap"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  });
  await page.waitForTimeout(350);
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
