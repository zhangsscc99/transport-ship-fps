// Enemy Silhouette Contrast Gate (portrait 390×844, deployed build):
//   1. Starts a real match at 390×844 portrait and advances to 8–15m from visible live enemies.
//   2. Performs exact same-frame A/B capture via CDP Page.captureScreenshot:
//        - Frame A: paused with enemies visible
//        - Frame B: exact same paused frame with enemies visible=false (zero clock/sim advance)
//      Diff region = enemy silhouette.
//   3. Asserts:
//        - Non-enemy region diff ≈ 0 (proves zero frame drift between A and B)
//        - For every visible enemy in 8–15m:
//            |meanLuma(silhouette) - meanLuma(12px outer ring)| >= 14 luma
//            stdLuma(silhouette) >= 6 luma (rich volumetric shading, not a dead black block)
//            silP99Luma <= 205 luma (no overexposed washed-out body)
//            hotFrac <= 0.06 (fraction of silhouette pixels with max(R,G,B) >= 235 && (max-min) >= 55)
//   4. Captures 2 required screenshots to e2e/shots/ via CDP Page.captureScreenshot (and asserts
//      silhouette contrast & overexposure bounds on them as well):
//        - e2e/shots/enemy-rim-portrait.png  (390×844 portrait combat with 3+ enemies)
//        - e2e/shots/enemy-rim-8m.png        (390×844 portrait 8m close-up)
//
// Exits non-zero on any failure.
// Usage: node scripts/enemy-contrast.mjs   (defaults to http://127.0.0.1:3028/transport/)

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const SHOTS_DIR = process.env.SHOTS_DIR ?? 'e2e/shots';
mkdirSync(SHOTS_DIR, { recursive: true });

const VIEWPORT = { width: 390, height: 844 };
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

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

const T0 = Date.now();
const log = (msg) => console.error(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

async function waitFrames(page, count = 2, timeout = 180000) {
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

/** Flush a single paused WebGL render cleanly into Chromium's compositor before CDP capture. */
async function renderPausedVisibility(page, visible) {
  await page.evaluate(
    (vis) =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          window.__test.setEnemiesVisible(vis);
          setTimeout(() => resolve(true), 40);
        });
      }),
    visible,
  );
}

/**
 * Capture exact same-frame A (visible=true) and B (visible=false) via CDP and analyze:
 *   - Non-enemy region diff (must be ≈ 0)
 *   - Per-enemy silhouette (diff >= DIFF_THRESH) mean luma, stddev, and 12px outer ring mean luma
 */
async function measureSceneAB(page, cdp, label, savePath = null, targetDistRange = [7.5, 16.0]) {
  await page.evaluate(() => window.__test.setPaused(true));
  await page.waitForTimeout(220); // let any in-flight HUD/touch CSS transitions settle before A/B
  const bounds = await page.evaluate(() => window.__test.getEnemyScreenBounds());

  await renderPausedVisibility(page, true);
  const shotA = await captureCdpPng(cdp, savePath);

  await renderPausedVisibility(page, false);
  const shotB = await captureCdpPng(cdp, null);

  await renderPausedVisibility(page, true);

  const metrics = await page.evaluate(
    async ({ b64A, b64B, enemyBounds, ringR, diffThresh, distMin, distMax, hotMaxRgb, hotMinChroma }) => {
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
      //    (wide enough for visor halo + directional ground shadow, leaving >65% of screen checked).
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
        if (eb.dist < distMin || eb.dist > distMax) continue;

        // Crop tightly around enemy chassis (+10px left/right/top for visor halo, +2px bottom
        // to exclude the cast shadow extending along the deck beneath the boots).
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
          enemies.push({ id: eb.id, faction: eb.faction, dist: eb.dist, silPx: 0 });
          continue;
        }

        const silMean = silSum / silPx;
        const silVar = Math.max(0, silSqSum / silPx - silMean * silMean);
        const silStd = Math.sqrt(silVar);
        silLumas.sort((a, b) => a - b);
        const p99Pos = (silPx - 1) * 0.99;
        const p99Lo = Math.floor(p99Pos);
        const p99Hi = Math.min(silPx - 1, p99Lo + 1);
        const silP99Luma = silLumas[p99Lo] + (silLumas[p99Hi] - silLumas[p99Lo]) * (p99Pos - p99Lo);
        const hotFrac = hotPx / silPx;

        // Dilate silhouette by 12px; exclude silhouette pixels and any other enemy's diff pixels
        const ringMask = new Uint8Array(N);
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
            ringSumA += lumaA[nIdx];
            ringSumB += lumaB[nIdx];
          }
        }

        const ringMeanA = ringPx > 0 ? ringSumA / ringPx : 0;
        const ringMeanB = ringPx > 0 ? ringSumB / ringPx : 0;
        const deltaLuma = Math.abs(silMean - ringMeanA);

        enemies.push({
          id: eb.id,
          faction: eb.faction,
          dist: eb.dist,
          bbox: { x0: eb.x0, y0: eb.y0, x1: eb.x1, y1: eb.y1 },
          silPx,
          silMean: Number(silMean.toFixed(2)),
          silStd: Number(silStd.toFixed(2)),
          silP99Luma: Number(silP99Luma.toFixed(2)),
          hotPx,
          hotFrac: Number(hotFrac.toFixed(4)),
          ringPx,
          ringMean: Number(ringMeanA.toFixed(2)),
          ringMeanB: Number(ringMeanB.toFixed(2)),
          deltaLuma: Number(deltaLuma.toFixed(2)),
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
      distMin: targetDistRange[0],
      distMax: targetDistRange[1],
      hotMaxRgb: HOT_MAX_RGB,
      hotMinChroma: HOT_MIN_CHROMA,
    },
  );

  await page.evaluate(() => window.__test.setPaused(false));

  const measured = metrics.enemies.filter((e) => e.silPx >= 60);
  log(
    `${label}: meanA=${metrics.meanA} meanB=${metrics.meanB} globalDiffPx=${metrics.globalDiffPx} ` +
      `nonEnemyCov=${metrics.nonEnemy.coverageFrac} meanDiff=${metrics.nonEnemy.meanDiff} changedFrac=${metrics.nonEnemy.changedFrac} maxDiff=${metrics.nonEnemy.maxDiff} ` +
      `enemies=${measured.map((e) => `${e.id}@${e.dist}m(sil=${e.silMean},ring=${e.ringMean},|Δ|=${e.deltaLuma},std=${e.silStd},p99=${e.silP99Luma},hot=${(e.hotFrac * 100).toFixed(2)}%,px=${e.silPx})`).join(' ')}`,
  );
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

  // Verify every visible enemy in target distance range meets contrast + non-flat-black criteria
  assert.ok(
    measured.length >= 1,
    `${label}: no visible enemy with >=60 silhouette px in range [${targetDistRange[0]}, ${targetDistRange[1]}]m (raw=${JSON.stringify(metrics.enemies)})`,
  );
  for (const e of measured) {
    assert.ok(
      e.deltaLuma >= MIN_DELTA_LUMA,
      `${label} [${e.id} @ ${e.dist}m]: |Δluma|=${e.deltaLuma} < ${MIN_DELTA_LUMA} (sil=${e.silMean}, ring=${e.ringMean})`,
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
      `${label} [${e.id} @ ${e.dist}m]: hotFrac=${e.hotFrac} > ${MAX_HOT_FRAC} (hotPx=${e.hotPx}/${e.silPx}, neon rim overexposure)`,
    );
  }

  return { label, ...metrics, measuredCount: measured.length };
}

/** Advance from match start to 8–15m clear LOS of a live naturally spawned AI enemy (fast under SwiftShader). */
async function advanceToNaturalEnemy(page) {
  await waitFrames(page, 1);

  // Known obstacle-free open deck lanes (verified against src/game/map.ts boxes)
  const positionFacingLiveBot = async () =>
    page.evaluate(() => {
      const live = (window.__enemies ?? []).filter((e) => e.alive && e.state !== 'DEAD');
      // Try clear open-deck vantage points 11.5–13m away along unobstructed lanes (north lane z=-15.5,
      // center lane x=0.2, west lane x=-20, east lane x=20).
      const candidates = [];
      const clearOfOtherBots = (px, pz) =>
        live.every((other) => Math.hypot(other.x - px, other.z - pz) >= 6.5);
      for (const b of live) {
        if (Math.abs(b.z - -15.5) < 2.5) {
          if (b.x - 12.0 >= -20 && clearOfOtherBots(b.x - 12.0, -15.5)) {
            candidates.push({ b, px: b.x - 12.0, pz: -15.5 });
          }
          if (b.x + 12.0 <= 20 && clearOfOtherBots(b.x + 12.0, -15.5)) {
            candidates.push({ b, px: b.x + 12.0, pz: -15.5 });
          }
        }
        if (Math.abs(b.x) < 3.0) {
          const pz = b.z + 12.0;
          if (pz >= -16 && pz <= 16 && clearOfOtherBots(0.2, pz)) {
            candidates.push({ b, px: 0.2, pz });
          }
        }
        if (Math.abs(b.x - -20) < 2.5 && clearOfOtherBots(-20.0, b.z + 11.5)) {
          candidates.push({ b, px: -20.0, pz: b.z + 11.5 });
        }
        if (Math.abs(b.x - 18) < 2.5 && clearOfOtherBots(19.5, b.z + 11.5)) {
          candidates.push({ b, px: 19.5, pz: b.z + 11.5 });
        }
      }
      // Fallback: open north-west or center deck vantage clear of nearby bots
      if (candidates.length === 0 && live.length > 0) {
        const b = live[0];
        for (const [px, pz] of [
          [0.2, -3.5],
          [-20.0, 2.0],
          [19.5, 2.0],
          [0.2, -15.5],
        ]) {
          if (clearOfOtherBots(px, pz)) {
            candidates.push({ b, px, pz });
            break;
          }
        }
      }
      return candidates.map((c) => ({ id: c.b.id, bx: c.b.x, bz: c.b.z, px: c.px, pz: c.pz }));
    });

  const candidates = await positionFacingLiveBot();
  let chosen = null;
  for (const c of candidates) {
    await page.evaluate((cand) => {
      const yawDeg = (Math.atan2(-(cand.bx - cand.px), -(cand.bz - cand.pz)) * 180) / Math.PI;
      window.__test.teleport(cand.px, cand.pz, yawDeg, -1.5, 0);
    }, c);
    await waitFrames(page, 1);
    const hit = await page.evaluate(() => {
      const live = (window.__enemies ?? []).filter((e) => e.alive && e.hasLos && e.dist >= 8.0 && e.dist <= 15.0);
      live.sort((a, b) => Math.abs(a.dist - 11.0) - Math.abs(b.dist - 11.0));
      return live[0] ?? null;
    });
    if (hit) {
      chosen = hit;
      break;
    }
  }

  // Advance forward 2 real frames with virtual joystick while tracking the live LOS enemy
  await page.evaluate(() => {
    const zone = document.querySelector('[data-zone="stick"]');
    if (!zone) return;
    const r = zone.getBoundingClientRect();
    const ox = r.x + r.width * 0.5;
    const oy = r.y + r.height * 0.65;
    zone.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 44,
        clientX: ox,
        clientY: oy,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 44,
        clientX: ox,
        clientY: oy - 64,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
  });
  await waitFrames(page, 2);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 44, bubbles: true, pointerType: 'touch' }));
  });
  await page.waitForTimeout(300);

  // Lock camera center onto the visible live LOS enemy in 8–15m
  const picked = await page.evaluate(() => {
    const st = window.__state;
    const live = (window.__enemies ?? []).filter((e) => e.alive && e.hasLos && e.dist >= 8.0 && e.dist <= 15.0);
    live.sort((a, b) => Math.abs(a.dist - 11.0) - Math.abs(b.dist - 11.0));
    const b = live[0] ?? null;
    if (b) {
      const yawDeg = (Math.atan2(-(b.x - st.x), -(b.z - st.z)) * 180) / Math.PI;
      window.__test.teleport(st.x, st.z, yawDeg, -1.5, st.y);
    }
    return b;
  });
  await waitFrames(page, 1);
  return picked ?? chosen;
}

async function runGateAttempt(attempt) {
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
    log(`attempt #${attempt}: goto ${URL} (${VIEWPORT.width}x${VIEWPORT.height} portrait)`);
    await page.goto(URL, { waitUntil: 'commit', timeout: 30000 });
    let frames = 0;
    for (let i = 0; i < 160 && frames < 4; i++) {
      await page.waitForTimeout(400);
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
    await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 240000 });
    log('match phase=playing');

    // ── Gate 1: Real match advance to 8–15m from live AI enemy + same-frame A/B contrast check ──
    const naturalBot = await advanceToNaturalEnemy(page);
    log(
      `advanced to natural bot: ${
        naturalBot && typeof naturalBot.dist === 'number'
          ? `${naturalBot.id} @ ${naturalBot.dist.toFixed(1)}m los=${naturalBot.hasLos}`
          : JSON.stringify(naturalBot)
      }`,
    );
    const naturalResult = await measureSceneAB(page, cdp, 'natural-advance', null, [7.5, 16.0]);

    // ── Gate 2 + Shot 1: Portrait combat scene with 3+ enemies at 8–15m across deck/fog & dark container backgrounds ──
    await page.evaluate(() => {
      window.__test.clearEnemies();
      window.__test.teleport(0.4, 15.0, 0, -2, 0);
      // 4 robots in unobstructed view across varied backgrounds (deck/horizon fog + shaded container):
      const e1 = window.__test.spawnEnemyAt(-0.6, 5.8, 175, 'enemy'); // ~9.3m (open deck/fog)
      const e2 = window.__test.spawnEnemyAt(1.9, 3.2, 185, 'enemy'); // ~11.9m (in front of dark green container)
      const e3 = window.__test.spawnEnemyAt(-1.6, 1.0, 170, 'enemy'); // ~14.1m (open corridor / cranes)
      const a1 = window.__test.spawnEnemyAt(1.2, -1.5, 180, 'ally'); // ~16.5m (cyan ally contrast check)
      window.__test.damageEnemy(e2, 45);
      window.__test.damageEnemy(e3, 75);
      return { e1, e2, e3, a1 };
    });
    await waitFrames(page, 2);
    const combatShotPath = `${SHOTS_DIR}/enemy-rim-portrait.png`;
    const combatResult = await measureSceneAB(page, cdp, 'portrait-combat-3plus', combatShotPath, [8.0, 15.5]);
    assert.ok(
      combatResult.measuredCount >= 3,
      `portrait combat shot must verify >=3 visible enemies in 8–15.5m, got ${combatResult.measuredCount}`,
    );

    // ── Gate 3 + Shot 2: Portrait 8m close-up showing Fresnel rim + visor fake bloom + armor volume ──
    await page.evaluate(() => {
      window.__test.clearEnemies();
      window.__test.teleport(0.3, 14.0, 0, -2, 0);
      window.__test.spawnEnemyAt(-0.35, 6.0, 170, 'enemy'); // ~8.0m crisp close-up (enemy magenta)
      window.__test.spawnEnemyAt(1.35, 5.2, 200, 'ally'); // ~8.9m companion (ally cyan)
    });
    await waitFrames(page, 2);
    const closeupShotPath = `${SHOTS_DIR}/enemy-rim-8m.png`;
    const closeupResult = await measureSceneAB(page, cdp, 'portrait-8m-closeup', closeupShotPath, [7.5, 10.0]);

    assert.deepEqual(errors, [], `JS/console errors: ${errors.join('\n')}`);
    return {
      viewport: VIEWPORT,
      thresholds: {
        minDeltaLuma: MIN_DELTA_LUMA,
        minSilhouetteStd: MIN_SIL_STD,
        maxSilP99Luma: MAX_SIL_P99_LUMA,
        maxHotFrac: MAX_HOT_FRAC,
        hotMaxRgb: HOT_MAX_RGB,
        hotMinChroma: HOT_MIN_CHROMA,
        ringRadiusPx: RING_RADIUS_PX,
        maxNonEnemyMeanDiff: MAX_NON_ENEMY_MEAN_DIFF,
      },
      naturalResult,
      combatResult,
      closeupResult,
      shots: [combatShotPath, closeupShotPath],
    };
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

let lastErr = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const out = await runGateAttempt(attempt);
    console.log(JSON.stringify(out, null, 2));
    console.log('ENEMY CONTRAST GATE ALL OK');
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
