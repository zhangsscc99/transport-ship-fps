// Dark-block gate (F211): screenshots the deployed build at two aspect ratios
// and three camera poses, then counts 4-connected pixel blobs with luma < 12.
// Any blob > MAX_BLOB px is a "dead black mass" — the bug class where props /
// the viewmodel collapse to featureless black. Fails the build on regression.
// Usage: node scripts/dark-block.mjs   (server must run on 127.0.0.1:3028)

import { mkdirSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const OUT = 'e2e/shots';
const MAX_BLOB = 1200;
const SHOT_TIMEOUT = 150000; // this box runs hot — SwiftShader shots are slow

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

const VIEWPORTS = [
  { name: 'land', width: 844, height: 390 },
  { name: 'port', width: 390, height: 844 },
];

mkdirSync(OUT, { recursive: true });

async function startMatch(page) {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500);
    const frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
    if (frames > 30) return true;
  }
  return false;
}

async function clickStart(page) {
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
  if (!started) throw new Error('could not find a "开始游戏" node to click');
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 60000 });
}

// Touch-look drag on [data-zone="look"], then wait until the player state
// actually reflects it (frames lag on SwiftShader — poll, retry once).
async function look(page, dx, dy) {
  const before = await page.evaluate(() => ({ yaw: window.__state.yaw, pitch: window.__state.pitch }));
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(
      ([DX, DY]) => {
        const zone = document.querySelector('[data-zone="look"]');
        if (!zone) return;
        const rect = zone.getBoundingClientRect();
        const x0 = rect.x + rect.width * 0.5;
        const y0 = rect.y + rect.height * 0.4;
        const opts = (x, y) => ({
          pointerId: 33,
          clientX: x,
          clientY: y,
          bubbles: true,
          isPrimary: false,
          pointerType: 'touch',
        });
        const ev = (type, o) => new PointerEvent(type, o);
        zone.dispatchEvent(ev('pointerdown', opts(x0, y0)));
        const STEPS = 12;
        for (let i = 1; i <= STEPS; i++) {
          window.dispatchEvent(ev('pointermove', opts(x0 + (DX * i) / STEPS, y0 + (DY * i) / STEPS)));
        }
        window.dispatchEvent(ev('pointerup', opts(x0 + DX, y0 + DY)));
      },
      [dx, dy],
    );
    try {
      await page.waitForFunction(
        (b) =>
          Math.abs(window.__state.yaw - b.yaw) > 0.02 ||
          Math.abs(window.__state.pitch - b.pitch) > 0.02,
        before,
        { timeout: 8000 },
      );
      return;
    } catch {
      // drag dropped — retry with a fresh pointer
    }
  }
  throw new Error(`look(${dx},${dy}) never landed`);
}

// In-page PNG decode + 4-connected components over luma<12.
async function largestDarkBlob(page, pngB64) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = `data:image/png;base64,${b64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = width * height;
    const dark = new Uint8Array(n);
    let darkCount = 0;
    for (let i = 0; i < n; i++) {
      const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      if (l < 12) {
        dark[i] = 1;
        darkCount++;
      }
    }
    // BFS over 4-neighbourhood; track the biggest component's bbox
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let max = { size: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
    let blobs = 0;
    for (let s = 0; s < n; s++) {
      if (!dark[s] || seen[s]) continue;
      blobs++;
      let top = 0;
      stack[top++] = s;
      seen[s] = 1;
      let size = 0;
      let x0 = width;
      let y0 = height;
      let x1 = 0;
      let y1 = 0;
      while (top) {
        const i = stack[--top];
        size++;
        const x = i % width;
        const y = (i / width) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x > 0 && dark[i - 1] && !seen[i - 1]) {
          seen[i - 1] = 1;
          stack[top++] = i - 1;
        }
        if (x < width - 1 && dark[i + 1] && !seen[i + 1]) {
          seen[i + 1] = 1;
          stack[top++] = i + 1;
        }
        if (y > 0 && dark[i - width] && !seen[i - width]) {
          seen[i - width] = 1;
          stack[top++] = i - width;
        }
        if (y < height - 1 && dark[i + width] && !seen[i + width]) {
          seen[i + width] = 1;
          stack[top++] = i + width;
        }
      }
      if (size > max.size) max = { size, x0, y0, x1, y1 };
    }
    return { darkCount, blobs, max };
  }, pngB64);
}

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
let ok = true;

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  if (!(await startMatch(page))) {
    console.log(`FAIL  ${vp.name} — frames never advanced`);
    ok = false;
    await context.close();
    continue;
  }
  await clickStart(page);
  await page.waitForTimeout(800);

  const poses = [
    ['spawn', 0, 0],
    ['down', 0, 240],
    ['downleft', -260, 0],
  ];
  for (const [pose, dx, dy] of poses) {
    if (dx || dy) await look(page, dx, dy);
    await page.waitForTimeout(400);
    const file = `${OUT}/dark-${vp.name}-${pose}.png`;
    const png = await page.screenshot({ path: file, timeout: SHOT_TIMEOUT });
    const r = await largestDarkBlob(page, png.toString('base64'));
    const pass = r.max.size <= MAX_BLOB;
    if (!pass) ok = false;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${vp.name}/${pose.padEnd(8)} ` +
        `maxBlob=${r.max.size}px` +
        (r.max.size ? ` bbox x${r.max.x0}..${r.max.x1} y${r.max.y0}..${r.max.y1}` : '') +
        ` darkTotal=${r.darkCount} blobs=${r.blobs}  → ${file}`,
    );
  }
  for (const e of errors) console.log(`PAGE ERROR: ${e}`);
  if (errors.length) ok = false;
  await context.close();
}

await browser.close();
console.log(ok ? 'DARK-BLOCK OK' : 'DARK-BLOCK FAILED');
process.exit(ok ? 0 : 1);
