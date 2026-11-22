// Minimalist overhead enemy distance & HP overlay (DOM layer, 0 WebGL draw calls):
//   - Displays ONLY distance in `^\d+m$` format (integer + lowercase m); zero names/factions.
//   - Glass pill: rgba(8,12,20,.62), 1px inner-glow border rgba(120,255,255,.35),
//     radius 6px, ui-monospace stack, 12px, weight 500.
//     When distance < 10m: border shifts warm (#FFB454) + 4px circular indicator dot before digits.
//   - HP bar 4px directly beneath pill: 42px × 3px, overflow hidden (no radius overflow),
//     track rgba(255,255,255,.14), fill cyan (>60%) -> yellow (30-60%) -> red (<=30%),
//     zero border & zero shadow.
//   - Distance fade: >40m completely hidden, 25-40m opacity 0.45, <25m full 1.0.
//   - Simultaneous on-screen cap: strictly <= 5 nearest visible enemies.
//   - Never covers >1/3 of enemy screen height; same-frame exact camera projection prevents pan jitter.

import * as THREE from 'three';
import { PALETTE } from './palette';
import { hasLineOfSight, type EnemyBot, type Faction } from '../game/ai';
import type { Box } from '../game/map';
import type { EnemyRenderer } from './enemies';

export const TAG_MAX_RANGE_M = 40;
export const TAG_FADE_START_M = 25;
export const TAG_FADE_OPACITY = 0.45;
export const TAG_CLOSE_WARN_M = 10;
export const TAG_MAX_VISIBLE = 5;
export const TAG_DIST_UPDATE_MS = 160;
export const TAG_HEAD_OFFSET_M = 0.24;

const MONO_FONT = `ui-monospace,'SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace`;

export interface EnemyTagTelemetry {
  botId: string;
  faction: Faction;
  text: string;
  displayedDist: number;
  actualDist: number;
  hpRatio: number;
  closeWarn: boolean;
  visible: boolean;
  occluded: boolean;
  opacity: number;
  screenX: number;
  screenY: number;
  coversBodyRatio: number;
}

interface TagEntry {
  el: HTMLDivElement;
  pillEl: HTMLDivElement;
  dotEl: HTMLSpanElement;
  textEl: HTMLSpanElement;
  hpTrackEl: HTMLDivElement;
  hpFillEl: HTMLDivElement;
  displayedDist: number;
  lastDistUpdateMs: number;
  lastText: string;
  lastCloseWarn: boolean | null;
  lastHpKey: string;
  smoothHeadOffsetY: number;
  lastUpdateMs: number;
  baseW: number;
  baseH: number;
  needsMeasure: boolean;
}

interface Candidate {
  bot: EnemyBot;
  entry: TagEntry;
  actualDist: number;
  occluded: boolean;
  opacity: number;
  anchorX: number;
  anchorY: number;
  headSy: number;
  footSy: number;
  bodyH: number;
}

export class EnemyTagOverlay {
  readonly root: HTMLDivElement;
  readonly telemetry: EnemyTagTelemetry[] = [];

  private entries = new Map<string, TagEntry>();
  private tmpHeadTop = new THREE.Vector3();
  private tmpAnchor = new THREE.Vector3();
  private tmpFoot = new THREE.Vector3();
  private tmpCenter = new THREE.Vector3();
  private tmpNdc = new THREE.Vector3();
  private tmpHeadNdc = new THREE.Vector3();
  private tmpFootNdc = new THREE.Vector3();
  private tmpCamFwd = new THREE.Vector3();
  private tmpToAnchor = new THREE.Vector3();

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.dataset.hud = 'enemy-tags';
    this.root.style.cssText =
      `position:fixed;inset:0;z-index:4;pointer-events:none;overflow:hidden;` +
      `user-select:none;-webkit-user-select:none;`;
    parent.appendChild(this.root);
  }

  private createEntry(botId: string, initialDist: number, nowMs: number): TagEntry {
    const el = document.createElement('div');
    el.dataset.enemyTag = botId;
    el.style.cssText =
      `position:absolute;left:0;top:0;display:none;flex-direction:column;align-items:center;` +
      `pointer-events:none;will-change:transform,opacity;transform-origin:50% 100%;`;

    const pillEl = document.createElement('div');
    pillEl.dataset.role = 'dist-pill';
    pillEl.style.cssText =
      `display:inline-flex;align-items:center;justify-content:center;gap:4px;` +
      `padding:2px 7px;border-radius:6px;box-sizing:border-box;white-space:nowrap;` +
      `background:${PALETTE.tagGlassBg};` +
      `border:1px solid ${PALETTE.tagBorderCyan};` +
      `box-shadow:inset 0 0 6px ${PALETTE.tagGlowCyan};` +
      `font-family:${MONO_FONT};font-size:12px;font-weight:500;line-height:1.2;` +
      `font-variant-numeric:tabular-nums;color:${PALETTE.tagText};`;

    // 4px circular indicator dot (empty text so parent .textContent stays strictly `^\d+m$`)
    const dotEl = document.createElement('span');
    dotEl.dataset.role = 'close-dot';
    dotEl.style.cssText =
      `display:none;width:4px;height:4px;border-radius:50%;flex:0 0 auto;` +
      `background:${PALETTE.tagBorderWarm};`;

    const textEl = document.createElement('span');
    textEl.dataset.role = 'dist-text';
    const text = `${initialDist}m`;
    textEl.textContent = text;

    pillEl.append(dotEl, textEl);

    // Minimalist HP bar: 42px × 3px, 4px directly below pill, zero border & zero shadow
    const hpTrackEl = document.createElement('div');
    hpTrackEl.dataset.role = 'hp-bar';
    hpTrackEl.style.cssText =
      `width:42px;height:3px;margin-top:4px;border-radius:0;overflow:hidden;` +
      `background:${PALETTE.tagHpTrack};border:none;box-shadow:none;box-sizing:border-box;`;

    const hpFillEl = document.createElement('div');
    hpFillEl.dataset.role = 'hp-fill';
    hpFillEl.style.cssText =
      `width:100%;height:100%;border-radius:0;border:none;box-shadow:none;` +
      `background:${PALETTE.tagHpHigh};`;

    hpTrackEl.appendChild(hpFillEl);
    el.append(pillEl, hpTrackEl);
    this.root.appendChild(el);

    return {
      el,
      pillEl,
      dotEl,
      textEl,
      hpTrackEl,
      hpFillEl,
      displayedDist: initialDist,
      lastDistUpdateMs: nowMs,
      lastText: text,
      lastCloseWarn: null,
      lastHpKey: '',
      smoothHeadOffsetY: 1.82,
      lastUpdateMs: nowMs,
      baseW: 46,
      baseH: 27,
      needsMeasure: true,
    };
  }

  /** Hide and remove all active overhead tags immediately. */
  clearAll(): void {
    for (const entry of this.entries.values()) {
      entry.el.remove();
    }
    this.entries.clear();
    this.telemetry.length = 0;
  }

  /** Drop one bot's tag immediately (e.g. on a kill outside the frame loop). */
  remove(botId: string): void {
    const entry = this.entries.get(botId);
    if (entry) {
      entry.el.remove();
      this.entries.delete(botId);
    }
    for (let i = this.telemetry.length - 1; i >= 0; i--) {
      if (this.telemetry[i].botId === botId) this.telemetry.splice(i, 1);
    }
  }

  private hideEntry(entry: TagEntry): void {
    if (entry.el.style.display !== 'none') {
      entry.el.style.display = 'none';
    }
    entry.el.dataset.visible = '0';
  }

  /** Project and update overhead distance+HP tags for live bots (max 5 nearest, <= 40m). */
  update(
    bots: readonly EnemyBot[],
    renderer: EnemyRenderer,
    camera: THREE.PerspectiveCamera,
    boxes: readonly Box[],
    nowMs: number,
    active: boolean,
  ): void {
    this.telemetry.length = 0;
    if (!active) {
      if (this.entries.size > 0) this.clearAll();
      return;
    }

    // Ensure camera matrices match the exact WebGL frame being rendered (eliminates pan jitter)
    camera.updateMatrixWorld(true);
    const vw = window.innerWidth || 844;
    const vh = window.innerHeight || 390;

    this.tmpCamFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const camPos = camera.position;
    const camVec = { x: camPos.x, y: camPos.y, z: camPos.z };

    const liveIds = new Set<string>();
    const candidates: Candidate[] = [];

    for (const bot of bots) {
      if (!bot.entity.alive || bot.state === 'DEAD') continue;
      liveIds.add(bot.id);

      const bp = bot.entity.pos;
      this.tmpCenter.set(bp.x, bp.y + 1.05, bp.z);
      const actualDist = camPos.distanceTo(this.tmpCenter);
      const roundedDist = Math.max(0, Math.round(actualDist));
      const hpRatio = Math.max(0, Math.min(1, bot.entity.hp / Math.max(1, bot.entity.maxHp)));

      let entry = this.entries.get(bot.id);
      if (!entry) {
        entry = this.createEntry(bot.id, roundedDist, nowMs);
        this.entries.set(bot.id, entry);
      } else if (nowMs - entry.lastDistUpdateMs >= TAG_DIST_UPDATE_MS) {
        entry.lastDistUpdateMs = nowMs;
        entry.displayedDist = roundedDist;
        const nextText = `${roundedDist}m`;
        if (nextText !== entry.lastText) {
          entry.lastText = nextText;
          entry.textEl.textContent = nextText;
          entry.needsMeasure = true;
        }
      }

      // Strictly hide beyond 40m
      if (actualDist > TAG_MAX_RANGE_M) {
        this.hideEntry(entry);
        entry.el.dataset.dist = String(entry.displayedDist);
        this.telemetry.push({
          botId: bot.id,
          faction: bot.faction,
          text: entry.lastText,
          displayedDist: entry.displayedDist,
          actualDist: Number(actualDist.toFixed(2)),
          hpRatio: Number(hpRatio.toFixed(3)),
          closeWarn: false,
          visible: false,
          occluded: false,
          opacity: 0,
          screenX: -999,
          screenY: -999,
          coversBodyRatio: 0,
        });
        continue;
      }

      // Smooth only vertical head-top height relative to entity feet so walk bob never jitters the tag
      // while crouch/stand transitions track smoothly and camera pan stays 100% locked with zero lag.
      if (!renderer.getHeadTopWorld(bot.id, this.tmpHeadTop)) {
        this.tmpHeadTop.set(bp.x, bp.y + 1.82, bp.z);
      }
      const rawHeadOffsetY = Math.max(1.05, Math.min(2.1, this.tmpHeadTop.y - bp.y));
      const dtSec = Math.max(0, Math.min(0.1, (nowMs - entry.lastUpdateMs) * 0.001));
      entry.lastUpdateMs = nowMs;
      entry.smoothHeadOffsetY +=
        (rawHeadOffsetY - entry.smoothHeadOffsetY) * (dtSec > 0 ? 1 - Math.exp(-8 * dtSec) : 1);

      const stableHeadY = bp.y + entry.smoothHeadOffsetY;
      this.tmpAnchor.set(bp.x, stableHeadY + TAG_HEAD_OFFSET_M, bp.z);

      // Behind camera check
      this.tmpToAnchor.subVectors(this.tmpAnchor, camPos);
      if (this.tmpToAnchor.dot(this.tmpCamFwd) <= 0.15) {
        this.hideEntry(entry);
        this.telemetry.push({
          botId: bot.id,
          faction: bot.faction,
          text: entry.lastText,
          displayedDist: entry.displayedDist,
          actualDist: Number(actualDist.toFixed(2)),
          hpRatio: Number(hpRatio.toFixed(3)),
          closeWarn: actualDist < TAG_CLOSE_WARN_M,
          visible: false,
          occluded: false,
          opacity: 0,
          screenX: -999,
          screenY: -999,
          coversBodyRatio: 0,
        });
        continue;
      }

      this.tmpNdc.copy(this.tmpAnchor).project(camera);
      if (this.tmpNdc.z < -1 || this.tmpNdc.z > 1) {
        this.hideEntry(entry);
        continue;
      }

      const sx = (this.tmpNdc.x * 0.5 + 0.5) * vw;
      const sy = (-this.tmpNdc.y * 0.5 + 0.5) * vh;

      // Off-screen cull
      if (sx < -40 || sx > vw + 40 || sy < -40 || sy > vh + 40) {
        this.hideEntry(entry);
        continue;
      }

      // Project head & feet to measure exact screen body height (so tag never covers > 1/3 body)
      this.tmpHeadNdc.set(bp.x, stableHeadY, bp.z).project(camera);
      this.tmpFoot.set(bp.x, bp.y, bp.z);
      this.tmpFootNdc.copy(this.tmpFoot).project(camera);
      const headSy = (-this.tmpHeadNdc.y * 0.5 + 0.5) * vh;
      const footSy = (-this.tmpFootNdc.y * 0.5 + 0.5) * vh;
      const bodyH = Math.max(16, footSy - headSy);

      // Raycast LOS check against map boxes (metadata + optional mild dimming if behind wall)
      const chestClear = hasLineOfSight(camVec, { x: bp.x, y: bp.y + 1.15, z: bp.z }, boxes);
      const headClear = hasLineOfSight(camVec, { x: bp.x, y: bp.y + 1.65, z: bp.z }, boxes);
      const occluded = !chestClear && !headClear;

      // Distance fade: >40m hidden (handled above), 25-40m -> 0.45, <25m -> 1.0
      const distOpacity = actualDist >= TAG_FADE_START_M ? TAG_FADE_OPACITY : 1;
      const opacity = occluded ? Math.min(distOpacity, 0.35) : distOpacity;

      candidates.push({
        bot,
        entry,
        actualDist,
        occluded,
        opacity,
        anchorX: sx,
        anchorY: sy,
        headSy,
        footSy,
        bodyH,
      });
    }

    // Sort strictly by distance ascending and keep ONLY the nearest 5 on screen
    candidates.sort((a, b) => a.actualDist - b.actualDist);

    // Track placed screen rects so farther tags never pile on top of closer tags
    const placed: { left: number; right: number; top: number; bottom: number }[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const { bot, entry } = c;
      const hpRatio = Math.max(0, Math.min(1, bot.entity.hp / Math.max(1, bot.entity.maxHp)));
      const closeWarn = c.actualDist < TAG_CLOSE_WARN_M;

      if (i >= TAG_MAX_VISIBLE) {
        this.hideEntry(entry);
        this.telemetry.push({
          botId: bot.id,
          faction: bot.faction,
          text: entry.lastText,
          displayedDist: entry.displayedDist,
          actualDist: Number(c.actualDist.toFixed(2)),
          hpRatio: Number(hpRatio.toFixed(3)),
          closeWarn,
          visible: false,
          occluded: c.occluded,
          opacity: 0,
          screenX: -999,
          screenY: -999,
          coversBodyRatio: 0,
        });
        continue;
      }

      // Apply <10m warm border + 4px indicator dot vs default cyan inner-glow border
      if (entry.lastCloseWarn !== closeWarn) {
        entry.lastCloseWarn = closeWarn;
        entry.pillEl.style.borderColor = closeWarn ? PALETTE.tagBorderWarm : PALETTE.tagBorderCyan;
        entry.pillEl.style.boxShadow = closeWarn
          ? `inset 0 0 6px ${PALETTE.tagGlowWarm}`
          : `inset 0 0 6px ${PALETTE.tagGlowCyan}`;
        entry.dotEl.style.display = closeWarn ? 'inline-block' : 'none';
        entry.el.dataset.closeWarn = closeWarn ? '1' : '0';
        entry.needsMeasure = true;
      }

      // Update minimalist 42×3 HP bar: cyan (>60%) -> yellow (30-60%) -> red (<=30%)
      const hpCol =
        hpRatio > 0.6 ? PALETTE.tagHpHigh : hpRatio > 0.3 ? PALETTE.tagHpMid : PALETTE.tagHpLow;
      const hpPct = (hpRatio * 100).toFixed(1);
      const hpKey = `${hpPct}|${hpCol}`;
      if (hpKey !== entry.lastHpKey) {
        entry.lastHpKey = hpKey;
        entry.hpFillEl.style.width = `${hpPct}%`;
        entry.hpFillEl.style.background = hpCol;
      }

      if (entry.el.style.display !== 'flex') {
        entry.el.style.display = 'flex';
      }
      if (entry.needsMeasure && entry.el.offsetWidth > 8) {
        entry.baseW = entry.el.offsetWidth;
        entry.baseH = entry.el.offsetHeight;
        entry.needsMeasure = false;
      }

      const hw = entry.baseW * 0.5;
      const tagH = entry.baseH;

      // Anchor bottom-center strictly above enemy head (never occluding body)
      let x = c.anchorX;
      let bottomY = Math.min(c.anchorY, c.headSy - 6);

      // Clamp inside viewport bounds
      x = Math.max(hw + 8, Math.min(vw - hw - 8, x));
      bottomY = Math.max(tagH + 8, Math.min(vh - 8, bottomY));

      // De-overlap against already-placed closer tags by lifting farther tag cleanly upward
      for (let pass = 0; pass < 3; pass++) {
        let nudged = false;
        const left = x - hw - 3;
        const right = x + hw + 3;
        const top = bottomY - tagH - 3;
        const botY = bottomY + 3;
        for (const p of placed) {
          if (left < p.right && p.left < right && top < p.bottom && p.top < botY) {
            const liftedBottom = p.top - 4;
            if (liftedBottom >= tagH + 8) {
              bottomY = liftedBottom;
              nudged = true;
            }
          }
        }
        if (!nudged) break;
      }

      // Guarantee tag NEVER occludes > 1/3 of the enemy's screen height (e.g. close-up near top edge):
      // if clamping pushed the tag down over the head/chest, slide it cleanly to the side instead.
      const overlapH = Math.max(0, Math.min(bottomY, c.footSy) - Math.max(bottomY - tagH, c.headSy));
      let coversBodyRatio = overlapH / c.bodyH;
      if (coversBodyRatio > 1 / 3) {
        const approxHalfBodyW = Math.max(20, c.bodyH * 0.22);
        const sideDir = x >= vw * 0.5 ? -1 : 1;
        const shiftedX = c.anchorX + sideDir * (approxHalfBodyW + hw + 10);
        if (shiftedX >= hw + 8 && shiftedX <= vw - hw - 8) {
          x = shiftedX;
          coversBodyRatio = 0;
        }
      }

      placed.push({ left: x - hw, right: x + hw, top: bottomY - tagH, bottom: bottomY });

      // Sub-pixel translate3d with bottom-center anchor (-50%, -100%) for zero pan jitter
      entry.el.style.opacity = String(c.opacity);
      entry.el.style.transform = `translate3d(${x.toFixed(2)}px,${bottomY.toFixed(2)}px,0) translate(-50%,-100%)`;
      entry.el.dataset.visible = '1';
      entry.el.dataset.dist = String(entry.displayedDist);
      entry.el.dataset.occluded = c.occluded ? '1' : '0';

      this.telemetry.push({
        botId: bot.id,
        faction: bot.faction,
        text: entry.lastText,
        displayedDist: entry.displayedDist,
        actualDist: Number(c.actualDist.toFixed(2)),
        hpRatio: Number(hpRatio.toFixed(3)),
        closeWarn,
        visible: true,
        occluded: c.occluded,
        opacity: c.opacity,
        screenX: Number(x.toFixed(1)),
        screenY: Number((bottomY - tagH * 0.5).toFixed(1)),
        coversBodyRatio: Number(coversBodyRatio.toFixed(3)),
      });
    }

    // Immediately remove DOM nodes for dead or despawned enemies
    for (const [id, entry] of this.entries) {
      if (!liveIds.has(id)) {
        entry.el.remove();
        this.entries.delete(id);
      }
    }
  }
}
