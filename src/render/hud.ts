// VALORANT-inspired minimalist tactical DOM HUD — English uppercase + inline
// SVG line icons (1.5–2px stroke), zero Chinese buttons, zero external icon
// deps. Palette: rgba(8,12,18,0.55) panel, 1px rgba(255,255,255,0.18) stroke,
// #ff4655 accent strictly for danger / fire / low-HP / hit confirmation.
// All non-interactive overlays enforce pointer-events:none so drag/fire stay
// completely unobstructed in both 390×844 portrait and 844×390 landscape.

import { PALETTE } from './palette';

export interface HudState {
  hp: number;
  maxHp: number;
  ammo: number;
  mag?: number;
  reloading: boolean;
  weaponName: string;
  /** crosshair gap radius in px — spread projected through the camera */
  spreadPx: number;
  fps: number;
  dead: boolean;
  /** seconds until respawn when dead */
  respawnIn: number;
}

export const HUD_FONT = `'DIN Alternate','Bahnschrift','Segoe UI',system-ui,-apple-system,sans-serif`;

const HURT_BG = `radial-gradient(ellipse 115% 90% at 50% 50%, transparent 55%, ${PALETTE.hurtVeil} 100%)`;

const HURT_MS = 120;
const ARC_MS = 600;
const KILL_MS = 700;
const HIT_CROSS_MS = 60;
const PULSE_MS = 1200;
const PULSE_PEAK = 0.25;
const MAX_MAG_SEGMENTS = 30;

// Inline SVG line icons (1.75px uniform stroke, round caps/joins, 24×24 grid).
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
  run: (size = 17) =>
    svgWrap(
      `<circle cx="15" cy="4.5" r="1.8"/>` +
        `<path d="M8.5 10l3.2-1.8 3.3 1.4 2.8-1.4"/>` +
        `<path d="M12.2 8.8l-1.7 5.2 3.8 2-1.3 4.2"/>` +
        `<path d="M10.5 14l-3.5 2.5-1.5 2.7"/>`,
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
  const labelSize = size >= 70 ? 9 : 6.8;
  const tracking = size >= 70 ? '0.12em' : '0.04em';
  el.style.cssText =
    `position:${zIndex !== undefined ? 'fixed' : 'absolute'};${posCss}` +
    `width:${size}px;height:${size}px;` +
    `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${size >= 70 ? 3 : 2}px;` +
    `border-radius:${circle ? '50%' : '6px'};` +
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
  private ammoText: HTMLDivElement;
  private ammoSub: HTMLDivElement;
  private ammoSegs: HTMLDivElement[] = [];
  private lastMag = -1;
  private crossLines: HTMLDivElement[] = [];
  private crossDot: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private deadEl: HTMLDivElement;
  private rotateEl: HTMLDivElement;
  private swapBlurEl: HTMLDivElement;
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
  private hitCrossAt = -1;
  private mutedFlag = false;
  private isLowHpState = false;

  /** counters/values for the e2e feedback hooks — persistent object */
  readonly fx = { hits: 0, kills: 0, flashOpacity: 0, lowHpPulse: 0 };
  /** wired by main.ts to the sfx bus */
  onMuteToggle: ((muted: boolean) => void) | null = null;

  constructor(parent: HTMLElement, _touchMode: boolean) {
    ensureHudStyles();
    this.root = div(
      `position:fixed;inset:0;z-index:5;pointer-events:none;font-family:${HUD_FONT};` +
        `color:${PALETTE.uiText};`,
      parent,
    );
    const ab = (px: number) => `calc(${px}px + env(safe-area-inset-bottom, 0px))`;
    const al = (px: number) => `calc(${px}px + env(safe-area-inset-left, 0px))`;
    const ar = (px: number) => `calc(${px}px + env(safe-area-inset-right, 0px))`;
    const at = (px: number) => `calc(${px}px + env(safe-area-inset-top, 0px))`;

    // Lower-screen subtle CSS blur veil (used during weapon swap — zero postprocessing)
    this.swapBlurEl = div(
      `position:absolute;left:0;right:0;bottom:0;height:36%;pointer-events:none;` +
        `opacity:0;display:none;` +
        `mask-image:linear-gradient(to top, rgba(0,0,0,0.9) 25%, rgba(0,0,0,0) 100%);` +
        `-webkit-mask-image:linear-gradient(to top, rgba(0,0,0,0.9) 25%, rgba(0,0,0,0) 100%);` +
        `backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);`,
      this.root,
      'swap-blur',
    );

    // --- HP panel: bottom-left (numeric + slim 6px bar, breathes red <30%) ---
    this.hpWrap = div(
      `position:absolute;left:${al(14)};bottom:${ab(14)};width:136px;` +
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

    // --- AMMO panel: bottom-right (32px numeral + uppercase weapon name + per-round bar) ---
    const ammoWrap = div(
      `position:absolute;right:${ar(14)};bottom:${ab(14)};min-width:146px;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-right:2px solid ${PALETTE.uiText};border-radius:4px;padding:5px 10px 7px;` +
        `text-align:right;box-sizing:border-box;pointer-events:none;`,
      this.root,
      'ammo',
    );
    const ammoTop = div(
      `display:flex;align-items:baseline;justify-content:flex-end;gap:6px;pointer-events:none;`,
      ammoWrap,
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
      ammoWrap,
    );
    this.ammoSub.textContent = 'ASSAULT RIFLE';
    const segRow = div(
      `display:flex;align-items:center;gap:2px;height:6px;width:126px;margin:6px 0 0 auto;pointer-events:none;`,
      ammoWrap,
      'ammo-bar',
    );
    for (let i = 0; i < MAX_MAG_SEGMENTS; i++) {
      const seg = div(
        `flex:1;height:100%;border-radius:1px;background:${PALETTE.uiText};pointer-events:none;`,
        segRow,
      );
      this.ammoSegs.push(seg);
    }

    // --- Crosshair: center (4 short lines + center dot; ≥24px clear zone around center) ---
    const cross = div(
      `position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;`,
      this.root,
      'cross',
    );
    const mkLine = (w: number, h: number): HTMLDivElement => {
      const el = div(
        `position:absolute;left:${-w / 2}px;top:${-h / 2}px;width:${w}px;height:${h}px;` +
          `background:${PALETTE.crosshair};box-shadow:0 0 0 1px ${PALETTE.crosshairEdge};pointer-events:none;`,
        cross,
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
      cross,
    );

    // FPS readout sits cleanly left of the top-right SOUND button (hidden on portrait)
    this.fpsEl = div(
      `position:absolute;right:${ar(66)};top:${at(26)};` +
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

    this.rotateEl = div(
      `position:absolute;left:50%;top:${at(18)};` +
        `transform:translateX(-50%);font-size:9px;font-weight:700;letter-spacing:0.14em;` +
        `text-transform:uppercase;color:${PALETTE.uiDim};` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-radius:4px;padding:4px 10px;display:none;pointer-events:none;white-space:nowrap;`,
      this.root,
      'rotate',
    );
    this.rotateEl.textContent = 'LANDSCAPE RECOMMENDED';

    // --- Feedback overlays (prebuilt, opacity animated only; zero per-frame alloc) ---
    this.hurtEl = div(`position:absolute;inset:0;background:${HURT_BG};opacity:0;pointer-events:none;`, this.root);
    this.hurtEl.dataset.fx = 'hurt';
    this.lowHpEl = div(`position:absolute;inset:0;background:${HURT_BG};opacity:0;pointer-events:none;`, this.root);
    this.lowHpEl.dataset.fx = 'lowhp';

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

    // --- Top-right SOUND icon button (44×44, fixed above touch UI) ---
    this.muteBtn = buildHudButton({
      id: 'mute',
      label: 'SOUND',
      iconSvg: HUD_ICONS.soundOn(17),
      posCss: `right:${ar(14)};top:${at(14)};`,
      size: 44,
      zIndex: 30,
    });
    parent.appendChild(this.muteBtn);
    this.muteBtn.addEventListener('click', () => {
      this.setMuted(!this.mutedFlag);
      this.onMuteToggle?.(this.mutedFlag);
    });
  }

  /** Damage feedback: edge flash + directional hit arc. */
  hitFrom(angleRad: number, now: number): void {
    this.hurtAt = now;
    this.arcAt = now;
    this.arcAngle = angleRad;
    this.fx.hits++;
  }

  /** Target hit confirmation: crosshair turns Valorant red and expands for 60ms. */
  notifyHit(now: number): void {
    this.hitCrossAt = now;
  }

  notifyKill(now: number): void {
    this.killAt = now;
    this.fx.kills++;
  }

  /** Subtle lower-screen CSS blur amount [0..1] during weapon swap transition. */
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

  setMuted(m: boolean): void {
    this.mutedFlag = m;
    const iconBox = this.muteBtn.querySelector('[data-role="icon"]');
    const labelEl = this.muteBtn.querySelector('[data-role="label"]');
    if (iconBox) iconBox.innerHTML = m ? HUD_ICONS.soundOff(17) : HUD_ICONS.soundOn(17);
    if (labelEl) labelEl.textContent = m ? 'MUTE' : 'SOUND';
    this.muteBtn.style.borderColor = m ? PALETTE.accent : PALETTE.uiBorder;
    this.muteBtn.style.color = m ? PALETTE.accent : PALETTE.uiText;
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

    // Ammo numeral + weapon label + per-round segmented bar
    const mag = Math.min(MAX_MAG_SEGMENTS, Math.max(1, s.mag ?? 30));
    const lowAmmo = s.ammo <= Math.max(1, Math.ceil(mag * 0.2));
    this.ammoText.textContent = `${s.ammo}`;
    this.ammoText.style.color = s.reloading || lowAmmo ? PALETTE.accent : PALETTE.uiText;
    this.ammoSub.textContent = s.reloading ? 'RELOADING' : s.weaponName;
    this.ammoSub.style.color = s.reloading ? PALETTE.accent : PALETTE.uiDim;

    if (mag !== this.lastMag) {
      this.lastMag = mag;
      for (let i = 0; i < MAX_MAG_SEGMENTS; i++) {
        this.ammoSegs[i].style.display = i < mag ? 'block' : 'none';
      }
    }
    const litColor = lowAmmo ? PALETTE.accent : PALETTE.uiText;
    const emptyColor = s.ammo === 0 ? 'rgba(255,255,255,0.09)' : PALETTE.uiEmpty;
    for (let i = 0; i < mag; i++) {
      const lit = i < s.ammo;
      this.ammoSegs[i].style.background = lit ? litColor : emptyColor;
      this.ammoSegs[i].dataset.lit = lit ? '1' : '0';
    }

    // Crosshair: 4 short lines + dot, hit confirms in red + expands 60ms
    const hitActive = this.hitCrossAt >= 0 && now - this.hitCrossAt <= HIT_CROSS_MS;
    const hitExpand = hitActive ? 5 * (1 - (now - this.hitCrossAt) / HIT_CROSS_MS) : 0;
    const g = Math.min(22, 4 + s.spreadPx) + hitExpand;
    const crossCol = hitActive ? PALETTE.crosshairHit : PALETTE.crosshair;
    const [top, bottom, left, right] = this.crossLines;
    top.style.transform = `translateY(${-g - 3.5}px)`;
    bottom.style.transform = `translateY(${g + 3.5}px)`;
    left.style.transform = `translateX(${-g - 3.5}px)`;
    right.style.transform = `translateX(${g + 3.5}px)`;
    for (const l of this.crossLines) l.style.background = crossCol;
    this.crossDot.style.background = crossCol;

    // Portrait hides FPS readout so controls have breathing room
    const portrait = window.innerHeight > window.innerWidth;
    this.fpsEl.style.display = portrait ? 'none' : '';
    this.fpsEl.textContent = this.fpsVisible ? `${s.fps.toFixed(0)} FPS` : '';
    this.deadEl.style.display = s.dead ? 'block' : 'none';
    if (s.dead) this.deadEl.textContent = `ELIMINATED · RESPAWN ${Math.max(0, s.respawnIn).toFixed(1)}S`;
    this.rotateEl.style.display = portrait ? 'block' : 'none';

    // --- Feedback decay (opacity animated only) ---
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
