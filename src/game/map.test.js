// src/game/map.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

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
function isInsideBounds(x, z) {
  return Math.abs(x) <= MAP.bounds.w / 2 && Math.abs(z) <= MAP.bounds.d / 2;
}
function isInWater(y) {
  return y < MAP.waterY;
}
function spawnPoint(team, index) {
  const list = team === "A" ? MAP.spawns.teamA : MAP.spawns.teamB;
  return list[(index % list.length + list.length) % list.length];
}
function pointInBox(x, y, z, b) {
  return x > b.x - b.w / 2 && x < b.x + b.w / 2 && y > b.y && y < b.y + b.h && z > b.z - b.d / 2 && z < b.z + b.d / 2;
}

// src/game/map.test.ts
var EPS = 1e-6;
function rangeOverlap(aMin, aMax, bMin, bMax) {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) > EPS;
}
function boxesOverlap(a, b) {
  return rangeOverlap(a.x - a.w / 2, a.x + a.w / 2, b.x - b.w / 2, b.x + b.w / 2) && rangeOverlap(a.y, a.y + a.h, b.y, b.y + b.h) && rangeOverlap(a.z - a.d / 2, a.z + a.d / 2, b.z - b.d / 2, b.z + b.d / 2);
}
test("collider inventory: deck, 8 containers, 4 towers w/ stairs, pipes, crates", () => {
  const by = (k) => MAP.boxes.filter((b) => b.kind === k);
  assert.equal(by("deck").length, 1);
  assert.equal(by("container").filter((b) => b.h === 2.6).length, 8, "full containers");
  assert.equal(by("container").filter((b) => b.h === 0.55).length, 2, "low covers");
  assert.equal(by("pipe").length, 6, "2 walls + 1 roof per pipe");
  assert.equal(by("rail").length, 20, "5 rails per tower \xD74");
  const steps = by("tower").filter((b) => b.w === 0.6);
  assert.equal(steps.length, 40, "10 stair steps per tower");
  assert.ok(by("tower").some((b) => b.h === 3 && b.w > 3), "tower bases exist");
  assert.ok(MAP.boxes.length > 80);
});
test("all spawn points are inside bounds and not inside any collider", () => {
  for (const team of ["A", "B"]) {
    assert.equal(MAP.spawns[team === "A" ? "teamA" : "teamB"].length, 5);
    for (let i = 0; i < 5; i++) {
      const [x, y, z] = spawnPoint(team, i);
      assert.ok(isInsideBounds(x, z), `spawn ${team}${i} out of bounds`);
      assert.equal(y, 0);
      for (const b of MAP.boxes) {
        assert.ok(!pointInBox(x, y + 0.5, z, b), `spawn ${team}${i} inside ${b.kind}`);
      }
    }
  }
  assert.deepEqual(spawnPoint("A", 7), MAP.spawns.teamA[2]);
});
test("two pipes connect own half to enemy flank, walkable and roofed", () => {
  assert.equal(MAP.pipes.length, 2);
  const pipes = MAP.boxes.filter((b) => b.kind === "pipe");
  for (const p of MAP.pipes) {
    const [fx, fz] = p.from;
    const [tx, tz] = p.to;
    const dist = Math.hypot(tx - fx, tz - fz);
    assert.ok(dist >= 25, `pipe too short: ${dist}`);
    assert.ok(isInsideBounds(fx, fz) && isInsideBounds(tx, tz));
    for (let t = 0; t <= 1; t += 0.1) {
      const x = fx + (tx - fx) * t;
      const z = fz + (tz - fz) * t;
      for (const b of MAP.boxes) {
        assert.ok(!pointInBox(x, 1, z, b), `pipe blocked at ${x},${z} by ${b.kind}`);
      }
      assert.ok(
        pipes.some((b) => pointInBox(x - 1.05, 1, z, b)),
        `missing west wall near ${x},${z}`
      );
      assert.ok(
        pipes.some((b) => pointInBox(x + 1.05, 1, z, b)),
        `missing east wall near ${x},${z}`
      );
      assert.ok(pipes.some((b) => pointInBox(x, 2.1, z, b)), `missing roof near ${x},${z}`);
    }
  }
});
test("no solid boxes overlap (touching faces allowed)", () => {
  const solid = MAP.boxes.filter((b) => b.kind !== "deck");
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      assert.ok(
        !boxesOverlap(solid[i], solid[j]),
        `overlap: ${JSON.stringify(solid[i])} vs ${JSON.stringify(solid[j])}`
      );
    }
  }
});
test("bounds and water checks", () => {
  assert.ok(isInsideBounds(0, 0));
  assert.ok(isInsideBounds(-31.9, 19.9));
  assert.ok(!isInsideBounds(33, 0));
  assert.ok(!isInsideBounds(0, -21));
  assert.ok(isInWater(-2.5));
  assert.ok(!isInWater(-2));
  assert.ok(!isInWater(0));
});
test("every box lies inside the world bounds", () => {
  for (const b of MAP.boxes) {
    assert.ok(isInsideBounds(b.x - b.w / 2, b.z - b.d / 2), `${b.kind} sticks out of bounds`);
    assert.ok(isInsideBounds(b.x + b.w / 2, b.z + b.d / 2), `${b.kind} sticks out of bounds`);
  }
});
