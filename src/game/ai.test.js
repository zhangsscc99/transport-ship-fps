// src/game/ai.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/entities.ts
var RESPAWN_MS = 3e3;
function createEntity(id, pos, maxHp = 100, radius = 0.35, height = 1.7) {
  return {
    id,
    pos,
    radius,
    height,
    hp: maxHp,
    maxHp,
    alive: true,
    deadUntil: 0,
    invincibleUntil: 0
  };
}

// src/game/damage.ts
var EPS = 1e-6;
function rayBoxT(o, d, b) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [
    [o.x, d.x, b.x - b.w / 2, b.x + b.w / 2],
    [o.y, d.y, b.y, b.y + b.h],
    [o.z, d.z, b.z - b.d / 2, b.z + b.d / 2]
  ];
  for (const [ov, dv, lo, hi] of axes) {
    if (Math.abs(dv) < EPS) {
      if (ov <= lo || ov >= hi) return Infinity;
      continue;
    }
    let t1 = (lo - ov) / dv;
    let t2 = (hi - ov) / dv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin > EPS ? tmin : tmax > EPS ? 0 : Infinity;
}
function applyDamage(e, dmg, now) {
  if (!e.alive || now < e.invincibleUntil) return false;
  e.hp = Math.max(0, e.hp - dmg);
  if (e.hp > 0) return false;
  e.alive = false;
  e.deadUntil = now + RESPAWN_MS;
  return true;
}

// src/game/difficulty.ts
var DIFFICULTIES = [
  {
    id: "easy",
    label: "EASY",
    subLabel: "\u7B80\u5355",
    enemyDmg: 8,
    hitRate: 0.25,
    reactionMs: 900,
    moveSpeed: 2.4,
    totalEnemies: 3,
    maxSimultaneous: 3,
    canTakeCover: false,
    flankPairs: false,
    respawnDelayMs: 3600
  },
  {
    id: "normal",
    label: "NORMAL",
    subLabel: "\u666E\u901A",
    enemyDmg: 12,
    hitRate: 0.4,
    reactionMs: 600,
    moveSpeed: 3,
    totalEnemies: 5,
    maxSimultaneous: 5,
    canTakeCover: true,
    flankPairs: false,
    respawnDelayMs: 3e3
  },
  {
    id: "hard",
    label: "HARD",
    subLabel: "\u56F0\u96BE",
    enemyDmg: 16,
    hitRate: 0.55,
    reactionMs: 350,
    moveSpeed: 3.4,
    totalEnemies: 7,
    maxSimultaneous: 5,
    canTakeCover: true,
    flankPairs: true,
    respawnDelayMs: 1800
  }
];
var DIFFICULTY_MAP = {
  easy: DIFFICULTIES[0],
  normal: DIFFICULTIES[1],
  hard: DIFFICULTIES[2]
};
function getDifficultySpec(id) {
  return DIFFICULTY_MAP[id] ?? DIFFICULTY_MAP.normal;
}

// src/game/ai.ts
var BOT_RADIUS = 0.38;
var BOT_HEIGHT = 1.8;
var BOT_EYE_Y = 1.56;
var BOT_MAG = 30;
var BOT_RELOAD_MS = 2200;
var PATROL_SPEED = 1.4;
var COVER_SPEED = 1.2;
var ALERT_HOLD_MS = 600;
var ENGAGE_FIRE_INTERVAL_MS = 900;
var FIRE_ANIM_MS = 350;
var FIRE_HIT_DELAY_MS = 180;
var HIT_ANIM_MS = 250;
var BOT_TURN_RATE = 8;
var MIN_PLAYER_SPAWN_DIST = 15;
var MIN_BOT_SEPARATION = 1.5;
var VISION_FOV_DEG = 100;
var VISION_COS_HALF = Math.cos(VISION_FOV_DEG * 0.5 * Math.PI / 180);
var VISION_RANGE = 40;
var HEAR_SHOT_RANGE = 60;
var HEAR_STEP_RANGE = 12;
var ENGAGE_MIN_DIST = 8;
var ENGAGE_MAX_DIST = 16;
var PATROL_WAYPOINTS = [
  { x: -16, z: -15.5 },
  // 0: NW deck
  { x: -4, z: -15.5 },
  // 1: N-mid-W
  { x: 6, z: -15.5 },
  // 2: N-mid-E
  { x: 18, z: -15.5 },
  // 3: NE deck
  { x: -20, z: -7.5 },
  // 4: W upper lane
  { x: -8, z: -8 },
  // 5: mid-NW alley
  { x: 0, z: -7.5 },
  // 6: center north
  { x: 18, z: -7.5 },
  // 7: E upper lane
  { x: -21, z: 0 },
  // 8: W flank mid
  { x: -11, z: 0 },
  // 9: W mid deck
  { x: 0, z: 0 },
  // 10: ship center
  { x: 11, z: 0 },
  // 11: E mid deck
  { x: 21, z: 0 },
  // 12: E flank mid
  { x: -18, z: 7.5 },
  // 13: W lower lane
  { x: 0, z: 7.5 },
  // 14: center south
  { x: 8, z: 8 },
  // 15: mid-SE alley
  { x: 19, z: 7.5 },
  // 16: E lower lane
  { x: -16, z: 15.5 },
  // 17: SW deck
  { x: 14, z: 15.5 }
  // 18: SE deck
];
var WP_NEIGHBORS = [
  [1, 4],
  // 0
  [0, 2, 5, 6],
  // 1
  [1, 3, 6],
  // 2
  [2, 7],
  // 3
  [0, 5, 8],
  // 4
  [1, 4, 6, 9],
  // 5
  [1, 2, 5, 10],
  // 6
  [3, 12],
  // 7
  [4, 9, 13],
  // 8
  [5, 8, 10],
  // 9
  [6, 9, 11, 14],
  // 10
  [10, 12, 15],
  // 11
  [7, 11, 16],
  // 12
  [8, 17],
  // 13
  [10, 15],
  // 14
  [11, 14, 16, 18],
  // 15
  [12, 15, 18],
  // 16
  [13],
  // 17
  [15, 16]
  // 18
];
var COVER_SPOTS = [
  { x: -6, z: -6.8 },
  // north behind container (-6,-4)
  { x: -6, z: -1.4 },
  // south behind container (-6,-4)
  { x: 6, z: 1.4 },
  // north behind container (6,4)
  { x: 6, z: 6.8 },
  // south behind container (6,4)
  { x: -18.8, z: 2 },
  // west behind container (-16,2)
  { x: -13.2, z: 2 },
  // east behind container (-16,2)
  { x: 18.8, z: -2 },
  // east behind container (16,-2)
  { x: 13.2, z: -2 },
  // west behind container (16,-2)
  { x: 4, z: -13.8 },
  // north behind container (4,-11)
  { x: 12, z: -13.8 },
  // north behind container (12,-11)
  { x: -12, z: 13.8 },
  // south behind container (-12,11)
  { x: -4, z: 13.8 }
  // south behind container (-4,11)
];
var ENEMY_SPAWNS = [
  { x: -14, z: -15.5 },
  { x: -4, z: -15.5 },
  { x: 6, z: -15.5 },
  { x: 16, z: -15.5 },
  { x: -20, z: -7.5 },
  { x: 18, z: -7.5 },
  { x: 0, z: -15.5 }
];
var FALLBACK_SPAWNS = [
  { x: -21, z: 0 },
  { x: 21, z: 0 },
  { x: -18, z: 7.5 },
  { x: 19, z: 7.5 },
  { x: -16, z: 15.5 },
  { x: 14, z: 15.5 }
];
function hasLineOfSight(from, to, boxes) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return true;
  const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
  for (const b of boxes) {
    if (b.kind === "deck") continue;
    const t = rayBoxT(from, dir, b);
    if (t < dist - 0.15) return false;
  }
  return true;
}
function wrapPi(a) {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}
function turnToward(current, target, maxStep) {
  const diff = wrapPi(target - current);
  if (Math.abs(diff) <= maxStep) return wrapPi(target);
  return wrapPi(current + Math.sign(diff) * maxStep);
}
function yawFromDir(dx, dz) {
  return Math.atan2(-dx, -dz);
}
function enemyHitAttenuation(dist) {
  if (dist <= 12) return 1;
  return Math.max(0.35, 1 - (dist - 12) / 58);
}
var EnemyManager = class {
  bots = [];
  entities = [];
  difficulty;
  rng;
  nextBotSeq = 1;
  factionBalance = 0;
  /** Remembered player spawn origin so initial/replacement spawns stay >= 15m away. */
  playerSpawnOrigin = { x: -8, z: 17 };
  constructor(diffId = "normal", rng = Math.random) {
    this.difficulty = getDifficultySpec(diffId);
    this.rng = rng;
  }
  setDifficulty(diffId) {
    this.difficulty = getDifficultySpec(diffId);
  }
  /** Reset and spawn a fresh wave matching active difficulty (EASY 3 / NORMAL 5 / HARD 7 pool, <=5 live). */
  reset(nowMs, playerPos) {
    this.bots.length = 0;
    this.entities.length = 0;
    this.factionBalance = 0;
    this.playerSpawnOrigin = { x: playerPos.x, z: playerPos.z };
    const count = Math.min(5, this.difficulty.maxSimultaneous);
    for (let i = 0; i < count; i++) {
      this.spawnIntoSlot(i, nowMs, playerPos);
    }
  }
  /** Deterministic helper for e2e & unit tests: clear all bots. */
  clear() {
    this.bots.length = 0;
    this.entities.length = 0;
  }
  /** Deterministic helper for e2e & unit tests: spawn a specific bot at (x, z, yaw). */
  spawnManual(x, z, yaw = 0, faction, nowMs = 0) {
    const f = faction ?? this.pickFaction();
    const slot = this.bots.length;
    const id = `bot-${this.nextBotSeq++}`;
    const ent = createEntity(id, { x, y: 0, z }, 100, BOT_RADIUS, BOT_HEIGHT);
    const bot = {
      id,
      slotIndex: slot,
      faction: f,
      entity: ent,
      state: "IDLE",
      yaw,
      speed: 0,
      ammo: BOT_MAG,
      mag: BOT_MAG,
      shotsFired: 0,
      reloadingUntil: 0,
      waypointIdx: this.nearestWaypoint(x, z),
      stateUntil: nowMs + 1600,
      sightAcquiredAt: -1,
      firstShotAt: -1,
      firstSightAt: -1,
      hasLos: false,
      lastSeenPos: null,
      lastSeenAt: 0,
      fireAnimStartAt: -1e4,
      fireAnimEndAt: -1e4,
      fireHitAt: -1e4,
      fireHitPending: false,
      nextFireCycleAt: nowMs,
      flankSign: slot % 2 === 0 ? 1 : -1,
      strafeSwitchAt: nowMs + 1600,
      coverTarget: null,
      lastFireAt: -1e4,
      lastHitAt: -1e4,
      diedAt: -1e4,
      replaceAt: -1,
      anim: "idle_rifle",
      walkPhase: this.rng() * Math.PI * 2
    };
    this.bots.push(bot);
    this.entities.push(ent);
    return bot;
  }
  /** Random CF faction assignment ('bl' 潜伏者 / 'gr' 保卫者), avoiding mono-faction streaks. */
  pickFaction() {
    let f = this.rng() < 0.5 ? "bl" : "gr";
    if (this.factionBalance >= 2) f = "gr";
    else if (this.factionBalance <= -2) f = "bl";
    this.factionBalance += f === "bl" ? 1 : -1;
    return f;
  }
  nearestWaypoint(x, z) {
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
  /**
   * Pick an enemy spawn point strictly >= 15m from playerPos (and player spawn
   * when possible) and >= 1.5m away from all live enemies.
   */
  pickSpawn(playerPos, slotIndex) {
    const allCandidates = [...ENEMY_SPAWNS, ...FALLBACK_SPAWNS];
    const minBotDistAt = (sp) => {
      let minD = 99;
      for (const b of this.bots) {
        if (!b.entity.alive) continue;
        const db = Math.hypot(sp.x - b.entity.pos.x, sp.z - b.entity.pos.z);
        if (db < minD) minD = db;
      }
      return minD;
    };
    const pickFrom = (list, requireSpawnDist) => {
      let best = null;
      let bestScore = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const sp = list[(i + slotIndex) % list.length];
        const dPlayer = Math.hypot(sp.x - playerPos.x, sp.z - playerPos.z);
        if (dPlayer < MIN_PLAYER_SPAWN_DIST) continue;
        if (requireSpawnDist) {
          const dOrigin = Math.hypot(sp.x - this.playerSpawnOrigin.x, sp.z - this.playerSpawnOrigin.z);
          if (dOrigin < MIN_PLAYER_SPAWN_DIST) continue;
        }
        const minBotD = minBotDistAt(sp);
        if (minBotD < MIN_BOT_SEPARATION + 0.5) continue;
        const score = Math.min(dPlayer, 36) + Math.min(minBotD, 14) * 2.5 + this.rng() * 3;
        if (score > bestScore) {
          bestScore = score;
          best = sp;
        }
      }
      return best;
    };
    const p1 = pickFrom(ENEMY_SPAWNS, true);
    if (p1) return p1;
    const p2 = pickFrom(allCandidates, true);
    if (p2) return p2;
    const p3 = pickFrom(allCandidates, false);
    if (p3) return p3;
    let fallback = ENEMY_SPAWNS[slotIndex % ENEMY_SPAWNS.length];
    let bestD = -Infinity;
    for (const sp of allCandidates) {
      const d = Math.hypot(sp.x - playerPos.x, sp.z - playerPos.z) + minBotDistAt(sp) * 2;
      if (d > bestD) {
        bestD = d;
        fallback = sp;
      }
    }
    return fallback;
  }
  spawnIntoSlot(slotIndex, nowMs, playerPos) {
    const sp = this.pickSpawn(playerPos, slotIndex);
    const id = `bot-${this.nextBotSeq++}`;
    const ent = createEntity(id, { x: sp.x, y: 0, z: sp.z }, 100, BOT_RADIUS, BOT_HEIGHT);
    const yaw = yawFromDir(playerPos.x - sp.x, playerPos.z - sp.z);
    const bot = {
      id,
      slotIndex,
      faction: this.pickFaction(),
      entity: ent,
      state: "PATROL",
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
      fireAnimStartAt: -1e4,
      fireAnimEndAt: -1e4,
      fireHitAt: -1e4,
      fireHitPending: false,
      nextFireCycleAt: nowMs + 200,
      flankSign: slotIndex % 2 === 0 ? 1 : -1,
      strafeSwitchAt: nowMs + 1400 + this.rng() * 1200,
      coverTarget: null,
      lastFireAt: -1e4,
      lastHitAt: -1e4,
      diedAt: -1e4,
      replaceAt: -1,
      anim: "walk_rifle",
      walkPhase: this.rng() * Math.PI * 2
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
  /** Alert hold before entering ENGAGE: 0.6s on NORMAL; aligns EASY/HARD first-shot delay with 0.18s fire windup. */
  alertSightDelayMs() {
    if (this.difficulty.id === "normal") return ALERT_HOLD_MS;
    return Math.max(150, this.difficulty.reactionMs - FIRE_HIT_DELAY_MS);
  }
  /** Notify bot that it was hit by the player (triggers 0.25s hit clip without interrupting movement, death, or alert). */
  onBotDamaged(entity, attackerPos, nowMs) {
    const bot = this.bots.find((b) => b.entity === entity);
    if (!bot) return null;
    bot.lastHitAt = nowMs;
    if (!entity.alive) {
      bot.state = "DEAD";
      bot.diedAt = nowMs;
      bot.replaceAt = nowMs + this.difficulty.respawnDelayMs;
      bot.fireHitPending = false;
      bot.speed = 0;
      bot.anim = "die";
      return bot;
    }
    bot.lastSeenPos = { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z };
    bot.lastSeenAt = nowMs;
    if (bot.state === "IDLE" || bot.state === "PATROL") {
      bot.state = "ALERT";
      bot.stateUntil = nowMs + ALERT_HOLD_MS;
    }
    if (this.difficulty.canTakeCover && entity.hp < entity.maxHp * 0.3 && bot.state !== "COVER" && bot.state !== "RELOAD") {
      bot.state = "COVER";
      bot.coverTarget = null;
      bot.fireHitPending = false;
      bot.stateUntil = nowMs + 2800;
    }
    return bot;
  }
  /** Advance all AI bots one simulation step; returns shots fired at the 0.18s fire_rifle trigger. */
  update(ctx) {
    const shots = [];
    const { dt, nowMs, playerPos, playerEye, playerAlive, boxes, collider } = ctx;
    const diff = this.difficulty;
    const alertSightMs = this.alertSightDelayMs();
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const ent = bot.entity;
      if (!ent.alive || bot.state === "DEAD") {
        bot.state = "DEAD";
        bot.speed = 0;
        bot.fireHitPending = false;
        bot.anim = "die";
        if (bot.replaceAt > 0 && nowMs >= bot.replaceAt) {
          this.spawnIntoSlot(bot.slotIndex, nowMs, playerPos);
        }
        continue;
      }
      const botEye = { x: ent.pos.x, y: ent.pos.y + BOT_EYE_Y, z: ent.pos.z };
      const toPx = playerPos.x - ent.pos.x;
      const toPz = playerPos.z - ent.pos.z;
      const dist = Math.hypot(toPx, toPz);
      let canSee = false;
      let clearLos = false;
      if (playerAlive && dist <= VISION_RANGE) {
        clearLos = hasLineOfSight(botEye, playerEye, boxes);
        if (clearLos) {
          const fwdX = -Math.sin(bot.yaw);
          const fwdZ = -Math.cos(bot.yaw);
          const dot = dist > 1e-4 ? (toPx * fwdX + toPz * fwdZ) / dist : 1;
          const inCone = dot >= VISION_COS_HALF || dist < 3.5;
          const alreadyAware = bot.state === "ALERT" || bot.state === "CHASE" || bot.state === "ENGAGE" || bot.state === "RELOAD";
          if (inCone || alreadyAware) canSee = true;
        }
      }
      const heardShot = playerAlive && ctx.playerFired && dist <= HEAR_SHOT_RANGE;
      const heardStep = playerAlive && ctx.playerOnGround && ctx.playerSpeed > 1.2 && dist <= HEAR_STEP_RANGE;
      bot.hasLos = canSee && clearLos;
      if (bot.hasLos) {
        if (bot.sightAcquiredAt < 0) bot.sightAcquiredAt = nowMs;
        if (bot.firstSightAt < 0) bot.firstSightAt = nowMs;
        bot.lastSeenPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
        bot.lastSeenAt = nowMs;
      } else {
        bot.sightAcquiredAt = -1;
        bot.fireHitPending = false;
      }
      if ((heardShot || heardStep) && !bot.hasLos) {
        bot.lastSeenPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
        bot.lastSeenAt = nowMs;
        if (bot.state === "IDLE" || bot.state === "PATROL") {
          bot.state = "ALERT";
          bot.stateUntil = nowMs + ALERT_HOLD_MS;
        }
      }
      if (diff.canTakeCover && ent.hp < ent.maxHp * 0.3 && bot.state !== "COVER" && bot.state !== "RELOAD" && bot.state !== "IDLE" && bot.state !== "PATROL") {
        bot.state = "COVER";
        bot.coverTarget = this.pickCoverSpot(ent.pos, playerEye, boxes);
        bot.fireHitPending = false;
        bot.stateUntil = nowMs + 2600;
      }
      let moveTargetX = null;
      let moveTargetZ = null;
      let desiredSpeed = 0;
      let lookTargetYaw = bot.yaw;
      if (!playerAlive && bot.state !== "IDLE" && bot.state !== "PATROL" && bot.state !== "RELOAD") {
        bot.state = "PATROL";
        bot.fireHitPending = false;
        bot.sightAcquiredAt = -1;
      }
      switch (bot.state) {
        case "IDLE": {
          desiredSpeed = 0;
          if (bot.hasLos) {
            bot.state = "ALERT";
            bot.stateUntil = nowMs + alertSightMs;
          } else if (nowMs >= bot.stateUntil) {
            bot.state = "PATROL";
            bot.waypointIdx = this.pickNextWaypoint(bot.waypointIdx);
          }
          break;
        }
        case "PATROL": {
          if (bot.hasLos) {
            bot.state = "ALERT";
            bot.stateUntil = nowMs + alertSightMs;
            break;
          }
          const wp = PATROL_WAYPOINTS[bot.waypointIdx] ?? PATROL_WAYPOINTS[0];
          const wd = Math.hypot(wp.x - ent.pos.x, wp.z - ent.pos.z);
          if (wd < 1.1) {
            bot.state = "IDLE";
            bot.stateUntil = nowMs + 700 + this.rng() * 900;
            desiredSpeed = 0;
          } else {
            moveTargetX = wp.x;
            moveTargetZ = wp.z;
            desiredSpeed = PATROL_SPEED;
            lookTargetYaw = yawFromDir(wp.x - ent.pos.x, wp.z - ent.pos.z);
          }
          break;
        }
        case "ALERT": {
          desiredSpeed = 0;
          const target = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (target) {
            lookTargetYaw = yawFromDir(target.x - ent.pos.x, target.z - ent.pos.z);
          }
          if (bot.hasLos) {
            if (nowMs - bot.sightAcquiredAt >= alertSightMs) {
              bot.state = dist <= ENGAGE_MAX_DIST + 4 ? "ENGAGE" : "CHASE";
              bot.nextFireCycleAt = Math.min(bot.nextFireCycleAt, nowMs);
            }
          } else if (nowMs >= bot.stateUntil) {
            if (bot.lastSeenPos && nowMs - bot.lastSeenAt < 6500) {
              bot.state = "CHASE";
            } else {
              bot.state = "PATROL";
            }
          }
          break;
        }
        case "CHASE": {
          if (bot.hasLos && dist <= ENGAGE_MAX_DIST && nowMs - bot.sightAcquiredAt >= alertSightMs) {
            bot.state = "ENGAGE";
            bot.nextFireCycleAt = Math.min(bot.nextFireCycleAt, nowMs);
            break;
          }
          const goal = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (!goal || !bot.hasLos && nowMs - bot.lastSeenAt > 7500) {
            bot.state = "PATROL";
            bot.waypointIdx = this.nearestWaypoint(ent.pos.x, ent.pos.z);
            break;
          }
          let tx = goal.x;
          let tz = goal.z;
          if (diff.flankPairs && dist > 6) {
            const ang = Math.atan2(ent.pos.z - goal.z, ent.pos.x - goal.x) + bot.flankSign * 0.65;
            tx = goal.x + Math.cos(ang) * Math.max(8, dist * 0.65);
            tz = goal.z + Math.sin(ang) * Math.max(8, dist * 0.65);
          }
          const dGoal = Math.hypot(tx - ent.pos.x, tz - ent.pos.z);
          if (dGoal < 1.4 && !bot.hasLos) {
            bot.lastSeenPos = null;
            bot.state = "PATROL";
            bot.waypointIdx = this.nearestWaypoint(ent.pos.x, ent.pos.z);
          } else {
            moveTargetX = tx;
            moveTargetZ = tz;
            desiredSpeed = diff.moveSpeed;
            lookTargetYaw = yawFromDir(goal.x - ent.pos.x, goal.z - ent.pos.z);
          }
          break;
        }
        case "RELOAD": {
          desiredSpeed = 0;
          bot.fireHitPending = false;
          const target = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (target) {
            lookTargetYaw = yawFromDir(target.x - ent.pos.x, target.z - ent.pos.z);
          }
          if (nowMs >= bot.reloadingUntil) {
            bot.ammo = bot.mag;
            bot.reloadingUntil = 0;
            bot.state = bot.hasLos ? "ENGAGE" : bot.lastSeenPos ? "CHASE" : "PATROL";
            bot.nextFireCycleAt = nowMs + 150;
          }
          break;
        }
        case "ENGAGE": {
          if (!bot.hasLos) {
            bot.fireHitPending = false;
            bot.state = "CHASE";
            break;
          }
          if (bot.ammo <= 0 && !bot.fireHitPending) {
            bot.state = "RELOAD";
            bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
            break;
          }
          lookTargetYaw = yawFromDir(toPx, toPz);
          if (nowMs >= bot.strafeSwitchAt) {
            bot.flankSign = bot.flankSign === 1 ? -1 : 1;
            bot.strafeSwitchAt = nowMs + 1600 + this.rng() * 1e3;
          }
          const inFireAnim = nowMs >= bot.fireAnimStartAt && nowMs < bot.fireAnimEndAt;
          if (!inFireAnim) {
            const ux = dist > 1e-4 ? toPx / dist : 0;
            const uz = dist > 1e-4 ? toPz / dist : -1;
            const rx = -uz * bot.flankSign;
            const rz = ux * bot.flankSign;
            let mx = rx * 0.45;
            let mz = rz * 0.45;
            if (dist > ENGAGE_MAX_DIST) {
              mx += ux * 0.85;
              mz += uz * 0.85;
            } else if (dist < ENGAGE_MIN_DIST) {
              mx -= ux * 0.7;
              mz -= uz * 0.7;
            }
            moveTargetX = ent.pos.x + mx * 2.5;
            moveTargetZ = ent.pos.z + mz * 2.5;
            desiredSpeed = 0.85;
          } else {
            desiredSpeed = 0;
          }
          const reactionMet = bot.sightAcquiredAt >= 0 && nowMs - bot.sightAcquiredAt >= alertSightMs;
          if (reactionMet && bot.ammo > 0 && !bot.fireHitPending && nowMs >= bot.nextFireCycleAt && hasLineOfSight(botEye, playerEye, boxes)) {
            bot.fireAnimStartAt = nowMs;
            bot.fireAnimEndAt = nowMs + FIRE_ANIM_MS;
            bot.fireHitAt = nowMs + FIRE_HIT_DELAY_MS;
            bot.fireHitPending = true;
            bot.nextFireCycleAt = nowMs + ENGAGE_FIRE_INTERVAL_MS;
          }
          if (bot.fireHitPending && nowMs >= bot.fireHitAt) {
            bot.fireHitPending = false;
            if (bot.ammo > 0 && hasLineOfSight(botEye, playerEye, boxes)) {
              bot.ammo--;
              bot.shotsFired++;
              bot.lastFireAt = nowMs;
              if (bot.firstShotAt < 0) bot.firstShotAt = nowMs;
              const pHit = diff.hitRate * enemyHitAttenuation(dist);
              const hit = this.rng() < pHit;
              const fwdX = -Math.sin(bot.yaw);
              const fwdZ = -Math.cos(bot.yaw);
              const muzzle = {
                x: ent.pos.x + fwdX * 0.58 + -fwdZ * 0.14,
                y: ent.pos.y + 1.38,
                z: ent.pos.z + fwdZ * 0.58 + fwdX * 0.14
              };
              const missSide = (this.rng() < 0.5 ? 1 : -1) * (0.45 + this.rng() * 0.55);
              const missUp = (this.rng() - 0.35) * 0.5;
              const target = hit ? { x: playerEye.x, y: playerEye.y - 0.25, z: playerEye.z } : {
                x: playerEye.x + -fwdZ * missSide,
                y: Math.max(0.25, playerEye.y - 0.15 + missUp),
                z: playerEye.z + fwdX * missSide
              };
              shots.push({
                botId: bot.id,
                faction: bot.faction,
                origin: muzzle,
                target,
                hit,
                damage: hit ? diff.enemyDmg : 0,
                dist
              });
              if (bot.ammo <= 0) {
                bot.state = "RELOAD";
                bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
              }
            }
          }
          break;
        }
        case "COVER": {
          if (!bot.coverTarget) {
            bot.coverTarget = this.pickCoverSpot(ent.pos, playerEye, boxes);
          }
          const c = bot.coverTarget;
          const dc = Math.hypot(c.x - ent.pos.x, c.z - ent.pos.z);
          if (nowMs >= bot.strafeSwitchAt) {
            bot.flankSign = bot.flankSign === 1 ? -1 : 1;
            bot.strafeSwitchAt = nowMs + 1100 + this.rng() * 800;
          }
          if (dc > 0.85) {
            moveTargetX = c.x;
            moveTargetZ = c.z;
            desiredSpeed = COVER_SPEED;
          } else {
            const ref = bot.lastSeenPos ?? playerPos;
            const rdx = ref.x - ent.pos.x;
            const rdz = ref.z - ent.pos.z;
            const rlen = Math.hypot(rdx, rdz) || 1;
            const lx = -rdz / rlen * bot.flankSign;
            const lz = rdx / rlen * bot.flankSign;
            moveTargetX = ent.pos.x + lx * 2;
            moveTargetZ = ent.pos.z + lz * 2;
            desiredSpeed = COVER_SPEED;
          }
          const lookRef = bot.hasLos ? playerPos : bot.lastSeenPos;
          if (lookRef) {
            lookTargetYaw = yawFromDir(lookRef.x - ent.pos.x, lookRef.z - ent.pos.z);
          }
          if (bot.ammo <= 0) {
            bot.state = "RELOAD";
            bot.reloadingUntil = nowMs + BOT_RELOAD_MS;
          } else if (nowMs >= bot.stateUntil) {
            bot.coverTarget = null;
            bot.state = bot.hasLos ? "ENGAGE" : "CHASE";
          }
          break;
        }
      }
      bot.yaw = turnToward(bot.yaw, lookTargetYaw, BOT_TURN_RATE * dt);
      let vx = 0;
      let vz = 0;
      if (moveTargetX !== null && moveTargetZ !== null && desiredSpeed > 0.01) {
        let dirX = moveTargetX - ent.pos.x;
        let dirZ = moveTargetZ - ent.pos.z;
        const dLen = Math.hypot(dirX, dirZ) || 1;
        dirX /= dLen;
        dirZ /= dLen;
        const probePos = { x: ent.pos.x, y: 0.9, z: ent.pos.z };
        if (this.rayBlocked(probePos, dirX, dirZ, 1.5, boxes)) {
          const angles = [
            bot.flankSign * 0.78,
            -bot.flankSign * 0.78,
            bot.flankSign * 1.4,
            -bot.flankSign * 1.4
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
        for (let j = 0; j < this.bots.length; j++) {
          if (j === i) continue;
          const other = this.bots[j];
          if (!other.entity.alive) continue;
          const sx = ent.pos.x - other.entity.pos.x;
          const sz = ent.pos.z - other.entity.pos.z;
          const sd = Math.hypot(sx, sz);
          if (sd > 1e-3 && sd < 2) {
            const push = (2 - sd) / 2 * 1.6;
            dirX += sx / sd * push;
            dirZ += sz / sd * push;
          }
        }
        const fl = Math.hypot(dirX, dirZ) || 1;
        vx = dirX / fl * desiredSpeed;
        vz = dirZ / fl * desiredSpeed;
      }
      const moved = collider.move(
        ent.pos,
        { x: vx, y: -4, z: vz },
        ent.radius,
        ent.height,
        dt,
        true
      );
      const actualDisp = Math.hypot(moved.pos.x - ent.pos.x, moved.pos.z - ent.pos.z);
      ent.pos.x = moved.pos.x;
      ent.pos.y = Math.max(0, moved.pos.y);
      ent.pos.z = moved.pos.z;
      bot.speed = dt > 1e-4 ? actualDisp / dt : 0;
      bot.walkPhase += bot.speed * dt * 3.1;
      if (bot.state === "PATROL" && desiredSpeed > 0.5 && bot.speed < 0.25) {
        bot.waypointIdx = this.pickNextWaypoint(bot.waypointIdx);
      }
      if (nowMs - bot.lastHitAt >= 0 && nowMs - bot.lastHitAt < HIT_ANIM_MS) {
        bot.anim = "hit";
      } else {
        switch (bot.state) {
          case "IDLE":
            bot.anim = "idle_rifle";
            break;
          case "PATROL":
            bot.anim = "walk_rifle";
            break;
          case "ALERT":
            bot.anim = "aim_rifle";
            break;
          case "CHASE":
            bot.anim = "run_rifle";
            break;
          case "ENGAGE":
            bot.anim = nowMs >= bot.fireAnimStartAt && nowMs < bot.fireAnimEndAt ? "fire_rifle" : "aim_rifle";
            break;
          case "RELOAD":
            bot.anim = "reload_rifle";
            break;
          case "COVER":
            bot.anim = "crouch_rifle";
            break;
        }
      }
    }
    this.enforceMinSeparation(collider, dt);
    return shots;
  }
  enforceMinSeparation(collider, dt) {
    const stepDt = Math.max(dt, 1 / 60);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.bots.length; i++) {
        const a = this.bots[i];
        if (!a.entity.alive) continue;
        for (let j = i + 1; j < this.bots.length; j++) {
          const b = this.bots[j];
          if (!b.entity.alive) continue;
          let dx = a.entity.pos.x - b.entity.pos.x;
          let dz = a.entity.pos.z - b.entity.pos.z;
          let d = Math.hypot(dx, dz);
          if (d >= MIN_BOT_SEPARATION) continue;
          if (d < 1e-4) {
            const ang = (i * 1.7 + j * 2.3) % (Math.PI * 2);
            dx = Math.cos(ang);
            dz = Math.sin(ang);
            d = 1;
          }
          const nx = dx / d;
          const nz = dz / d;
          const overlap = (MIN_BOT_SEPARATION - d) * 0.52;
          const pushSpeed = overlap / stepDt;
          const ma = collider.move(
            a.entity.pos,
            { x: nx * pushSpeed, y: -4, z: nz * pushSpeed },
            a.entity.radius,
            a.entity.height,
            stepDt,
            true
          );
          a.entity.pos.x = ma.pos.x;
          a.entity.pos.y = Math.max(0, ma.pos.y);
          a.entity.pos.z = ma.pos.z;
          const mb = collider.move(
            b.entity.pos,
            { x: -nx * pushSpeed, y: -4, z: -nz * pushSpeed },
            b.entity.radius,
            b.entity.height,
            stepDt,
            true
          );
          b.entity.pos.x = mb.pos.x;
          b.entity.pos.y = Math.max(0, mb.pos.y);
          b.entity.pos.z = mb.pos.z;
        }
      }
    }
  }
  rayBlocked(origin, dx, dz, maxDist, boxes) {
    const dir = { x: dx, y: 0, z: dz };
    for (const b of boxes) {
      if (b.kind === "deck") continue;
      if (rayBoxT(origin, dir, b) < maxDist) return true;
    }
    return false;
  }
  pickNextWaypoint(currentIdx) {
    const nbs = WP_NEIGHBORS[currentIdx];
    if (!nbs || nbs.length === 0) return Math.floor(this.rng() * PATROL_WAYPOINTS.length);
    return nbs[Math.floor(this.rng() * nbs.length)];
  }
  pickCoverSpot(botPos, playerEye, boxes) {
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
};

// src/game/map.ts
var BOXES = [];
var box = (x, y, z, w, h, d, kind) => {
  BOXES.push({ x, y, z, w, h, d, kind });
};
box(0, -1, 0, 64, 1, 40, "deck");
var CONTAINER_H = 2.6;
box(-12, 0, 11, 6, CONTAINER_H, 2.5, "container");
box(-4, 0, 11, 6, CONTAINER_H, 2.5, "container");
box(-16, 0, 2, 2.5, CONTAINER_H, 6, "container");
box(-6, 0, -4, 6, CONTAINER_H, 2.5, "container");
box(6, 0, 4, 6, CONTAINER_H, 2.5, "container");
box(16, 0, -2, 2.5, CONTAINER_H, 6, "container");
box(4, 0, -11, 6, CONTAINER_H, 2.5, "container");
box(12, 0, -11, 6, CONTAINER_H, 2.5, "container");
box(-2, 0, 1, 2.4, 0.55, 1.2, "container");
box(2, 0, -1, 2.4, 0.55, 1.2, "container");
var CRATE_H = [0.6, 1.2, 1.8, 2];
function crateStairs(cx, faceZ, dir) {
  for (let i = 0; i < CRATE_H.length; i++) {
    box(cx, 0, faceZ + dir * (0.6 + (CRATE_H.length - 1 - i) * 0.95), 0.9, CRATE_H[i], 0.9, "container");
  }
}
crateStairs(-12, 9.75, -1);
crateStairs(-4, 9.75, -1);
crateStairs(12, -9.75, 1);
crateStairs(4, -9.75, 1);
function tower(tx, tz) {
  const s = tx > 0 ? -1 : 1;
  box(tx, 0, tz, 3.4, 3, 3.4, "tower");
  box(tx, 3, tz, 4.4, 0.3, 4.4, "tower");
  box(tx, 3.3, tz - 2.05, 3.8, 1.05, 0.3, "rail");
  box(tx, 3.3, tz + 2.05, 3.8, 1.05, 0.3, "rail");
  box(tx - s * 2.05, 3.3, tz, 0.3, 1.05, 4.4, "rail");
  box(tx + s * 2.05, 3.3, tz - 1.5, 0.3, 1.05, 1.4, "rail");
  box(tx + s * 2.05, 3.3, tz + 1.5, 0.3, 1.05, 1.4, "rail");
  const edgeX = tx + s * 2.2;
  for (let i = 0; i < 10; i++) {
    box(edgeX + s * (9.5 - i) * 0.6, 0, tz, 0.6, (i + 1) * 0.3, 1.6, "tower");
  }
}
tower(-26, 14);
tower(26, 14);
tower(26, -14);
tower(-26, -14);
function pipe(cx, cz, len) {
  box(cx - 1.05, 0, cz, 0.3, 2, len, "pipe");
  box(cx + 1.05, 0, cz, 0.3, 2, len, "pipe");
  box(cx, 2, cz, 2.7, 0.4, len, "pipe");
}
pipe(-30, 1, 32);
pipe(30, -1, 32);
var WALKABLE_POLYGON = [
  { x: -27.8, z: -19.65 },
  { x: 31.85, z: -19.65 },
  { x: 31.85, z: 16.9 },
  { x: 27.8, z: 16.9 },
  { x: 27.8, z: 19.65 },
  { x: -31.85, z: 19.65 },
  { x: -31.85, z: -16.9 },
  { x: -27.8, z: -16.9 }
];
var MAP = {
  bounds: { w: 64, d: 40 },
  walkablePolygon: WALKABLE_POLYGON,
  boxes: BOXES,
  spawns: {
    teamA: [
      [-8, 0, 17],
      [-4, 0, 17],
      [0, 0, 17],
      [4, 0, 17],
      [8, 0, 17]
    ],
    teamB: [
      [8, 0, -17],
      [4, 0, -17],
      [0, 0, -17],
      [-4, 0, -17],
      [-8, 0, -17]
    ]
  },
  waterY: -2,
  pipes: [
    { from: [-30, 15], to: [-30, -13] },
    { from: [30, -15], to: [30, 13] }
  ],
  jumpSpots: [
    [-12, 6.3],
    [-4, 6.3],
    [12, -6.3],
    [4, -6.3]
  ]
};

// src/game/collision.ts
var PLAYER_RADIUS = 0.35;
var STEP_HEIGHT = 0.35;
var AIR_WALL_SLIDE_DAMP = 0.35;
var EPS2 = 1e-4;
var MAX_SUBSTEP = 0.15;
var MAX_STEPS = 64;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function circleHitsRect(x, z, r, b) {
  const qx = clamp(x, b.x - b.w / 2, b.x + b.w / 2);
  const qz = clamp(z, b.z - b.d / 2, b.z + b.d / 2);
  const dx = x - qx;
  const dz = z - qz;
  return dx * dx + dz * dz < r * r - EPS2;
}
function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const zi = poly[i].z;
    const xj = poly[j].x;
    const zj = poly[j].z;
    if (zi > z !== zj > z && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
function closestOnSegment(x, z, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 1e-12 ? clamp(((x - ax) * abx + (z - az) * abz) / lenSq, 0, 1) : 0;
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = x - qx;
  const dz = z - qz;
  return { qx, qz, t, distSq: dx * dx + dz * dz };
}
function defaultRectPolygon(bounds) {
  const hw = bounds.w / 2 - 0.15;
  const hd = bounds.d / 2 - 0.15;
  return [
    { x: -hw, z: -hd },
    { x: hw, z: -hd },
    { x: hw, z: hd },
    { x: -hw, z: hd }
  ];
}
var CollisionWorld = class {
  constructor(boxes, bounds, waterY, polygon) {
    this.boxes = boxes;
    this.bounds = bounds;
    this.waterY = waterY;
    this.polygon = polygon && polygon.length >= 3 ? polygon : defaultRectPolygon(bounds);
  }
  polygon;
  insideBounds(x, z) {
    return Math.abs(x) <= this.bounds.w / 2 && Math.abs(z) <= this.bounds.d / 2;
  }
  /** True when a capsule of `radius` at (x,z) lies completely within the walkable polygon. */
  isInsideWalkable(x, z, radius = PLAYER_RADIUS) {
    if (!pointInPolygon(x, z, this.polygon)) return false;
    const minDistSq = Math.max(0, radius - EPS2) ** 2;
    const n = this.polygon.length;
    for (let i = 0; i < n; i++) {
      const a = this.polygon[i];
      const b = this.polygon[(i + 1) % n];
      const c = closestOnSegment(x, z, a.x, a.z, b.x, b.z);
      if (c.distSq < minDistSq) return false;
    }
    return true;
  }
  /**
   * Constrain candidate `(x, z)` so a capsule of `radius` remains inside the
   * CCW walkable polygon. Returns resolved `(x, z)`, unit inward push normal
   * `(nx, nz)`, and `hit: true` when an air-wall boundary constrained motion.
   */
  constrainToPolygon(candX, candZ, radius) {
    let x = candX;
    let z = candZ;
    let hit = false;
    const poly = this.polygon;
    const n = poly.length;
    for (let iter = 0; iter < 4; iter++) {
      const inside = pointInPolygon(x, z, poly);
      let bestDistSq = Infinity;
      let bestQx = x;
      let bestQz = z;
      let bestT = 0.5;
      let bestNx = 0;
      let bestNz = 0;
      for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        const seg = closestOnSegment(x, z, a.x, a.z, b.x, b.z);
        if (seg.distSq < bestDistSq) {
          bestDistSq = seg.distSq;
          bestQx = seg.qx;
          bestQz = seg.qz;
          bestT = seg.t;
          const ex = b.x - a.x;
          const ez = b.z - a.z;
          const el = Math.hypot(ex, ez) || 1;
          bestNx = -ez / el;
          bestNz = ex / el;
        }
      }
      const dist = Math.sqrt(bestDistSq);
      if (!inside) {
        hit = true;
        x = bestQx + bestNx * radius;
        z = bestQz + bestNz * radius;
      } else if (dist < radius - EPS2) {
        hit = true;
        const push = radius - dist;
        if (bestT > 1e-4 && bestT < 1 - 1e-4) {
          x += bestNx * push;
          z += bestNz * push;
        } else if (dist > 1e-6) {
          x += (x - bestQx) / dist * push;
          z += (z - bestQz) / dist * push;
        } else {
          x += bestNx * push;
          z += bestNz * push;
        }
      } else {
        break;
      }
    }
    if (!hit) return { x, z, nx: 0, nz: 0, hit: false };
    const px = x - candX;
    const pz = z - candZ;
    const pl = Math.hypot(px, pz);
    if (pl < 1e-7) return { x, z, nx: 0, nz: 0, hit: true };
    return { x, z, nx: px / pl, nz: pz / pl, hit: true };
  }
  /**
   * Does a cylinder with feet at y and top at y+h overlap any box?
   * Exact face contact (standing on a top, head brushing a ceiling) does
   * not count — only real penetration does.
   */
  hits(x, y, z, r, h) {
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS2 || y >= b.y + b.h - EPS2) continue;
      if (circleHitsRect(x, z, r, b)) return true;
    }
    return false;
  }
  /** Collect every box the cylinder penetrates at (x,y,z). */
  blockers(x, y, z, r, h, out) {
    out.length = 0;
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS2 || y >= b.y + b.h - EPS2) continue;
      if (circleHitsRect(x, z, r, b)) out.push(b);
    }
  }
  /** Lowest blocker top reachable by an auto-step from feetY (Infinity if none). */
  stepCandidate(blockers, feetY) {
    let best = Infinity;
    for (const b of blockers) {
      const top = b.y + b.h;
      const rise = top - feetY;
      if (rise > -EPS2 && rise <= STEP_HEIGHT + EPS2 && top < best) best = top;
    }
    return best;
  }
  /**
   * Advance a cylinder by vel*dt with box collision + walkable-polygon air walls.
   * `wasOnGround` gates auto-stepping (no stepping mid-air).
   * Air walls project candidate positions onto the nearest inward edge normal,
   * preserve wall sliding at 35% horizontal speed, and never block stairs/ramps.
   * `drowned` only triggers as a fallback when `pos.y < waterY`.
   */
  move(pos, vel, radius, height, dt, wasOnGround) {
    const p = { x: pos.x, y: pos.y, z: pos.z };
    const v = { x: vel.x, y: vel.y, z: vel.z };
    const disp = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) * dt;
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(disp / MAX_SUBSTEP)));
    const h = dt / steps;
    const scratch = [];
    let onGround = wasOnGround;
    let drowned = false;
    let hitAirWall = false;
    let airWallDamped = false;
    for (let i = 0; i < steps; i++) {
      const prevX = p.x;
      const prevZ = p.z;
      if (v.x !== 0) {
        const nx = p.x + v.x * h;
        this.blockers(nx, p.y, p.z, radius, height, scratch);
        const top = onGround ? this.stepCandidate(scratch, p.y) : Infinity;
        if (scratch.length === 0) {
          p.x = nx;
        } else if (top < Infinity && !this.hits(nx, top + EPS2, p.z, radius, height)) {
          p.x = nx;
          p.y = top;
        } else {
          const face = v.x > 0 ? Math.min(...scratch.map((b) => b.x - b.w / 2)) : Math.max(...scratch.map((b) => b.x + b.w / 2));
          p.x = v.x > 0 ? Math.min(nx, face - radius) : Math.max(nx, face + radius);
          v.x = 0;
        }
      }
      if (v.z !== 0) {
        const nz = p.z + v.z * h;
        this.blockers(p.x, p.y, nz, radius, height, scratch);
        const top = onGround ? this.stepCandidate(scratch, p.y) : Infinity;
        if (scratch.length === 0) {
          p.z = nz;
        } else if (top < Infinity && !this.hits(p.x, top + EPS2, nz, radius, height)) {
          p.z = nz;
          p.y = top;
        } else {
          const face = v.z > 0 ? Math.min(...scratch.map((b) => b.z - b.d / 2)) : Math.max(...scratch.map((b) => b.z + b.d / 2));
          p.z = v.z > 0 ? Math.min(nz, face - radius) : Math.max(nz, face + radius);
          v.z = 0;
        }
      }
      const wall = this.constrainToPolygon(p.x, p.z, radius);
      if (wall.hit) {
        hitAirWall = true;
        const slideDx = wall.x - prevX;
        const slideDz = wall.z - prevZ;
        if (!airWallDamped) {
          airWallDamped = true;
          const dampX = prevX + slideDx * AIR_WALL_SLIDE_DAMP;
          const dampZ = prevZ + slideDz * AIR_WALL_SLIDE_DAMP;
          const recheck = this.constrainToPolygon(dampX, dampZ, radius);
          p.x = recheck.x;
          p.z = recheck.z;
          const vn = v.x * wall.nx + v.z * wall.nz;
          if (vn < 0) {
            v.x = (v.x - vn * wall.nx) * AIR_WALL_SLIDE_DAMP;
            v.z = (v.z - vn * wall.nz) * AIR_WALL_SLIDE_DAMP;
          } else {
            v.x *= AIR_WALL_SLIDE_DAMP;
            v.z *= AIR_WALL_SLIDE_DAMP;
          }
        } else {
          p.x = wall.x;
          p.z = wall.z;
          const vn = v.x * wall.nx + v.z * wall.nz;
          if (vn < 0) {
            v.x -= vn * wall.nx;
            v.z -= vn * wall.nz;
          }
        }
        if (this.hits(p.x, p.y, p.z, radius, height)) {
          p.x = prevX;
          p.z = prevZ;
          v.x = 0;
          v.z = 0;
        }
      }
      const ny = p.y + v.y * h;
      if (v.y <= 0) {
        let floor = -Infinity;
        for (const b of this.boxes) {
          if (!circleHitsRect(p.x, p.z, radius, b)) continue;
          const top = b.y + b.h;
          if (top <= p.y + EPS2 && top >= ny && top > floor) floor = top;
        }
        if (floor > -Infinity) {
          p.y = floor;
          v.y = 0;
          onGround = true;
        } else {
          p.y = ny;
          onGround = false;
        }
      } else {
        let ceil = Infinity;
        const head0 = p.y + height;
        const head1 = ny + height;
        for (const b of this.boxes) {
          if (!circleHitsRect(p.x, p.z, radius, b)) continue;
          if (b.y >= head0 - EPS2 && b.y <= head1 && b.y < ceil) ceil = b.y;
        }
        if (ceil < Infinity) {
          p.y = ceil - height;
          v.y = 0;
        } else {
          p.y = ny;
        }
        onGround = false;
      }
      if (p.y < this.waterY) {
        drowned = true;
        break;
      }
    }
    return { pos: p, vel: v, onGround, drowned, hitAirWall };
  }
};

// src/game/ai.test.ts
var world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);
test("all patrol waypoints, cover spots, and enemy spawns lie cleanly inside deck & outside boxes", () => {
  for (const [label, pts] of [
    ["waypoint", PATROL_WAYPOINTS],
    ["cover", COVER_SPOTS],
    ["spawn", ENEMY_SPAWNS]
  ]) {
    for (const p of pts) {
      assert.equal(
        world.isInsideWalkable(p.x, p.z, BOT_RADIUS),
        true,
        `${label} (${p.x},${p.z}) outside walkable polygon`
      );
      assert.equal(
        world.hits(p.x, 0, p.z, BOT_RADIUS, BOT_HEIGHT),
        false,
        `${label} (${p.x},${p.z}) overlaps a map box`
      );
    }
  }
});
test("difficulty specs match EASY / NORMAL / HARD table and cap simultaneous enemies <= 5", () => {
  const e = getDifficultySpec("easy");
  const n = getDifficultySpec("normal");
  const h = getDifficultySpec("hard");
  assert.deepEqual([e.enemyDmg, e.hitRate, e.reactionMs, e.moveSpeed, e.totalEnemies, e.canTakeCover], [8, 0.25, 900, 2.4, 3, false]);
  assert.deepEqual([n.enemyDmg, n.hitRate, n.reactionMs, n.moveSpeed, n.totalEnemies, n.canTakeCover], [12, 0.4, 600, 3, 5, true]);
  assert.deepEqual([h.enemyDmg, h.hitRate, h.reactionMs, h.moveSpeed, h.totalEnemies, h.flankPairs], [16, 0.55, 350, 3.4, 7, true]);
  const mgr = new EnemyManager("hard", () => 0.4);
  mgr.reset(0, { x: -8, y: 0, z: 17 });
  assert.equal(mgr.bots.length, 5, "HARD caps simultaneous live enemies at 5");
});
test("spawns never land within 15m of player spawn and bots stay >= 1.5m apart", () => {
  const playerSpawn = { x: -8, y: 0, z: 17 };
  const mgr = new EnemyManager("normal", () => 0.35);
  mgr.reset(0, playerSpawn);
  assert.equal(mgr.bots.length, 5);
  for (const b2 of mgr.bots) {
    const dp = Math.hypot(b2.entity.pos.x - playerSpawn.x, b2.entity.pos.z - playerSpawn.z);
    assert.ok(dp >= MIN_PLAYER_SPAWN_DIST, `bot spawned ${dp.toFixed(2)}m < 15m from player`);
  }
  for (let i = 0; i < mgr.bots.length; i++) {
    for (let j = i + 1; j < mgr.bots.length; j++) {
      const d = Math.hypot(
        mgr.bots[i].entity.pos.x - mgr.bots[j].entity.pos.x,
        mgr.bots[i].entity.pos.z - mgr.bots[j].entity.pos.z
      );
      assert.ok(d >= MIN_BOT_SEPARATION - 1e-4, `bots ${i}&${j} too close: ${d.toFixed(2)}m`);
    }
  }
  mgr.clear();
  const a = mgr.spawnManual(0, -10, 0, "bl", 0);
  const b = mgr.spawnManual(0.2, -10, 0, "gr", 0);
  for (let t = 50; t <= 300; t += 50) {
    mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos: playerSpawn,
      playerEye: { x: playerSpawn.x, y: 1.7, z: playerSpawn.z },
      playerAlive: false,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world
    });
  }
  const sep = Math.hypot(a.entity.pos.x - b.entity.pos.x, a.entity.pos.z - b.entity.pos.z);
  assert.ok(sep >= MIN_BOT_SEPARATION - 0.02, `pairwise separation failed: ${sep.toFixed(3)}m`);
});
test("reaction delay & 0.18s fire_rifle hit trigger: EASY > 700ms; HARD < 500ms", () => {
  const runFirstFireDelay = (diff) => {
    const mgr = new EnemyManager(diff, () => 0.1);
    const playerPos = { x: 0, y: 0, z: 0 };
    const playerEye = { x: 0, y: 1.7, z: 0 };
    const bot = mgr.spawnManual(0, -10, yawFromDir(0, 10), "bl", 0);
    for (let t = 20; t <= 2e3; t += 20) {
      const shots = mgr.update({
        dt: 0.02,
        nowMs: t,
        playerPos,
        playerEye,
        playerAlive: true,
        playerFired: false,
        playerSpeed: 0,
        playerOnGround: true,
        boxes: MAP.boxes,
        collider: world
      });
      if (shots.length > 0) {
        return {
          delay: bot.firstShotAt - bot.firstSightAt,
          hitOffset: t - bot.fireAnimStartAt
        };
      }
    }
    return { delay: -1, hitOffset: -1 };
  };
  const easy = runFirstFireDelay("easy");
  const hard = runFirstFireDelay("hard");
  assert.ok(easy.delay >= 850 && easy.delay <= 1100, `EASY delay ${easy.delay}ms expected ~900ms`);
  assert.ok(hard.delay >= 300 && hard.delay <= 450, `HARD delay ${hard.delay}ms expected ~350ms`);
  assert.ok(easy.hitOffset >= FIRE_HIT_DELAY_MS && easy.hitOffset <= FIRE_HIT_DELAY_MS + 40, `hit offset ${easy.hitOffset}ms expected ~180ms`);
  assert.ok(hard.hitOffset >= FIRE_HIT_DELAY_MS && hard.hitOffset <= FIRE_HIT_DELAY_MS + 40, `hit offset ${hard.hitOffset}ms expected ~180ms`);
});
test("strict glTF clip state machine: IDLE->idle_rifle, PATROL->walk_rifle (1.4m/s), ENGAGE->aim_rifle/fire_rifle, RELOAD->reload_rifle (2.2s), COVER->crouch_rifle (1.2m/s)", () => {
  const mgr = new EnemyManager("normal", () => 0.2);
  const bot = mgr.spawnManual(0, -15.5, 0, "bl", 0);
  assert.equal(bot.state, "IDLE");
  assert.equal(bot.anim, "idle_rifle");
  let sawPatrol = false;
  for (let t = 50; t <= 2200; t += 50) {
    mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos: { x: 0, y: 0, z: 17 },
      playerEye: { x: 0, y: 1.7, z: 17 },
      playerAlive: false,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world
    });
    if (bot.state === "PATROL" && bot.speed > 0.5) {
      sawPatrol = true;
      assert.equal(bot.anim, "walk_rifle");
      assert.ok(Math.abs(bot.speed - PATROL_SPEED) < 0.2, `patrol speed ${bot.speed} != ${PATROL_SPEED}`);
      break;
    }
  }
  assert.equal(sawPatrol, true, "bot never entered PATROL");
  mgr.clear();
  const rbot = mgr.spawnManual(0, -10, yawFromDir(0, 10), "gr", 0);
  rbot.ammo = 1;
  let sawFireClip = false;
  let sawReloadClip = false;
  let shotsDuringReload = 0;
  for (let t = 20; t <= 3600; t += 20) {
    const wasReloading = rbot.state === "RELOAD";
    const shots = mgr.update({
      dt: 0.02,
      nowMs: t,
      playerPos: { x: 0, y: 0, z: 0 },
      playerEye: { x: 0, y: 1.7, z: 0 },
      playerAlive: true,
      playerFired: false,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world
    });
    if (rbot.anim === "fire_rifle") sawFireClip = true;
    if (rbot.state === "RELOAD") {
      sawReloadClip = true;
      assert.equal(rbot.anim, "reload_rifle");
    }
    if (wasReloading) shotsDuringReload += shots.length;
  }
  assert.equal(sawFireClip, true, "never played fire_rifle in ENGAGE");
  assert.equal(sawReloadClip, true, "never entered RELOAD when ammo hit 0");
  assert.equal(shotsDuringReload, 0, "bot fired during RELOAD!");
  assert.equal(BOT_RELOAD_MS, 2200);
  assert.equal(COVER_SPEED, 1.2);
});
test("enemies NEVER shoot through walls: 3s behind container consumes 0 ammo", () => {
  const mgr = new EnemyManager("hard", () => 0.1);
  const bot = mgr.spawnManual(-6, -7.2, yawFromDir(0, 6.4), "gr", 0);
  const playerPos = { x: -6, y: 0, z: -0.8 };
  const playerEye = { x: -6, y: 1.7, z: -0.8 };
  assert.equal(
    hasLineOfSight({ x: -6, y: 1.56, z: -7.2 }, playerEye, MAP.boxes),
    false,
    "test setup should be occluded by container"
  );
  let totalShots = 0;
  for (let t = 50; t <= 3e3; t += 50) {
    bot.entity.pos.x = -6;
    bot.entity.pos.z = -7.2;
    const shots = mgr.update({
      dt: 0.05,
      nowMs: t,
      playerPos,
      playerEye,
      playerAlive: true,
      playerFired: true,
      playerSpeed: 0,
      playerOnGround: true,
      boxes: MAP.boxes,
      collider: world
    });
    totalShots += shots.length;
  }
  assert.equal(totalShots, 0, "occluded bot fired through cover!");
  assert.equal(bot.ammo, bot.mag, "occluded bot consumed ammo");
});
test("wounded bot (<30% HP) enters COVER (crouch_rifle) on NORMAL, stays aggressive on EASY", () => {
  const mgrNorm = new EnemyManager("normal", () => 0.3);
  const bNorm = mgrNorm.spawnManual(0, -10, yawFromDir(0, 10), "bl", 0);
  applyDamage(bNorm.entity, 75, 100);
  mgrNorm.onBotDamaged(bNorm.entity, { x: 0, y: 0, z: 0 }, 100);
  assert.equal(bNorm.state, "COVER");
  const mgrEasy = new EnemyManager("easy", () => 0.3);
  const bEasy = mgrEasy.spawnManual(0, -10, yawFromDir(0, 10), "gr", 0);
  applyDamage(bEasy.entity, 75, 100);
  mgrEasy.onBotDamaged(bEasy.entity, { x: 0, y: 0, z: 0 }, 100);
  assert.notEqual(bEasy.state, "COVER");
});
test("killed bot collapses to DEAD (die) and replenishes a replacement after respawnDelayMs", () => {
  const mgr = new EnemyManager("hard", () => 0.5);
  mgr.reset(0, { x: -8, y: 0, z: 17 });
  const victim = mgr.bots[0];
  const oldId = victim.id;
  applyDamage(victim.entity, 200, 100);
  mgr.onBotDamaged(victim.entity, { x: -8, y: 0, z: 17 }, 100);
  assert.equal(victim.state, "DEAD");
  assert.equal(victim.anim, "die");
  mgr.update({
    dt: 0.05,
    nowMs: 100 + mgr.difficulty.respawnDelayMs + 50,
    playerPos: { x: -8, y: 0, z: 17 },
    playerEye: { x: -8, y: 1.7, z: 17 },
    playerAlive: true,
    playerFired: false,
    playerSpeed: 0,
    playerOnGround: true,
    boxes: MAP.boxes,
    collider: world
  });
  assert.notEqual(mgr.bots[0].id, oldId);
  assert.equal(mgr.bots[0].entity.alive, true);
  assert.equal(mgr.bots.length, 5);
});
