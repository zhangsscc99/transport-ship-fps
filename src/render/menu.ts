// Start menu / difficulty settings / match & death settlement overlay.
// - Difficulty: EASY / NORMAL / HARD persisted to localStorage (tsf.difficulty)
// - Music toggle (default ON, persisted to tsf.music) + Mute + Sensitivity
// - CC BY 4.0 music attribution clearly shown at bottom of menu
// - Death settlement panel: kills / survival time / difficulty + Retry / Return to Menu
// - Compact responsive layout fits cleanly inside 844×390 landscape & 390×844 portrait.

import { PALETTE } from './palette';
import type { Winner } from '../game/match';
import {
  DIFFICULTIES,
  getDifficultySpec,
  parseDifficulty,
  type DifficultyId,
} from '../game/difficulty';

export type Difficulty = DifficultyId;

export interface MenuSettings {
  difficulty: DifficultyId;
  /** look sensitivity in °/px — SPEC default 0.35 */
  sensitivity: number;
  muted: boolean;
  /** background music enabled (default true) */
  musicEnabled: boolean;
}

export interface MenuResult {
  winner: Winner;
  killsA: number;
  killsB: number;
}

export interface DeathSummary {
  kills: number;
  survivalMs: number;
  difficulty: DifficultyId;
}

export interface MenuCallbacks {
  onStart: (s: MenuSettings) => void;
  onRetry?: (s: MenuSettings) => void;
  onReturnMenu?: () => void;
  onSettingsChange?: (s: MenuSettings) => void;
}

const FONT = `'DIN Alternate','Bahnschrift',system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif`;
const LS = {
  difficulty: 'tsf.difficulty',
  sensitivity: 'tsf.sensitivity',
  muted: 'tsf.muted',
  music: 'tsf.music',
} as const;

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

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function loadSettings(): MenuSettings {
  const s: MenuSettings = {
    difficulty: 'normal',
    sensitivity: 0.35,
    muted: false,
    musicEnabled: true,
  };
  try {
    s.difficulty = parseDifficulty(localStorage.getItem(LS.difficulty));
    const v = parseFloat(localStorage.getItem(LS.sensitivity) ?? '');
    if (Number.isFinite(v)) s.sensitivity = Math.min(0.8, Math.max(0.1, v));
    s.muted = localStorage.getItem(LS.muted) === '1';
    const mus = localStorage.getItem(LS.music);
    s.musicEnabled = mus === null ? true : mus !== '0';
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
  private deathPanel: HTMLDivElement;
  private deathKillsEl: HTMLDivElement;
  private deathTimeEl: HTMLDivElement;
  private deathDiffEl: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private resultEl: HTMLDivElement;
  private resultTitle: HTMLDivElement;
  private resultScore: HTMLDivElement;
  private primary: HTMLDivElement;
  private diffEls = new Map<DifficultyId, HTMLDivElement>();
  private diffInfoEl: HTMLDivElement;
  private musicKnob: HTMLDivElement;
  private musicPill: HTMLDivElement;
  private muteKnob: HTMLDivElement;
  private mutePill: HTMLDivElement;
  private sensValue: HTMLDivElement;
  private cbs: MenuCallbacks;

  constructor(parent: HTMLElement, opts: MenuCallbacks) {
    this.cbs = opts;
    this.settings = loadSettings();

    const root = div(
      `position:fixed;inset:0;z-index:20;pointer-events:none;font-family:${FONT};` +
        `color:${PALETTE.uiText};`,
      parent,
    );

    // Big pre-match countdown numeral
    this.countdownEl = div(
      `position:absolute;left:50%;top:34%;transform:translate(-50%,-50%);` +
        `font-size:96px;font-weight:800;color:${PALETTE.accent};` +
        `text-shadow:0 0 18px ${PALETTE.crosshairEdge};visibility:hidden;`,
      root,
    );

    // --- Main Start / Settings Panel (compact so 844×390 landscape shows 100% cleanly!) ---
    this.panel = div(
      `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
        `width:min(388px,92vw);max-height:94vh;box-sizing:border-box;` +
        `background:rgba(10,15,22,0.84);border:1px solid ${PALETTE.uiBorder};` +
        `border-top:2px solid ${PALETTE.accent};border-radius:10px;padding:12px 16px 10px;` +
        `display:flex;flex-direction:column;gap:8px;` +
        `pointer-events:auto;visibility:hidden;touch-action:none;` +
        `user-select:none;-webkit-user-select:none;box-shadow:0 14px 40px rgba(0,0,0,0.48);`,
      root,
    );
    this.panel.dataset.panel = 'menu';

    const titleRow = div(
      `display:flex;align-items:baseline;justify-content:center;gap:10px;`,
      this.panel,
    );
    div(`font-size:24px;font-weight:800;letter-spacing:5px;`, titleRow, '运输船');
    div(
      `font-size:10px;font-weight:700;letter-spacing:0.14em;color:${PALETTE.uiDim};`,
      titleRow,
      'TRANSPORT SHIP · 保卫者视角',
    );

    // Match result block (populated by showResult, hidden in start mode)
    this.resultEl = div(`display:none;flex-direction:column;gap:3px;`, this.panel);
    this.resultTitle = div(`font-size:19px;font-weight:800;text-align:center;`, this.resultEl);
    this.resultScore = div(`font-size:13px;color:${PALETTE.uiText};text-align:center;`, this.resultEl);
    div(`height:1px;background:${PALETTE.uiBorder};margin:3px 0;`, this.resultEl);

    // --- Difficulty selector: EASY / NORMAL / HARD ---
    const diffHead = div(
      `display:flex;align-items:baseline;justify-content:space-between;`,
      this.panel,
    );
    div(`font-size:11px;font-weight:700;letter-spacing:0.14em;color:${PALETTE.uiDim};`, diffHead, 'DIFFICULTY · 难度');
    this.diffInfoEl = div(`font-size:10px;color:${PALETTE.uiDim};letter-spacing:0.04em;`, diffHead);

    const diffRow = div(`display:flex;gap:8px;`, this.panel);
    diffRow.dataset.role = 'difficulty-row';
    for (const d of DIFFICULTIES) {
      const el = div(
        `flex:1;height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;` +
          `border:2px solid ${PALETTE.uiBorder};border-radius:8px;` +
          `cursor:pointer;touch-action:none;box-sizing:border-box;background:rgba(255,255,255,0.03);`,
        diffRow,
      );
      el.dataset.diff = d.id;
      div(`font-size:13px;font-weight:800;letter-spacing:0.12em;line-height:1.1;`, el, d.label);
      div(`font-size:10px;opacity:0.75;line-height:1;`, el, d.subLabel);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setDifficulty(d.id);
      });
      this.diffEls.set(d.id, el);
    }
    this.paintDifficulty();

    // --- Sensitivity slider (compact 36px row) ---
    const sensRow = div(
      `display:flex;align-items:center;gap:8px;min-height:32px;`,
      this.panel,
    );
    div(`font-size:11px;color:${PALETTE.uiDim};flex:0 0 auto;`, sensRow, '灵敏度');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.1';
    slider.max = '0.8';
    slider.step = '0.05';
    slider.value = String(this.settings.sensitivity);
    css(
      slider,
      `flex:1;height:28px;margin:0;accent-color:${PALETTE.accent};touch-action:none;`,
    );
    sensRow.appendChild(slider);
    this.sensValue = div(
      `font-size:11px;color:${PALETTE.uiText};width:32px;text-align:right;flex:0 0 auto;font-variant-numeric:tabular-nums;`,
      sensRow,
      this.settings.sensitivity.toFixed(2),
    );
    slider.addEventListener('input', () => {
      this.settings.sensitivity = parseFloat(slider.value);
      this.sensValue.textContent = this.settings.sensitivity.toFixed(2);
      save(LS.sensitivity, slider.value);
      this.cbs.onSettingsChange?.(this.settings);
    });

    // --- Audio toggles side-by-side: BGM Music + Master Mute ---
    const audioRow = div(`display:flex;gap:12px;align-items:center;`, this.panel);

    const makeToggle = (label: string, testAttr: string) => {
      const wrap = div(
        `flex:1;display:flex;align-items:center;justify-content:space-between;gap:6px;` +
          `min-height:34px;padding:0 8px;border-radius:6px;background:rgba(255,255,255,0.03);` +
          `border:1px solid ${PALETTE.uiBorder};cursor:pointer;touch-action:none;box-sizing:border-box;`,
        audioRow,
      );
      wrap.dataset.toggle = testAttr;
      div(`font-size:11px;color:${PALETTE.uiDim};`, wrap, label);
      const pill = div(
        `width:40px;height:22px;border-radius:11px;position:relative;` +
          `border:1.5px solid ${PALETTE.uiBorder};box-sizing:border-box;flex:0 0 auto;`,
        wrap,
      );
      const knob = div(
        `position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;` +
          `background:${PALETTE.uiText};`,
        pill,
      );
      return { wrap, pill, knob };
    };

    const musicT = makeToggle('音乐 BGM', 'music');
    this.musicPill = musicT.pill;
    this.musicKnob = musicT.knob;
    musicT.wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.settings.musicEnabled = !this.settings.musicEnabled;
      save(LS.music, this.settings.musicEnabled ? '1' : '0');
      this.paintToggles();
      this.cbs.onSettingsChange?.(this.settings);
    });

    const muteT = makeToggle('静音 MUTE', 'mute');
    this.mutePill = muteT.pill;
    this.muteKnob = muteT.knob;
    muteT.wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.settings.muted = !this.settings.muted;
      save(LS.muted, this.settings.muted ? '1' : '0');
      this.paintToggles();
      this.cbs.onSettingsChange?.(this.settings);
    });
    this.paintToggles();

    // --- Primary CTA: 开始游戏 (≥56×56, ≤120px width for mobile hit-rect test) ---
    this.primary = div(
      `align-self:center;width:116px;height:48px;display:flex;align-items:center;` +
        `justify-content:center;border-radius:8px;font-size:16px;font-weight:800;` +
        `letter-spacing:2px;background:${PALETTE.accent};color:#ffffff;cursor:pointer;` +
        `touch-action:none;margin-top:2px;box-shadow:0 4px 16px rgba(255,70,85,0.35);`,
      this.panel,
      '开始游戏',
    );
    this.primary.dataset.btn = 'start';
    this.primary.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cbs.onStart(this.settings);
    });

    // --- CC BY 4.0 Music Attribution footer ---
    const credit = div(
      `font-size:9px;color:${PALETTE.uiDim};text-align:center;letter-spacing:0.03em;` +
        `opacity:0.82;border-top:1px solid rgba(255,255,255,0.08);padding-top:5px;margin-top:1px;`,
      this.panel,
      'Music: Kevin MacLeod (incompetech.com) — CC BY 4.0',
    );
    credit.dataset.role = 'music-credit';

    // --- Player Death Settlement Panel (shown after 0.6s fall-down camera) ---
    this.deathPanel = div(
      `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
        `width:min(368px,90vw);box-sizing:border-box;` +
        `background:rgba(12,10,14,0.88);border:1px solid rgba(255,70,85,0.55);` +
        `border-top:3px solid ${PALETTE.accent};border-radius:10px;padding:18px 18px 14px;` +
        `display:none;flex-direction:column;gap:12px;pointer-events:auto;touch-action:none;` +
        `user-select:none;-webkit-user-select:none;box-shadow:0 18px 48px rgba(0,0,0,0.65);`,
      root,
    );
    this.deathPanel.dataset.panel = 'death';

    div(
      `font-size:26px;font-weight:800;letter-spacing:6px;text-align:center;color:${PALETTE.accent};`,
      this.deathPanel,
      '阵亡',
    );
    div(
      `font-size:10px;font-weight:700;letter-spacing:0.22em;text-align:center;color:${PALETTE.uiDim};margin-top:-10px;`,
      this.deathPanel,
      'KIA · COMBAT SETTLEMENT',
    );

    const statsRow = div(`display:flex;gap:8px;`, this.deathPanel);
    const makeStatCard = (label: string, testKey: string) => {
      const card = div(
        `flex:1;padding:10px 6px;border-radius:8px;background:rgba(255,255,255,0.04);` +
          `border:1px solid ${PALETTE.uiBorder};text-align:center;`,
        statsRow,
      );
      div(`font-size:10px;color:${PALETTE.uiDim};letter-spacing:0.1em;margin-bottom:4px;`, card, label);
      const val = div(
        `font-size:20px;font-weight:800;color:${PALETTE.uiText};font-variant-numeric:tabular-nums;`,
        card,
        '0',
      );
      val.dataset.deathStat = testKey;
      return val;
    };
    this.deathKillsEl = makeStatCard('击杀数', 'kills');
    this.deathTimeEl = makeStatCard('存活时间', 'survival');
    this.deathDiffEl = makeStatCard('难度', 'difficulty');

    const deathBtns = div(`display:flex;gap:10px;justify-content:center;margin-top:4px;`, this.deathPanel);
    const retryBtn = div(
      `flex:1;height:46px;display:flex;align-items:center;justify-content:center;border-radius:8px;` +
        `background:${PALETTE.accent};color:#ffffff;font-size:15px;font-weight:800;letter-spacing:2px;` +
        `cursor:pointer;touch-action:none;`,
      deathBtns,
      '重试',
    );
    retryBtn.dataset.deathBtn = 'retry';
    retryBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideDeath();
      if (this.cbs.onRetry) this.cbs.onRetry(this.settings);
      else this.cbs.onStart(this.settings);
    });

    const backBtn = div(
      `flex:1;height:46px;display:flex;align-items:center;justify-content:center;border-radius:8px;` +
        `background:rgba(255,255,255,0.08);border:1px solid ${PALETTE.uiBorder};` +
        `color:${PALETTE.uiText};font-size:15px;font-weight:700;letter-spacing:1px;` +
        `cursor:pointer;touch-action:none;`,
      deathBtns,
      '返回菜单',
    );
    backBtn.dataset.deathBtn = 'menu';
    backBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideDeath();
      this.cbs.onReturnMenu?.();
      this.show();
    });
  }

  setDifficulty(id: DifficultyId): void {
    this.settings.difficulty = id;
    save(LS.difficulty, id);
    this.paintDifficulty();
    this.cbs.onSettingsChange?.(this.settings);
  }

  syncMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.paintToggles();
  }

  /** Start mode: result hidden, primary reads 开始游戏 */
  show(): void {
    this.hideDeath();
    this.resultEl.style.display = 'none';
    this.primary.textContent = '开始游戏';
    this.panel.style.visibility = 'visible';
    this.panel.style.pointerEvents = 'auto';
  }

  /** Menu down — layout kept (rects measurable), touches pass through */
  hide(): void {
    this.panel.style.visibility = 'hidden';
    this.panel.style.pointerEvents = 'none';
  }

  /** Show player death settlement panel (kills / survival time / difficulty + Retry / Menu). */
  showDeath(summary: DeathSummary): void {
    this.hide();
    const spec = getDifficultySpec(summary.difficulty);
    this.deathKillsEl.textContent = String(summary.kills);
    this.deathTimeEl.textContent = formatDuration(summary.survivalMs);
    this.deathDiffEl.textContent = spec.label;
    this.deathDiffEl.style.color =
      spec.id === 'hard' ? PALETTE.accent : spec.id === 'easy' ? PALETTE.gatlingReady : PALETTE.gatlingAccent;
    this.deathPanel.style.display = 'flex';
  }

  hideDeath(): void {
    this.deathPanel.style.display = 'none';
  }

  setCountdown(msLeft: number | null): void {
    if (msLeft === null || msLeft <= 0) {
      this.countdownEl.style.visibility = 'hidden';
      return;
    }
    this.countdownEl.textContent = String(Math.ceil(msLeft / 1000));
    this.countdownEl.style.visibility = 'visible';
  }

  showResult(r: MenuResult): void {
    this.hideDeath();
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
    const spec = getDifficultySpec(this.settings.difficulty);
    this.diffInfoEl.textContent = `敌伤 ${spec.enemyDmg} · 命中 ${Math.round(spec.hitRate * 100)}% · 反应 ${(spec.reactionMs / 1000).toFixed(2)}s`;
    for (const [id, el] of this.diffEls) {
      const on = id === this.settings.difficulty;
      el.style.borderColor = on ? PALETTE.accent : PALETTE.uiBorder;
      el.style.color = on ? PALETTE.accent : PALETTE.uiText;
      el.style.background = on ? 'rgba(255,70,85,0.14)' : 'rgba(255,255,255,0.03)';
    }
  }

  private paintToggles(): void {
    const paintOne = (pill: HTMLDivElement, knob: HTMLDivElement, on: boolean, activeBg: string) => {
      pill.style.background = on ? activeBg : PALETTE.uiPanel;
      pill.style.borderColor = on ? activeBg : PALETTE.uiBorder;
      knob.style.left = on ? '20px' : '2px';
      knob.style.background = on ? '#0b1018' : PALETTE.uiText;
    };
    paintOne(this.musicPill, this.musicKnob, this.settings.musicEnabled, PALETTE.gatlingReady);
    paintOne(this.mutePill, this.muteKnob, this.settings.muted, PALETTE.accent);
  }
}
