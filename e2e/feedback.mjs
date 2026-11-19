// F109 feedback test (desktop 1280×720): asserts the procedural-sfx gesture
// unlock, shot counting, hurt flash + direction feedback, low-hp pulse, and
// the persisted mute toggle. Same Firefox-under-xvfb launch as smoke.mjs.
//
// Usage: xvfb-run -a node e2e/feedback.mjs  (TSF_URL overrides the target)

if (!process.env.DISPLAY) {
  console.error('no DISPLAY — run:  xvfb-run -a node e2e/feedback.mjs');
  process.exit(1);
}

const { firefox } = await import('playwright');
const { mkdirSync, statSync } = await import('node:fs');
const { default: assert } = await import('node:assert/strict');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const errors = [];

const browser = await firefox.launch({
  headless: false,
  timeout: 90000,
  // WSL2 blocks firefox's sandbox namespaces — the browser hangs at startup
  // without these. (See: MOZ sandbox + unprivileged userns.)
  env: {
    ...process.env,
    MOZ_DISABLE_CONTENT_SANDBOX: '1',
    MOZ_DISABLE_GMP_SANDBOX: '1',
    MOZ_DISABLE_RDD_SANDBOX: '1',
    MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: '1',
  },
  firefoxUserPrefs: {
    'webgl.force-enabled': true,
    'webgl.disabled': false,
    'gfx.webrender.software': true,
    'webgl.software-rendering': true,
    'layers.acceleration.disabled': true,
  },
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.waitForSelector('canvas#game', { timeout: 10000 });
await page.waitForFunction(() => window.__frames > 90, null, { timeout: 30000 });

// ①a audio is still locked on load — no user gesture has happened yet.
// (read this before clicking start: that click is itself a real gesture)
const unlockedAtLoad = await page.evaluate(() => window.__sfx.unlocked);
assert.strictEqual(unlockedAtLoad, false, 'sfx unlocked before any gesture');

// drive to playing: poll-click the menu start button, then wait out the countdown
await page.waitForFunction(() => window.__match, null, { timeout: 10000 });
for (let i = 0; i < 10; i++) {
  const phase = await page.evaluate(() => window.__match.phase);
  if (phase !== 'menu') break;
  await page.click('[data-btn="start"]').catch(() => {});
  await page.waitForTimeout(200);
}
await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 15000 });

// ①b a real gesture (the start click, or this one) unlocks the audio ctx
await page.mouse.move(640, 360);
await page.mouse.down();
await page.mouse.up();
await page.waitForFunction(() => window.__sfx.unlocked === true, null, { timeout: 5000 });

// ② hold LMB 400ms → shot sfx counted (all shot* events aggregate under `shot`)
await page.mouse.move(640, 360);
await page.mouse.down();
await page.waitForTimeout(400);
await page.mouse.up();
const shotCount = await page.evaluate(() => window.__sfx.counts.shot ?? 0);
assert.ok(shotCount >= 1, `no shot sfx counted (${shotCount})`);

// ③ hurt(45) → hurt overlay flashes above 0.05 within 300ms, fx.hits grows
await page.evaluate(() => window.__test.hurt(45));
const fxHits = await page.evaluate(() => window.__fx.hits);
assert.ok(fxHits >= 1, `fx.hits did not increment (${fxHits})`);
let flash = 0;
const tFlash = Date.now();
while (Date.now() - tFlash < 300) {
  const o = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('[data-fx="hurt"]')).opacity),
  );
  flash = Math.max(flash, o);
  if (o > 0.05) break;
  await page.waitForTimeout(15);
}
assert.ok(flash > 0.05, `hurt overlay never flashed (peak ${flash})`);

// ④ drop to ≤30 hp → low-hp pulse opacity lands in 0.05–0.25 within 1.4s
// (__state.hp refreshes once per frame — wait for it rather than read stale)
await page.evaluate(() => window.__test.hurt(30));
await page.waitForFunction(() => window.__state.hp <= 30, null, { timeout: 2000 });
const hp = await page.evaluate(() => window.__state.hp);
assert.ok(hp > 0 && hp <= 30, `expected 0 < hp ≤ 30, got ${hp}`);
let pulseSeen = false;
const tPulse = Date.now();
while (Date.now() - tPulse < 1400) {
  const o = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('[data-fx="lowhp"]')).opacity),
  );
  if (o >= 0.05 && o <= 0.251) {
    pulseSeen = true;
    break;
  }
  await page.waitForTimeout(25);
}
assert.ok(pulseSeen, 'low-hp pulse never entered the 0.05–0.25 band');
const lowHpPulse = await page.evaluate(() => window.__fx.lowHpPulse);
assert.ok(lowHpPulse > 0, `fx.lowHpPulse is 0`);

// ⑤ mute button persists the setting and silences further counting.
// (firing grabbed pointer lock on the canvas — release it so the button
// receives the click, exactly like a real user pressing Esc first)
await page.evaluate(() => document.exitPointerLock?.());
await page.click('[data-btn="mute"]');
assert.strictEqual(
  await page.evaluate(() => localStorage.getItem('tsf.muted')),
  '1',
  'tsf.muted not persisted to localStorage',
);
const before = await page.evaluate(() => window.__sfx.counts.shot ?? 0);
await page.mouse.move(640, 360);
await page.mouse.down();
await page.waitForTimeout(400);
await page.mouse.up();
const after = await page.evaluate(() => window.__sfx.counts.shot ?? 0);
assert.strictEqual(after, before, `shot counts grew while muted (${before} → ${after})`);

mkdirSync('e2e/shots', { recursive: true });
await page.screenshot({ path: 'e2e/shots/m2-feedback.png' });
const shotSize = statSync('e2e/shots/m2-feedback.png').size;

await browser.close();

assert.ok(errors.length === 0, `JS errors on page:\n${errors.join('\n')}`);
assert.ok(shotSize > 8000, `screenshot looks blank (${shotSize} bytes)`);

console.log(
  `FEEDBACK OK — shots=${shotCount}, hits=${fxHits}, flash=${flash.toFixed(2)}, ` +
    `lowHpPulse=${lowHpPulse}, muted-shot-freeze=${before}→${after}, ` +
    `shot=${(shotSize / 1024).toFixed(0)}KB, errors=0`,
);
