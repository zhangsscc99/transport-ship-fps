// Touch control layer (F108 / HUD v2):
//   - Left thumb natural zone: virtual joystick ONLY (r=56px dashed ring + solid
//     nub, deadzone 8px). No sprint button.
//   - Right thumb arc zone: ALL action keys (FIRE 76px circle at right/bottom 24px,
//     RELOAD 52px upper-left of FIRE, SWAP 52px above RELOAD, JUMP 52px directly
//     above FIRE, CROUCH 48px above JUMP).
//   - Dedicated portrait (390×844) & landscape (844×390) anchor sets: landscape
//     shifts the right cluster right and scales right buttons down 8% (0.92×).
//   - Input判定 logic (stick/look/aim-while-firing/edge/toggle) is unchanged.

import type { InputState } from '../game/player';
import { emptyInput } from '../game/player';
import { TOUCH_LOOK_SENSITIVITY, type InputSource } from '../game/input';
import { PALETTE } from '../render/palette';
import { buildHudButton, HUD_ICONS } from '../render/hud';

/** SPEC: joystick radius 56 CSS px, dead-zone 8px, look 0.35°/px. */
const STICK_R = 56;
const STICK_DZ = 8;

export type TouchBtnId = 'fire' | 'reload' | 'swap' | 'jump' | 'crouch';

export interface BtnAnchor {
  size: number;
  side: 'left' | 'right';
  x: number;
  bottom: number;
}

export interface LayoutSpec {
  stick: { left: number; bottom: number };
  btns: Record<TouchBtnId, BtnAnchor>;
}

/** Portrait 390×844 anchors: right cluster sits in the lower-right thumb arc,
 *  all 5 buttons stay non-overlapping with ≥8px pairwise spacing (≥6px spec),
 *  ≥24px safe margin from screen edges, FIRE at 24/24px, and strictly outside
 *  the 120px center crosshair clear radius. */
export const PORTRAIT_LAYOUT: LayoutSpec = {
  stick: { left: 20, bottom: 82 },
  btns: {
    fire: { size: 76, side: 'right', x: 24, bottom: 24 },
    reload: { size: 52, side: 'right', x: 108, bottom: 36 },
    swap: { size: 52, side: 'right', x: 92, bottom: 108 },
    jump: { size: 52, side: 'right', x: 28, bottom: 108 },
    crouch: { size: 48, side: 'right', x: 30, bottom: 168 },
  },
};

/** Landscape 844×390 anchors: right cluster shifts right and scales down 8% (0.92×)
 *  while keeping every hit rect ≥ 44 CSS px. */
export const LANDSCAPE_LAYOUT: LayoutSpec = {
  stick: { left: 20, bottom: 72 },
  btns: {
    fire: { size: 70, side: 'right', x: 16, bottom: 16 },
    reload: { size: 48, side: 'right', x: 96, bottom: 32 },
    swap: { size: 48, side: 'right', x: 84, bottom: 88 },
    jump: { size: 48, side: 'right', x: 26, bottom: 94 },
    crouch: { size: 44, side: 'right', x: 28, bottom: 150 },
  },
};

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.('(pointer: coarse)').matches === true ||
    new URLSearchParams(window.location.search).has('touch')
  );
}

const css = (el: HTMLElement, style: string): void => {
  el.style.cssText = style;
};

export class TouchControls implements InputSource {
  readonly root: HTMLDivElement;
  /** false on non-touch devices — the whole overlay is skipped then */
  readonly enabled: boolean;

  private stickId = -1;
  private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private lookId = -1;
  private lookLast = { x: 0, y: 0 };
  private lookAcc = { x: 0, y: 0 };
  private fireIds = new Set<number>();
  private flags = { fire: false, reload: false, swap: false, jump: false };
  private toggles = { crouch: false };
  private disposers: (() => void)[] = [];
  private stickBase: HTMLDivElement | null = null;
  private stickNub: HTMLDivElement | null = null;
  private stickIdle: HTMLDivElement | null = null;
  private fireBtn: HTMLDivElement | null = null;
  private btnEls: Partial<Record<TouchBtnId, HTMLDivElement>> = {};

  constructor(parent: HTMLElement = document.body) {
    this.enabled = isTouchDevice();
    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    if (!this.enabled) {
      this.root.style.display = 'none';
      parent.appendChild(this.root);
      return;
    }
    css(this.root, 'position:fixed;inset:0;z-index:10;pointer-events:none;touch-action:none;');

    const mkZone = (name: string, style: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.dataset.zone = name;
      css(el, `position:absolute;${style};pointer-events:auto;touch-action:none;`);
      this.root.appendChild(el);
      return el;
    };
    const stickZone = mkZone('stick', 'left:0;top:0;width:50%;height:100%;');
    const lookZone = mkZone('look', 'right:0;top:0;width:50%;height:100%;');

    // Resting bottom-left joystick hint: dashed outer ring (r=56) + solid inner circle (pointer-events:none)
    this.stickIdle = document.createElement('div');
    this.stickIdle.dataset.stick = 'idle';
    css(
      this.stickIdle,
      `position:absolute;width:${STICK_R * 2}px;height:${STICK_R * 2}px;` +
        `border-radius:50%;border:1.5px dashed rgba(255,255,255,0.28);background:rgba(8,12,18,0.22);` +
        `display:flex;align-items:center;justify-content:center;pointer-events:none;box-sizing:border-box;`,
    );
    const idleNub = document.createElement('div');
    css(
      idleNub,
      `width:38px;height:38px;border-radius:50%;background:rgba(236,232,225,0.48);` +
        `border:1px solid rgba(255,255,255,0.3);pointer-events:none;`,
    );
    this.stickIdle.appendChild(idleNub);
    this.root.appendChild(this.stickIdle);

    // Active dynamic joystick (follows touch point): dashed outer ring + solid inner circle
    this.stickBase = document.createElement('div');
    this.stickBase.dataset.stick = 'base';
    css(
      this.stickBase,
      `position:fixed;width:${STICK_R * 2}px;height:${STICK_R * 2}px;border-radius:50%;` +
        `border:1.5px dashed rgba(255,255,255,0.45);background:rgba(8,12,18,0.34);` +
        `display:none;pointer-events:none;transform:translate(-50%,-50%);z-index:11;box-sizing:border-box;`,
    );
    this.stickNub = document.createElement('div');
    this.stickNub.dataset.stick = 'nub';
    css(
      this.stickNub,
      `position:fixed;width:40px;height:40px;border-radius:50%;` +
        `background:${PALETTE.uiText};opacity:0.9;display:none;pointer-events:none;` +
        `transform:translate(-50%,-50%);z-index:12;`,
    );
    document.body.append(this.stickBase, this.stickNub);

    // HUD v2 buttons: FIRE/RELOAD/SWAP/JUMP/CROUCH on right thumb arc; left side is joystick only.
    this.fireBtn = buildHudButton({
      id: 'fire',
      label: 'FIRE',
      iconSvg: HUD_ICONS.fire(26),
      posCss: '',
      size: PORTRAIT_LAYOUT.btns.fire.size,
      circle: true,
      danger: true,
    });
    const btns: {
      el: HTMLDivElement;
      id: TouchBtnId;
      act: 'hold' | 'edge' | 'toggle';
    }[] = [
      { el: this.fireBtn, act: 'hold', id: 'fire' },
      {
        el: buildHudButton({
          id: 'reload',
          label: 'RELOAD',
          iconSvg: HUD_ICONS.reload(18),
          posCss: '',
          size: PORTRAIT_LAYOUT.btns.reload.size,
        }),
        act: 'edge',
        id: 'reload',
      },
      {
        el: buildHudButton({
          id: 'swap',
          label: 'SWAP',
          iconSvg: HUD_ICONS.swap(18),
          posCss: '',
          size: PORTRAIT_LAYOUT.btns.swap.size,
        }),
        act: 'edge',
        id: 'swap',
      },
      {
        el: buildHudButton({
          id: 'jump',
          label: 'JUMP',
          iconSvg: HUD_ICONS.jump(18),
          posCss: '',
          size: PORTRAIT_LAYOUT.btns.jump.size,
        }),
        act: 'edge',
        id: 'jump',
      },
      {
        el: buildHudButton({
          id: 'crouch',
          label: 'CROUCH',
          iconSvg: HUD_ICONS.crouch(17),
          posCss: '',
          size: PORTRAIT_LAYOUT.btns.crouch.size,
        }),
        act: 'toggle',
        id: 'crouch',
      },
    ];
    for (const b of btns) {
      this.btnEls[b.id] = b.el;
      this.root.appendChild(b.el);
      this.on(b.el, 'pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.act === 'hold') {
          this.fireIds.add(e.pointerId);
          this.flags.fire = true;
          // hold-fire doubles as the look pointer: if no finger already owns
          // the camera, this one steers it — drag on the fire button turns.
          if (b.id === 'fire' && this.lookId < 0) {
            this.lookId = e.pointerId;
            this.lookLast = { x: e.clientX, y: e.clientY };
          }
        } else if (b.act === 'edge') {
          this.flags[b.id as 'reload' | 'swap' | 'jump'] = true;
        } else {
          this.toggles.crouch = !this.toggles.crouch;
          this.markToggle(b.el, this.toggles.crouch);
        }
      });
    }

    this.applyLayout();
    const onRelayout = () => this.applyLayout();
    window.addEventListener('resize', onRelayout);
    window.addEventListener('orientationchange', onRelayout);
    this.disposers.push(() => {
      window.removeEventListener('resize', onRelayout);
      window.removeEventListener('orientationchange', onRelayout);
    });

    const onDown = (zone: 'stick' | 'look') => (e: PointerEvent) => {
      e.preventDefault();
      if (zone === 'stick' && this.stickId < 0) {
        this.stickId = e.pointerId;
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this.stickVec = { x: 0, y: 0 };
        this.moveStickVisual(e.clientX, e.clientY, 0, 0, true);
      } else if (zone === 'look' && this.lookId < 0) {
        this.lookId = e.pointerId;
        this.lookLast = { x: e.clientX, y: e.clientY };
      }
    };
    this.on(stickZone, 'pointerdown', onDown('stick'));
    this.on(lookZone, 'pointerdown', onDown('look'));

    this.on(window, 'pointermove', (e) => {
      if (e.pointerId === this.stickId) {
        e.preventDefault();
        let dx = e.clientX - this.stickOrigin.x;
        let dy = e.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK_R) {
          dx = (dx / len) * STICK_R;
          dy = (dy / len) * STICK_R;
        }
        this.stickVec = len < STICK_DZ ? { x: 0, y: 0 } : { x: dx / STICK_R, y: dy / STICK_R };
        this.moveStickVisual(this.stickOrigin.x, this.stickOrigin.y, dx, dy, true);
      } else if (e.pointerId === this.lookId) {
        this.lookAcc.x += e.clientX - this.lookLast.x;
        this.lookAcc.y += e.clientY - this.lookLast.y;
        this.lookLast = { x: e.clientX, y: e.clientY };
      }
    });

    const release = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) {
        this.stickId = -1;
        this.stickVec = { x: 0, y: 0 };
        this.moveStickVisual(0, 0, 0, 0, false);
      }
      if (e.pointerId === this.lookId) this.lookId = -1;
      if (this.fireIds.delete(e.pointerId) && this.fireIds.size === 0) this.flags.fire = false;
    };
    this.on(window, 'pointerup', release);
    this.on(window, 'pointercancel', release);

    parent.appendChild(this.root);
  }

  /** Apply portrait (390×844) or landscape (844×390) button & stick anchors. */
  private applyLayout(): void {
    const portrait = window.innerHeight > window.innerWidth;
    const spec = portrait ? PORTRAIT_LAYOUT : LANDSCAPE_LAYOUT;
    const ab = (px: number) => `calc(${px}px + env(safe-area-inset-bottom, 0px))`;
    const al = (px: number) => `calc(${px}px + env(safe-area-inset-left, 0px))`;
    const ar = (px: number) => `calc(${px}px + env(safe-area-inset-right, 0px))`;

    if (this.stickIdle) {
      this.stickIdle.style.left = al(spec.stick.left);
      this.stickIdle.style.bottom = ab(spec.stick.bottom);
    }

    for (const [id, anchor] of Object.entries(spec.btns) as [
      keyof LayoutSpec['btns'],
      BtnAnchor,
    ][]) {
      const el = this.btnEls[id];
      if (!el) continue;
      el.style.width = `${anchor.size}px`;
      el.style.height = `${anchor.size}px`;
      el.style.bottom = ab(anchor.bottom);
      if (anchor.side === 'right') {
        el.style.right = ar(anchor.x);
        el.style.left = '';
      } else {
        el.style.left = al(anchor.x);
        el.style.right = '';
      }
    }
  }

  private on(
    target: HTMLElement | Window,
    type: string,
    fn: (e: PointerEvent) => void,
  ): void {
    target.addEventListener(type, fn as EventListener, { passive: false });
    this.disposers.push(() => target.removeEventListener(type, fn as EventListener));
  }

  private markToggle(el: HTMLElement, on: boolean): void {
    el.style.borderColor = on ? PALETTE.uiBorderActive : PALETTE.uiBorder;
    el.style.color = on ? PALETTE.uiText : PALETTE.uiDim;
    el.style.background = on ? 'rgba(236,232,225,0.14)' : PALETTE.uiPanel;
  }

  /** Brief radial pulse on the FIRE button when shots fire or confirm a hit. */
  pulseFire(): void {
    if (!this.fireBtn) return;
    this.fireBtn.classList.remove('val-fire-pulse');
    void this.fireBtn.offsetWidth;
    this.fireBtn.classList.add('val-fire-pulse');
  }

  private moveStickVisual(bx: number, by: number, dx: number, dy: number, show: boolean): void {
    if (!this.stickBase || !this.stickNub) return;
    if (this.stickIdle) this.stickIdle.style.visibility = show ? 'hidden' : 'visible';
    this.stickBase.style.display = show ? 'block' : 'none';
    this.stickNub.style.display = show ? 'block' : 'none';
    if (show) {
      this.stickBase.style.left = `${bx}px`;
      this.stickBase.style.top = `${by}px`;
      this.stickNub.style.left = `${bx + dx}px`;
      this.stickNub.style.top = `${by + dy}px`;
    }
  }

  snapshot(): InputState {
    const s = emptyInput();
    if (!this.enabled) return s;
    s.moveX = this.stickVec.x;
    s.moveZ = -this.stickVec.y; // stick up = forward
    s.yawDelta = -this.lookAcc.x * TOUCH_LOOK_SENSITIVITY;
    s.pitchDelta = -this.lookAcc.y * TOUCH_LOOK_SENSITIVITY;
    s.crouch = this.toggles.crouch;
    s.fire = this.flags.fire;
    s.jump = this.flags.jump;
    s.reload = this.flags.reload;
    s.swap = this.flags.swap;
    this.lookAcc.x = 0;
    this.lookAcc.y = 0;
    this.flags.jump = false; // edge-triggered
    this.flags.reload = false;
    this.flags.swap = false;
    return s;
  }

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.stickBase?.remove();
    this.stickNub?.remove();
    this.root.remove();
  }
}
