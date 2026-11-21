// Projected overhead enemy identification tags (DOM overlay, 0 WebGL draw calls):
//   - Format: `▣ 潜伏者 32m` (dark red bg) / `▣ 保卫者 18m` (tactical blue bg)
//   - Anchored strictly 0.35m above live Head top world position (tracks standing & crouch)
//   - Distance = straight-line metres from player camera to enemy (rounded integer), refreshed every 0.2s
//   - Hidden beyond 60m, behind camera, or immediately upon enemy death
//   - Occluded behind map cover (raycast LOS against MAP.boxes): opacity 0.25 (visible for tracking)
//   - Smooth monotonic near-big / far-small distance scaling (1.35x @ 4m -> 0.60x @ 60m)
//   - Never intrudes on the central 120px crosshair zone: automatically shifts outward

import * as THREE from 'three';
import { PALETTE } from './palette';
import { HUD_FONT } from './hud';
import { hasLineOfSight, type EnemyBot, type Faction } from '../game/ai';
import type { Box } from '../game/map';
import type { EnemyRenderer } from './enemies';

export const TAG_MAX_RANGE_M = 60;
export const TAG_DIST_UPDATE_MS = 200;
export const TAG_HEAD_OFFSET_M = 0.35;
export const TAG_OCCLUDED_OPACITY = 0.25;
export const TAG_CENTER_CLEAR_PX = 120;

export interface EnemyTagTelemetry {
  botId: string;
  faction: Faction;
  text: string;
  displayedDist: number;
  actualDist: number;
  visible: boolean;
  occluded: boolean;
  opacity: number;
  scale: number;
  screenX: number;
  screenY: number;
  outsideCenter120: boolean;
}

interface TagEntry {
  el: HTMLDivElement;
  faction: Faction;
  displayedDist: number;
  lastDistUpdateMs: number;
  lastText: string;
  baseW: number;
  baseH: number;
}

const FACTION_LABEL: Record<Faction, string> = {
  bl: '潜伏者',
  gr: '保卫者',
};

const TAG_FONT = `${HUD_FONT},'PingFang SC','Microsoft YaHei',sans-serif`;

export class EnemyTagOverlay {
  readonly root: HTMLDivElement;
  readonly telemetry: EnemyTagTelemetry[] = [];

  private entries = new Map<string, TagEntry>();
  private tmpHeadTop = new THREE.Vector3();
  private tmpAnchor = new THREE.Vector3();
  private tmpCenter = new THREE.Vector3();
  private tmpNdc = new THREE.Vector3();
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

  private createEntry(botId: string, faction: Faction, initialDist: number, nowMs: number): TagEntry {
    const el = document.createElement('div');
    const isBL = faction === 'bl';
    el.dataset.enemyTag = botId;
    el.dataset.faction = faction;
    el.style.cssText =
      `position:absolute;left:0;top:0;display:none;pointer-events:none;white-space:nowrap;` +
      `font-family:${TAG_FONT};font-size:12px;font-weight:800;letter-spacing:0.04em;line-height:1.2;` +
      `color:#f4f7fa;padding:2px 8px;border-radius:4px;box-sizing:border-box;` +
      `background:${isBL ? PALETTE.blTagBg : PALETTE.grTagBg};` +
      `border:1px solid ${isBL ? PALETTE.blTagBorder : PALETTE.grTagBorder};` +
      `box-shadow:0 2px 6px rgba(0,0,0,0.48);text-shadow:0 1px 2px rgba(0,0,0,0.65);` +
      `will-change:transform,opacity;transform-origin:center center;`;
    const text = `▣ ${FACTION_LABEL[faction]} ${initialDist}m`;
    el.textContent = text;
    this.root.appendChild(el);
    return {
      el,
      faction,
      displayedDist: initialDist,
      lastDistUpdateMs: nowMs,
      lastText: text,
      baseW: 96,
      baseH: 22,
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

  /** Project and update overhead tags for all live bots. */
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

    camera.updateMatrixWorld();
    const vw = window.innerWidth || 844;
    const vh = window.innerHeight || 390;
    const cx = vw * 0.5;
    const cy = vh * 0.5;
    const halfClear = TAG_CENTER_CLEAR_PX * 0.5;

    this.tmpCamFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const camPos = camera.position;
    const camVec = { x: camPos.x, y: camPos.y, z: camPos.z };

    const liveIds = new Set<string>();

    for (const bot of bots) {
      // Immediately disappear when enemy dies
      if (!bot.entity.alive || bot.state === 'DEAD') continue;
      liveIds.add(bot.id);

      const bp = bot.entity.pos;
      this.tmpCenter.set(bp.x, bp.y + 1.1, bp.z);
      const actualDist = camPos.distanceTo(this.tmpCenter);
      const roundedDist = Math.round(actualDist);

      let entry = this.entries.get(bot.id);
      if (!entry) {
        entry = this.createEntry(bot.id, bot.faction, roundedDist, nowMs);
        this.entries.set(bot.id, entry);
      } else if (nowMs - entry.lastDistUpdateMs >= TAG_DIST_UPDATE_MS) {
        entry.lastDistUpdateMs = nowMs;
        entry.displayedDist = roundedDist;
        const nextText = `▣ ${FACTION_LABEL[bot.faction]} ${roundedDist}m`;
        if (nextText !== entry.lastText) {
          entry.lastText = nextText;
          entry.el.textContent = nextText;
        }
      }

      // Hide strictly when beyond 60m
      if (actualDist > TAG_MAX_RANGE_M) {
        entry.el.style.display = 'none';
        entry.el.dataset.visible = '0';
        entry.el.dataset.dist = String(entry.displayedDist);
        this.telemetry.push({
          botId: bot.id,
          faction: bot.faction,
          text: entry.lastText,
          displayedDist: entry.displayedDist,
          actualDist,
          visible: false,
          occluded: false,
          opacity: 0,
          scale: 0,
          screenX: -999,
          screenY: -999,
          outsideCenter120: true,
        });
        continue;
      }

      // Anchor strictly 0.35m above live Head top world position
      if (!renderer.getHeadTopWorld(bot.id, this.tmpHeadTop)) {
        this.tmpHeadTop.set(bp.x, bp.y + 1.8, bp.z);
      }
      this.tmpAnchor.set(this.tmpHeadTop.x, this.tmpHeadTop.y + TAG_HEAD_OFFSET_M, this.tmpHeadTop.z);

      // Behind camera check
      this.tmpToAnchor.subVectors(this.tmpAnchor, camPos);
      const frontDot = this.tmpToAnchor.dot(this.tmpCamFwd);
      if (frontDot <= 0.15) {
        entry.el.style.display = 'none';
        entry.el.dataset.visible = '0';
        this.telemetry.push({
          botId: bot.id,
          faction: bot.faction,
          text: entry.lastText,
          displayedDist: entry.displayedDist,
          actualDist,
          visible: false,
          occluded: false,
          opacity: 0,
          scale: 0,
          screenX: -999,
          screenY: -999,
          outsideCenter120: true,
        });
        continue;
      }

      this.tmpNdc.copy(this.tmpAnchor).project(camera);
      if (this.tmpNdc.z < -1 || this.tmpNdc.z > 1) {
        entry.el.style.display = 'none';
        entry.el.dataset.visible = '0';
        continue;
      }

      let sx = (this.tmpNdc.x * 0.5 + 0.5) * vw;
      let sy = (-this.tmpNdc.y * 0.5 + 0.5) * vh;

      // Off-screen cull
      if (sx < -100 || sx > vw + 100 || sy < -60 || sy > vh + 60) {
        entry.el.style.display = 'none';
        entry.el.dataset.visible = '0';
        continue;
      }

      // Near-big / far-small monotonic scale across 4m..60m
      const clampedD = Math.max(4, Math.min(TAG_MAX_RANGE_M, actualDist));
      const scale = 1.35 - ((clampedD - 4) / (TAG_MAX_RANGE_M - 4)) * 0.75;

      // Raycast occlusion check against map cover boxes (chest & head)
      const chestClear = hasLineOfSight(camVec, { x: bp.x, y: bp.y + 1.15, z: bp.z }, boxes);
      const headClear = hasLineOfSight(camVec, { x: bp.x, y: bp.y + 1.65, z: bp.z }, boxes);
      const occluded = !chestClear && !headClear;
      const opacity = occluded ? TAG_OCCLUDED_OPACITY : 1;

      if (entry.el.style.display !== 'block') {
        entry.el.style.display = 'block';
      }
      if (entry.el.offsetWidth > 10) {
        entry.baseW = entry.el.offsetWidth;
        entry.baseH = entry.el.offsetHeight;
      }

      const hw = entry.baseW * 0.5 * scale;
      const hh = entry.baseH * 0.5 * scale;

      // Keep tag completely outside the central 120×120px crosshair clear zone
      const inCenterX = Math.abs(sx - cx) < halfClear + hw;
      const inCenterY = Math.abs(sy - cy) < halfClear + hh;
      if (inCenterX && inCenterY) {
        const upY = cy - halfClear - hh - 4;
        const downY = cy + halfClear + hh + 4;
        if (sy <= cy + 16 && upY >= hh + 8) {
          sy = upY;
        } else if (downY <= vh - hh - 8) {
          sy = downY;
        } else {
          const side = sx >= cx ? 1 : -1;
          sx = cx + side * (halfClear + hw + 6);
        }
      }

      // Keep inside viewport bounds
      sx = Math.max(hw + 6, Math.min(vw - hw - 6, sx));
      sy = Math.max(hh + 6, Math.min(vh - hh - 6, sy));

      const outsideCenter120 =
        Math.abs(sx - cx) >= halfClear + hw - 1 || Math.abs(sy - cy) >= halfClear + hh - 1;

      entry.el.style.opacity = String(opacity);
      entry.el.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      entry.el.dataset.visible = '1';
      entry.el.dataset.dist = String(entry.displayedDist);
      entry.el.dataset.occluded = occluded ? '1' : '0';

      this.telemetry.push({
        botId: bot.id,
        faction: bot.faction,
        text: entry.lastText,
        displayedDist: entry.displayedDist,
        actualDist: Number(actualDist.toFixed(2)),
        visible: true,
        occluded,
        opacity,
        scale: Number(scale.toFixed(3)),
        screenX: Number(sx.toFixed(1)),
        screenY: Number(sy.toFixed(1)),
        outsideCenter120,
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
