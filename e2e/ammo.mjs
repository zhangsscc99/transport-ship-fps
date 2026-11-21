// Ammo & reload lifecycle e2e test (Round 5: rifle + gatling only):
//   1. Entering a match starts with strictly 2 weapons (rifle=30, gatling=300)
//      and DOM ammo readout matches `ammo === mag`.
//   2. Firing one shot on rifle drops ammo to `mag - 1` (both state and DOM bar).
//   3. Triggering reload refills ammo back to `mag` after reloadMs WITHOUT
//      requiring another fire press.
// Usage: node e2e/ammo.mjs  (server must run on 127.0.0.1:3028)

const { chromium } = await import('playwright');
const { default: assert } = await import('node:assert/strict');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

async function readAmmo(page) {
  return page.evaluate(() => {
    const segs = Array.from(document.querySelectorAll('[data-hud="ammo-bar"] > div'));
    const visible = segs.filter((el) => el.style.display !== 'none');
    const lit = visible.filter((el) => el.dataset.lit === '1');
    const gatRows = Array.from(document.querySelectorAll('[data-gatling-row]'));
    const numEl = document.querySelector('[data-hud="ammo-num"]');
    const hudMode = document.querySelector('[data-hud="ammo"]')?.getAttribute('data-hud-mode');
    return {
      ammo: window.__state.ammo,
      mag: window.__state.mag,
      weapon: window.__state.weapon,
      weapons: window.__state.weapons,
      reloading: window.__state.reloading,
      domNum: numEl ? Number(numEl.textContent?.trim()) : NaN,
      hudMode,
      visibleSegs: visible.length,
      litSegs: lit.length,
      gatRows: gatRows.length,
    };
  });
}

async function tapBtn(page, id, holdMs = 0) {
  await page.evaluate((btnId) => {
    const el = document.querySelector(`[data-btn="${btnId}"]`);
    if (!el) throw new Error(`missing [data-btn="${btnId}"]`);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 55,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
  }, id);
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 55, bubbles: true, pointerType: 'touch' }),
    );
  });
}

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'commit', timeout: 20000 });
  let frames = 0;
  for (let i = 0; i < 40 && frames <= 15; i++) {
    await page.waitForTimeout(800);
    frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
  }
  assert.ok(frames > 15, 'page never rendered frames');

  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 30000 });
  await page.waitForTimeout(250);

  // 1. Initial full mag for strictly 2 weapons: rifle (30) <-> gatling (300) <-> rifle (30)
  const expected = [
    ['rifle', 30],
    ['gatling', 300],
    ['rifle', 30],
  ];
  for (let i = 0; i < expected.length; i++) {
    const [wId, mag] = expected[i];
    if (i > 0) {
      await tapBtn(page, 'swap');
      await page.waitForFunction((id) => window.__state.weapon === id, wId, { timeout: 10000 });
      await page.waitForTimeout(200);
    }
    const snap = await readAmmo(page);
    assert.deepStrictEqual(snap.weapons, ['rifle', 'gatling']);
    assert.strictEqual(snap.weapon, wId, `expected weapon ${wId}, got ${snap.weapon}`);
    assert.strictEqual(snap.mag, mag, `${wId}: mag ${snap.mag} !== ${mag}`);
    assert.strictEqual(snap.ammo, mag, `${wId}: initial ammo ${snap.ammo} !== mag ${mag}`);
    assert.strictEqual(snap.domNum, mag, `${wId}: DOM ammo ${snap.domNum} !== ${mag}`);
    assert.strictEqual(snap.hudMode, wId, `${wId}: HUD mode mismatch (${snap.hudMode})`);
    if (wId === 'rifle') {
      assert.strictEqual(snap.visibleSegs, 30);
      assert.strictEqual(snap.litSegs, 30);
    } else {
      assert.strictEqual(snap.gatRows, 3, 'gatling HUD must have 3×100 rows');
    }
  }

  // 2. Fire single shot on rifle -> ammo === 29
  const beforeFire = await readAmmo(page);
  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="fire"]');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: 56,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        pointerType: 'touch',
      }),
    );
  });
  await page.waitForFunction((a0) => window.__state.ammo < a0, beforeFire.ammo, { timeout: 10000 });
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 56, bubbles: true, pointerType: 'touch' }),
    );
  });
  await page.waitForTimeout(200);
  const afterFire = await readAmmo(page);
  assert.strictEqual(afterFire.ammo, beforeFire.mag - 1);
  assert.strictEqual(afterFire.domNum, afterFire.ammo);
  assert.strictEqual(afterFire.litSegs, afterFire.ammo);

  // 3. Reload -> refills back to 30
  await tapBtn(page, 'reload');
  await page.waitForFunction(() => window.__state.reloading === true, null, { timeout: 10000 });
  await page.waitForFunction(
    (mag) => window.__state.reloading === false && window.__state.ammo === mag,
    beforeFire.mag,
    { timeout: 15000 },
  );
  await page.waitForTimeout(200);
  const afterReload = await readAmmo(page);
  assert.strictEqual(afterReload.ammo, beforeFire.mag);
  assert.strictEqual(afterReload.domNum, beforeFire.mag);
  assert.strictEqual(afterReload.litSegs, beforeFire.mag);

  assert.strictEqual(errors.length, 0, `JS errors:\n${errors.join('\n')}`);
  console.log(
    `AMMO OK — rifle 30 / gatling 300 (3×100 HUD), single-shot ${beforeFire.ammo}→${afterFire.ammo}, reload→${afterReload.ammo}, errors=0`,
  );
} finally {
  await browser.close();
}
