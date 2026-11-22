import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTRAIT_LAYOUT,
  LANDSCAPE_LAYOUT,
  STICK_R,
  type BtnAnchor,
  type LayoutSpec,
  type TouchBtnId,
} from '../input/touch.ts';

interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
}

const BTN_IDS: readonly TouchBtnId[] = ['fire', 'reload', 'swap', 'jump', 'crouch'];
const SECONDARY_IDS: readonly TouchBtnId[] = ['reload', 'swap', 'jump', 'crouch'];

function anchorToRect(id: TouchBtnId, a: BtnAnchor, vw: number, vh: number): Rect {
  const x = a.side === 'right' ? vw - a.x - a.size : a.x;
  const y = vh - a.bottom - a.size;
  return {
    id,
    x,
    y,
    w: a.size,
    h: a.size,
    right: x + a.size,
    bottom: y + a.size,
    cx: x + a.size / 2,
    cy: y + a.size / 2,
  };
}

function stickRect(spec: LayoutSpec, vh: number): Rect {
  const d = STICK_R * 2;
  const x = spec.stick.left;
  const y = vh - spec.stick.bottom - d;
  return { id: 'stick', x, y, w: d, h: d, right: x + d, bottom: y + d, cx: x + STICK_R, cy: y + STICK_R };
}

function layoutRects(spec: LayoutSpec, vw: number, vh: number): Record<TouchBtnId, Rect> {
  const out = {} as Record<TouchBtnId, Rect>;
  for (const id of BTN_IDS) {
    out[id] = anchorToRect(id, spec.btns[id], vw, vh);
  }
  return out;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}

function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - b.right, b.x - a.right);
  const dy = Math.max(0, a.y - b.bottom, b.y - a.bottom);
  return Math.hypot(dx, dy);
}

for (const { name, spec, vw, vh, hpWidth } of [
  { name: 'portrait 390x844', spec: PORTRAIT_LAYOUT, vw: 390, vh: 844, hpWidth: 196 },
  { name: 'landscape 844x390', spec: LANDSCAPE_LAYOUT, vw: 844, vh: 390, hpWidth: 206 },
]) {
  test(`${name}: all 5 action buttons sit on right side, hit target >= 56px, fire radius >= 64px, gap >= 10px, clear of stick/HP/crosshair`, () => {
    const rects = layoutRects(spec, vw, vh);
    const list = BTN_IDS.map((id) => rects[id]);
    const stick = stickRect(spec, vh);
    const hp: Rect = {
      id: 'hp',
      x: 16,
      y: vh - 78,
      w: hpWidth,
      h: 60,
      right: 16 + hpWidth,
      bottom: vh - 18,
      cx: 16 + hpWidth / 2,
      cy: vh - 48,
    };

    // Every action button on right side, >= 56px, inside viewport with >= 8px edge margin
    for (const id of BTN_IDS) {
      const a = spec.btns[id];
      const r = rects[id];
      assert.equal(a.side, 'right', `${name}: ${id} must be right-anchored`);
      assert.ok(r.cx > vw / 2, `${name}: ${id} center x=${r.cx} <= vw/2 (${vw / 2})`);
      assert.ok(r.x > vw / 2, `${name}: ${id} left x=${r.x} crosses midline ${vw / 2}`);
      assert.ok(r.w >= 56 && r.h >= 56, `${name}: ${id} size ${r.w}x${r.h} < 56px`);
      assert.ok(r.x >= 8 && r.y >= 8 && vw - r.right >= 8 && vh - r.bottom >= 8, `${name}: ${id} edge margin < 8px`);
      assert.equal(rectsOverlap(r, stick), false, `${name}: ${id} overlaps joystick`);
      assert.equal(rectsOverlap(r, hp), false, `${name}: ${id} overlaps HP bar`);
    }

    // FIRE button is the largest button with radius >= 64px (diameter >= 128px)
    assert.ok(rects.fire.w >= 128 && rects.fire.h >= 128, `${name}: FIRE diameter ${rects.fire.w} < 128 (r<64)`);
    for (const id of SECONDARY_IDS) {
      assert.ok(rects.fire.w > rects[id].w, `${name}: FIRE should be larger than ${id}`);
    }

    // Pairwise non-overlap and gap >= 10px
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        assert.equal(rectsOverlap(a, b), false, `${name}: ${a.id} overlaps ${b.id}`);
        const gap = rectGap(a, b);
        assert.ok(gap >= 10, `${name}: ${a.id} <-> ${b.id} gap ${gap.toFixed(1)}px < 10px`);
      }
    }

    // Exact 2x2 grid above FIRE: RELOAD above FIRE, SWAP left of RELOAD, JUMP & CROUCH on upper row
    const xs = new Set(SECONDARY_IDS.map((id) => rects[id].x));
    const ys = new Set(SECONDARY_IDS.map((id) => rects[id].y));
    assert.equal(xs.size, 2, `${name}: expected 2 columns in 2x2 secondary grid`);
    assert.equal(ys.size, 2, `${name}: expected 2 rows in 2x2 secondary grid`);
    assert.ok(rects.reload.bottom < rects.fire.y, `${name}: RELOAD must sit above FIRE`);
    assert.ok(rects.swap.right < rects.reload.x, `${name}: SWAP must sit left of RELOAD`);
    assert.ok(rects.jump.bottom < rects.reload.y, `${name}: JUMP must sit above RELOAD`);
    assert.ok(rects.crouch.bottom < rects.swap.y, `${name}: CROUCH must sit above SWAP`);

    // Outside 120px center crosshair circle
    const cx = vw / 2;
    const cy = vh / 2;
    for (const r of list) {
      const dx = Math.max(r.x - cx, 0, cx - r.right);
      const dy = Math.max(r.y - cy, 0, cy - r.bottom);
      const dist = Math.hypot(dx, dy);
      assert.ok(dist >= 120, `${name}: ${r.id} intrudes into 120px crosshair circle (dist=${dist.toFixed(1)}px)`);
    }
  });
}

test('joystick anchor stays unchanged at bottom-left in both portrait and landscape', () => {
  assert.deepEqual(PORTRAIT_LAYOUT.stick, { left: 20, bottom: 82 });
  assert.deepEqual(LANDSCAPE_LAYOUT.stick, { left: 20, bottom: 72 });
  assert.equal(STICK_R, 56);
});
