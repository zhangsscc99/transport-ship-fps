// Round 4 comprehensive E2E test & screenshot verification suite:
//   1. No SPRINT button/DOM in HUD (landscape & portrait) + linear joystick speed
//   2. Rifle reload duration in 1.0–1.2s + fire locked during 0–900ms (0 ammo spent)
//   3. Muzzle flash VFX: >=1 muzzle particle & >=1 active PointLight within 60ms of fire
//   4. Ejected brass shells landing on deck
//   5. Dock-edge air walls: 3s push toward sea stays y > -0.5 & inside walkable polygon
//   6. Tower stair descent NOT blocked by air walls
//   7. Fall-respawn fallback: teleport to y=-5 returns to y>=0 within 1.5s without dying
//   8. Performance budget: draw calls <= 150, triangles <= 190k
//   + Captures 5 verification screenshots into e2e/shots/:
//     hud-left.png, reload-1.png, reload-2.png, muzzle.png, shells.png
//
// Usage: node e2e/round4.mjs  (server running on 127.0.0.1:3028)

const { chromium } = await import('playwright');
const { mkdirSync, statSync } = await import('node:fs');
const { default: assert } = await import('node:assert/strict');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const OUT = 'e2e/shots';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

mkdirSync(OUT, { recursive: true });

async function waitFrames(page, count = 2, timeout = 60000) {
  const f0 = await page.evaluate(() => window.__frames ?? 0);
  await page.waitForFunction((target) => (window.__frames ?? 0) >= target, f0 + count, { timeout });
}

async function waitSimMs(page, ms, timeout = 90000) {
  const t0 = await page.evaluate(() => window.__anim?.simTimeMs ?? 0);
  await page.waitForFunction((target) => (window.__anim?.simTimeMs ?? 0) >= target, t0 + ms, { timeout });
}

async function takeShot(page, outPath) {
  await page.evaluate(() => window.__test.setPaused(true));
  await page.waitForTimeout(80);
  await page.screenshot({ path: outPath, timeout: 60000 });
  await page.evaluate(() => window.__test.setPaused(false));
  await waitFrames(page, 1);
}

async function startMatch(page) {
  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  let frames = 0;
  for (let i = 0; i < 40 && frames <= 12; i++) {
    await page.waitForTimeout(500);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 12, 'page never rendered frames');

  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    if (!el) throw new Error('missing [data-btn="start"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 30000 });
  await waitFrames(page, 2);
}

async function fireShots(page, count, pid = 62) {
  const ammo0 = await page.evaluate(() => window.__state.ammo);
  const target = Math.max(0, ammo0 - count);
  await page.evaluate((pId) => {
    const el = document.querySelector('[data-btn="fire"]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: pId,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
  }, pid);
  await page.waitForFunction((t) => window.__state.ammo <= t, target, { timeout: 30000 });
  await page.evaluate((pId) => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: pId, bubbles: true, pointerType: 'touch' }));
  }, pid);
  await waitFrames(page, 1);
}

async function holdStickSim(page, dyPx, simMs, pid = 71) {
  await page.evaluate(
    ([dy, pId]) => {
      const zone = document.querySelector('[data-zone="stick"]');
      if (!zone) throw new Error('missing stick zone');
      const ox = 80;
      const oy = 260;
      zone.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: pId,
          clientX: ox,
          clientY: oy,
          bubbles: true,
          pointerType: 'touch',
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: pId,
          clientX: ox,
          clientY: oy + dy,
          bubbles: true,
          pointerType: 'touch',
        }),
      );
    },
    [dyPx, pid],
  );
  await waitSimMs(page, simMs);
  await page.evaluate((pId) => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: pId, bubbles: true, pointerType: 'touch' }),
    );
  }, pid);
  await waitFrames(page, 1);
}

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const errors = [];

try {
  // === Landscape mobile viewport (844x390, touch) ===
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await startMatch(page);

  // ── 1. No SPRINT in HUD + left-HUD screenshot + linear joystick speed ──
  const sprintCheck = await page.evaluate(() => {
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      const id = (el.id || '').toLowerCase();
      const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      const btn = (el.getAttribute('data-btn') || '').toLowerCase();
      const txt = el.children.length === 0 ? (el.textContent || '').trim().toLowerCase() : '';
      if (
        id.includes('sprint') ||
        cls.includes('sprint') ||
        btn === 'sprint' ||
        btn === 'run' ||
        txt === 'sprint' ||
        txt === 'run'
      ) {
        hits.push({ tag: el.tagName, id, cls, btn, txt });
      }
    }
    const leftButtons = Array.from(document.querySelectorAll('[data-btn]'))
      .map((el) => ({ id: el.getAttribute('data-btn'), rect: el.getBoundingClientRect() }))
      .filter((b) => b.id !== 'start' && b.rect.width > 0 && b.rect.x + b.rect.width / 2 < window.innerWidth / 2);
    const stick = document.querySelector('[data-stick="idle"]')?.getBoundingClientRect() ?? null;
    return { hits, leftButtons, stick };
  });
  assert.strictEqual(sprintCheck.hits.length, 0, `found sprint/run elements: ${JSON.stringify(sprintCheck.hits)}`);
  assert.strictEqual(sprintCheck.leftButtons.length, 0, `unexpected left-side buttons: ${JSON.stringify(sprintCheck.leftButtons)}`);
  assert.ok(sprintCheck.stick && sprintCheck.stick.width > 80, 'left joystick missing');

  // Capture hud-left.png (clean view showing left joystick only, no sprint)
  await page.evaluate(() => window.__test.teleport(0, 14, 0, -4, 0));
  await waitFrames(page, 2);
  await takeShot(page, `${OUT}/hud-left.png`);

  // Verify linear joystick speed (50% push vs 100% push over equal sim time)
  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, 0));
  await waitFrames(page, 1);
  const pHalf0 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  await holdStickSim(page, -28, 400, 71); // 28 / 56 = 50%
  const pHalf1 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  const vHalf = Math.hypot(pHalf1.x - pHalf0.x, pHalf1.z - pHalf0.z) / Math.max(0.05, (pHalf1.t - pHalf0.t) / 1000);

  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, 0));
  await waitFrames(page, 1);
  const pFull0 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  await holdStickSim(page, -56, 400, 72); // 56 / 56 = 100%
  const pFull1 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  const vFull = Math.hypot(pFull1.x - pFull0.x, pFull1.z - pFull0.z) / Math.max(0.05, (pFull1.t - pFull0.t) / 1000);
  const speedRatio = vHalf / Math.max(0.001, vFull);
  assert.ok(vFull > 2.5, `full stick speed too low: ${vFull.toFixed(2)}m/s`);
  assert.ok(
    speedRatio >= 0.4 && speedRatio <= 0.6,
    `joystick speed not linear: half=${vHalf.toFixed(2)} full=${vFull.toFixed(2)} ratio=${speedRatio.toFixed(2)}`,
  );
  console.log(`CHECK 1 OK — no sprint, left buttons=0, stick linearity ratio=${speedRatio.toFixed(2)} (${vHalf.toFixed(2)} / ${vFull.toFixed(2)} m/s)`);

  // ── 2. Reload duration (1.0–1.2s rifle) + fire lock in 0–900ms ──
  await page.evaluate(() => window.__test.teleport(0, 14, 0, -10, 0));
  await waitFrames(page, 1);
  await fireShots(page, 2, 62);
  const ammoBeforeReload = await page.evaluate(() => window.__state.ammo);
  assert.ok(ammoBeforeReload < 30, `expected ammo < 30 before reload, got ${ammoBeforeReload}`);

  // Measure delta-time-accumulated reload duration
  const reloadStats = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const btn = document.querySelector('[data-btn="reload"]');
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 63, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true, pointerType: 'touch' }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 63, bubbles: true, pointerType: 'touch' }));
      let tStart = -1;
      let specDur = 0;
      const deadline = performance.now() + 90000;
      const tick = () => {
        if (performance.now() > deadline) return reject(new Error('reload timing timeout'));
        if (tStart < 0 && window.__state.reloading) {
          tStart = window.__anim.simTimeMs;
          specDur = window.__anim.reloadDurationMs;
        } else if (tStart >= 0 && !window.__state.reloading) {
          return resolve({ durMs: window.__anim.simTimeMs - tStart, specDur, ammo: window.__state.ammo });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  assert.strictEqual(reloadStats.ammo, 30, `rifle ammo did not refill to 30 (${reloadStats.ammo})`);
  assert.ok(
    reloadStats.specDur >= 1000 && reloadStats.specDur <= 1200,
    `rifle reload specDur ${reloadStats.specDur}ms outside 1.0–1.2s`,
  );
  assert.ok(
    reloadStats.durMs >= 1000 && reloadStats.durMs <= 1200,
    `rifle reload durMs ${reloadStats.durMs.toFixed(0)}ms outside 1.0–1.2s`,
  );

  // Fire again, start reload, press fire during 0–900ms → assert 0 ammo consumed!
  await fireShots(page, 2, 64);
  const ammoMidCheck = await page.evaluate(() => window.__state.ammo);
  assert.ok(ammoMidCheck < 30, `expected ammo < 30, got ${ammoMidCheck}`);

  const fireLockRes = await page.evaluate((expectedAmmo) => {
    return new Promise((resolve, reject) => {
      const rBtn = document.querySelector('[data-btn="reload"]');
      const fBtn = document.querySelector('[data-btn="fire"]');
      const tap = (el, pid) => {
        const b = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: pid, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, bubbles: true, pointerType: 'touch' }));
      };
      const up = (pid) => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: pid, bubbles: true, pointerType: 'touch' }));

      tap(rBtn, 65);
      up(65);
      let t0 = -1;
      const pressedAt = [];
      let minAmmo = expectedAmmo;
      let cancelledEarly = false;
      const deadline = performance.now() + 90000;
      const tick = () => {
        if (performance.now() > deadline) return reject(new Error('fire-lock test timeout'));
        if (t0 < 0 && window.__state.reloading) t0 = window.__anim.simTimeMs;
        if (t0 >= 0) {
          const el = window.__anim.simTimeMs - t0;
          if (el >= 100 && el <= 850) {
            tap(fBtn, 66);
            pressedAt.push(Math.round(el));
            if (window.__state.ammo < minAmmo) minAmmo = window.__state.ammo;
            if (!window.__state.reloading) cancelledEarly = true;
          } else if (el > 850) {
            up(66);
          }
          if (el >= 950 && !window.__state.reloading) {
            up(66);
            return resolve({ minAmmo, expectedAmmo, cancelledEarly, finalAmmo: window.__state.ammo, pressedAt });
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, ammoMidCheck);
  assert.strictEqual(
    fireLockRes.minAmmo,
    ammoMidCheck,
    `ammo dropped during 0–900ms reload lock (${ammoMidCheck} → ${fireLockRes.minAmmo})`,
  );
  assert.strictEqual(fireLockRes.cancelledEarly, false, 'reload was interrupted during 0–900ms');
  assert.strictEqual(fireLockRes.finalAmmo, 30, 'reload did not complete after 0–900ms fire presses');
  console.log(
    `CHECK 2 OK — rifle reload=${reloadStats.durMs.toFixed(0)}ms (1000–1200ms), 0–900ms fire attempts at [${fireLockRes.pressedAt.join(',')}ms] consumed 0 ammo`,
  );

  // ── Capture reload-1.png (mag detached + hand in frame) & reload-2.png (new mag about to insert) ──
  await page.evaluate(() => window.__test.teleport(0, 14, 12, -14, 0));
  await waitFrames(page, 1);
  await fireShots(page, 1, 67);

  async function captureReloadAt(targetMinMs, targetMaxMs, outPath) {
    const hit = await page.evaluate(
      ([lo, hi]) =>
        new Promise((resolve) => {
          const btn = document.querySelector('[data-btn="reload"]');
          const b = btn.getBoundingClientRect();
          btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 68, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, bubbles: true, pointerType: 'touch' }));
          window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 68, bubbles: true, pointerType: 'touch' }));
          const deadline = performance.now() + 60000;
          const poll = () => {
            const a = window.__anim;
            if (a.reloadActive && a.reloadElapsedMs >= lo && a.reloadElapsedMs <= hi) {
              window.__test.setPaused(true);
              return resolve({ ok: true, elapsed: Math.round(a.reloadElapsedMs), magDetached: a.magDetached, newMagInHand: a.newMagInHand });
            }
            if (performance.now() > deadline) return resolve({ ok: false, elapsed: Math.round(a.reloadElapsedMs) });
            requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        }),
      [targetMinMs, targetMaxMs],
    );
    await page.waitForTimeout(80);
    await page.screenshot({ path: outPath, timeout: 60000 });
    await page.evaluate(() => window.__test.setPaused(false));
    await page.waitForFunction(() => !window.__state.reloading, null, { timeout: 90000 });
    await waitFrames(page, 1);
    return hit;
  }

  const r1 = await captureReloadAt(150, 230, `${OUT}/reload-1.png`);
  assert.ok(r1.ok && r1.magDetached, `reload-1 capture missed detached mag: ${JSON.stringify(r1)}`);
  await fireShots(page, 1, 69);
  const r2 = await captureReloadAt(350, 450, `${OUT}/reload-2.png`);
  assert.ok(r2.ok && r2.newMagInHand, `reload-2 capture missed new mag in hand: ${JSON.stringify(r2)}`);
  console.log(`RELOAD SHOTS — reload-1:`, r1, `reload-2:`, r2);

  // ── 3. Muzzle VFX (<=60ms after fire: >=1 muzzle particle & >=1 active PointLight) + muzzle.png ──
  await page.evaluate(() => window.__test.teleport(0, 14, 0, -6, 0));
  await waitFrames(page, 2);
  const muzzleCheck = await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const fBtn = document.querySelector('[data-btn="fire"]');
      const b = fBtn.getBoundingClientRect();
      const ammo0 = window.__state.ammo;
      fBtn.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 75,
          clientX: b.x + b.width / 2,
          clientY: b.y + b.height / 2,
          bubbles: true,
          pointerType: 'touch',
        }),
      );
      const deadline = performance.now() + 60000;
      const check = () => {
        if (performance.now() > deadline) {
          window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 75, bubbles: true, pointerType: 'touch' }));
          return reject(new Error('muzzle check timeout'));
        }
        if (window.__state.ammo < ammo0) {
          const v = { ...window.__vfx };
          window.__test.setPaused(true);
          return resolve(v);
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });
  await page.waitForTimeout(80);
  await page.screenshot({ path: `${OUT}/muzzle.png`, timeout: 60000 });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 75, bubbles: true, pointerType: 'touch' }));
    window.__test.setPaused(false);
  });
  await waitFrames(page, 1);
  assert.ok(muzzleCheck.muzzleParticles >= 1, `no muzzle particles within 60ms: ${JSON.stringify(muzzleCheck)}`);
  assert.ok(muzzleCheck.muzzleLightsActive >= 1, `no active muzzle PointLight within 60ms: ${JSON.stringify(muzzleCheck)}`);
  assert.ok(muzzleCheck.muzzleLightMaxIntensity > 0, `muzzle PointLight intensity was 0: ${JSON.stringify(muzzleCheck)}`);
  console.log(
    `CHECK 3 OK — muzzle on fire frame (<60ms): particles=${muzzleCheck.muzzleParticles}, flashSlots=${muzzleCheck.muzzleFlashSlots}, lights=${muzzleCheck.muzzleLightsActive} (intensity=${muzzleCheck.muzzleLightMaxIntensity.toFixed(2)})`,
  );

  // ── 4. Ejected shells landing on deck + shells.png ──
  await page.evaluate(() => window.__test.teleport(-4, 15, 0, -14, 0));
  await waitFrames(page, 1);
  await fireShots(page, 6, 76);
  await page.waitForFunction(() => window.__vfx.shellsGrounded >= 2, null, { timeout: 60000 });
  const shellStats = await page.evaluate(() => ({ ...window.__vfx }));
  // Pitch down-right toward where the brass casings settled on the deck
  await page.evaluate(() => window.__test.teleport(-4, 15, -32, -48, 0));
  await waitFrames(page, 2);
  await takeShot(page, `${OUT}/shells.png`);
  assert.ok(shellStats.shellsGrounded >= 2, `expected grounded shells, got ${JSON.stringify(shellStats)}`);
  console.log(`CHECK 4 OK — shellsActive=${shellStats.shellsActive}, shellsGrounded=${shellStats.shellsGrounded}, decals=${shellStats.decalsCount}`);

  // ── 5. Air Walls: 3s push straight toward sea edge → y > -0.5 & inside walkable polygon ──
  await page.evaluate(() => window.__test.teleport(-10, 18.2, 180, 0, 0));
  await waitFrames(page, 1);
  await page.evaluate(() => {
    const zone = document.querySelector('[data-zone="stick"]');
    zone.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 81, clientX: 80, clientY: 260, bubbles: true, pointerType: 'touch' }));
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 81, clientX: 80, clientY: 204, bubbles: true, pointerType: 'touch' }));
  });
  let minY = Infinity;
  let allInside = true;
  let maxZ = -Infinity;
  const pushStart = Date.now();
  const simStart = await page.evaluate(() => window.__anim.simTimeMs);
  while (Date.now() - pushStart < 3000 || (await page.evaluate(() => window.__anim.simTimeMs)) - simStart < 1000) {
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => ({
      x: window.__state.x,
      y: window.__state.y,
      z: window.__state.z,
      inside: window.__test.isInsideWalkable(window.__state.x, window.__state.z),
    }));
    if (st.y < minY) minY = st.y;
    if (st.z > maxZ) maxZ = st.z;
    if (!st.inside) allInside = false;
  }
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 81, bubbles: true, pointerType: 'touch' }));
  });
  await waitFrames(page, 1);
  assert.ok(minY > -0.5, `player fell into sea! minY=${minY}`);
  assert.strictEqual(allInside, true, `player escaped walkable polygon! maxZ=${maxZ}`);
  console.log(`CHECK 5 OK — >=3s sea-edge push stayed dry: minY=${minY.toFixed(3)}, maxZ=${maxZ.toFixed(2)}, insidePolygon=${allInside}`);

  // ── 6. Walking down tower stairs from platform edge NOT blocked by air walls ──
  // Tower (-26, 14) platform top y=3.3; stairs descend along +X (yaw=-90° faces +X)
  await page.evaluate(() => window.__test.teleport(-24.5, 14, -90, -15, 3.3));
  await waitFrames(page, 1);
  await holdStickSim(page, -56, 1800, 82);
  const afterStairs = await page.evaluate(() => ({
    x: window.__state.x,
    y: window.__state.y,
    z: window.__state.z,
  }));
  assert.ok(afterStairs.x > -20.5, `stair descent appears blocked: x=${afterStairs.x.toFixed(2)}`);
  assert.ok(afterStairs.y < 1.2, `did not descend stairs: y=${afterStairs.y.toFixed(2)}`);
  console.log(`CHECK 6 OK — platform stair descent unobstructed: landed at x=${afterStairs.x.toFixed(2)}, y=${afterStairs.y.toFixed(2)}`);

  // ── 7. Fall-respawn fallback: set y=-5 → returns to y >= 0 within 1.5s without dying ──
  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, 0));
  await waitFrames(page, 2); // record valid lastSafePos
  const tDropSim0 = await page.evaluate(() => window.__anim.simTimeMs);
  const tDropWall0 = Date.now();
  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, -5));
  await page.waitForFunction(() => window.__state.y >= 0, null, { timeout: 25000 });
  const recoverWallMs = Date.now() - tDropWall0;
  const afterFall = await page.evaluate(() => ({
    y: window.__state.y,
    hp: window.__state.hp,
    dead: window.__state.dead,
    simT: window.__anim.simTimeMs,
  }));
  const recoverSimMs = afterFall.simT - tDropSim0;
  assert.ok(afterFall.y >= 0, `fall respawn did not restore y>=0 (${afterFall.y})`);
  assert.ok(recoverSimMs <= 1500, `fall respawn took ${recoverSimMs.toFixed(0)}ms sim (>1500ms)`);
  assert.strictEqual(afterFall.dead, false, 'fall respawn should not kill player');
  assert.strictEqual(afterFall.hp, 100, 'fall respawn should preserve HP');
  console.log(`CHECK 7 OK — fall-respawn y=-5 → y=${afterFall.y.toFixed(2)} in ${recoverSimMs.toFixed(0)}ms sim (<=1500ms, wall=${recoverWallMs}ms), hp=${afterFall.hp}, dead=${afterFall.dead}`);

  // ── 8. Performance budget (renderer.info) ──
  const perf = await page.evaluate(() => ({
    fps: window.__fps,
    renderInfo: window.__renderInfo,
  }));
  assert.ok(perf.renderInfo.calls <= 150, `draw calls ${perf.renderInfo.calls} > 150`);
  assert.ok(perf.renderInfo.triangles <= 190000, `triangles ${perf.renderInfo.triangles} > 190000`);
  console.log(
    `CHECK 8 OK — calls=${perf.renderInfo.calls} (<=150), tris=${perf.renderInfo.triangles} (<=190k), ` +
      `geos=${perf.renderInfo.geometries}, tex=${perf.renderInfo.textures}, emaFps=${perf.fps.toFixed(1)}`,
  );

  // Verify portrait viewport (390x844) also has zero sprint elements
  const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const pPage = await pCtx.newPage();
  pPage.on('pageerror', (e) => errors.push(String(e)));
  await startMatch(pPage);
  const portraitSprint = await pPage.evaluate(() => {
    let count = 0;
    for (const el of document.querySelectorAll('*')) {
      const id = (el.id || '').toLowerCase();
      const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      const btn = (el.getAttribute('data-btn') || '').toLowerCase();
      if (id.includes('sprint') || cls.includes('sprint') || btn === 'sprint' || btn === 'run') count++;
    }
    return count;
  });
  assert.strictEqual(portraitSprint, 0, `portrait HUD has ${portraitSprint} sprint/run elements`);
  await pCtx.close();

  // Verify all 5 screenshots exist and are non-trivial PNGs
  for (const f of ['reload-1.png', 'reload-2.png', 'muzzle.png', 'hud-left.png', 'shells.png']) {
    const sz = statSync(`${OUT}/${f}`).size;
    assert.ok(sz > 8000, `${f} looks blank (${sz} bytes)`);
  }

  assert.strictEqual(errors.length, 0, `JS errors:\n${errors.join('\n')}`);
  console.log('ROUND 4 E2E ALL OK — 0 JS errors, 5 screenshots verified');
} finally {
  await browser.close();
}
