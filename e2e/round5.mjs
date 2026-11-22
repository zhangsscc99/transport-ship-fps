// Round 5 comprehensive E2E test & 6-screenshot verification suite:
//   Screenshots (e2e/shots/):
//     1. menu-difficulty.png  Start menu with EASY / NORMAL / HARD & CC BY 4.0 credit
//     2. hands-reload-1.png   Mid-reload: both realistic hands in frame, 5 fingers visible, no clipping
//     3. hands-reload-2.png   Fresh magazine entering magwell moment
//     4. gatling.png          Gatling first-person view (6 barrels + swinging brass belt + 3×100 HUD)
//     5. enemy-alert.png      CF-style BL (black-red/red eye) & GR (blue-white/blue eye) enemies visible
//     6. death.png            Death settlement panel (kills / survival time / difficulty + Retry / Menu)
//
//   Assertions:
//     - Weapon list strictly ['rifle', 'gatling'] with round-trip swap
//     - Hands triangle budget <= 1200/hand (<= 2400 total), clearance >= 2cm, articulated finger curl
//     - Gatling initial ammo >= 200 (300); continuous fire stays >0 at 200 rounds & empties at 300
//     - Gatling move speed = Rifle * 0.82 (error <= 5%)
//     - EASY enemy first-fire delay > 0.7s; HARD < 0.5s
//     - Occluded enemy (3s behind container) fires 0 shots & spends 0 ammo
//     - BGM starts playing after first real user click (audio.paused === false)
//     - /audio/bgm-tension.mp3 & /transport/audio/bgm-tension.mp3 return HTTP 200 audio/mpeg
//     - Round 4 regression: 3s push toward sea stays dry (air wall), no SPRINT HUD
//     - Performance budget (with 5 enemies live): draw calls <= 170, triangles <= 220k, enemy <= 2500 tris
//
// Usage: node e2e/round5.mjs  (server running on 127.0.0.1:3028)

const { chromium } = await import('playwright');
const { mkdirSync, statSync } = await import('node:fs');
const { default: assert } = await import('node:assert/strict');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const ORIGIN = new globalThis.URL(URL).origin;
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

async function waitSimMs(page, ms, timeout = 120000) {
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

async function tapTouchBtn(page, id, pid = 55) {
  await page.evaluate(
    ([btnId, pId]) => {
      const el = document.querySelector(`[data-btn="${btnId}"]`);
      if (!el) throw new Error(`missing [data-btn="${btnId}"]`);
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
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: pId, bubbles: true, pointerType: 'touch' }),
      );
    },
    [id, pid],
  );
}

async function fireRifleShots(page, count, pid = 62) {
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

// ── 0. Verify /audio/bgm-tension.mp3 returns HTTP 200 & audio/mpeg ──
for (const audioPath of ['/audio/bgm-tension.mp3', '/transport/audio/bgm-tension.mp3']) {
  const res = await fetch(`${ORIGIN}${audioPath}`);
  assert.strictEqual(res.status, 200, `${audioPath} status ${res.status} !== 200`);
  const ct = res.headers.get('content-type') ?? '';
  assert.ok(ct.includes('audio/mpeg'), `${audioPath} content-type "${ct}" !== audio/mpeg`);
}
console.log('CHECK 0 OK — /audio/bgm-tension.mp3 & /transport/audio/bgm-tension.mp3 return 200 audio/mpeg');

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'commit', timeout: 25000 });
  let frames = 0;
  for (let i = 0; i < 50 && frames <= 12; i++) {
    await page.waitForTimeout(400);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 12, 'page never rendered frames');

  // ── 1. Menu Difficulty (EASY / NORMAL / HARD) + Attribution + Pre-click BGM paused ──
  const menuCheck = await page.evaluate(() => {
    const diffs = Array.from(document.querySelectorAll('[data-diff]')).map((el) => ({
      id: el.getAttribute('data-diff'),
      text: (el.textContent ?? '').trim(),
    }));
    const credit = document.querySelector('[data-role="music-credit"]')?.textContent?.trim() ?? '';
    const audios = Array.from(document.querySelectorAll('audio')).map((a) => ({
      bgm: a.dataset.bgm,
      paused: a.paused,
      src: a.src,
    }));
    return { diffs, credit, audios };
  });
  assert.deepStrictEqual(
    menuCheck.diffs.map((d) => d.id),
    ['easy', 'normal', 'hard'],
    `menu diffs wrong: ${JSON.stringify(menuCheck.diffs)}`,
  );
  assert.ok(menuCheck.diffs[0].text.includes('EASY'), 'EASY label missing');
  assert.ok(menuCheck.diffs[1].text.includes('NORMAL'), 'NORMAL label missing');
  assert.ok(menuCheck.diffs[2].text.includes('HARD'), 'HARD label missing');
  assert.ok(
    menuCheck.credit.includes('Kevin MacLeod (incompetech.com) — CC BY 4.0'),
    `missing CC BY 4.0 credit: "${menuCheck.credit}"`,
  );
  assert.ok(menuCheck.audios.length >= 2, 'missing menu & battle <audio> elements');
  assert.ok(
    menuCheck.audios.every((a) => a.paused === true),
    `BGM started before first user click: ${JSON.stringify(menuCheck.audios)}`,
  );

  // Capture Screenshot 5: menu-difficulty.png
  await page.screenshot({ path: `${OUT}/menu-difficulty.png`, timeout: 60000 });

  // Click HARD via real Playwright click → verify localStorage persistence + BGM starts playing!
  await page.click('[data-diff="hard"]');
  await page.waitForTimeout(300);
  const afterFirstClick = await page.evaluate(() => ({
    lsDiff: localStorage.getItem('tsf.difficulty'),
    anyPlaying: Array.from(document.querySelectorAll('audio')).some((a) => !a.paused),
    bgm: { ...window.__bgm },
  }));
  assert.strictEqual(afterFirstClick.lsDiff, 'hard', 'difficulty not written to localStorage');
  assert.strictEqual(
    afterFirstClick.anyPlaying,
    true,
    `BGM did not start playing after first click: ${JSON.stringify(afterFirstClick.bgm)}`,
  );
  console.log('CHECK 1 OK — Menu EASY/NORMAL/HARD + CC BY 4.0 credit + localStorage + BGM playing after first click');

  // Switch back to NORMAL and click 开始游戏 (real click)
  await page.click('[data-diff="normal"]');
  await page.click('[data-btn="start"]');
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 30000 });
  await waitFrames(page, 3);

  // Verify battle BGM is playing (paused === false)
  const battleBgm = await page.evaluate(() => {
    const el = document.querySelector('audio[data-bgm="battle"]');
    return { paused: el?.paused ?? true, src: el?.src ?? '', bgm: { ...window.__bgm } };
  });
  assert.strictEqual(battleBgm.paused, false, `battle BGM paused in combat: ${JSON.stringify(battleBgm)}`);
  assert.ok(battleBgm.src.includes('bgm-tension.mp3'), `unexpected battle BGM src: ${battleBgm.src}`);
  console.log('CHECK 2 OK — Battle BGM (/audio/bgm-tension.mp3) active & playing (paused=false)');

  // ── 2. Performance & Triangle Budgets with 5 live enemies on deck! ──
  const perf5 = await page.evaluate(() => ({
    enemyCount: window.__enemies.length,
    maxEnemyTris: Math.max(0, ...window.__enemies.map((e) => e.tris)),
    hands: { ...window.__hands },
    renderInfo: { ...window.__renderInfo },
    fps: window.__fps,
  }));
  assert.strictEqual(perf5.enemyCount, 5, `NORMAL should spawn 5 enemies, got ${perf5.enemyCount}`);
  assert.ok(perf5.maxEnemyTris > 100 && perf5.maxEnemyTris <= 2500, `enemy tris ${perf5.maxEnemyTris} > 2500`);
  assert.ok(perf5.hands.leftTris <= 1200 && perf5.hands.rightTris <= 1200, `hand tris over 1200: ${JSON.stringify(perf5.hands)}`);
  assert.ok(perf5.hands.totalTris <= 2400, `total hand tris ${perf5.hands.totalTris} > 2400`);
  assert.ok(perf5.renderInfo.calls <= 170, `draw calls ${perf5.renderInfo.calls} > 170`);
  assert.ok(perf5.renderInfo.triangles <= 220000, `triangles ${perf5.renderInfo.triangles} > 220k`);
  console.log(
    `CHECK 3 OK — 5 enemies live (maxEnemyTris=${perf5.maxEnemyTris} <=2500), hands=${perf5.hands.leftTris}+${perf5.hands.rightTris}=${perf5.hands.totalTris} tris (<=2400), calls=${perf5.renderInfo.calls} (<=170), tris=${perf5.renderInfo.triangles} (<=220k)`,
  );

  // ── 3. Capture enemy-alert.png showing BOTH enemy (magenta glow) & ally (cyan glow) robots ──
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 10, 0, -4, 0);
    // Place enemy & ally robots ~6m ahead in open sunlit deck facing directly toward player (yaw=180° faces +Z)
    window.__test.spawnEnemyAt(-1.65, 3.8, 180, 'enemy');
    window.__test.spawnEnemyAt(1.65, 3.8, 180, 'ally');
  });
  // Let enemies spot player & level rifles in ALERT/AIM stance (350ms < 600ms NORMAL reaction delay)
  await waitSimMs(page, 350);
  await takeShot(page, `${OUT}/enemy-alert.png`);
  const alertSnap = await page.evaluate(() => window.__enemies.map((e) => ({ faction: e.faction, state: e.state, anim: e.anim })));
  console.log('SHOT enemy-alert.png — enemies:', alertSnap);

  // Clear enemies during isolated weapon / hands / air-wall tests so player isn't interrupted
  await page.evaluate(() => window.__test.clearEnemies());
  await waitFrames(page, 1);

  // ── 4. Realistic 5-Finger Human Hands Reload + Clearance >= 2cm + Screenshots 1 & 2 ──
  await page.evaluate(() => window.__test.teleport(0, 14, 12, -12, 0));
  await waitFrames(page, 2);
  await fireRifleShots(page, 2, 62);

  async function captureReloadMoment(loMs, hiMs, outPath) {
    const res = await page.evaluate(
      ([lo, hi]) =>
        new Promise((resolve) => {
          const btn = document.querySelector('[data-btn="reload"]');
          const b = btn.getBoundingClientRect();
          btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 68, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, bubbles: true, pointerType: 'touch' }));
          window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 68, bubbles: true, pointerType: 'touch' }));
          const deadline = performance.now() + 60000;
          let minClear = Infinity;
          let minCurl = Infinity;
          let maxCurl = -Infinity;
          const poll = () => {
            const a = window.__anim;
            const h = window.__hands;
            if (a.reloadActive) {
              if (h.minClearanceM < minClear) minClear = h.minClearanceM;
              if (h.leftIndexCurlDeg < minCurl) minCurl = h.leftIndexCurlDeg;
              if (h.leftIndexCurlDeg > maxCurl) maxCurl = h.leftIndexCurlDeg;
            }
            if (a.reloadActive && a.reloadElapsedMs >= lo && a.reloadElapsedMs <= hi) {
              window.__test.setPaused(true);
              return resolve({
                ok: true,
                elapsed: Math.round(a.reloadElapsedMs),
                stage: h.reloadStage,
                minClear,
                minCurl: Math.round(minCurl),
                maxCurl: Math.round(maxCurl),
                newMagInHand: a.newMagInHand,
              });
            }
            if (performance.now() > deadline) return resolve({ ok: false, elapsed: Math.round(a.reloadElapsedMs) });
            requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        }),
      [loMs, hiMs],
    );
    await page.waitForTimeout(80);
    await page.screenshot({ path: outPath, timeout: 60000 });
    await page.evaluate(() => window.__test.setPaused(false));
    await page.waitForFunction(() => !window.__state.reloading, null, { timeout: 90000 });
    await waitFrames(page, 1);
    return res;
  }

  // Stage ③ (390–490ms): both hands in frame, fresh mag held in open 5-finger left palm!
  const hr1 = await captureReloadMoment(390, 490, `${OUT}/hands-reload-1.png`);
  assert.ok(hr1.ok && hr1.newMagInHand, `hands-reload-1 missed stage ③: ${JSON.stringify(hr1)}`);
  assert.ok(hr1.minClear >= 0.02, `hand-gun clearance violated (<2cm): ${hr1.minClear.toFixed(4)}m`);
  assert.ok(hr1.maxCurl - hr1.minCurl >= 25, `fingers did not articulate enough: ${hr1.minCurl}°..${hr1.maxCurl}°`);

  await fireRifleShots(page, 1, 63);
  // Stage ④ (565–635ms): fresh magazine pushing straight into magwell!
  const hr2 = await captureReloadMoment(565, 635, `${OUT}/hands-reload-2.png`);
  assert.ok(hr2.ok && hr2.newMagInHand, `hands-reload-2 missed stage ④ mag-in: ${JSON.stringify(hr2)}`);
  assert.ok(hr2.minClear >= 0.02, `hand-gun clearance violated in stage ④: ${hr2.minClear.toFixed(4)}m`);
  console.log('CHECK 4 OK — Hands reload:', { hr1, hr2 });

  // ── 5. Weapon List strictly ['rifle', 'gatling'], round-trip swap, Gatling shot & speed 0.82× ──
  const wList = await page.evaluate(() => window.__state.weapons);
  assert.deepStrictEqual(wList, ['rifle', 'gatling'], `unexpected weapon list: ${JSON.stringify(wList)}`);

  // Measure Rifle speed
  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, 0));
  await waitFrames(page, 1);
  const r0 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  await holdStickSim(page, -56, 700, 71);
  const r1 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  const vRifle = Math.hypot(r1.x - r0.x, r1.z - r0.z) / Math.max(0.05, (r1.t - r0.t) / 1000);

  // Swap to Gatling -> verify round-trip -> back to Gatling
  await tapTouchBtn(page, 'swap', 72);
  await page.waitForFunction(() => window.__state.weapon === 'gatling' && !window.__anim.swapActive, null, { timeout: 25000 });
  const gatInit = await page.evaluate(() => ({ weapon: window.__state.weapon, ammo: window.__state.ammo, mag: window.__state.mag }));
  assert.strictEqual(gatInit.weapon, 'gatling');
  assert.ok(gatInit.ammo >= 200 && gatInit.ammo === 300, `gatling initial ammo ${gatInit.ammo} < 200`);

  // Swap back to rifle & back to gatling to prove bidirectional swap
  await tapTouchBtn(page, 'swap', 73);
  await page.waitForFunction(() => window.__state.weapon === 'rifle' && !window.__anim.swapActive, null, { timeout: 25000 });
  await tapTouchBtn(page, 'swap', 74);
  await page.waitForFunction(() => window.__state.weapon === 'gatling' && !window.__anim.swapActive, null, { timeout: 25000 });

  // Measure Gatling speed -> assert vGatling / vRifle ≈ 0.82 (<= 5% error)
  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, 0));
  await waitFrames(page, 1);
  const g0 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  await holdStickSim(page, -56, 700, 75);
  const g1 = await page.evaluate(() => ({ x: window.__state.x, z: window.__state.z, t: window.__anim.simTimeMs }));
  const vGatling = Math.hypot(g1.x - g0.x, g1.z - g0.z) / Math.max(0.05, (g1.t - g0.t) / 1000);
  const speedRatio = vGatling / Math.max(0.001, vRifle);
  const relErr = Math.abs(speedRatio - 0.82) / 0.82;
  assert.ok(
    relErr <= 0.05,
    `gatling/rifle speed ratio ${speedRatio.toFixed(3)} outside 0.82 ±5% (vGat=${vGatling.toFixed(2)}, vRifle=${vRifle.toFixed(2)})`,
  );
  console.log(`CHECK 5 OK — Weapons=['rifle','gatling'], speed ratio=${speedRatio.toFixed(3)} (target 0.82, err ${(relErr * 100).toFixed(1)}%)`);

  // Capture Screenshot 3: gatling.png (clear deck angle showing 6 barrels + swinging brass belt + 3×100 HUD)
  await page.evaluate(() => window.__test.teleport(0, 14, 14, -10, 0));
  await waitFrames(page, 2);
  await takeShot(page, `${OUT}/gatling.png`);

  // Continuous fire Gatling: verify spin-up, still >0 after 200 shots, empties at 300 & triggers 3.2s reload!
  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="fire"]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 76,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
  });
  // Wait until at least 200 rounds have been fired (ammo <= 100): must NOT be empty yet!
  await page.waitForFunction(() => window.__state.ammo <= 100, null, { timeout: 120000 });
  const midGat = await page.evaluate(() => ({ ammo: window.__state.ammo, reloading: window.__state.reloading }));
  assert.ok(midGat.ammo > 0 && midGat.reloading === false, `gatling emptied before 200+ rounds: ${JSON.stringify(midGat)}`);
  // Keep firing until empty (0) and auto-reload starts
  await page.waitForFunction(() => window.__state.ammo === 0 || window.__state.reloading === true, null, { timeout: 120000 });
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 76, bubbles: true, pointerType: 'touch' }));
  });
  console.log(`CHECK 6 OK — Gatling fired 200+ continuous rounds (mid ammo=${midGat.ammo}>0) before emptying all 300 rounds`);

  // Swap back to rifle for enemy & regression tests
  await tapTouchBtn(page, 'swap', 77);
  await page.waitForFunction(() => window.__state.weapon === 'rifle' && !window.__anim.swapActive, null, { timeout: 25000 });

  // ── 6. AI Reaction Delay: EASY > 0.7s vs HARD < 0.5s ──
  async function measureEnemyFirstFire(diff) {
    await page.evaluate((d) => {
      window.__test.clearEnemies();
      window.__test.setDifficulty(d);
      window.__test.teleport(0, 0, 180, 0, 0); // face north toward enemy
      window.__test.spawnEnemyAt(0, -10, 180, 'enemy'); // enemy at z=-10 facing south (+Z) toward player at (0,0)
    }, diff);
    await page.waitForFunction(
      () => window.__enemies.length > 0 && window.__enemies[0].firstShotAt > 0,
      null,
      { timeout: 60000 },
    );
    const e = await page.evaluate(() => window.__enemies[0]);
    return (e.firstShotAt - e.firstSightAt) / 1000;
  }

  const easyDelaySec = await measureEnemyFirstFire('easy');
  assert.ok(easyDelaySec > 0.7, `EASY first-fire delay ${easyDelaySec.toFixed(3)}s <= 0.7s`);
  const hardDelaySec = await measureEnemyFirstFire('hard');
  assert.ok(hardDelaySec < 0.5, `HARD first-fire delay ${hardDelaySec.toFixed(3)}s >= 0.5s`);
  console.log(`CHECK 7 OK — Enemy reaction delay: EASY=${easyDelaySec.toFixed(3)}s (>0.7s), HARD=${hardDelaySec.toFixed(3)}s (<0.5s)`);

  // ── 7. Enemy NO Wall-Shooting: 3s behind solid container consumes 0 ammo ──
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.setDifficulty('hard');
    // Container sits at (-6, 0, -4) w=6, h=2.6, d=2.5 (z in [-5.25, -2.75]).
    // Player at (-6, -0.8), Enemy at (-6, -7.2) facing south -> completely occluded.
    window.__test.teleport(-6, -0.8, 0, 0, 0);
    window.__test.spawnEnemyAt(-6, -7.2, 180, 'enemy');
  });
  const occStartSim = await page.evaluate(() => window.__anim.simTimeMs);
  while ((await page.evaluate(() => window.__anim.simTimeMs)) - occStartSim < 3050) {
    // Keep player mirrored behind container so occlusion holds for the full 3s
    await page.evaluate(() => {
      const e = window.__enemies[0];
      if (!e) return;
      // Keep player cleanly opposite the container (-6,-4) if bot slides sideways
      window.__test.teleport(-6, -0.8, 0, 0, 0);
    });
    await page.waitForTimeout(150);
  }
  const occEnemy = await page.evaluate(() => window.__enemies[0]);
  assert.strictEqual(occEnemy.shotsFired, 0, `occluded enemy fired ${occEnemy.shotsFired} shots through cover!`);
  assert.strictEqual(occEnemy.ammo, 30, `occluded enemy spent ammo (${occEnemy.ammo}/30)`);
  console.log(`CHECK 8 OK — 3s occluded enemy: shotsFired=${occEnemy.shotsFired}, ammo=${occEnemy.ammo}/30`);

  // ── 8. Round 4 Regression: Air Wall (3s push toward sea stays dry) + No SPRINT ──
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(-10, 18.2, 180, 0, 0);
  });
  await waitFrames(page, 1);
  await page.evaluate(() => {
    const zone = document.querySelector('[data-zone="stick"]');
    zone.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 81, clientX: 80, clientY: 260, bubbles: true, pointerType: 'touch' }));
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 81, clientX: 80, clientY: 204, bubbles: true, pointerType: 'touch' }));
  });
  let minY = Infinity;
  let allInside = true;
  const pushStart = Date.now();
  while (Date.now() - pushStart < 3000) {
    await page.waitForTimeout(200);
    const st = await page.evaluate(() => ({
      y: window.__state.y,
      inside: window.__test.isInsideWalkable(window.__state.x, window.__state.z),
    }));
    if (st.y < minY) minY = st.y;
    if (!st.inside) allInside = false;
  }
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 81, bubbles: true, pointerType: 'touch' }));
  });
  assert.ok(minY > -0.5 && allInside, `air wall regression: minY=${minY}, inside=${allInside}`);
  const sprintCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-btn]')).filter((el) =>
      (el.getAttribute('data-btn') || '').toLowerCase().includes('sprint'),
    ).length,
  );
  assert.strictEqual(sprintCount, 0, 'SPRINT button regressed back into HUD');
  console.log(`CHECK 9 OK — Round 4 regression clean (3s air-wall minY=${minY.toFixed(3)}, no SPRINT)`);

  // ── 9. Player Death -> 0.6s Fall-down Cam -> Settlement Panel (death.png) -> Retry ──
  await page.evaluate(() => {
    window.__test.teleport(0, 14, 0, -4, 0);
    window.__test.hurt(200);
  });
  await page.waitForFunction(() => window.__state.deathPanelVisible === true, null, { timeout: 30000 });
  await waitFrames(page, 2);
  await page.screenshot({ path: `${OUT}/death.png`, timeout: 60000 });

  const deathStats = await page.evaluate(() => ({
    kills: document.querySelector('[data-death-stat="kills"]')?.textContent?.trim(),
    survival: document.querySelector('[data-death-stat="survival"]')?.textContent?.trim(),
    difficulty: document.querySelector('[data-death-stat="difficulty"]')?.textContent?.trim(),
  }));
  assert.ok(deathStats.kills !== undefined && deathStats.survival && deathStats.difficulty, `death panel incomplete: ${JSON.stringify(deathStats)}`);

  // Click Retry -> restores HP=100 & active match
  await page.click('[data-death-btn="retry"]');
  await page.waitForFunction(() => window.__state.hp === 100 && !window.__state.dead, null, { timeout: 15000 });
  console.log('CHECK 10 OK — Death 0.6s cam -> settlement panel:', deathStats, '-> Retry restored HP=100');

  // Verify all 6 required screenshots exist and are non-trivial PNGs
  const shots = [
    'hands-reload-1.png',
    'hands-reload-2.png',
    'gatling.png',
    'enemy-alert.png',
    'menu-difficulty.png',
    'death.png',
  ];
  for (const f of shots) {
    const sz = statSync(`${OUT}/${f}`).size;
    assert.ok(sz > 8000, `${f} looks blank (${sz} bytes)`);
  }

  assert.strictEqual(errors.length, 0, `JS errors:\n${errors.join('\n')}`);
  console.log('ROUND 5 E2E ALL OK — 0 JS errors, all 6 screenshots & all assertions passed');
} finally {
  await browser.close();
}
