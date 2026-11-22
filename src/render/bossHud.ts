// Tactical Boss HUD (top-centered segmented health bar + floating damage numbers).
// Pure DOM + CSS (zero canvas/WebGL draw calls, pointer-events: none) matching the
// existing VALORANT / cyberpunk-maritime glass HUD language of hud.ts & enemyTags.ts.

export interface BossHudOptions {
  /** Boss display title shown on the header row. Defaults to 「变异体 · 原型体」. */
  title?: string;
}

export interface ScreenProjection {
  x: number;
  y: number;
  visible: boolean;
}

export type DamageKind = 'body' | 'weak';

export const BOSS_HUD_DEFAULT_TITLE = '变异体 · 原型体';
export const BOSS_HUD_SEGMENTS = 10;
export const BOSS_HUD_MAX_DAMAGE = 12;
export const BOSS_HUD_GHOST_HOLD_MS = 65;
export const BOSS_HUD_GHOST_DURATION_MS = 350;
export const BOSS_HUD_DAMAGE_DURATION_MS = 800;
export const BOSS_HUD_DMG_BODY_FONT_PX = 12;
export const BOSS_HUD_DMG_WEAK_SCALE = 1.4;

export const BOSS_HP_COLORS = {
  high: '#38E0E8',
  mid: '#FFB454',
  low: '#FF4D4D',
  phase2: '#B81D2E',
  dmgBody: '#FFFFFF',
  dmgWeak: '#FFC857',
} as const;

const TITLE_FONT =
  `'DIN Alternate','Bahnschrift','Segoe UI','PingFang SC','Microsoft YaHei','Noto Sans SC',system-ui,-apple-system,sans-serif`;
const MONO_FONT =
  `ui-monospace,'SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace`;
const STYLE_ID = 'boss-hud-styles';

// Small deterministic scatter around the hit coordinate so burst hits remain legible
// while the first hit lands directly on the exact projected screen point.
const DMG_SCATTER_X = [0, -14, 14, -7, 10, -18, 17, -4, 7, -12, 15, -9] as const;
const DMG_SCATTER_Y = [0, -4, 3, -7, 2, -2, -6, 4, -5, 1, -8, 3] as const;

/** Compute clamped HP width percentage [0..100] with up to 2 decimal places. */
export function hpWidthPct(cur: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(cur)) return 0;
  const clamped = Math.max(0, Math.min(max, cur));
  const raw = (clamped / max) * 100;
  return Math.max(0, Math.min(100, Math.round(raw * 100) / 100));
}

/** Format percentage number as CSS width string (e.g., 50 -> "50%", 33.33 -> "33.33%"). */
export function formatHpWidth(pct: number): string {
  const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return `${Number(safe.toFixed(2))}%`;
}

/** Resolve fill color by HP percentage (>60% cyan, 30–60% yellow, <30% red) and boss phase. */
export function hpColor(pct: number, phase: 1 | 2 = 1): string {
  if (phase === 2) return BOSS_HP_COLORS.phase2;
  if (pct > 60) return BOSS_HP_COLORS.high;
  if (pct >= 30) return BOSS_HP_COLORS.mid;
  return BOSS_HP_COLORS.low;
}

/** Format integer HP readout as "128000 / 128000". */
export function formatHpReadout(cur: number, max: number): {
  curText: string;
  maxText: string;
  fullText: string;
} {
  const safeMax = Number.isFinite(max) && max > 0 ? Math.round(max) : 0;
  const safeCur = Number.isFinite(cur)
    ? Math.max(0, Math.min(safeMax, Math.ceil(cur)))
    : 0;
  const curText = String(safeCur);
  const maxText = String(safeMax);
  return { curText, maxText, fullText: `${curText} / ${maxText}` };
}

function ensureBossHudStyles(doc: Document): void {
  if (doc.getElementById?.(STYLE_ID)) return;
  const head = doc.head ?? doc.documentElement;
  if (!head) return;
  const st = doc.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
@keyframes bossHudPhase2Pulse {
  0%, 100% {
    box-shadow:
      inset 0 0 6px rgba(255, 72, 92, 0.34),
      inset 0 1px 2px rgba(0, 0, 0, 0.65),
      0 0 8px rgba(210, 32, 52, 0.48),
      0 0 18px rgba(184, 29, 46, 0.24);
  }
  50% {
    box-shadow:
      inset 0 0 10px rgba(255, 108, 122, 0.56),
      inset 0 1px 2px rgba(0, 0, 0, 0.55),
      0 0 16px rgba(235, 42, 64, 0.88),
      0 0 30px rgba(184, 29, 46, 0.54);
  }
}
@keyframes bossHudPhase2Emblem {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(255, 68, 88, 0.85); }
  50% { opacity: 0.55; box-shadow: 0 0 12px rgba(255, 68, 88, 1); }
}
@keyframes bossHudPhase2Sheen {
  0% { background-position: 0 0, 0 0; }
  100% { background-position: 0 0, 48px 0; }
}
@keyframes bossHudDmgBody {
  0% {
    opacity: 0.96;
    transform: translate(-50%, -50%) scale(1.12);
  }
  16% {
    opacity: 1;
    transform: translate(-50%, calc(-50% - 8px)) scale(1);
  }
  68% {
    opacity: 0.92;
    transform: translate(-50%, calc(-50% - 29px)) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, calc(-50% - 40px)) scale(0.94);
  }
}
@keyframes bossHudDmgWeak {
  0% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.24);
  }
  18% {
    opacity: 1;
    transform: translate(-50%, calc(-50% - 10px)) scale(1.03);
  }
  70% {
    opacity: 0.95;
    transform: translate(-50%, calc(-50% - 31px)) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, calc(-50% - 40px)) scale(0.96);
  }
}
.boss-hud-panel {
  position: relative;
  padding: 7px 12px 9px;
  border-radius: 4px;
  background: linear-gradient(180deg, rgba(6, 10, 16, 0.74) 0%, rgba(6, 10, 16, 0.48) 100%);
  border: 1px solid rgba(120, 255, 255, 0.16);
  border-top: 1px solid rgba(120, 255, 255, 0.34);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-sizing: border-box;
  transition: border-color 220ms ease, box-shadow 220ms ease;
}
.boss-hud-panel::before,
.boss-hud-panel::after {
  content: '';
  position: absolute;
  top: -1px;
  width: 9px;
  height: 9px;
  border-top: 1.5px solid rgba(120, 255, 255, 0.68);
  pointer-events: none;
  transition: border-color 220ms ease;
}
.boss-hud-panel::before {
  left: -1px;
  border-left: 1.5px solid rgba(120, 255, 255, 0.68);
  border-top-left-radius: 3px;
}
.boss-hud-panel::after {
  right: -1px;
  border-right: 1.5px solid rgba(120, 255, 255, 0.68);
  border-top-right-radius: 3px;
}
.boss-hud-panel.boss-hud-phase2 {
  border-color: rgba(255, 72, 92, 0.28);
  border-top-color: rgba(255, 72, 92, 0.66);
  box-shadow: 0 6px 24px rgba(48, 4, 12, 0.58), inset 0 1px 0 rgba(255, 110, 124, 0.14);
}
.boss-hud-panel.boss-hud-phase2::before,
.boss-hud-panel.boss-hud-phase2::after {
  border-color: rgba(255, 77, 94, 0.9);
}
.boss-hud-bar-track {
  position: relative;
  width: 100%;
  height: 10px;
  border-radius: 3px;
  background: rgba(6, 10, 14, 0.62);
  border: 1px solid rgba(120, 255, 255, 0.28);
  box-shadow: inset 0 0 6px rgba(120, 255, 255, 0.28), inset 0 1px 2px rgba(0, 0, 0, 0.65);
  overflow: hidden;
  box-sizing: border-box;
  transition: border-color 220ms ease;
}
.boss-hud-bar-track.boss-hud-phase2-pulse {
  border-color: rgba(255, 72, 92, 0.72);
  animation: bossHudPhase2Pulse 1.6s ease-in-out infinite;
}
.boss-hud-hp-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 100%;
  background-color: ${BOSS_HP_COLORS.high};
  background-image: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.28) 0%,
    rgba(255, 255, 255, 0.05) 48%,
    rgba(0, 0, 0, 0.22) 100%
  );
  transition: width 70ms ease-out, background-color 220ms ease;
  z-index: 2;
}
.boss-hud-hp-fill::after {
  content: '';
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.65);
  opacity: 0.9;
}
.boss-hud-hp-fill[data-edge="0"]::after {
  opacity: 0;
}
.boss-hud-hp-fill.boss-hud-fill-phase2 {
  background-image:
    linear-gradient(
      180deg,
      rgba(255, 190, 196, 0.26) 0%,
      rgba(255, 255, 255, 0.03) 48%,
      rgba(28, 0, 6, 0.34) 100%
    ),
    repeating-linear-gradient(
      -55deg,
      rgba(255, 110, 124, 0.14) 0px,
      rgba(255, 110, 124, 0.14) 6px,
      transparent 6px,
      transparent 16px
    );
  background-size: 100% 100%, 48px 100%;
  animation: bossHudPhase2Sheen 1.6s linear infinite;
}
.boss-hud-emblem-phase2 {
  animation: bossHudPhase2Emblem 1.6s ease-in-out infinite;
}
.boss-hud-dmg-num {
  position: absolute;
  left: 0;
  top: 0;
  font-family: ${MONO_FONT};
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
  will-change: transform, opacity;
  user-select: none;
  -webkit-user-select: none;
}
`;
  head.appendChild(st);
}

interface DamageNodeEntry {
  el: HTMLDivElement;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BossHud {
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly emblemEl: HTMLSpanElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly phaseBadgeEl: HTMLSpanElement;
  private readonly hpReadoutEl: HTMLDivElement;
  private readonly hpCurSpan: HTMLSpanElement;
  private readonly hpMaxSpan: HTMLSpanElement;
  private readonly barTrack: HTMLDivElement;
  private readonly ghostFill: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly dmgLayer: HTMLDivElement;

  private phase: 1 | 2 = 1;
  private lastPct = 100;
  private lastHp = Number.NaN;
  private lastHpMax = Number.NaN;
  private ghostPct = 100;
  private initialized = false;
  private disposed = false;
  private ghostTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDmg: DamageNodeEntry[] = [];
  private dmgSeq = 0;

  constructor(parent: HTMLElement, opts?: BossHudOptions) {
    this.doc = parent.ownerDocument ?? document;
    ensureBossHudStyles(this.doc);

    const title = opts?.title?.trim() || BOSS_HUD_DEFAULT_TITLE;

    this.root = this.doc.createElement('div');
    this.root.dataset.hud = 'boss-hud';
    this.root.dataset.phase = '1';
    this.root.dataset.visible = '1';
    this.root.style.cssText =
      `position:fixed;inset:0;z-index:12;pointer-events:none;overflow:hidden;` +
      `user-select:none;-webkit-user-select:none;`;

    // Floating damage numbers layer (full viewport, beneath the bar panel)
    this.dmgLayer = this.doc.createElement('div');
    this.dmgLayer.dataset.role = 'boss-dmg-layer';
    this.dmgLayer.style.cssText =
      `position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1;`;
    this.root.appendChild(this.dmgLayer);

    // Top-centered Boss bar container
    const barWrap = this.doc.createElement('div');
    barWrap.dataset.role = 'boss-bar-wrap';
    barWrap.style.cssText =
      `position:absolute;left:50%;top:calc(env(safe-area-inset-top, 0px) + 14px);` +
      `transform:translateX(-50%);width:min(640px, 78vw);` +
      `pointer-events:none;box-sizing:border-box;z-index:2;`;
    this.root.appendChild(barWrap);

    this.panel = this.doc.createElement('div');
    this.panel.className = 'boss-hud-panel';
    this.panel.dataset.role = 'boss-panel';
    this.panel.style.cssText = `pointer-events:none;`;
    barWrap.appendChild(this.panel);

    // Header row: emblem + title + phase tag (left) | tabular HP numbers (right)
    const header = this.doc.createElement('div');
    header.dataset.role = 'boss-header';
    header.style.cssText =
      `display:flex;align-items:center;justify-content:space-between;gap:8px;` +
      `margin-bottom:5px;pointer-events:none;min-width:0;`;
    this.panel.appendChild(header);

    const leftCluster = this.doc.createElement('div');
    leftCluster.style.cssText =
      `display:flex;align-items:center;gap:6px;min-width:0;pointer-events:none;`;
    header.appendChild(leftCluster);

    this.emblemEl = this.doc.createElement('span');
    this.emblemEl.dataset.role = 'boss-emblem';
    this.emblemEl.style.cssText =
      `display:inline-block;width:6px;height:6px;flex:0 0 auto;transform:rotate(45deg);` +
      `background:${BOSS_HP_COLORS.high};box-shadow:0 0 6px rgba(56,224,232,0.75);` +
      `border-radius:1px;pointer-events:none;`;
    leftCluster.appendChild(this.emblemEl);

    this.titleEl = this.doc.createElement('span');
    this.titleEl.dataset.role = 'boss-title';
    this.titleEl.textContent = title;
    this.titleEl.style.cssText =
      `font-family:${TITLE_FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;` +
      `line-height:1.2;color:rgba(220,236,240,0.82);` +
      `text-shadow:0 1px 3px rgba(0,0,0,0.85);` +
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;`;
    leftCluster.appendChild(this.titleEl);

    this.phaseBadgeEl = this.doc.createElement('span');
    this.phaseBadgeEl.dataset.role = 'boss-phase';
    this.phaseBadgeEl.textContent = 'PHASE I';
    this.phaseBadgeEl.style.cssText =
      `flex:0 0 auto;font-family:${MONO_FONT};font-size:8.5px;font-weight:700;` +
      `letter-spacing:0.1em;line-height:1;padding:2px 5px;border-radius:2px;` +
      `color:rgba(168,238,244,0.84);background:rgba(56,224,232,0.10);` +
      `border:1px solid rgba(120,255,255,0.28);pointer-events:none;`;
    leftCluster.appendChild(this.phaseBadgeEl);

    this.hpReadoutEl = this.doc.createElement('div');
    this.hpReadoutEl.dataset.role = 'boss-hp-text';
    this.hpReadoutEl.style.cssText =
      `flex:0 0 auto;font-family:${MONO_FONT};font-size:10px;font-weight:600;` +
      `letter-spacing:0.04em;line-height:1.1;font-variant-numeric:tabular-nums;` +
      `white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,0.9);pointer-events:none;`;
    header.appendChild(this.hpReadoutEl);

    this.hpCurSpan = this.doc.createElement('span');
    this.hpCurSpan.dataset.role = 'boss-hp-cur';
    this.hpCurSpan.style.cssText = `color:rgba(236,248,252,0.95);pointer-events:none;`;
    this.hpCurSpan.textContent = '128000';

    this.hpMaxSpan = this.doc.createElement('span');
    this.hpMaxSpan.dataset.role = 'boss-hp-max';
    this.hpMaxSpan.style.cssText = `color:rgba(196,218,228,0.56);pointer-events:none;`;
    this.hpMaxSpan.textContent = ' / 128000';

    this.hpReadoutEl.append(this.hpCurSpan, this.hpMaxSpan);

    // 10px segmented HP bar track
    this.barTrack = this.doc.createElement('div');
    this.barTrack.className = 'boss-hud-bar-track';
    this.barTrack.dataset.role = 'boss-bar-track';
    this.barTrack.style.cssText =
      `height:10px;border-radius:3px;background:rgba(6,10,14,0.62);` +
      `border:1px solid rgba(120,255,255,0.28);pointer-events:none;`;
    this.panel.appendChild(this.barTrack);

    // Damage trail ghost bar (0.35s white delayed catch-up)
    this.ghostFill = this.doc.createElement('div');
    this.ghostFill.dataset.role = 'boss-hp-ghost';
    this.ghostFill.style.cssText =
      `position:absolute;left:0;top:0;bottom:0;width:100%;` +
      `background:rgba(255,255,255,0.92);box-shadow:0 0 6px rgba(255,255,255,0.45);` +
      `transition:width ${BOSS_HUD_GHOST_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1);` +
      `z-index:1;pointer-events:none;`;
    this.barTrack.appendChild(this.ghostFill);

    // Primary colored HP fill
    this.hpFill = this.doc.createElement('div');
    this.hpFill.className = 'boss-hud-hp-fill';
    this.hpFill.dataset.role = 'boss-hp-fill';
    this.hpFill.dataset.color = BOSS_HP_COLORS.high;
    this.hpFill.dataset.edge = '0';
    this.hpFill.style.width = '100%';
    this.hpFill.style.backgroundColor = BOSS_HP_COLORS.high;
    this.barTrack.appendChild(this.hpFill);

    // 10-segment scale overlay (1px dark divider at every 10%)
    const ticksWrap = this.doc.createElement('div');
    ticksWrap.dataset.role = 'boss-hp-ticks';
    ticksWrap.style.cssText =
      `position:absolute;inset:0;display:flex;z-index:3;pointer-events:none;`;
    for (let i = 0; i < BOSS_HUD_SEGMENTS; i++) {
      const tick = this.doc.createElement('div');
      tick.dataset.role = 'hp-tick';
      tick.dataset.index = String(i);
      const isLast = i === BOSS_HUD_SEGMENTS - 1;
      const isMid = i === 4; // 50% landmark
      tick.style.cssText =
        `flex:1;height:100%;box-sizing:border-box;pointer-events:none;` +
        (isLast
          ? ''
          : `border-right:1px solid ${isMid ? 'rgba(4,8,12,0.92)' : 'rgba(4,8,12,0.74)'};`);
      ticksWrap.appendChild(tick);
    }
    this.barTrack.appendChild(ticksWrap);

    parent.appendChild(this.root);
  }

  /** Update Boss HP segmented fill, delayed white damage ghost bar, and numeric readout. */
  setHp(hp: number, hpMax: number): void {
    if (this.disposed) return;
    if (this.initialized && hp === this.lastHp && hpMax === this.lastHpMax) return;
    this.lastHp = hp;
    this.lastHpMax = hpMax;

    const pct = hpWidthPct(hp, hpMax);
    const widthStr = formatHpWidth(pct);
    const color = hpColor(pct, this.phase);
    const { curText, maxText } = formatHpReadout(hp, hpMax);

    this.hpCurSpan.textContent = curText;
    this.hpMaxSpan.textContent = ` / ${maxText}`;

    this.hpFill.style.width = widthStr;
    this.hpFill.style.backgroundColor = color;
    this.hpFill.dataset.color = color;
    this.hpFill.dataset.pct = String(pct);
    this.hpFill.dataset.edge = pct > 0 && pct < 100 ? '1' : '0';

    if (this.phase === 1) {
      this.emblemEl.style.background = color;
      this.emblemEl.style.boxShadow = `0 0 6px ${color}`;
    }

    if (!this.initialized || pct > this.ghostPct) {
      // First update or HP increased/reset: snap ghost directly without lag
      if (this.ghostTimer !== null) {
        clearTimeout(this.ghostTimer);
        this.ghostTimer = null;
      }
      this.ghostPct = pct;
      this.ghostFill.style.transition = 'none';
      this.ghostFill.style.width = widthStr;
    } else if (pct < this.lastPct) {
      // HP dropped: hold briefly so burst damage reads crisply, then sweep down over 0.35s
      if (this.ghostTimer !== null) {
        clearTimeout(this.ghostTimer);
      }
      const targetPct = pct;
      const targetWidth = widthStr;
      this.ghostTimer = setTimeout(() => {
        this.ghostTimer = null;
        if (this.disposed) return;
        this.ghostPct = targetPct;
        this.ghostFill.style.transition = `width ${BOSS_HUD_GHOST_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
        this.ghostFill.style.width = targetWidth;
      }, BOSS_HUD_GHOST_HOLD_MS);
    }

    this.lastPct = pct;
    this.initialized = true;
  }

  /** Switch Boss phase (1: cyan/yellow/red thresholds; 2: dark crimson + 1.6s outer glow pulse). */
  setPhase(phase: 1 | 2): void {
    if (this.disposed) return;
    this.phase = phase;
    const isP2 = phase === 2;
    this.root.dataset.phase = String(phase);

    const color = hpColor(this.lastPct, phase);
    this.hpFill.style.backgroundColor = color;
    this.hpFill.dataset.color = color;

    this.panel.classList.toggle('boss-hud-phase2', isP2);
    this.barTrack.classList.toggle('boss-hud-phase2-pulse', isP2);
    this.hpFill.classList.toggle('boss-hud-fill-phase2', isP2);
    this.emblemEl.classList.toggle('boss-hud-emblem-phase2', isP2);

    this.barTrack.style.borderColor = isP2
      ? 'rgba(255, 72, 92, 0.72)'
      : 'rgba(120, 255, 255, 0.28)';

    this.emblemEl.style.background = isP2 ? '#FF4D5E' : color;
    this.emblemEl.style.boxShadow = isP2
      ? '0 0 8px rgba(255, 68, 88, 0.9)'
      : `0 0 6px ${color}`;

    if (isP2) {
      this.phaseBadgeEl.textContent = 'PHASE II';
      this.phaseBadgeEl.style.color = '#FFD6DA';
      this.phaseBadgeEl.style.background = 'rgba(184, 29, 46, 0.38)';
      this.phaseBadgeEl.style.borderColor = 'rgba(255, 77, 94, 0.72)';
    } else {
      this.phaseBadgeEl.textContent = 'PHASE I';
      this.phaseBadgeEl.style.color = 'rgba(168, 238, 244, 0.84)';
      this.phaseBadgeEl.style.background = 'rgba(56, 224, 232, 0.10)';
      this.phaseBadgeEl.style.borderColor = 'rgba(120, 255, 255, 0.28)';
    }
  }

  /** Show or hide the Boss HUD overlay. */
  setVisible(v: boolean): void {
    if (this.disposed) return;
    this.root.style.display = v ? '' : 'none';
    this.root.dataset.visible = v ? '1' : '0';
  }

  /**
   * Spawn a floating damage number at the projected screen position.
   * Caps simultaneous nodes at 12 (reusing the oldest node when exceeded),
   * floats up 40px and fades out over 0.8s before removing itself from DOM.
   */
  showDamage(
    worldToScreen: () => ScreenProjection,
    amount: number,
    kind: DamageKind,
  ): void {
    if (this.disposed) return;
    const pos = worldToScreen();
    if (!pos || !pos.visible || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      return;
    }

    const idx = this.dmgSeq % DMG_SCATTER_X.length;
    this.dmgSeq++;
    const x = pos.x + DMG_SCATTER_X[idx];
    const y = pos.y + DMG_SCATTER_Y[idx];

    let entry: DamageNodeEntry;
    if (this.activeDmg.length >= BOSS_HUD_MAX_DAMAGE) {
      entry = this.activeDmg.shift()!;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    } else {
      const el = this.doc.createElement('div');
      el.className = 'boss-hud-dmg-num';
      el.dataset.role = 'boss-dmg';
      this.dmgLayer.appendChild(el);
      entry = { el, timer: null };
    }

    const el = entry.el;
    const isWeak = kind === 'weak';
    const fontPx = isWeak
      ? Number((BOSS_HUD_DMG_BODY_FONT_PX * BOSS_HUD_DMG_WEAK_SCALE).toFixed(1))
      : BOSS_HUD_DMG_BODY_FONT_PX;
    const displayNum = Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;

    el.dataset.kind = kind;
    el.textContent = String(displayNum);
    el.style.left = `${Number(x.toFixed(1))}px`;
    el.style.top = `${Number(y.toFixed(1))}px`;
    el.style.fontSize = `${fontPx}px`;
    el.style.fontWeight = isWeak ? '800' : '700';
    el.style.color = isWeak ? BOSS_HP_COLORS.dmgWeak : BOSS_HP_COLORS.dmgBody;
    el.style.textShadow = isWeak
      ? '0 1px 3px rgba(0, 0, 0, 0.96), 0 -1px 2px rgba(0, 0, 0, 0.7), 0 0 11px rgba(255, 200, 87, 0.68)'
      : '0 1px 3px rgba(0, 0, 0, 0.96), 0 -1px 2px rgba(0, 0, 0, 0.68), 0 0 4px rgba(0, 0, 0, 0.72)';

    // Restart CSS float+fade animation cleanly when reusing an active node
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = `${isWeak ? 'bossHudDmgWeak' : 'bossHudDmgBody'} ${BOSS_HUD_DAMAGE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`;

    entry.timer = setTimeout(() => {
      entry.timer = null;
      const posIdx = this.activeDmg.indexOf(entry);
      if (posIdx !== -1) this.activeDmg.splice(posIdx, 1);
      entry.el.remove();
    }, BOSS_HUD_DAMAGE_DURATION_MS);

    this.activeDmg.push(entry);
  }

  /** Tear down all timers and remove the Boss HUD container from the DOM. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ghostTimer !== null) {
      clearTimeout(this.ghostTimer);
      this.ghostTimer = null;
    }
    for (const entry of this.activeDmg) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.el.remove();
    }
    this.activeDmg.length = 0;
    this.root.remove();
  }
}
