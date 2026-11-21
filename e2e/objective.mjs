// Objective bar e2e: top-centre "我方 a/25 · M:SS · 敌方 b" in 390×844 portrait
// and 844×390 landscape (both hasTouch). Asserts the DOM contract
// ([data-hud=objective] + data-obj=a|time|b with dataset.v), that it never
// overlaps the mute button / FPS / crosshair / HP / ammo / touch buttons,
// portrait width ≤ 62vw and every text ≥ 12px; enemy kill → killsA + HUD a,
// player death via __test.hurt(999) → killsB 0→1 exactly once.
// Chromium + SwiftShader, no xvfb needed.
// Usage: node e2e/objective.mjs  (server on 127.0.0.1:3028, or TSF_URL=...)

const { chromium } = await import('playwright');
const { default: assert } = await import('node:assert/strict');
const { mkdirSync } = await import('node:fs');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const SHOTS = new globalThis.URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

const readObj = (page) =>
  page.evaluate(() => {
    const wrap = document.querySelector('[data-hud="objective"]');
    const q = (k) => wrap?.querySelector(`[data-obj="${k}"]`);
    const r = wrap?.getBoundingClientRect();
    const cs = wrap ? getComputedStyle(wrap) : null;
    return {
      exists: !!wrap,
      visible: !!r && r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
      a: q('a')?.textContent ?? null,
      aV: q('a')?.dataset.v ?? null,
      time: q('time')?.textContent ?? null,
      timeV: q('time')?.dataset.v ?? null,
      b: q('b')?.textContent ?? null,
      bV: q('b')?.dataset.v ?? null,
      killsA: window.__match.killsA,
      killsB: window.__match.killsB,
      killsToWin: window.__match.killsToWin,
      phase: window.__match.phase,
      dead: window.__state.dead,
    };
  });

const layoutCheck = (page) =>
  page.evaluate(() => {
    const wrap = document.querySelector('[data-hud="objective"]');
    const r = wrap.getBoundingClientRect();
    const rect = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 ? b : null;
    };
    const inter = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const others = {
      mute: document.querySelector('[data-btn="mute"]'),
      fps: document.querySelector('[data-hud="fps"]'),
      hp: document.querySelector('[data-hud="hp"]'),
      ammo: document.querySelector('[data-hud="ammo"]'),
    };
    // crosshair: a 60px box around the centre point covers both reticles
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const crossBox = { left: cx - 32, right: cx + 32, top: cy - 32, bottom: cy + 32 };
    const overlaps = [];
    for (const [k, el] of Object.entries(others)) {
      const b = rect(el);
      if (b && inter(r, b)) overlaps.push(k);
    }
    if (inter(r, crossBox)) overlaps.push('cross');
    for (const el of document.querySelectorAll('[data-btn]')) {
      if (el.dataset.btn === 'mute' || el.closest('[data-panel]')) continue;
      const b = rect(el);
      if (b && inter(r, b)) overlaps.push(`btn:${el.dataset.btn}`);
    }
    let minFont = Infinity;
    for (const el of wrap.querySelectorAll('*')) {
      if (!el.textContent.trim()) continue;
      minFont = Math.min(minFont, parseFloat(getComputedStyle(el).fontSize));
    }
    const muteR = rect(others.mute);
    return {
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width },
      vw: innerWidth,
      overlaps,
      minFont,
      muteLeft: muteR?.left ?? null,
      topStyle: wrap.style.top,
      safeArea: /env\(safe-area-inset-top/.test(wrap.style.top),
    };
  });

async function runViewport(browser, label, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('crash', () => console.error(`[${label}] renderer crashed`));

  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  let frames = 0;
  for (let i = 0; i < 40 && frames <= 15; i++) {
    await page.waitForTimeout(800);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 15, `${label}: page never rendered frames`);

  const inMenu = await readObj(page);
  assert.equal(inMenu.exists, true, `${label}: objective bar missing from DOM`);
  assert.equal(inMenu.visible, false, `${label}: objective bar should hide in menu`);

  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  // SwiftShader on a loaded box can drop to ~1–5 fps and dt is clamped to
  // 0.1s, so the 3s sim countdown may take a while in wall time.
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 180000 });
  await page.evaluate(() => window.__test.clearEnemies());
  await page.waitForFunction(
    () => document.querySelector('[data-hud="objective"]')?.dataset.phase === 'playing',
    null,
    { timeout: 60000 },
  );

  // 1. visible + contract
  const o = await readObj(page);
  assert.equal(o.visible, true, `${label}: objective bar not visible after kickoff`);
  assert.match(o.time, /^\d:\d\d$/, `${label}: clock text "${o.time}"`);
  assert.ok(o.a.includes('/25'), `${label}: a text "${o.a}" lacks /25`);
  assert.equal(o.killsToWin, 25);
  assert.equal(o.aV, String(o.killsA));
  assert.equal(o.bV, String(o.killsB));
  assert.ok(Number(o.timeV) > 0 && Number(o.timeV) <= 300, `${label}: time dataset.v ${o.timeV}`);
  // clock is running (sim time — wait on the value, not wall time)
  await page.waitForFunction(
    (v) => Number(document.querySelector('[data-hud="objective"] [data-obj="time"]').dataset.v) < v,
    Number(o.timeV),
    { timeout: 120000 },
  );

  // 2. layout
  const lay = await layoutCheck(page);
  assert.deepEqual(lay.overlaps, [], `${label}: objective overlaps ${lay.overlaps.join(',')}`);
  assert.ok(lay.minFont >= 12, `${label}: min font ${lay.minFont}px < 12`);
  assert.ok(lay.safeArea, `${label}: top lacks env(safe-area-inset-top): ${lay.topStyle}`);
  assert.ok(lay.rect.left >= 0 && lay.rect.right <= lay.vw, `${label}: bar off-screen`);
  if (viewport.height > viewport.width) {
    assert.ok(lay.rect.width <= lay.vw * 0.62 + 0.5, `${label}: width ${lay.rect.width} > 62vw`);
  }
  const shot = `${SHOTS}objective-${label}.png`;
  // pause the WebGL loop so the compositor can grab a frame on slow SwiftShader
  await page.evaluate(() => window.__test.setPaused(true));
  await page.screenshot({ path: shot, timeout: 120000 });
  await page.evaluate(() => window.__test.setPaused(false));

  // 3. enemy kill → killsA and HUD a in lockstep
  const before = await readObj(page);
  const id = await page.evaluate(() => {
    window.__test.teleport(0, 10, 0, 0, 0);
    return window.__test.spawnEnemyAt(-1.65, 3.8, 180, 'bl');
  });
  await page.evaluate((eid) => window.__test.damageEnemy(eid, 99999), id);
  await page.waitForFunction(
    (k) =>
      window.__match.killsA === k + 1 &&
      document.querySelector('[data-hud="objective"] [data-obj="a"]').dataset.v === String(k + 1),
    before.killsA,
    { timeout: 60000 },
  );
  await page.evaluate(() => window.__test.clearEnemies());
  const afterKill = await readObj(page);
  assert.ok(afterKill.a.includes(`${before.killsA + 1}/25`), `${label}: a text "${afterKill.a}"`);
  assert.equal(afterKill.killsB, 0);

  // 4. player death → killsB 0→1 exactly once
  assert.equal(afterKill.bV, '0');
  await page.evaluate(() => window.__test.hurt(999));
  await page.waitForFunction(
    () =>
      window.__match.killsB === 1 &&
      document.querySelector('[data-hud="objective"] [data-obj="b"]').dataset.v === '1',
    null,
    { timeout: 60000 },
  );
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__test.hurt(999));
    await page.waitForTimeout(150);
  }
  // let several frames run so any (wrong) re-score would reach __match + HUD
  const f0 = await page.evaluate(() => window.__frames);
  await page.waitForFunction((f) => window.__frames >= f + 5, f0, { timeout: 60000 });
  const dead = await readObj(page);
  assert.equal(dead.dead, true);
  assert.equal(dead.killsB, 1, `${label}: corpse hurt re-scored killsB=${dead.killsB}`);
  assert.equal(dead.bV, '1');
  assert.ok(dead.b.includes('1'), `${label}: b text "${dead.b}"`);

  assert.deepEqual(errors, [], `${label}: page errors`);
  console.log(`[${label}] OK`, JSON.stringify({ o, lay, afterKill: afterKill.a, b: dead.b, shot }));
  await ctx.close();
}

// one fresh browser per viewport (SwiftShader renderers get heavy); pass
// `portrait` or `landscape` as argv[2] to run a single one.
const VIEWPORTS = {
  portrait: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
};
const only = process.argv[2];
for (const [label, vp] of Object.entries(VIEWPORTS)) {
  if (only && only !== label) continue;
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    await runViewport(browser, label, vp);
  } finally {
    await browser.close();
  }
}
console.log('OBJECTIVE E2E PASS');
