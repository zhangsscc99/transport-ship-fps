// Enemy & Boss Silhouette Contrast Gate (portrait 390×844):
//   Probe distance ranges (selected dynamically by enemy height / body radius):
//     - Small enemies / robots (height < 3.0m, radius < 0.55m): 8–15m
//     - Boss (height >= 3.0m or radius >= 0.55m):               14–22m
//
//   Protocol:
//   1. Starts a real match at 390×844 portrait and positions at an unobstructed open-deck
//      vantage inside the height-appropriate distance range (14–22m for 4m Boss; 8–15m for mobs).
//   2. Performs exact same-frame A/B capture via CDP Page.captureScreenshot:
//        - Frame A: paused with target visible=true
//        - Frame B: exact same paused frame with target visible=false (zero clock/sim advance)
//      Diff region (max RGB channel diff >= 8) = true rendered silhouette.
//   3. Visibility pre-assertion (mandatory before evaluating contrast):
//        - On-screen bounding box must be non-empty (clipped area > 0) AND
//        - A/B hide diff must change > 500 pixels (both global and within target box).
//      Otherwise exits non-zero and prints:
//        `GATE INVALID: boss occluded or setVisible ineffective`
//   4. Contrast & exposure assertions (thresholds never relaxed):
//        - Non-enemy region coverage >= 0.50, meanDiff <= 0.25, changedFrac <= 0.002
//        - |meanLuma(silhouette) - meanLuma(12px outer ring)| >= 14 luma
//        - median|Δluma| (|median(sil) - median(ring)| & cross-probe median) >= 14 luma
//        - stdLuma(silhouette) >= 6 luma (volumetric shading, not a flat dark block)
//        - silP99Luma <= 205 luma (no overexposed / washed-out bone or skin)
//        - hotFrac <= 0.06 (silhouette fraction with max(R,G,B) >= 235 && (max-min) >= 55)
//   5. Captures 3 required 390×844 portrait Boss screenshots to e2e/shots/:
//        - e2e/shots/boss-standoff-17m.png  (15–20m unobstructed standoff)
//        - e2e/shots/boss-charge.png        (Boss charge rush in open corridor)
//        - e2e/shots/boss-melee-hit.png     (Boss melee slash landing hit on player)
//
// Exits non-zero on any failure.
// Usage: node scripts/enemy-contrast.mjs
//   - Respects TSF_URL if set (e.g. TSF_URL=http://127.0.0.1:3028/transport/).
//   - Otherwise serves local ./dist on an ephemeral 127.0.0.1:0 server when present,
//     falling back to http://127.0.0.1:3028/transport/.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOCAL_DIST = path.join(REPO_ROOT, 'dist');
const SHOTS_DIR = process.env.SHOTS_DIR ?? 'e2e/shots';
mkdirSync(SHOTS_DIR, { recursive: true });

const VIEWPORT = { width: 390, height: 844 };

// Height-based probe distance ranges (documented in file header):
const SMALL_ENEMY_RANGE = [8.0, 15.0]; // small enemies (< 3.0m tall)
const BOSS_ENEMY_RANGE = [14.0, 22.0]; // Boss (>= 3.0m tall)
const BOSS_HEIGHT_THRESH = 3.0;
const BOSS_RADIUS_THRESH = 0.55;

// Strict visibility & contrast thresholds (NEVER relax):
const MIN_AB_CHANGED_PX = 500;
const MIN_DELTA_LUMA = 14;
const MIN_SIL_STD = 6;
const MAX_SIL_P99_LUMA = 205;
const MAX_HOT_FRAC = 0.06;
const HOT_MAX_RGB = 235;
const HOT_MIN_CHROMA = 55;
const RING_RADIUS_PX = 12;
const DIFF_THRESH = 8; // RGB max-channel diff defining enemy silhouette pixels
const MAX_NON_ENEMY_MEAN_DIFF = 0.25;
const MAX_NON_ENEMY_CHANGED_FRAC = 0.002;

// Generous frame/navigation waits for loaded hosts (~0.5–1fps SwiftShader)
const FRAME_WAIT_TIMEOUT_MS = 240000;
const MATCH_PLAY_TIMEOUT_MS = 240000;

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

const T0 = Date.now();
const log = (msg) => console.error(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

function isBossTarget(enemy) {
  const h = Number(enemy?.height ?? 0);
  const r = Number(enemy?.radius ?? 0);
  return h >= BOSS_HEIGHT_THRESH || r >= BOSS_RADIUS_THRESH || enemy?.id === 'boss';
}

function probeRangeForEnemy(enemy) {
  return isBossTarget(enemy) ? BOSS_ENEMY_RANGE : SMALL_ENEMY_RANGE;
}

function medianOf(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) * 0.5;
}

/**
 * Resolve target URL:
 *   1. If TSF_URL is set, use it directly.
 *   2. Else if local ./dist/index.html exists, start an ephemeral 127.0.0.1:0 static server.
 *   3. Else fall back to http://127.0.0.1:3028/transport/.
 */
async function resolveTargetUrl() {
  if (process.env.TSF_URL) {
    return { url: process.env.TSF_URL, close: async () => {} };
  }
  const indexHtml = path.join(LOCAL_DIST, 'index.html');
  if (!existsSync(indexHtml)) {
    return { url: 'http://127.0.0.1:3028/transport/', close: async () => {} };
  }
  const server = http.createServer((req, res) => {
    const rawUrl = (req.url || '/').split('?')[0];
    let rel = rawUrl;
    if (rel === '/' || rel === '/transport') {
      res.writeHead(302, { Location: '/transport/' });
      return res.end();
    }
    if (rel.startsWith('/transport/')) {
      rel = rel.slice('/transport'.length);
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    let decoded;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      res.writeHead(400);
      return res.end('bad request');
    }
    const file = path.normalize(path.join(LOCAL_DIST, decoded));
    if (!file.startsWith(LOCAL_DIST + path.sep) && file !== indexHtml) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
    if (!st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/transport/`;
  log(`serving local dist/ at ${url}`);
  return {
    url,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function waitFrames(page, count = 2, timeout = FRAME_WAIT_TIMEOUT_MS) {
  const f0 = await page.evaluate(() => window.__frames ?? 0);
  await page.waitForFunction((target) => (window.__frames ?? 0) >= target, f0 + count, { timeout });
}

async function captureCdpPng(cdp, outPath = null) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  if (outPath) {
    writeFileSync(outPath, buf);
    const sz = statSync(outPath).size;
    assert.ok(sz > 8000, `screenshot ${outPath} looks blank (${sz} bytes)`);
    log(`saved ${outPath} (${(sz / 1024).toFixed(1)} KB)`);
  }
  return { b64: data, buf };
}

/** Flush a paused WebGL visibility toggle cleanly through Chromium's compositor before CDP capture. */
async function renderPausedVisibility(page, visible) {
  await page.evaluate(
    (vis) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          window.__test.setEnemiesVisible(vis);
          requestAnimationFrame(() => {
            setTimeout(() => resolve(true), 80);
          });
        });
      }),
    visible,
  );
}

/**
 * Capture exact same-frame A (visible=true) and B (visible=false) via CDP and analyze:
 *   - Mandatory visibility pre-assertion: non-empty on-screen bbox AND changedPx > 500
 *     (otherwise prints `GATE INVALID: boss occluded or setVisible ineffective` and fails)
 *   - Non-enemy region diff (must be ≈ 0)
 *   - Per-enemy silhouette + 12px outer ring contrast & exposure bounds
 */
async function measureSceneAB(page, cdp, label, savePath = null, opts = {}) {
  const { explicitDistRange = null, visibilityOnly = false } = opts;
  await page.evaluate(() => window.__test.setPaused(true));
  await page.waitForTimeout(240); // let HUD transitions settle before A/B
  const bounds = await page.evaluate(() => window.__test.getEnemyScreenBounds());

  const activeRange =
    explicitDistRange ??
    (bounds.length > 0 ? probeRangeForEnemy(bounds[0]) : BOSS_ENEMY_RANGE);

  await renderPausedVisibility(page, true);
  const shotA = await captureCdpPng(cdp, savePath);

  await renderPausedVisibility(page, false);
  const shotB = await captureCdpPng(cdp, null);

  await renderPausedVisibility(page, true);

  const metrics = await page.evaluate(
    async ({ b64A, b64B, enemyBounds, ringR, diffThresh, distMin, distMax, hotMaxRgb, hotMinChroma, skipDistFilter }) => {
      const decode = async (b64) => {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = `data:image/png;base64,${b64}`;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };

      const median = (sorted) => {
        const n = sorted.length;
        if (n === 0) return 0;
        const m = n >> 1;
        return n % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) * 0.5;
      };

      const imgA = await decode(b64A);
      const imgB = await decode(b64B);
      const W = imgA.width;
      const H = imgA.height;
      const dA = imgA.data;
      const dB = imgB.data;
      const N = W * H;

      const lumaA = new Float32Array(N);
      const lumaB = new Float32Array(N);
      const diffMax = new Uint8Array(N);
      const globalSil = new Uint8Array(N);

      let sumA = 0;
      let sumB = 0;
      let globalDiffPx = 0;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const rA = dA[o], gA = dA[o + 1], bA = dA[o + 2];
        const rB = dB[o], gB = dB[o + 1], bB = dB[o + 2];
        const la = 0.299 * rA + 0.587 * gA + 0.114 * bA;
        const lb = 0.299 * rB + 0.587 * gB + 0.114 * bB;
        lumaA[i] = la;
        lumaB[i] = lb;
        sumA += la;
        sumB += lb;
        const dm = Math.max(Math.abs(rA - rB), Math.abs(gA - gB), Math.abs(bA - bB));
        diffMax[i] = dm;
        if (dm >= diffThresh) {
          globalSil[i] = 1;
          globalDiffPx++;
        }
      }

      // 1. Non-enemy region diff check: exclude generous padded boxes around all on-screen enemies
      const excluded = new Uint8Array(N);
      for (const eb of enemyBounds) {
        if (!eb.onScreen) continue;
        const padX = 52;
        const padTop = 36;
        const padBot = 78;
        const x0 = Math.max(0, Math.floor(eb.x0 - padX));
        const x1 = Math.min(W - 1, Math.ceil(eb.x1 + padX));
        const y0 = Math.max(0, Math.floor(eb.y0 - padTop));
        const y1 = Math.min(H - 1, Math.ceil(eb.y1 + padBot));
        for (let y = y0; y <= y1; y++) {
          const row = y * W;
          for (let x = x0; x <= x1; x++) excluded[row + x] = 1;
        }
      }

      let nonEnemyPx = 0;
      let nonEnemyDiffSum = 0;
      let nonEnemyChanged = 0;
      let nonEnemyMaxDiff = 0;
      let chX0 = W, chY0 = H, chX1 = -1, chY1 = -1;
      for (let i = 0; i < N; i++) {
        if (excluded[i]) continue;
        nonEnemyPx++;
        const dm = diffMax[i];
        nonEnemyDiffSum += dm;
        if (dm > 2) {
          nonEnemyChanged++;
          const x = i % W;
          const y = (i / W) | 0;
          if (x < chX0) chX0 = x;
          if (x > chX1) chX1 = x;
          if (y < chY0) chY0 = y;
          if (y > chY1) chY1 = y;
        }
        if (dm > nonEnemyMaxDiff) nonEnemyMaxDiff = dm;
      }

      // Precompute circular kernel offsets for 12px outer ring dilation
      const ringOffsets = [];
      for (let dy = -ringR; dy <= ringR; dy++) {
        for (let dx = -ringR; dx <= ringR; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (dx * dx + dy * dy <= ringR * ringR) ringOffsets.push([dx, dy]);
        }
      }

      // 2. Per-enemy silhouette + 12px outer ring contrast metrics
      const enemies = [];
      for (const eb of enemyBounds) {
        if (!eb.onScreen) continue;
        if (!skipDistFilter && (eb.dist < distMin || eb.dist > distMax)) continue;

        const clipX0 = Math.max(0, Math.floor(eb.x0));
        const clipX1 = Math.min(W - 1, Math.ceil(eb.x1));
        const clipY0 = Math.max(0, Math.floor(eb.y0));
        const clipY1 = Math.min(H - 1, Math.ceil(eb.y1));
        const bboxNonEmpty = clipX1 > clipX0 && clipY1 > clipY0;

        // Crop around enemy chassis (+10px left/right/top, +2px bottom to exclude deck shadow)
        const bx0 = Math.max(0, Math.floor(eb.x0 - 10));
        const bx1 = Math.min(W - 1, Math.ceil(eb.x1 + 10));
        const by0 = Math.max(0, Math.floor(eb.y0 - 10));
        const by1 = Math.min(H - 1, Math.ceil(eb.y1 + 2));

        const silCoords = [];
        const silLumas = [];
        const localSil = new Uint8Array(N);
        let silSum = 0;
        let silSqSum = 0;
        let hotPx = 0;

        for (let y = by0; y <= by1; y++) {
          const row = y * W;
          for (let x = bx0; x <= bx1; x++) {
            const idx = row + x;
            if (diffMax[idx] >= diffThresh) {
              localSil[idx] = 1;
              silCoords.push([x, y]);
              const l = lumaA[idx];
              silLumas.push(l);
              silSum += l;
              silSqSum += l * l;
              const o = idx * 4;
              const r = dA[o], g = dA[o + 1], b = dA[o + 2];
              const maxC = Math.max(r, g, b);
              const minC = Math.min(r, g, b);
              if (maxC >= hotMaxRgb && maxC - minC >= hotMinChroma) {
                hotPx++;
              }
            }
          }
        }

        const silPx = silCoords.length;
        if (silPx === 0) {
          enemies.push({
            id: eb.id,
            faction: eb.faction,
            dist: eb.dist,
            height: eb.height ?? 0,
            bboxNonEmpty,
            bbox: { x0: eb.x0, y0: eb.y0, x1: eb.x1, y1: eb.y1 },
            silPx: 0,
          });
          continue;
        }

        const silMean = silSum / silPx;
        const silVar = Math.max(0, silSqSum / silPx - silMean * silMean);
        const silStd = Math.sqrt(silVar);
        silLumas.sort((a, b) => a - b);
        const silMedian = median(silLumas);
        const p99Pos = (silPx - 1) * 0.99;
        const p99Lo = Math.floor(p99Pos);
        const p99Hi = Math.min(silPx - 1, p99Lo + 1);
        const silP99Luma = silLumas[p99Lo] + (silLumas[p99Hi] - silLumas[p99Lo]) * (p99Pos - p99Lo);
        const hotFrac = hotPx / silPx;

        // Dilate silhouette by 12px; exclude silhouette pixels and any other enemy's diff pixels
        const ringMask = new Uint8Array(N);
        const ringLumas = [];
        let ringPx = 0;
        let ringSumA = 0;
        let ringSumB = 0;

        for (let k = 0; k < silCoords.length; k++) {
          const [sx, sy] = silCoords[k];
          for (let j = 0; j < ringOffsets.length; j++) {
            const nx = sx + ringOffsets[j][0];
            const ny = sy + ringOffsets[j][1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nIdx = ny * W + nx;
            if (localSil[nIdx] || globalSil[nIdx] || ringMask[nIdx]) continue;
            ringMask[nIdx] = 1;
            ringPx++;
            const la = lumaA[nIdx];
            ringLumas.push(la);
            ringSumA += la;
            ringSumB += lumaB[nIdx];
          }
        }

        ringLumas.sort((a, b) => a - b);
        const ringMedian = median(ringLumas);
        const ringMeanA = ringPx > 0 ? ringSumA / ringPx : 0;
        const ringMeanB = ringPx > 0 ? ringSumB / ringPx : 0;
        const deltaLuma = Math.abs(silMean - ringMeanA);
        const medianDeltaLuma = Math.abs(silMedian - ringMedian);

        enemies.push({
          id: eb.id,
          faction: eb.faction,
          dist: eb.dist,
          height: eb.height ?? 0,
          bboxNonEmpty,
          bbox: { x0: eb.x0, y0: eb.y0, x1: eb.x1, y1: eb.y1 },
          silPx,
          silMean: Number(silMean.toFixed(2)),
          silMedian: Number(silMedian.toFixed(2)),
          silStd: Number(silStd.toFixed(2)),
          silP99Luma: Number(silP99Luma.toFixed(2)),
          hotPx,
          hotFrac: Number(hotFrac.toFixed(4)),
          ringPx,
          ringMean: Number(ringMeanA.toFixed(2)),
          ringMedian: Number(ringMedian.toFixed(2)),
          ringMeanB: Number(ringMeanB.toFixed(2)),
          deltaLuma: Number(deltaLuma.toFixed(2)),
          medianDeltaLuma: Number(medianDeltaLuma.toFixed(2)),
          signedDelta: Number((silMean - ringMeanA).toFixed(2)),
        });
      }

      return {
        width: W,
        height: H,
        meanA: Number((sumA / N).toFixed(2)),
        meanB: Number((sumB / N).toFixed(2)),
        globalDiffPx,
        boundsCount: enemyBounds.length,
        onScreenBounds: enemyBounds.filter((e) => e.onScreen),
        nonEnemy: {
          px: nonEnemyPx,
          coverageFrac: Number((nonEnemyPx / N).toFixed(3)),
          meanDiff: Number((nonEnemyDiffSum / Math.max(1, nonEnemyPx)).toFixed(4)),
          changedFrac: Number((nonEnemyChanged / Math.max(1, nonEnemyPx)).toFixed(5)),
          maxDiff: nonEnemyMaxDiff,
          changedBox: nonEnemyChanged > 0 ? { x0: chX0, y0: chY0, x1: chX1, y1: chY1 } : null,
        },
        enemies,
      };
    },
    {
      b64A: shotA.b64,
      b64B: shotB.b64,
      enemyBounds: bounds,
      ringR: RING_RADIUS_PX,
      diffThresh: DIFF_THRESH,
      distMin: activeRange[0],
      distMax: activeRange[1],
      hotMaxRgb: HOT_MAX_RGB,
      hotMinChroma: HOT_MIN_CHROMA,
      skipDistFilter: visibilityOnly,
    },
  );

  await page.evaluate(() => window.__test.setPaused(false));

  const validVisible = metrics.enemies.filter((e) => e.bboxNonEmpty && e.silPx > MIN_AB_CHANGED_PX);
  log(
    `${label} range=[${activeRange[0]},${activeRange[1]}]m: meanA=${metrics.meanA} meanB=${metrics.meanB} ` +
      `globalDiffPx=${metrics.globalDiffPx} nonEnemyCov=${metrics.nonEnemy.coverageFrac} ` +
      `meanDiff=${metrics.nonEnemy.meanDiff} changedFrac=${metrics.nonEnemy.changedFrac} ` +
      `enemies=${validVisible
        .map(
          (e) =>
            `${e.id}@${e.dist}m(sil=${e.silMean},ring=${e.ringMean},|Δ|=${e.deltaLuma},med|Δ|=${e.medianDeltaLuma},std=${e.silStd},p99=${e.silP99Luma},hot=${(e.hotFrac * 100).toFixed(2)}%,px=${e.silPx})`,
        )
        .join(' ')}`,
  );

  // ── Mandatory Visibility Pre-Assertion ──
  // Prove Boss / target is genuinely visible & unoccluded in frame A and genuinely hidden in frame B.
  if (metrics.globalDiffPx <= MIN_AB_CHANGED_PX || validVisible.length === 0) {
    writeFileSync(`/tmp/debug-${label}-A.png`, shotA.buf);
    writeFileSync(`/tmp/debug-${label}-B.png`, shotB.buf);
    const reason =
      `GATE INVALID: boss occluded or setVisible ineffective ` +
      `(${label}: globalDiffPx=${metrics.globalDiffPx}, validVisible=${validVisible.length}, ` +
      `range=[${activeRange[0]},${activeRange[1]}]m, onScreenBounds=${JSON.stringify(metrics.onScreenBounds)})`;
    console.error(reason);
    throw new Error(reason);
  }

  if (visibilityOnly) {
    return { label, range: activeRange, ...metrics, measuredCount: validVisible.length };
  }

  if (
    metrics.nonEnemy.coverageFrac < 0.5 ||
    metrics.nonEnemy.meanDiff > MAX_NON_ENEMY_MEAN_DIFF ||
    metrics.nonEnemy.changedFrac > MAX_NON_ENEMY_CHANGED_FRAC
  ) {
    writeFileSync(`/tmp/debug-${label}-A.png`, shotA.buf);
    writeFileSync(`/tmp/debug-${label}-B.png`, shotB.buf);
    log(
      `wrote /tmp/debug-${label}-{A,B}.png; changedBox=${JSON.stringify(metrics.nonEnemy.changedBox)} ` +
        `onScreenBounds=${JSON.stringify(metrics.onScreenBounds)}`,
    );
  }

  // Verify non-enemy region diff ≈ 0
  assert.ok(
    metrics.nonEnemy.coverageFrac >= 0.5,
    `${label}: non-enemy region too small (${metrics.nonEnemy.coverageFrac})`,
  );
  assert.ok(
    metrics.nonEnemy.meanDiff <= MAX_NON_ENEMY_MEAN_DIFF,
    `${label}: non-enemy meanDiff=${metrics.nonEnemy.meanDiff} > ${MAX_NON_ENEMY_MEAN_DIFF}`,
  );
  assert.ok(
    metrics.nonEnemy.changedFrac <= MAX_NON_ENEMY_CHANGED_FRAC,
    `${label}: non-enemy changedFrac=${metrics.nonEnemy.changedFrac} > ${MAX_NON_ENEMY_CHANGED_FRAC}`,
  );

  // Verify every visible enemy in target distance range meets strict contrast & exposure bounds
  for (const e of validVisible) {
    assert.ok(
      e.deltaLuma >= MIN_DELTA_LUMA,
      `${label} [${e.id} @ ${e.dist}m]: |Δluma|=${e.deltaLuma} < ${MIN_DELTA_LUMA} (sil=${e.silMean}, ring=${e.ringMean})`,
    );
    assert.ok(
      e.medianDeltaLuma >= MIN_DELTA_LUMA,
      `${label} [${e.id} @ ${e.dist}m]: median|Δluma|=${e.medianDeltaLuma} < ${MIN_DELTA_LUMA} (silMed=${e.silMedian}, ringMed=${e.ringMedian})`,
    );
    assert.ok(
      e.silStd >= MIN_SIL_STD,
      `${label} [${e.id} @ ${e.dist}m]: silStd=${e.silStd} < ${MIN_SIL_STD} (dead dark block)`,
    );
    assert.ok(
      e.silP99Luma <= MAX_SIL_P99_LUMA,
      `${label} [${e.id} @ ${e.dist}m]: silP99Luma=${e.silP99Luma} > ${MAX_SIL_P99_LUMA} (overexposed silhouette)`,
    );
    assert.ok(
      e.hotFrac <= MAX_HOT_FRAC,
      `${label} [${e.id} @ ${e.dist}m]: hotFrac=${e.hotFrac} > ${MAX_HOT_FRAC} (hotPx=${e.hotPx}/${e.silPx}, overexposed neon/lava)`,
    );
  }

  return { label, range: activeRange, ...metrics, measuredCount: validVisible.length };
}

/**
 * Find an unobstructed open-deck vantage inside the enemy's height-appropriate probe range
 * (14–22m for >=3m Boss, 8–15m for <3m mobs), verifying multi-ray LOS clearance so no foreground
 * shipping container blocks the camera lens.
 */
async function advanceToNaturalEnemy(page) {
  await waitFrames(page, 1);

  const plan = await page.evaluate(
    ({ bossHThresh, bossRThresh, bossRange, smallRange }) => {
      const live = (window.__enemies ?? []).filter((e) => e.alive && e.state !== 'DEAD');
      if (live.length === 0) return null;
      const target = live[0];
      const isBoss =
        (target.height ?? 0) >= bossHThresh ||
        (target.radius ?? 0) >= bossRThresh ||
        target.id === 'boss';
      const range = isBoss ? bossRange : smallRange;
      const radii = isBoss ? [18.5, 17.5, 19.5, 16.5, 20.5, 15.5] : [11.5, 12.5, 10.5, 13.5];
      const midY = (target.height || (isBoss ? 4.0 : 1.8)) * 0.52;
      const topY = (target.height || (isBoss ? 4.0 : 1.8)) * 0.85;
      const lowY = 0.65;

      const clearOfOthers = (px, pz) =>
        live.every((o) => o.id === target.id || Math.hypot(o.x - px, o.z - pz) >= 6.5);

      const candidates = [];
      for (const r of radii) {
        for (let deg = 0; deg < 360; deg += 10) {
          const rad = (deg * Math.PI) / 180;
          const px = target.x + Math.sin(rad) * r;
          const pz = target.z + Math.cos(rad) * r;
          if (!window.__test.isInsideWalkable(px, pz)) continue;
          if (!clearOfOthers(px, pz)) continue;

          // Verify center + lateral (±0.9m) sightlines clear all containers & props so the camera
          // never spawns nose-first against a container edge.
          const dx = target.x - px;
          const dz = target.z - pz;
          const len = Math.hypot(dx, dz) || 1;
          const rx = -dz / len;
          const rz = dx / len;

          const hasLos = window.__test.hasClearLos;
          if (!hasLos) {
            candidates.push({ px, pz, score: r });
            continue;
          }
          const okCenter =
            hasLos(px, 1.65, pz, target.x, midY, target.z) &&
            hasLos(px, 1.65, pz, target.x, topY, target.z) &&
            hasLos(px, 1.65, pz, target.x, lowY, target.z);
          if (!okCenter) continue;

          // Check camera-side lateral margin (0.95m left & right, and 0.9m forward/back of camera)
          const okMargin =
            hasLos(px + rx * 0.95, 1.65, pz + rz * 0.95, target.x + rx * 0.45, midY, target.z + rz * 0.45) &&
            hasLos(px - rx * 0.95, 1.65, pz - rz * 0.95, target.x - rx * 0.45, midY, target.z - rz * 0.45) &&
            window.__test.isInsideWalkable(px + rx * 0.7, pz + rz * 0.7) &&
            window.__test.isInsideWalkable(px - rx * 0.7, pz - rz * 0.7);
          const wideClear =
            hasLos(px + rx * 2.0, 1.65, pz + rz * 2.0, target.x, midY, target.z) &&
            hasLos(px - rx * 2.0, 1.65, pz - rz * 2.0, target.x, midY, target.z);

          // Prefer wide open corridor near ideal standoff distance (~18m for Boss, ~11.5m for mob)
          const ideal = isBoss ? 18.0 : 11.5;
          const score =
            (wideClear ? 0 : okMargin ? 4 : 20) + Math.abs(r - ideal);
          candidates.push({ px, pz, score, wideClear, okMargin });
        }
      }
      candidates.sort((a, b) => a.score - b.score);
      return {
        isBoss,
        range,
        targetId: target.id,
        height: target.height ?? 0,
        candidates: candidates.slice(0, 8),
      };
    },
    {
      bossHThresh: BOSS_HEIGHT_THRESH,
      bossRThresh: BOSS_RADIUS_THRESH,
      bossRange: BOSS_ENEMY_RANGE,
      smallRange: SMALL_ENEMY_RANGE,
    },
  );

  assert.ok(plan && plan.candidates.length > 0, 'advanceToNaturalEnemy: no unobstructed open-deck vantage found');
  const [rMin, rMax] = plan.range;
  const idealDist = plan.isBoss ? 17.5 : 11.0;

  let chosen = null;
  for (const cand of plan.candidates) {
    await page.evaluate(({ px, pz }) => {
      const b = (window.__enemies ?? []).find((e) => e.alive);
      if (!b) return;
      const dx = b.x - px;
      const dz = b.z - pz;
      const dist = Math.hypot(dx, dz) || 1;
      const yawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      const aimY = (b.height || 4.0) * 0.5;
      const pitchDeg = (Math.atan2(aimY - 1.65, dist) * 180) / Math.PI;
      window.__test.teleport(px, pz, yawDeg, pitchDeg, 0);
    }, cand);
    await waitFrames(page, 1);

    const hit = await page.evaluate(
      ({ lo, hi, ideal }) => {
        const live = (window.__enemies ?? []).filter(
          (e) => e.alive && e.hasLos && e.dist >= lo && e.dist <= hi,
        );
        live.sort((a, b) => Math.abs(a.dist - ideal) - Math.abs(b.dist - ideal));
        return live[0] ?? null;
      },
      { lo: rMin, hi: rMax, ideal: idealDist },
    );
    if (hit) {
      chosen = hit;
      break;
    }
  }

  // Re-center aim cleanly on the live Boss after 1 more rendered frame (handles fast Boss movement)
  const picked = await page.evaluate(
    ({ lo, hi, ideal }) => {
      const st = window.__state;
      const live = (window.__enemies ?? []).filter(
        (e) => e.alive && e.hasLos && e.dist >= lo && e.dist <= hi,
      );
      live.sort((a, b) => Math.abs(a.dist - ideal) - Math.abs(b.dist - ideal));
      const b = live[0] ?? null;
      if (b) {
        const dx = b.x - st.x;
        const dz = b.z - st.z;
        const dist = Math.hypot(dx, dz) || 1;
        const yawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
        const aimY = (b.height || 4.0) * 0.5;
        const pitchDeg = (Math.atan2(aimY - (st.y + 1.65), dist) * 180) / Math.PI;
        window.__test.teleport(st.x, st.z, yawDeg, pitchDeg, st.y);
      }
      return b;
    },
    { lo: rMin, hi: rMax, ideal: idealDist },
  );
  await waitFrames(page, 1);
  return { enemy: picked ?? chosen, range: plan.range, isBoss: plan.isBoss };
}

async function runGateAttempt(attempt, targetUrl) {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];

  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  try {
    log(`attempt #${attempt}: goto ${targetUrl} (${VIEWPORT.width}x${VIEWPORT.height} portrait)`);
    await page.goto(targetUrl, { waitUntil: 'commit', timeout: 60000 });
    let frames = 0;
    for (let i = 0; i < 240 && frames < 4; i++) {
      await page.waitForTimeout(500);
      frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
    }
    assert.ok(frames >= 4, 'page never rendered WebGL frames');
    log(`loaded frames=${frames}`);

    // Start real match
    await page.evaluate(() => {
      const el = document.querySelector('[data-btn="start"]');
      el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      window.__test.skipCountdown?.();
    });
    await page.waitForFunction(() => window.__match?.phase === 'playing', null, {
      timeout: MATCH_PLAY_TIMEOUT_MS,
    });
    log('match phase=playing');

    // ── Gate 1: Real match natural Boss/enemy probe in dynamic height range (14–22m for >=3m Boss) ──
    const natural = await advanceToNaturalEnemy(page);
    log(
      `natural target: ${
        natural.enemy
          ? `${natural.enemy.id}@${natural.enemy.dist.toFixed(2)}m h=${natural.enemy.height}m los=${natural.enemy.hasLos} state=${natural.enemy.state}`
          : 'none'
      } range=[${natural.range[0]},${natural.range[1]}]m`,
    );
    const naturalResult = await measureSceneAB(page, cdp, 'natural-advance', null, {
      explicitDistRange: natural.range,
    });

    // ── Gate 2 + Shot 1: Unobstructed 15–20m Boss Standoff Panorama (open center corridor @ 17m) ──
    await page.evaluate(() => {
      // Wide open center corridor (x=0, z in [-16, 16], zero containers in path):
      // Boss at (0, -2.5), Player at (0, 14.5) => 17.0m (<= 18m charge trigger -> upright chase standoff!)
      window.__test.teleport(0.0, 14.5, 0, 1.2, 0);
      window.__test.positionBoss(0.0, -2.5, true);
    });
    await waitFrames(page, 2);
    // Keep camera smoothly centered on Boss as it steps forward in standoff
    await page.evaluate(() => {
      const b = window.__boss;
      const st = window.__state;
      const dx = b.x - st.x;
      const dz = b.z - st.z;
      const dist = Math.hypot(dx, dz) || 1;
      const yawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      const pitchDeg = (Math.atan2(b.height * 0.5 - 1.65, dist) * 180) / Math.PI;
      window.__test.teleport(st.x, st.z, yawDeg, pitchDeg, 0);
    });
    await waitFrames(page, 1);
    const standoffShotPath = `${SHOTS_DIR}/boss-standoff-17m.png`;
    const standoffResult = await measureSceneAB(page, cdp, 'boss-standoff-17m', standoffShotPath, {
      explicitDistRange: BOSS_ENEMY_RANGE,
    });

    // ── Gate 3 + Shot 2: Boss Charge Rush Moment (state === 'charge' across open center corridor) ──
    await page.evaluate(() => {
      // Starting dist 20.5m > chargeTriggerDist (18m) -> enters straight-line charge on first tick!
      window.__test.teleport(0.0, 15.0, 0, 1.0, 0);
      window.__test.positionBoss(0.0, -5.5, true);
    });
    await page.waitForFunction(
      () => window.__boss?.state === 'charge' && window.__boss.dist >= 14.2 && window.__boss.dist <= 21.5,
      null,
      { timeout: FRAME_WAIT_TIMEOUT_MS },
    );
    // Advance 3 frames so the charge forward-lean & arms-swept-back sprint pose settles visibly
    await waitFrames(page, 3);
    const chargeState = await page.evaluate(() => {
      const b = window.__boss;
      const st = window.__state;
      const dx = b.x - st.x;
      const dz = b.z - st.z;
      const dist = Math.hypot(dx, dz) || 1;
      const yawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      const pitchDeg = (Math.atan2(b.height * 0.45 - 1.65, dist) * 180) / Math.PI;
      window.__test.teleport(st.x, st.z, yawDeg, pitchDeg, 0);
      return { state: b.state, dist: Number(dist.toFixed(2)) };
    });
    await waitFrames(page, 1);
    assert.equal(chargeState.state, 'charge', `expected Boss in charge state, got ${chargeState.state}`);
    const chargeShotPath = `${SHOTS_DIR}/boss-charge.png`;
    const chargeResult = await measureSceneAB(page, cdp, 'boss-charge', chargeShotPath, {
      explicitDistRange: BOSS_ENEMY_RANGE,
    });

    // ── Shot 3: Boss Melee Attack Hit Moment (real windup -> attack -> onAttackHit + player HP drop) ──
    await page.evaluate(() => {
      // Position player at 3.0m (<= attackRange 3.2m) facing Boss, pitched slightly up at slashing claw/torso
      window.__test.teleport(0.0, 0.5, 0, 11.5, 0);
      window.__test.positionBoss(0.0, -2.5, true);
    });
    await page.waitForFunction(
      () => (window.__boss?.meleeHitsDealt ?? 0) >= 1 && window.__state.hp < window.__state.maxHp,
      null,
      { timeout: FRAME_WAIT_TIMEOUT_MS },
    );
    const meleeInfo = await page.evaluate(() => ({
      bossState: window.__boss.state,
      bossDist: Number(window.__boss.dist.toFixed(2)),
      meleeHitsDealt: window.__boss.meleeHitsDealt,
      playerHp: window.__state.hp,
      playerMaxHp: window.__state.maxHp,
      flashOpacity: Number((window.__fx?.flashOpacity ?? 0).toFixed(3)),
    }));
    const meleeShotPath = `${SHOTS_DIR}/boss-melee-hit.png`;
    const meleeVisibility = await measureSceneAB(page, cdp, 'boss-melee-hit', meleeShotPath, {
      visibilityOnly: true,
    });
    assert.ok(meleeInfo.meleeHitsDealt >= 1, `expected meleeHitsDealt >= 1, got ${meleeInfo.meleeHitsDealt}`);
    assert.ok(meleeInfo.playerHp < meleeInfo.playerMaxHp, `expected player HP drop on melee hit`);

    // Aggregate summary across all 14–22m Boss contrast probes
    const contrastProbes = [naturalResult, standoffResult, chargeResult];
    const allMeasured = contrastProbes.flatMap((r) =>
      r.enemies.filter((e) => e.bboxNonEmpty && e.silPx > MIN_AB_CHANGED_PX),
    );
    const overallMedianDeltaLuma = Number(medianOf(allMeasured.map((e) => e.deltaLuma)).toFixed(2));
    const overallMedianPixDeltaLuma = Number(medianOf(allMeasured.map((e) => e.medianDeltaLuma)).toFixed(2));
    const maxP99Luma = Number(Math.max(...allMeasured.map((e) => e.silP99Luma)).toFixed(2));
    const maxHotFrac = Number(Math.max(...allMeasured.map((e) => e.hotFrac)).toFixed(4));
    const minChangedPx = Math.min(
      ...contrastProbes.map((r) => r.globalDiffPx),
      meleeVisibility.globalDiffPx,
    );

    assert.ok(
      overallMedianDeltaLuma >= MIN_DELTA_LUMA,
      `overall median|Δluma|=${overallMedianDeltaLuma} < ${MIN_DELTA_LUMA}`,
    );
    assert.ok(
      overallMedianPixDeltaLuma >= MIN_DELTA_LUMA,
      `overall pixel median|Δluma|=${overallMedianPixDeltaLuma} < ${MIN_DELTA_LUMA}`,
    );

    assert.deepEqual(errors, [], `JS/console errors: ${errors.join('\n')}`);
    return {
      viewport: VIEWPORT,
      ranges: {
        smallEnemy: SMALL_ENEMY_RANGE,
        boss: BOSS_ENEMY_RANGE,
      },
      thresholds: {
        minChangedPx: MIN_AB_CHANGED_PX,
        minDeltaLuma: MIN_DELTA_LUMA,
        minSilhouetteStd: MIN_SIL_STD,
        maxSilP99Luma: MAX_SIL_P99_LUMA,
        maxHotFrac: MAX_HOT_FRAC,
        hotMaxRgb: HOT_MAX_RGB,
        hotMinChroma: HOT_MIN_CHROMA,
        ringRadiusPx: RING_RADIUS_PX,
        maxNonEnemyMeanDiff: MAX_NON_ENEMY_MEAN_DIFF,
      },
      summary: {
        medianDeltaLuma: overallMedianDeltaLuma,
        medianPixelDeltaLuma: overallMedianPixDeltaLuma,
        maxP99Luma,
        maxHotFrac,
        minChangedPx,
      },
      naturalResult,
      standoffResult,
      chargeResult,
      meleeInfo: { ...meleeInfo, changedPx: meleeVisibility.globalDiffPx },
      shots: [standoffShotPath, chargeShotPath, meleeShotPath],
    };
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const target = await resolveTargetUrl();
let lastErr = null;
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await runGateAttempt(attempt, target.url);
      console.log(JSON.stringify(out, null, 2));
      console.log('ENEMY CONTRAST GATE ALL OK');
      await target.close();
      process.exit(0);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const isTransientCrash = /Target page, context or browser has been closed|Target closed|crashed/i.test(msg);
      if (!isTransientCrash || attempt === 3) {
        throw err;
      }
      log(`transient SwiftShader browser crash on attempt #${attempt}: ${msg} — retrying`);
    }
  }
  throw lastErr;
} finally {
  await target.close();
}
