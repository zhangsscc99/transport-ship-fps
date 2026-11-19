// Touch control layer (F108): left-half virtual joystick, right-half look
// drag, and a button cluster — all merged into the shared InputState.
// Implemented with Pointer Events so real multi-touch and synthetic test
// pointers take the same code path; mouse users never see the overlay.

import type { InputState } from '../game/player';
import { emptyInput } from '../game/player';
import { TOUCH_LOOK_SENSITIVITY, type InputSource } from '../game/input';
import { PALETTE } from '../render/palette';

/** SPEC: joystick radius 56 CSS px, dead-zone 8px, look 0.35°/px. */
const STICK_R = 56;
const STICK_DZ = 8;
const BTN = 56;
const FIRE_BTN = 80;

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

function makeBtn(id: string, label: string, pos: string, size: number, accent = false): HTMLDivElement {
  const el = document.createElement('div');
  el.dataset.btn = id;
  el.textContent = label;
  css(
    el,
    `position:absolute;${pos}width:${size}px;height:${size}px;` +
      `display:flex;align-items:center;justify-content:center;` +
      `border-radius:${id === 'fire' ? '50%' : '12px'};` +
      `background:${PALETTE.uiPanel};border:2px solid ${accent ? PALETTE.accent : PALETTE.uiBorder};` +
      `color:${accent ? PALETTE.accent : PALETTE.uiText};font:600 ${size > 60 ? 17 : 14}px/1 ` +
      `system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;` +
      `pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;` +
      `box-sizing:border-box;`,
  );
  return el;
}

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
  /** toggles — mobile default runs (SPEC: 手机默认按住「跑」) */
  private toggles = { run: true, crouch: false };
  private disposers: (() => void)[] = [];
  private stickBase: HTMLDivElement | null = null;
  private stickNub: HTMLDivElement | null = null;

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

    this.stickBase = document.createElement('div');
    this.stickBase.dataset.stick = 'base';
    css(
      this.stickBase,
      `position:fixed;width:${STICK_R * 2}px;height:${STICK_R * 2}px;border-radius:50%;` +
        `border:2px solid ${PALETTE.uiBorder};background:${PALETTE.uiPanel};` +
        `display:none;pointer-events:none;transform:translate(-50%,-50%);`,
    );
    this.stickNub = document.createElement('div');
    this.stickNub.dataset.stick = 'nub';
    css(
      this.stickNub,
      `position:fixed;width:44px;height:44px;border-radius:50%;` +
        `background:${PALETTE.uiText};opacity:0.85;display:none;pointer-events:none;` +
        `transform:translate(-50%,-50%);`,
    );
    document.body.append(this.stickBase, this.stickNub);

    // bottom-right cluster (SPEC: 开火·换弹·换枪·跳跃·蹲), all inside safe area
    const ar = (px: number) => `calc(${px}px + env(safe-area-inset-right, 0px))`;
    const ab = (px: number) => `calc(${px}px + env(safe-area-inset-bottom, 0px))`;
    const al = (px: number) => `calc(${px}px + env(safe-area-inset-left, 0px))`;
    const at = (px: number) => `calc(${px}px + env(safe-area-inset-top, 0px))`;
    const btns: { el: HTMLDivElement; id: string; act: 'hold' | 'edge' | 'toggle' }[] = [
      { el: makeBtn('fire', '开火', `right:${ar(20)};bottom:${ab(20)};`, FIRE_BTN, true), act: 'hold', id: 'fire' },
      { el: makeBtn('reload', '换弹', `right:${ar(116)};bottom:${ab(24)};`, BTN), act: 'edge', id: 'reload' },
      { el: makeBtn('swap', '切枪', `right:${ar(116)};bottom:${ab(96)};`, BTN), act: 'edge', id: 'swap' },
      { el: makeBtn('jump', '跳', `right:${ar(32)};bottom:${ab(116)};`, BTN), act: 'edge', id: 'jump' },
      { el: makeBtn('crouch', '蹲', `right:${ar(32)};bottom:${ab(188)};`, BTN), act: 'toggle', id: 'crouch' },
      { el: makeBtn('run', '跑', `left:${al(20)};top:${at(20)};`, BTN), act: 'toggle', id: 'run' },
    ];
    for (const b of btns) {
      this.root.appendChild(b.el);
      if (b.id === 'run') this.markToggle(b.el, this.toggles.run);
      this.on(b.el, 'pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.act === 'hold') {
          this.fireIds.add(e.pointerId);
          this.flags.fire = true;
        } else if (b.act === 'edge') {
          this.flags[b.id as 'reload' | 'swap' | 'jump'] = true;
        } else {
          const k = b.id as 'run' | 'crouch';
          this.toggles[k] = !this.toggles[k];
          this.markToggle(b.el, this.toggles[k]);
        }
      });
    }

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

  private on(
    target: HTMLElement | Window,
    type: string,
    fn: (e: PointerEvent) => void,
  ): void {
    target.addEventListener(type, fn as EventListener, { passive: false });
    this.disposers.push(() => target.removeEventListener(type, fn as EventListener));
  }

  private markToggle(el: HTMLElement, on: boolean): void {
    el.style.borderColor = on ? PALETTE.accent : PALETTE.uiBorder;
    el.style.color = on ? PALETTE.accent : PALETTE.uiText;
  }

  private moveStickVisual(bx: number, by: number, dx: number, dy: number, show: boolean): void {
    if (!this.stickBase || !this.stickNub) return;
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
    s.run = this.toggles.run;
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
