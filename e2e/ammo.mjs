// Ammo & reload lifecycle e2e test (Round 3 Part B):
//   1. Entering a match starts with full mag (rifle=30, sniper=5, shotgun=6)
//      and DOM ammo readout + lit segment count match `ammo === mag`.
//   2. Firing one shot drops ammo to `mag - 1` (both state and DOM bar).
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
    const numEl = document.querySelector('[data-hud="ammo-num"]');
    return {
      ammo: window.__state.ammo,
      mag: window.__state.mag,
      weapon: window.__state.weapon,
      reloading: window.__state.reloading,
      domNum: numEl ? Number(numEl.textContent?.trim()) : NaN,
      visibleSegs: visible.length,
      litSegs: lit.length,
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

  // Start match
  await page.evaluate(() => {
    const el = document.querySelector('[data-btn="start"]');
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 30000 });
  await page.waitForTimeout(250);

  // 1. Initial full mag for rifle (30), sniper (5), shotgun (6), back to rifle (30)
  const expected = [
    ['rifle', 30],
    ['sniper', 5],
    ['shotgun', 6],
    ['rifle', 30],
  ];
  for (let i = 0; i < expected.length; i++) {
    const [wId, mag] = expected[i];
    if (i > 0) {
      await tapBtn(page, 'swap');
      await page.waitForFunction((id) => window.__state.weapon === id, wId, { timeout: 10000 });
      await page.waitForTimeout(150);
    }
    const snap = await readAmmo(page);
    assert.strictEqual(snap.weapon, wId, `expected weapon ${wId}, got ${snap.weapon}`);
    assert.strictEqual(snap.mag, mag, `${wId}: mag ${snap.mag} !== ${mag}`);
    assert.strictEqual(snap.ammo, mag, `${wId}: initial ammo ${snap.ammo} !== mag ${mag}`);
    assert.strictEqual(snap.domNum, mag, `${wId}: DOM ammo ${snap.domNum} !== ${mag}`);
    assert.strictEqual(snap.visibleSegs, mag, `${wId}: visible segments ${snap.visibleSegs} !== ${mag}`);
    assert.strictEqual(snap.litSegs, mag, `${wId}: lit segments ${snap.litSegs} !== ${mag}`);
  }

  // 2. Fire single shot on rifle -> ammo === mag - 1 (29)
  // Wait for 1 shot cleanly: press fire, wait until ammo drops by 1, release immediately
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
  assert.strictEqual(
    afterFire.ammo,
    beforeFire.mag - 1,
    `expected 1 shot to leave mag-1 (${beforeFire.mag - 1}), got ${afterFire.ammo}`,
  );
  assert.strictEqual(afterFire.domNum, afterFire.ammo, 'DOM numeral out of sync after shot');
  assert.strictEqual(afterFire.litSegs, afterFire.ammo, 'DOM bar out of sync after shot');

  // 3. Reload -> wait until reload finishes WITHOUT pressing fire -> ammo === mag
  await tapBtn(page, 'reload');
  await page.waitForFunction(() => window.__state.reloading === true, null, { timeout: 10000 });
  await page.waitForFunction(
    (mag) => window.__state.reloading === false && window.__state.ammo === mag,
    beforeFire.mag,
    { timeout: 10000 },
  );
  await page.waitForTimeout(200);
  const afterReload = await readAmmo(page);
  assert.strictEqual(afterReload.ammo, beforeFire.mag, `reload did not restore mag (${afterReload.ammo})`);
  assert.strictEqual(afterReload.domNum, beforeFire.mag, 'DOM numeral did not restore after reload');
  assert.strictEqual(afterReload.litSegs, beforeFire.mag, 'DOM segments did not restore after reload');

  assert.strictEqual(errors.length, 0, `JS errors:\n${errors.join('\n')}`);
  console.log(
    `AMMO OK — rifle 30 / sniper 5 / shotgun 6 initial full, single-shot ${beforeFire.ammo}→${afterFire.ammo}, reload→${afterReload.ammo}, errors=0`,
  );
} finally {
  await browser.close();
}
