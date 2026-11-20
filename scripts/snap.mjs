// Iteration screenshot helper: start a match, teleport the camera, optionally
// hold the touch fire button (shot taken while still held — catches flash).
// Usage: node scripts/snap.mjs [name=x,z,yaw,pitch[,fireMs]] ...
//   TSF_URL defaults to the dev server. Shots land in e2e/shots/<name>.png
import { mkdirSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:5174/transport/';
const OUT = process.env.OUT ?? 'e2e/shots';
const VW = Number(process.env.VW ?? 844);
const VH = Number(process.env.VH ?? 390);
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1200);
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
await page.waitForTimeout(800);

for (const spec of process.argv.slice(2)) {
  const [name, rest] = spec.split('=');
  const [x, z, yaw, pitch, fireMs] = rest.split(',').map(Number);
  await page.evaluate(
    ([x, z, yaw, pitch]) => window.__test.teleport(x, z, yaw, pitch),
    [x, z, yaw, pitch],
  );
  await page.waitForTimeout(450);
  if (fireMs) {
    await page.evaluate(() => {
      const el = document.querySelector('[data-btn="fire"]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 44,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
          bubbles: true,
          pointerType: 'touch',
        }),
      );
    });
    await page.waitForTimeout(fireMs);
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 150000 }); // still holding — flash/tracer visible
    await page.evaluate(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 44, bubbles: true, pointerType: 'touch' }),
      );
    });
  } else {
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 150000 });
  }
  console.log(`shot ${name}.png`);
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
