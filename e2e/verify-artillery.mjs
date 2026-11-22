// E2E Verification & 4-Screenshot Suite for Stationary Parabolic Artillery Boss.
//
// Run via unified screenshot lock:
//   /data/app/scripts/shoot.sh /www/transport-ship-fps-wt/boss-artillery node e2e/verify-artillery.mjs
//
// Asserts all 6 required checks:
//   1. Stationary: after >=30s combat, Boss displacement < 0.05m
//   2. Parabola: sample >=5 frames of projectile, y rises then falls, impact error vs lastShot.target < 0.5m
//   3. Telegraph: ground marker appears <=200ms after launch and stays visible until impact
//   4. Dodgeable: standing at target center takes HP damage; running out during warning takes 0 damage
//   5. No Melee: across >=60s combat meleeHitsDealt === 0, and projectile entity existed in Three.js scene
//   6. Zero console errors, zero page errors, zero failed network requests
//
// Captures 4 screenshots to e2e/shots/:
//   - artillery-telegraph.png  (390x844 portrait: ground warning ring + airborne parabolic shell)
//   - artillery-impact.png     (390x844 portrait: detonation fireball + ground shockwave ring)
//   - artillery-dodge.png      (390x844 portrait: player dodged outside radius, empty blast, 0 damage)
//   - artillery-wide.png       (1280x720 wide side-profile showing Boss + full parabolic arc + ground target)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHOTS_DIR = path.join(ROOT, 'e2e', 'shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const EXTRA_ARGS = (process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? '')
  .split(/\s+/)
  .filter(Boolean);

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  ...EXTRA_ARGS,
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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const T0 = Date.now();
const log = (msg) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

/** Embedded zero-dependency static server for worktree dist/ (/transport/* + /audio/*). */
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (urlPath === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      let filePath = null;
      if (urlPath === '/transport' || urlPath === '/transport/') {
        filePath = path.join(DIST_DIR, 'index.html');
      } else if (urlPath.startsWith('/transport/')) {
        const rel = urlPath.slice('/transport/'.length);
        const candDist = path.normalize(path.join(DIST_DIR, rel));
        const candPub = path.normalize(path.join(PUBLIC_DIR, rel));
        if (candDist.startsWith(DIST_DIR) && fs.existsSync(candDist) && fs.statSync(candDist).isFile()) {
          filePath = candDist;
        } else if (candPub.startsWith(PUBLIC_DIR) && fs.existsSync(candPub) && fs.statSync(candPub).isFile()) {
          filePath = candPub;
        }
      } else if (urlPath.startsWith('/audio/')) {
        const rel = urlPath.slice(1);
        const candDist = path.normalize(path.join(DIST_DIR, rel));
        const candPub = path.normalize(path.join(PUBLIC_DIR, rel));
        if (candDist.startsWith(DIST_DIR) && fs.existsSync(candDist) && fs.statSync(candDist).isFile()) {
          filePath = candDist;
        } else if (candPub.startsWith(PUBLIC_DIR) && fs.existsSync(candPub) && fs.statSync(candPub).isFile()) {
          filePath = candPub;
        }
      }

      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/transport/` });
    });
  });
}

async function waitFrames(page, count = 2, timeout = 120000) {
  const f0 = await page.evaluate(() => window.__frames ?? 0);
  await page.waitForFunction((target) => (window.__frames ?? 0) >= target, f0 + count, { timeout });
}

async function captureCdp(page, cdp, outName) {
  const outPath = path.join(SHOTS_DIR, outName);
  await page.evaluate(() => window.__test.setPaused(true));
  await page.waitForTimeout(80);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
  const sz = fs.statSync(outPath).size;
  assert.ok(sz > 8000, `screenshot ${outName} looks blank (${sz} bytes)`);
  await page.evaluate(() => window.__test.setPaused(false));
  await waitFrames(page, 1);
  log(`saved ${outName} (${(sz / 1024).toFixed(1)} KB)`);
  return outPath;
}

/** Compute camera yaw (deg) looking from (fx, fz) toward (tx, tz) matching Player convention (yaw=0 -> -Z). */
function yawDegTo(fx, fz, tx, tz) {
  return (Math.atan2(-(tx - fx), -(tz - fz)) * 180) / Math.PI;
}

async function bootAndStartMatch(context, url, consoleErrors, pageErrors, failedRequests) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText ?? 'failed'})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });

  await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
  let frames = 0;
  for (let i = 0; i < 240 && frames < 4; i++) {
    await page.waitForTimeout(400);
    frames = await page
      .evaluate(() => (window.__artillery ? window.__frames ?? 0 : 0))
      .catch(() => 0);
  }
  assert.ok(frames >= 4, `page never rendered WebGL frames (frames=${frames})`);
  log(`loaded frames=${frames}`);

  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    if (!el) throw new Error('missing [data-btn="start"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.click();
    window.__test.skipCountdown();
  });
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 120000 });
  await waitFrames(page, 2);

  return { page, cdp };
}

const serverInfo = process.env.TSF_URL
  ? { server: null, url: process.env.TSF_URL }
  : await startLocalServer();
log(`using target URL: ${serverInfo.url}`);

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });

try {
  // ==========================================================================
  // PART A: Portrait 390x844 (DPR 1 for SwiftShader speed) — Assertions 1..6 + 3 Portrait Shots
  // ==========================================================================
  const portraitCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const { page, cdp } = await bootAndStartMatch(
    portraitCtx,
    serverInfo.url,
    consoleErrors,
    pageErrors,
    failedRequests,
  );

  const BOSS_X = 0;
  const BOSS_Z = -14;
  const TARGET_X = 0;
  const TARGET_Z = 7;

  // Stage Boss at (0, -14) and Player at (0, 7) on clear central corridor (21m apart)
  // and install an in-page rAF probe so EVERY rendered frame of Shot #1 is sampled with zero IPC drops!
  const startState = await page.evaluate(
    ([bx, bz, px, pz, yaw]) => {
      window.__test.teleport(px, pz, yaw, -4);
      window.__test.positionBoss(bx, bz, true);

      const probe = {
        active: true,
        shotId: null,
        shotRecord: null,
        hpBefore: window.__state.hp,
        telegraphDelayMs: null,
        samples: [],
        telegraphAlwaysVisible: true,
        minRingScale: 1,
        sawProjectileInScene: false,
        maxTris: 0,
        impact: null,
        hpAfter: null,
      };
      window.__artilleryProbe = probe;

      const tick = () => {
        if (!probe.active) return;
        const art = window.__artillery;
        const simNowMs = window.__anim?.simTimeMs ?? 0;
        if (art) {
          if (art.tris > probe.maxTris) probe.maxTris = art.tris;
          if (!probe.shotId && art.lastShot) {
            probe.shotId = art.lastShot.id;
            probe.shotRecord = {
              ...art.lastShot,
              origin: { ...art.lastShot.origin },
              target: { ...art.lastShot.target },
            };
            const tg = art.activeTelegraphs.find((t) => t.id === probe.shotId);
            if (tg && tg.visible && tg.inScene) {
              probe.telegraphDelayMs = Math.max(0, simNowMs - art.lastShot.launchedAt);
            }
          }
          if (probe.shotId) {
            const p = art.activeProjectiles.find((x) => x.id === probe.shotId);
            const tg = art.activeTelegraphs.find((t) => t.id === probe.shotId);
            if (p) {
              const sceneStats = window.__sceneStats();
              if (sceneStats.projectileObjects.length > 0) probe.sawProjectileInScene = true;
              if (
                probe.samples.length === 0 ||
                probe.samples[probe.samples.length - 1].elapsedSec !== p.elapsedSec
              ) {
                probe.samples.push({
                  frame: window.__frames,
                  elapsedSec: p.elapsedSec,
                  x: p.pos.x,
                  y: p.pos.y,
                  z: p.pos.z,
                });
              }
              if (!tg || !tg.visible || !tg.inScene) {
                probe.telegraphAlwaysVisible = false;
              } else {
                if (probe.telegraphDelayMs === null) {
                  probe.telegraphDelayMs = Math.max(0, simNowMs - probe.shotRecord.launchedAt);
                }
                if (tg.ringScale < probe.minRingScale) probe.minRingScale = tg.ringScale;
              }
            }
            if (art.lastImpact && art.lastImpact.id === probe.shotId) {
              probe.impact = {
                ...art.lastImpact,
                target: { ...art.lastImpact.target },
                impactPos: { ...art.lastImpact.impactPos },
              };
              probe.hpAfter = window.__state.hp;
              probe.active = false;
              return;
            }
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      return {
        simTimeMs: window.__anim.simTimeMs,
        bossX: window.__boss.x,
        bossZ: window.__boss.z,
        hp: window.__state.hp,
      };
    },
    [BOSS_X, BOSS_Z, TARGET_X, TARGET_Z, yawDegTo(TARGET_X, TARGET_Z, BOSS_X, BOSS_Z)],
  );
  log(`Match staged: boss=(${startState.bossX}, ${startState.bossZ}), playerHp=${startState.hp}`);

  // Wait for Shot #1 to complete naturally over real rAF frames while player stands dead center!
  await page.waitForFunction(() => window.__artilleryProbe && !window.__artilleryProbe.active, null, {
    timeout: 180000,
  });

  const p1 = await page.evaluate(() => window.__artilleryProbe);
  assert.ok(p1.shotRecord, 'Assertion 2: lastShot must be exposed');
  assert.ok(p1.impact, 'Assertion 2: impact record missing');

  // Verify Assertion 2: >=5 parabola samples, y rises then falls, impact error vs target < 0.5m
  assert.ok(
    p1.samples.length >= 5,
    `Assertion 2: expected >=5 parabola samples, got ${p1.samples.length}`,
  );
  let peakIdx = 0;
  for (let i = 1; i < p1.samples.length; i++) {
    if (p1.samples[i].y > p1.samples[peakIdx].y) peakIdx = i;
  }
  const y0 = p1.samples[0].y;
  const yPeak = p1.samples[peakIdx].y;
  const yLast = p1.samples[p1.samples.length - 1].y;
  assert.ok(
    peakIdx > 0 && peakIdx < p1.samples.length - 1 && yPeak > y0 + 0.5 && yLast < yPeak - 1.5,
    `Assertion 2: y did not rise then fall: [${p1.samples.map((s) => s.y.toFixed(2)).join(', ')}]`,
  );
  const impactErr = Math.hypot(
    p1.impact.impactPos.x - p1.shotRecord.target.x,
    p1.impact.impactPos.y - p1.shotRecord.target.y,
    p1.impact.impactPos.z - p1.shotRecord.target.z,
  );
  assert.ok(impactErr < 0.5, `Assertion 2: impact error ${impactErr.toFixed(3)}m >= 0.5m`);

  // Verify Assertion 3: ground telegraph appeared <=200ms after launch & stayed visible until impact
  assert.notEqual(p1.telegraphDelayMs, null, 'Assertion 3: ground telegraph never appeared');
  assert.ok(
    p1.telegraphDelayMs <= 200,
    `Assertion 3: telegraph delay ${p1.telegraphDelayMs.toFixed(1)}ms > 200ms`,
  );
  assert.equal(p1.telegraphAlwaysVisible, true, 'Assertion 3: telegraph disappeared before impact');
  assert.ok(p1.minRingScale < 0.35, `Assertion 3: countdown ring failed to shrink (${p1.minRingScale})`);

  // Verify Assertion 4a: standing still at target center takes damage
  assert.ok(
    p1.hpAfter < p1.hpBefore,
    `Assertion 4a: stationary center player did not lose HP (${p1.hpBefore} -> ${p1.hpAfter})`,
  );
  assert.equal(p1.impact.hitPlayer, true);

  let sawProjectileEntityInScene = p1.sawProjectileInScene;
  let maxArtilleryTris = p1.maxTris;

  log(
    `ASSERTION 2+3+4a PASS — samples=${p1.samples.length} y=[${y0.toFixed(2)} -> peak ${yPeak.toFixed(2)} -> ${yLast.toFixed(2)}] impactErr=${impactErr.toFixed(4)}m telegraphDelay=${p1.telegraphDelayMs.toFixed(0)}ms minRing=${p1.minRingScale.toFixed(2)} hp=${p1.hpBefore}->${p1.hpAfter}`,
  );

  // ── SCREENSHOT 1 & 2 (390x844): artillery-telegraph.png + artillery-impact.png ──
  // Advance cleanly to Shot #2 launch at player (0, 7), step camera slightly off-axis to (2.4, 13.6)
  // pitching -8 deg toward (0, -3) so BOTH the huge vivid ground warning ring AND the curved parabolic
  // shell trail from the Boss are unmistakably clear on 390x844 portrait!
  const shot2 = await page.evaluate(
    ([prevId, vx, vz, yaw]) => {
      window.__test.setPaused(true);
      let s = window.__artillery.lastShot;
      for (let i = 0; i < 120 && (!s || s.id <= prevId); i++) {
        window.__test.stepSim(50, 50, false);
        s = window.__artillery.lastShot;
      }
      window.__test.teleport(vx, vz, yaw, -8);
      const targetProgressMs = Math.round(s.flightTime * 1000 * 0.52);
      window.__test.stepSim(targetProgressMs, 40, true);
      return {
        id: s.id,
        flightTime: s.flightTime,
        remainingMs: Math.max(0, Math.round(s.flightTime * 1000 - targetProgressMs)),
        tris: window.__artillery.tris,
      };
    },
    [p1.shotId, 2.4, 13.6, yawDegTo(2.4, 13.6, 0, -2.5)],
  );
  if (shot2.tris > maxArtilleryTris) maxArtilleryTris = shot2.tris;

  // Capture Screenshot 1: artillery-telegraph.png (already paused & freshly rendered!)
  {
    const outPath = path.join(SHOTS_DIR, 'artillery-telegraph.png');
    await page.waitForTimeout(80);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    const sz = fs.statSync(outPath).size;
    assert.ok(sz > 8000, `artillery-telegraph.png looks blank (${sz} bytes)`);
    log(`saved artillery-telegraph.png (${(sz / 1024).toFixed(1)} KB)`);
  }

  // Step forward to exact detonation moment (+110ms into layered fiery fireball & expanding shockwave ring)
  await page.evaluate((remMs) => {
    window.__test.stepSim(remMs + 110, 40, true);
  }, shot2.remainingMs);
  {
    const outPath = path.join(SHOTS_DIR, 'artillery-impact.png');
    await page.waitForTimeout(80);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    const sz = fs.statSync(outPath).size;
    assert.ok(sz > 8000, `artillery-impact.png looks blank (${sz} bytes)`);
    log(`saved artillery-impact.png (${(sz / 1024).toFixed(1)} KB)`);
  }

  // ── ASSERTION 4b + SCREENSHOT 3 (390x844): REAL player movement dodge during telegraph -> 0 damage! ──
  // Resume live loop, place player at (0, 7) facing Boss, advance to exact Shot #3 launch, then hold real
  // KeyD + KeyS (full move speed) over real live frames until impact -> assert 0 HP lost & capture empty blast!
  await page.evaluate(
    ([px, pz, yaw]) => {
      window.__test.teleport(px, pz, yaw, -6);
      const prevId = window.__artillery.lastShot?.id ?? 0;
      for (let i = 0; i < 120; i++) {
        window.__test.stepSim(50, 50, false);
        if ((window.__artillery.lastShot?.id ?? 0) > prevId) break;
      }
      window.__test.stepSim(0, 16, true);
      window.__test.setPaused(false);
    },
    [TARGET_X, TARGET_Z, yawDegTo(TARGET_X, TARGET_Z, BOSS_X, BOSS_Z)],
  );

  const dodgeShot = await page.evaluate(() => ({
    shot: window.__artillery.lastShot,
    hpBefore: window.__state.hp,
    hitsBefore: window.__artillery.totalHitsDealt,
  }));
  assert.ok(dodgeShot.shot && dodgeShot.shot.id > shot2.id, 'Assertion 4b: dodge shot did not launch');

  // Hold REAL keyboard movement (KeyD + KeyS) over REAL live frames until impact!
  await page.keyboard.down('KeyD');
  await page.keyboard.down('KeyS');
  await page.waitForFunction(
    (id) => window.__artillery?.lastImpact?.id === id,
    dodgeShot.shot.id,
    { timeout: 120000 },
  );
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyS');

  const afterDodge = await page.evaluate(() => ({
    hp: window.__state.hp,
    x: window.__state.x,
    z: window.__state.z,
    totalHitsDealt: window.__artillery.totalHitsDealt,
    lastImpact: window.__artillery.lastImpact,
  }));

  assert.ok(
    afterDodge.hp >= dodgeShot.hpBefore - 1e-6,
    `Assertion 4b: dodging player lost HP (${dodgeShot.hpBefore} -> ${afterDodge.hp}), dist=${afterDodge.lastImpact.playerDist}m`,
  );
  assert.equal(
    afterDodge.totalHitsDealt,
    dodgeShot.hitsBefore,
    `Assertion 4b: artillery totalHitsDealt incremented during dodge (${dodgeShot.hitsBefore} -> ${afterDodge.totalHitsDealt})`,
  );
  assert.equal(afterDodge.lastImpact.hitPlayer, false, 'Assertion 4b: dodged impact must have hitPlayer=false');
  assert.ok(
    afterDodge.lastImpact.playerDist > dodgeShot.shot.blastRadius,
    `Assertion 4b: player only reached ${afterDodge.lastImpact.playerDist}m (radius ${dodgeShot.shot.blastRadius}m)`,
  );

  // Turn camera from player's escaped position toward the still-exploding empty blast zone & capture artillery-dodge.png
  await page.evaluate(
    ([px, pz, tx, tz]) => {
      window.__test.setPaused(true);
      const yaw = (Math.atan2(-(tx - px), -(tz - pz)) * 180) / Math.PI;
      window.__test.teleport(px, pz, yaw, -7);
      window.__test.stepSim(50, 50, true);
    },
    [afterDodge.x, afterDodge.z, dodgeShot.shot.target.x, dodgeShot.shot.target.z],
  );
  {
    const outPath = path.join(SHOTS_DIR, 'artillery-dodge.png');
    await page.waitForTimeout(80);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    const sz = fs.statSync(outPath).size;
    assert.ok(sz > 8000, `artillery-dodge.png looks blank (${sz} bytes)`);
    log(`saved artillery-dodge.png (${(sz / 1024).toFixed(1)} KB)`);
  }

  log(
    `ASSERTION 4b PASS — real-input dodge reached dist=${afterDodge.lastImpact.playerDist.toFixed(2)}m (> ${dodgeShot.shot.blastRadius}m), 0 damage taken (HP ${dodgeShot.hpBefore.toFixed(1)} -> ${afterDodge.hp.toFixed(1)}, hits=${afterDodge.totalHitsDealt})`,
  );

  // ── ASSERTION 1 (30s stationary <0.05m) & ASSERTION 5 (60s meleeHitsDealt===0 + projectile in scene) ──
  // Run the FULL remaining real game simulation loop in 50ms steps up to 30s and 60s (including point-blank
  // proximity to Boss AND Enraged phase hpPct <= 0.35 3-shell fan barrage!), asserting every single step!
  const endurance = await page.evaluate(
    ([t0Ms, bossX0, bossZ0]) => {
      window.__test.setPaused(true);
      let checked30 = false;
      let dispAt30 = 0;
      let shotsAt30 = 0;
      let maxDisp = 0;
      let maxTris = window.__artillery.tris;
      let sawProj = window.__sceneStats().projectileObjects.length > 0;
      let enragedTriggered = false;
      let maxSalvoSimultaneous = 0;

      // Move player right next to Boss (1.8m) to prove ZERO melee hits even at point-blank!
      window.__test.teleport(bossX0, bossZ0 + 1.8, 0, 0);

      for (let step = 0; step < 2000; step++) {
        window.__test.stepSim(50, 50, false);
        const elapsed = window.__anim.simTimeMs - t0Ms;
        const disp = Math.hypot(window.__boss.x - bossX0, window.__boss.z - bossZ0);
        if (disp > maxDisp) maxDisp = disp;
        if (window.__artillery.tris > maxTris) maxTris = window.__artillery.tris;
        if (window.__artillery.activeProjectiles.length > maxSalvoSimultaneous) {
          maxSalvoSimultaneous = window.__artillery.activeProjectiles.length;
        }
        if (window.__sceneStats().projectileObjects.length > 0) sawProj = true;

        if (window.__boss.meleeHitsDealt !== 0) {
          return { ok: false, reason: `meleeHitsDealt=${window.__boss.meleeHitsDealt} at ${elapsed}ms` };
        }
        if (disp >= 0.05) {
          return { ok: false, reason: `boss displaced ${disp}m at ${elapsed}ms` };
        }

        // Dodge incoming blasts so player stays alive across the full 60s fight
        const tg = window.__artillery.activeTelegraphs[0];
        if (tg && tg.progress > 0.5) {
          const sx = tg.target.x > 0 ? tg.target.x - 5.5 : tg.target.x + 5.5;
          const sz = Math.min(12, tg.target.z + 2.5);
          window.__test.teleport(sx, sz, 0, 0);
        }

        if (!checked30 && elapsed >= 30000) {
          checked30 = true;
          dispAt30 = disp;
          shotsAt30 = window.__artillery.totalShotsFired;
        }
        if (!enragedTriggered && elapsed >= 38000) {
          enragedTriggered = true;
          window.__test.damageBoss(1400, 'body'); // 30% HP -> Enraged 3-shell barrage
        }
        if (elapsed >= 60000) {
          return {
            ok: true,
            elapsedMs: elapsed,
            dispAt30,
            shotsAt30,
            maxDisp,
            maxTris,
            sawProj,
            maxSalvoSimultaneous,
            meleeHitsDealt: window.__boss.meleeHitsDealt,
            totalShots: window.__artillery.totalShotsFired,
            bossTris: window.__boss.tris,
          };
        }
      }
      return { ok: false, reason: 'did not reach 60000ms' };
    },
    [startState.simTimeMs, startState.bossX, startState.bossZ],
  );

  assert.equal(endurance.ok, true, `Endurance check failed: ${endurance.reason}`);
  if (endurance.sawProj) sawProjectileEntityInScene = true;
  if (endurance.maxTris > maxArtilleryTris) maxArtilleryTris = endurance.maxTris;

  assert.ok(endurance.dispAt30 < 0.05, `Assertion 1: 30s displacement ${endurance.dispAt30}m >= 0.05m`);
  assert.equal(endurance.meleeHitsDealt, 0, 'Assertion 5: meleeHitsDealt must be 0');
  assert.equal(sawProjectileEntityInScene, true, 'Assertion 5: projectile entity never appeared in scene');
  assert.ok(maxArtilleryTris <= 1500, `Artillery tris ${maxArtilleryTris} > 1500`);

  log(
    `ASSERTION 1 PASS — at 30.0s Boss displacement=${endurance.dispAt30.toFixed(5)}m (< 0.05m), shots=${endurance.shotsAt30}`,
  );
  log(
    `ASSERTION 5 PASS — at ${(endurance.elapsedMs / 1000).toFixed(1)}s meleeHitsDealt=0, sawProjectileInScene=true, totalShots=${endurance.totalShots}, maxSalvo=${endurance.maxSalvoSimultaneous}, maxDisp=${endurance.maxDisp.toFixed(5)}m, bossTris=${endurance.bossTris}, maxArtilleryTris=${maxArtilleryTris} (<=1500)`,
  );

  // ==========================================================================
  // PART B: Wide 1280x720 Landscape — artillery-wide.png (Full Side-Profile Parabolic Arc)
  // ==========================================================================
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(
    ([cx, cz, yaw]) => {
      window.__test.setPaused(true);
      const touchUi = document.getElementById('touch-ui');
      if (touchUi) touchUi.style.display = 'none';
      // Place Boss at (18.5, 6.5) and Player at (3.5, 7.5) across wide-open south-east deck lane (15m apart)
      window.__test.teleport(3.5, 7.5, -86, 0);
      window.__test.positionBoss(18.5, 6.5, true);
      // Step until Boss launches a crisp Phase 1 parabolic shot
      for (let i = 0; i < 80; i++) {
        window.__test.stepSim(50, 50, false);
        if (window.__artillery.activeProjectiles.length > 0) break;
      }
      const s = window.__artillery.lastShot;
      // Move camera to unobstructed side-profile point (11.0, 18.8) looking at midpoint (11.0, 7.0), pitch +9 deg
      window.__test.teleport(cx, cz, yaw, 9);
      // Advance to 64% flight so the full parabolic contrail curves from Boss (right) over apex to diving shell & red target (left)!
      window.__test.stepSim(Math.round(s.flightTime * 1000 * 0.64), 40, true);
    },
    [11.0, 18.8, yawDegTo(11.0, 18.8, 11.0, 7.0)],
  );
  {
    const outPath = path.join(SHOTS_DIR, 'artillery-wide.png');
    await page.waitForTimeout(100);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
    const sz = fs.statSync(outPath).size;
    assert.ok(sz > 8000, `artillery-wide.png looks blank (${sz} bytes)`);
    log(`saved artillery-wide.png (${(sz / 1024).toFixed(1)} KB)`);
  }

  await portraitCtx.close();

  // ── ASSERTION 6: Zero console errors, zero page errors, zero failed requests ──
  assert.deepEqual(pageErrors, [], `Assertion 6: pageErrors: ${pageErrors.join('; ')}`);
  assert.deepEqual(consoleErrors, [], `Assertion 6: consoleErrors: ${consoleErrors.join('; ')}`);
  assert.deepEqual(failedRequests, [], `Assertion 6: failedRequests: ${failedRequests.join('; ')}`);
  log('ASSERTION 6 PASS — consoleErrors=0, pageErrors=0, failedRequests=0');
  log('ALL 6 ARTILLERY E2E ASSERTIONS PASSED!');
} finally {
  await browser.close();
  if (serverInfo.server) {
    await new Promise((r) => serverInfo.server.close(r));
  }
}
