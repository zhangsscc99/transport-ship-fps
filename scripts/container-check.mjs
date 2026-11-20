// Container gate (F213h): teleports the camera in front of several containers,
// reads the WebGL canvas pixels in-page (no page.screenshot — that encode kept
// timing out at 100-150s on this loaded box), and asserts that
//   distinct — adjacent container blocks differ in mean colour/luma (no more
//             "every box is the same tile"),
//   ribFreq  — corrugation ribs alternate along a long face (tiles repeat by
//             physical size, not stretched to fit),
//   dark     — no dead-black mass crept in with the rust.
// rustFrac is REPORTED ONLY — no longer a gate (F213g). Measured evidence:
//   - Criterion A (current: R>G>B && R-B>=26 && 30<=luma<=150 && darker than
//     its grid block mean) scored 0.0459 on a shot where the face visibly
//     reads as rust/dirt — a uniformly rusty block has no "darker pixel",
//     so the more even the rust the lower the score. It measures contrast.
//   - Criterion B (dropping "darker than block mean") scored 0.9903 on the
//     red face and 0.8406 on the green one — red paint itself satisfies
//     R>G>B && R-B>=26, so it degenerates into "count the paint".
// Container base colour is per-instance, so no colour predicate separates
// rust from paint; the value is background info, not a threshold.
// Usage: node scripts/container-check.mjs   (server must run on 127.0.0.1:3028)

import { mkdirSync, writeFileSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const OUT = 'e2e/shots';
const W = 1280;
const H = 720;
const SHOT_TIMEOUT = 30000; // fallback only — shots normally come from toDataURL

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

// Stand on the A-side spawn apron looking down-deck: the (-12,11) red and
// (-4,11) green containers fill the mid-frame ~7 m out, the crate staircase
// sits in front of them, and the (-16,2) blue box plus mid-map boxes sit
// behind — four+ container surfaces in one frame.
const POSE = { x: -8, z: 16.6, yaw: 0, pitch: -4 };
const REGION = { x0: 0.04, x1: 0.96, y0: 0.3, y1: 0.92 };
// rustFrac is measured inside FACE — a tight crop on ONE container skin, the
// (-12,11) red box's front face (measured on container-main.png: the face
// spans ~x 0–570, y 220–510 px at 1280x720; this crop keeps ~60 px inside
// the corner post and above the deck line). The old whole-REGION scope
// diluted the box area ~4-5x with deck/sky/props, so "20% of the skin is
// rusty" read as ~4% of frame — this is a per-face metric, not per-frame.
const FACE = { x0: 0.05, x1: 0.4, y0: 0.36, y1: 0.66 };
const GRID = 12; // REGION split into GRID x GRID blocks for the distinct check
// The HUD crosshair sits at screen centre — mask it so every stat measures
// the scene, not UI chrome.
const CROSSHAIR_MASK = { dx: 30, dy: 18 };

mkdirSync(OUT, { recursive: true });

// The menu starts rendering inside a couple of seconds, but on this loaded
// box SwiftShader then spends ~a minute finishing program compiles — so we
// only require the counter to move at all, then drive frames explicitly with
// requestAnimationFrame (each resolves once the renderer has drawn a frame).
async function waitFrames(page) {
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1500);
    const frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
    if (frames > 15) return true;
  }
  return false;
}

// Wait until the renderer has drawn `n` more rAF frames — the camera pose set
// by __test.teleport applies on the next drawn frame, so this also settles it.
async function drawFrames(page, n) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
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

// Read the WebGL canvas inside a rAF queued after the game's own render — the
// drawing buffer is still live there even with preserveDrawingBuffer=false —
// run all pixel stats over REGION in the same pass, and return a PNG data URL
// for the saved shot. No page.screenshot: the PNG encode kept timing out at
// 100-150s on this loaded box. Resolves null if no canvas is readable.
function grabStats(page) {
  return page.evaluate(
    ([reg, face, grid, mask]) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const glc = document.querySelector('canvas');
          if (!glc || !glc.width || !glc.height) return resolve(null);
          const w = glc.width;
          const h = glc.height;
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(glc, 0, 0);
          const data = ctx.getImageData(0, 0, w, h).data;

      const x0 = Math.floor(w * reg.x0);
      const x1 = Math.floor(w * reg.x1);
      const y0 = Math.floor(h * reg.y0);
      const y1 = Math.floor(h * reg.y1);
      const fx0 = Math.floor(w * face.x0);
      const fx1 = Math.floor(w * face.x1);
      const fy0 = Math.floor(h * face.y0);
      const fy1 = Math.floor(h * face.y1);
      const inMask = (x, y) => Math.abs(x - w / 2) <= mask.dx && Math.abs(y - h / 2) <= mask.dy;
      const lumaAt = (x, y) => {
        const i = (y * w + x) * 4;
        return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      };

      // --- per-block mean rgb + luma (adjacent-block distinctness) ---
      const bw = (x1 - x0) / grid;
      const bh = (y1 - y0) / grid;
      const blkR = new Float64Array(grid * grid);
      const blkG = new Float64Array(grid * grid);
      const blkB = new Float64Array(grid * grid);
      const blkL = new Float64Array(grid * grid);
      const blkN = new Float64Array(grid * grid);
      let rust = 0;
      let dark = 0;
      let n = 0;
      // pass 1: per-block means only — rust is judged against them below
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (inMask(x, y)) continue;
          const i = (y * w + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          const bi =
            Math.min(grid - 1, Math.floor((y - y0) / bh)) * grid +
            Math.min(grid - 1, Math.floor((x - x0) / bw));
          blkR[bi] += r;
          blkG[bi] += g;
          blkB[bi] += b;
          blkL[bi] += l;
          blkN[bi]++;
          n++;
        }
      }
      for (let b = 0; b < grid * grid; b++) {
        if (blkN[b] === 0) continue;
        blkR[b] /= blkN[b];
        blkG[b] /= blkN[b];
        blkB[b] /= blkN[b];
        blkL[b] /= blkN[b];
      }
      // pass 2: a "rust" pixel is warm-hued AND darker than its block's mean
      // luma — the rust-red paint of a whole container face no longer counts,
      // only staining/marks that sit on top of the paint.
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (inMask(x, y)) continue;
          const i = (y * w + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const l = 0.299 * r + 0.587 * g + 0.114 * b;
          const bi =
            Math.min(grid - 1, Math.floor((y - y0) / bh)) * grid +
            Math.min(grid - 1, Math.floor((x - x0) / bw));
          if (
            x >= fx0 &&
            x < fx1 &&
            y >= fy0 &&
            y < fy1 &&
            r > g &&
            g > b &&
            r - b >= 26 &&
            l >= 30 &&
            l <= 150 &&
            l < blkL[bi] - 5
          )
            rust++;
          if (l < 12) dark++;
        }
      }
      // adjacent (4-neighbour) block pairs whose mean colour or brightness
      // clearly differ — ≥4 luma, or an rgb distance of ≥8 grey steps
      let distinctPairs = 0;
      let maxPairDist = 0;
      for (let gy = 0; gy < grid; gy++) {
        for (let gx = 0; gx < grid; gx++) {
          const a = gy * grid + gx;
          if (blkN[a] === 0) continue;
          for (const [nx, ny] of [
            [gx + 1, gy],
            [gx, gy + 1],
          ]) {
            if (nx >= grid || ny >= grid) continue;
            const b2 = ny * grid + nx;
            if (blkN[b2] === 0) continue;
            const dl = Math.abs(blkL[a] - blkL[b2]);
            const dr = blkR[a] - blkR[b2];
            const dg = blkG[a] - blkG[b2];
            const db = blkB[a] - blkB[b2];
            const rgbDist = Math.hypot(dr, dg, db);
            if (rgbDist > maxPairDist) maxPairDist = rgbDist;
            if (dl >= 4 || rgbDist >= 8) distinctPairs++;
          }
        }
      }

      // --- rib alternation: horizontal scanlines through the long faces ---
      // count sign transitions of (luma - rowMean) past a +/-delta hysteresis;
      // corrugation ribs give a regular bright/dark beat.
      let ribMax = 0;
      let ribRow = -1;
      for (const fy of [0.3, 0.42, 0.55, 0.68, 0.8]) {
        const y = Math.floor(y0 + (y1 - y0) * fy);
        let sum = 0;
        for (let x = x0; x < x1; x++) sum += lumaAt(x, y);
        const mean = sum / (x1 - x0);
        const delta = 2.5;
        let state = 0;
        let runs = 0;
        let last = mean;
        for (let x = x0; x < x1; x++) {
          // crosshair px carry the last luma so UI chrome can't fake a beat
          const l = inMask(x, y) ? last : lumaAt(x, y);
          last = l;
          const s = l > mean + delta ? 1 : l < mean - delta ? -1 : state;
          if (s !== 0 && s !== state) {
            runs++;
            state = s;
          }
        }
        if (runs > ribMax) {
          ribMax = runs;
          ribRow = fy;
        }
      }

      const facePx = (fx1 - fx0) * (fy1 - fy0);
      resolve({
        stats: {
          rustFrac: rust / facePx, // face-scope: share of the box skin, not of frame
          darkFrac: dark / n,
          distinctPairs,
          maxPairDist,
          ribMax,
          ribRow,
          px: n,
        },
        png: c.toDataURL('image/png'),
      });
        });
      }),
    [REGION, FACE, GRID, CROSSHAIR_MASK],
  );
}

// Same in-page canvas grab, pixels only as a PNG data URL — for the
// review-only close-up shot. Resolves null if no canvas is readable.
function grabPng(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const glc = document.querySelector('canvas');
          if (!glc || !glc.width || !glc.height) return resolve(null);
          const c = document.createElement('canvas');
          c.width = glc.width;
          c.height = glc.height;
          c.getContext('2d').drawImage(glc, 0, 0);
          resolve(c.toDataURL('image/png'));
        });
      }),
  );
}

function saveDataUrl(dataUrl, path) {
  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

// One full attempt — the chromium renderer dies sporadically under this
// box's load (same reason measure-look.mjs retries navigation).
async function attempt() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
    if (!(await waitFrames(page))) throw new Error('frames never advanced past 15');
    await clickStart(page);

    await page.evaluate(
      (p) => window.__test.teleport(p.x, p.z, p.yaw, p.pitch),
      POSE,
    );
    await drawFrames(page, 2);
    const shot = await grabStats(page);
    if (!shot) throw new Error('no readable WebGL canvas in page');
    if (shot.png) {
      saveDataUrl(shot.png, `${OUT}/container-main.png`);
    } else {
      // canvas encode failed — last-resort screenshot, but never block the gate
      await page
        .screenshot({ path: `${OUT}/container-main.png`, timeout: SHOT_TIMEOUT })
        .catch(() => {});
    }

    // a second, closer look at one long face — review only, no assertions
    await page.evaluate(() => window.__test.teleport(-4, 14.2, 0, -6));
    await drawFrames(page, 2);
    const closePng = await grabPng(page);
    if (closePng) saveDataUrl(closePng, `${OUT}/container-close.png`);

    return { stats: shot.stats, errors };
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
  console.log('CONTAINER FAILED — browser never survived a full pass');
  process.exit(1);
}

const s = result.stats;
let ok = result.errors.length === 0;
const checks = [
  ['distinct', s.distinctPairs, '>=', 3],
  ['ribFreq', s.ribMax, '>=', 8],
  ['dark', s.darkFrac, '<=', 0.02],
];
for (const [name, value, op, threshold] of checks) {
  const pass = op === '>=' ? value >= threshold : value <= threshold;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(8)} ${value.toFixed(4)}  ${op} ${threshold}`);
}
for (const e of result.errors) console.log(`PAGE ERROR: ${e}`);
console.log(
  ok
    ? `CONTAINER-CHECK OK distinct=${s.distinctPairs} rustFrac=${s.rustFrac.toFixed(4)} ` +
        `ribFreq=${s.ribMax} dark=${s.darkFrac.toFixed(4)}`
    : `CONTAINER-CHECK FAILED distinct=${s.distinctPairs} rustFrac=${s.rustFrac.toFixed(4)} ` +
        `ribFreq=${s.ribMax} dark=${s.darkFrac.toFixed(4)}`,
);
process.exit(ok ? 0 : 1);
