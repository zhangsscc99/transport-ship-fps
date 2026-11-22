// Enemy overhead distance & HP tags e2e (distance-only `^\d+m$`, zero names/factions).
// Portrait 390×844 + landscape 844×390 (hasTouch).
// Usage: node e2e/enemyTags.mjs  (server on 127.0.0.1:3028, or TSF_URL=...)

const { chromium } = await import('playwright');
const { default: assert } = await import('node:assert/strict');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];
const TEXT_RE = /^\d+m$/;
const FORBIDDEN_RE = new RegExp(
  ['\\u6f5c\\u4f0f\\u8005', '\\u4fdd\\u536b\\u8005', 'defend' + 'er', 'attack' + 'er'].join('|'),
  'i',
);

const waitFrames = (page, n) =>
  page.evaluate(
    (count) =>
      new Promise((res) => {
        const start = window.__frames ?? 0;
        const tick = () => ((window.__frames ?? 0) - start >= count ? res() : requestAnimationFrame(tick));
        tick();
      }),
    n,
  );

const readTags = (page) =>
  page.evaluate(() => {
    const dom = [];
    for (const el of document.querySelectorAll('[data-enemy-tag]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const pill = el.querySelector('[data-role="dist-pill"]');
      const dot = el.querySelector('[data-role="close-dot"]');
      const hp = el.querySelector('[data-role="hp-bar"]');
      const hpFill = el.querySelector('[data-role="hp-fill"]');
      const r = el.getBoundingClientRect();
      const pr = pill?.getBoundingClientRect();
      const hr = hp?.getBoundingClientRect();
      dom.push({
        id: el.dataset.enemyTag,
        text: (el.textContent ?? '').trim(),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        opacity: Number(cs.opacity),
        borderColor: pill ? getComputedStyle(pill).borderTopColor : '',
        dotVisible: dot ? getComputedStyle(dot).display !== 'none' : false,
        hpW: hr ? Number(hr.width.toFixed(1)) : 0,
        hpH: hr ? Number(hr.height.toFixed(1)) : 0,
        hpGap: hr && pr ? Number((hr.top - pr.bottom).toFixed(1)) : 0,
        hpColor: hpFill ? getComputedStyle(hpFill).backgroundColor : '',
      });
    }
    return {
      vw: innerWidth,
      vh: innerHeight,
      html: document.documentElement.innerHTML,
      tags: JSON.parse(JSON.stringify(window.__enemyTags ?? [])),
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
  for (let i = 0; i < 40 && frames <= 10; i++) {
    await page.waitForTimeout(400);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 10, `${label}: page never rendered frames`);

  const menu = await readTags(page);
  assert.equal(menu.tags.length, 0, `${label}: tags present in menu`);
  assert.equal(menu.dom.length, 0, `${label}: tag DOM visible in menu`);
  assert.equal(FORBIDDEN_RE.test(menu.html), false, `${label}: forbidden faction wording in menu DOM`);

  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 120000 });

  const ids = await page.evaluate(() => {
    window.__test.clearEnemies();
    window.__test.teleport(0, 17, 0, 0, 0);
    const eClose = window.__test.spawnEnemyAt(-1.2, 9.5, 180, 'enemy'); // ~7.5m (<10m warm)
    const eMid = window.__test.spawnEnemyAt(1.8, 3.0, 180, 'enemy'); // ~14m (<25m full)
    const eFade = window.__test.spawnEnemyAt(0, -13.0, 180, 'enemy'); // ~30m (25-40m -> 0.45)
    const eFar = window.__test.spawnEnemyAt(-26, -18, 180, 'enemy'); // >43m -> hidden
    window.__test.damageEnemy(eMid, 50); // 50% HP -> yellow
    return { eClose, eMid, eFade, eFar };
  });
  await waitFrames(page, 3);
  const s = await readTags(page);

  assert.equal(FORBIDDEN_RE.test(s.html), false, `${label}: forbidden wording in combat DOM`);
  assert.ok(s.dom.length <= 5, `${label}: >5 visible tags (${s.dom.length})`);
  for (const d of s.dom) {
    assert.match(d.text, TEXT_RE, `${label}: bad distance text "${d.text}"`);
    assert.ok(d.hpW === 42 && d.hpH === 3, `${label}: hp bar ${d.hpW}x${d.hpH} !== 42x3`);
    assert.ok(Math.abs(d.hpGap - 4) <= 1, `${label}: hp gap ${d.hpGap}px !== 4px`);
  }

  const domOf = (id) => s.dom.find((d) => d.id === id);
  assert.equal(domOf(ids.eClose)?.dotVisible, true, `${label}: <10m warm dot missing`);
  assert.equal(domOf(ids.eClose)?.borderColor, 'rgb(255, 180, 84)', `${label}: <10m border not #FFB454`);
  assert.equal(domOf(ids.eMid)?.opacity, 1, `${label}: <25m opacity !== 1`);
  assert.ok(Math.abs((domOf(ids.eFade)?.opacity ?? 0) - 0.45) < 0.02, `${label}: 25-40m opacity !== 0.45`);
  assert.equal(domOf(ids.eFar), undefined, `${label}: >40m tag should be hidden`);

  // Kill removes tag within 1 frame
  await page.evaluate((id) => window.__test.damageEnemy(id, 9999), ids.eClose);
  await waitFrames(page, 1);
  const afterKill = await readTags(page);
  assert.equal(afterKill.dom.some((d) => d.id === ids.eClose), false, `${label}: killed tag lingered`);

  assert.deepEqual(errors, [], `${label}: page errors ${errors.join('\n')}`);
  console.log(`[${label}] ENEMY TAGS OK (visible=${s.dom.length})`);
  await ctx.close();
}

for (const [label, vp] of [
  ['portrait', { width: 390, height: 844 }],
  ['landscape', { width: 844, height: 390 }],
]) {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    await runViewport(browser, label, vp);
  } finally {
    await browser.close();
  }
}
console.log('ENEMY TAGS E2E OK');
