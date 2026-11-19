// Input layer: produces a unified InputState consumed by Player.update.
// Keyboard WASD / Shift(run) / Ctrl+C(crouch) / Space(jump) + pointer-lock
// mouselook on desktop; a touch source exposes the same state for mobile
// (virtual joystick / look-drag UI lands in F108 — the capture interface is
// defined here already). No three.js; DOM access lives only inside the
// source classes, so module level stays pure.

import type { InputState } from './player';
import { emptyInput } from './player';

export type { InputState };

/** Mouse sensitivity, rad per CSS px of movementX/Y. */
export const MOUSE_SENSITIVITY = 0.0026;
/** Touch look sensitivity: SPEC default 0.35°/px on the right half of the screen. */
export const TOUCH_LOOK_SENSITIVITY = (0.35 * Math.PI) / 180;

/** A source of per-frame intent. snapshot() consumes edge-triggered state. */
export interface InputSource {
  snapshot(): InputState;
  detach(): void;
}

export class KeyboardMouseInput implements InputSource {
  private canvas: HTMLElement;
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private jumpQueued = false;
  private reloadQueued = false;
  private firing = false;
  private pointerLocked = false;
  private disposers: (() => void)[] = [];

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    const on = (
      target: Window | HTMLElement | Document,
      type: string,
      fn: (ev: any) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    on(window, 'keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpQueued = true;
      if (e.code === 'KeyR') this.reloadQueued = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    on(this.canvas, 'mousedown', (e) => {
      if (e.button === 0) this.firing = true;
      if (!this.pointerLocked) this.canvas.requestPointerLock?.();
    });
    on(window, 'mouseup', (e) => {
      if (e.button === 0) this.firing = false;
    });
    on(document, 'pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    on(document, 'mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
  }

  snapshot(): InputState {
    const s = emptyInput();
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) s.moveZ += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) s.moveZ -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s.moveX += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) s.moveX -= 1;
    s.run = k.has('ShiftLeft') || k.has('ShiftRight');
    s.crouch = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC');
    s.jump = this.jumpQueued;
    s.reload = this.reloadQueued;
    s.fire = this.firing;
    // Screen-right mouse motion turns right (yaw decreases); mouse up pitches up.
    s.yawDelta = -this.lookX * MOUSE_SENSITIVITY;
    s.pitchDelta = -this.lookY * MOUSE_SENSITIVITY;
    this.jumpQueued = false;
    this.reloadQueued = false;
    this.lookX = 0;
    this.lookY = 0;
    return s;
  }

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.keys.clear();
  }
}

/**
 * Touch input contract (F108 builds the on-screen widgets):
 *   - left half of the screen: virtual joystick, radius 56 CSS px, dead-zone 8px
 *   - right half: drag to look, TOUCH_LOOK_SENSITIVITY rad/px
 *   - buttons (fire / reload / weapon / run / crouch / jump) feed flags below
 * Buttons are plain fields the future HUD writes into; the class already
 * merges joystick + look drags into the shared InputState.
 */
export class TouchInput implements InputSource {
  static readonly STICK_RADIUS_PX = 56;
  static readonly STICK_DEADZONE_PX = 8;

  readonly buttons = {
    fire: false,
    reload: false,
    /** Mobile default per SPEC: run is held unless toggled off. */
    run: true,
    crouch: false,
    jump: false,
  };

  /** True once any touch has been seen — used to gate merging so the
   *  default-held mobile `run` flag doesn't leak into keyboard sessions. */
  active = false;

  private el: HTMLElement;
  private stickTouch: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private lookTouch: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookX = 0;
  private lookY = 0;
  private disposers: (() => void)[] = [];

  constructor(el: HTMLElement) {
    this.el = el;
    const on = (
      target: HTMLElement,
      type: string,
      fn: (ev: TouchEvent) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(el, 'touchstart', (e) => this.onStart(e), { passive: false });
    on(el, 'touchmove', (e) => this.onMove(e), { passive: false });
    on(el, 'touchend', (e) => this.onEnd(e));
    on(el, 'touchcancel', (e) => this.onEnd(e));
  }

  private onStart(e: TouchEvent): void {
    e.preventDefault();
    this.active = true;
    const w = this.el.clientWidth;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < w / 2 && this.stickTouch === null) {
        this.stickTouch = t.identifier;
        this.stickOrigin = { x: t.clientX, y: t.clientY };
        this.stickVec = { x: 0, y: 0 };
      } else if (t.clientX >= w / 2 && this.lookTouch === null) {
        this.lookTouch = t.identifier;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private onMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickTouch) {
        let dx = t.clientX - this.stickOrigin.x;
        let dy = t.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy);
        const R = TouchInput.STICK_RADIUS_PX;
        if (len > R) {
          dx = (dx / len) * R;
          dy = (dy / len) * R;
        }
        const dz = TouchInput.STICK_DEADZONE_PX;
        this.stickVec =
          Math.hypot(dx, dy) < dz ? { x: 0, y: 0 } : { x: dx / R, y: dy / R };
      } else if (t.identifier === this.lookTouch) {
        this.lookX += t.clientX - this.lookLast.x;
        this.lookY += t.clientY - this.lookLast.y;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private onEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickTouch) {
        this.stickTouch = null;
        this.stickVec = { x: 0, y: 0 };
      } else if (t.identifier === this.lookTouch) {
        this.lookTouch = null;
      }
    }
  }

  snapshot(): InputState {
    const s = emptyInput();
    s.moveX = this.stickVec.x;
    s.moveZ = -this.stickVec.y; // stick up = forward
    s.run = this.buttons.run;
    s.crouch = this.buttons.crouch;
    s.jump = this.buttons.jump;
    s.reload = this.buttons.reload;
    s.fire = this.buttons.fire;
    s.yawDelta = -this.lookX * TOUCH_LOOK_SENSITIVITY;
    s.pitchDelta = -this.lookY * TOUCH_LOOK_SENSITIVITY;
    this.lookX = 0;
    this.lookY = 0;
    this.buttons.jump = false; // edge-triggered
    this.buttons.reload = false;
    return s;
  }

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

export interface Input {
  snapshot(): InputState;
  detach(): void;
  touch: TouchInput;
}

/** Merge all active input sources into one InputState per frame. */
export function createInput(canvas: HTMLElement): Input {
  const kb = new KeyboardMouseInput(canvas);
  const touch = new TouchInput(canvas);
  return {
    touch,
    snapshot() {
      const a = kb.snapshot();
      const b = touch.active ? touch.snapshot() : emptyInput();
      return {
        moveX: a.moveX + b.moveX,
        moveZ: a.moveZ + b.moveZ,
        run: a.run || b.run,
        crouch: a.crouch || b.crouch,
        jump: a.jump || b.jump,
        reload: a.reload || b.reload,
        fire: a.fire || b.fire,
        yawDelta: a.yawDelta + b.yawDelta,
        pitchDelta: a.pitchDelta + b.pitchDelta,
      };
    },
    detach() {
      kb.detach();
      touch.detach();
    },
  };
}
