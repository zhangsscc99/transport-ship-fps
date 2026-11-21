// Enemy overhead tags e2e: `▣ 潜伏者 32m` / `▣ 保卫者 18m` DOM overlay.
// Portrait 390×844 + landscape 844×390 (hasTouch). Asserts via the read-only
// window.__enemyTags telemetry + [data-enemy-tag] DOM:
//   - hidden in menu (no tags), visible tags once playing (natural + deterministic)
//   - every visible tag: text /^▣ (潜伏者|保卫者) \d+m$/, actualDist ≤ 60
//   - occluded behind container → occluded: true, opacity 0.25
//   - near-big / far-small distance scaling
//   - bot > 60m away → tag hidden
//   - tag rect stays inside the viewport and outside the central 120×120 box
//   - killing a bot removes its tag within 1 frame (telemetry + DOM)
//   - hidden in settlement phase (death panel)
// Chromium + SwiftShader, no xvfb needed.
// Usage: node e2e/enemyTags.mjs  (server on 127.0.0.1:3028, or TSF_URL=...)

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
const TEXT_RE = /^▣ (潜伏者|保卫者) \d+m$/;

/** wait for N rendered frames (sim-time agnostic; SwiftShader can be slow) */
const waitFrames = (page, n) =>
  page.evaluate(
    (n) =>
      new Promise((res) => {
        const start = window.__frames ?? 0;
        const tick = () => ((window.__frames ?? 0) - start >= n ? res() : requestAnimationFrame(tick));
        tick();
      }),
    n,
  );

const readTags = (page) =>
  page.evaluate(() => {
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const dom = [];
    for (const el of document.querySelectorAll('[data-enemy-tag]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      dom.push({
        id: el.dataset.enemyTag,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        inCentre: r.left < cx + 60 && r.right > cx - 60 && r.top < cy + 60 && r.bottom > cy - 60,
        font: cs.fontFamily,
        bg: cs.backgroundColor,
        opacity: Number(cs.opacity),
      });
    }
    return {
      vw: innerWidth,
      vh: innerHeight,
      tags: JSON.parse(JSON.stringify(window.__enemyTags ?? null)),
      dom,
    };
  });

async function runViewport(browser, label, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  let frames = 0;
  for (let i = 0; i < 40 && frames <= 15; i++) {
    await page.waitForTimeout(800);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 15, `${label}: page never rendered frames`);

  // 0. menu: telemetry exposed but empty, no visible DOM tags
  const menu = await readTags(page);
  assert.ok(Array.isArray(menu.tags), `${label}: window.__enemyTags missing`);
  assert.equal(menu.tags.length, 0, `${label}: tags present in menu`);
  assert.equal(menu.dom.length, 0, `${label}: tag DOM visible in menu`);

  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 180000 });

  // 1. natural spawns: turn toward the first live enemy and assert visible tags
  await page.evaluate(() => {
    const first = window.__enemies.find((e) => e.hp > 0);
    if (first) {
      const dx = first.x - 0;
      const dz = first.z - 14;
      const yawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      window.__test.teleport(0, 14, yawDeg, 0, 0);
    } else {
      window.__test.teleport(0, 14, 0, 0, 0);
    }
  });
  await waitFrames(page, 3);
  const natural = await readTags(page);
  const natVisible = natural.tags.filter((t) => t.visible);
  assert.ok(natVisible.length > 0, `${label}: no visible tags on natural spawns`);
  for (const t of natVisible) {
    assert.match(t.text, TEXT_RE, `${label}: natural bad tag text "${t.text}"`);
    assert.ok(t.actualDist <= 60, `${label}: natural visible tag at ${t.actualDist}m > 60`);
  }

  // 2. deterministic layout: clear, place known bots in front / side / occluded / far away
  const ids = await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 14, 0, 0, 0);
    return {
      centre: window.__test.spawnEnemyAt(0, 4, 180, 'bl'), // 10m dead ahead → must dodge crosshair
      side: window.__test.spawnEnemyAt(4, -2, 180, 'gr'), // ~16.5m ahead-right, clear LOS
      occluded: window.__test.spawnEnemyAt(-5, -8, 180, 'gr'), // ~22.6m behind container (-6,0,-4)
      far: window.__test.spawnEnemyAt(31, -19, 180, 'bl'), // opposite corner, checked from (-27,18)
    };
  });
  await waitFrames(page, 3);
  const s = await readTags(page);
  // Pause WebGL loop briefly so SwiftShader compositor grabs a crisp frame quickly
  await page.evaluate(() => window.__test.setPaused(true));
  await page
    .screenshot({ path: `${SHOTS}enemytags-${label}.png`, timeout: 60000 })
    .catch((e) => console.warn(`[${label}] screenshot skipped: ${e.message.split('\n')[0]}`));
  await page.evaluate(() => window.__test.setPaused(false));

  const visible = s.tags.filter((t) => t.visible);
  console.log(
    `[${label}] tags:`,
    s.tags
      .map(
        (t) =>
          `${t.botId}:${t.text}:${t.actualDist}m:${t.visible ? 'V' : 'h'}${t.occluded ? 'O' : ''}:x${t.scale}`,
      )
      .join(' | '),
  );
  assert.ok(visible.length >= 3, `${label}: expected >=3 visible deterministic tags, got ${visible.length}`);
  for (const t of visible) {
    assert.match(t.text, TEXT_RE, `${label}: bad tag text "${t.text}"`);
    assert.ok(t.actualDist <= 60, `${label}: visible tag at ${t.actualDist}m > 60`);
    assert.ok(t.scale > 0, `${label}: scale ${t.scale}`);
    assert.equal(typeof t.occluded, 'boolean');
    assert.ok(t.faction === 'bl' || t.faction === 'gr');
  }
  for (const t of s.tags) {
    if (t.actualDist > 60) assert.equal(t.visible, false, `${label}: ${t.botId} >60m visible`);
  }

  // Distance scaling & occlusion assertions
  const centreTag = visible.find((t) => t.botId === ids.centre);
  const sideTag = visible.find((t) => t.botId === ids.side);
  const occTag = visible.find((t) => t.botId === ids.occluded);
  assert.ok(centreTag && sideTag && occTag, `${label}: missing deterministic tags`);
  assert.ok(
    centreTag.scale > sideTag.scale && sideTag.scale > occTag.scale,
    `${label}: monotonic scale failed (${centreTag.scale}, ${sideTag.scale}, ${occTag.scale})`,
  );
  assert.equal(centreTag.occluded, false, `${label}: centre bot should not be occluded`);
  assert.equal(occTag.occluded, true, `${label}: bot behind container should be occluded`);
  assert.equal(occTag.opacity, 0.25, `${label}: occluded opacity should be 0.25`);

  // DOM: inside viewport, outside central 120px zone, HUD font, faction bg, occluded opacity
  assert.ok(s.dom.length >= 3, `${label}: expected >=3 visible tag DOM nodes`);
  for (const d of s.dom) {
    assert.ok(
      d.left >= 0 && d.top >= 0 && d.right <= s.vw && d.bottom <= s.vh,
      `${label}: tag ${d.id} out of viewport ${JSON.stringify(d)}`,
    );
    assert.equal(d.inCentre, false, `${label}: tag ${d.id} intrudes central 120px ${JSON.stringify(d)}`);
    assert.ok(/DIN Alternate/.test(d.font), `${label}: tag font ${d.font}`);
    assert.ok(d.opacity === 1 || Math.abs(d.opacity - 0.25) < 1e-3, `${label}: opacity ${d.opacity}`);
  }
  const domOf = (id) => s.dom.find((d) => d.id === id);
  assert.equal(domOf(ids.centre)?.bg, 'rgba(155, 28, 25, 0.88)', `${label}: 潜伏者 bg`);
  assert.equal(domOf(ids.side)?.bg, 'rgba(35, 90, 148, 0.88)', `${label}: 保卫者 bg`);
  assert.ok(
    Math.abs((domOf(ids.occluded)?.opacity ?? 0) - 0.25) < 1e-3,
    `${label}: occluded DOM opacity ${domOf(ids.occluded)?.opacity}`,
  );

  // 2b. > 60m: step into the far corner (~69m from the far bot) → hidden
  await page.evaluate(() => window.__test.teleport(-27, 18, -122, 0, 0));
  await waitFrames(page, 3);
  const farRead = await readTags(page);
  const farTag = farRead.tags.find((t) => t.botId === ids.far);
  assert.ok(farTag, `${label}: far bot has no telemetry entry`);
  assert.ok(farTag.actualDist > 60, `${label}: far bot only ${farTag.actualDist}m`);
  assert.equal(farTag.visible, false, `${label}: tag at ${farTag.actualDist}m should hide`);
  assert.ok(!farRead.dom.some((d) => d.id === ids.far), `${label}: far tag DOM visible`);
  await page.evaluate(() => window.__test.teleport(0, 14, 0, 0, 0));
  await waitFrames(page, 3);

  // 3. kill → tag gone within 1 frame (telemetry + DOM)
  const victim = ids.centre;
  const sameTick = await page.evaluate((id) => {
    window.__test.damageEnemy(id, 9999);
    return {
      tele: window.__enemyTags.some((t) => t.botId === id),
      dom: !!document.querySelector(`[data-enemy-tag="${id}"]`),
    };
  }, victim);
  await waitFrames(page, 1);
  const nextFrame = await page.evaluate(
    (id) => ({
      tele: window.__enemyTags.some((t) => t.botId === id),
      dom: !!document.querySelector(`[data-enemy-tag="${id}"]`),
    }),
    victim,
  );
  assert.deepEqual(sameTick, { tele: false, dom: false }, `${label}: killed tag lingered same tick`);
  assert.deepEqual(nextFrame, { tele: false, dom: false }, `${label}: killed tag lingered after 1 frame`);

  // 4. settlement (death panel) → tags hidden & cleared
  await page.evaluate(() => window.__test.hurt(999));
  await page.waitForFunction(() => window.__state?.deathPanelVisible === true, null, { timeout: 60000 });
  await waitFrames(page, 2);
  const settled = await readTags(page);
  assert.equal(settled.tags.length, 0, `${label}: tags present during death settlement`);
  assert.equal(settled.dom.length, 0, `${label}: tag DOM visible during death settlement`);

  assert.deepEqual(errors, [], `${label}: page errors ${errors.join('\n')}`);
  console.log(`[${label}] OK natural=${natVisible.length} visible=${visible.length} killed=${victim}`);
  await ctx.close();
}

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
console.log('ENEMY TAGS E2E OK');
