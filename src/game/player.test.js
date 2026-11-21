// src/game/player.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/collision.ts
var PLAYER_RADIUS = 0.35;

// src/game/player.ts
var MOVE = {
  walkSpeed: 4.2,
  crouchSpeed: 1.9,
  jumpSpeed: 4.8,
  gravity: -18,
  eyeHeight: 1.7,
  crouchEyeHeight: 1.15,
  pitchLimit: 85 * Math.PI / 180
};
function emptyInput() {
  return {
    moveX: 0,
    moveZ: 0,
    crouch: false,
    jump: false,
    yawDelta: 0,
    pitchDelta: 0,
    fire: false,
    reload: false,
    swap: false
  };
}
function wrapPi(a) {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}
var Player = class {
  position;
  velocity;
  yaw = 0;
  pitch = 0;
  crouch = false;
  onGround = true;
  /** Set by the collider when the body falls below waterY. */
  drowned = false;
  /** True on frames where the player capsule slid against a dock-edge air wall. */
  hitAirWall = false;
  constructor(spawn = { x: 0, y: 0, z: 0 }, yaw = 0) {
    this.position = { ...spawn };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.yaw = yaw;
  }
  get eyeHeight() {
    return this.crouch ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
  }
  /** Forward unit vector on the XZ plane derived from yaw. */
  forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }
  update(dt, input2, world = {}) {
    this.yaw = wrapPi(this.yaw + input2.yawDelta);
    this.pitch = Math.max(-MOVE.pitchLimit, Math.min(MOVE.pitchLimit, this.pitch + input2.pitchDelta));
    if (!input2.crouch && this.crouch && world.collider) {
      const p2 = this.position;
      this.crouch = world.collider.hits(p2.x, p2.y, p2.z, PLAYER_RADIUS, MOVE.eyeHeight);
    } else {
      this.crouch = input2.crouch;
    }
    const speed = (this.crouch ? MOVE.crouchSpeed : MOVE.walkSpeed) * (world.speedMult ?? 1);
    const fwd = this.forward();
    const right = { x: -fwd.z, z: fwd.x };
    let wx = fwd.x * input2.moveZ + right.x * input2.moveX;
    let wz = fwd.z * input2.moveZ + right.z * input2.moveX;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    this.velocity.x = wx * speed;
    this.velocity.z = wz * speed;
    if (input2.jump && this.onGround) {
      this.velocity.y = MOVE.jumpSpeed;
      this.onGround = false;
    }
    this.velocity.y += MOVE.gravity * dt;
    if (world.collider) {
      const res = world.collider.move(
        this.position,
        this.velocity,
        PLAYER_RADIUS,
        this.eyeHeight,
        dt,
        this.onGround
      );
      const p2 = this.position;
      p2.x = res.pos.x;
      p2.y = res.pos.y;
      p2.z = res.pos.z;
      this.velocity.x = res.vel.x;
      this.velocity.y = res.vel.y;
      this.velocity.z = res.vel.z;
      this.onGround = res.onGround;
      this.hitAirWall = Boolean(res.hitAirWall);
      if (res.drowned) this.drowned = true;
      return;
    }
    this.hitAirWall = false;
    const inside = world.isInside ?? (() => true);
    const p = this.position;
    let nx = p.x + this.velocity.x * dt;
    let nz = p.z + this.velocity.z * dt;
    if (!inside(nx, nz)) {
      if (inside(nx, p.z)) {
        nz = p.z;
        this.velocity.z = 0;
      } else if (inside(p.x, nz)) {
        nx = p.x;
        this.velocity.x = 0;
      } else {
        nx = p.x;
        nz = p.z;
        this.velocity.x = 0;
        this.velocity.z = 0;
      }
    }
    const ground = world.groundHeight?.(nx, nz) ?? 0;
    let ny = p.y + this.velocity.y * dt;
    if (ny <= ground && this.velocity.y <= 0) {
      ny = ground;
      this.velocity.y = 0;
      this.onGround = true;
    } else if (ny > ground + 1e-6) {
      this.onGround = false;
    }
    p.x = nx;
    p.y = ny;
    p.z = nz;
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
function isInsideBounds(x, z) {
  return Math.abs(x) <= MAP.bounds.w / 2 && Math.abs(z) <= MAP.bounds.d / 2;
}

// src/game/player.test.ts
var DT = 1 / 120;
function input(patch = {}) {
  return { ...emptyInput(), ...patch };
}
function step(p, inp, seconds, world = {}) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) p.update(DT, inp, world);
}
test("walk speed is 4.2 m/s and moves forward", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 1 }), 0.5);
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  assert.ok(Math.abs(speed - MOVE.walkSpeed) < 1e-6, `speed ${speed}`);
  assert.ok(p.position.z < -1.5, `z ${p.position.z}`);
});
test("speed scales linearly with stick magnitude; crouch is 1.9 and sets the flag", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 0.5 }), 0.3);
  assert.ok(Math.abs(Math.hypot(p.velocity.x, p.velocity.z) - MOVE.walkSpeed * 0.5) < 1e-6);
  step(p, input({ moveZ: 1 }), 0.3);
  assert.ok(Math.abs(Math.hypot(p.velocity.x, p.velocity.z) - MOVE.walkSpeed) < 1e-6);
  step(p, input({ moveZ: 1, crouch: true }), 0.3);
  assert.ok(Math.abs(Math.hypot(p.velocity.x, p.velocity.z) - MOVE.crouchSpeed) < 1e-6);
  assert.equal(p.crouch, true);
  assert.equal(p.eyeHeight, MOVE.crouchEyeHeight);
});
test("diagonal movement is normalized to walk speed", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 1, moveX: 1 }), 0.3);
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  assert.ok(speed <= MOVE.walkSpeed + 1e-6, `speed ${speed}`);
  assert.ok(speed > 3.5, `speed ${speed} too low`);
});
test("jump apex \u2248 v\xB2/2g \u2248 0.64m then lands on ground", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  const air = input({ jump: true });
  p.update(DT, air);
  assert.equal(p.onGround, false);
  let apex = 0;
  const steps = Math.round(1.2 / DT);
  let landedAt = -1;
  for (let i = 0; i < steps; i++) {
    p.update(DT, input());
    apex = Math.max(apex, p.position.y);
    if (p.onGround && landedAt < 0) landedAt = (i + 1) * DT;
  }
  const expectedApex = MOVE.jumpSpeed * MOVE.jumpSpeed / (2 * -MOVE.gravity);
  assert.ok(Math.abs(apex - expectedApex) < 0.03, `apex ${apex}`);
  const expectedAir = 2 * MOVE.jumpSpeed / -MOVE.gravity;
  assert.ok(landedAt > 0 && Math.abs(landedAt - expectedAir) < 0.05, `airtime ${landedAt}`);
  assert.equal(p.position.y, 0);
  assert.equal(p.onGround, true);
});
test("yaw wraps into (-\u03C0, \u03C0]", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  p.update(DT, input({ yawDelta: 7 }));
  assert.ok(p.yaw > -Math.PI && p.yaw <= Math.PI, `yaw ${p.yaw}`);
  p.update(DT, input({ yawDelta: -15 }));
  assert.ok(p.yaw > -Math.PI && p.yaw <= Math.PI, `yaw ${p.yaw}`);
  assert.equal(wrapPi(Math.PI), Math.PI);
  assert.equal(wrapPi(-Math.PI), Math.PI);
});
test("pitch clamps to \xB185\xB0", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  p.update(DT, input({ pitchDelta: 2 }));
  assert.ok(Math.abs(p.pitch - MOVE.pitchLimit) < 1e-9);
  p.update(DT, input({ pitchDelta: -4 }));
  assert.ok(Math.abs(p.pitch + MOVE.pitchLimit) < 1e-9);
});
test("cannot leave map bounds (slides along the edge)", () => {
  const p = new Player({ x: 31.8, y: 0, z: 0 });
  const world = { isInside: isInsideBounds };
  step(p, input({ moveX: 1 }), 0.5, world);
  assert.ok(p.position.x <= MAP.bounds.w / 2, `x ${p.position.x}`);
  const p2 = new Player({ x: 0, y: 0, z: -19.8 });
  step(p2, input({ moveZ: 1 }), 0.5, world);
  assert.ok(p2.position.z >= -MAP.bounds.d / 2, `z ${p2.position.z}`);
});
test("falls back to ground height when airborne", () => {
  const p = new Player({ x: 0, y: 3, z: 0 });
  p.onGround = false;
  step(p, input(), 1);
  assert.equal(p.position.y, 0);
  assert.equal(p.onGround, true);
  assert.equal(p.velocity.y, 0);
});
test("weapon speedMult (0.82 for gatling) scales walk speed proportionally", () => {
  const p = new Player({ x: 0, y: 0, z: 0 });
  step(p, input({ moveZ: 1 }), 0.3, { speedMult: 0.82 });
  const speed = Math.hypot(p.velocity.x, p.velocity.z);
  assert.ok(Math.abs(speed - MOVE.walkSpeed * 0.82) < 1e-6, `gatling speed ${speed}`);
});
