// DOM HUD: hp bar (bottom-left), ammo (bottom-right), spread-aware crosshair
// (center), fps (top-right, toggleable), death overlay, portrait rotate hint,
// hit feedback (edge vignette + direction arc), kill hint, low-hp pulse and a
// mute toggle. All colors from palette.ts; overlays are pointer-events:none.

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
/** edge vignette shared by the hurt flash and the low-hp pulse */
const HURT_BG = `radial-gradient(ellipse 115% 90% at 50% 50%, transparent 55%, ${PALETTE.hurtVeil} 100%)`;

const HURT_MS = 120; // ART-SPEC §3: flash fades back inside 120ms
const ARC_MS = 600;
const KILL_MS = 700;
const PULSE_MS = 1200;
const PULSE_PEAK = 0.25;

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

  private hurtEl: HTMLDivElement;
  private lowHpEl: HTMLDivElement;
  private arcEl: HTMLDivElement;
  private killEl: HTMLDivElement;
  private muteBtn: HTMLDivElement;
  private hurtAt = -1;
  private arcAt = -1;
  private arcAngle = 0;
  private killAt = -1;
  private mutedFlag = false;

  /** counters/values for the e2e feedback hooks — persistent object */
  readonly fx = { hits: 0, kills: 0, flashOpacity: 0, lowHpPulse: 0 };
  /** wired by main.ts to the sfx bus */
  onMuteToggle: ((muted: boolean) => void) | null = null;

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

    // ammo — own zone above the touch button cluster so it can't overlap the
    // 跳/蹲 column even in portrait (cluster top is ~224px on touch)
    const ammoWrap = div(
      `position:absolute;right:${ar(16)};bottom:${ab(touchMode ? 256 : 16)};` +
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

    // --- feedback layer (F109): all elements prebuilt, opacity animated only ---
    this.hurtEl = div(`position:absolute;inset:0;background:${HURT_BG};opacity:0;`, this.root);
    this.hurtEl.dataset.fx = 'hurt';
    this.lowHpEl = div(`position:absolute;inset:0;background:${HURT_BG};opacity:0;`, this.root);
    this.lowHpEl.dataset.fx = 'lowhp';

    this.arcEl = div(
      `position:absolute;left:50%;top:50%;width:44vmin;height:44vmin;` +
        `transform:translate(-50%,-50%);opacity:0;`,
      this.root,
    );
    this.arcEl.dataset.fx = 'arc';
    this.arcEl.innerHTML =
      `<svg viewBox="0 0 100 100" width="100%" height="100%">` +
      `<path d="M16 53 A35 35 0 0 1 84 53" fill="none" stroke="${PALETTE.hpLow}" ` +
      `stroke-width="5" stroke-linecap="round"/></svg>`;

    this.killEl = div(
      `position:absolute;left:50%;top:30%;transform:translateX(-50%);` +
        `font-size:20px;font-weight:700;color:${PALETTE.accent};` +
        `text-shadow:0 0 4px ${PALETTE.crosshairEdge};opacity:0;`,
      this.root,
    );
    this.killEl.dataset.fx = 'kill';
    this.killEl.textContent = '击倒';

    // mute toggle — own fixed layer above the touch UI (z 10) so it stays
    // clickable on mobile; hit rect 48×48 sits inside the 44–120px budget.
    this.muteBtn = document.createElement('div');
    this.muteBtn.dataset.btn = 'mute';
    this.muteBtn.textContent = '声';
    this.muteBtn.style.cssText =
      `position:fixed;right:calc(12px + env(safe-area-inset-right, 0px));` +
      `top:calc(30px + env(safe-area-inset-top, 0px));width:48px;height:48px;` +
      `display:flex;align-items:center;justify-content:center;border-radius:10px;` +
      `background:${PALETTE.uiPanel};border:2px solid ${PALETTE.uiBorder};` +
      `color:${PALETTE.uiText};font:600 15px/1 ${FONT};z-index:30;` +
      `pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;` +
      `cursor:pointer;box-sizing:border-box;`;
    parent.appendChild(this.muteBtn);
    this.muteBtn.addEventListener('click', () => {
      this.setMuted(!this.mutedFlag);
      this.onMuteToggle?.(this.mutedFlag);
    });
  }

  /** damage feedback: edge flash + a direction arc rotated to the attack
   *  bearing (screen-relative radians, 0 = straight ahead). */
  hitFrom(angleRad: number, now: number): void {
    this.hurtAt = now;
    this.arcAt = now;
    this.arcAngle = angleRad;
    this.fx.hits++;
  }

  notifyKill(now: number): void {
    this.killAt = now;
    this.fx.kills++;
  }

  setMuted(m: boolean): void {
    this.mutedFlag = m;
    this.muteBtn.textContent = m ? '静' : '声';
    this.muteBtn.style.borderColor = m ? PALETTE.accent : PALETTE.uiBorder;
    this.muteBtn.style.color = m ? PALETTE.accent : PALETTE.uiText;
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

    // portrait hides secondary info — fps readout yields the space to controls
    const portrait = window.innerHeight > window.innerWidth;
    this.fpsEl.style.display = portrait ? 'none' : '';
    this.fpsEl.textContent = this.fpsVisible ? `${s.fps.toFixed(0)} fps` : '';
    this.deadEl.style.display = s.dead ? 'block' : 'none';
    if (s.dead) this.deadEl.textContent = `阵亡 · ${Math.max(0, s.respawnIn).toFixed(1)}s 后重生`;
    this.rotateEl.style.display = portrait ? 'block' : 'none';

    // --- feedback decay (values only; elements and gradients prebuilt) ---
    const now = performance.now();
    const flash =
      this.hurtAt < 0 ? 0 : Math.max(0, 0.35 * (1 - (now - this.hurtAt) / HURT_MS));
    this.hurtEl.style.opacity = `${flash}`;
    this.fx.flashOpacity = flash;

    const arcO =
      this.arcAt < 0 ? 0 : Math.max(0, 0.9 * (1 - (now - this.arcAt) / ARC_MS));
    this.arcEl.style.opacity = `${arcO}`;
    if (arcO > 0)
      this.arcEl.style.transform = `translate(-50%,-50%) rotate(${this.arcAngle}rad)`;

    const killO =
      this.killAt < 0 ? 0 : Math.max(0, 1 - (now - this.killAt) / KILL_MS);
    this.killEl.style.opacity = `${killO}`;

    const lowHp = frac <= 0.3 && !s.dead;
    const pulse = lowHp
      ? PULSE_PEAK * (0.5 - 0.5 * Math.cos((now / PULSE_MS) * 2 * Math.PI))
      : 0;
    this.lowHpEl.style.opacity = `${pulse}`;
    if (lowHp) this.fx.lowHpPulse++;
  }
}
