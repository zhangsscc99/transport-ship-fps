// VALORANT-inspired minimalist tactical DOM HUD — English uppercase + inline
// SVG line icons (1.5–2px stroke). Dedicated weapon UI branches:
//   - Rifle: 30-segment magazine bar + precision/burst recoil indicator + 4-line cross
//   - Gatling: distinct heavy amber HUD with 3×100-round segmented rows (300 total),
//     live 250ms spin-up gauge, vibration/wide-spread indicator & rotary ring reticle.
// All non-interactive overlays enforce pointer-events:none so drag/fire stay
// completely unobstructed in both 390×844 portrait and 844×390 landscape.

import { PALETTE } from './palette';
import type { WeaponId } from '../game/weapons';
import type { Phase } from '../game/match';
import { formatClock, isClockUrgent, isClockPulsing } from '../game/objective';

/** live match score/clock for the top-centre objective bar */
export interface HudObjective {
  phase: Phase;
  killsA: number;
  killsB: number;
  /** win target — always pass match.killsToWin, never a literal */
  killsToWin: number;
  timeLeftMs: number;
}

export interface HudState {
  hp: number;
  maxHp: number;
  regenerating?: boolean;
  ammo: number;
  mag?: number;
  reloading: boolean;
  weaponId?: WeaponId;
  weaponName: string;
  /** gatling barrel spin-up progress [0..1] */
  spinLevel?: number;
  /** crosshair gap radius in px — spread projected through the camera */
  spreadPx: number;
  fps: number;
  dead: boolean;
  /** seconds until respawn when dead */
  respawnIn: number;
  /** optional player kill counter */
  kills?: number;
  /** match objective bar (hidden when omitted or in 'menu') */
  objective?: HudObjective;
}

export const HUD_FONT = `'DIN Alternate','Bahnschrift','Segoe UI',system-ui,-apple-system,sans-serif`;
export const HUD_BTN_FONT = `'DIN Alternate','Bahnschrift','Roboto Condensed','Arial Narrow','DejaVu Sans','Segoe UI',system-ui,-apple-system,sans-serif`;

const HURT_BG = `radial-gradient(ellipse 115% 90% at 50% 50%, transparent 55%, ${PALETTE.hurtVeil} 100%)`;

const HURT_MS = 120;
const ARC_MS = 600;
const KILL_MS = 700;
const HIT_CROSS_MS = 60;
const PULSE_MS = 1200;
const PULSE_PEAK = 0.25;
const RIFLE_SEGMENTS = 30;
const GATLING_ROWS = 3;
const GATLING_CELLS_PER_ROW = 20; // 20 cells × 5 rounds = 100 rounds per row × 3 rows = 300
const BTN_STROKE_PX = 1.5;
const BTN_LABEL_PX = 8.5;

const svgWrap = (inner: string, size: number): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
  `style="display:block;pointer-events:none;flex:0 0 auto;">${inner}</svg>`;

export const HUD_ICONS = {
  fire: (size = 27) =>
    svgWrap(
      `<circle cx="12" cy="12" r="6.5"/>` +
        `<line x1="12" y1="2.5" x2="12" y2="6.5"/>` +
        `<line x1="12" y1="17.5" x2="12" y2="21.5"/>` +
        `<line x1="2.5" y1="12" x2="6.5" y2="12"/>` +
        `<line x1="17.5" y1="12" x2="21.5" y2="12"/>` +
        `<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>`,
      size,
    ),
  reload: (size = 20) =>
    svgWrap(
      `<path d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2"/>` + `<polyline points="19.5 4.5 19.5 8.8 15.2 8.8"/>`,
      size,
    ),
  swap: (size = 20) =>
    svgWrap(
      `<polyline points="16 4 20 8 16 12"/>` +
        `<line x1="4" y1="8" x2="20" y2="8"/>` +
        `<polyline points="8 20 4 16 8 12"/>` +
        `<line x1="20" y1="16" x2="4" y2="16"/>`,
      size,
    ),
  crouch: (size = 20) =>
    svgWrap(
      `<circle cx="13" cy="5.5" r="2.1"/>` +
        `<path d="M9 11l3.5-1.5 3.5 2"/>` +
        `<path d="M12.5 9.5l-2 5 4.5 1.5-1 4"/>` +
        `<path d="M10.5 14.5l-3.5 2-1 3.5"/>`,
      size,
    ),
  jump: (size = 20) =>
    svgWrap(
      `<polyline points="7 11 12 6 17 11"/>` +
        `<line x1="12" y1="6.5" x2="12" y2="16.5"/>` +
        `<line x1="6.5" y1="19.5" x2="17.5" y2="19.5"/>`,
      size,
    ),
  soundOn: (size = 18) =>
    svgWrap(
      `<polygon points="4 9.5 8.5 9.5 13 5.5 13 18.5 8.5 14.5 4 14.5"/>` +
        `<path d="M16.2 9.2a4.2 4.2 0 0 1 0 5.6"/>` +
        `<path d="M18.8 6.8a7.4 7.4 0 0 1 0 10.4"/>`,
      size,
    ),
  soundOff: (size = 18) =>
    svgWrap(
      `<polygon points="4 9.5 8.5 9.5 13 5.5 13 18.5 8.5 14.5 4 14.5"/>` +
        `<line x1="16.5" y1="9.5" x2="21" y2="14.5"/>` +
        `<line x1="21" y1="9.5" x2="16.5" y2="14.5"/>`,
      size,
    ),
};

export interface HudBtnState {
  rect: { x: number; y: number; w: number; h: number };
  pressed: boolean;
  active: boolean;
  disabled: boolean;
  reloadPct: number;
  labelFontPx: number;
  strokePx: number;
}

const chamferCut = (size: number): number => (size >= 44 ? 7 : 6);

const chamferClipCss = (size: number): string => {
  const c = chamferCut(size);
  return `polygon(${c}px 0, calc(100% - ${c}px) 0, 100% ${c}px, 100% calc(100% - ${c}px), calc(100% - ${c}px) 100%, ${c}px 100%, 0 calc(100% - ${c}px), 0 ${c}px)`;
};

const chamferPoints = (size: number, inset: number): string => {
  const c = chamferCut(size);
  const k = inset * (Math.SQRT2 - 1);
  const s = size;
  const f = (n: number) => Number(n.toFixed(2));
  const p = [
    [c + k, inset],
    [s - c - k, inset],
    [s - inset, c + k],
    [s - inset, s - c - k],
    [s - c - k, s - inset],
    [c + k, s - inset],
    [inset, s - c - k],
    [inset, c + k],
  ];
  return p.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
};

/** Clockwise closed path starting at 12 o'clock for reload progress stroke-dashoffset. */
const chamferRingPath = (size: number, inset: number): string => {
  const c = chamferCut(size);
  const k = inset * (Math.SQRT2 - 1);
  const s = size;
  const mid = s / 2;
  const f = (n: number) => Number(n.toFixed(2));
  return (
    `M ${f(mid)},${f(inset)} ` +
    `L ${f(s - c - k)},${f(inset)} ` +
    `L ${f(s - inset)},${f(c + k)} ` +
    `L ${f(s - inset)},${f(s - c - k)} ` +
    `L ${f(s - c - k)},${f(s - inset)} ` +
    `L ${f(c + k)},${f(s - inset)} ` +
    `L ${f(inset)},${f(s - c - k)} ` +
    `L ${f(inset)},${f(c + k)} ` +
    `L ${f(c + k)},${f(inset)} Z`
  );
};

function buildFrameSvg(size: number, circle: boolean): string {
  const s = size;
  const halfStroke = BTN_STROKE_PX / 2;
  if (circle) {
    const r = s / 2;
    const rBorder = Number((r - halfStroke).toFixed(2));
    const rHi = Number((r - (s >= 100 ? 3.5 : 2.1)).toFixed(2));
    const rInner = Number((r - (s >= 100 ? 6.5 : 2.9)).toFixed(2));
    const dash = s >= 100 ? '14 8' : '10 6';
    // Upper ~112° highlight arc centered at 12 o'clock (-146° to -34°)
    const a0 = (-146 * Math.PI) / 180;
    const a1 = (-34 * Math.PI) / 180;
    const x0 = Number((r + rHi * Math.cos(a0)).toFixed(2));
    const y0 = Number((r + rHi * Math.sin(a0)).toFixed(2));
    const x1 = Number((r + rHi * Math.cos(a1)).toFixed(2));
    const y1 = Number((r + rHi * Math.sin(a1)).toFixed(2));
    return (
      `<svg data-role="frame" viewBox="0 0 ${s} ${s}" width="100%" height="100%" aria-hidden="true" ` +
      `style="position:absolute;inset:0;display:block;pointer-events:none;z-index:1;overflow:visible;">` +
      `<circle data-role="fire-accent" cx="${r}" cy="${r}" r="${rInner}" fill="none" stroke-width="1.25" stroke-dasharray="${dash}"/>` +
      `<path data-role="hi-top" d="M ${x0} ${y0} A ${rHi} ${rHi} 0 0 1 ${x1} ${y1}" fill="none" stroke="${PALETTE.uiBtnHiTop}" stroke-width="1.2" stroke-linecap="round"/>` +
      `<circle data-role="border" cx="${r}" cy="${r}" r="${rBorder}" fill="none" stroke-width="${BTN_STROKE_PX}"/>` +
      `</svg>`
    );
  }
  const c = chamferCut(s);
  const pts = chamferPoints(s, halfStroke);
  const hiY = Number((halfStroke + 1.25).toFixed(2));
  const hiX0 = Number((c + 1.1).toFixed(2));
  const hiX1 = Number((s - c - 1.1).toFixed(2));
  const hiSide = Number((halfStroke + 1.25).toFixed(2));
  const hiEndY = Number((c + 1.1).toFixed(2));
  const botY = Number((s - halfStroke - 1.25).toFixed(2));
  return (
    `<svg data-role="frame" viewBox="0 0 ${s} ${s}" width="100%" height="100%" aria-hidden="true" ` +
    `style="position:absolute;inset:0;display:block;pointer-events:none;z-index:1;overflow:visible;">` +
    `<polyline data-role="hi-top" points="${hiSide},${hiEndY} ${hiX0},${hiY} ${hiX1},${hiY} ${Number((s - hiSide).toFixed(2))},${hiEndY}" fill="none" stroke="${PALETTE.uiBtnHiTop}" stroke-width="1" stroke-linecap="square"/>` +
    `<line data-role="hi-bot" x1="${hiX0}" y1="${botY}" x2="${hiX1}" y2="${botY}" stroke="${PALETTE.uiBtnHiInnerBot}" stroke-width="1"/>` +
    `<polygon data-role="border" points="${pts}" fill="none" stroke-width="${BTN_STROKE_PX}" stroke-linejoin="miter"/>` +
    `</svg>`
  );
}

function buildReloadRingSvg(size: number, dashOffset = 360): string {
  const s = size;
  const d = chamferRingPath(s, 2.6);
  const off = Number(dashOffset.toFixed(2));
  return (
    `<svg data-role="reload-ring" viewBox="0 0 ${s} ${s}" width="100%" height="100%" aria-hidden="true" ` +
    `style="position:absolute;inset:0;display:block;pointer-events:none;z-index:2;opacity:0;transition:opacity 80ms linear;">` +
    `<path data-role="reload-track" d="${d}" fill="none" stroke="${PALETTE.uiBtnReloadTrack}" stroke-width="2.4" stroke-linejoin="miter"/>` +
    `<path data-role="reload-arc" d="${d}" pathLength="360" fill="none" stroke="${PALETTE.accent}" stroke-width="2.4" stroke-linecap="butt" stroke-linejoin="miter" stroke-dasharray="360" stroke-dashoffset="${off}"/>` +
    `</svg>`
  );
}

let stylesInjected = false;
export function ensureHudStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const st = document.createElement('style');
  st.id = 'val-hud-styles';
  st.textContent = `
@keyframes valLowHpBreathe {
  0%, 100% { opacity: 1; filter: drop-shadow(0 0 4px rgba(255,70,85,0.45)); }
  50% { opacity: 0.62; filter: drop-shadow(0 0 10px rgba(255,70,85,0.85)); }
}
@keyframes valFirePulse {
  0% { box-shadow: 0 3px 7px ${PALETTE.uiBtnShadow}, 0 0 0 0 rgba(255,70,85,0.68), inset 0 0 12px rgba(255,70,85,0.28); }
  100% { box-shadow: 0 3px 7px ${PALETTE.uiBtnShadow}, 0 0 0 12px rgba(255,70,85,0), inset 0 0 4px rgba(255,70,85,0.06); }
}
@keyframes valObjUrgent {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.09); opacity: 0.72; }
}
.val-lowhp-breathe { animation: valLowHpBreathe 1.2s ease-in-out infinite; }
.val-obj-urgent { animation: valObjUrgent 0.9s ease-in-out infinite; }
.val-fire-pulse { animation: valFirePulse 160ms ease-out; }
.val-btn-slot {
  position: absolute;
  pointer-events: none;
  box-sizing: border-box;
  filter: drop-shadow(0 3px 5px ${PALETTE.uiBtnShadow});
}
.val-btn-slot[data-circle="1"] {
  filter: none;
}
.val-tac-btn {
  --btn-stroke: ${PALETTE.uiBtnBorder};
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4px;
  box-sizing: border-box;
  background-color: ${PALETTE.uiBtnPanel};
  background-image: linear-gradient(180deg, ${PALETTE.uiBtnGradTop} 0%, ${PALETTE.uiBtnGradMid} 36%, ${PALETTE.uiBtnGradBot} 100%);
  color: ${PALETTE.uiText};
  font-family: ${HUD_BTN_FONT};
  font-stretch: condensed;
  font-weight: 700;
  text-transform: uppercase;
  line-height: 1;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
  transform: scale(1);
  transform-origin: 50% 50%;
  transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), filter 160ms ease-out;
}
.val-tac-btn[data-circle="1"] {
  border-radius: 50%;
  box-shadow: 0 3px 7px ${PALETTE.uiBtnShadow};
  color: ${PALETTE.accent};
}
.val-tac-btn [data-role="icon"] {
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  position: relative;
  z-index: 3;
}
.val-tac-btn [data-role="label"] {
  font-size: ${BTN_LABEL_PX}px;
  font-stretch: condensed;
  letter-spacing: 0.06em;
  margin-right: -0.06em;
  transform: scaleX(0.88);
  transform-origin: 50% 50%;
  color: ${PALETTE.uiText};
  opacity: 1;
  white-space: nowrap;
  pointer-events: none;
  position: relative;
  z-index: 3;
}
.val-tac-btn[data-circle="1"] [data-role="label"] {
  font-size: 11px;
  letter-spacing: 0.10em;
  transform: scaleX(0.96);
}
.val-tac-btn [data-role="border"] {
  stroke: var(--btn-stroke);
}
.val-tac-btn [data-role="fire-accent"] {
  stroke: ${PALETTE.uiBtnFireInnerRing};
}
.val-tac-btn[data-active="1"],
[data-btn="mute"][data-active="1"] .val-mute-plate {
  --btn-stroke: ${PALETTE.accent};
  background-image: linear-gradient(180deg, ${PALETTE.uiBtnActiveTop} 0%, ${PALETTE.uiBtnActiveMid} 52%, ${PALETTE.uiBtnActiveBot} 100%);
  color: ${PALETTE.accent};
}
.val-tac-btn[data-pressed="1"],
[data-btn="mute"][data-pressed="1"] .val-mute-plate {
  --btn-stroke: ${PALETTE.accent};
  transform: scale(0.96);
  background-image: linear-gradient(180deg, ${PALETTE.uiBtnPressedTop} 0%, ${PALETTE.uiBtnPressedMid} 50%, ${PALETTE.uiBtnPressedBot} 100%);
  box-shadow: inset 0 0 14px ${PALETTE.uiBtnPressedGlow};
  filter: brightness(1.18);
}
.val-tac-btn[data-circle="1"][data-pressed="1"] {
  box-shadow: 0 3px 7px ${PALETTE.uiBtnShadow}, 0 0 14px ${PALETTE.uiBtnPressedGlow}, inset 0 0 18px ${PALETTE.uiBtnPressedGlow};
}
.val-tac-btn[data-circle="1"][data-pressed="1"] [data-role="fire-accent"] {
  stroke: ${PALETTE.accent};
}
.val-tac-btn[data-disabled="1"] {
  --btn-stroke: ${PALETTE.uiBtnBorderDisabled};
  background-image: linear-gradient(180deg, ${PALETTE.uiBtnGradTop} 0%, ${PALETTE.uiBtnGradMid} 36%, ${PALETTE.uiBtnGradBot} 100%);
  color: ${PALETTE.uiBtnFgDisabled};
  filter: saturate(0.18) brightness(0.84);
  transform: scale(1);
}
.val-tac-btn[data-disabled="1"] [data-role="label"] {
  color: ${PALETTE.uiBtnFgDisabled};
}
.val-tac-btn[data-disabled="1"] [data-role="fire-accent"] {
  stroke: ${PALETTE.uiBtnBorderDisabled};
  opacity: 0.45;
}
`;
  document.head.appendChild(st);
}

/** Update chamfer clip-path & pixel-exact SVG frame (and optional reload ring) after size changes. */
export function syncHudButtonFrame(el: HTMLElement, size: number, circle: boolean): void {
  el.dataset.btnSize = String(size);
  el.dataset.circle = circle ? '1' : '0';
  el.style.clipPath = circle ? '' : chamferClipCss(size);
  el.style.gap = `${size >= 68 ? 3 : 2}px`;

  const oldFrame = el.querySelector('[data-role="frame"]');
  const tmp = document.createElement('div');
  tmp.innerHTML = buildFrameSvg(size, circle);
  const newFrame = tmp.firstElementChild;
  if (newFrame) {
    if (oldFrame) oldFrame.replaceWith(newFrame);
    else el.prepend(newFrame);
  }

  const oldRing = el.querySelector('[data-role="reload-ring"]');
  if (oldRing) {
    const prevArc = oldRing.querySelector('[data-role="reload-arc"]');
    const prevOff = prevArc ? Number(prevArc.getAttribute('stroke-dashoffset') ?? 360) : 360;
    const prevOp = (oldRing as HTMLElement).style.opacity || '0';
    tmp.innerHTML = buildReloadRingSvg(size, prevOff);
    const newRing = tmp.firstElementChild as HTMLElement | null;
    if (newRing) {
      newRing.style.opacity = prevOp;
      oldRing.replaceWith(newRing);
    }
  }
}

/** Update reload progress ring (0..100%) on the reload tactical button. */
export function setHudReloadProgress(el: HTMLElement, active: boolean, pct: number): void {
  const clamped = active ? Math.max(0, Math.min(100, pct)) : 0;
  const deg = clamped * 3.6;
  const dashOff = 360 - deg;
  el.dataset.reloading = active ? '1' : '0';
  el.dataset.reloadPct = String(Number(clamped.toFixed(2)));
  el.dataset.reloadDeg = String(Number(deg.toFixed(1)));

  const ring = el.querySelector<HTMLElement>('[data-role="reload-ring"]');
  const arc = el.querySelector<SVGElement>('[data-role="reload-arc"]');
  const conic = el.querySelector<HTMLElement>('[data-role="reload-conic"]');
  if (arc) {
    const offStr = dashOff.toFixed(2);
    arc.style.strokeDashoffset = offStr;
    arc.setAttribute('stroke-dashoffset', offStr);
  }
  if (ring) {
    ring.style.opacity = active ? '1' : '0';
  }
  if (conic) {
    conic.style.opacity = active ? '1' : '0';
    conic.style.background = active
      ? `conic-gradient(from 0deg, ${PALETTE.uiBtnReloadSweep} 0deg ${deg.toFixed(1)}deg, transparent ${deg.toFixed(1)}deg 360deg)`
      : 'none';
  }
}

/** Read DOM-verifiable state of any tactical HUD button (`fire|reload|swap|jump|crouch|mute`). */
export function readHudButtonState(id: string): HudBtnState | null {
  if (typeof document === 'undefined') return null;
  const el =
    document.querySelector<HTMLElement>(`#touch-ui [data-btn="${id}"]`) ??
    document.querySelector<HTMLElement>(`[data-btn="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const lbl = el.querySelector<HTMLElement>('[data-role="label"]');
  const labelFontPx = lbl ? Number(parseFloat(getComputedStyle(lbl).fontSize).toFixed(2)) : 0;
  const borderEl = el.querySelector<SVGElement>('[data-role="border"]');
  const strokePx = borderEl
    ? Number(parseFloat(getComputedStyle(borderEl).strokeWidth).toFixed(2))
    : Number(parseFloat(getComputedStyle(el).borderTopWidth).toFixed(2));
  const reloadPct = Number(Number(el.dataset.reloadPct ?? 0).toFixed(2));
  return {
    rect: {
      x: Number(r.x.toFixed(1)),
      y: Number(r.y.toFixed(1)),
      w: Number(r.width.toFixed(1)),
      h: Number(r.height.toFixed(1)),
    },
    pressed: el.dataset.pressed === '1',
    active: el.dataset.active === '1',
    disabled: el.dataset.disabled === '1',
    reloadPct,
    labelFontPx,
    strokePx,
  };
}

/** Shared tactical panel button factory (used by HUD touch controls). */
export function buildHudButton(opts: {
  id: string;
  label: string;
  iconSvg: string;
  posCss: string;
  size: number;
  circle?: boolean;
  danger?: boolean;
  hasReloadRing?: boolean;
  zIndex?: number;
}): HTMLDivElement {
  ensureHudStyles();
  const {
    id,
    label,
    iconSvg,
    posCss,
    size,
    circle = false,
    hasReloadRing = false,
    zIndex,
  } = opts;
  const el = document.createElement('div');
  el.className = 'val-tac-btn';
  el.dataset.btn = id;
  el.dataset.pressed = '0';
  el.dataset.active = '0';
  el.dataset.disabled = '0';
  el.dataset.reloadPct = '0';
  el.dataset.reloadDeg = '0';
  el.dataset.circle = circle ? '1' : '0';
  el.style.cssText =
    (posCss ? `position:${zIndex !== undefined ? 'fixed' : 'absolute'};${posCss}` : '') +
    `width:${size}px;height:${size}px;` +
    (zIndex !== undefined ? `z-index:${zIndex};` : '');

  if (hasReloadRing) {
    const conic = document.createElement('div');
    conic.dataset.role = 'reload-conic';
    conic.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:0;opacity:0;transition:opacity 80ms linear;';
    el.appendChild(conic);
    const tmp = document.createElement('div');
    tmp.innerHTML = buildReloadRingSvg(size, 360);
    if (tmp.firstElementChild) el.appendChild(tmp.firstElementChild);
  }

  const iconBox = document.createElement('div');
  iconBox.dataset.role = 'icon';
  iconBox.innerHTML = iconSvg;

  const txt = document.createElement('span');
  txt.dataset.role = 'label';
  txt.textContent = label;

  el.append(iconBox, txt);
  syncHudButtonFrame(el, size, circle);
  return el;
}

function div(style: string, parent: HTMLElement, hudTag?: string): HTMLDivElement {
  const el = document.createElement('div');
  if (hudTag) el.dataset.hud = hudTag;
  el.style.cssText = style;
  parent.appendChild(el);
  return el;
}

export class Hud {
  private root: HTMLDivElement;
  private hpWrap: HTMLDivElement;
  private hpFill1: HTMLDivElement;
  private hpFill2: HTMLDivElement;
  private hpNum: HTMLDivElement;
  private hpMaxEl: HTMLDivElement;
  private hpTag: HTMLDivElement;
  private hpRegenBadge: HTMLDivElement;

  // Shared bottom-right weapon container, with two completely distinct sub-layouts:
  private ammoWrap: HTMLDivElement;
  private ammoText: HTMLDivElement;
  private ammoSub: HTMLDivElement;
  private riflePanel: HTMLDivElement;
  private ammoSegs: HTMLDivElement[] = [];
  private rifleHintEl: HTMLDivElement;
  private rifleStabilityFill: HTMLDivElement;

  // Dedicated Gatling UI (3×100-round rows + spin-up gauge + vibration/spread hint)
  private gatlingPanel: HTMLDivElement;
  private gatlingRows: HTMLDivElement[][] = [];
  private gatlingRowCounts: HTMLDivElement[] = [];
  private gatlingSpinFill: HTMLDivElement;
  private gatlingSpinLabel: HTMLDivElement;
  private gatlingHintEl: HTMLDivElement;

  // Crosshair: rifle precision cross vs gatling rotary ring
  private crossRifleWrap: HTMLDivElement;
  private crossLines: HTMLDivElement[] = [];
  private crossDot: HTMLDivElement;
  private crossGatlingWrap: HTMLDivElement;
  private crossGatlingRing: HTMLDivElement;

  private fpsEl: HTMLDivElement;
  // Top-centre objective bar: 我方 a/25 · M:SS · 敌方 b
  private objWrap: HTMLDivElement;
  private objA: HTMLDivElement;
  private objANum: HTMLSpanElement;
  private objAGoal: HTMLSpanElement;
  private objTime: HTMLDivElement;
  private objB: HTMLDivElement;
  private objBNum: HTMLSpanElement;
  private objKey = '';
  private deadEl: HTMLDivElement;
  private swapBlurEl: HTMLDivElement;
  private fpsVisible = true;
  private touchMode: boolean;
  private lastWeaponMode: WeaponId | null = null;

  private hurtEl: HTMLDivElement;
  private lowHpEl: HTMLDivElement;
  private deathVeilEl: HTMLDivElement;
  private fallFadeEl: HTMLDivElement;
  private arcEl: HTMLDivElement;
  private killEl: HTMLDivElement;
  private muteBtn: HTMLDivElement;
  private muteBadge: HTMLDivElement;
  private muteIconEl: HTMLDivElement;
  private mutePtrs = new Set<number>();
  private hurtAt = -1;
  private arcAt = -1;
  private arcAngle = 0;
  private killAt = -1;
  private hitCrossAt = -1;
  private mutedFlag = false;
  private isLowHpState = false;
  private lastPortrait: boolean | null = null;

  /** counters/values for the e2e feedback hooks — persistent object */
  readonly fx = { hits: 0, kills: 0, flashOpacity: 0, lowHpPulse: 0, desat: 0 };
  /** wired by main.ts to the sfx bus */
  onMuteToggle: ((muted: boolean) => void) | null = null;

  constructor(parent: HTMLElement, touchMode: boolean) {
    ensureHudStyles();
    this.touchMode = touchMode;
    this.root = div(
      `position:fixed;inset:0;z-index:5;pointer-events:none;font-family:${HUD_FONT};` +
        `color:${PALETTE.uiText};`,
      parent,
    );
    const ab = (px: number) => `calc(${px}px + env(safe-area-inset-bottom, 0px))`;
    const al = (px: number) => `calc(${px}px + env(safe-area-inset-left, 0px))`;
    const ar = (px: number) => `calc(${px}px + env(safe-area-inset-right, 0px))`;
    const at = (px: number) => `calc(${px}px + env(safe-area-inset-top, 0px))`;

    this.swapBlurEl = div(
      `position:absolute;left:0;right:0;bottom:0;height:36%;pointer-events:none;` +
        `opacity:0;display:none;` +
        `mask-image:linear-gradient(to top, rgba(0,0,0,0.9) 25%, rgba(0,0,0,0) 100%);` +
        `-webkit-mask-image:linear-gradient(to top, rgba(0,0,0,0.9) 25%, rgba(0,0,0,0) 100%);` +
        `backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);`,
      this.root,
      'swap-blur',
    );

    // --- HP panel: bottom-left (2-segment 0–100–200 bar + enlarged numeral) ---
    this.hpWrap = div(
      `position:absolute;left:${al(16)};bottom:${ab(18)};width:206px;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-left:3px solid ${PALETTE.uiText};border-radius:4px;padding:4px 10px 5px;` +
        `box-sizing:border-box;pointer-events:none;`,
      this.root,
      'hp',
    );
    const hpHeader = div(
      `display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px;pointer-events:none;`,
      this.hpWrap,
    );
    const hpLeftLbl = div(
      `display:flex;align-items:baseline;gap:6px;pointer-events:none;`,
      hpHeader,
    );
    this.hpTag = div(
      `font-size:11px;font-weight:800;letter-spacing:0.16em;color:${PALETTE.uiDim};pointer-events:none;`,
      hpLeftLbl,
      'hp-tag',
    );
    this.hpTag.textContent = 'HP';
    this.hpRegenBadge = div(
      `font-size:9px;font-weight:800;letter-spacing:0.08em;color:${PALETTE.gatlingReady};` +
        `opacity:0;transition:opacity 120ms linear;pointer-events:none;`,
      hpLeftLbl,
      'hp-regen',
    );
    this.hpRegenBadge.textContent = '+REGEN';

    const hpNumWrap = div(
      `display:flex;align-items:baseline;gap:4px;pointer-events:none;`,
      hpHeader,
    );
    this.hpNum = div(
      `font-size:30px;font-weight:800;line-height:0.92;font-variant-numeric:tabular-nums;` +
        `letter-spacing:-0.01em;color:${PALETTE.uiText};pointer-events:none;`,
      hpNumWrap,
      'hp-num',
    );
    this.hpNum.textContent = '200';
    this.hpMaxEl = div(
      `font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:${PALETTE.uiDim};pointer-events:none;`,
      hpNumWrap,
      'hp-max',
    );
    this.hpMaxEl.textContent = '/ 200';

    // Two-segment HP bar split at 100 (Seg 1: 0..100, Seg 2: 100..200)
    const hpBars = div(
      `display:flex;align-items:center;gap:4px;height:8px;pointer-events:none;`,
      this.hpWrap,
      'hp-bars',
    );
    const seg1Track = div(
      `flex:1;height:100%;border-radius:1px;background:${PALETTE.uiEmpty};overflow:hidden;pointer-events:none;`,
      hpBars,
    );
    seg1Track.dataset.hpSeg = '1';
    this.hpFill1 = div(
      `height:100%;width:100%;background:${PALETTE.hpFull};transition:width 60ms linear;pointer-events:none;`,
      seg1Track,
    );
    const segDivider = div(
      `width:2px;height:10px;background:${PALETTE.uiBorderActive};border-radius:1px;flex:0 0 auto;pointer-events:none;`,
      hpBars,
      'hp-divider',
    );
    void segDivider;
    const seg2Track = div(
      `flex:1;height:100%;border-radius:1px;background:${PALETTE.uiEmpty};overflow:hidden;pointer-events:none;`,
      hpBars,
    );
    seg2Track.dataset.hpSeg = '2';
    this.hpFill2 = div(
      `height:100%;width:100%;background:${PALETTE.hpSeg2};transition:width 60ms linear;pointer-events:none;`,
      seg2Track,
    );

    // Scale markers: 0 · 100 · 200
    const hpTicks = div(
      `display:flex;justify-content:space-between;align-items:center;margin-top:2px;` +
        `font-size:8px;font-weight:700;letter-spacing:0.06em;font-variant-numeric:tabular-nums;` +
        `color:${PALETTE.uiDim};line-height:1;pointer-events:none;`,
      this.hpWrap,
      'hp-ticks',
    );
    const t0 = div(`pointer-events:none;`, hpTicks);
    t0.textContent = '0';
    const t100 = div(`color:${PALETTE.uiText};opacity:0.85;pointer-events:none;`, hpTicks);
    t100.textContent = '100';
    const t200 = div(`pointer-events:none;`, hpTicks);
    t200.textContent = '200';

    // --- AMMO panel: bottom-right ---
    this.ammoWrap = div(
      `position:absolute;right:${ar(16)};bottom:${ab(16)};min-width:162px;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-right:2px solid ${PALETTE.uiText};border-radius:4px;padding:5px 10px 7px;` +
        `text-align:right;box-sizing:border-box;pointer-events:none;`,
      this.root,
      'ammo',
    );
    this.ammoWrap.dataset.hudMode = 'rifle';

    const ammoTop = div(
      `display:flex;align-items:baseline;justify-content:flex-end;gap:6px;pointer-events:none;`,
      this.ammoWrap,
    );
    this.ammoText = div(
      `font-size:32px;font-weight:800;line-height:0.95;font-variant-numeric:tabular-nums;` +
        `letter-spacing:-0.01em;color:${PALETTE.uiText};pointer-events:none;`,
      ammoTop,
      'ammo-num',
    );
    this.ammoText.textContent = '30';
    const ammoInf = div(
      `font-size:11px;font-weight:700;color:${PALETTE.uiDim};letter-spacing:0.06em;pointer-events:none;`,
      ammoTop,
    );
    ammoInf.textContent = '/ ∞';
    this.ammoSub = div(
      `font-size:9px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;` +
        `color:${PALETTE.uiDim};margin-top:3px;pointer-events:none;`,
      this.ammoWrap,
    );
    this.ammoSub.textContent = 'ASSAULT RIFLE';

    // --- Rifle-specific UI: 30-segment bar + precision/recoil strip ---
    this.riflePanel = div(`display:block;pointer-events:none;`, this.ammoWrap, 'rifle-ui');
    const segRow = div(
      `display:flex;align-items:center;gap:1.5px;height:6px;width:142px;margin:6px 0 0 auto;pointer-events:none;`,
      this.riflePanel,
      'ammo-bar',
    );
    for (let i = 0; i < RIFLE_SEGMENTS; i++) {
      const seg = div(
        `flex:1;height:100%;border-radius:1px;background:${PALETTE.uiText};pointer-events:none;`,
        segRow,
      );
      seg.dataset.lit = '1';
      this.ammoSegs.push(seg);
    }
    this.rifleHintEl = div(
      `display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:5px;` +
        `font-size:8px;font-weight:700;letter-spacing:0.1em;color:${PALETTE.uiDim};pointer-events:none;`,
      this.riflePanel,
      'rifle-recoil',
    );
    const rifleLbl = div(`pointer-events:none;`, this.rifleHintEl);
    rifleLbl.textContent = 'ACC HIGH · BURST';
    const rifleTrack = div(
      `width:44px;height:3px;background:${PALETTE.uiEmpty};border-radius:1px;overflow:hidden;pointer-events:none;`,
      this.rifleHintEl,
    );
    this.rifleStabilityFill = div(
      `height:100%;width:100%;background:${PALETTE.uiText};pointer-events:none;`,
      rifleTrack,
    );

    // --- Gatling-specific UI: 3×100-round rows + 250ms spin-up bar + heavy vibration/spread readout ---
    this.gatlingPanel = div(
      `display:none;flex-direction:column;gap:3px;margin-top:5px;width:196px;pointer-events:none;`,
      this.ammoWrap,
      'gatling-ui',
    );
    const barsWrap = div(
      `display:flex;flex-direction:column;gap:2.5px;pointer-events:none;`,
      this.gatlingPanel,
      'gatling-bars',
    );
    // Row 0 = 201..300 (top), Row 1 = 101..200 (mid), Row 2 = 1..100 (base)
    const rowLabels = ['300', '200', '100'];
    for (let r = 0; r < GATLING_ROWS; r++) {
      const rowLine = div(
        `display:flex;align-items:center;gap:4px;pointer-events:none;`,
        barsWrap,
      );
      rowLine.dataset.gatlingRow = String(r);
      const lbl = div(
        `width:22px;font-size:8px;font-weight:800;font-variant-numeric:tabular-nums;` +
          `text-align:right;color:${PALETTE.gatlingAccent};opacity:0.88;pointer-events:none;`,
        rowLine,
      );
      lbl.textContent = rowLabels[r];
      this.gatlingRowCounts.push(lbl);
      const cellRow = div(
        `display:flex;flex:1;gap:1.5px;height:5px;pointer-events:none;`,
        rowLine,
      );
      const cells: HTMLDivElement[] = [];
      for (let c = 0; c < GATLING_CELLS_PER_ROW; c++) {
        const cell = div(
          `flex:1;height:100%;border-radius:1px;background:${PALETTE.gatlingAccent};pointer-events:none;`,
          cellRow,
        );
        cell.dataset.lit = '1';
        cells.push(cell);
      }
      this.gatlingRows.push(cells);
    }

    // Spin-up gauge (250ms pre-heat visual feedback)
    const spinRow = div(
      `display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:3px;pointer-events:none;`,
      this.gatlingPanel,
      'gatling-spin',
    );
    this.gatlingSpinLabel = div(
      `font-size:8px;font-weight:800;letter-spacing:0.08em;white-space:nowrap;color:${PALETTE.gatlingAccent};pointer-events:none;`,
      spinRow,
    );
    this.gatlingSpinLabel.textContent = 'ROTOR IDLE · 250MS SPIN';
    const spinTrack = div(
      `width:52px;height:4px;border-radius:2px;background:${PALETTE.uiEmpty};overflow:hidden;pointer-events:none;`,
      spinRow,
    );
    this.gatlingSpinFill = div(
      `height:100%;width:0%;background:${PALETTE.gatlingAccent};pointer-events:none;`,
      spinTrack,
    );

    // Distinct Gatling recoil/accuracy/speed tag
    this.gatlingHintEl = div(
      `font-size:8px;font-weight:700;letter-spacing:0.08em;color:${PALETTE.uiDim};` +
        `text-align:right;pointer-events:none;`,
      this.gatlingPanel,
      'gatling-recoil',
    );
    this.gatlingHintEl.textContent = 'WIDE SPREAD · LOW RECOIL · 0.82× SPD';

    // --- Crosshair: center (Rifle 4-line precision cross vs Gatling rotary ring) ---
    const cross = div(
      `position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;`,
      this.root,
      'cross',
    );
    this.crossRifleWrap = div(`position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;`, cross);
    const mkLine = (w: number, h: number): HTMLDivElement => {
      const el = div(
        `position:absolute;left:${-w / 2}px;top:${-h / 2}px;width:${w}px;height:${h}px;` +
          `background:${PALETTE.crosshair};box-shadow:0 0 0 1px ${PALETTE.crosshairEdge};pointer-events:none;`,
        this.crossRifleWrap,
      );
      this.crossLines.push(el);
      return el;
    };
    mkLine(2, 7); // top
    mkLine(2, 7); // bottom
    mkLine(7, 2); // left
    mkLine(7, 2); // right
    this.crossDot = div(
      `position:absolute;left:-1px;top:-1px;width:2px;height:2px;border-radius:50%;` +
        `background:${PALETTE.crosshair};box-shadow:0 0 0 1px ${PALETTE.crosshairEdge};pointer-events:none;`,
      this.crossRifleWrap,
    );

    // Gatling rotary reticle: wide circle + 6-barrel radial ticks (distinct from rifle cross!)
    this.crossGatlingWrap = div(
      `position:absolute;left:0;top:0;width:0;height:0;display:none;pointer-events:none;`,
      cross,
      'cross-gatling',
    );
    this.crossGatlingRing = div(
      `position:absolute;left:-20px;top:-20px;width:40px;height:40px;pointer-events:none;`,
      this.crossGatlingWrap,
    );
    this.crossGatlingRing.innerHTML =
      `<svg viewBox="0 0 48 48" width="100%" height="100%" fill="none">` +
      `<circle cx="24" cy="24" r="15" stroke="${PALETTE.gatlingAccent}" stroke-width="1.5" stroke-dasharray="6 5" opacity="0.9"/>` +
      `<circle cx="24" cy="24" r="2" fill="${PALETTE.crosshair}"/>` +
      `<line x1="24" y1="3" x2="24" y2="8" stroke="${PALETTE.crosshair}" stroke-width="1.8"/>` +
      `<line x1="24" y1="40" x2="24" y2="45" stroke="${PALETTE.crosshair}" stroke-width="1.8"/>` +
      `<line x1="3" y1="24" x2="8" y2="24" stroke="${PALETTE.crosshair}" stroke-width="1.8"/>` +
      `<line x1="40" y1="24" x2="45" y2="24" stroke="${PALETTE.crosshair}" stroke-width="1.8"/>` +
      `</svg>`;

    // Top-right toggleable FPS readout (clear of 56×56 top-right mute button)
    this.fpsEl = div(
      `position:absolute;right:${ar(76)};top:${at(28)};` +
        `font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;` +
        `color:${PALETTE.uiDim};pointer-events:none;`,
      this.root,
      'fps',
    );

    // --- Objective bar: top-centre, between the left edge and the FPS/mute
    // cluster on the right. Width capped at 62vw so on a 390px portrait
    // screen it ends ≥18px left of the 44px mute hit-box (right:12px). ---
    this.objWrap = div(
      `position:absolute;left:50%;top:${at(10)};transform:translateX(-50%);` +
        `display:none;align-items:center;justify-content:center;gap:10px;` +
        `max-width:62vw;box-sizing:border-box;padding:4px 12px;white-space:nowrap;overflow:hidden;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};border-radius:4px;` +
        `font-size:13px;font-weight:800;letter-spacing:0.06em;line-height:1.15;` +
        `font-variant-numeric:tabular-nums;pointer-events:none;`,
      this.root,
      'objective',
    );
    const objSide = (key: 'a' | 'b', label: string, color: string): [HTMLDivElement, HTMLSpanElement] => {
      const el = div(
        `display:flex;align-items:baseline;gap:4px;border-${key === 'a' ? 'left' : 'right'}:3px solid ${color};` +
          `padding-${key === 'a' ? 'left' : 'right'}:6px;pointer-events:none;`,
        this.objWrap,
      );
      el.dataset.obj = key;
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = `font-size:12px;font-weight:700;color:${PALETTE.uiDim};`;
      const num = document.createElement('span');
      num.textContent = '0';
      num.style.cssText = `font-size:15px;color:${color};`;
      el.append(lbl, num);
      return [el, num];
    };
    [this.objA, this.objANum] = objSide('a', '我方', PALETTE.teamA);
    this.objAGoal = document.createElement('span');
    this.objAGoal.style.cssText = `font-size:12px;color:${PALETTE.uiDim};margin-left:-3px;`;
    this.objA.appendChild(this.objAGoal);
    this.objTime = div(
      `font-size:16px;font-weight:800;color:${PALETTE.uiText};min-width:3.2em;text-align:center;` +
        `transform-origin:50% 50%;pointer-events:none;`,
      this.objWrap,
    );
    this.objTime.dataset.obj = 'time';
    [this.objB, this.objBNum] = objSide('b', '敌方', PALETTE.teamB);

    this.deadEl = div(
      `position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);` +
        `background:${PALETTE.deadVeil};border:1px solid ${PALETTE.accent};` +
        `border-radius:4px;padding:12px 24px;font-size:14px;font-weight:700;` +
        `letter-spacing:0.14em;text-transform:uppercase;` +
        `color:${PALETTE.uiText};display:none;text-align:center;pointer-events:none;`,
      this.root,
      'dead',
    );

    // --- Feedback overlays ---
    this.hurtEl = div(`position:absolute;inset:0;background:${HURT_BG};opacity:0;pointer-events:none;`, this.root);
    this.hurtEl.dataset.fx = 'hurt';
    this.lowHpEl = div(`position:absolute;inset:0;background:${HURT_BG};opacity:0;pointer-events:none;`, this.root);
    this.lowHpEl.dataset.fx = 'lowhp';
    this.deathVeilEl = div(
      `position:absolute;inset:0;background:radial-gradient(ellipse 90% 80% at 50% 50%, rgba(45,6,10,0.28) 20%, rgba(16,4,8,0.88) 100%);` +
        `opacity:0;display:none;pointer-events:none;z-index:18;`,
      this.root,
    );
    this.deathVeilEl.dataset.fx = 'death-veil';
    this.fallFadeEl = div(
      `position:absolute;inset:0;background:radial-gradient(ellipse 85% 75% at 50% 50%, rgba(4,8,12,0.92) 32%, #000000 100%);` +
        `opacity:0;display:none;pointer-events:none;z-index:25;`,
      this.root,
    );
    this.fallFadeEl.dataset.fx = 'fall-fade';

    this.arcEl = div(
      `position:absolute;left:50%;top:50%;width:44vmin;height:44vmin;` +
        `transform:translate(-50%,-50%);opacity:0;pointer-events:none;`,
      this.root,
    );
    this.arcEl.dataset.fx = 'arc';
    this.arcEl.innerHTML =
      `<svg viewBox="0 0 100 100" width="100%" height="100%">` +
      `<path d="M16 53 A35 35 0 0 1 84 53" fill="none" stroke="${PALETTE.accent}" ` +
      `stroke-width="4" stroke-linecap="round"/></svg>`;

    this.killEl = div(
      `position:absolute;left:50%;top:28%;transform:translateX(-50%);` +
        `font-size:15px;font-weight:800;letter-spacing:0.22em;text-transform:uppercase;` +
        `color:${PALETTE.accent};text-shadow:0 0 8px ${PALETTE.crosshairEdge};` +
        `opacity:0;pointer-events:none;`,
      this.root,
    );
    this.killEl.dataset.fx = 'kill';
    this.killEl.textContent = 'ELIMINATED';

    // --- Top-right SOUND icon (56×56 clickable hit target, chamfered tactical plate) ---
    this.muteBtn = document.createElement('div');
    this.muteBtn.dataset.btn = 'mute';
    this.muteBtn.dataset.pressed = '0';
    this.muteBtn.dataset.active = '0';
    this.muteBtn.dataset.disabled = '0';
    this.muteBtn.dataset.reloadPct = '0';
    this.muteBtn.style.cssText =
      `position:fixed;right:${ar(8)};top:${at(8)};width:56px;height:56px;` +
      `display:flex;align-items:center;justify-content:center;background:transparent;` +
      `filter:drop-shadow(0 3px 5px ${PALETTE.uiBtnShadow});` +
      `pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;` +
      `box-sizing:border-box;cursor:pointer;z-index:30;`;
    this.muteBadge = document.createElement('div');
    this.muteBadge.className = 'val-tac-btn val-mute-plate';
    this.muteBadge.style.cssText = 'width:48px;height:48px;pointer-events:none;';
    this.muteIconEl = document.createElement('div');
    this.muteIconEl.dataset.role = 'icon';
    this.muteIconEl.innerHTML = HUD_ICONS.soundOn(20);
    this.muteBadge.appendChild(this.muteIconEl);
    syncHudButtonFrame(this.muteBadge, 48, false);
    this.muteBtn.appendChild(this.muteBadge);
    parent.appendChild(this.muteBtn);
    this.muteBtn.addEventListener('pointerdown', (e) => {
      this.mutePtrs.add(e.pointerId);
      this.muteBtn.dataset.pressed = '1';
    });
    const releaseMute = (e: PointerEvent) => {
      if (this.mutePtrs.delete(e.pointerId) && this.mutePtrs.size === 0) {
        this.muteBtn.dataset.pressed = '0';
      }
    };
    window.addEventListener('pointerup', releaseMute);
    window.addEventListener('pointercancel', releaseMute);
    this.muteBtn.addEventListener('click', () => {
      this.setMuted(!this.mutedFlag);
      this.onMuteToggle?.(this.mutedFlag);
    });

    this.applyLayout();
    window.addEventListener('resize', () => this.applyLayout());
    window.addEventListener('orientationchange', () => this.applyLayout());
  }

  private applyLayout(): void {
    const portrait = window.innerHeight > window.innerWidth;
    if (portrait === this.lastPortrait) return;
    this.lastPortrait = portrait;
    const ab = (px: number) => `calc(${px}px + env(safe-area-inset-bottom, 0px))`;
    const al = (px: number) => `calc(${px}px + env(safe-area-inset-left, 0px))`;
    const ar = (px: number) => `calc(${px}px + env(safe-area-inset-right, 0px))`;
    const at = (px: number) => `calc(${px}px + env(safe-area-inset-top, 0px))`;

    this.hpWrap.style.left = al(16);
    this.hpWrap.style.bottom = ab(portrait ? 18 : 14);
    this.hpWrap.style.width = portrait ? '196px' : '206px';

    if (this.touchMode) {
      if (portrait) {
        // Portrait 390×844: upper-right beneath 56×56 mute button, leaving middle HUD & lower-right cluster completely clear
        this.ammoWrap.style.right = ar(12);
        this.ammoWrap.style.top = at(72);
        this.ammoWrap.style.bottom = '';
      } else {
        // Landscape 844×390: bottom-right immediately left of the 128px FIRE button (clear of cluster & crosshair)
        this.ammoWrap.style.right = ar(158);
        this.ammoWrap.style.bottom = ab(14);
        this.ammoWrap.style.top = '';
      }
    } else {
      this.ammoWrap.style.right = ar(16);
      this.ammoWrap.style.bottom = ab(16);
      this.ammoWrap.style.top = '';
    }
  }

  hitFrom(angleRad: number, now: number): void {
    this.hurtAt = now;
    this.arcAt = now;
    this.arcAngle = angleRad;
    this.fx.hits++;
  }

  notifyHit(now: number): void {
    this.hitCrossAt = now;
  }

  notifyKill(now: number): void {
    this.killAt = now;
    this.fx.kills++;
  }

  setSwapBlur(amount: number): void {
    if (amount <= 0.01) {
      if (this.swapBlurEl.style.display !== 'none') {
        this.swapBlurEl.style.display = 'none';
        this.swapBlurEl.style.opacity = '0';
      }
      return;
    }
    this.swapBlurEl.style.display = 'block';
    this.swapBlurEl.style.opacity = `${Math.min(1, amount).toFixed(2)}`;
  }

  /** Red-dark cinematic vignette [0..1] during 0.6s player death collapse. */
  setDeathVeil(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    if (a <= 0.005) {
      if (this.deathVeilEl.style.display !== 'none') {
        this.deathVeilEl.style.display = 'none';
        this.deathVeilEl.style.opacity = '0';
      }
      return;
    }
    this.deathVeilEl.style.display = 'block';
    this.deathVeilEl.style.opacity = a.toFixed(3);
  }

  setFallFade(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    if (a <= 0.005) {
      if (this.fallFadeEl.style.display !== 'none') {
        this.fallFadeEl.style.display = 'none';
        this.fallFadeEl.style.opacity = '0';
      }
      return;
    }
    this.fallFadeEl.style.display = 'block';
    this.fallFadeEl.style.opacity = a.toFixed(3);
  }

  setMuted(m: boolean): void {
    this.mutedFlag = m;
    this.muteBtn.dataset.active = m ? '1' : '0';
    this.muteIconEl.innerHTML = m ? HUD_ICONS.soundOff(20) : HUD_ICONS.soundOn(20);
  }

  /** Objective bar: writes text + dataset.v only when a displayed value changes. */
  private updateObjective(o: HudObjective | undefined): void {
    if (!o || o.phase === 'menu') {
      if (this.objKey !== 'hidden') {
        this.objKey = 'hidden';
        this.objWrap.style.display = 'none';
        this.objTime.classList.remove('val-obj-urgent');
      }
      return;
    }
    const clock = formatClock(o.timeLeftMs);
    const urgent = isClockUrgent(o.timeLeftMs, o.phase);
    const pulsing = isClockPulsing(o.timeLeftMs, o.phase);
    const key = `${o.killsA}|${o.killsB}|${o.killsToWin}|${clock}|${urgent}|${pulsing}|${o.phase}`;
    if (key === this.objKey) return;
    this.objKey = key;
    this.objWrap.style.display = 'flex';
    this.objWrap.dataset.phase = o.phase;
    this.objANum.textContent = String(o.killsA);
    this.objAGoal.textContent = `/${o.killsToWin}`;
    this.objA.dataset.v = String(o.killsA);
    this.objBNum.textContent = String(o.killsB);
    this.objB.dataset.v = String(o.killsB);
    this.objTime.textContent = clock;
    this.objTime.dataset.v = String(Math.max(0, Math.ceil(o.timeLeftMs / 1000)));
    this.objTime.dataset.urgent = urgent ? '1' : '0';
    this.objTime.style.color = urgent ? PALETTE.accent : PALETTE.uiText;
    this.objTime.classList.toggle('val-obj-urgent', pulsing);
  }

  setFpsVisible(v: boolean): void {
    this.fpsVisible = v;
  }

  update(s: HudState): void {
    const now = performance.now();
    const maxHp = Math.max(1, s.maxHp);
    const segSpan = maxHp * 0.5; // 100 per segment for 200 max HP
    const hp = Math.max(0, Math.min(maxHp, s.hp));
    const seg1Pct = Math.max(0, Math.min(100, (hp / segSpan) * 100));
    const seg2Pct = Math.max(0, Math.min(100, ((hp - segSpan) / segSpan) * 100));
    const lowHp = hp > 0 && hp < 40 && !s.dead;
    const criticalHp = hp > 0 && hp < 20 && !s.dead;

    this.hpFill1.style.width = `${seg1Pct.toFixed(1)}%`;
    this.hpFill2.style.width = `${seg2Pct.toFixed(1)}%`;
    this.hpFill1.style.background = lowHp ? PALETTE.hpLow : hp >= segSpan ? PALETTE.hpFull : PALETTE.hpMid;
    this.hpFill2.style.background = PALETTE.hpSeg2;
    this.hpNum.textContent = `${Math.ceil(hp)}`;
    this.hpMaxEl.textContent = `/ ${Math.round(maxHp)}`;
    this.hpNum.style.color = lowHp ? PALETTE.hpLow : PALETTE.uiText;
    this.hpWrap.style.borderLeftColor = lowHp ? PALETTE.hpLow : hp > segSpan ? PALETTE.hpSeg2 : PALETTE.uiText;
    this.hpRegenBadge.style.opacity = s.regenerating && !s.dead ? '1' : '0';
    if (lowHp !== this.isLowHpState) {
      this.isLowHpState = lowHp;
      this.hpWrap.classList.toggle('val-lowhp-breathe', lowHp);
    }
    this.fx.desat = criticalHp ? Number((0.45 + 0.25 * (1 - hp / 20)).toFixed(2)) : 0;

    const mode: WeaponId = s.weaponId ?? (s.mag && s.mag > 60 ? 'gatling' : 'rifle');
    const isGatling = mode === 'gatling';
    const mag = Math.max(1, s.mag ?? (isGatling ? 300 : 30));
    const lowAmmo = s.ammo <= Math.max(1, Math.ceil(mag * 0.18));

    if (mode !== this.lastWeaponMode) {
      this.lastWeaponMode = mode;
      this.ammoWrap.dataset.hudMode = mode;
      this.ammoWrap.style.borderRightColor = isGatling ? PALETTE.gatlingAccent : PALETTE.uiText;
      this.riflePanel.style.display = isGatling ? 'none' : 'block';
      this.gatlingPanel.style.display = isGatling ? 'flex' : 'none';
      this.crossRifleWrap.style.display = isGatling ? 'none' : 'block';
      this.crossGatlingWrap.style.display = isGatling ? 'block' : 'none';
    }

    this.ammoText.textContent = `${s.ammo}`;
    this.ammoText.style.color = s.reloading || lowAmmo
      ? PALETTE.accent
      : isGatling
        ? PALETTE.gatlingAccent
        : PALETTE.uiText;
    this.ammoSub.textContent = s.reloading
      ? isGatling
        ? 'SWAPPING DRUM (3.2S)'
        : 'RELOADING'
      : s.weaponName;
    this.ammoSub.style.color = s.reloading ? PALETTE.accent : PALETTE.uiDim;

    if (!isGatling) {
      // Rifle 30-segment magazine bar + burst accuracy stability indicator
      const litColor = lowAmmo ? PALETTE.accent : PALETTE.uiText;
      const emptyColor = s.ammo === 0 ? 'rgba(255,255,255,0.09)' : PALETTE.uiEmpty;
      for (let i = 0; i < RIFLE_SEGMENTS; i++) {
        const lit = i < s.ammo;
        this.ammoSegs[i].style.background = lit ? litColor : emptyColor;
        this.ammoSegs[i].dataset.lit = lit ? '1' : '0';
      }
      const stability = Math.max(15, Math.min(100, 100 - s.spreadPx * 3.2));
      this.rifleStabilityFill.style.width = `${stability.toFixed(0)}%`;
      this.rifleStabilityFill.style.background = stability < 45 ? PALETTE.accent : PALETTE.uiText;
    } else {
      // Gatling 3×100-round rows (Row 0: 201..300, Row 1: 101..200, Row 2: 1..100)
      for (let r = 0; r < GATLING_ROWS; r++) {
        const rowBase = (GATLING_ROWS - 1 - r) * 100; // 200, 100, 0
        const inRow = Math.max(0, Math.min(100, s.ammo - rowBase));
        const cells = this.gatlingRows[r];
        const perCell = 100 / GATLING_CELLS_PER_ROW; // 5 rounds/cell
        const litColor = lowAmmo ? PALETTE.accent : PALETTE.gatlingAccent;
        for (let c = 0; c < GATLING_CELLS_PER_ROW; c++) {
          const cellLo = c * perCell;
          const lit = inRow > cellLo;
          const partial = lit && inRow < cellLo + perCell;
          cells[c].style.background = lit ? litColor : PALETTE.uiEmpty;
          cells[c].style.opacity = partial ? '0.55' : '1';
          cells[c].dataset.lit = lit ? '1' : '0';
        }
        this.gatlingRowCounts[r].textContent = `${inRow}`;
        this.gatlingRowCounts[r].style.color = inRow === 0 ? PALETTE.uiDim : lowAmmo ? PALETTE.accent : PALETTE.gatlingAccent;
      }

      const spin = Math.max(0, Math.min(1, s.spinLevel ?? 0));
      this.gatlingSpinFill.style.width = `${(spin * 100).toFixed(0)}%`;
      if (s.reloading) {
        this.gatlingSpinLabel.textContent = 'RELOAD LOCKED';
        this.gatlingSpinLabel.style.color = PALETTE.accent;
        this.gatlingSpinFill.style.background = PALETTE.accent;
      } else if (spin >= 0.99) {
        this.gatlingSpinLabel.textContent = 'ROTOR READY · 900 RPM';
        this.gatlingSpinLabel.style.color = PALETTE.gatlingReady;
        this.gatlingSpinFill.style.background = PALETTE.gatlingReady;
      } else if (spin > 0.02) {
        this.gatlingSpinLabel.textContent = `SPINNING UP ${(spin * 100).toFixed(0)}%`;
        this.gatlingSpinLabel.style.color = PALETTE.gatlingAccent;
        this.gatlingSpinFill.style.background = PALETTE.gatlingAccent;
      } else {
        this.gatlingSpinLabel.textContent = 'ROTOR IDLE · 250MS SPIN';
        this.gatlingSpinLabel.style.color = PALETTE.uiDim;
        this.gatlingSpinFill.style.background = PALETTE.gatlingAccent;
      }
    }

    // --- Crosshair update ---
    const hitActive = this.hitCrossAt >= 0 && now - this.hitCrossAt <= HIT_CROSS_MS;
    const hitExpand = hitActive ? 5 * (1 - (now - this.hitCrossAt) / HIT_CROSS_MS) : 0;
    const crossCol = hitActive ? PALETTE.crosshairHit : PALETTE.crosshair;
    if (!isGatling) {
      const g = Math.min(22, 4 + s.spreadPx) + hitExpand;
      const [top, bottom, left, right] = this.crossLines;
      top.style.transform = `translateY(${-g - 3.5}px)`;
      bottom.style.transform = `translateY(${g + 3.5}px)`;
      left.style.transform = `translateX(${-g - 3.5}px)`;
      right.style.transform = `translateX(${g + 3.5}px)`;
      for (const l of this.crossLines) l.style.background = crossCol;
      this.crossDot.style.background = crossCol;
    } else {
      const spin = Math.max(0, Math.min(1, s.spinLevel ?? 0));
      const dia = Math.min(64, Math.max(36, 26 + s.spreadPx * 1.4 + hitExpand * 2));
      const half = dia * 0.5;
      this.crossGatlingRing.style.width = `${dia.toFixed(0)}px`;
      this.crossGatlingRing.style.height = `${dia.toFixed(0)}px`;
      this.crossGatlingRing.style.left = `${(-half).toFixed(0)}px`;
      this.crossGatlingRing.style.top = `${(-half).toFixed(0)}px`;
      const rotDeg = (now * 0.35 * (0.1 + spin)) % 360;
      this.crossGatlingRing.style.transform = `rotate(${rotDeg.toFixed(1)}deg)`;
      this.crossGatlingRing.style.filter = hitActive
        ? `drop-shadow(0 0 4px ${PALETTE.accent})`
        : 'none';
    }

    this.updateObjective(s.objective);

    const portrait = window.innerHeight > window.innerWidth;
    if (portrait !== this.lastPortrait) this.applyLayout();
    this.fpsEl.style.display = !portrait && this.fpsVisible ? '' : 'none';
    this.fpsEl.textContent = this.fpsVisible ? `${s.fps.toFixed(0)} FPS` : '';
    this.deadEl.style.display = s.dead && s.respawnIn > 0 ? 'block' : 'none';
    if (s.dead && s.respawnIn > 0) {
      this.deadEl.textContent = `ELIMINATED · RESPAWN ${Math.max(0, s.respawnIn).toFixed(1)}S`;
    }

    // --- Feedback decay ---
    const flash = this.hurtAt < 0 ? 0 : Math.max(0, 0.35 * (1 - (now - this.hurtAt) / HURT_MS));
    this.hurtEl.style.opacity = `${flash}`;
    this.fx.flashOpacity = flash;

    const arcO = this.arcAt < 0 ? 0 : Math.max(0, 0.9 * (1 - (now - this.arcAt) / ARC_MS));
    this.arcEl.style.opacity = `${arcO}`;
    if (arcO > 0) this.arcEl.style.transform = `translate(-50%,-50%) rotate(${this.arcAngle}rad)`;

    const killO = this.killAt < 0 ? 0 : Math.max(0, 1 - (now - this.killAt) / KILL_MS);
    this.killEl.style.opacity = `${killO}`;

    const pulse = lowHp ? PULSE_PEAK * (0.5 - 0.5 * Math.cos((now / PULSE_MS) * 2 * Math.PI)) : 0;
    this.lowHpEl.style.opacity = `${pulse}`;
    if (lowHp) this.fx.lowHpPulse++;
  }
}
