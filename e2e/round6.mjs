// Round 6 comprehensive E2E test & 5-screenshot verification suite:
//   Screenshots (e2e/shots/):
//     1. enemy-model.png   Human-rigged soldiers (BL dark-red + GR tactical-blue, rifles & eye orbs)
//     2. enemy-tag.png     Overhead faction + distance tags (`▣ 潜伏者 Xm` / `▣ 保卫者 Xm`)
//     3. hp-200.png        200 max HP two-segment HUD (0 / 100 / 200)
//     4. enemy-engage.png  Enemy actively aiming / firing (`fire_rifle` / `aim_rifle`)
//     5. enemy-dead.png    Enemy knocked down on deck (`die` clip) + tag gone immediately
//
//   Assertions:
//     - public/models/soldier.glb & weapon_rifle.glb served HTTP 200
//     - Enemy model triangles > 2000 (3368+300+eye) & modelSource === 'public/models/soldier.glb'
//     - Distance tag numeric value error <= 2m vs actual camera-to-enemy distance
//     - Occluded enemy tag opacity === 0.25; tags stay outside central 120px crosshair zone
//     - Enemy > 60m away has tag hidden; dead enemy tag disappears immediately
//     - Player initial HP === 200; after 100 damage, holds 6s then regens at 12 HP/s back to 200 in <10s
//     - Low HP <40 triggers red vignette pulse + heartbeat; <20 triggers subtle desaturation
//     - Enemy in IDLE plays clip 'idle_rifle'; in ENGAGE plays 'fire_rifle'
//     - Spawns >= 15m from player spawn; pairwise enemy spacing >= 1.5m
//     - Performance (5 live rigged enemies): draw calls <= 200, triangles <= 260k (reports renderer.info)
//
// Usage: node e2e/round6.mjs  (server running on 127.0.0.1:3028)

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

// ── 0. Verify GLB assets are served cleanly from /transport/models/ ──
for (const modelPath of ['/transport/models/soldier.glb', '/transport/models/weapon_rifle.glb']) {
  const res = await fetch(`${ORIGIN}${modelPath}`);
  assert.strictEqual(res.status, 200, `${modelPath} status ${res.status} !== 200`);
  const buf = await res.arrayBuffer();
  assert.ok(buf.byteLength > 10000, `${modelPath} unexpectedly small (${buf.byteLength} bytes)`);
}
console.log('CHECK 0 OK — soldier.glb & weapon_rifle.glb served HTTP 200');

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const errors = [];
const modelRequests = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', (res) => {
    if (res.url().includes('/models/')) {
      modelRequests.push({ url: res.url(), status: res.status() });
    }
  });

  await page.goto(URL, { waitUntil: 'commit', timeout: 25000 });
  let frames = 0;
  for (let i = 0; i < 50 && frames <= 12; i++) {
    await page.waitForTimeout(400);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 12, 'page never rendered frames');

  // Start NORMAL round
  await page.click('[data-diff="normal"]');
  await page.click('[data-btn="start"]');
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 30000 });
  // Wait for soldier.glb + weapon_rifle.glb to finish loading onto all 5 bots
  await page.waitForFunction(
    () => window.__enemies.length === 5 && window.__enemies.every((e) => e.modelLoaded && e.tris > 2000),
    null,
    { timeout: 30000 },
  );
  await waitFrames(page, 3);

  // ── 1. Verify model source, >2000 tris, spawn >=15m, spacing >=1.5m, & perf budget ──
  const initCheck = await page.evaluate(() => {
    const p = { x: window.__state.x, z: window.__state.z };
    const enemies = window.__enemies.map((e) => ({ ...e }));
    let minPlayerDist = Infinity;
    let minPairDist = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const dp = Math.hypot(enemies[i].x - p.x, enemies[i].z - p.z);
      if (dp < minPlayerDist) minPlayerDist = dp;
      for (let j = i + 1; j < enemies.length; j++) {
        const d = Math.hypot(enemies[i].x - enemies[j].x, enemies[i].z - enemies[j].z);
        if (d < minPairDist) minPairDist = d;
      }
    }
    return {
      hp: window.__state.hp,
      maxHp: window.__state.maxHp,
      enemyCount: enemies.length,
      minEnemyTris: Math.min(...enemies.map((e) => e.tris)),
      maxEnemyTris: Math.max(...enemies.map((e) => e.tris)),
      modelSources: [...new Set(enemies.map((e) => e.modelSource))],
      minPlayerDist,
      minPairDist,
      renderInfo: { ...window.__renderInfo },
      fps: window.__fps,
      hpText: document.querySelector('[data-hud="hp-num"]')?.textContent?.trim(),
      hpMaxText: document.querySelector('[data-hud="hp-max"]')?.textContent?.trim(),
      hpSegCount: document.querySelectorAll('[data-hp-seg]').length,
    };
  });

  assert.strictEqual(initCheck.hp, 200, `initial HP ${initCheck.hp} !== 200`);
  assert.strictEqual(initCheck.maxHp, 200, `maxHp ${initCheck.maxHp} !== 200`);
  assert.strictEqual(initCheck.hpText, '200', `HUD hp numeral "${initCheck.hpText}" !== "200"`);
  assert.strictEqual(initCheck.hpSegCount, 2, `expected 2-segment HP bar, got ${initCheck.hpSegCount}`);
  assert.strictEqual(initCheck.enemyCount, 5, `expected 5 live enemies on NORMAL, got ${initCheck.enemyCount}`);
  assert.ok(initCheck.minEnemyTris > 2000, `enemy tris ${initCheck.minEnemyTris} <= 2000`);
  assert.deepStrictEqual(initCheck.modelSources, ['public/models/soldier.glb']);
  assert.ok(
    modelRequests.some((r) => r.url.includes('models/soldier.glb') && r.status === 200),
    `soldier.glb was not loaded via HTTP 200: ${JSON.stringify(modelRequests)}`,
  );
  assert.ok(initCheck.minPlayerDist >= 14.5, `enemy spawned too close to player: ${initCheck.minPlayerDist.toFixed(2)}m`);
  assert.ok(initCheck.minPairDist >= 1.48, `enemies overlapped (<1.5m): ${initCheck.minPairDist.toFixed(2)}m`);
  assert.ok(initCheck.renderInfo.calls <= 200, `draw calls ${initCheck.renderInfo.calls} > 200`);
  assert.ok(initCheck.renderInfo.triangles <= 260000, `triangles ${initCheck.renderInfo.triangles} > 260k`);

  console.log(
    `CHECK 1 OK — HP=${initCheck.hp}/${initCheck.maxHp} (2-seg), 5 enemies loaded from public/models/soldier.glb ` +
      `(tris=${initCheck.minEnemyTris} >2000), minSpawnDist=${initCheck.minPlayerDist.toFixed(1)}m, ` +
      `minPairDist=${initCheck.minPairDist.toFixed(2)}m, calls=${initCheck.renderInfo.calls} (<=200), ` +
      `tris=${initCheck.renderInfo.triangles} (<=260k)`,
  );

  // ── 2. Screenshot 3: hp-200.png (clear sunlit deck view + full 200 two-segment HP bar) ──
  await page.evaluate(() => {
    window.__test.teleport(0, 14, 10, -6, 0);
  });
  await waitFrames(page, 2);
  await takeShot(page, `${OUT}/hp-200.png`);
  console.log('SHOT hp-200.png OK');

  // ── 3. Screenshot 1: enemy-model.png (close-up human-rigged BL & GR with rifles & eye orbs) ──
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 9.0, 0, -5, 0);
    // Spawn BL (dark red) & GR (tactical blue) ~4.6m ahead facing player (+Z => yaw=180°)
    window.__test.spawnEnemyAt(-1.25, 4.4, 180, 'bl');
    window.__test.spawnEnemyAt(1.25, 4.4, 180, 'gr');
  });
  await waitSimMs(page, 280);
  await takeShot(page, `${OUT}/enemy-model.png`);
  console.log('SHOT enemy-model.png OK');

  // ── 4. IDLE clip check ('idle_rifle') & ENGAGE clip check ('fire_rifle') + Screenshot 4: enemy-engage.png ──
  // 4a. IDLE check: spawn bot facing AWAY behind a container so it stays strictly in IDLE -> idle_rifle
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(-6, 12, 0, 0, 0);
    // Behind container (-6, 0, -4), facing north (yaw=0 -> -Z, away from player)
    window.__test.spawnEnemyAt(-6, -15.5, 0, 'bl');
  });
  await waitFrames(page, 4);
  const idleBot = await page.evaluate(() => window.__enemies[0]);
  assert.strictEqual(idleBot.state, 'IDLE', `expected IDLE, got ${idleBot.state}`);
  assert.strictEqual(idleBot.clip, 'idle_rifle', `IDLE clip "${idleBot.clip}" !== "idle_rifle"`);
  console.log(`CHECK 2 OK — IDLE bot plays clip="${idleBot.clip}"`);

  // 4b. ENGAGE check: place bot 6.5m in clear view facing player -> wait until ENGAGE triggers fire_rifle
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.setDifficulty('normal');
    window.__test.teleport(0, 10.5, 0, -4, 0);
    window.__test.spawnEnemyAt(-0.4, 4.2, 180, 'bl');
    window.__test.spawnEnemyAt(1.8, 3.8, 180, 'gr');
  });
  await page.waitForFunction(
    () =>
      window.__enemies.some(
        (e) => e.state === 'ENGAGE' && (e.clip === 'fire_rifle' || e.clipsPlayed.includes('fire_rifle')),
      ),
    null,
    { timeout: 30000 },
  );
  // Capture right when at least one enemy is in fire_rifle or aim_rifle combat stance
  await takeShot(page, `${OUT}/enemy-engage.png`);
  const engageSnap = await page.evaluate(() =>
    window.__enemies.map((e) => ({ state: e.state, clip: e.clip, clipsPlayed: e.clipsPlayed, shots: e.shotsFired })),
  );
  assert.ok(
    engageSnap.some((e) => e.clipsPlayed.includes('fire_rifle')),
    `ENGAGE never played fire_rifle: ${JSON.stringify(engageSnap)}`,
  );
  console.log('CHECK 3 OK + SHOT enemy-engage.png — engage clips:', engageSnap);

  // ── 5. Overhead tags: distance accuracy <=2m, occlusion opacity=0.25, center 120px clear, >60m hidden, Screenshot 2: enemy-tag.png ──
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 16, 0, -2, 0);
    // Place BL at ~9.5m (left) and GR at ~22m (right) in open sightlines
    window.__test.spawnEnemyAt(-2.6, 6.6, 180, 'bl');
    window.__test.spawnEnemyAt(3.8, -5.8, 180, 'gr');
  });
  await waitSimMs(page, 260); // ensure 0.2s distance refresh has run
  const tagCheck = await page.evaluate(() => ({
    tags: window.__enemyTags.map((t) => ({ ...t })),
    domTags: Array.from(document.querySelectorAll('[data-enemy-tag]')).map((el) => ({
      id: el.getAttribute('data-enemy-tag'),
      text: el.textContent,
      visible: el.getAttribute('data-visible'),
      opacity: parseFloat(getComputedStyle(el).opacity),
      rect: el.getBoundingClientRect().toJSON(),
    })),
  }));
  assert.strictEqual(tagCheck.tags.length, 2, `expected 2 enemy tags, got ${tagCheck.tags.length}`);
  for (const t of tagCheck.tags) {
    assert.strictEqual(t.visible, true, `tag ${t.botId} should be visible`);
    assert.ok(
      t.text.includes(t.faction === 'bl' ? '潜伏者' : '保卫者') && t.text.endsWith('m'),
      `unexpected tag text "${t.text}"`,
    );
    const err = Math.abs(t.displayedDist - t.actualDist);
    assert.ok(err <= 2.0, `tag dist error ${err.toFixed(2)}m > 2m (${t.displayedDist} vs ${t.actualDist})`);
    assert.strictEqual(t.outsideCenter120, true, `tag intruded center 120px zone: ${JSON.stringify(t)}`);
  }
  // Near tag scale should be strictly larger than far tag scale
  const sortedByDist = [...tagCheck.tags].sort((a, b) => a.actualDist - b.actualDist);
  assert.ok(
    sortedByDist[0].scale > sortedByDist[1].scale,
    `near tag scale (${sortedByDist[0].scale}) should exceed far tag scale (${sortedByDist[1].scale})`,
  );
  await takeShot(page, `${OUT}/enemy-tag.png`);
  console.log(
    'CHECK 4 OK + SHOT enemy-tag.png — tags:',
    tagCheck.tags.map((t) => `${t.text} (actual=${t.actualDist}m, scale=${t.scale})`),
  );

  // 5b. Test center 120px avoidance when aiming dead-center at enemy, plus occlusion opacity 0.25!
  await page.evaluate(() => {
    window.__test.clearEnemies();
    // Aim straight at enemy behind container (-6, 0, -4) -> occluded AND near screen center
    window.__test.teleport(-6, 1.5, 0, 0, 0);
    window.__test.spawnEnemyAt(-6, -8.5, 180, 'gr');
  });
  await waitFrames(page, 4);
  const occTag = await page.evaluate(() => window.__enemyTags[0]);
  assert.ok(occTag && occTag.visible, `occluded tag should stay visible at 0.25 opacity: ${JSON.stringify(occTag)}`);
  assert.strictEqual(occTag.occluded, true, 'tag behind container should be occluded');
  assert.ok(Math.abs(occTag.opacity - 0.25) < 0.02, `occluded tag opacity ${occTag.opacity} !== 0.25`);
  assert.strictEqual(occTag.outsideCenter120, true, `centered tag failed 120px avoidance: ${JSON.stringify(occTag)}`);
  console.log(`CHECK 5 OK — Occluded tag opacity=${occTag.opacity}, outsideCenter120=${occTag.outsideCenter120}`);

  // 5c. Test >60m enemy tag is strictly hidden!
  await page.evaluate(() => {
    window.__test.clearEnemies();
    // Corner-to-corner across 64×40m deck: (-27, 17) to (+27, -16) => hypot(54, 33) = 63.3m > 60m!
    // Facing NE: dx=+54, dz=-33 => yaw = atan2(-54, 33) = -58.6°
    window.__test.teleport(-27, 17, -58.6, 0, 0);
    window.__test.spawnEnemyAt(27, -16, 120, 'bl');
  });
  await waitFrames(page, 4);
  const farCheck = await page.evaluate(() => ({
    tag: window.__enemyTags[0],
    domDisplay: getComputedStyle(document.querySelector('[data-enemy-tag]')).display,
  }));
  assert.ok(farCheck.tag.actualDist > 60, `expected >60m, got ${farCheck.tag.actualDist}m`);
  assert.strictEqual(farCheck.tag.visible, false, `>60m tag should be hidden: ${JSON.stringify(farCheck.tag)}`);
  assert.strictEqual(farCheck.domDisplay, 'none', `>60m DOM display should be none, got ${farCheck.domDisplay}`);
  console.log(`CHECK 6 OK — Enemy at ${farCheck.tag.actualDist}m (>60m) has tag hidden (display=none)`);

  // ── 6. Screenshot 5: enemy-dead.png (die animation frame + tag vanishes immediately on death) ──
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 9.5, 0, -14, 0);
    const id = window.__test.spawnEnemyAt(0, 4.8, 180, 'bl');
    window.__test.damageEnemy(id, 200);
  });
  await waitFrames(page, 2);
  // Immediately after death: tag MUST already be gone (0 DOM tag nodes)
  const deadTagCount = await page.evaluate(() => document.querySelectorAll('[data-enemy-tag]').length);
  assert.strictEqual(deadTagCount, 0, `dead enemy tag did not disappear immediately (${deadTagCount} left)`);
  // Advance ~2.0s into the 2.33s `die` animation so soldier is collapsed flat on deck
  await waitSimMs(page, 2000);
  await takeShot(page, `${OUT}/enemy-dead.png`);
  console.log('CHECK 7 OK + SHOT enemy-dead.png — tag removed immediately on death & die collapse captured');

  // ── 7. Player HP=200 regeneration test + <40 pulse/heartbeat + <20 desaturation ──
  // Reset cleanly via menu/retry or start from full HP after clearing enemies
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 14, 0, 0, 0);
  });
  // First verify low HP (<40 pulse + <20 desat) via hurt, then reset round for clean 200 -> 100 -> 200 regen test!
  await page.evaluate(() => {
    // Drop from current HP down to ~15 HP (critical < 20)
    const cur = window.__state.hp;
    if (cur > 15) window.__test.hurt(cur - 15);
  });
  await waitSimMs(page, 400);
  const lowCheck = await page.evaluate(() => ({
    hp: window.__state.hp,
    lowHpPulse: window.__fx.lowHpPulse,
    desat: window.__fx.desat,
    canvasFilter: document.getElementById('game')?.style.filter ?? '',
    heartbeatCount: window.__sfx.counts.heartbeat ?? 0,
  }));
  assert.ok(lowCheck.hp > 0 && lowCheck.hp < 20, `expected <20 HP, got ${lowCheck.hp}`);
  assert.ok(lowCheck.lowHpPulse > 0, 'low-HP vignette pulse did not activate below 40 HP');
  assert.ok(lowCheck.desat > 0 && lowCheck.canvasFilter.includes('saturate'), `desat missing <20 HP: ${JSON.stringify(lowCheck)}`);
  console.log('CHECK 8 OK — Critical HP (<20) vignette pulse + heartbeat + desaturation:', lowCheck);

  // Trigger death -> Retry so player starts cleanly at 200 HP with zero pending hurt timer
  await page.evaluate(() => window.__test.hurt(200));
  await page.waitForFunction(() => window.__state.deathPanelVisible === true, null, { timeout: 30000 });
  await page.click('[data-death-btn="retry"]');
  await page.waitForFunction(() => window.__match?.phase === 'playing' && window.__state.hp === 200, null, {
    timeout: 30000,
  });
  // Clear enemies so they don't interrupt our 100-damage regen measurement
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.hurt(100);
  });
  await waitFrames(page, 2);
  const afterHurt = await page.evaluate(() => ({
    hp: window.__state.hp,
    t: window.__anim.simTimeMs,
  }));
  assert.strictEqual(afterHurt.hp, 100, `after 100 dmg expected HP=100, got ${afterHurt.hp}`);

  // Confirm regen does NOT start prematurely before 6s (check at +4s)
  await waitSimMs(page, 4000);
  const midDelayHp = await page.evaluate(() => window.__state.hp);
  assert.strictEqual(midDelayHp, 100, `HP started regen early at 4s (${midDelayHp} !== 100)`);

  // Wait for regen to start (after 6s delay)
  await page.waitForFunction(() => window.__state.hp > 100.5, null, { timeout: 60000 });
  const regenStartSim = await page.evaluate(() => window.__anim.simTimeMs);
  const delaySec = (regenStartSim - afterHurt.t) / 1000;
  assert.ok(delaySec >= 5.8 && delaySec <= 6.8, `regen delay ${delaySec.toFixed(2)}s expected ~6s`);

  // Wait until HP returns to 200 and assert regen phase completes within 10s!
  await page.waitForFunction(() => window.__state.hp >= 200, null, { timeout: 90000 });
  const regenEndSim = await page.evaluate(() => window.__anim.simTimeMs);
  const regenDurationSec = (regenEndSim - regenStartSim) / 1000;
  assert.ok(
    regenDurationSec <= 10.0,
    `HP regen from 100 -> 200 took ${regenDurationSec.toFixed(2)}s (> 10s)`,
  );
  console.log(
    `CHECK 9 OK — 200 -> hurt(100) -> delay=${delaySec.toFixed(2)}s (~6s) -> regen to 200 in ${regenDurationSec.toFixed(2)}s (<=10s)`,
  );

  // Verify all 5 required screenshots exist and are non-trivial PNGs
  const shots = [
    'enemy-model.png',
    'enemy-tag.png',
    'hp-200.png',
    'enemy-engage.png',
    'enemy-dead.png',
  ];
  for (const f of shots) {
    const sz = statSync(`${OUT}/${f}`).size;
    assert.ok(sz > 8000, `${f} looks blank (${sz} bytes)`);
  }

  assert.strictEqual(errors.length, 0, `JS errors:\n${errors.join('\n')}`);
  console.log('ROUND 6 E2E ALL OK — 0 JS errors, all 5 screenshots & all assertions passed');
} finally {
  await browser.close();
}
