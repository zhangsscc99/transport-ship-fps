// VALORANT-inspired minimalist tactical DOM HUD — English uppercase + inline
// SVG line icons (1.5–2px stroke). Dedicated weapon UI branches:
//   - Rifle: 30-segment magazine bar + precision/burst recoil indicator + 4-line cross
//   - Gatling: distinct heavy amber HUD with 3×100-round segmented rows (300 total),
//     live 250ms spin-up gauge, vibration/wide-spread indicator & rotary ring reticle.
// All non-interactive overlays enforce pointer-events:none so drag/fire stay
// completely unobstructed in both 390×844 portrait and 844×390 landscape.

import { PALETTE } from './palette';
import type { WeaponId } from '../game/weapons';

export interface HudState {
  hp: number;
  maxHp: number;
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
}

export const HUD_FONT = `'DIN Alternate','Bahnschrift','Segoe UI',system-ui,-apple-system,sans-serif`;

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

const svgWrap = (inner: string, size: number): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
  `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
  `style="display:block;pointer-events:none;flex:0 0 auto;">${inner}</svg>`;

export const HUD_ICONS = {
  fire: (size = 26) =>
    svgWrap(
      `<circle cx="12" cy="12" r="6.5"/>` +
        `<line x1="12" y1="2.5" x2="12" y2="6.5"/>` +
        `<line x1="12" y1="17.5" x2="12" y2="21.5"/>` +
        `<line x1="2.5" y1="12" x2="6.5" y2="12"/>` +
        `<line x1="17.5" y1="12" x2="21.5" y2="12"/>` +
        `<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>`,
      size,
    ),
  reload: (size = 18) =>
    svgWrap(
      `<path d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2"/>` + `<polyline points="19.5 4.5 19.5 8.8 15.2 8.8"/>`,
      size,
    ),
  swap: (size = 18) =>
    svgWrap(
      `<polyline points="16 4 20 8 16 12"/>` +
        `<line x1="4" y1="8" x2="20" y2="8"/>` +
        `<polyline points="8 20 4 16 8 12"/>` +
        `<line x1="20" y1="16" x2="4" y2="16"/>`,
      size,
    ),
  crouch: (size = 17) =>
    svgWrap(
      `<circle cx="12.5" cy="5.5" r="2"/>` +
        `<path d="M9.5 10.5l3-1 3 2.5"/>` +
        `<path d="M12 9.5l-1.5 4.5 4 1.5-1 4"/>` +
        `<path d="M10.5 14l-3.5 1.5-1 4"/>`,
      size,
    ),
  jump: (size = 17) =>
    svgWrap(
      `<polyline points="7 11 12 6 17 11"/>` +
        `<line x1="12" y1="6.5" x2="12" y2="16.5"/>` +
        `<line x1="6.5" y1="19.5" x2="17.5" y2="19.5"/>`,
      size,
    ),
  soundOn: (size = 17) =>
    svgWrap(
      `<polygon points="4 9.5 8.5 9.5 13 5.5 13 18.5 8.5 14.5 4 14.5"/>` +
        `<path d="M16.2 9.2a4.2 4.2 0 0 1 0 5.6"/>` +
        `<path d="M18.8 6.8a7.4 7.4 0 0 1 0 10.4"/>`,
      size,
    ),
  soundOff: (size = 17) =>
    svgWrap(
      `<polygon points="4 9.5 8.5 9.5 13 5.5 13 18.5 8.5 14.5 4 14.5"/>` +
        `<line x1="16.5" y1="9.5" x2="21" y2="14.5"/>` +
        `<line x1="21" y1="9.5" x2="16.5" y2="14.5"/>`,
      size,
    ),
};

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
  0% { box-shadow: 0 0 0 0 rgba(255,70,85,0.72), inset 0 0 14px rgba(255,70,85,0.28); transform: scale(0.95); }
  100% { box-shadow: 0 0 0 14px rgba(255,70,85,0), inset 0 0 4px rgba(255,70,85,0.08); transform: scale(1); }
}
.val-lowhp-breathe { animation: valLowHpBreathe 1.2s ease-in-out infinite; }
.val-fire-pulse { animation: valFirePulse 160ms ease-out; }
`;
  document.head.appendChild(st);
}

/** Shared VALORANT icon+label button factory (used by HUD sound & touch controls). */
export function buildHudButton(opts: {
  id: string;
  label: string;
  iconSvg: string;
  posCss: string;
  size: number;
  circle?: boolean;
  danger?: boolean;
  zIndex?: number;
}): HTMLDivElement {
  ensureHudStyles();
  const { id, label, iconSvg, posCss, size, circle = false, danger = false, zIndex } = opts;
  const el = document.createElement('div');
  el.dataset.btn = id;
  const fg = danger ? PALETTE.accent : PALETTE.uiText;
  const border = danger ? `1.5px solid ${PALETTE.accent}` : `1px solid ${PALETTE.uiBorder}`;
  const labelSize = size >= 68 ? 9 : 7;
  const tracking = size >= 68 ? '0.12em' : '0.05em';
  el.style.cssText =
    `position:${zIndex !== undefined ? 'fixed' : 'absolute'};${posCss}` +
    `width:${size}px;height:${size}px;` +
    `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${size >= 68 ? 3 : 2}px;` +
    `border-radius:${circle ? '50%' : '10px'};` +
    `background:${PALETTE.uiPanel};border:${border};color:${fg};` +
    `font-family:${HUD_FONT};font-weight:700;letter-spacing:${tracking};text-transform:uppercase;` +
    `line-height:1;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;` +
    `box-sizing:border-box;cursor:pointer;` +
    (zIndex !== undefined ? `z-index:${zIndex};` : '');

  const iconBox = document.createElement('div');
  iconBox.dataset.role = 'icon';
  iconBox.style.cssText = 'display:flex;align-items:center;justify-content:center;pointer-events:none;';
  iconBox.innerHTML = iconSvg;

  const txt = document.createElement('span');
  txt.dataset.role = 'label';
  txt.textContent = label;
  txt.style.cssText = `font-size:${labelSize}px;opacity:${danger ? 0.95 : 0.78};pointer-events:none;`;

  el.append(iconBox, txt);
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
  private hpFill: HTMLDivElement;
  private hpNum: HTMLDivElement;
  private hpTag: HTMLDivElement;

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
  private hurtAt = -1;
  private arcAt = -1;
  private arcAngle = 0;
  private killAt = -1;
  private hitCrossAt = -1;
  private mutedFlag = false;
  private isLowHpState = false;
  private lastPortrait: boolean | null = null;

  /** counters/values for the e2e feedback hooks — persistent object */
  readonly fx = { hits: 0, kills: 0, flashOpacity: 0, lowHpPulse: 0 };
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

    // --- HP panel: bottom-left ---
    this.hpWrap = div(
      `position:absolute;left:${al(16)};bottom:${ab(18)};width:136px;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-left:2px solid ${PALETTE.uiText};border-radius:4px;padding:6px 10px 8px;` +
        `box-sizing:border-box;pointer-events:none;`,
      this.root,
      'hp',
    );
    const hpHeader = div(
      `display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px;pointer-events:none;`,
      this.hpWrap,
    );
    this.hpTag = div(
      `font-size:10px;font-weight:700;letter-spacing:0.16em;color:${PALETTE.uiDim};pointer-events:none;`,
      hpHeader,
    );
    this.hpTag.textContent = 'HP';
    this.hpNum = div(
      `font-size:22px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;` +
        `letter-spacing:0.02em;color:${PALETTE.uiText};pointer-events:none;`,
      hpHeader,
    );
    this.hpNum.textContent = '100';
    const hpTrack = div(
      `height:6px;border-radius:1px;background:${PALETTE.uiEmpty};overflow:hidden;pointer-events:none;`,
      this.hpWrap,
    );
    this.hpFill = div(
      `height:100%;width:100%;background:${PALETTE.hpFull};transition:width 60ms linear;pointer-events:none;`,
      hpTrack,
    );

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
      `display:none;flex-direction:column;gap:3px;margin-top:5px;width:176px;pointer-events:none;`,
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
      `font-size:8px;font-weight:800;letter-spacing:0.1em;color:${PALETTE.gatlingAccent};pointer-events:none;`,
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

    // Top-right toggleable FPS readout
    this.fpsEl = div(
      `position:absolute;right:${ar(62)};top:${at(26)};` +
        `font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;` +
        `color:${PALETTE.uiDim};pointer-events:none;`,
      this.root,
      'fps',
    );

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

    // --- Top-right SOUND icon ---
    this.muteBtn = document.createElement('div');
    this.muteBtn.dataset.btn = 'mute';
    this.muteBtn.style.cssText =
      `position:fixed;right:${ar(12)};top:${at(12)};width:44px;height:44px;` +
      `display:flex;align-items:center;justify-content:center;background:transparent;` +
      `pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;` +
      `box-sizing:border-box;cursor:pointer;z-index:30;`;
    this.muteBadge = document.createElement('div');
    this.muteBadge.dataset.role = 'icon';
    this.muteBadge.style.cssText =
      `width:40px;height:40px;display:flex;align-items:center;justify-content:center;` +
      `border-radius:8px;background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
      `color:${PALETTE.uiText};pointer-events:none;box-sizing:border-box;`;
    this.muteBadge.innerHTML = HUD_ICONS.soundOn(18);
    this.muteBtn.appendChild(this.muteBadge);
    parent.appendChild(this.muteBtn);
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

    this.hpWrap.style.left = al(16);
    this.hpWrap.style.bottom = ab(portrait ? 18 : 14);

    this.ammoWrap.style.right = ar(16);
    if (this.touchMode) {
      this.ammoWrap.style.bottom = ab(portrait ? 228 : 204);
    } else {
      this.ammoWrap.style.bottom = ab(16);
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
    this.muteBadge.innerHTML = m ? HUD_ICONS.soundOff(18) : HUD_ICONS.soundOn(18);
    this.muteBadge.style.borderColor = m ? PALETTE.accent : PALETTE.uiBorder;
    this.muteBadge.style.color = m ? PALETTE.accent : PALETTE.uiText;
  }

  setFpsVisible(v: boolean): void {
    this.fpsVisible = v;
  }

  update(s: HudState): void {
    const now = performance.now();
    const frac = Math.max(0, Math.min(1, s.hp / s.maxHp));
    const lowHp = frac <= 0.3 && !s.dead;

    this.hpFill.style.width = `${frac * 100}%`;
    this.hpFill.style.background = lowHp ? PALETTE.hpLow : frac > 0.55 ? PALETTE.hpFull : PALETTE.hpMid;
    this.hpNum.textContent = `${Math.ceil(s.hp)}`;
    this.hpNum.style.color = lowHp ? PALETTE.hpLow : PALETTE.uiText;
    this.hpWrap.style.borderLeftColor = lowHp ? PALETTE.hpLow : PALETTE.uiText;
    if (lowHp !== this.isLowHpState) {
      this.isLowHpState = lowHp;
      this.hpWrap.classList.toggle('val-lowhp-breathe', lowHp);
    }

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
