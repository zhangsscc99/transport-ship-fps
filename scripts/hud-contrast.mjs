// HUD contrast & viewmodel framing gate (F217):
// Captures portrait (390×844) and landscape (844×390) with touch UI enabled.
// For each viewport:
//   1. Captures normal frame (saved to e2e/shots/hud217-{portrait,landscape}.png)
//   2. Sets every action [data-btn] background to transparent (no box-shadow) on
//      the exact same paused WebGL frame and captures the "off" frame
//   3. Solves effective alpha per button via alpha ~= (L_off - L_on) / (L_off - L_plate)
//      over interior plate pixels (excluding border, icon, and label) and asserts:
//        - min alpha >= 0.80, max alpha <= 0.97
//        - [data-role=label] computed font-size >= 8.5px, opacity >= 0.95
//   4. Asserts window.__vmRect() framing and action-button layout constraints.
//
// Exits non-zero on any failure.
// Usage: node scripts/hud-contrast.mjs  (defaults to http://127.0.0.1:3028/transport/)

import { mkdirSync } from 'node:fs';

const { chromium } = await import('playwright');

const URL = process.env.TSF_URL ?? 'http://127.0.0.1:3028/transport/';
const OUT = process.env.OUT ?? 'e2e/shots';
const SHOT_TIMEOUT = 150000;
const ACTION_BTNS = ['fire', 'reload', 'swap', 'jump', 'crouch'];
const SECONDARY_BTNS = ['reload', 'swap', 'jump', 'crouch'];
const STICK_R = 56;

// Recorded pre-F217 landscape rifle viewmodel baseline (docs/HUD-BASELINE.md,
// rest midpoint across the ±1.5px idle breathe/sway cycle)
const LANDSCAPE_VM_BASELINE = { x: 417.5, y: 223.9, w: 251.7, h: 166.1, scale: 1 };
const LANDSCAPE_BTN_BASELINE = {
  fire: { x: 758, y: 304, w: 70, h: 70 },
  reload: { x: 700, y: 310, w: 48, h: 48 },
  swap: { x: 712, y: 254, w: 48, h: 48 },
  jump: { x: 770, y: 248, w: 48, h: 48 },
  crouch: { x: 772, y: 196, w: 44, h: 44 },
};

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
];

mkdirSync(OUT, { recursive: true });

function parseRgba(str) {
  const m = String(str).match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

function rectInterArea(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return Number((ix * iy).toFixed(2));
}

function circleRectDist(cx, cy, r) {
  const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w));
  const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
  return Math.hypot(dx, dy);
}

async function runViewport(vp) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    const ctx = await browser.newContext({ viewport: { width: vp.vw, height: vp.vh }, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = Date.now();
    const log = (msg) => console.error(`[${vp.name} #${attempt} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
    try {
      log(`goto ${URL}`);
      await page.goto(URL, { waitUntil: 'commit', timeout: 30000 });
      let frames = 0;
      for (let i = 0; i < 60 && frames < 4; i++) {
        await page.waitForTimeout(400);
        frames = await page.evaluate(() => window.__frames ?? 0).catch(() => 0);
      }
      if (frames < 4) throw new Error('frames never advanced');
      log(`loaded frames=${frames}, clicking start`);
      await page.evaluate(() => {
        document
          .querySelector('[data-btn="start"]')
          ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        window.__test?.clearEnemies?.();
      });
      await page.waitForFunction(() => window.__match?.phase === 'playing', null, { timeout: 240000 });
      const f0 = await page.evaluate(() => window.__frames ?? 0);
      await page.waitForFunction((t) => (window.__frames ?? 0) >= t, f0 + 2, { timeout: 60000 });
      await page.evaluate(() => window.__test.setPaused(true));
      log(`playing & paused`);

      const dom = await page.evaluate((ids) => {
        const vm = window.__vmRect();
        const btns = [];
        for (const id of ids) {
          const el = document.querySelector(`#touch-ui [data-btn="${id}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const icon = el.querySelector('[data-role="icon"]');
          const ir = icon ? icon.getBoundingClientRect() : null;
          const lbl = el.querySelector('[data-role="label"]');
          const lr = lbl ? lbl.getBoundingClientRect() : null;
          const lcs = lbl ? getComputedStyle(lbl) : null;
          btns.push({
            id,
            rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
            bg: cs.backgroundColor,
            circle: cs.borderTopLeftRadius.includes('%') || parseFloat(cs.borderTopLeftRadius) >= r.width * 0.45,
            iconRect: ir ? { x: ir.x, y: ir.y, w: ir.width, h: ir.height } : null,
            labelRect: lr ? { x: lr.x, y: lr.y, w: lr.width, h: lr.height } : null,
            labelSize: lcs ? parseFloat(lcs.fontSize) : 0,
            labelOpacity: lcs ? parseFloat(lcs.opacity) : 0,
            labelColor: lcs ? lcs.color : '',
            labelOverflow: lr ? lr.width > el.clientWidth + 1 : false,
          });
        }
        const stickEl = document.querySelector('#touch-ui [data-stick="idle"]');
        const sr = stickEl ? stickEl.getBoundingClientRect() : null;
        const stick = sr
          ? {
              x: +sr.x.toFixed(1),
              y: +sr.y.toFixed(1),
              w: +sr.width.toFixed(1),
              h: +sr.height.toFixed(1),
              cx: +(sr.x + sr.width / 2).toFixed(1),
              cy: +(sr.y + sr.height / 2).toFixed(1),
              r: +(sr.width / 2).toFixed(1),
            }
          : null;
        const hpEl = document.querySelector('[data-hud="hp"]');
        const hr = hpEl ? hpEl.getBoundingClientRect() : null;
        const hp = hr
          ? { x: +hr.x.toFixed(1), y: +hr.y.toFixed(1), w: +hr.width.toFixed(1), h: +hr.height.toFixed(1) }
          : null;
        const fireBtn = btns.find((b) => b.id === 'fire');
        const fireVmCoverage =
          fireBtn && typeof window.__vmCoverage === 'function' ? window.__vmCoverage(fireBtn.rect) : null;
        return { vm, btns, stick, hp, fireVmCoverage };
      }, ACTION_BTNS);

      // 1. Capture normal screenshot
      const shotPath = `${OUT}/hud217-${vp.name}.png`;
      const pngOn = await page.screenshot({ path: shotPath, timeout: SHOT_TIMEOUT });
      log(`captured normal ${shotPath}`);

      // 2. Make all action [data-btn] backgrounds transparent on the exact same paused frame
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('#touch-ui [data-btn]')) {
          el.dataset.prevBg = el.style.background;
          el.dataset.prevShadow = el.style.boxShadow;
          el.style.background = 'transparent';
          el.style.boxShadow = 'none';
        }
      });
      await page.waitForTimeout(80);
      const pngOff = await page.screenshot({ timeout: SHOT_TIMEOUT });
      log(`captured transparent frame`);

      // Restore button backgrounds
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('#touch-ui [data-btn]')) {
          if (el.dataset.prevBg !== undefined) el.style.background = el.dataset.prevBg;
          if (el.dataset.prevShadow !== undefined) el.style.boxShadow = el.dataset.prevShadow;
        }
      });

      const specs = dom.btns.map((b) => {
        const parsed = parseRgba(b.bg) ?? { r: 14, g: 19, b: 27, a: 0.9 };
        return { ...b, rgb: parsed };
      });
      const contrast = await analyzeContrast(page, pngOn.toString('base64'), pngOff.toString('base64'), specs);
      log(`contrast analyzed`);

      // 3. For portrait, also capture a live "moving + firing" action frame
      let actionShot = null;
      if (vp.name === 'portrait') {
        const fireRect = dom.btns.find((b) => b.id === 'fire')?.rect;
        const stickCx = dom.stick ? dom.stick.cx : 76;
        const stickCy = dom.stick ? dom.stick.cy : 706;
        const fireCx = fireRect ? fireRect.x + fireRect.w / 2 : 328;
        const fireCy = fireRect ? fireRect.y + fireRect.h / 2 : 782;

        const pos0 = await page.evaluate(() => ({
          x: window.__state.x,
          z: window.__state.z,
          ammo: window.__state.ammo,
        }));
        await page.evaluate(() => window.__test.setPaused(false));
        await page.evaluate(
          ({ scx, scy, fcx, fcy }) => {
            const stickZone = document.querySelector('#touch-ui [data-zone="stick"]');
            const fireBtn = document.querySelector('#touch-ui [data-btn="fire"]');
            const mkEv = (type, id, x, y) =>
              new PointerEvent(type, {
                pointerId: id,
                clientX: x,
                clientY: y,
                bubbles: true,
                cancelable: true,
                pointerType: 'touch',
                isPrimary: id === 1,
              });
            stickZone?.dispatchEvent(mkEv('pointerdown', 1, scx, scy));
            window.dispatchEvent(mkEv('pointermove', 1, scx + 12, scy - 46));
            fireBtn?.dispatchEvent(mkEv('pointerdown', 2, fcx, fcy));
          },
          { scx: stickCx, scy: stickCy, fcx: fireCx, fcy: fireCy },
        );

        // Wait until player has moved and fired at least 2 rounds (live motion + recoil/flash)
        await page.waitForFunction(
          (p0) => {
            const s = window.__state;
            if (!s) return false;
            const moved = Math.hypot(s.x - p0.x, s.z - p0.z);
            return s.firing && s.ammo <= p0.ammo - 2 && moved > 0.15;
          },
          pos0,
          { timeout: 60000 },
        );
        await page.evaluate(() => window.__test.setPaused(true));
        const actionPath = `${OUT}/hud217-portrait-action.png`;
        await page.screenshot({ path: actionPath, timeout: SHOT_TIMEOUT });
        const actState = await page.evaluate(() => ({
          ammo: window.__state.ammo,
          firing: window.__state.firing,
          x: +window.__state.x.toFixed(2),
          z: +window.__state.z.toFixed(2),
          vm: window.__vmRect(),
          muzzleFlashSlots: window.__vfx?.muzzleFlashSlots ?? 0,
        }));
        // Release synthetic pointers cleanly
        await page.evaluate(() => {
          for (const id of [1, 2]) {
            window.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, bubbles: true, pointerType: 'touch' }));
          }
        });
        actionShot = {
          path: actionPath,
          movedDist: Number(Math.hypot(actState.x - pos0.x, actState.z - pos0.z).toFixed(2)),
          shotsFired: pos0.ammo - actState.ammo,
          ...actState,
        };
        log(`captured action frame ${actionPath} (moved=${actionShot.movedDist}m, shots=${actionShot.shotsFired})`);
      }

      return { dom, contrast, errors, shotPath, actionShot };
    } catch (e) {
      lastErr = e;
      log(`FAILED attempt ${attempt}: ${String(e).split('\n')[0]}`);
    } finally {
      await ctx.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
  throw lastErr ?? new Error(`viewport ${vp.name} failed`);
}

async function analyzeContrast(page, onB64, offB64, btnSpecs) {
  return page.evaluate(
    async ({ onStr, offStr, specs }) => {
      const decode = async (b64) => {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const imgOn = await decode(onStr);
      const imgOff = await decode(offStr);
      const W = imgOn.width;
      const H = imgOn.height;
      const lumaAt = (img, x, y) => {
        const i = (y * W + x) * 4;
        return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      };

      const results = [];
      for (const s of specs) {
        const lPlate = 0.299 * s.rgb.r + 0.587 * s.rgb.g + 0.114 * s.rgb.b;
        const cx = s.rect.x + s.rect.w / 2;
        const cy = s.rect.y + s.rect.h / 2;
        const rInner = Math.min(s.rect.w, s.rect.h) / 2 - 4;
        const x0 = Math.max(0, Math.ceil(s.rect.x + 4));
        const x1 = Math.min(W - 1, Math.floor(s.rect.x + s.rect.w - 4));
        const y0 = Math.max(0, Math.ceil(s.rect.y + 4));
        const y1 = Math.min(H - 1, Math.floor(s.rect.y + s.rect.h - 4));

        const inBox = (px, py, b, pad) =>
          b && px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad;

        let sumNum = 0;
        let sumDen = 0;
        let sumOn = 0;
        let sumOff = 0;
        let count = 0;
        let allCount = 0;
        let allOn = 0;
        let allOff = 0;

        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (s.circle) {
              const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
              if (d > rInner) continue;
            } else {
              // skip 10px rounded corners
              const rx = Math.max(s.rect.x + 11 - (x + 0.5), x + 0.5 - (s.rect.x + s.rect.w - 11), 0);
              const ry = Math.max(s.rect.y + 11 - (y + 0.5), y + 0.5 - (s.rect.y + s.rect.h - 11), 0);
              if (rx > 0 && ry > 0 && Math.hypot(rx, ry) > 6) continue;
            }
            if (inBox(x + 0.5, y + 0.5, s.iconRect, 2)) continue;
            if (inBox(x + 0.5, y + 0.5, s.labelRect, 2)) continue;

            const lOn = lumaAt(imgOn, x, y);
            const lOff = lumaAt(imgOff, x, y);
            allCount++;
            allOn += lOn;
            allOff += lOff;
            const denom = lOff - lPlate;
            if (Math.abs(denom) >= 8) {
              const sign = denom >= 0 ? 1 : -1;
              sumNum += sign * (lOff - lOn);
              sumDen += sign * denom;
              sumOn += lOn;
              sumOff += lOff;
              count++;
            }
          }
        }
        const alpha = sumDen > 1e-3 ? sumNum / sumDen : allCount > 0 ? (allOff / allCount - allOn / allCount) / Math.max(1e-3, allOff / allCount - lPlate) : 0;
        results.push({
          id: s.id,
          alpha: Number(alpha.toFixed(4)),
          lOn: Number((count ? sumOn / count : allCount ? allOn / allCount : 0).toFixed(2)),
          lOff: Number((count ? sumOff / count : allCount ? allOff / allCount : 0).toFixed(2)),
          lPlate: Number(lPlate.toFixed(2)),
          samples: count,
          totalInterior: allCount,
        });
      }
      return results;
    },
    { onStr: onB64, offStr: offB64, specs: btnSpecs },
  );
}

const failures = [];
const report = {};

for (const vp of [
  { name: 'portrait', vw: 390, vh: 844 },
  { name: 'landscape', vw: 844, vh: 390 },
]) {
  const { dom, contrast, errors, shotPath, actionShot } = await runViewport(vp);

  if (dom.btns.length !== ACTION_BTNS.length) {
    failures.push(`${vp.name}: expected ${ACTION_BTNS.length} action buttons, found ${dom.btns.length}`);
  }

  // Assert effective alpha & label typography
  let minAlpha = Infinity;
  let maxAlpha = -Infinity;
  for (let i = 0; i < dom.btns.length; i++) {
    const b = dom.btns[i];
    const c = contrast[i];
    if (c.alpha < minAlpha) minAlpha = c.alpha;
    if (c.alpha > maxAlpha) maxAlpha = c.alpha;
    if (c.samples < 10) {
      failures.push(`${vp.name}/${b.id}: too few contrasting interior samples (${c.samples})`);
    }
    if (c.alpha < 0.80 || c.alpha > 0.97) {
      failures.push(`${vp.name}/${b.id}: effective alpha ${c.alpha} outside [0.80, 0.97]`);
    }
    if (b.labelSize < 8.5) {
      failures.push(`${vp.name}/${b.id}: label font-size ${b.labelSize}px < 8.5px`);
    }
    if (b.labelOpacity < 0.95) {
      failures.push(`${vp.name}/${b.id}: label opacity ${b.labelOpacity} < 0.95`);
    }
    if (b.labelOverflow) {
      failures.push(`${vp.name}/${b.id}: label overflows button width`);
    }
  }

  // Assert viewmodel & composition layout
  const vm = dom.vm;
  let composition = null;
  if (vp.name === 'portrait') {
    const rightEdge = Number((vm.x + vm.w).toFixed(1));
    const bottomEdge = Number((vm.y + vm.h).toFixed(1));
    const minBottom = Number((0.98 * vp.vh).toFixed(2));

    // 5 portrait __vmRect composition gates (F217b: natural bottom-right hold)
    if (vm.x < 110) {
      failures.push(`portrait vm.x ${vm.x} < 110`);
    }
    if (rightEdge < 355) {
      failures.push(`portrait vm right edge (x+w) ${rightEdge} < 355`);
    }
    if (bottomEdge < minBottom) {
      failures.push(`portrait vm bottom edge (y+h) ${bottomEdge} < ${minBottom} (0.98*vh)`);
    }
    if (vm.h < 186 || vm.h > 354) {
      failures.push(`portrait vm.h ${vm.h} outside [186, 354]`);
    }
    if (vm.scale < 0.74 || vm.scale > 0.80) {
      failures.push(`portrait vm.scale ${vm.scale} outside [0.74, 0.80]`);
    }

    // Crosshair 120px circle clearance for viewmodel
    const cx = vp.vw / 2;
    const cy = vp.vh / 2;
    const vmCrossDist = Number(circleRectDist(cx, cy, vm).toFixed(1));
    if (vmCrossDist < 120) {
      failures.push(`portrait vm overlaps center crosshair 120px circle (dist=${vmCrossDist}px)`);
    }

    // Portrait 5-button edge margins & pairwise spacing
    let minPairGap = Infinity;
    for (let i = 0; i < dom.btns.length; i++) {
      const a = dom.btns[i].rect;
      if (a.x < 8 || a.y < 8 || vp.vw - (a.x + a.w) < 8 || vp.vh - (a.y + a.h) < 8) {
        failures.push(`portrait ${dom.btns[i].id} violates 8px edge margin`);
      }
      for (let j = i + 1; j < dom.btns.length; j++) {
        const b = dom.btns[j].rect;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
        const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
        const gap = Math.hypot(dx, dy);
        if (gap < minPairGap) minPairGap = gap;
        if (overlap || gap < 6) {
          failures.push(`portrait ${dom.btns[i].id}<->${dom.btns[j].id} gap=${gap.toFixed(1)}px (<6)`);
        }
      }
    }

    // 4 secondary buttons: 0 intersection with vm bbox, non-intersecting with r=56 joystick circle,
    // clear of HP bar, below screen midline, and outside 120px center crosshair circle
    const stickCenter = dom.stick ? { cx: dom.stick.cx, cy: dom.stick.cy } : { cx: 20 + STICK_R, cy: vp.vh - 82 - STICK_R };
    const secondaryVmBboxInter = {};
    const secondaryStickClearance = {};
    const secondaryCrossDist = {};
    for (const id of SECONDARY_BTNS) {
      const btn = dom.btns.find((b) => b.id === id);
      if (!btn) continue;
      const r = btn.rect;
      const vmInter = rectInterArea(r, vm);
      secondaryVmBboxInter[id] = vmInter;
      if (vmInter > 0) {
        failures.push(`portrait secondary ${id} intersects vm bbox (area=${vmInter}px^2 > 0)`);
      }
      const sDist = circleRectDist(stickCenter.cx, stickCenter.cy, r);
      secondaryStickClearance[id] = Number((sDist - STICK_R).toFixed(1));
      if (sDist < STICK_R) {
        failures.push(`portrait secondary ${id} intersects r=${STICK_R} joystick circle (dist=${sDist.toFixed(1)}px)`);
      }
      if (dom.hp) {
        const hpInter = rectInterArea(r, dom.hp);
        if (hpInter > 0) {
          failures.push(`portrait secondary ${id} overlaps HP bar (area=${hpInter}px^2)`);
        }
      }
      const cDist = Number(circleRectDist(cx, cy, r).toFixed(1));
      secondaryCrossDist[id] = cDist;
      if (cDist < 120) {
        failures.push(`portrait secondary ${id} intrudes 120px crosshair circle (dist=${cDist}px)`);
      }
      if (r.y < vp.vh / 2) {
        failures.push(`portrait secondary ${id} top y=${r.y} above screen midline ${vp.vh / 2}`);
      }
    }

    // FIRE button margins 24+-2 and viewmodel silhouette overlap <= 40% of FIRE area
    const fire = dom.btns.find((b) => b.id === 'fire')?.rect;
    let fireMargins = null;
    if (fire) {
      const rm = Number((vp.vw - (fire.x + fire.w)).toFixed(1));
      const bm = Number((vp.vh - (fire.y + fire.h)).toFixed(1));
      fireMargins = { right: rm, bottom: bm };
      if (Math.abs(rm - 24) > 2 || Math.abs(bm - 24) > 2) {
        failures.push(`portrait FIRE margins right=${rm}, bottom=${bm} outside 24+-2px`);
      }
    }
    const cov = dom.fireVmCoverage;
    if (!cov) {
      failures.push('portrait missing window.__vmCoverage(fire) measurement');
    } else {
      if (cov.rectRatio > 0.40) {
        failures.push(`portrait FIRE rect vs vm overlap ${(cov.rectRatio * 100).toFixed(2)}% > 40%`);
      }
      if (cov.circleRatio > 0.40) {
        failures.push(`portrait FIRE circle vs vm overlap ${(cov.circleRatio * 100).toFixed(2)}% > 40%`);
      }
    }

    composition = {
      vmRight: rightEdge,
      vmBottom: bottomEdge,
      vmCrossDist,
      minPairGap: Number(minPairGap.toFixed(1)),
      stick: dom.stick,
      hp: dom.hp,
      fireMargins,
      secondaryVmBboxInter,
      secondaryStickClearance,
      secondaryCrossDist,
      fireVmCoverage: cov,
    };
  } else {
    if (vm.scale !== 1) failures.push(`landscape vm scale ${vm.scale} !== 1`);
    for (const k of ['x', 'y', 'w', 'h']) {
      const diff = Math.abs(vm[k] - LANDSCAPE_VM_BASELINE[k]);
      if (diff > 2) {
        failures.push(`landscape vm.${k}=${vm[k]} drifted ${diff.toFixed(1)}px from baseline ${LANDSCAPE_VM_BASELINE[k]}`);
      }
    }
    for (const b of dom.btns) {
      const exp = LANDSCAPE_BTN_BASELINE[b.id];
      for (const k of ['x', 'y', 'w', 'h']) {
        if (Math.abs(b.rect[k] - exp[k]) > 0.5) {
          failures.push(`landscape ${b.id}.${k}=${b.rect[k]} !== baseline ${exp[k]}`);
        }
      }
    }
  }

  if (errors.length) failures.push(`${vp.name}: page errors: ${errors.join('; ')}`);

  report[vp.name] = {
    shot: shotPath,
    ...(actionShot ? { actionShot } : {}),
    vm,
    vmRight: Number((vm.x + vm.w).toFixed(1)),
    vmBottom: Number((vm.y + vm.h).toFixed(1)),
    ...(composition ? { composition } : {}),
    minAlpha: Number(minAlpha.toFixed(4)),
    maxAlpha: Number(maxAlpha.toFixed(4)),
    buttons: dom.btns.map((b, i) => ({
      id: b.id,
      rect: b.rect,
      labelSize: b.labelSize,
      labelOpacity: b.labelOpacity,
      labelColor: b.labelColor,
      ...contrast[i],
    })),
  };
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error('HUD-CONTRAST FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('HUD-CONTRAST OK');
