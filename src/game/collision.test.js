// src/game/collision.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/collision.ts
var PLAYER_RADIUS = 0.35;
var STEP_HEIGHT = 0.35;
var EPS = 1e-4;
var MAX_SUBSTEP = 0.15;
var MAX_STEPS = 64;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function circleHitsRect(x, z, r, b) {
  const qx = clamp(x, b.x - b.w / 2, b.x + b.w / 2);
  const qz = clamp(z, b.z - b.d / 2, b.z + b.d / 2);
  const dx = x - qx;
  const dz = z - qz;
  return dx * dx + dz * dz < r * r - EPS;
}
var CollisionWorld = class {
  constructor(boxes, bounds, waterY) {
    this.boxes = boxes;
    this.bounds = bounds;
    this.waterY = waterY;
  }
  insideBounds(x, z) {
    return Math.abs(x) <= this.bounds.w / 2 && Math.abs(z) <= this.bounds.d / 2;
  }
  /**
   * Does a cylinder with feet at y and top at y+h overlap any box?
   * Exact face contact (standing on a top, head brushing a ceiling) does
   * not count — only real penetration does.
   */
  hits(x, y, z, r, h) {
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS || y >= b.y + b.h - EPS) continue;
      if (circleHitsRect(x, z, r, b)) return true;
    }
    return false;
  }
  /** Collect every box the cylinder penetrates at (x,y,z). */
  blockers(x, y, z, r, h, out) {
    out.length = 0;
    for (const b of this.boxes) {
      if (y + h <= b.y + EPS || y >= b.y + b.h - EPS) continue;
      if (circleHitsRect(x, z, r, b)) out.push(b);
    }
  }
  /** Lowest blocker top reachable by an auto-step from feetY (Infinity if none). */
  stepCandidate(blockers, feetY) {
    let best = Infinity;
    for (const b of blockers) {
      const top = b.y + b.h;
      const rise = top - feetY;
      if (rise > -EPS && rise <= STEP_HEIGHT + EPS && top < best) best = top;
    }
    return best;
  }
  /**
   * Advance a cylinder by vel*dt with collision response.
   * `wasOnGround` gates auto-stepping (no stepping mid-air).
   * Returns the resolved position/velocity; `drowned` when the body left
   * the ship bounds or sank below waterY.
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
    for (let i = 0; i < steps; i++) {
      if (v.x !== 0) {
        const nx = p.x + v.x * h;
        this.blockers(nx, p.y, p.z, radius, height, scratch);
        const top = onGround ? this.stepCandidate(scratch, p.y) : Infinity;
        if (scratch.length === 0) {
          p.x = nx;
        } else if (top < Infinity && !this.hits(nx, top + EPS, p.z, radius, height)) {
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
        } else if (top < Infinity && !this.hits(p.x, top + EPS, nz, radius, height)) {
          p.z = nz;
          p.y = top;
        } else {
          const face = v.z > 0 ? Math.min(...scratch.map((b) => b.z - b.d / 2)) : Math.max(...scratch.map((b) => b.z + b.d / 2));
          p.z = v.z > 0 ? Math.min(nz, face - radius) : Math.max(nz, face + radius);
          v.z = 0;
        }
      }
      const ny = p.y + v.y * h;
      if (v.y <= 0) {
        let floor = -Infinity;
        for (const b of this.boxes) {
          if (!circleHitsRect(p.x, p.z, radius, b)) continue;
          const top = b.y + b.h;
          if (top <= p.y + EPS && top >= ny && top > floor) floor = top;
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
          if (b.y >= head0 - EPS && b.y <= head1 && b.y < ceil) ceil = b.y;
        }
        if (ceil < Infinity) {
          p.y = ceil - height;
          v.y = 0;
        } else {
          p.y = ny;
        }
        onGround = false;
      }
      if (!this.insideBounds(p.x, p.z) || p.y < this.waterY) {
        drowned = true;
        break;
      }
    }
    return { pos: p, vel: v, onGround, drowned };
  }
};

// src/game/player.ts
var MOVE = {
  walkSpeed: 4.2,
  runSpeed: 6,
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
    run: false,
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
  /** Set by the collider when the body leaves the ship / hits water. */
  drowned = false;
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
  update(dt, input2, world2 = {}) {
    this.yaw = wrapPi(this.yaw + input2.yawDelta);
    this.pitch = Math.max(-MOVE.pitchLimit, Math.min(MOVE.pitchLimit, this.pitch + input2.pitchDelta));
    if (!input2.crouch && this.crouch && world2.collider) {
      const p2 = this.position;
      this.crouch = world2.collider.hits(p2.x, p2.y, p2.z, PLAYER_RADIUS, MOVE.eyeHeight);
    } else {
      this.crouch = input2.crouch;
    }
    const speed = this.crouch ? MOVE.crouchSpeed : input2.run ? MOVE.runSpeed : MOVE.walkSpeed;
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
    if (world2.collider) {
      const res = world2.collider.move(
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
      if (res.drowned) this.drowned = true;
      return;
    }
    const inside = world2.isInside ?? (() => true);
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
    const ground = world2.groundHeight?.(nx, nz) ?? 0;
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
var MAP = {
  bounds: { w: 64, d: 40 },
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

// src/game/collision.test.ts
var DT = 1 / 120;
var world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY);
var WQ = { collider: world };
function input(patch = {}) {
  return { ...emptyInput(), ...patch };
}
function step(p, inp, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) p.update(DT, inp, WQ);
}
test("head-on sprint into a container stops at its face and stays stable", () => {
  const p = new Player({ x: -6, y: 0, z: 0 });
  step(p, input({ moveZ: 1, run: true }), 1.2);
  const face = -2.75 + PLAYER_RADIUS;
  assert.ok(Math.abs(p.position.z - face) < 0.02, `z ${p.position.z}`);
  assert.equal(p.velocity.z, 0);
  for (let i = 0; i < 60; i++) p.update(DT, input({ moveZ: 1, run: true }), WQ);
  assert.ok(Math.abs(p.position.z - face) < 0.02, `drifted to ${p.position.z}`);
});
test("diagonal pressure slides along the wall (strafe keeps moving)", () => {
  const p = new Player({ x: -5, y: 0, z: -1.5 });
  step(p, input({ moveZ: 1, moveX: -1, run: true }), 0.5);
  assert.ok(Math.abs(p.position.z - (-2.75 + PLAYER_RADIUS)) < 0.05, `z ${p.position.z}`);
  assert.ok(p.position.x < -6.5, `slid to x ${p.position.x}`);
});
test("walks up tower stairs via auto-step (no jump needed)", () => {
  const p = new Player({ x: -16, y: 0, z: 14 });
  step(p, input({ moveX: -1, run: true }), 4);
  assert.ok(p.position.y > 2.9, `y ${p.position.y}`);
  assert.ok(p.position.x < -22.5, `x ${p.position.x}`);
  assert.ok(p.onGround);
});
test("jumping under a pipe roof bumps the head and lands back", () => {
  const p = new Player({ x: -30, y: 0, z: 5 });
  p.update(DT, input({ jump: true }), WQ);
  let maxY = 0;
  for (let i = 0; i < Math.round(1.4 / DT); i++) {
    p.update(DT, input(), WQ);
    maxY = Math.max(maxY, p.position.y);
  }
  assert.ok(maxY <= 0.31, `maxY ${maxY}`);
  assert.equal(p.position.y, 0);
  assert.ok(p.onGround);
});
test("leaving the ship bounds drowns", () => {
  const p = new Player({ x: 31, y: 0, z: 19 });
  step(p, input({ moveX: 1, run: true }), 1);
  assert.equal(p.drowned, true);
});
test("sinking below waterY drowns (direct move call)", () => {
  const res = world.move(
    { x: 0, y: -2.6, z: 0 },
    { x: 0, y: -3, z: 0 },
    PLAYER_RADIUS,
    MOVE.eyeHeight,
    DT,
    false
  );
  assert.equal(res.drowned, true);
});
test("fast movement cannot tunnel through a 0.3m wall", () => {
  const res = world.move(
    { x: -28.5, y: 0, z: 5 },
    { x: -30, y: 0, z: 0 },
    PLAYER_RADIUS,
    MOVE.eyeHeight,
    1 / 20,
    true
  );
  assert.ok(res.pos.x >= -29.1 + PLAYER_RADIUS - 1e-3, `tunneled to x ${res.pos.x}`);
  assert.ok(!world.hits(res.pos.x, res.pos.y, res.pos.z, PLAYER_RADIUS, MOVE.eyeHeight));
});
function lowCeilingWorld() {
  const boxes = [
    { x: 0, y: -1, z: 0, w: 30, h: 1, d: 30, kind: "deck" },
    { x: 0, y: 1.4, z: -5, w: 8, h: 0.5, d: 6, kind: "pipe" }
    // 1.4m ceiling over z∈[-8,-2]
  ];
  const w = new CollisionWorld(boxes, { w: 30, d: 30 }, -2);
  return { world: w, wq: { collider: w } };
}
test("standing is blocked by a low ceiling but crouching passes under", () => {
  const { wq } = lowCeilingWorld();
  const p = new Player({ x: 0, y: 0, z: 2 });
  const n = Math.round(1.2 / DT);
  for (let i = 0; i < n; i++) p.update(DT, input({ moveZ: 1 }), wq);
  assert.ok(p.position.z >= -2 + PLAYER_RADIUS - 0.02, `standing reached z ${p.position.z}`);
  assert.ok(p.position.z > -2.4, `overshot to ${p.position.z}`);
  const c = new Player({ x: 0, y: 0, z: 2 });
  for (let i = 0; i < Math.round(4 / DT); i++) c.update(DT, input({ moveZ: 1, crouch: true }), wq);
  assert.ok(c.position.z < -5, `crouch only reached z ${c.position.z}`);
});
test("cannot stand back up under a low ceiling", () => {
  const { wq } = lowCeilingWorld();
  const p = new Player({ x: 0, y: 0, z: -5 });
  p.update(DT, input({ crouch: true }), wq);
  assert.equal(p.crouch, true);
  for (let i = 0; i < 30; i++) p.update(DT, input({ crouch: false }), wq);
  assert.equal(p.crouch, true, "stood up into the ceiling");
});
test("falls and lands on top of a container", () => {
  const p = new Player({ x: -12, y: 3.6, z: 11 });
  p.onGround = false;
  step(p, input(), 1.2);
  assert.ok(Math.abs(p.position.y - 2.6) < 1e-6, `y ${p.position.y}`);
  assert.ok(p.onGround);
});
test("a 0.55m cover is too tall for auto-step \u2014 it blocks", () => {
  const p = new Player({ x: -2, y: 0, z: 3 });
  step(p, input({ moveZ: 1, run: true }), 1);
  assert.ok(p.position.z >= 1.6 + PLAYER_RADIUS - 0.02, `z ${p.position.z}`);
  assert.ok(p.position.z < 2.05, `overshot to ${p.position.z}`);
  assert.equal(p.position.y, 0);
});
