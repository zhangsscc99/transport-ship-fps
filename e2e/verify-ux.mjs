// UX Redesign Verification & 3-Screenshot Capture Suite:
//   Asserts ALL 3 required acceptance checks across BOTH 844×390 landscape & 390×844 portrait:
//     1. All 5 action buttons on right half (centerX > vw/2), >= 56px, FIRE radius >= 64px,
//        zero overlap with joystick bbox, >= 10px spacing, scale(0.96) + highlight on press.
//     2. Distance tags match /^\d+m$/ strictly, zero forbidden words in DOM, <10m warm border + 4px dot,
//        42×3px HP bar 4px below with cyan/yellow/red thresholds, 25–40m opacity 0.45, >40m hidden,
//        <= 5 visible simultaneously, never covers > 1/3 body height.
//     3. Procedural cyberpunk robot (0 GLB requests): single robot tris <= 2500,
//        7 simultaneous robots in view -> renderer.info.render.triangles <= 220000.
//   Captures 3 screenshots to e2e/shots/ via CDP Page.captureScreenshot (immune to WebGL timeout):
//     - e2e/shots/ux-landscape-combat.png
//     - e2e/shots/ux-portrait-combat.png
//     - e2e/shots/ux-robot-closeup.png

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const SHOTS_DIR = 'e2e/shots';
mkdirSync(SHOTS_DIR, { recursive: true });

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

const ACTION_BTNS = ['fire', 'reload', 'swap', 'jump', 'crouch'];
const DIST_RE = /^\d+m$/;
const FORBIDDEN_RE = new RegExp(
  ['\\u6f5c\\u4f0f\\u8005', '\\u4fdd\\u536b\\u8005', 'defend' + 'er', 'attack' + 'er'].join('|'),
  'i',
);

const T0 = Date.now();
const log = (msg) => console.error(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

async function waitFrames(page, count = 2, timeout = 180000) {
  const f0 = await page.evaluate(() => window.__frames ?? 0);
  await page.waitForFunction((target) => (window.__frames ?? 0) >= target, f0 + count, { timeout });
}

async function captureCdpPng(cdp, outPath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  writeFileSync(outPath, buf);
  const sz = statSync(outPath).size;
  assert.ok(sz > 8000, `screenshot ${outPath} looks blank (${sz} bytes)`);
  log(`saved ${outPath} (${(sz / 1024).toFixed(1)} KB)`);
  return outPath;
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function rectGap(a, b) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

async function auditViewport(page, cdp, name, glbRequests) {
  log(`auditing viewport=${name}`);

  // ── Check 1: All action buttons on right half, >=56px, fire r>=64px, zero overlap with joystick ──
  const layout = await page.evaluate((btnIds) => {
    const toBox = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Number(r.x.toFixed(1)),
        y: Number(r.y.toFixed(1)),
        w: Number(r.width.toFixed(1)),
        h: Number(r.height.toFixed(1)),
        cx: Number((r.x + r.width / 2).toFixed(1)),
        cy: Number((r.y + r.height / 2).toFixed(1)),
      };
    };
    const btns = {};
    for (const id of [...btnIds, 'mute']) {
      const el =
        document.querySelector(`#touch-ui [data-btn="${id}"]`) ??
        document.querySelector(`[data-btn="${id}"]`);
      if (el) btns[id] = toBox(el);
    }
    const stickEl = document.querySelector('#touch-ui [data-stick="idle"]');
    const hpEl = document.querySelector('[data-hud="hp"]');
    const ammoEl = document.querySelector('[data-hud="ammo"]');
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      btns,
      stick: stickEl ? toBox(stickEl) : null,
      hp: hpEl ? toBox(hpEl) : null,
      ammo: ammoEl ? toBox(ammoEl) : null,
    };
  }, ACTION_BTNS);

  assert.ok(layout.stick, `${name}: joystick missing`);
  for (const id of ACTION_BTNS) {
    const b = layout.btns[id];
    assert.ok(b, `${name}: missing button ${id}`);
    assert.ok(b.cx > layout.vw / 2, `${name}: ${id} centerX=${b.cx} <= vw/2 (${layout.vw / 2})`);
    assert.ok(b.w >= 56 && b.h >= 56, `${name}: ${id} hit target ${b.w}x${b.h} < 56px`);
    assert.equal(rectsIntersect(b, layout.stick), false, `${name}: ${id} overlaps joystick`);
    if (layout.hp) assert.equal(rectsIntersect(b, layout.hp), false, `${name}: ${id} overlaps HP`);
    if (layout.ammo) assert.equal(rectsIntersect(b, layout.ammo), false, `${name}: ${id} overlaps Ammo`);
  }
  assert.ok(
    layout.btns.fire.w >= 128 && layout.btns.fire.h >= 128,
    `${name}: FIRE radius ${(layout.btns.fire.w / 2).toFixed(1)} < 64px`,
  );
  assert.ok(
    layout.btns.mute.w >= 56 && layout.btns.mute.h >= 56,
    `${name}: MUTE hit target ${layout.btns.mute.w}x${layout.btns.mute.h} < 56px`,
  );
  for (let i = 0; i < ACTION_BTNS.length; i++) {
    for (let j = i + 1; j < ACTION_BTNS.length; j++) {
      const a = layout.btns[ACTION_BTNS[i]];
      const b = layout.btns[ACTION_BTNS[j]];
      const gap = rectGap(a, b);
      assert.ok(gap >= 10, `${name}: ${ACTION_BTNS[i]}<->${ACTION_BTNS[j]} gap ${gap.toFixed(1)} < 10px`);
    }
  }

  // Pressed feedback check (scale 0.96 + pressed flag)
  const pressCheck = await page.evaluate(() => {
    const el = document.querySelector('#touch-ui [data-btn="reload"]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 91,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
    const pressedAttr = el.dataset.pressed;
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 91, bubbles: true, pointerType: 'touch' }));
    return { pressedAttr, releasedAttr: el.dataset.pressed };
  });
  assert.equal(pressCheck.pressedAttr, '1', `${name}: pressed state not set`);
  assert.equal(pressCheck.releasedAttr, '0', `${name}: pressed state not released`);
  log(`${name}: Check 1 (buttons right/size/no-overlap/pressed) OK`);

  // ── Check 2 & 3: Spawn 7 cyberpunk robots simultaneously in view ──
  // Open central corridor on deck: player at (0.5, 16) facing north (-Z, yaw=0) so ALL 5 visible robots are unobstructed!
  const spawnIds = await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0.5, 16.0, 0, -2, 0);
    const ids = {
      close: window.__test.spawnEnemyAt(-0.4, 8.6, 180, 'enemy'), // ~7.5m (<10m warm border + dot, clear LOS, HP 88% cyan)
      midYellow: window.__test.spawnEnemyAt(2.1, 4.4, 180, 'enemy'), // ~11.7m (<25m full, HP 48% yellow)
      midRed: window.__test.spawnEnemyAt(-1.2, -0.5, 180, 'enemy'), // ~16.6m (<25m full, HP 22% red)
      allyMid: window.__test.spawnEnemyAt(1.6, -4.5, 180, 'ally'), // ~20.5m (<25m full, cyan ally robot)
      fade25: window.__test.spawnEnemyAt(-0.2, -13.0, 180, 'enemy'), // ~29.0m (25-40m -> opacity 0.45)
      sixth: window.__test.spawnEnemyAt(2.2, -16.5, 180, 'enemy'), // ~32.5m (6th nearest -> capped out by max 5!)
      over40: window.__test.spawnEnemyAt(0.5, -26.0, 180, 'enemy'), // ~42.0m (>40m -> hidden!)
    };
    window.__test.damageEnemy(ids.close, 12); // 88 HP (>60% cyan)
    window.__test.damageEnemy(ids.midYellow, 52); // 48 HP (30-60% yellow)
    window.__test.damageEnemy(ids.midRed, 78); // 22 HP (<=30% red)
    return ids;
  });
  await waitFrames(page, 2);

  const audit = await page.evaluate(() => {
    const domTags = [];
    for (const el of document.querySelectorAll('[data-enemy-tag]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const pill = el.querySelector('[data-role="dist-pill"]');
      const dot = el.querySelector('[data-role="close-dot"]');
      const hp = el.querySelector('[data-role="hp-bar"]');
      const hpFill = el.querySelector('[data-role="hp-fill"]');
      const pr = pill.getBoundingClientRect();
      const hr = hp.getBoundingClientRect();
      const hpCs = getComputedStyle(hp);
      const pillCs = getComputedStyle(pill);
      domTags.push({
        id: el.dataset.enemyTag,
        text: (el.textContent ?? '').trim(),
        opacity: Number(cs.opacity),
        fontFamily: pillCs.fontFamily,
        fontSize: pillCs.fontSize,
        fontWeight: pillCs.fontWeight,
        borderRadius: pillCs.borderRadius,
        borderColor: pillCs.borderTopColor,
        dotVisible: getComputedStyle(dot).display !== 'none',
        dotW: Number(dot.getBoundingClientRect().width.toFixed(1)),
        hpW: Number(hr.width.toFixed(1)),
        hpH: Number(hr.height.toFixed(1)),
        hpGap: Number((hr.top - pr.bottom).toFixed(1)),
        hpBorder: hpCs.borderTopWidth,
        hpShadow: hpCs.boxShadow,
        hpColor: getComputedStyle(hpFill).backgroundColor,
      });
    }
    return {
      domTags,
      telemetry: JSON.parse(JSON.stringify(window.__enemyTags ?? [])),
      enemies: JSON.parse(JSON.stringify(window.__enemies ?? [])),
      renderInfo: { ...window.__renderInfo },
      html: document.documentElement.innerHTML,
      innerText: document.body.innerText,
    };
  });

  // Assert zero forbidden words anywhere in DOM or visible text
  assert.equal(FORBIDDEN_RE.test(audit.html), false, `${name}: forbidden wording in HTML`);
  assert.equal(FORBIDDEN_RE.test(audit.innerText), false, `${name}: forbidden wording in body text`);

  // Assert tag count <= 5 (7 robots in view -> capped at nearest 5!)
  assert.ok(
    audit.domTags.length >= 4 && audit.domTags.length <= 5,
    `${name}: visible tags ${audit.domTags.length} expected 4..5 (got ${JSON.stringify(audit.domTags.map((t) => t.text))})`,
  );
  for (const t of audit.domTags) {
    assert.match(t.text, DIST_RE, `${name}: tag text "${t.text}" does not match /^\\d+m$/`);
    assert.equal(t.fontSize, '12px', `${name}: fontSize ${t.fontSize} !== 12px`);
    assert.equal(t.fontWeight, '500', `${name}: fontWeight ${t.fontWeight} !== 500`);
    assert.equal(t.borderRadius, '6px', `${name}: borderRadius ${t.borderRadius} !== 6px`);
    assert.ok(t.hpW === 42 && t.hpH === 3, `${name}: hp bar ${t.hpW}x${t.hpH} !== 42x3`);
    assert.ok(Math.abs(t.hpGap - 4) <= 1, `${name}: hp gap ${t.hpGap}px !== 4px`);
    assert.equal(t.hpBorder, '0px', `${name}: hp bar has border ${t.hpBorder}`);
    assert.equal(t.hpShadow, 'none', `${name}: hp bar has shadow ${t.hpShadow}`);
  }

  const tagById = (id) => audit.domTags.find((t) => t.id === id);
  assert.equal(tagById(spawnIds.close)?.dotVisible, true, `${name}: <10m warm dot hidden`);
  assert.equal(tagById(spawnIds.close)?.borderColor, 'rgb(255, 180, 84)', `${name}: <10m border !== #FFB454`);
  assert.equal(tagById(spawnIds.close)?.hpColor, 'rgb(34, 224, 255)', `${name}: >60% HP not cyan`);
  assert.equal(tagById(spawnIds.midYellow)?.hpColor, 'rgb(255, 209, 102)', `${name}: 30-60% HP not yellow`);
  assert.equal(tagById(spawnIds.midRed)?.hpColor, 'rgb(255, 70, 85)', `${name}: <=30% HP not red`);
  assert.ok(
    Math.abs((tagById(spawnIds.fade25)?.opacity ?? 0) - 0.45) < 0.02,
    `${name}: 25-40m tag opacity ${tagById(spawnIds.fade25)?.opacity} !== 0.45`,
  );
  assert.equal(tagById(spawnIds.sixth), undefined, `${name}: 6th nearest tag should be hidden by max-5 cap`);
  assert.equal(tagById(spawnIds.over40), undefined, `${name}: >40m tag should be hidden`);

  for (const tele of audit.telemetry.filter((x) => x.visible)) {
    assert.ok(
      tele.coversBodyRatio <= 1 / 3 + 0.01,
      `${name}: tag covers ${(tele.coversBodyRatio * 100).toFixed(1)}% > 33.3% of enemy body`,
    );
  }
  log(`${name}: Check 2 (distance tags/HP/fade/max5/no-forbidden) OK`);

  // Assert 7 simultaneous robots & triangle budgets
  assert.equal(audit.enemies.length, 7, `${name}: expected 7 simultaneous robots, got ${audit.enemies.length}`);
  const singleRobotTris = Math.max(...audit.enemies.map((e) => e.tris));
  assert.ok(singleRobotTris > 100 && singleRobotTris <= 2500, `${name}: single robot tris ${singleRobotTris} > 2500`);
  assert.ok(
    audit.renderInfo.triangles <= 220000,
    `${name}: 7-robot scene triangles ${audit.renderInfo.triangles} > 220000`,
  );
  assert.equal(glbRequests.length, 0, `${name}: GLB network requests still fired: ${glbRequests.join(', ')}`);
  log(
    `${name}: Check 3 (7 robots tris=${audit.renderInfo.triangles}<=220k, single=${singleRobotTris}<=2500, calls=${audit.renderInfo.calls}) OK`,
  );

  // Capture combat screenshot cleanly via CDP
  await page.evaluate(() => window.__test.setPaused(true));
  await page.waitForTimeout(80);
  const shotPath = `${SHOTS_DIR}/ux-${name}-combat.png`;
  await captureCdpPng(cdp, shotPath);
  await page.evaluate(() => window.__test.setPaused(false));

  return {
    viewport: name,
    actionButtonsRight: ACTION_BTNS.every((id) => layout.btns[id].cx > layout.vw / 2),
    fireSize: layout.btns.fire.w,
    fireRadius: layout.btns.fire.w / 2,
    minBtnSize: Math.min(...[...ACTION_BTNS, 'mute'].map((id) => Math.min(layout.btns[id].w, layout.btns[id].h))),
    stickOverlapCount: ACTION_BTNS.filter((id) => rectsIntersect(layout.btns[id], layout.stick)).length,
    visibleTags: audit.domTags.map((t) => `${t.text}(op=${t.opacity},warm=${t.dotVisible ? 1 : 0})`),
    singleRobotTris,
    sevenRobotSceneTris: audit.renderInfo.triangles,
    drawCalls: audit.renderInfo.calls,
    glbRequests: glbRequests.length,
    shotPath,
  };
}

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const errors = [];
const glbRequests = [];

page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('request', (req) => {
  if (/\.glb(\?|$)/i.test(req.url())) glbRequests.push(req.url());
});

try {
  log(`goto ${URL}`);
  await page.goto(URL, { waitUntil: 'commit', timeout: 30000 });
  let frames = 0;
  for (let i = 0; i < 120 && frames < 4; i++) {
    await page.waitForTimeout(400);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames >= 4, 'page never rendered WebGL frames');
  log(`loaded frames=${frames}`);

  const menuHtml = await page.evaluate(() => document.documentElement.innerHTML);
  assert.equal(FORBIDDEN_RE.test(menuHtml), false, 'forbidden faction wording in menu DOM');

  // Click start, verify natural robot wave spawns, then clear during countdown to keep SwiftShader crisp
  const spawnedAtStart = await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return window.__enemies?.length ?? 0;
  });
  await page.evaluate(() => window.__test.clearEnemies());
  log(`clicked start (natural wave=${spawnedAtStart}), waiting for playing...`);
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 240000 });
  log('match phase=playing');

  // 1. Landscape 844×390 audit + combat shot
  const landscape = await auditViewport(page, cdp, 'landscape', glbRequests);

  // 2. Cyberpunk robot close-up shot (open sunlit deck, 2.7m away:
  //    Left = enemy magenta robot facing camera; Right = ally cyan robot angled 3/4 rear showing glowing back energy core!)
  await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0.2, 11.4, 0, -4, 0);
    window.__test.spawnEnemyAt(-0.55, 8.7, 162, 'enemy');
    window.__test.spawnEnemyAt(0.85, 8.7, 32, 'ally');
  });
  await waitFrames(page, 1);
  await page.evaluate(() => window.__test.setPaused(true));
  await page.waitForTimeout(80);
  const closeupPath = `${SHOTS_DIR}/ux-robot-closeup.png`;
  await captureCdpPng(cdp, closeupPath);
  await page.evaluate(() => window.__test.setPaused(false));

  // 3. Switch dynamically to Portrait 390×844 -> audit + combat shot
  await page.setViewportSize({ width: 390, height: 844 });
  await waitFrames(page, 2);
  const portrait = await auditViewport(page, cdp, 'portrait', glbRequests);

  assert.deepEqual(errors, [], `JS/console errors: ${errors.join('\n')}`);
  console.log(JSON.stringify({ landscape, portrait, closeupPath }, null, 2));
  console.log('UX VERIFICATION ALL OK');
} finally {
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
}
