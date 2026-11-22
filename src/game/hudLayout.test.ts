import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTRAIT_LAYOUT,
  LANDSCAPE_LAYOUT,
  type BtnAnchor,
  type LayoutSpec,
  type TouchBtnId,
} from '../input/touch.ts';

interface Rect {
  id: TouchBtnId;
  x: number;
  y: number;
  w: number;
  h: number;
  right: number;
  bottom: number;
}

const BTN_IDS: readonly TouchBtnId[] = ['fire', 'reload', 'swap', 'jump', 'crouch'];

function anchorToRect(id: TouchBtnId, a: BtnAnchor, vw: number, vh: number): Rect {
  const x = a.side === 'right' ? vw - a.x - a.size : a.x;
  const y = vh - a.bottom - a.size;
  return { id, x, y, w: a.size, h: a.size, right: x + a.size, bottom: y + a.size };
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

/** Edge-to-edge Euclidean distance between two non-overlapping axis-aligned rects. */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - b.right, b.x - a.right);
  const dy = Math.max(0, a.y - b.bottom, b.y - a.bottom);
  return Math.hypot(dx, dy);
}

test('portrait 390x844: 5 action button rects never overlap, pairwise gap >= 6px, edge margin >= 8px, FIRE margin 24+-2px', () => {
  const VW = 390;
  const VH = 844;
  const rects = layoutRects(PORTRAIT_LAYOUT, VW, VH);
  const list = BTN_IDS.map((id) => rects[id]);

  // Every hit rect >= 44px and >= 8px from all 4 viewport edges
  for (const r of list) {
    assert.ok(r.w >= 44 && r.h >= 44, `${r.id} size ${r.w}x${r.h} < 44px`);
    assert.ok(r.x >= 8, `${r.id} left margin ${r.x} < 8px`);
    assert.ok(r.y >= 8, `${r.id} top margin ${r.y} < 8px`);
    assert.ok(VW - r.right >= 8, `${r.id} right margin ${VW - r.right} < 8px`);
    assert.ok(VH - r.bottom >= 8, `${r.id} bottom margin ${VH - r.bottom} < 8px`);
  }

  // FIRE right & bottom margins within 24 +- 2px
  const fire = rects.fire;
  const fireRightMargin = VW - fire.right;
  const fireBottomMargin = VH - fire.bottom;
  assert.ok(
    Math.abs(fireRightMargin - 24) <= 2,
    `FIRE right margin ${fireRightMargin} outside 24+-2px`,
  );
  assert.ok(
    Math.abs(fireBottomMargin - 24) <= 2,
    `FIRE bottom margin ${fireBottomMargin} outside 24+-2px`,
  );

  // Pairwise non-overlap and gap >= 6px
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      assert.equal(rectsOverlap(a, b), false, `${a.id} overlaps ${b.id}`);
      const gap = rectGap(a, b);
      assert.ok(gap >= 6, `${a.id} <-> ${b.id} gap ${gap.toFixed(1)}px < 6px`);
    }
  }

  // Outside 120px center crosshair circle
  const cx = VW / 2;
  const cy = VH / 2;
  for (const r of list) {
    const dx = Math.max(r.x - cx, 0, cx - r.right);
    const dy = Math.max(r.y - cy, 0, cy - r.bottom);
    const dist = Math.hypot(dx, dy);
    assert.ok(dist >= 120, `${r.id} intrudes into 120px crosshair circle (dist=${dist.toFixed(1)}px)`);
  }
});

test('landscape 844x390: all 5 action button rects match baseline anchors pixel-for-pixel', () => {
  const VW = 844;
  const VH = 390;
  const rects = layoutRects(LANDSCAPE_LAYOUT, VW, VH);

  // Hard-coded baseline anchors:
  // fire 70@16/16, reload 48@96/32, swap 48@84/88, jump 48@26/94, crouch 44@28/150
  const expected: Record<TouchBtnId, { x: number; y: number; w: number; h: number }> = {
    fire: { x: 758, y: 304, w: 70, h: 70 },
    reload: { x: 700, y: 310, w: 48, h: 48 },
    swap: { x: 712, y: 254, w: 48, h: 48 },
    jump: { x: 770, y: 248, w: 48, h: 48 },
    crouch: { x: 772, y: 196, w: 44, h: 44 },
  };

  for (const id of BTN_IDS) {
    const actual = rects[id];
    const exp = expected[id];
    assert.deepEqual(
      { x: actual.x, y: actual.y, w: actual.w, h: actual.h },
      exp,
      `landscape ${id} rect drifted from baseline`,
    );
  }
});
