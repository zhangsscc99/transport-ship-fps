// Start menu / settings / result panel — DOM overlay (F110).
// Palette-only colors (ART-SPEC §1). The hidden state uses
// visibility:hidden + pointer-events:none (never display:none), so
// [data-btn] hit rects stay measurable for e2e and no in-game touch is
// swallowed while the menu is down.
// Persisted to localStorage: tsf.difficulty / tsf.sensitivity / tsf.muted.

import { PALETTE } from './palette';
import type { Winner } from '../game/match';

export type Difficulty = 'recruit' | 'veteran' | 'elite';

export interface MenuSettings {
  difficulty: Difficulty;
  /** look sensitivity in °/px — SPEC default 0.35 */
  sensitivity: number;
  muted: boolean;
}

export interface MenuResult {
  winner: Winner;
  killsA: number;
  killsB: number;
}

const FONT = `system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif`;
const LS = {
  difficulty: 'tsf.difficulty',
  sensitivity: 'tsf.sensitivity',
  muted: 'tsf.muted',
} as const;

const DIFFS: { id: Difficulty; label: string }[] = [
  { id: 'recruit', label: '简单' },
  { id: 'veteran', label: '普通' },
  { id: 'elite', label: '困难' },
];
const DIFF_SET = new Set<string>(DIFFS.map((d) => d.id));

const css = (el: HTMLElement, style: string): void => {
  el.style.cssText = style;
};

function div(style: string, parent: HTMLElement, text = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = style;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function loadSettings(): MenuSettings {
  const s: MenuSettings = { difficulty: 'veteran', sensitivity: 0.35, muted: false };
  try {
    const d = localStorage.getItem(LS.difficulty);
    if (d && DIFF_SET.has(d)) s.difficulty = d as Difficulty;
    const v = parseFloat(localStorage.getItem(LS.sensitivity) ?? '');
    if (Number.isFinite(v)) s.sensitivity = Math.min(0.8, Math.max(0.1, v));
    s.muted = localStorage.getItem(LS.muted) === '1';
  } catch {
    /* storage unavailable — defaults are fine */
  }
  return s;
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export class Menu {
  readonly settings: MenuSettings;
  private panel: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private resultEl: HTMLDivElement;
  private resultTitle: HTMLDivElement;
  private resultScore: HTMLDivElement;
  private primary: HTMLDivElement;
  private diffEls = new Map<Difficulty, HTMLDivElement>();
  private muteKnob: HTMLDivElement;
  private mutePill: HTMLDivElement;
  private sensValue: HTMLDivElement;
  private onStart: (s: MenuSettings) => void;

  constructor(parent: HTMLElement, opts: { onStart: (s: MenuSettings) => void }) {
    this.onStart = opts.onStart;
    this.settings = loadSettings();

    const root = div(
      `position:fixed;inset:0;z-index:20;pointer-events:none;font-family:${FONT};` +
        `color:${PALETTE.uiText};`,
      parent,
    );

    // big countdown numeral — separate from the panel so it can show while
    // the menu itself is hidden; never intercepts touches
    this.countdownEl = div(
      `position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);` +
        `font-size:96px;font-weight:800;color:${PALETTE.accent};` +
        `text-shadow:0 0 18px ${PALETTE.crosshairEdge};visibility:hidden;`,
      root,
    );

    this.panel = div(
      `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
        `width:min(340px,88vw);box-sizing:border-box;` +
        `background:${PALETTE.uiPanel};border:1px solid ${PALETTE.uiBorder};` +
        `border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;` +
        `pointer-events:auto;visibility:hidden;touch-action:none;` +
        `user-select:none;-webkit-user-select:none;`,
      root,
    );

    div(
      `font-size:30px;font-weight:800;letter-spacing:6px;text-align:center;`,
      this.panel,
      '运输船',
    );
    div(
      `font-size:11px;color:${PALETTE.uiDim};text-align:center;margin-top:-8px;`,
      this.panel,
      '团队竞技 · 先达 25 杀或 5 分钟判胜',
    );

    // result block — populated by showResult(), hidden in start mode
    this.resultEl = div(`display:none;flex-direction:column;gap:4px;`, this.panel);
    this.resultEl.style.display = 'none';
    this.resultTitle = div(
      `font-size:22px;font-weight:700;text-align:center;`,
      this.resultEl,
    );
    this.resultScore = div(
      `font-size:15px;color:${PALETTE.uiText};text-align:center;`,
      this.resultEl,
    );
    div(
      `height:1px;background:${PALETTE.uiBorder};margin:4px 0;`,
      this.resultEl,
    );

    // difficulty — single-select row, each option ≥44px tall
    div(`font-size:12px;color:${PALETTE.uiDim};`, this.panel, '难度');
    const diffRow = div(`display:flex;gap:8px;`, this.panel);
    for (const d of DIFFS) {
      const el = div(
        `flex:1;height:44px;display:flex;align-items:center;justify-content:center;` +
          `border:2px solid ${PALETTE.uiBorder};border-radius:8px;font-size:14px;` +
          `cursor:pointer;touch-action:none;`,
        diffRow,
        d.label,
      );
      el.dataset.diff = d.id;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.settings.difficulty = d.id;
        save(LS.difficulty, d.id);
        this.paintDifficulty();
      });
      this.diffEls.set(d.id, el);
    }
    this.paintDifficulty();

    // sensitivity — label + range + live value, row ≥44px
    const sensRow = div(
      `display:flex;align-items:center;gap:10px;min-height:44px;`,
      this.panel,
    );
    div(`font-size:12px;color:${PALETTE.uiDim};flex:0 0 auto;`, sensRow, '灵敏度');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.1';
    slider.max = '0.8';
    slider.step = '0.05';
    slider.value = String(this.settings.sensitivity);
    css(
      slider,
      `flex:1;height:44px;margin:0;accent-color:${PALETTE.accent};touch-action:none;`,
    );
    sensRow.appendChild(slider);
    this.sensValue = div(
      `font-size:12px;color:${PALETTE.uiText};width:34px;text-align:right;flex:0 0 auto;`,
      sensRow,
      this.settings.sensitivity.toFixed(2),
    );
    slider.addEventListener('input', () => {
      this.settings.sensitivity = parseFloat(slider.value);
      this.sensValue.textContent = this.settings.sensitivity.toFixed(2);
      save(LS.sensitivity, slider.value);
    });

    // mute — whole row is the ≥44px tap target, pill shows state
    const muteRow = div(
      `display:flex;align-items:center;gap:10px;min-height:44px;` +
        `cursor:pointer;touch-action:none;`,
      this.panel,
    );
    div(`font-size:12px;color:${PALETTE.uiDim};flex:1;`, muteRow, '静音');
    this.mutePill = div(
      `width:48px;height:26px;border-radius:13px;position:relative;` +
        `border:2px solid ${PALETTE.uiBorder};box-sizing:border-box;`,
      muteRow,
    );
    this.muteKnob = div(
      `position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;` +
        `background:${PALETTE.uiText};`,
      this.mutePill,
    );
    muteRow.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.settings.muted = !this.settings.muted;
      save(LS.muted, this.settings.muted ? '1' : '0');
      this.paintMute();
    });
    this.paintMute();

    // primary action — e2e drives this; ≥56×56, ≤120 per mobile hit-rect cap
    this.primary = div(
      `align-self:center;width:116px;height:56px;display:flex;align-items:center;` +
        `justify-content:center;border-radius:10px;font-size:18px;font-weight:700;` +
        `background:${PALETTE.accent};color:${PALETTE.sky[0]};cursor:pointer;` +
        `touch-action:none;`,
      this.panel,
      '开始游戏',
    );
    this.primary.dataset.btn = 'start';
    this.primary.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onStart(this.settings);
    });
  }

  /** start mode: result hidden, primary reads 开始游戏 */
  show(): void {
    this.resultEl.style.display = 'none';
    this.primary.textContent = '开始游戏';
    this.panel.style.visibility = 'visible';
    this.panel.style.pointerEvents = 'auto';
  }

  /** menu down — layout kept (rects measurable), touches pass through */
  hide(): void {
    this.panel.style.visibility = 'hidden';
    this.panel.style.pointerEvents = 'none';
  }

  /** big center numeral while the countdown runs; null clears it */
  setCountdown(msLeft: number | null): void {
    if (msLeft === null || msLeft <= 0) {
      this.countdownEl.style.visibility = 'hidden';
      return;
    }
    this.countdownEl.textContent = String(Math.ceil(msLeft / 1000));
    this.countdownEl.style.visibility = 'visible';
  }

  /** settlement panel on top of the same menu: winner, score, 再来一局 */
  showResult(r: MenuResult): void {
    this.resultEl.style.display = 'flex';
    this.resultTitle.textContent =
      r.winner === 'A' ? '我方胜利' : r.winner === 'B' ? '敌方胜利' : '平局';
    this.resultTitle.style.color =
      r.winner === 'A' ? PALETTE.teamA : r.winner === 'B' ? PALETTE.teamB : PALETTE.uiText;
    this.resultScore.textContent = `我方 ${r.killsA} — ${r.killsB} 敌方`;
    this.primary.textContent = '再来一局';
    this.panel.style.visibility = 'visible';
    this.panel.style.pointerEvents = 'auto';
  }

  private paintDifficulty(): void {
    for (const [id, el] of this.diffEls) {
      const on = id === this.settings.difficulty;
      el.style.borderColor = on ? PALETTE.accent : PALETTE.uiBorder;
      el.style.color = on ? PALETTE.accent : PALETTE.uiText;
    }
  }

  private paintMute(): void {
    const on = this.settings.muted;
    this.mutePill.style.background = on ? PALETTE.accent : PALETTE.uiPanel;
    this.mutePill.style.borderColor = on ? PALETTE.accent : PALETTE.uiBorder;
    this.muteKnob.style.left = on ? '24px' : '2px';
    this.muteKnob.style.background = on ? PALETTE.sky[0] : PALETTE.uiText;
  }
}
