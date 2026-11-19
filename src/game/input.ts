// Input layer: produces a unified InputState consumed by Player.update.
// Keyboard WASD / Shift(run) / Ctrl+C(crouch) / Space(jump) / R(reload) /
// Q(swap) + pointer-lock mouselook on desktop; touch controls live in
// src/input/touch.ts (F108) and feed the same InputState. No three.js;
// DOM access lives only inside the source classes, so module level
// stays pure.

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
  private swapQueued = false;
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
      if (e.code === 'KeyQ') this.swapQueued = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    on(this.canvas, 'mousedown', (e) => {
      if (e.button === 0) this.firing = true;
      if (!this.pointerLocked) {
        const r = this.canvas.requestPointerLock?.() as unknown;
        if (r instanceof Promise) r.catch(() => {});
      }
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
    s.swap = this.swapQueued;
    s.fire = this.firing;
    // Screen-right mouse motion turns right (yaw decreases); mouse up pitches up.
    s.yawDelta = -this.lookX * MOUSE_SENSITIVITY;
    s.pitchDelta = -this.lookY * MOUSE_SENSITIVITY;
    this.jumpQueued = false;
    this.reloadQueued = false;
    this.swapQueued = false;
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

/** Merge two InputStates (keyboard/mouse + touch) into one frame intent. */
export function mergeInputs(a: InputState, b: InputState): InputState {
  return {
    moveX: a.moveX + b.moveX,
    moveZ: a.moveZ + b.moveZ,
    run: a.run || b.run,
    crouch: a.crouch || b.crouch,
    jump: a.jump || b.jump,
    reload: a.reload || b.reload,
    swap: a.swap || b.swap,
    fire: a.fire || b.fire,
    yawDelta: a.yawDelta + b.yawDelta,
    pitchDelta: a.pitchDelta + b.pitchDelta,
  };
}
