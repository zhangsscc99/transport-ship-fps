// Puddle gate (F212b): teleports the camera in front of the deck puddle at
// (-0.5, 8.2), screenshots twice 0.7s apart plus a grazing-angle shot, then
// measures a region around the puddle. The water must animate (frame diff),
// must not be a flat fill (luminance spread), must not collapse into black
// pixels — and now must read as WATER: brighter than the deck around it
// (bright block fraction + block max) with a real sun-glint (region max)
// that stays below the overexposure cap (F212c: no lava-glare relapse).
// Usage: node scripts/puddle-check.mjs   (server must run on 127.0.0.1:3028)

import { mkdirSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const OUT = 'e2e/shots';
const SHOT_TIMEOUT = 150000; // this box runs hot — SwiftShader shots are slow

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

// Region tightened onto the near puddle for F212b: the blob lands at roughly
// x 360–495 / y 190–295 of the 844×390 frame. x0 stays at 0.43 (not lower):
// the drainage grate at (1, 7.5) lands at screen x ≲ 351 with this pose, and
// its stamped slots are luma<12 BY DESIGN — the gate would fail on a dark
// element that has nothing to do with the water. x1/y1 now hug the puddle so
// water covers most of the region — required for the bright-block check to
// mean "the water is brighter than its deck margins".
const REGION = { x0: 0.43, x1: 0.62, y0: 0.5, y1: 0.8 };
const GRID = 16; // puddleMean splits REGION into GRID×GRID blocks
// The HUD crosshair sits at screen centre INSIDE region: its #eef4fa pixels
// (luma 242.9) would be specularMax forever regardless of the water shader.
// Mask that box out so every luma stat measures the scene, not UI chrome.
const CROSSHAIR_MASK = { dx: 28, dy: 15 };

mkdirSync(OUT, { recursive: true });

async function waitFrames(page) {
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

// In-page PNG decode + luma stats over REGION for both shots: frame diff,
// spread, dark fraction, peak luma, and a GRID×GRID block-mean breakdown so
// "water brighter than deck" is judged on areas, not single hot pixels.
async function measure(page, pngA, pngB) {
  return page.evaluate(
    async ([b64a, b64b, reg, grid, mask]) => {
      const load = (b64) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [ia, ib] = await Promise.all([load(b64a), load(b64b)]);
      const w = ia.naturalWidth;
      const h = ia.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const grab = (img) => {
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const A = grab(ia);
      const B = grab(ib);
      const x0 = Math.floor(w * reg.x0);
      const x1 = Math.floor(w * reg.x1);
      const y0 = Math.floor(h * reg.y0);
      const y1 = Math.floor(h * reg.y1);
      const bw = (x1 - x0) / grid;
      const bh = (y1 - y0) / grid;
      const blockSum = new Float64Array(grid * grid);
      const blockN = new Float64Array(grid * grid);
      let n = 0;
      let diffSum = 0;
      let sum = 0;
      let sum2 = 0;
      let dark = 0;
      let max = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (Math.abs(x - w / 2) <= mask.dx && Math.abs(y - h / 2) <= mask.dy) continue;
          const i = (y * w + x) * 4;
          const la = 0.299 * A[i] + 0.587 * A[i + 1] + 0.114 * A[i + 2];
          const lb = 0.299 * B[i] + 0.587 * B[i + 1] + 0.114 * B[i + 2];
          diffSum += Math.abs(la - lb);
          sum += la;
          sum2 += la * la;
          if (la > max) max = la;
          if (la < 12) dark++;
          const bi =
            Math.min(grid - 1, Math.floor((y - y0) / bh)) * grid +
            Math.min(grid - 1, Math.floor((x - x0) / bw));
          blockSum[bi] += la;
          blockN[bi]++;
          n++;
        }
      }
      const mean = sum / n;
      let bright = 0;
      let maxBlock = 0;
      let minBlock = Infinity;
      for (let b = 0; b < grid * grid; b++) {
        const bm = blockSum[b] / blockN[b];
        if (bm > mean) bright++;
        if (bm > maxBlock) maxBlock = bm;
        if (bm < minBlock) minBlock = bm;
      }
      return {
        diff: diffSum / n,
        std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
        darkFrac: dark / n,
        max,
        mean,
        brightBlocks: bright / (grid * grid),
        maxBlock,
        minBlock,
      };
    },
    [pngA.toString('base64'), pngB.toString('base64'), REGION, GRID, CROSSHAIR_MASK],
  );
}

// One full attempt: fresh browser → start match → teleport → two shots → stats.
// The chromium renderer dies sporadically under this box's load (same reason
// measure-look.mjs retries navigation), so the whole flow is restartable.
async function attempt() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
    if (!(await waitFrames(page))) throw new Error('frames never advanced past 30');
    await clickStart(page);

    // stand just short of the (-0.5, 8.2) puddle, look down at it
    await page.evaluate(() => window.__test.teleport(-0.5, 6.0, 180, -35));
    await page.waitForTimeout(1200);
    const pngA = await page.screenshot({ path: `${OUT}/puddle-a.png`, timeout: SHOT_TIMEOUT });
    await page.waitForTimeout(700);
    const pngB = await page.screenshot({ path: `${OUT}/puddle-b.png`, timeout: SHOT_TIMEOUT });

    // grazing view of the same puddle — review only, no assertions on it
    await page.evaluate(() => window.__test.teleport(-0.5, 3.5, 180, -8));
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/puddle-graze.png`, timeout: SHOT_TIMEOUT });

    const stats = await measure(page, pngA, pngB);
    return { stats, errors };
  } finally {
    await browser.close().catch(() => {});
  }
}

let result = null;
for (let i = 0; i < 5 && !result; i++) {
  try {
    result = await attempt();
  } catch (e) {
    console.log(`attempt ${i + 1} failed: ${String(e).split('\n')[0]}`);
  }
}
if (!result) {
  console.log('PUDDLE FAILED — browser never survived a full pass');
  process.exit(1);
}

let ok = result.errors.length === 0;
const checks = [
  ['diff', result.stats.diff, '>', 0.35],
  ['std', result.stats.std, '>', 5],
  ['darkFrac', result.stats.darkFrac, '<', 0.02],
  ['specularMax', result.stats.max, '>=', 120],
  ['specularMax', result.stats.max, '<=', 200],
];
for (const [name, value, op, threshold] of checks) {
  const pass =
    op === '>' ? value > threshold
    : op === '>=' ? value >= threshold
    : op === '<=' ? value <= threshold
    : value < threshold;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(11)} ${value.toFixed(3)}  ${op} ${threshold}`);
}
// puddleMean: ≥35% of the 16×16 block means must sit above the region mean
// (the water area outshining its deck margins) AND the brightest block must
// reach luma 70 — together they prove "water brighter than deck", which a
// per-pixel percentile could fake with a handful of hot pixels.
const puddlePass = result.stats.brightBlocks >= 0.35 && result.stats.maxBlock >= 70;
if (!puddlePass) ok = false;
console.log(
  `${puddlePass ? 'PASS' : 'FAIL'}  puddleMean  brightBlocks=${(result.stats.brightBlocks * 100).toFixed(1)}% >= 35%` +
    `  maxBlock=${result.stats.maxBlock.toFixed(1)} >= 70` +
    `  (regionMean=${result.stats.mean.toFixed(1)} minBlock=${result.stats.minBlock.toFixed(1)})`,
);
for (const e of result.errors) console.log(`PAGE ERROR: ${e}`);
console.log(ok ? 'PUDDLE OK' : 'PUDDLE FAILED');
process.exit(ok ? 0 : 1);
