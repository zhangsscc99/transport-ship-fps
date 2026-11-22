// src/render/bossHud.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/render/bossHud.ts
var BOSS_HUD_DEFAULT_TITLE = "\u53D8\u5F02\u4F53 \xB7 \u539F\u578B\u4F53";
var BOSS_HUD_SEGMENTS = 10;
var BOSS_HUD_MAX_DAMAGE = 12;
var BOSS_HUD_GHOST_HOLD_MS = 65;
var BOSS_HUD_GHOST_DURATION_MS = 350;
var BOSS_HUD_DAMAGE_DURATION_MS = 800;
var BOSS_HUD_DMG_BODY_FONT_PX = 12;
var BOSS_HUD_DMG_WEAK_SCALE = 1.4;
var BOSS_HP_COLORS = {
  high: "#38E0E8",
  mid: "#FFB454",
  low: "#FF4D4D",
  phase2: "#B81D2E",
  dmgBody: "#FFFFFF",
  dmgWeak: "#FFC857"
};
var TITLE_FONT = `'DIN Alternate','Bahnschrift','Segoe UI','PingFang SC','Microsoft YaHei','Noto Sans SC',system-ui,-apple-system,sans-serif`;
var MONO_FONT = `ui-monospace,'SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace`;
var STYLE_ID = "boss-hud-styles";
var DMG_SCATTER_X = [0, -14, 14, -7, 10, -18, 17, -4, 7, -12, 15, -9];
var DMG_SCATTER_Y = [0, -4, 3, -7, 2, -2, -6, 4, -5, 1, -8, 3];
function hpWidthPct(cur, max) {
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(cur)) return 0;
  const clamped = Math.max(0, Math.min(max, cur));
  const raw = clamped / max * 100;
  return Math.max(0, Math.min(100, Math.round(raw * 100) / 100));
}
function formatHpWidth(pct) {
  const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return `${Number(safe.toFixed(2))}%`;
}
function hpColor(pct, phase = 1) {
  if (phase === 2) return BOSS_HP_COLORS.phase2;
  if (pct > 60) return BOSS_HP_COLORS.high;
  if (pct >= 30) return BOSS_HP_COLORS.mid;
  return BOSS_HP_COLORS.low;
}
function formatHpReadout(cur, max) {
  const safeMax = Number.isFinite(max) && max > 0 ? Math.round(max) : 0;
  const safeCur = Number.isFinite(cur) ? Math.max(0, Math.min(safeMax, Math.ceil(cur))) : 0;
  const curText = String(safeCur);
  const maxText = String(safeMax);
  return { curText, maxText, fullText: `${curText} / ${maxText}` };
}
function ensureBossHudStyles(doc) {
  if (doc.getElementById?.(STYLE_ID)) return;
  const head = doc.head ?? doc.documentElement;
  if (!head) return;
  const st = doc.createElement("style");
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
var BossHud = class {
  doc;
  root;
  panel;
  emblemEl;
  titleEl;
  phaseBadgeEl;
  hpReadoutEl;
  hpCurSpan;
  hpMaxSpan;
  barTrack;
  ghostFill;
  hpFill;
  dmgLayer;
  phase = 1;
  lastPct = 100;
  lastHp = Number.NaN;
  lastHpMax = Number.NaN;
  ghostPct = 100;
  initialized = false;
  disposed = false;
  ghostTimer = null;
  activeDmg = [];
  dmgSeq = 0;
  constructor(parent, opts) {
    this.doc = parent.ownerDocument ?? document;
    ensureBossHudStyles(this.doc);
    const title = opts?.title?.trim() || BOSS_HUD_DEFAULT_TITLE;
    this.root = this.doc.createElement("div");
    this.root.dataset.hud = "boss-hud";
    this.root.dataset.phase = "1";
    this.root.dataset.visible = "1";
    this.root.style.cssText = `position:fixed;inset:0;z-index:12;pointer-events:none;overflow:hidden;user-select:none;-webkit-user-select:none;`;
    this.dmgLayer = this.doc.createElement("div");
    this.dmgLayer.dataset.role = "boss-dmg-layer";
    this.dmgLayer.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1;`;
    this.root.appendChild(this.dmgLayer);
    const barWrap = this.doc.createElement("div");
    barWrap.dataset.role = "boss-bar-wrap";
    barWrap.style.cssText = `position:absolute;left:50%;top:calc(env(safe-area-inset-top, 0px) + 14px);transform:translateX(-50%);width:min(640px, 78vw);pointer-events:none;box-sizing:border-box;z-index:2;`;
    this.root.appendChild(barWrap);
    this.panel = this.doc.createElement("div");
    this.panel.className = "boss-hud-panel";
    this.panel.dataset.role = "boss-panel";
    this.panel.style.cssText = `pointer-events:none;`;
    barWrap.appendChild(this.panel);
    const header = this.doc.createElement("div");
    header.dataset.role = "boss-header";
    header.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;pointer-events:none;min-width:0;`;
    this.panel.appendChild(header);
    const leftCluster = this.doc.createElement("div");
    leftCluster.style.cssText = `display:flex;align-items:center;gap:6px;min-width:0;pointer-events:none;`;
    header.appendChild(leftCluster);
    this.emblemEl = this.doc.createElement("span");
    this.emblemEl.dataset.role = "boss-emblem";
    this.emblemEl.style.cssText = `display:inline-block;width:6px;height:6px;flex:0 0 auto;transform:rotate(45deg);background:${BOSS_HP_COLORS.high};box-shadow:0 0 6px rgba(56,224,232,0.75);border-radius:1px;pointer-events:none;`;
    leftCluster.appendChild(this.emblemEl);
    this.titleEl = this.doc.createElement("span");
    this.titleEl.dataset.role = "boss-title";
    this.titleEl.textContent = title;
    this.titleEl.style.cssText = `font-family:${TITLE_FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;line-height:1.2;color:rgba(220,236,240,0.82);text-shadow:0 1px 3px rgba(0,0,0,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;`;
    leftCluster.appendChild(this.titleEl);
    this.phaseBadgeEl = this.doc.createElement("span");
    this.phaseBadgeEl.dataset.role = "boss-phase";
    this.phaseBadgeEl.textContent = "PHASE I";
    this.phaseBadgeEl.style.cssText = `flex:0 0 auto;font-family:${MONO_FONT};font-size:8.5px;font-weight:700;letter-spacing:0.1em;line-height:1;padding:2px 5px;border-radius:2px;color:rgba(168,238,244,0.84);background:rgba(56,224,232,0.10);border:1px solid rgba(120,255,255,0.28);pointer-events:none;`;
    leftCluster.appendChild(this.phaseBadgeEl);
    this.hpReadoutEl = this.doc.createElement("div");
    this.hpReadoutEl.dataset.role = "boss-hp-text";
    this.hpReadoutEl.style.cssText = `flex:0 0 auto;font-family:${MONO_FONT};font-size:10px;font-weight:600;letter-spacing:0.04em;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,0.9);pointer-events:none;`;
    header.appendChild(this.hpReadoutEl);
    this.hpCurSpan = this.doc.createElement("span");
    this.hpCurSpan.dataset.role = "boss-hp-cur";
    this.hpCurSpan.style.cssText = `color:rgba(236,248,252,0.95);pointer-events:none;`;
    this.hpCurSpan.textContent = "128000";
    this.hpMaxSpan = this.doc.createElement("span");
    this.hpMaxSpan.dataset.role = "boss-hp-max";
    this.hpMaxSpan.style.cssText = `color:rgba(196,218,228,0.56);pointer-events:none;`;
    this.hpMaxSpan.textContent = " / 128000";
    this.hpReadoutEl.append(this.hpCurSpan, this.hpMaxSpan);
    this.barTrack = this.doc.createElement("div");
    this.barTrack.className = "boss-hud-bar-track";
    this.barTrack.dataset.role = "boss-bar-track";
    this.barTrack.style.cssText = `height:10px;border-radius:3px;background:rgba(6,10,14,0.62);border:1px solid rgba(120,255,255,0.28);pointer-events:none;`;
    this.panel.appendChild(this.barTrack);
    this.ghostFill = this.doc.createElement("div");
    this.ghostFill.dataset.role = "boss-hp-ghost";
    this.ghostFill.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:100%;background:rgba(255,255,255,0.92);box-shadow:0 0 6px rgba(255,255,255,0.45);transition:width ${BOSS_HUD_GHOST_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1);z-index:1;pointer-events:none;`;
    this.barTrack.appendChild(this.ghostFill);
    this.hpFill = this.doc.createElement("div");
    this.hpFill.className = "boss-hud-hp-fill";
    this.hpFill.dataset.role = "boss-hp-fill";
    this.hpFill.dataset.color = BOSS_HP_COLORS.high;
    this.hpFill.dataset.edge = "0";
    this.hpFill.style.width = "100%";
    this.hpFill.style.backgroundColor = BOSS_HP_COLORS.high;
    this.barTrack.appendChild(this.hpFill);
    const ticksWrap = this.doc.createElement("div");
    ticksWrap.dataset.role = "boss-hp-ticks";
    ticksWrap.style.cssText = `position:absolute;inset:0;display:flex;z-index:3;pointer-events:none;`;
    for (let i = 0; i < BOSS_HUD_SEGMENTS; i++) {
      const tick = this.doc.createElement("div");
      tick.dataset.role = "hp-tick";
      tick.dataset.index = String(i);
      const isLast = i === BOSS_HUD_SEGMENTS - 1;
      const isMid = i === 4;
      tick.style.cssText = `flex:1;height:100%;box-sizing:border-box;pointer-events:none;` + (isLast ? "" : `border-right:1px solid ${isMid ? "rgba(4,8,12,0.92)" : "rgba(4,8,12,0.74)"};`);
      ticksWrap.appendChild(tick);
    }
    this.barTrack.appendChild(ticksWrap);
    parent.appendChild(this.root);
  }
  /** Update Boss HP segmented fill, delayed white damage ghost bar, and numeric readout. */
  setHp(hp, hpMax) {
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
    this.hpFill.dataset.edge = pct > 0 && pct < 100 ? "1" : "0";
    if (this.phase === 1) {
      this.emblemEl.style.background = color;
      this.emblemEl.style.boxShadow = `0 0 6px ${color}`;
    }
    if (!this.initialized || pct > this.ghostPct) {
      if (this.ghostTimer !== null) {
        clearTimeout(this.ghostTimer);
        this.ghostTimer = null;
      }
      this.ghostPct = pct;
      this.ghostFill.style.transition = "none";
      this.ghostFill.style.width = widthStr;
    } else if (pct < this.lastPct) {
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
  setPhase(phase) {
    if (this.disposed) return;
    this.phase = phase;
    const isP2 = phase === 2;
    this.root.dataset.phase = String(phase);
    const color = hpColor(this.lastPct, phase);
    this.hpFill.style.backgroundColor = color;
    this.hpFill.dataset.color = color;
    this.panel.classList.toggle("boss-hud-phase2", isP2);
    this.barTrack.classList.toggle("boss-hud-phase2-pulse", isP2);
    this.hpFill.classList.toggle("boss-hud-fill-phase2", isP2);
    this.emblemEl.classList.toggle("boss-hud-emblem-phase2", isP2);
    this.barTrack.style.borderColor = isP2 ? "rgba(255, 72, 92, 0.72)" : "rgba(120, 255, 255, 0.28)";
    this.emblemEl.style.background = isP2 ? "#FF4D5E" : color;
    this.emblemEl.style.boxShadow = isP2 ? "0 0 8px rgba(255, 68, 88, 0.9)" : `0 0 6px ${color}`;
    if (isP2) {
      this.phaseBadgeEl.textContent = "PHASE II";
      this.phaseBadgeEl.style.color = "#FFD6DA";
      this.phaseBadgeEl.style.background = "rgba(184, 29, 46, 0.38)";
      this.phaseBadgeEl.style.borderColor = "rgba(255, 77, 94, 0.72)";
    } else {
      this.phaseBadgeEl.textContent = "PHASE I";
      this.phaseBadgeEl.style.color = "rgba(168, 238, 244, 0.84)";
      this.phaseBadgeEl.style.background = "rgba(56, 224, 232, 0.10)";
      this.phaseBadgeEl.style.borderColor = "rgba(120, 255, 255, 0.28)";
    }
  }
  /** Show or hide the Boss HUD overlay. */
  setVisible(v) {
    if (this.disposed) return;
    this.root.style.display = v ? "" : "none";
    this.root.dataset.visible = v ? "1" : "0";
  }
  /**
   * Spawn a floating damage number at the projected screen position.
   * Caps simultaneous nodes at 12 (reusing the oldest node when exceeded),
   * floats up 40px and fades out over 0.8s before removing itself from DOM.
   */
  showDamage(worldToScreen, amount, kind) {
    if (this.disposed) return;
    const pos = worldToScreen();
    if (!pos || !pos.visible || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      return;
    }
    const idx = this.dmgSeq % DMG_SCATTER_X.length;
    this.dmgSeq++;
    const x = pos.x + DMG_SCATTER_X[idx];
    const y = pos.y + DMG_SCATTER_Y[idx];
    let entry;
    if (this.activeDmg.length >= BOSS_HUD_MAX_DAMAGE) {
      entry = this.activeDmg.shift();
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    } else {
      const el2 = this.doc.createElement("div");
      el2.className = "boss-hud-dmg-num";
      el2.dataset.role = "boss-dmg";
      this.dmgLayer.appendChild(el2);
      entry = { el: el2, timer: null };
    }
    const el = entry.el;
    const isWeak = kind === "weak";
    const fontPx = isWeak ? Number((BOSS_HUD_DMG_BODY_FONT_PX * BOSS_HUD_DMG_WEAK_SCALE).toFixed(1)) : BOSS_HUD_DMG_BODY_FONT_PX;
    const displayNum = Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
    el.dataset.kind = kind;
    el.textContent = String(displayNum);
    el.style.left = `${Number(x.toFixed(1))}px`;
    el.style.top = `${Number(y.toFixed(1))}px`;
    el.style.fontSize = `${fontPx}px`;
    el.style.fontWeight = isWeak ? "800" : "700";
    el.style.color = isWeak ? BOSS_HP_COLORS.dmgWeak : BOSS_HP_COLORS.dmgBody;
    el.style.textShadow = isWeak ? "0 1px 3px rgba(0, 0, 0, 0.96), 0 -1px 2px rgba(0, 0, 0, 0.7), 0 0 11px rgba(255, 200, 87, 0.68)" : "0 1px 3px rgba(0, 0, 0, 0.96), 0 -1px 2px rgba(0, 0, 0, 0.68), 0 0 4px rgba(0, 0, 0, 0.72)";
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = `${isWeak ? "bossHudDmgWeak" : "bossHudDmgBody"} ${BOSS_HUD_DAMAGE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) forwards`;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const posIdx = this.activeDmg.indexOf(entry);
      if (posIdx !== -1) this.activeDmg.splice(posIdx, 1);
      entry.el.remove();
    }, BOSS_HUD_DAMAGE_DURATION_MS);
    this.activeDmg.push(entry);
  }
  /** Tear down all timers and remove the Boss HUD container from the DOM. */
  dispose() {
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
};

// src/render/bossHud.test.ts
var MockClassList = class {
  set = /* @__PURE__ */ new Set();
  syncFromString(str) {
    this.set.clear();
    for (const tok of str.split(/\s+/)) {
      if (tok) this.set.add(tok);
    }
  }
  toString() {
    return [...this.set].join(" ");
  }
  contains(cls) {
    return this.set.has(cls);
  }
  toggle(cls, force) {
    const next = force !== void 0 ? force : !this.set.has(cls);
    if (next) this.set.add(cls);
    else this.set.delete(cls);
    return next;
  }
};
var MockStyle = class {
  props = {};
  get cssText() {
    return Object.entries(this.props).map(([k, v]) => `${k}:${v}`).join(";");
  }
  set cssText(val) {
    this.props = {};
    for (const part of val.split(";")) {
      const idx = part.indexOf(":");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) {
        const camel = k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.props[camel] = v;
      }
    }
  }
  getProp(k) {
    return this.props[k] ?? "";
  }
  setProp(k, v) {
    this.props[k] = v;
  }
};
function makeStyleProxy() {
  const target = new MockStyle();
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "cssText") return t.cssText;
      return t.getProp(prop);
    },
    set(t, prop, val) {
      if (prop === "cssText") {
        t.cssText = String(val);
      } else {
        t.setProp(prop, String(val));
      }
      return true;
    }
  });
}
var MockElement = class {
  tagName;
  ownerDocument;
  children = [];
  dataset = {};
  classList = new MockClassList();
  style = makeStyleProxy();
  parentNode = null;
  id = "";
  offsetWidth = 100;
  _text = "";
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }
  get className() {
    return this.classList.toString();
  }
  set className(val) {
    this.classList.syncFromString(val);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(val) {
    this.children.length = 0;
    this._text = String(val);
  }
  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }
  querySelectorAll(selector) {
    const out = [];
    const dataRoleMatch = /^\[data-role="([^"]+)"\]$/.exec(selector);
    const dataHudMatch = /^\[data-hud="([^"]+)"\]$/.exec(selector);
    const classMatch = /^\.([a-zA-Z0-9_-]+)$/.exec(selector);
    const visit = (node) => {
      for (const c of node.children) {
        const matched = dataRoleMatch && c.dataset.role === dataRoleMatch[1] || dataHudMatch && c.dataset.hud === dataHudMatch[1] || classMatch && c.classList.contains(classMatch[1]);
        if (matched) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
};
var MockDocument = class {
  documentElement;
  head;
  body;
  constructor() {
    this.documentElement = new MockElement("html", this);
    this.head = new MockElement("head", this);
    this.body = new MockElement("body", this);
    this.documentElement.append(this.head, this.body);
  }
  createElement(tag) {
    return new MockElement(tag, this);
  }
  getElementById(id) {
    const visit = (node) => {
      if (node.id === id) return node;
      for (const c of node.children) {
        const found = visit(c);
        if (found) return found;
      }
      return null;
    };
    return visit(this.documentElement);
  }
};
function createMockParent() {
  const doc = new MockDocument();
  return {
    doc,
    parent: doc.body,
    rawParent: doc.body
  };
}
test("hpWidthPct computes exact clamped percentages", () => {
  assert.equal(hpWidthPct(64e3, 128e3), 50);
  assert.equal(formatHpWidth(hpWidthPct(64e3, 128e3)), "50%");
  assert.equal(hpWidthPct(128e3, 128e3), 100);
  assert.equal(hpWidthPct(0, 128e3), 0);
  assert.equal(hpWidthPct(-100, 128e3), 0);
  assert.equal(hpWidthPct(2e5, 128e3), 100);
  assert.equal(hpWidthPct(50, 0), 0);
  assert.equal(hpWidthPct(Number.NaN, 100), 0);
});
test("hpColor switches across >60% cyan, 30-60% yellow, <30% red, and phase 2 dark red", () => {
  assert.equal(hpColor(100), BOSS_HP_COLORS.high);
  assert.equal(hpColor(60.01), BOSS_HP_COLORS.high);
  assert.equal(hpColor(60), BOSS_HP_COLORS.mid);
  assert.equal(hpColor(45), BOSS_HP_COLORS.mid);
  assert.equal(hpColor(30), BOSS_HP_COLORS.mid);
  assert.equal(hpColor(29.99), BOSS_HP_COLORS.low);
  assert.equal(hpColor(0), BOSS_HP_COLORS.low);
  assert.equal(hpColor(95, 2), BOSS_HP_COLORS.phase2);
  assert.equal(hpColor(15, 2), BOSS_HP_COLORS.phase2);
});
test("formatHpReadout formats Boss HP numbers cleanly", () => {
  assert.equal(formatHpReadout(128e3, 128e3).fullText, "128000 / 128000");
  assert.equal(formatHpReadout(64e3, 128e3).fullText, "64000 / 128000");
  assert.equal(formatHpReadout(0.2, 128e3).fullText, "1 / 128000");
  assert.equal(formatHpReadout(-5, 128e3).fullText, "0 / 128000");
});
test("BossHud renders default title, pointer-events:none, and exactly 10 segment ticks", () => {
  const { doc, parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const root = rawParent.querySelector('[data-hud="boss-hud"]');
  assert.ok(root, "BossHud root should be mounted into parent");
  assert.equal(root.style.pointerEvents, "none");
  const title = root.querySelector('[data-role="boss-title"]');
  assert.equal(title?.textContent, BOSS_HUD_DEFAULT_TITLE);
  const ticks = root.querySelectorAll('[data-role="hp-tick"]');
  assert.equal(ticks.length, BOSS_HUD_SEGMENTS);
  assert.equal(ticks.length, 10);
  const styleEl = doc.getElementById("boss-hud-styles");
  assert.ok(styleEl, "BossHud stylesheet should be injected into document.head");
  hud.dispose();
});
test("setHp updates fill width percentage, readout text, and threshold colors", () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent, { title: "APEX \xB7 PROTOTYPE" });
  const title = rawParent.querySelector('[data-role="boss-title"]');
  const fill = rawParent.querySelector('[data-role="boss-hp-fill"]');
  const readout = rawParent.querySelector('[data-role="boss-hp-text"]');
  assert.equal(title?.textContent, "APEX \xB7 PROTOTYPE");
  assert.ok(fill && readout);
  hud.setHp(102400, 128e3);
  assert.equal(fill.style.width, "80%");
  assert.equal(fill.style.backgroundColor, "#38E0E8");
  assert.equal(readout.textContent, "102400 / 128000");
  hud.setHp(64e3, 128e3);
  assert.equal(fill.style.width, "50%");
  assert.equal(fill.style.backgroundColor, "#FFB454");
  assert.equal(readout.textContent, "64000 / 128000");
  hud.setHp(25600, 128e3);
  assert.equal(fill.style.width, "20%");
  assert.equal(fill.style.backgroundColor, "#FF4D4D");
  assert.equal(readout.textContent, "25600 / 128000");
  hud.dispose();
});
test("setHp trails white ghost bar on damage and snaps immediately on heal", async () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const ghost = rawParent.querySelector('[data-role="boss-hp-ghost"]');
  hud.setHp(128e3, 128e3);
  assert.equal(ghost.style.width, "100%");
  hud.setHp(64e3, 128e3);
  assert.equal(ghost.style.width, "100%");
  await new Promise((r) => setTimeout(r, BOSS_HUD_GHOST_HOLD_MS + 35));
  assert.equal(ghost.style.width, "50%");
  assert.ok(ghost.style.transition.includes("350ms"), "ghost bar should animate catch-up over 350ms");
  hud.setHp(64e3, 128e3);
  assert.ok(ghost.style.transition.includes("350ms"), "unchanged setHp should preserve ghost transition");
  hud.setHp(128e3, 128e3);
  assert.equal(ghost.style.width, "100%");
  assert.equal(ghost.style.transition, "none");
  hud.dispose();
});
test("setPhase(2) applies dark red fill and 1.6s outer glow pulse class, setPhase(1) reverts", () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const fill = rawParent.querySelector('[data-role="boss-hp-fill"]');
  const track = rawParent.querySelector('[data-role="boss-bar-track"]');
  hud.setHp(1e5, 128e3);
  assert.equal(fill.style.backgroundColor, "#38E0E8");
  assert.equal(track.classList.contains("boss-hud-phase2-pulse"), false);
  hud.setPhase(2);
  assert.equal(fill.style.backgroundColor, BOSS_HP_COLORS.phase2);
  assert.equal(track.classList.contains("boss-hud-phase2-pulse"), true);
  hud.setPhase(1);
  assert.equal(fill.style.backgroundColor, "#38E0E8");
  assert.equal(track.classList.contains("boss-hud-phase2-pulse"), false);
  hud.dispose();
});
test("setVisible toggles root display state cleanly", () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const root = rawParent.querySelector('[data-hud="boss-hud"]');
  hud.setVisible(false);
  assert.equal(root.style.display, "none");
  assert.equal(root.dataset.visible, "0");
  hud.setVisible(true);
  assert.equal(root.style.display, "");
  assert.equal(root.dataset.visible, "1");
  hud.dispose();
});
test("showDamage caps DOM nodes at 12 when called 15 times, reusing oldest, and styles body vs weak", () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const dmgLayer = rawParent.querySelector('[data-role="boss-dmg-layer"]');
  hud.showDamage(() => ({ x: 100, y: 100, visible: false }), 999, "weak");
  assert.equal(dmgLayer.children.length, 0);
  for (let i = 1; i <= 15; i++) {
    const kind = i % 3 === 0 ? "weak" : "body";
    hud.showDamage(() => ({ x: 200 + i * 2, y: 180, visible: true }), i * 100, kind);
  }
  assert.equal(dmgLayer.children.length, BOSS_HUD_MAX_DAMAGE);
  assert.equal(dmgLayer.children.length, 12);
  const texts = dmgLayer.children.map((el) => el.textContent);
  assert.equal(texts.includes("100"), false);
  assert.equal(texts.includes("200"), false);
  assert.equal(texts.includes("300"), false);
  assert.equal(texts.includes("1300"), true);
  assert.equal(texts.includes("1400"), true);
  assert.equal(texts.includes("1500"), true);
  const bodyEl = dmgLayer.children.find((el) => el.dataset.kind === "body");
  const weakEl = dmgLayer.children.find((el) => el.dataset.kind === "weak");
  assert.equal(bodyEl.style.color, "#FFFFFF");
  assert.equal(bodyEl.style.fontSize, "12px");
  assert.equal(weakEl.style.color, "#FFC857");
  assert.equal(weakEl.style.fontSize, "16.8px");
  hud.dispose();
});
test("showDamage auto-removes floating node after 0.8s", async () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  const dmgLayer = rawParent.querySelector('[data-role="boss-dmg-layer"]');
  hud.showDamage(() => ({ x: 180, y: 200, visible: true }), 450, "body");
  assert.equal(dmgLayer.children.length, 1);
  await new Promise((r) => setTimeout(r, BOSS_HUD_DAMAGE_DURATION_MS + 60));
  assert.equal(dmgLayer.children.length, 0);
  hud.dispose();
});
test("dispose removes BossHud container from DOM cleanly and is idempotent", () => {
  const { parent, rawParent } = createMockParent();
  const hud = new BossHud(parent);
  assert.equal(rawParent.children.length, 1);
  hud.showDamage(() => ({ x: 150, y: 150, visible: true }), 320, "weak");
  hud.dispose();
  assert.equal(rawParent.children.length, 0);
  hud.dispose();
  hud.setHp(5e4, 128e3);
  hud.showDamage(() => ({ x: 150, y: 150, visible: true }), 500, "body");
  assert.equal(rawParent.children.length, 0);
});
