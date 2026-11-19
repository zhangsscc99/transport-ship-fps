// src/game/damage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/entities.ts
var RESPAWN_MS = 3e3;
var INVINCIBLE_MS = 1500;
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
var HEADSHOT_ZONE = 0.85;
var HEADSHOT_MULT = 2;
var FALLOFF_START = 25;
var FALLOFF_END = 50;
var FALLOFF_FLOOR = 0.6;
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
function rayCylinderT(o, d, pos, r, height) {
  const ox = o.x - pos.x;
  const oz = o.z - pos.z;
  const y0 = pos.y;
  const y1 = pos.y + height;
  let best = Infinity;
  const a = d.x * d.x + d.z * d.z;
  if (a > EPS) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= EPS) continue;
        const y = o.y + t * d.y;
        if (y >= y0 && y <= y1 && t < best) best = t;
      }
    }
  }
  if (Math.abs(d.y) > EPS) {
    for (const cap of [y0, y1]) {
      const t = (cap - o.y) / d.y;
      if (t <= EPS || t >= best) continue;
      const x = o.x + t * d.x - pos.x;
      const z = o.z + t * d.z - pos.z;
      if (x * x + z * z <= r * r) best = t;
    }
  }
  return best;
}
var at = (o, d, t) => ({
  x: o.x + t * d.x,
  y: o.y + t * d.y,
  z: o.z + t * d.z
});
function traceHit(ray2, boxes, entities) {
  let boxT = Infinity;
  let hitBox = null;
  for (const b of boxes) {
    const t = rayBoxT(ray2.origin, ray2.dir, b);
    if (t < boxT) {
      boxT = t;
      hitBox = b;
    }
  }
  let entT = boxT;
  let hitEnt = null;
  for (const e of entities) {
    if (!e.alive) continue;
    const t = rayCylinderT(ray2.origin, ray2.dir, e.pos, e.radius, e.height);
    if (t < entT) {
      entT = t;
      hitEnt = e;
    }
  }
  if (hitEnt) {
    const point = at(ray2.origin, ray2.dir, entT);
    return {
      kind: "entity",
      entity: hitEnt,
      point,
      dist: entT,
      headshot: point.y - hitEnt.pos.y > hitEnt.height * HEADSHOT_ZONE
    };
  }
  if (hitBox) return { kind: "box", box: hitBox, point: at(ray2.origin, ray2.dir, boxT), dist: boxT };
  return null;
}
function falloffFactor(spec, dist) {
  if (spec.noFalloff || dist <= FALLOFF_START) return 1;
  if (dist >= FALLOFF_END) return FALLOFF_FLOOR;
  const t = (dist - FALLOFF_START) / (FALLOFF_END - FALLOFF_START);
  return 1 - t * (1 - FALLOFF_FLOOR);
}
function applyDamage(e, dmg, now) {
  if (!e.alive || now < e.invincibleUntil) return false;
  e.hp = Math.max(0, e.hp - dmg);
  if (e.hp > 0) return false;
  e.alive = false;
  e.deadUntil = now + RESPAWN_MS;
  return true;
}
function updateRespawn(e, now, spawn) {
  if (e.alive || now < e.deadUntil) return false;
  e.alive = true;
  e.hp = e.maxHp;
  e.pos.x = spawn.x;
  e.pos.y = spawn.y;
  e.pos.z = spawn.z;
  e.invincibleUntil = now + INVINCIBLE_MS;
  return true;
}

// src/game/weapons.ts
var WEAPONS = [
  { id: "rifle", name: "\u7A81\u51FB\u6B65\u67AA", dmg: 24, rpm: 700, mag: 30, reloadMs: 1900, spread: 6e-3, recoil: 45e-4, pellets: 1 },
  { id: "sniper", name: "\u72D9\u51FB\u67AA", dmg: 95, rpm: 45, mag: 5, reloadMs: 3200, spread: 15e-4, recoil: 0.09, pellets: 1, noFalloff: true },
  { id: "shotgun", name: "\u9730\u5F39\u67AA", dmg: 12, rpm: 60, mag: 6, reloadMs: 2600, spread: 0.055, recoil: 0.02, pellets: 8 }
];

// src/game/damage.test.ts
var NO_BOXES = [];
function ray(ox, oy, oz, dx, dy, dz) {
  const l = Math.hypot(dx, dy, dz);
  return { origin: { x: ox, y: oy, z: oz }, dir: { x: dx / l, y: dy / l, z: dz / l } };
}
function entAt(x, z, patch = {}) {
  return { ...createEntity("e", { x, y: 0, z }), ...patch };
}
test("a clear shot hits the entity at the surface distance", () => {
  const e = entAt(0, -10);
  const hit = traceHit(ray(0, 1, 0, 0, 0, -1), NO_BOXES, [e]);
  assert.equal(hit.kind, "entity");
  if (hit.kind !== "entity") return;
  assert.equal(hit.entity, e);
  assert.ok(Math.abs(hit.dist - 9.65) < 1e-6, `dist ${hit.dist}`);
  assert.ok(Math.abs(hit.point.z + 9.65) < 1e-6);
});
test("a box between shooter and target occludes the entity", () => {
  const cover = { x: 0, y: 0, z: -5, w: 2, h: 2, d: 2, kind: "container" };
  const e = entAt(0, -10);
  const hit = traceHit(ray(0, 1, 0, 0, 0, -1), [cover], [e]);
  assert.equal(hit.kind, "box");
  if (hit.kind !== "box") return;
  assert.equal(hit.box, cover);
  assert.ok(Math.abs(hit.dist - 4) < 1e-6, `dist ${hit.dist}`);
});
test("hits in the top 15% count as headshots (\xD72), lower hits do not", () => {
  const e = entAt(0, -10);
  const head = traceHit(ray(0, 1.6, 0, 0, 0, -1), NO_BOXES, [e]);
  assert.equal(head.kind, "entity");
  if (head.kind === "entity") assert.equal(head.headshot, true);
  const torso = traceHit(ray(0, 1.3, 0, 0, 0, -1), NO_BOXES, [e]);
  if (torso.kind === "entity") assert.equal(torso.headshot, false);
  const edge = traceHit(ray(0, 0.85 * 1.7, 0, 0, 0, -1), NO_BOXES, [e]);
  if (edge.kind === "entity") assert.equal(edge.headshot, false);
});
test("closer entity wins over one behind it", () => {
  const near = entAt(0, -8);
  const far = entAt(0, -12);
  const hit = traceHit(ray(0, 1, 0, 0, 0, -1), NO_BOXES, [far, near]);
  assert.equal(hit.kind, "entity");
  if (hit.kind === "entity") assert.equal(hit.entity, near);
});
test("dead entities are ignored by traceHit", () => {
  const e = entAt(0, -10, { alive: false });
  assert.equal(traceHit(ray(0, 1, 0, 0, 0, -1), NO_BOXES, [e]), null);
});
test("damage falls off past 25m to a 0.6 floor; sniper is exempt", () => {
  const rifle = WEAPONS[0];
  const sniper = WEAPONS[1];
  assert.equal(falloffFactor(rifle, 20), 1);
  assert.equal(falloffFactor(rifle, 25), 1);
  const mid = falloffFactor(rifle, 37.5);
  assert.ok(Math.abs(mid - 0.8) < 1e-9, `mid ${mid}`);
  assert.equal(falloffFactor(rifle, 60), FALLOFF_FLOOR);
  assert.equal(falloffFactor(sniper, 200), 1);
});
test("applyDamage drains hp; lethal damage kills and starts the 3s timer", () => {
  const e = entAt(0, 0);
  assert.equal(applyDamage(e, 24, 0), false);
  assert.equal(e.hp, 76);
  assert.equal(applyDamage(e, 100, 1e3), true);
  assert.equal(e.alive, false);
  assert.equal(e.hp, 0);
  assert.equal(e.deadUntil, 1e3 + RESPAWN_MS);
  assert.equal(applyDamage(e, 50, 1100), false);
  assert.equal(e.hp, 0);
});
test("respawn at deadUntil restores hp, teleports, grants 1.5s protection", () => {
  const e = entAt(0, 0);
  applyDamage(e, 200, 0);
  const spawn = { x: 5, y: 0, z: 7 };
  assert.equal(updateRespawn(e, RESPAWN_MS - 1, spawn), false);
  assert.equal(updateRespawn(e, RESPAWN_MS, spawn), true);
  assert.equal(e.alive, true);
  assert.equal(e.hp, e.maxHp);
  assert.deepEqual(e.pos, spawn);
  assert.equal(e.invincibleUntil, RESPAWN_MS + INVINCIBLE_MS);
  assert.equal(applyDamage(e, 50, RESPAWN_MS + 100), false);
  assert.equal(e.hp, e.maxHp);
  assert.equal(applyDamage(e, 200, RESPAWN_MS + INVINCIBLE_MS), true);
});
test("headshot doubles the pellet damage end-to-end", () => {
  const e = entAt(0, -10);
  const hit = traceHit(ray(0, 1.6, 0, 0, 0, -1), NO_BOXES, [e]);
  assert.equal(hit.kind, "entity");
  if (hit.kind !== "entity") return;
  const dmg = WEAPONS[0].dmg * falloffFactor(WEAPONS[0], hit.dist) * (hit.headshot ? HEADSHOT_MULT : 1);
  applyDamage(e, dmg, 0);
  assert.equal(e.hp, 100 - 48);
});
test("each shotgun pellet damages independently", () => {
  const e = entAt(0, -5);
  const pellets = [
    ray(0, 1, 0, 0, 0, -1),
    ray(0, 1, 0, 0.05, 0, -1),
    ray(0, 1.6, 0, 0, 0, -1),
    ray(0, 1, 0, 1, 0, 0),
    ray(0, 1, 0, 0, 1, -0.2),
    ray(0, 1, 0, -1, 0, 0),
    ray(0, 1, 0, 0, 0, 1),
    ray(0, 1, 0, 0.9, 0.9, -0.1)
  ];
  let total = 0;
  let hits = 0;
  for (const p of pellets) {
    const h = traceHit(p, NO_BOXES, [e]);
    if (h?.kind === "entity") {
      hits++;
      const dmg = WEAPONS[2].dmg * falloffFactor(WEAPONS[2], h.dist) * (h.headshot ? HEADSHOT_MULT : 1);
      applyDamage(e, dmg, 0);
      total += dmg;
    }
  }
  assert.equal(hits, 3);
  assert.equal(e.hp, 100 - total);
  assert.ok(Math.abs(total - 48) < 1e-6, `total ${total}`);
});
