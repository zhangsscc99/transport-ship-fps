// CF-style AI enemy state machine — pure logic, zero three.js / DOM.
// Uses preset deck waypoints + raycast line-of-sight & whisker avoidance (no navmesh).
//
// States: IDLE -> PATROL -> ALERT -> CHASE -> ENGAGE -> COVER -> DEAD
// Detection: 100° FOV / 40m vision cone + raycast LOS + hearing (60m gunshot, 12m footsteps).
// Firing: 3-round bursts, probability + distance attenuation (no bullet entities),
// STRICTLY blocked without clear raycast LOS (never shoots through walls).
// Simultaneous cap <= 5 enemies on field; dead enemies replenish according to difficulty.

import { createEntity, type Entity } from './entities';
import { rayBoxT } from './damage';
import type { Box, Vec2 } from './map';
import type { CollisionWorld } from './collision';
import type { Vec3 } from './player';
import { getDifficultySpec, type DifficultyId, type DifficultySpec } from './difficulty';

export type Faction = 'bl' | 'gr'; // bl = 潜伏者 (Black List), gr = 保卫者 (Global Risk)

export type AiState = 'IDLE' | 'PATROL' | 'ALERT' | 'CHASE' | 'ENGAGE' | 'COVER' | 'DEAD';

export type EnemyAnim = 'breathe' | 'walk' | 'aim' | 'fire' | 'hit' | 'dead';

export interface EnemyShotEvent {
  botId: string;
  faction: Faction;
  origin: Vec3;
  target: Vec3;
  hit: boolean;
  damage: number;
  dist: number;
}

export interface EnemyBot {
  id: string;
  slotIndex: number;
  faction: Faction;
  entity: Entity;
  state: AiState;
  yaw: number;
  /** horizontal velocity for animation cadence */
  speed: number;
  ammo: number;
  mag: number;
  shotsFired: number;
  reloadingUntil: number;
  /** current patrol waypoint index */
  waypointIdx: number;
  /** idle / pause timer (ms timestamp) */
  stateUntil: number;
  /** timestamp when bot first acquired continuous LOS to player (-1 if none) */
  sightAcquiredAt: number;
  /** timestamp of first shot fired after spotting player (-1 if none yet) */
  firstShotAt: number;
  /** timestamp of first sight ever (for e2e reaction-delay verification) */
  firstSightAt: number;
  /** whether bot currently has unobstructed raycast LOS to player */
  hasLos: boolean;
  /** last known player position */
  lastSeenPos: Vec3 | null;
  lastSeenAt: number;
  /** active 3-round burst tracking */
  burstRemaining: number;
  nextBurstShotAt: number;
  nextBurstStartAt: number;
  /** strafe / flank side (+1 or -1) */
  flankSign: 1 | -1;
  strafeSwitchAt: number;
  /** cover target while in COVER state */
  coverTarget: Vec2 | null;
  /** animation timestamps (ms) */
  lastFireAt: number;
  lastHitAt: number;
  diedAt: number;
  /** corpse removal / replacement timer (ms) */
  replaceAt: number;
  /** derived animation clip name */
  anim: EnemyAnim;
  /** walk stride phase (radians) */
  walkPhase: number;
}

export const BOT_RADIUS = 0.38;
export const BOT_HEIGHT = 1.75;
export const BOT_EYE_Y = 1.56;
export const BOT_MAG = 30;
export const BOT_RELOAD_MS = 1600;
export const VISION_FOV_DEG = 100;
export const VISION_COS_HALF = Math.cos(((VISION_FOV_DEG * 0.5) * Math.PI) / 180); // cos(50°)
export const VISION_RANGE = 40;
export const HEAR_SHOT_RANGE = 60;
export const HEAR_STEP_RANGE = 12;
export const ENGAGE_MIN_DIST = 8;
export const ENGAGE_MAX_DIST = 14;
export const BURST_ROUNDS = 3;
export const BURST_SHOT_GAP_MS = 135;

/** Verified open-deck patrol waypoints on the 64×40m transport ship (all clear of boxes). */
export const PATROL_WAYPOINTS: readonly Vec2[] = [
  { x: -16, z: -15.5 }, // 0: NW deck
  { x: -4, z: -15.5 },  // 1: N-mid-W
  { x: 6, z: -15.5 },   // 2: N-mid-E
  { x: 18, z: -15.5 },  // 3: NE deck
  { x: -20, z: -7.5 },  // 4: W upper lane
  { x: -8, z: -8.0 },   // 5: mid-NW alley
  { x: 0, z: -7.5 },    // 6: center north
  { x: 18, z: -7.5 },   // 7: E upper lane
  { x: -21, z: 0 },     // 8: W flank mid
  { x: -11, z: 0 },     // 9: W mid deck
  { x: 0, z: 0 },       // 10: ship center
  { x: 11, z: 0 },      // 11: E mid deck
  { x: 21, z: 0 },      // 12: E flank mid
  { x: -18, z: 7.5 },   // 13: W lower lane
  { x: 0, z: 7.5 },     // 14: center south
  { x: 8, z: 8.0 },     // 15: mid-SE alley
  { x: 19, z: 7.5 },    // 16: E lower lane
  { x: -16, z: 15.5 },  // 17: SW deck
  { x: 14, z: 15.5 },   // 18: SE deck
];

/** Connected waypoint adjacency graph for smooth deck patrolling without navmesh. */
const WP_NEIGHBORS: readonly (readonly number[])[] = [
  [1, 4],          // 0
  [0, 2, 5, 6],    // 1
  [1, 3, 6],       // 2
  [2, 7],          // 3
  [0, 5, 8],       // 4
  [1, 4, 6, 9],    // 5
  [1, 2, 5, 10],   // 6
  [3, 12],         // 7
  [4, 9, 13],      // 8
  [5, 8, 10],      // 9
  [6, 9, 11, 14],  // 10
  [10, 12, 15],    // 11
  [7, 11, 16],     // 12
  [8, 17],         // 13
  [10, 15],        // 14
  [11, 14, 16, 18],// 15
  [12, 15, 18],    // 16
  [13],            // 17
  [15, 16],        // 18
];

/** Tactical cover positions tucked alongside deck containers (all verified box-free). */
export const COVER_SPOTS: readonly Vec2[] = [
  { x: -6, z: -6.8 },   // north behind container (-6,-4)
  { x: -6, z: -1.4 },   // south behind container (-6,-4)
  { x: 6, z: 1.4 },     // north behind container (6,4)
  { x: 6, z: 6.8 },     // south behind container (6,4)
  { x: -18.8, z: 2 },   // west behind container (-16,2)
  { x: -13.2, z: 2 },   // east behind container (-16,2)
  { x: 18.8, z: -2 },   // east behind container (16,-2)
  { x: 13.2, z: -2 },   // west behind container (16,-2)
  { x: 4, z: -13.8 },   // north behind container (4,-11)
  { x: 12, z: -13.8 },  // north behind container (12,-11)
  { x: -12, z: 13.8 },  // south behind container (-12,11)
  { x: -4, z: 13.8 },   // south behind container (-4,11)
];

/** Enemy spawn spots (north / mid-north side away from player spawn at z=+17). */
export const ENEMY_SPAWNS: readonly Vec2[] = [
  { x: -14, z: -15.5 },
  { x: -4, z: -15.5 },
  { x: 6, z: -15.5 },
  { x: 16, z: -15.5 },
  { x: -20, z: -7.5 },
  { x: 18, z: -7.5 },
  { x: 0, z: -15.5 },
];

/** Raycast visibility check between two 3D points against MAP.boxes. */
export function hasLineOfSight(from: Vec3, to: Vec3, boxes: readonly Box[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const dir: Vec3 = { x: dx / dist, y: dy / dist, z: dz / dist };
  for (const b of boxes) {
    if (b.kind === 'deck') continue;
    const t = rayBoxT(from, dir, b);
    if (t < dist - 0.15) return false;
  }
  return true;
}

/** Normalize angle to (-PI, PI]. */
function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Smooth angular turn toward target yaw at maxTurnRate (rad/s). */
function turnToward(current: number, target: number, maxStep: number): number {
  const diff = wrapPi(target - current);
  if (Math.abs(diff) <= maxStep) return wrapPi(target);
  return wrapPi(current + Math.sign(diff) * maxStep);
}

/** Yaw facing along (dx, dz) using the same convention as Player (yaw=0 -> -Z). */
export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Distance attenuation for enemy hit probability (1.0 within 12m, tapering to 0.35 at 50m). */
export function enemyHitAttenuation(dist: number): number {
  if (dist <= 12) return 1.0;
  return Math.max(0.35, 1 - (dist - 12) / 58);
}

export interface EnemyUpdateContext {
  dt: number;
  nowMs: number;
  playerPos: Vec3;
  playerEye: Vec3;
  playerAlive: boolean;
  /** True on frames where the player fired a weapon (60m hearing radius). */
  playerFired: boolean;
  /** Player horizontal speed (m/s) for 12m footstep hearing. */
  playerSpeed: number;
  playerOnGround: boolean;
  boxes: readonly Box[];
  collider: CollisionWorld;
}

export class EnemyManager {
  readonly bots: EnemyBot[] = [];
  readonly entities: Entity[] = [];
  difficulty: DifficultySpec;
  private rng: () => number;
  private nextBotSeq = 1;
  private factionBalance = 0;

  constructor(diffId: DifficultyId = 'normal', rng: () => number = Math.random) {
    this.difficulty = getDifficultySpec(diffId);
    this.rng = rng;
  }

  setDifficulty(diffId: DifficultyId): void {
    this.difficulty = getDifficultySpec(diffId);
  }

  /** Reset and spawn a fresh wave matching the active difficulty (cap <= 5 simultaneous). */
  reset(nowMs: number, playerPos: Vec3): void {
    this.bots.length = 0;
    this.entities.length = 0;
    this.factionBalance = 0;
    const count = Math.min(5, this.difficulty.maxSimultaneous);
    for (let i = 0; i < count; i++) {
      this.spawnIntoSlot(i, nowMs, playerPos);
    }
  }

  /** Deterministic helper for e2e & unit tests: clear all bots. */
  clear(): void {
    this.bots.length = 0;
    this.entities.length = 0;
  }

  /** Deterministic helper for e2e & unit tests: spawn a specific bot at (x, z, yaw). */
  spawnManual(
    x: number,
    z: number,
    yaw = 0,
    faction?: Faction,
    nowMs = 0,
  ): EnemyBot {
    const f = faction ?? this.pickFaction();
    const slot = this.bots.length;
    const id = `bot-${this.nextBotSeq++}`;
    const ent = createEntity(id, { x, y: 0, z }, 100, BOT_RADIUS, BOT_HEIGHT);
    const bot: EnemyBot = {
      id,
      slotIndex: slot,
      faction: f,
      entity: ent,
      state: 'IDLE',
      yaw,
      speed: 0,
      ammo: BOT_MAG,
      mag: BOT_MAG,
      shotsFired: 0,
      reloadingUntil: 0,
      waypointIdx: this.nearestWaypoint(x, z),
      stateUntil: nowMs + 800,
      sightAcquiredAt: -1,
      firstShotAt: -1,
      firstSightAt: -1,
      hasLos: false,
      lastSeenPos: null,
      lastSeenAt: 0,
      burstRemaining: 0,
      nextBurstShotAt: 0,
      nextBurstStartAt: 0,
      flankSign: slot % 2 === 0 ? 1 : -1,
      strafeSwitchAt: nowMs + 1600,
      coverTarget: null,
      lastFireAt: -10000,
      lastHitAt: -10000,
      diedAt: -10000,
      replaceAt: -1,
      anim: 'breathe',
      walkPhase: this.rng() * Math.PI * 2,
    };
    this.bots.push(bot);
    this.entities.push(ent);
    return bot;
  }

  /** Random CF faction assignment ('bl' 潜伏者 / 'gr' 保卫者), avoiding mono-faction streaks. */
  private pickFaction(): Faction {
    let f: Faction = this.rng() < 0.5 ? 'bl' : 'gr';
    if (this.factionBalance >= 2) f = 'gr';
    else if (this.factionBalance <= -2) f = 'bl';
    this.factionBalance += f === 'bl' ? 1 : -1;
    return f;
  }

  private nearestWaypoint(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < PATROL_WAYPOINTS.length; i++) {
      const wp = PATROL_WAYPOINTS[i];
      const d = (wp.x - x) ** 2 + (wp.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Pick an enemy spawn point clear of player & other active bots. */
  private pickSpawn(playerPos: Vec3, slotIndex: number): Vec2 {
    let best = ENEMY_SPAWNS[slotIndex % ENEMY_SPAWNS.length];
    let bestScore = -Infinity;
    for (let i = 0; i < ENEMY_SPAWNS.length; i++) {
      const sp = ENEMY_SPAWNS[(i + slotIndex) % ENEMY_SPAWNS.length];
      const dPlayer = Math.hypot(sp.x - playerPos.x, sp.z - playerPos.z);
      let minBotD = 12;
      for (const b of this.bots) {
        if (!b.entity.alive) continue;
        const db = Math.hypot(sp.x - b.entity.pos.x, sp.z - b.entity.pos.z);
        if (db < minBotD) minBotD = db;
      }
      const score = Math.min(dPlayer, 35) + minBotD * 2.2 + this.rng() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    return best;
  }

  private spawnIntoSlot(slotIndex: number, nowMs: number, playerPos: Vec3): EnemyBot {
    const sp = this.pickSpawn(playerPos, slotIndex);
    const id = `bot-${this.nextBotSeq++}`;
    const ent = createEntity(id, { x: sp.x, y: 0, z: sp.z }, 100, BOT_RADIUS, BOT_HEIGHT);
    const yaw = yawFromDir(playerPos.x - sp.x, playerPos.z - sp.z);
    const bot: EnemyBot = {
      id,
      slotIndex,
      faction: this.pickFaction(),
      entity: ent,
      state: 'PATROL',
      yaw,
      speed: 0,
      ammo: BOT_MAG,
      mag: BOT_MAG,
      shotsFired: 0,
      reloadingUntil: 0,
      waypointIdx: this.nearestWaypoint(sp.x, sp.z),
      stateUntil: nowMs + 600 + this.rng() * 800,
      sightAcquiredAt: -1,
      firstShotAt: -1,
      firstSightAt: -1,
      hasLos: false,
      lastSeenPos: null,
      lastSeenAt: 0,
      burstRemaining: 0,
      nextBurstShotAt: 0,
      nextBurstStartAt: nowMs + 400,
      flankSign: slotIndex % 2 === 0 ? 1 : -1,
      strafeSwitchAt: nowMs + 1400 + this.rng() * 1200,
      coverTarget: null,
      lastFireAt: -10000,
      lastHitAt: -10000,
      diedAt: -10000,
      replaceAt: -1,
      anim: 'walk',
      walkPhase: this.rng() * Math.PI * 2,
    };
    if (slotIndex < this.bots.length) {
      this.bots[slotIndex] = bot;
      this.entities[slotIndex] = ent;
    } else {
      this.bots.push(bot);
      this.entities.push(ent);
    }
    return bot;
  }

  /** Notify bot that it was hit by the player (triggers flinch, death transition & alert). */
  onBotDamaged(entity: Entity, attackerPos: Vec3, nowMs: number): EnemyBot | null {
    const bot = this.bots.find((b) => b.entity === entity);
    if (!bot) return null;
    bot.lastHitAt = nowMs;
    if (!entity.alive) {
      bot.state = 'DEAD';
      bot.diedAt = nowMs;
      bot.replaceAt = nowMs + this.difficulty.respawnDelayMs;
      bot.burstRemaining = 0;
      bot.speed = 0;
      bot.anim = 'dead';
      return bot;
    }
    // Wounded bot immediately knows where fire came from
    bot.lastSeenPos = { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z };
    bot.lastSeenAt = nowMs;
    if (bot.state === 'IDLE' || bot.state === 'PATROL') {
      bot.state = 'ALERT';
      bot.stateUntil = nowMs + this.difficulty.reactionMs;
    }
    // Retreat to cover when HP < 30% on NORMAL / HARD
    if (
      this.difficulty.canTakeCover &&
      entity.hp < entity.maxHp * 0.3 &&
      bot.state !== 'COVER'
    ) {
      bot.state = 'COVER';
      bot.coverTarget = null;
      bot.stateUntil = nowMs + 2800;
    }
    return bot;
  }

  /** Advance all AI bots one simulation step; returns shots fired this frame. */
  update(ctx: EnemyUpdateContext): EnemyShotEvent[] {
    const shots: EnemyShotEvent[] = [];
    const { dt, nowMs, playerPos, playerEye, playerAlive, boxes, collider } = ctx;
    const diff = this.difficulty;

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const ent = bot.entity;

      // --- DEAD state & replenishment ---
      if (!ent.alive || bot.state === 'DEAD') {
        bot.state = 'DEAD';
        bot.speed = 0;
        bot.anim = 'dead';
        if (bot.replaceAt > 0 && nowMs >= bot.replaceAt) {
          this.spawnIntoSlot(bot.slotIndex, nowMs, playerPos);
        }
        continue;
      }

      // Reload completion
      if (bot.reloadingUntil > 0 && nowMs >= bot.reloadingUntil) {
        bot.ammo = bot.mag;
        bot.reloadingUntil = 0;
      }

      const botEye: Vec3 = { x: ent.pos.x, y: ent.pos.y + BOT_EYE_Y, z: ent.pos.z };
      const toPx = playerPos.x - ent.pos.x;
      const toPz = playerPos.z - ent.pos.z;
      const dist = Math.hypot(toPx, toPz);

      // --- Sensory Perception: 100°/40m vision cone + raycast LOS + hearing ---
      let canSee = false;
      let clearLos = false;
      if (playerAlive && dist <= VISION_RANGE) {
        clearLos = hasLineOfSight(botEye, playerEye, boxes);
        if (clearLos) {
          const fwdX = -Math.sin(bot.yaw);
          const fwdZ = -Math.cos(bot.yaw);
          const dot = dist > 1e-4 ? (toPx * fwdX + toPz * fwdZ) / dist : 1;
          // In ALERT/ENGAGE/CHASE/COVER bots track across wider peripheral awareness;
          // in IDLE/PATROL strict 100° vision cone applies.
          const inCone = dot >= VISION_COS_HALF || dist < 3.5;
          const alreadyAware =
            bot.state === 'ALERT' || bot.state === 'CHASE' || bot.state === 'ENGAGE';
          if (inCone || alreadyAware) canSee = true;
        }
      }

      const heardShot = playerAlive && ctx.playerFired && dist <= HEAR_SHOT_RANGE;
      const heardStep =
        playerAlive && ctx.playerOnGround && ctx.playerSpeed > 1.2 && dist <= HEAR_STEP_RANGE;

      bot.hasLos = canSee && clearLos;
      if (bot.hasLos) {
        if (bot.sightAcquiredAt < 0) bot.sightAcquiredAt = nowMs;
        if (bot.firstSightAt < 0) bot.firstSightAt = nowMs;
        bot.lastSeenPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
        bot.lastSeenAt = nowMs;
      } else {
        bot.sightAcquiredAt = -1;
        bot.burstRemaining = 0;
      }

      if ((heardShot || heardStep) && !bot.hasLos) {
        bot.lastSeenPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
        bot.lastSeenAt = nowMs;
        if (bot.state === 'IDLE' || bot.state === 'PATROL') {
          bot.state = 'ALERT';
          bot.stateUntil = nowMs + Math.max(diff.reactionMs, 650);
        }
      }

      // Low HP cover trigger (NORMAL / HARD only)
      if (
        diff.canTakeCover &&
        ent.hp < ent.maxHp * 0.3 &&
        bot.state !== 'COVER' &&
        bot.state !== 'IDLE' &&
        bot.state !== 'PATROL'
      ) {
        bot.state = 'COVER';
        bot.coverTarget = this.pickCoverSpot(ent.pos, playerEye, boxes);
        bot.stateUntil = nowMs + 2600;
      }

      // --- State Transitions & Movement Intent ---
      let moveTargetX: number | null = null;
      let moveTargetZ: number | null = null;
      let desiredSpeed = 0;
      let lookTargetYaw = bot.yaw;

      if (!playerAlive && bot.state !== 'IDLE' && bot.state !== 'PATROL') {
        bot.state = 'PATROL';
        bot.burstRemaining = 0;
        bot.sightAcquiredAt = -1;
      }

      switch (bot.state) {
        case 'IDLE': {
          desiredSpeed = 0;
          if (bot.hasLos) {
            bot.state = 'ALERT';
            bot.stateUntil = nowMs + diff.reactionMs;
          } else if (nowMs >= bot.stateUntil) {
            bot.state = 'PATROL';
            bot.waypointIdx = this.pickNextWaypoint(bot.waypointIdx);
          }
          break;
        }

        case 'PATROL': {
          if (bot.hasLos) {
            bot.state = 'ALERT';
            bot.stateUntil = nowMs + diff.reactionMs;
            break;
          }
          const wp = PATROL_WAYPOINTS[bot.waypointIdx] ?? PATROL_WAYPOINTS[0];
          const wd = Math.hypot(wp.x - ent.pos.x, wp.z - ent.pos.z);
          if (wd < 1.1) {
            bot.state = 'IDLE';
            bot.stateUntil = nowMs + 600 + this.rng() * 900;
            desiredSpeed = 0;
          } else {
            moveTargetX = wp.x;
            moveTargetZ = wp.z;
            desiredSpeed = diff.moveSpeed * 0.72;
            lookTargetYaw = yawFromDir(wp.x - ent.pos.x, wp.z - ent.pos.z);
          }
          break;
        }

        case 'ALERT': {
          desiredSpeed = 0;
          const target = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (target) {
            lookTargetYaw = yawFromDir(target.x - ent.pos.x, target.z - ent.pos.z);
          }
          if (bot.hasLos) {
            // Wait exact difficulty reactionMs before opening fire / engaging!
            if (nowMs - bot.sightAcquiredAt >= diff.reactionMs) {
              bot.state = dist <= ENGAGE_MAX_DIST + 4 ? 'ENGAGE' : 'CHASE';
            }
          } else if (nowMs >= bot.stateUntil) {
            if (bot.lastSeenPos && nowMs - bot.lastSeenAt < 6500) {
              bot.state = 'CHASE';
            } else {
              bot.state = 'PATROL';
            }
          }
          break;
        }

        case 'CHASE': {
          if (bot.hasLos && dist <= ENGAGE_MAX_DIST && nowMs - bot.sightAcquiredAt >= diff.reactionMs) {
            bot.state = 'ENGAGE';
            break;
          }
          const goal = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (!goal || (!bot.hasLos && nowMs - bot.lastSeenAt > 7500)) {
            bot.state = 'PATROL';
            bot.waypointIdx = this.nearestWaypoint(ent.pos.x, ent.pos.z);
            break;
          }
          let tx = goal.x;
          let tz = goal.z;
          // HARD pair flanking: approach from opposite ±38° wings around target!
          if (diff.flankPairs && dist > 6) {
            const ang = Math.atan2(ent.pos.z - goal.z, ent.pos.x - goal.x) + bot.flankSign * 0.65;
            tx = goal.x + Math.cos(ang) * Math.max(8, dist * 0.65);
            tz = goal.z + Math.sin(ang) * Math.max(8, dist * 0.65);
          }
          const dGoal = Math.hypot(tx - ent.pos.x, tz - ent.pos.z);
          if (dGoal < 1.4 && !bot.hasLos) {
            // Reached last known position and player is gone → return to patrol
            bot.lastSeenPos = null;
            bot.state = 'PATROL';
            bot.waypointIdx = this.nearestWaypoint(ent.pos.x, ent.pos.z);
          } else {
            moveTargetX = tx;
            moveTargetZ = tz;
            desiredSpeed = diff.moveSpeed;
            lookTargetYaw = yawFromDir(goal.x - ent.pos.x, goal.z - ent.pos.z);
          }
          break;
        }

        case 'ENGAGE': {
          if (!bot.hasLos) {
            bot.burstRemaining = 0;
            bot.state = 'CHASE';
            break;
          }
          lookTargetYaw = yawFromDir(toPx, toPz);

          // Maintain 8–14m engagement distance + tactical side-strafe
          if (nowMs >= bot.strafeSwitchAt) {
            bot.flankSign = bot.flankSign === 1 ? -1 : 1;
            bot.strafeSwitchAt = nowMs + 1300 + this.rng() * 1100;
          }
          const ux = dist > 1e-4 ? toPx / dist : 0;
          const uz = dist > 1e-4 ? toPz / dist : -1;
          const rx = -uz * bot.flankSign;
          const rz = ux * bot.flankSign;

          let mx = rx * 0.75;
          let mz = rz * 0.75;
          if (dist > ENGAGE_MAX_DIST) {
            mx += ux * 0.85;
            mz += uz * 0.85;
          } else if (dist < ENGAGE_MIN_DIST) {
            mx -= ux * 0.7;
            mz -= uz * 0.7;
          }
          moveTargetX = ent.pos.x + mx * 3;
          moveTargetZ = ent.pos.z + mz * 3;
          desiredSpeed = diff.moveSpeed * 0.62;

          // --- 3-round burst firing (STRICT LOS + reaction delay guard) ---
          const reactionMet =
            bot.sightAcquiredAt >= 0 && nowMs - bot.sightAcquiredAt >= diff.reactionMs;
          const canShoot =
            bot.hasLos &&
            reactionMet &&
            bot.reloadingUntil === 0 &&
            hasLineOfSight(botEye, playerEye, boxes);

          if (canShoot) {
            if (bot.ammo <= 0) {
              bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
              bot.burstRemaining = 0;
            } else if (bot.burstRemaining === 0 && nowMs >= bot.nextBurstStartAt) {
              bot.burstRemaining = Math.min(BURST_ROUNDS, bot.ammo);
              bot.nextBurstShotAt = nowMs;
            }
            if (bot.burstRemaining > 0 && nowMs >= bot.nextBurstShotAt) {
              // Double-verify LOS right on shot frame (never shoot through walls)
              if (hasLineOfSight(botEye, playerEye, boxes)) {
                bot.ammo--;
                bot.shotsFired++;
                bot.burstRemaining--;
                bot.lastFireAt = nowMs;
                if (bot.firstShotAt < 0) bot.firstShotAt = nowMs;
                bot.nextBurstShotAt = nowMs + BURST_SHOT_GAP_MS;
                if (bot.burstRemaining === 0) {
                  bot.nextBurstStartAt = nowMs + 850 + this.rng() * 550;
                }

                const pHit = diff.hitRate * enemyHitAttenuation(dist);
                const hit = this.rng() < pHit;
                // Muzzle origin offset slightly forward & right of bot chest
                const fwdX = -Math.sin(bot.yaw);
                const fwdZ = -Math.cos(bot.yaw);
                const muzzle: Vec3 = {
                  x: ent.pos.x + fwdX * 0.55 + -fwdZ * 0.14,
                  y: ent.pos.y + 1.38,
                  z: ent.pos.z + fwdZ * 0.55 + fwdX * 0.14,
                };
                const missSide = (this.rng() < 0.5 ? 1 : -1) * (0.45 + this.rng() * 0.55);
                const missUp = (this.rng() - 0.35) * 0.5;
                const target: Vec3 = hit
                  ? { x: playerEye.x, y: playerEye.y - 0.25, z: playerEye.z }
                  : {
                      x: playerEye.x + -fwdZ * missSide,
                      y: Math.max(0.25, playerEye.y - 0.15 + missUp),
                      z: playerEye.z + fwdX * missSide,
                    };

                shots.push({
                  botId: bot.id,
                  faction: bot.faction,
                  origin: muzzle,
                  target,
                  hit,
                  damage: hit ? diff.enemyDmg : 0,
                  dist,
                });
              } else {
                bot.burstRemaining = 0;
              }
            }
          }
          break;
        }

        case 'COVER': {
          if (!bot.coverTarget) {
            bot.coverTarget = this.pickCoverSpot(ent.pos, playerEye, boxes);
          }
          const c = bot.coverTarget;
          const dc = Math.hypot(c.x - ent.pos.x, c.z - ent.pos.z);
          if (dc > 0.9) {
            moveTargetX = c.x;
            moveTargetZ = c.z;
            desiredSpeed = diff.moveSpeed * 1.08;
            lookTargetYaw = yawFromDir(c.x - ent.pos.x, c.z - ent.pos.z);
          } else {
            desiredSpeed = 0;
            if (bot.lastSeenPos) {
              lookTargetYaw = yawFromDir(bot.lastSeenPos.x - ent.pos.x, bot.lastSeenPos.z - ent.pos.z);
            }
            if (bot.ammo < bot.mag && bot.reloadingUntil === 0) {
              bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
            }
          }
          if (nowMs >= bot.stateUntil) {
            bot.coverTarget = null;
            bot.state = bot.hasLos ? 'ENGAGE' : 'CHASE';
          }
          break;
        }
      }

      // --- Smooth Yaw + Box-Avoiding Horizontal Steering via CollisionWorld ---
      bot.yaw = turnToward(bot.yaw, lookTargetYaw, 7.5 * dt);

      let vx = 0;
      let vz = 0;
      if (moveTargetX !== null && moveTargetZ !== null && desiredSpeed > 0.01) {
        let dirX = moveTargetX - ent.pos.x;
        let dirZ = moveTargetZ - ent.pos.z;
        const dLen = Math.hypot(dirX, dirZ) || 1;
        dirX /= dLen;
        dirZ /= dLen;

        // Lightweight raycast whisker steering around containers (no navmesh)
        const probePos: Vec3 = { x: ent.pos.x, y: 0.9, z: ent.pos.z };
        if (this.rayBlocked(probePos, dirX, dirZ, 1.5, boxes)) {
          // Try ±45° & ±80° steering offsets
          const angles = [
            bot.flankSign * 0.78,
            -bot.flankSign * 0.78,
            bot.flankSign * 1.4,
            -bot.flankSign * 1.4,
          ];
          for (const a of angles) {
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const rx = dirX * ca - dirZ * sa;
            const rz = dirX * sa + dirZ * ca;
            if (!this.rayBlocked(probePos, rx, rz, 1.5, boxes)) {
              dirX = rx;
              dirZ = rz;
              break;
            }
          }
        }

        // Gentle bot-to-bot separation so enemies never stack on top of each other
        for (let j = 0; j < this.bots.length; j++) {
          if (j === i) continue;
          const other = this.bots[j];
          if (!other.entity.alive) continue;
          const sx = ent.pos.x - other.entity.pos.x;
          const sz = ent.pos.z - other.entity.pos.z;
          const sd = Math.hypot(sx, sz);
          if (sd > 0.01 && sd < 1.4) {
            const push = (1.4 - sd) * 0.9;
            dirX += (sx / sd) * push;
            dirZ += (sz / sd) * push;
          }
        }
        const fl = Math.hypot(dirX, dirZ) || 1;
        vx = (dirX / fl) * desiredSpeed;
        vz = (dirZ / fl) * desiredSpeed;
      }

      const moved = collider.move(
        ent.pos,
        { x: vx, y: -4.0, z: vz },
        ent.radius,
        ent.height,
        dt,
        true,
      );
      const actualDisp = Math.hypot(moved.pos.x - ent.pos.x, moved.pos.z - ent.pos.z);
      ent.pos.x = moved.pos.x;
      ent.pos.y = Math.max(0, moved.pos.y);
      ent.pos.z = moved.pos.z;
      bot.speed = dt > 1e-4 ? actualDisp / dt : 0;
      bot.walkPhase += bot.speed * dt * 3.1;

      // If blocked while patrolling, pick an alternate neighbor waypoint
      if (bot.state === 'PATROL' && desiredSpeed > 0.5 && bot.speed < 0.25) {
        bot.waypointIdx = this.pickNextWaypoint(bot.waypointIdx);
      }

      // --- Derive one of the 6 required animations ---
      if (nowMs - bot.lastHitAt < 220) {
        bot.anim = 'hit';
      } else if (nowMs - bot.lastFireAt < 130) {
        bot.anim = 'fire';
      } else if (bot.speed > 0.35) {
        bot.anim = 'walk';
      } else if (bot.state === 'ALERT' || bot.state === 'ENGAGE' || bot.state === 'COVER') {
        bot.anim = 'aim';
      } else {
        bot.anim = 'breathe';
      }
    }

    return shots;
  }

  private rayBlocked(origin: Vec3, dx: number, dz: number, maxDist: number, boxes: readonly Box[]): boolean {
    const dir: Vec3 = { x: dx, y: 0, z: dz };
    for (const b of boxes) {
      if (b.kind === 'deck') continue;
      if (rayBoxT(origin, dir, b) < maxDist) return true;
    }
    return false;
  }

  private pickNextWaypoint(currentIdx: number): number {
    const nbs = WP_NEIGHBORS[currentIdx];
    if (!nbs || nbs.length === 0) return Math.floor(this.rng() * PATROL_WAYPOINTS.length);
    return nbs[Math.floor(this.rng() * nbs.length)];
  }

  private pickCoverSpot(botPos: Vec3, playerEye: Vec3, boxes: readonly Box[]): Vec2 {
    let best = COVER_SPOTS[0];
    let bestScore = Infinity;
    for (const c of COVER_SPOTS) {
      const d = Math.hypot(c.x - botPos.x, c.z - botPos.z);
      const hidden = !hasLineOfSight({ x: c.x, y: 1.2, z: c.z }, playerEye, boxes);
      const score = d + (hidden ? 0 : 25);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }
}
