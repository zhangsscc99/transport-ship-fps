// First-person player state & movement — pure logic, no three.js / DOM.
// Spec numbers from docs/SPEC.md §移动: walk 4.2 / run 6.0 / crouch 1.9,
// jump initial velocity 4.8, gravity -18.

export const MOVE = {
  walkSpeed: 4.2,
  runSpeed: 6.0,
  crouchSpeed: 1.9,
  jumpSpeed: 4.8,
  gravity: -18,
  eyeHeight: 1.7,
  crouchEyeHeight: 1.15,
  pitchLimit: (85 * Math.PI) / 180,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Per-frame intent produced by the input layer (keyboard/mouse or touch). */
export interface InputState {
  moveX: number; // strafe, +1 = right
  moveZ: number; // +1 = forward
  run: boolean;
  crouch: boolean;
  jump: boolean; // edge-triggered, consumed on use
  yawDelta: number; // radians to add to yaw this frame
  pitchDelta: number; // radians to add to pitch this frame
  fire: boolean;
  reload: boolean;
}

export function emptyInput(): InputState {
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
  };
}

/** World queries injected so game logic stays decoupled from the map/collision impl. */
export interface WorldQuery {
  /** True when (x,z) is inside the playable bounds. */
  isInside?: (x: number, z: number) => boolean;
  /** Ground surface height at (x,z); defaults to 0 (flat deck). */
  groundHeight?: (x: number, z: number) => number;
}

/** Wrap angle to (-PI, PI]. */
export function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

export class Player {
  readonly position: Vec3;
  readonly velocity: Vec3;
  yaw = 0;
  pitch = 0;
  crouch = false;
  onGround = true;

  constructor(spawn: Vec3 = { x: 0, y: 0, z: 0 }, yaw = 0) {
    this.position = { ...spawn };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.yaw = yaw;
  }

  get eyeHeight(): number {
    return this.crouch ? MOVE.crouchEyeHeight : MOVE.eyeHeight;
  }

  /** Forward unit vector on the XZ plane derived from yaw. */
  forward(): { x: number; z: number } {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  update(dt: number, input: InputState, world: WorldQuery = {}): void {
    // --- look ---
    this.yaw = wrapPi(this.yaw + input.yawDelta);
    this.pitch = Math.max(-MOVE.pitchLimit, Math.min(MOVE.pitchLimit, this.pitch + input.pitchDelta));

    // --- move ---
    this.crouch = input.crouch;
    const speed = this.crouch ? MOVE.crouchSpeed : input.run ? MOVE.runSpeed : MOVE.walkSpeed;

    const fwd = this.forward();
    const right = { x: -fwd.z, z: fwd.x };
    let wx = fwd.x * input.moveZ + right.x * input.moveX;
    let wz = fwd.z * input.moveZ + right.z * input.moveX;
    const len = Math.hypot(wx, wz);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    this.velocity.x = wx * speed;
    this.velocity.z = wz * speed;

    // --- jump / gravity ---
    if (input.jump && this.onGround) {
      this.velocity.y = MOVE.jumpSpeed;
      this.onGround = false;
    }
    this.velocity.y += MOVE.gravity * dt;

    // --- integrate with bounds check (slide along edges) ---
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
}
