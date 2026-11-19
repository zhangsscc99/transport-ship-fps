// DOM HUD: hp bar (bottom-left), ammo (bottom-right), spread-aware crosshair
// (center), fps (top-right, toggleable), death overlay, portrait rotate hint.
// All colors from palette.ts; display-only (pointer-events: none).

import { PALETTE } from './palette';

export interface HudState {
  hp: number;
  maxHp: number;
  ammo: number;
  reloading: boolean;
  weaponName: string;
  /** crosshair gap radius in px — spread projected through the camera */
  spreadPx: number;
  fps: number;
  dead: boolean;
  /** seconds until respawn when dead */
  respawnIn: number;
}

const FONT = `system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif`;

function div(style: string, parent: HTMLElement, hudTag?: string): HTMLDivElement {
  const el = document.createElement('div');
  if (hudTag) el.dataset.hud = hudTag;
  el.style.cssText = style;
  parent.appendChild(el);
  return el;
}

export class Hud {
  private root: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private hpText: HTMLDivElement;
  private ammoText: HTMLDivElement;
  private ammoSub: HTMLDivElement;
  private crossLines: HTMLDivElement[] = [];
  private fpsEl: HTMLDivElement;
  private deadEl: HTMLDivElement;
  private rotateEl: HTMLDivElement;
  private fpsVisible = true;

  constructor(parent: HTMLElement, touchMode: boolean) {
    this.root = div(
      `position:fixed;inset:0;z-index:5;pointer-events:none;font-family:${FONT};` +
        `color:${PALETTE.uiText};`,
      parent,
    );
    const ab = (px: number) => `calc(${px}px + env(safe-area-inset-bottom, 0px))`;
    const al = (px: number) => `calc(${px}px + env(safe-area-inset-left, 0px))`;
    const ar = (px: number) => `calc(${px}px + env(safe-area-inset-right, 0px))`;

    // hp bar — bottom left
    const hpWrap = div(
      `position:absolute;left:${al(16)};bottom:${ab(16)};width:150px;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-radius:6px;padding:6px 8px;`,
      this.root,
      'hp',
    );
    this.hpText = div(`font-size:11px;color:${PALETTE.uiDim};margin-bottom:4px;`, hpWrap);
    const hpBar = div(
      `height:8px;border-radius:4px;background:${PALETTE.uiBorder};overflow:hidden;`,
      hpWrap,
    );
    this.hpFill = div(`height:100%;width:100%;background:${PALETTE.hpFull};`, hpBar);

    // ammo — bottom right (lifted above the button cluster on touch)
    const ammoWrap = div(
      `position:absolute;right:${ar(16)};bottom:${ab(touchMode ? 116 : 16)};` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-radius:6px;padding:6px 12px;text-align:right;`,
      this.root,
      'ammo',
    );
    this.ammoText = div(`font-size:26px;font-weight:700;line-height:1.1;`, ammoWrap);
    this.ammoSub = div(`font-size:11px;color:${PALETTE.uiDim};`, ammoWrap);

    // crosshair — 4 discrete lines + centre dot, gap follows weapon spread
    const cross = div(
      `position:absolute;left:50%;top:50%;width:0;height:0;`,
      this.root,
      'cross',
    );
    const mk = (w: number, h: number): HTMLDivElement => {
      const el = div(
        `position:absolute;left:${-w / 2}px;top:${-h / 2}px;width:${w}px;height:${h}px;` +
          `background:${PALETTE.crosshair};box-shadow:0 0 0 1px ${PALETTE.crosshairEdge};`,
        cross,
      );
      this.crossLines.push(el);
      return el;
    };
    mk(2, 10); // top
    mk(2, 10); // bottom
    mk(10, 2); // left
    mk(10, 2); // right
    div(
      `position:absolute;left:-1.5px;top:-1.5px;width:3px;height:3px;border-radius:50%;` +
        `background:${PALETTE.crosshair};box-shadow:0 0 0 1px ${PALETTE.crosshairEdge};`,
      cross,
    );

    this.fpsEl = div(
      `position:absolute;right:${ar(12)};top:calc(8px + env(safe-area-inset-top, 0px));` +
        `font-size:11px;color:${PALETTE.uiDim};`,
      this.root,
      'fps',
    );

    this.deadEl = div(
      `position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);` +
        `background:${PALETTE.deadVeil};border:1px solid ${PALETTE.hpLow};` +
        `border-radius:8px;padding:14px 26px;font-size:18px;font-weight:600;` +
        `color:${PALETTE.uiText};display:none;text-align:center;`,
      this.root,
      'dead',
    );

    this.rotateEl = div(
      `position:absolute;left:50%;top:calc(10px + env(safe-area-inset-top, 0px));` +
        `transform:translateX(-50%);font-size:11px;color:${PALETTE.uiDim};` +
        `background:${PALETTE.uiPanel};border-radius:5px;padding:4px 10px;display:none;`,
      this.root,
      'rotate',
    );
    this.rotateEl.textContent = '建议横屏游玩（竖屏也可玩）';
  }

  setFpsVisible(v: boolean): void {
    this.fpsVisible = v;
  }

  update(s: HudState): void {
    const frac = Math.max(0, Math.min(1, s.hp / s.maxHp));
    this.hpFill.style.width = `${frac * 100}%`;
    this.hpFill.style.background =
      frac > 0.55 ? PALETTE.hpFull : frac > 0.3 ? PALETTE.hpMid : PALETTE.hpLow;
    this.hpText.textContent = `HP ${Math.ceil(s.hp)}`;

    this.ammoText.textContent = `${s.ammo}`;
    this.ammoSub.textContent = s.reloading ? '换弹中…' : `${s.weaponName} / ∞`;
    this.ammoText.style.color = s.reloading ? PALETTE.accent : PALETTE.uiText;

    const g = 5 + s.spreadPx;
    const [top, bottom, left, right] = this.crossLines;
    top.style.transform = `translateY(${-g - 5}px)`;
    bottom.style.transform = `translateY(${g - 5}px)`;
    left.style.transform = `translateX(${-g - 5}px)`;
    right.style.transform = `translateX(${g - 5}px)`;

    this.fpsEl.textContent = this.fpsVisible ? `${s.fps.toFixed(0)} fps` : '';
    this.deadEl.style.display = s.dead ? 'block' : 'none';
    if (s.dead) this.deadEl.textContent = `阵亡 · ${Math.max(0, s.respawnIn).toFixed(1)}s 后重生`;
    this.rotateEl.style.display =
      window.innerHeight > window.innerWidth ? 'block' : 'none';
  }
}
