// Boss Parabolic Artillery System — pure ballistics + procedural Three.js shells,
// parabolic contrail ribbons, high-contrast ground landing telegraphs, and
// impact explosions + shockwave rings. Zero external assets, zero physics engines.
//
// Triangle budget: strictly <= 1,500 tris across all simultaneous artillery objects.

import * as THREE from 'three';
import { CollisionWorld } from './collision';
import { MAP } from './map';
import type { Vec3 } from './player';

export const ARTILLERY_CONFIG = {
  /** Downward gravitational acceleration g (m/s²) in y(t) = y0 + vy*t - 0.5*g*t^2. */
  gravity: 16.0,
  /** Ground blast & warning indicator radius (m). Diameter = 6.4m for clear 390x844 readability. */
  blastRadius: 3.2,
  /** Direct AoE damage when player is within blastRadius at impact (player maxHp = 200). */
  damage: 40,
  /** Vertical tolerance (m) for blast hit check above/below impact surface. */
  blastVerticalTolerance: 3.2,

  /** Reference player max run/sprint speeds (m/s) used in the dodgeability inequality. */
  playerBaseMaxSpeed: 5.2,
  playerSprintSpeed: 8.6,
  dodgeSafetyFactor: 1.6,

  // 预警时长安全不等式（硬性约束，即使狂暴阶段 hpPct <= 0.35 也不得打破）：
  //   预警时长 × 5.2 > 标识半径 × 1.6
  //   minTelegraphSec (1.40s) × 5.2 = 7.28m > blastRadius (3.2m) × 1.6 = 5.12m  (满足且留 42% 余量)
  //   按游戏当前实机走速 4.2 m/s：1.40s × 4.2 = 5.88m > 5.12m  (玩家站在圆心不靠冲刺也能稳步跑出)
  minTelegraphSec: 1.40,
  phase1FlightBaseSec: 1.50,
  phase1FlightPerMeter: 0.008,
  phase1FlightMaxSec: 1.85,
  enragedFlightBaseSec: 1.40,
  enragedFlightPerMeter: 0.005,
  enragedFlightMaxSec: 1.65,

  /** Multi-shell salvo fan geometry (Phase 2: 2 shells, Enraged <=35%: 3 shells). */
  fanAngleDeg: 22,
  minFanSeparationMult: 2.1,

  /** Launch mount offsets relative to Boss root (upper shoulder/dorsal mortar pod). */
  muzzleHeightOffset: 3.55,
  muzzleForwardOffset: 0.65,
  muzzleSideOffset: 0.72,

  /** Visual lifetimes (s). */
  impactVfxDurationSec: 0.68,
  muzzleVfxDurationSec: 0.24,
  trailHistorySec: 1.25,

  /** Maximum allowed simultaneous triangles for all artillery meshes combined. */
  maxTriangleBudget: 1500,
} as const;

const EPS = 1e-6;
const DEG2RAD = Math.PI / 180;
const TRAIL_SEGMENTS = 16;
const SMOKE_PUFFS_PER_SHELL = 8;

export interface BallisticSolution {
  origin: Vec3;
  target: Vec3;
  vx: number;
  vy: number;
  vz: number;
  initialSpeed: number;
  elevationRad: number;
  flightTime: number;
  gravity: number;
  apexTime: number;
  apexY: number;
}

export interface ArtilleryShotRecord {
  id: number;
  origin: Vec3;
  target: Vec3;
  /** Flight & telegraph duration in seconds. */
  flightTime: number;
  /** Scheduled impact timestamp on simulation clock (ms). */
  impactAt: number;
  /** Launch timestamp on simulation clock (ms). */
  launchedAt: number;
  blastRadius: number;
  initialSpeed: number;
  elevationDeg: number;
  apexY: number;
}

export interface ArtilleryProjectileSnapshot {
  id: number;
  origin: Vec3;
  target: Vec3;
  pos: Vec3;
  elapsedSec: number;
  flightTime: number;
  impactAt: number;
  blastRadius: number;
  progress: number;
}

export interface ArtilleryTelegraphSnapshot {
  id: number;
  target: Vec3;
  radius: number;
  progress: number;
  remainingMs: number;
  visible: boolean;
  inScene: boolean;
  ringScale: number;
}

export interface ArtilleryImpactRecord {
  id: number;
  target: Vec3;
  impactPos: Vec3;
  impactAt: number;
  playerDist: number;
  hitPlayer: boolean;
  damage: number;
}

export interface ArtilleryHitInfo {
  id: number;
  damage: number;
  impactPos: Vec3;
  dist: number;
}

export interface ArtilleryTelemetry {
  lastShot: ArtilleryShotRecord | null;
  lastImpact: ArtilleryImpactRecord | null;
  activeProjectiles: ArtilleryProjectileSnapshot[];
  activeTelegraphs: ArtilleryTelegraphSnapshot[];
  activeImpacts: number;
  totalShotsFired: number;
  totalImpacts: number;
  totalHitsDealt: number;
  tris: number;
  maxTrisBudget: number;
  blastRadius: number;
  minTelegraphSec: number;
}

export interface ArtilleryOptions {
  blastRadius?: number;
  damage?: number;
  gravity?: number;
  onImpactHit?: (info: ArtilleryHitInfo) => void;
  onLaunch?: (shots: readonly ArtilleryShotRecord[]) => void;
  onImpact?: (record: ArtilleryImpactRecord) => void;
}

export interface FireSalvoParams {
  bossPos: Vec3;
  bossYaw: number;
  playerPos: Vec3;
  salvoCount: number;
  enraged: boolean;
  simNowMs: number;
}

// ============================================================================
// Pure Ballistic Math & Target Planning (Zero Three.js / DOM side effects)
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Verify the dodgeability inequality: warningSec * 5.2 > radius * 1.6. */
export function isTelegraphDodgeable(
  warningSec: number,
  radius: number = ARTILLERY_CONFIG.blastRadius,
): boolean {
  return (
    warningSec * ARTILLERY_CONFIG.playerBaseMaxSpeed >
    radius * ARTILLERY_CONFIG.dodgeSafetyFactor
  );
}

/** Compute parabolic flight / warning duration (s) for horizontal distance `dist`, always dodgeable. */
export function computeFlightTimeSec(
  dist: number,
  enraged: boolean,
  blastRadius: number = ARTILLERY_CONFIG.blastRadius,
): number {
  const safeDist = Number.isFinite(dist) && dist > 0 ? dist : 0;
  // Minimum time mandated by: 预警时长 × 5.2 > 标识半径 × 1.6 (plus safety floor)
  const inequalityFloor =
    (blastRadius * ARTILLERY_CONFIG.dodgeSafetyFactor) / ARTILLERY_CONFIG.playerBaseMaxSpeed + 0.25;
  const floorSec = Math.max(ARTILLERY_CONFIG.minTelegraphSec, inequalityFloor);

  const raw = enraged
    ? clamp(
        ARTILLERY_CONFIG.enragedFlightBaseSec + safeDist * ARTILLERY_CONFIG.enragedFlightPerMeter,
        ARTILLERY_CONFIG.enragedFlightBaseSec,
        ARTILLERY_CONFIG.enragedFlightMaxSec,
      )
    : clamp(
        ARTILLERY_CONFIG.phase1FlightBaseSec + safeDist * ARTILLERY_CONFIG.phase1FlightPerMeter,
        ARTILLERY_CONFIG.phase1FlightBaseSec,
        ARTILLERY_CONFIG.phase1FlightMaxSec,
      );
  return Math.max(floorSec, raw);
}

/**
 * Solve true parabolic trajectory from `origin` to `target` in `flightTime` seconds:
 *   x(t) = x0 + vx * t
 *   z(t) = z0 + vz * t
 *   y(t) = y0 + vy * t - 0.5 * g * t^2
 */
export function solveBallisticArc(
  origin: Vec3,
  target: Vec3,
  flightTime: number,
  gravity: number = ARTILLERY_CONFIG.gravity,
): BallisticSolution {
  const T = Math.max(ARTILLERY_CONFIG.minTelegraphSec, flightTime);
  const g = Math.max(1.0, gravity);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;

  const vx = dx / T;
  const vz = dz / T;
  const vy = dy / T + 0.5 * g * T;
  const vh = Math.hypot(vx, vz);
  const initialSpeed = Math.hypot(vh, vy);
  const elevationRad = Math.atan2(vy, vh);
  const apexTime = clamp(vy / g, 0, T);
  const apexY = origin.y + vy * apexTime - 0.5 * g * apexTime * apexTime;

  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    target: { x: target.x, y: target.y, z: target.z },
    vx,
    vy,
    vz,
    initialSpeed,
    elevationRad,
    flightTime: T,
    gravity: g,
    apexTime,
    apexY,
  };
}

/** Evaluate exact parabolic position at `tSec` seconds after launch. */
export function sampleBallisticPos(sol: BallisticSolution, tSec: number): Vec3 {
  const t = clamp(tSec, 0, sol.flightTime);
  return {
    x: sol.origin.x + sol.vx * t,
    y: sol.origin.y + sol.vy * t - 0.5 * sol.gravity * t * t,
    z: sol.origin.z + sol.vz * t,
  };
}

/** Evaluate instantaneous velocity tangent at `tSec` seconds after launch. */
export function sampleBallisticVel(sol: BallisticSolution, tSec: number): Vec3 {
  const t = clamp(tSec, 0, sol.flightTime);
  return {
    x: sol.vx,
    y: sol.vy - sol.gravity * t,
    z: sol.vz,
  };
}

/** Compute cannon launch origin from Boss world position, yaw, and alternating pod side (-1 / +1). */
export function computeArtilleryOrigin(bossPos: Vec3, bossYaw: number, side: -1 | 1): Vec3 {
  const fwdX = -Math.sin(bossYaw);
  const fwdZ = -Math.cos(bossYaw);
  const rightX = Math.cos(bossYaw);
  const rightZ = -Math.sin(bossYaw);
  return {
    x:
      bossPos.x +
      fwdX * ARTILLERY_CONFIG.muzzleForwardOffset +
      rightX * (side * ARTILLERY_CONFIG.muzzleSideOffset),
    y: bossPos.y + ARTILLERY_CONFIG.muzzleHeightOffset,
    z:
      bossPos.z +
      fwdZ * ARTILLERY_CONFIG.muzzleForwardOffset +
      rightZ * (side * ARTILLERY_CONFIG.muzzleSideOffset),
  };
}

const deckWorld = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY, MAP.walkablePolygon);

/** Pull a candidate landing point cleanly onto the walkable ship deck. */
function clampToDeck(x: number, z: number): { x: number; z: number } {
  const maxX = MAP.bounds.w * 0.5 - 2.6;
  const maxZ = MAP.bounds.d * 0.5 - 2.4;
  let cx = clamp(x, -maxX, maxX);
  let cz = clamp(z, -maxZ, maxZ);
  if (deckWorld.isInsideWalkable(cx, cz, 0.8)) {
    return { x: cx, z: cz };
  }
  for (let i = 1; i <= 8; i++) {
    const k = 1 - i / 9;
    const tx = cx * k;
    const tz = cz * k;
    if (deckWorld.isInsideWalkable(tx, tz, 0.8)) {
      return { x: tx, z: tz };
    }
  }
  return { x: 0, z: 0 };
}

/**
 * Plan 1..3 landing targets for a salvo:
 *   - Target 0 (primary): player's exact current ground position (guarantees standing still gets hit).
 *   - Additional targets (Phase 2 / Enraged): symmetric fan wings spaced >= 2.1*R so escape routes remain open.
 */
export function planSalvoTargets(
  bossPos: Vec3,
  playerPos: Vec3,
  salvoCount: number,
  blastRadius: number,
  fanParity: 1 | -1 = 1,
): Vec3[] {
  const count = Math.max(1, Math.min(3, Math.round(salvoCount)));
  const groundY = playerPos.y > 0.12 ? playerPos.y : 0;
  const primary: Vec3 = { x: playerPos.x, y: groundY, z: playerPos.z };
  if (count === 1) return [primary];

  const dx = playerPos.x - bossPos.x;
  const dz = playerPos.z - bossPos.z;
  const dist = Math.hypot(dx, dz);
  const dirX = dist > EPS ? dx / dist : 0;
  const dirZ = dist > EPS ? dz / dist : 1;
  const perpX = -dirZ;
  const perpZ = dirX;

  const fanRad = ARTILLERY_CONFIG.fanAngleDeg * DEG2RAD;
  const minSep = blastRadius * ARTILLERY_CONFIG.minFanSeparationMult;
  const lateralOffset = Math.max(dist * Math.sin(fanRad), minSep);
  const axialPull = dist > 4 ? Math.min(1.6, dist * (1 - Math.cos(fanRad))) : 0;

  const makeWing = (sign: -1 | 1): Vec3 => {
    const rawX = primary.x + perpX * (sign * lateralOffset) - dirX * axialPull;
    const rawZ = primary.z + perpZ * (sign * lateralOffset) - dirZ * axialPull;
    const clamped = clampToDeck(rawX, rawZ);
    return { x: clamped.x, y: 0, z: clamped.z };
  };

  if (count === 2) {
    return [primary, makeWing(fanParity)];
  }
  return [primary, makeWing(-1), makeWing(1)];
}

// ============================================================================
// Procedural Canvas2D Textures (Zero External Assets, Node-Safe Fallbacks)
// ============================================================================

interface ArtilleryAssets {
  outerRingTex: THREE.Texture;
  shrinkRingTex: THREE.Texture;
  fillDiscTex: THREE.Texture;
  wallRimTex: THREE.Texture;
  beaconTex: THREE.Texture;
  shellGlowTex: THREE.Texture;
  smokeTex: THREE.Texture;
  explosionTex: THREE.Texture;

  shellBodyGeo: THREE.BufferGeometry;
  shellNoseGeo: THREE.BufferGeometry;
  shellBandGeo: THREE.BufferGeometry;
  shellFinGeo: THREE.BufferGeometry;
  unitQuadGeo: THREE.PlaneGeometry;
  floorQuadGeo: THREE.PlaneGeometry;
  wallCylGeo: THREE.CylinderGeometry;
  beaconCrossGeo: THREE.BufferGeometry;
  fireballGeo: THREE.IcosahedronGeometry;
  shockRingGeo: THREE.RingGeometry;
}

function makeFallbackDataTex(r: number, g: number, b: number, a: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeProceduralTex(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
  fallbackRgba: [number, number, number, number],
  repeatX = false,
): THREE.Texture {
  if (typeof document === 'undefined') {
    return makeFallbackDataTex(fallbackRgba[0], fallbackRgba[1], fallbackRgba[2], fallbackRgba[3]);
  }
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeatX) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.needsUpdate = true;
  return tex;
}

function buildCrossedQuadGeo(w: number, h: number): THREE.BufferGeometry {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const positions = new Float32Array([
    // Plane 1 (XY)
    -hw, -hh, 0,  hw, -hh, 0,  hw, hh, 0,
    -hw, -hh, 0,  hw, hh, 0,  -hw, hh, 0,
    // Plane 2 (ZY)
    0, -hh, -hw,  0, -hh, hw,  0, hh, hw,
    0, -hh, -hw,  0, hh, hw,  0, hh, -hw,
  ]);
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 0,  1, 1,  0, 1,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

let sharedAssets: ArtilleryAssets | null = null;

function getSharedAssets(): ArtilleryAssets {
  if (sharedAssets) return sharedAssets;

  // 1. Outer Blast Boundary + Tactical Crosshair + High-Contrast Dark Backing Rim
  const outerRingTex = makeProceduralTex(
    256,
    (ctx, s) => {
      const cx = s * 0.5;
      const rOuter = s * 0.46;

      // Subtle red hazard tint inside blast zone
      const bg = ctx.createRadialGradient(cx, cx, rOuter * 0.15, cx, cx, rOuter);
      bg.addColorStop(0.0, 'rgba(255, 64, 24, 0.30)');
      bg.addColorStop(0.72, 'rgba(255, 36, 18, 0.22)');
      bg.addColorStop(0.95, 'rgba(255, 30, 14, 0.50)');
      bg.addColorStop(1.0, 'rgba(255, 30, 14, 0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter, 0, Math.PI * 2);
      ctx.fill();

      // Dark outer halo for contrast on sunlit deck plates
      ctx.strokeStyle = 'rgba(12, 4, 4, 0.88)';
      ctx.lineWidth = 15;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter - 5, 0, Math.PI * 2);
      ctx.stroke();

      // Vivid red-orange primary danger boundary ring
      ctx.strokeStyle = '#FF2A16';
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter - 5, 0, Math.PI * 2);
      ctx.stroke();

      // Hot amber-yellow inner accent line
      ctx.strokeStyle = '#FFCC44';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cx, rOuter - 11, 0, Math.PI * 2);
      ctx.stroke();

      // 12 radial hazard ticks around perimeter
      ctx.save();
      ctx.translate(cx, cx);
      for (let i = 0; i < 12; i++) {
        ctx.save();
        ctx.rotate((i / 12) * Math.PI * 2);
        const major = i % 3 === 0;
        ctx.fillStyle = major ? '#FFE878' : 'rgba(255, 110, 48, 0.92)';
        const len = major ? 26 : 14;
        const wid = major ? 6 : 3.5;
        ctx.fillRect(rOuter - 14 - len, -wid * 0.5, len, wid);
        ctx.restore();
      }

      // Crisp tactical crosshair axes + center bullseye
      ctx.strokeStyle = 'rgba(255, 232, 128, 0.88)';
      ctx.lineWidth = 3.5;
      for (const ang of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
        ctx.save();
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(rOuter - 46, 0);
        ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = '#FFF088';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#FF381C';
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
    [255, 42, 22, 235],
  );

  // 2. Contracting Countdown Ring (shrinks cleanly 1.0 -> 0.10 to show exact time-to-impact)
  const shrinkRingTex = makeProceduralTex(
    256,
    (ctx, s) => {
      const cx = s * 0.5;
      const r = s * 0.44;
      // Soft outer glow
      ctx.strokeStyle = 'rgba(255, 140, 24, 0.55)';
      ctx.lineWidth = 18;
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.stroke();

      // Razor-sharp bright gold-white core ring
      ctx.strokeStyle = '#FFF27A';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.stroke();

      // 4 inward-pointing lock-on chevrons
      ctx.save();
      ctx.translate(cx, cx);
      ctx.fillStyle = '#FFFFFF';
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.rotate((i * Math.PI) / 2 + Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(r - 22, 0);
        ctx.lineTo(r - 5, -9);
        ctx.lineTo(r - 5, 9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
    [255, 240, 110, 255],
  );

  // 3. Expanding Inner Danger Gauge Fill
  const fillDiscTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const cx = s * 0.5;
      const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx * 0.96);
      g.addColorStop(0.0, 'rgba(255, 110, 36, 0.72)');
      g.addColorStop(0.70, 'rgba(255, 42, 18, 0.58)');
      g.addColorStop(0.92, 'rgba(255, 210, 90, 0.90)');
      g.addColorStop(1.0, 'rgba(255, 42, 18, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cx, cx * 0.96, 0, Math.PI * 2);
      ctx.fill();
    },
    [255, 64, 24, 180],
  );

  // 4. Vertical Translucent Rim Wall (makes blast boundary obvious at grazing FPS angles!)
  const wallRimTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const grad = ctx.createLinearGradient(0, s, 0, 0);
      grad.addColorStop(0.0, 'rgba(255, 58, 22, 0.92)');
      grad.addColorStop(0.18, 'rgba(255, 130, 32, 0.65)');
      grad.addColorStop(0.55, 'rgba(255, 44, 18, 0.24)');
      grad.addColorStop(1.0, 'rgba(255, 36, 14, 0.0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);

      // Diagonal caution stripes near bottom edge
      ctx.fillStyle = 'rgba(255, 232, 110, 0.55)';
      for (let x = -s; x < s * 2; x += 28) {
        ctx.beginPath();
        ctx.moveTo(x, s);
        ctx.lineTo(x + 12, s);
        ctx.lineTo(x + 28, s * 0.62);
        ctx.lineTo(x + 16, s * 0.62);
        ctx.closePath();
        ctx.fill();
      }
    },
    [255, 72, 24, 200],
    true,
  );

  // 5. Central Vertical Lock-On Reticle Beacon
  const beaconTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const cx = s * 0.5;
      const g = ctx.createLinearGradient(0, s, 0, 0);
      g.addColorStop(0.0, 'rgba(255, 238, 136, 0.95)');
      g.addColorStop(0.28, 'rgba(255, 96, 28, 0.65)');
      g.addColorStop(0.75, 'rgba(255, 46, 18, 0.16)');
      g.addColorStop(1.0, 'rgba(255, 46, 18, 0.0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - 8, 0, 16, s);

      // Bright core filament
      const core = ctx.createLinearGradient(0, s, 0, 0);
      core.addColorStop(0.0, 'rgba(255, 255, 255, 0.98)');
      core.addColorStop(0.5, 'rgba(255, 210, 96, 0.52)');
      core.addColorStop(1.0, 'rgba(255, 160, 48, 0.0)');
      ctx.fillStyle = core;
      ctx.fillRect(cx - 2.5, 0, 5, s);
    },
    [255, 180, 72, 220],
  );

  // 6. Blazing Artillery Shell Halo Sprite
  const shellGlowTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const cx = s * 0.5;
      const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
      g.addColorStop(0.0, 'rgba(255, 255, 235, 1.0)');
      g.addColorStop(0.22, 'rgba(255, 218, 96, 0.95)');
      g.addColorStop(0.50, 'rgba(255, 92, 20, 0.68)');
      g.addColorStop(0.80, 'rgba(220, 32, 10, 0.22)');
      g.addColorStop(1.0, 'rgba(180, 20, 8, 0.0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    },
    [255, 160, 40, 255],
  );

  // 7. Parabolic Smoke Trail Puff (dark warm charcoal with soft edges so it stands out against sky!)
  const smokeTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const lobes: [number, number, number, number][] = [
        [0.50, 0.50, 0.42, 0.78],
        [0.36, 0.44, 0.30, 0.56],
        [0.64, 0.48, 0.28, 0.54],
        [0.48, 0.34, 0.27, 0.48],
        [0.54, 0.64, 0.28, 0.46],
      ];
      for (const [lx, ly, lr, a] of lobes) {
        const g = ctx.createRadialGradient(lx * s, ly * s, 0, lx * s, ly * s, lr * s);
        g.addColorStop(0.0, `rgba(62, 48, 42, ${a})`);
        g.addColorStop(0.55, `rgba(48, 40, 38, ${a * 0.55})`);
        g.addColorStop(1.0, 'rgba(36, 32, 34, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
    },
    [60, 48, 42, 190],
  );

  // 8. Impact Fireball Cloud & Blast Flash (turbulent fiery orange-gold core + dark rim, zero polygon whiteout)
  const explosionTex = makeProceduralTex(
    128,
    (ctx, s) => {
      const lobes: [number, number, number, number][] = [
        [0.50, 0.50, 0.44, 0.92],
        [0.36, 0.44, 0.30, 0.78],
        [0.64, 0.46, 0.30, 0.76],
        [0.48, 0.34, 0.28, 0.72],
        [0.54, 0.62, 0.28, 0.68],
      ];
      for (const [lx, ly, lr, a] of lobes) {
        const g = ctx.createRadialGradient(lx * s, ly * s, 0, lx * s, ly * s, lr * s);
        g.addColorStop(0.0, `rgba(255, 236, 152, ${a})`);
        g.addColorStop(0.32, `rgba(255, 138, 32, ${a * 0.94})`);
        g.addColorStop(0.68, `rgba(218, 48, 12, ${a * 0.70})`);
        g.addColorStop(0.88, `rgba(88, 22, 10, ${a * 0.34})`);
        g.addColorStop(1.0, 'rgba(42, 16, 12, 0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }
    },
    [255, 138, 32, 240],
  );

  // Shared lean geometries (strictly budgeted to stay far under 1,500 tris!)
  const shellBodyGeo = new THREE.CylinderGeometry(0.14, 0.22, 0.58, 8, 1); // 32 tris
  const shellNoseGeo = new THREE.ConeGeometry(0.14, 0.30, 8, 1);          // 16 tris
  shellNoseGeo.translate(0, 0.44, 0);
  const shellBandGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.16, 8, 1, true); // 16 tris
  const shellFinGeo = buildCrossedQuadGeo(0.52, 0.28);                    // 4 tris
  shellFinGeo.translate(0, -0.22, 0);

  const unitQuadGeo = new THREE.PlaneGeometry(1, 1);                      // 2 tris
  const floorQuadGeo = new THREE.PlaneGeometry(2, 2);                     // 2 tris (scale = radius)
  floorQuadGeo.rotateX(-Math.PI / 2);

  const wallCylGeo = new THREE.CylinderGeometry(1, 1, 0.58, 24, 1, true); // 48 tris
  wallCylGeo.translate(0, 0.29, 0);
  const beaconCrossGeo = buildCrossedQuadGeo(0.55, 2.2);                  // 4 tris
  beaconCrossGeo.translate(0, 1.1, 0);

  const fireballGeo = new THREE.IcosahedronGeometry(1, 1);                // 80 tris
  const shockRingGeo = new THREE.RingGeometry(0.76, 1.0, 20, 1);          // 40 tris
  shockRingGeo.rotateX(-Math.PI / 2);

  sharedAssets = {
    outerRingTex,
    shrinkRingTex,
    fillDiscTex,
    wallRimTex,
    beaconTex,
    shellGlowTex,
    smokeTex,
    explosionTex,
    shellBodyGeo,
    shellNoseGeo,
    shellBandGeo,
    shellFinGeo,
    unitQuadGeo,
    floorQuadGeo,
    wallCylGeo,
    beaconCrossGeo,
    fireballGeo,
    shockRingGeo,
  };
  return sharedAssets;
}

function countObjectTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry;
    if (!geo) return;
    const idx = geo.getIndex();
    if (idx) {
      total += Math.round(idx.count / 3);
    } else {
      const pos = geo.getAttribute('position');
      if (pos) total += Math.round(pos.count / 3);
    }
  });
  return total;
}

// ============================================================================
// Active Entity Structs (Projectile + Telegraph + Impact VFX + Muzzle Flash)
// ============================================================================

interface ActiveShell {
  id: number;
  isPrimary: boolean;
  sol: BallisticSolution;
  blastRadius: number;
  damage: number;
  launchedAtMs: number;
  impactAtMs: number;
  elapsedSec: number;
  pos: Vec3;

  // 3D shell assembly
  shellGroup: THREE.Group;
  haloMesh: THREE.Mesh;
  haloMat: THREE.MeshBasicMaterial;

  // Dynamic parabolic ribbon trail (16 segments = 32 tris)
  trailMesh: THREE.Mesh;
  trailGeo: THREE.BufferGeometry;
  trailMat: THREE.MeshBasicMaterial;

  // Parabolic smoke puffs along recent arc
  smokeMeshes: THREE.Mesh[];
  smokeMats: THREE.MeshBasicMaterial[];

  // Ground landing telegraph assembly
  telegraphGroup: THREE.Group;
  outerMat: THREE.MeshBasicMaterial;
  shrinkRingMesh: THREE.Mesh;
  shrinkMat: THREE.MeshBasicMaterial;
  fillDiscMesh: THREE.Mesh;
  fillMat: THREE.MeshBasicMaterial;
  wallMesh: THREE.Mesh;
  wallMat: THREE.MeshBasicMaterial;
  beaconMesh: THREE.Mesh;
  beaconMat: THREE.MeshBasicMaterial;
  ringScale: number;
}

interface ActiveImpact {
  group: THREE.Group;
  elapsedSec: number;
  durationSec: number;
  blastRadius: number;
  fireballMesh: THREE.Mesh;
  fireballMat: THREE.MeshBasicMaterial;
  shockMesh: THREE.Mesh;
  shockMat: THREE.MeshBasicMaterial;
  flashMesh: THREE.Mesh;
  flashMat: THREE.MeshBasicMaterial;
  plumeMeshes: THREE.Mesh[];
  plumeMats: THREE.MeshBasicMaterial[];
  plumeDirs: Vec3[];
}

interface ActiveMuzzleFlash {
  group: THREE.Group;
  elapsedSec: number;
  durationSec: number;
  starMesh: THREE.Mesh;
  starMat: THREE.MeshBasicMaterial;
  puffMeshes: THREE.Mesh[];
  puffMats: THREE.MeshBasicMaterial[];
  puffDirs: Vec3[];
}

const UP_VEC = new THREE.Vector3(0, 1, 0);
const tmpVel = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpCamPos = new THREE.Vector3(0, 8, 20);
const tmpPt = new THREE.Vector3();
const tmpNext = new THREE.Vector3();
const tmpTan = new THREE.Vector3();
const tmpView = new THREE.Vector3();
const tmpSide = new THREE.Vector3();

/** Build a pre-allocated non-indexed strip geometry for the parabolic contrail ribbon. */
function createTrailGeometry(): THREE.BufferGeometry {
  const vertCount = (TRAIL_SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices = new Uint16Array(TRAIL_SEGMENTS * 6);
  for (let i = 0; i < TRAIL_SEGMENTS; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    const k = i * 6;
    indices[k] = a;
    indices[k + 1] = b;
    indices[k + 2] = c;
    indices[k + 3] = b;
    indices[k + 4] = d;
    indices[k + 5] = c;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ============================================================================
// ArtillerySystem Controller
// ============================================================================

export class ArtillerySystem {
  readonly root: THREE.Group;
  readonly blastRadius: number;
  readonly damage: number;
  readonly gravity: number;

  private readonly scene: THREE.Scene;
  private readonly opts: ArtilleryOptions;
  private readonly assets: ArtilleryAssets;
  private readonly shells: ActiveShell[] = [];
  private readonly impacts: ActiveImpact[] = [];
  private readonly muzzles: ActiveMuzzleFlash[] = [];
  private readonly sharedShellBodyMat: THREE.MeshBasicMaterial;
  private readonly sharedShellGlowBandMat: THREE.MeshBasicMaterial;
  private readonly sharedShellFinMat: THREE.MeshBasicMaterial;

  private nextShotId = 1;
  private podParity: -1 | 1 = 1;
  private fanParity: -1 | 1 = 1;
  private disposed = false;

  private _totalShotsFired = 0;
  private _totalImpacts = 0;
  private _totalHitsDealt = 0;
  private _lastShot: ArtilleryShotRecord | null = null;
  private _lastImpact: ArtilleryImpactRecord | null = null;

  /** Persistent telemetry object mirrored onto window.__artillery (zero per-frame alloc). */
  readonly telemetry: ArtilleryTelemetry;

  constructor(scene: THREE.Scene, opts: ArtilleryOptions = {}) {
    this.scene = scene;
    this.opts = opts;
    this.assets = getSharedAssets();
    this.blastRadius =
      opts.blastRadius !== undefined && Number.isFinite(opts.blastRadius) && opts.blastRadius > 0
        ? opts.blastRadius
        : ARTILLERY_CONFIG.blastRadius;
    this.damage =
      opts.damage !== undefined && Number.isFinite(opts.damage) && opts.damage >= 0
        ? opts.damage
        : ARTILLERY_CONFIG.damage;
    this.gravity =
      opts.gravity !== undefined && Number.isFinite(opts.gravity) && opts.gravity > 0
        ? opts.gravity
        : ARTILLERY_CONFIG.gravity;

    this.root = new THREE.Group();
    this.root.name = 'boss-artillery-root';
    this.scene.add(this.root);

    this.sharedShellBodyMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#4B3328'),
      toneMapped: false,
    });
    this.sharedShellGlowBandMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#FFB238'),
      toneMapped: false,
    });
    this.sharedShellFinMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#FF4B1A'),
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.telemetry = {
      lastShot: null,
      lastImpact: null,
      activeProjectiles: [],
      activeTelegraphs: [],
      activeImpacts: 0,
      totalShotsFired: 0,
      totalImpacts: 0,
      totalHitsDealt: 0,
      tris: 0,
      maxTrisBudget: ARTILLERY_CONFIG.maxTriangleBudget,
      blastRadius: this.blastRadius,
      minTelegraphSec: ARTILLERY_CONFIG.minTelegraphSec,
    };
  }

  get totalShotsFired(): number {
    return this._totalShotsFired;
  }

  get totalImpacts(): number {
    return this._totalImpacts;
  }

  get totalHitsDealt(): number {
    return this._totalHitsDealt;
  }

  get lastShot(): ArtilleryShotRecord | null {
    return this._lastShot;
  }

  get lastImpact(): ArtilleryImpactRecord | null {
    return this._lastImpact;
  }

  get activeProjectileCount(): number {
    return this.shells.length;
  }

  get triangleCount(): number {
    return countObjectTriangles(this.root);
  }

  /** Launch a 1..3 shell parabolic artillery salvo with instant ground telegraphs. */
  fireSalvo(params: FireSalvoParams): ArtilleryShotRecord[] {
    if (this.disposed) return [];
    const targets = planSalvoTargets(
      params.bossPos,
      params.playerPos,
      params.salvoCount,
      this.blastRadius,
      this.fanParity,
    );
    this.fanParity = this.fanParity === 1 ? -1 : 1;

    const spawned: ArtilleryShotRecord[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const side: -1 | 1 = i === 0 ? this.podParity : i === 1 ? -1 : 1;
      if (i === 0) this.podParity = this.podParity === 1 ? -1 : 1;

      const origin = computeArtilleryOrigin(params.bossPos, params.bossYaw, side);
      const horizDist = Math.hypot(target.x - origin.x, target.z - origin.z);
      const flightTime = computeFlightTimeSec(horizDist, params.enraged, this.blastRadius);
      const sol = solveBallisticArc(origin, target, flightTime, this.gravity);
      const id = this.nextShotId++;
      const impactAt = params.simNowMs + flightTime * 1000;

      const shell = this.createActiveShell(
        id,
        i === 0,
        sol,
        this.blastRadius,
        this.damage,
        params.simNowMs,
        impactAt,
      );
      this.shells.push(shell);
      this._totalShotsFired++;

      const record: ArtilleryShotRecord = {
        id,
        origin: { ...sol.origin },
        target: { ...sol.target },
        flightTime: Number(sol.flightTime.toFixed(4)),
        impactAt: Number(impactAt.toFixed(1)),
        launchedAt: Number(params.simNowMs.toFixed(1)),
        blastRadius: this.blastRadius,
        initialSpeed: Number(sol.initialSpeed.toFixed(3)),
        elevationDeg: Number(((sol.elevationRad * 180) / Math.PI).toFixed(2)),
        apexY: Number(sol.apexY.toFixed(3)),
      };
      spawned.push(record);
      if (i === 0) {
        this._lastShot = record;
      }

      if (i === 0 || i === 1) {
        this.spawnMuzzleFlash(origin);
      }
    }

    this.syncTelemetry();
    this.opts.onLaunch?.(spawned);
    return spawned;
  }

  /** Advance all flying shells, parabolic trails, ground telegraphs, and explosion VFX. */
  update(dtSec: number, playerPos: Vec3, simNowMs: number, cameraPos?: Vec3): void {
    if (this.disposed) return;
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;

    if (cameraPos) {
      tmpCamPos.set(cameraPos.x, cameraPos.y, cameraPos.z);
    } else {
      tmpCamPos.set(playerPos.x, playerPos.y + 1.7, playerPos.z);
    }

    // 1. Update airborne shells & ground telegraphs
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.elapsedSec += dt;

      if (s.elapsedSec >= s.sol.flightTime) {
        // Exact impact at target
        const impactPos = sampleBallisticPos(s.sol, s.sol.flightTime);
        this.resolveImpact(s, impactPos, playerPos, simNowMs);
        this.destroyShell(s);
        this.shells.splice(i, 1);
        continue;
      }

      const pos = sampleBallisticPos(s.sol, s.elapsedSec);
      const vel = sampleBallisticVel(s.sol, s.elapsedSec);
      s.pos.x = pos.x;
      s.pos.y = pos.y;
      s.pos.z = pos.z;

      // Orient mortar shell along velocity tangent
      s.shellGroup.position.set(pos.x, pos.y, pos.z);
      tmpVel.set(vel.x, vel.y, vel.z);
      if (tmpVel.lengthSq() > EPS) {
        tmpVel.normalize();
        tmpQuat.setFromUnitVectors(UP_VEC, tmpVel);
        s.shellGroup.quaternion.copy(tmpQuat);
      }
      s.haloMesh.lookAt(tmpCamPos);
      const pulse = 0.92 + 0.16 * Math.sin(s.elapsedSec * 28);
      s.haloMesh.scale.set(1.25 * pulse, 1.25 * pulse, 1);

      // Update curved parabolic ribbon + smoke puffs behind shell
      this.updateTrailRibbon(s);
      this.updateSmokePuffs(s);

      // Update landing ground telegraph countdown & contracting ring animation
      const progress = clamp(s.elapsedSec / s.sol.flightTime, 0, 1);
      this.updateTelegraphVisual(s, progress);
    }

    // 2. Update explosion fireballs & shockwaves
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const imp = this.impacts[i];
      imp.elapsedSec += dt;
      if (imp.elapsedSec >= imp.durationSec) {
        this.destroyImpact(imp);
        this.impacts.splice(i, 1);
        continue;
      }
      this.updateImpactVisual(imp);
    }

    // 3. Update cannon muzzle flashes
    for (let i = this.muzzles.length - 1; i >= 0; i--) {
      const m = this.muzzles[i];
      m.elapsedSec += dt;
      if (m.elapsedSec >= m.durationSec) {
        this.destroyMuzzleFlash(m);
        this.muzzles.splice(i, 1);
        continue;
      }
      this.updateMuzzleVisual(m);
    }

    this.syncTelemetry();
  }

  /** Clear all in-flight projectiles, ground telegraphs, and VFX (e.g. on round reset). */
  clear(): void {
    for (const s of this.shells) this.destroyShell(s);
    this.shells.length = 0;
    for (const imp of this.impacts) this.destroyImpact(imp);
    this.impacts.length = 0;
    for (const m of this.muzzles) this.destroyMuzzleFlash(m);
    this.muzzles.length = 0;

    this._totalShotsFired = 0;
    this._totalImpacts = 0;
    this._totalHitsDealt = 0;
    this._lastShot = null;
    this._lastImpact = null;
    this.podParity = 1;
    this.fanParity = 1;
    this.syncTelemetry();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.scene.remove(this.root);
    this.sharedShellBodyMat.dispose();
    this.sharedShellGlowBandMat.dispose();
    this.sharedShellFinMat.dispose();
  }

  // ============================================================================
  // Internal Builders & Per-Frame Updaters
  // ============================================================================

  private createActiveShell(
    id: number,
    isPrimary: boolean,
    sol: BallisticSolution,
    blastRadius: number,
    damage: number,
    launchedAtMs: number,
    impactAtMs: number,
  ): ActiveShell {
    const a = this.assets;

    // 1. Shell 3D entity (named artillery-projectile-* so __sceneStats detects it)
    const shellGroup = new THREE.Group();
    shellGroup.name = `artillery-projectile-${id}`;
    shellGroup.position.set(sol.origin.x, sol.origin.y, sol.origin.z);

    const bodyMesh = new THREE.Mesh(a.shellBodyGeo, this.sharedShellBodyMat);
    bodyMesh.name = `artillery-projectile-body-${id}`;
    const noseMesh = new THREE.Mesh(a.shellNoseGeo, this.sharedShellBodyMat);
    const bandMesh = new THREE.Mesh(a.shellBandGeo, this.sharedShellGlowBandMat);
    const finMesh = new THREE.Mesh(a.shellFinGeo, this.sharedShellFinMat);

    const haloMat = new THREE.MeshBasicMaterial({
      map: a.shellGlowTex,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const haloMesh = new THREE.Mesh(a.unitQuadGeo, haloMat);
    haloMesh.scale.set(1.25, 1.25, 1);
    haloMesh.renderOrder = 14;

    shellGroup.add(bodyMesh, noseMesh, bandMesh, finMesh, haloMesh);
    this.root.add(shellGroup);

    // 2. Curved parabolic contrail ribbon (world-space BufferGeometry)
    const trailGeo = createTrailGeometry();
    const trailMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.name = `artillery-trail-${id}`;
    trailMesh.frustumCulled = false;
    trailMesh.renderOrder = 12;
    this.root.add(trailMesh);

    // 3. Parabolic smoke trail puffs behind warhead
    const smokeMeshes: THREE.Mesh[] = [];
    const smokeMats: THREE.MeshBasicMaterial[] = [];
    for (let k = 0; k < SMOKE_PUFFS_PER_SHELL; k++) {
      const mat = new THREE.MeshBasicMaterial({
        map: a.smokeTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const m = new THREE.Mesh(a.unitQuadGeo, mat);
      m.position.set(sol.origin.x, sol.origin.y, sol.origin.z);
      m.renderOrder = 11;
      m.visible = false;
      this.root.add(m);
      smokeMeshes.push(m);
      smokeMats.push(mat);
    }

    // 4. High-Contrast Ground Landing Telegraph (immediately visible on launch frame!)
    const telegraphGroup = new THREE.Group();
    telegraphGroup.name = `artillery-telegraph-${id}`;
    telegraphGroup.position.set(sol.target.x, sol.target.y, sol.target.z);
    telegraphGroup.visible = true;

    const outerMat = new THREE.MeshBasicMaterial({
      map: a.outerRingTex,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      toneMapped: false,
    });
    const outerMesh = new THREE.Mesh(a.floorQuadGeo, outerMat);
    outerMesh.name = `artillery-telegraph-outer-${id}`;
    outerMesh.position.y = 0.045;
    outerMesh.scale.set(blastRadius, 1, blastRadius);
    outerMesh.renderOrder = 8;

    const fillMat = new THREE.MeshBasicMaterial({
      map: a.fillDiscTex,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      toneMapped: false,
    });
    const fillDiscMesh = new THREE.Mesh(a.floorQuadGeo, fillMat);
    fillDiscMesh.position.y = 0.052;
    fillDiscMesh.scale.set(blastRadius * 0.1, 1, blastRadius * 0.1);
    fillDiscMesh.renderOrder = 9;

    const shrinkMat = new THREE.MeshBasicMaterial({
      map: a.shrinkRingTex,
      color: new THREE.Color('#FFF066'),
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      toneMapped: false,
    });
    const shrinkRingMesh = new THREE.Mesh(a.floorQuadGeo, shrinkMat);
    shrinkRingMesh.name = `artillery-telegraph-countdown-${id}`;
    shrinkRingMesh.position.y = 0.062;
    shrinkRingMesh.scale.set(blastRadius, 1, blastRadius);
    shrinkRingMesh.renderOrder = 10;

    const wallMat = new THREE.MeshBasicMaterial({
      map: a.wallRimTex,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const wallMesh = new THREE.Mesh(a.wallCylGeo, wallMat);
    wallMesh.name = `artillery-telegraph-rim-${id}`;
    wallMesh.scale.set(blastRadius, 1, blastRadius);
    wallMesh.renderOrder = 10;

    const beaconMat = new THREE.MeshBasicMaterial({
      map: a.beaconTex,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const beaconMesh = new THREE.Mesh(a.beaconCrossGeo, beaconMat);
    beaconMesh.position.y = 0.04;
    beaconMesh.renderOrder = 11;

    telegraphGroup.add(outerMesh, fillDiscMesh, shrinkRingMesh, wallMesh, beaconMesh);
    this.root.add(telegraphGroup);

    const active: ActiveShell = {
      id,
      isPrimary,
      sol,
      blastRadius,
      damage,
      launchedAtMs,
      impactAtMs,
      elapsedSec: 0,
      pos: { ...sol.origin },
      shellGroup,
      haloMesh,
      haloMat,
      trailMesh,
      trailGeo,
      trailMat,
      smokeMeshes,
      smokeMats,
      telegraphGroup,
      outerMat,
      shrinkRingMesh,
      shrinkMat,
      fillDiscMesh,
      fillMat,
      wallMesh,
      wallMat,
      beaconMesh,
      beaconMat,
      ringScale: 1.0,
    };

    // Orient shell immediately along initial launch elevation vector
    const initVel = sampleBallisticVel(sol, 0);
    tmpVel.set(initVel.x, initVel.y, initVel.z);
    if (tmpVel.lengthSq() > EPS) {
      tmpVel.normalize();
      tmpQuat.setFromUnitVectors(UP_VEC, tmpVel);
      shellGroup.quaternion.copy(tmpQuat);
    }
    this.updateTrailRibbon(active);
    return active;
  }

  private updateTrailRibbon(s: ActiveShell): void {
    const posAttr = s.trailGeo.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = s.trailGeo.getAttribute('color') as THREE.BufferAttribute;
    const pArr = posAttr.array as Float32Array;
    const cArr = colAttr.array as Float32Array;

    const tEnd = s.elapsedSec;
    const tStart = Math.max(0, tEnd - ARTILLERY_CONFIG.trailHistorySec);
    const span = tEnd - tStart;

    for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
      const u = i / TRAIL_SEGMENTS; // 0 = oldest tail, 1 = shell head
      const t = tStart + span * u;
      const p = sampleBallisticPos(s.sol, t);
      const tNext = Math.min(s.sol.flightTime, t + 0.025);
      const pn = sampleBallisticPos(s.sol, tNext);

      tmpPt.set(p.x, p.y, p.z);
      tmpNext.set(pn.x, pn.y, pn.z);
      tmpTan.subVectors(tmpNext, tmpPt);
      if (tmpTan.lengthSq() <= EPS) {
        const v = sampleBallisticVel(s.sol, t);
        tmpTan.set(v.x, v.y, v.z);
      }
      tmpTan.normalize();
      tmpView.subVectors(tmpCamPos, tmpPt).normalize();
      tmpSide.crossVectors(tmpTan, tmpView);
      if (tmpSide.lengthSq() <= EPS) {
        tmpSide.set(1, 0, 0);
      } else {
        tmpSide.normalize();
      }

      // Taper ribbon cleanly from thin glowing tail -> wide fiery plume directly behind warhead
      const halfWidth = span < 0.01 ? 0.01 : 0.04 + 0.24 * Math.pow(u, 1.35);
      const vi = i * 2;
      const pIdx = vi * 3;
      pArr[pIdx] = p.x - tmpSide.x * halfWidth;
      pArr[pIdx + 1] = p.y - tmpSide.y * halfWidth;
      pArr[pIdx + 2] = p.z - tmpSide.z * halfWidth;
      pArr[pIdx + 3] = p.x + tmpSide.x * halfWidth;
      pArr[pIdx + 4] = p.y + tmpSide.y * halfWidth;
      pArr[pIdx + 5] = p.z + tmpSide.z * halfWidth;

      // Color gradient along parabola: fading dark-ember tail -> blazing hot orange -> white-gold head
      const fade = Math.pow(u, 1.2);
      const r = fade * 1.0;
      const g = fade * (0.24 + 0.72 * u * u);
      const b = fade * (0.04 + 0.56 * Math.pow(u, 3));
      cArr[pIdx] = r;
      cArr[pIdx + 1] = g;
      cArr[pIdx + 2] = b;
      cArr[pIdx + 3] = r;
      cArr[pIdx + 4] = g;
      cArr[pIdx + 5] = b;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  private updateSmokePuffs(s: ActiveShell): void {
    for (let k = 0; k < SMOKE_PUFFS_PER_SHELL; k++) {
      const lag = (k + 1) * 0.125;
      const sampleT = s.elapsedSec - lag;
      const mesh = s.smokeMeshes[k];
      const mat = s.smokeMats[k];
      if (sampleT < 0) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const p = sampleBallisticPos(s.sol, sampleT);
      const ageFrac = clamp(lag / (SMOKE_PUFFS_PER_SHELL * 0.125), 0, 1);
      // Slight upward smoke billow so the dark plume lifts off the parabolic arc naturally
      mesh.position.set(p.x, p.y + ageFrac * 0.42, p.z);
      mesh.lookAt(tmpCamPos);
      const size = 0.42 + ageFrac * 0.92;
      mesh.scale.set(size, size, 1);
      mat.opacity = (1 - ageFrac * 0.82) * 0.74;
    }
  }

  private updateTelegraphVisual(s: ActiveShell, progress: number): void {
    // Smoothly shrink countdown ring from 1.0 -> 0.08 as impact approaches
    const ringScale = 1.0 - progress * 0.92;
    s.ringScale = ringScale;
    s.shrinkRingMesh.scale.set(s.blastRadius * ringScale, 1, s.blastRadius * ringScale);
    s.shrinkRingMesh.rotation.y = progress * Math.PI * 1.5;

    // Ramp urgency color & pulse frequency right before impact
    const urgent = clamp((progress - 0.65) / 0.35, 0, 1);
    const pulseFreq = 6 + urgent * 14;
    const pulse = 0.5 + 0.5 * Math.sin(s.elapsedSec * pulseFreq * Math.PI * 2);

    // Contracting ring: bright amber-gold -> blazing white-orange in final moment
    s.shrinkMat.color.setRGB(
      1.0,
      0.92 - progress * 0.42 + urgent * 0.35 * pulse,
      0.32 - progress * 0.22 + urgent * 0.55 * pulse,
    );
    s.shrinkMat.opacity = 0.92 + 0.08 * pulse;

    // Expanding danger fill grows smoothly from center -> outer blast boundary
    const fillFrac = 0.08 + progress * 0.90;
    s.fillDiscMesh.scale.set(s.blastRadius * fillFrac, 1, s.blastRadius * fillFrac);
    s.fillMat.opacity = 0.20 + progress * 0.42 + urgent * 0.14 * pulse;

    // Outer boundary ring & vertical holographic fence pulse with urgency
    s.outerMat.opacity = 0.88 + 0.12 * pulse;
    s.wallMat.opacity = 0.58 + progress * 0.34 + urgent * 0.08 * pulse;
    s.wallMesh.scale.set(s.blastRadius, 0.95 + progress * 0.45, s.blastRadius);

    // Central lock-on beam tightens & brightens as shell dives in
    const beamW = 1.1 - progress * 0.45;
    s.beaconMesh.scale.set(beamW, 0.85 + progress * 0.40, beamW);
    s.beaconMat.opacity = 0.55 + progress * 0.40;
  }

  private resolveImpact(
    s: ActiveShell,
    impactPos: Vec3,
    playerPos: Vec3,
    simNowMs: number,
  ): void {
    this._totalImpacts++;
    const horizDist = Math.hypot(playerPos.x - impactPos.x, playerPos.z - impactPos.z);
    const vertDist = Math.abs(playerPos.y - impactPos.y);
    const hitPlayer =
      horizDist <= s.blastRadius && vertDist <= ARTILLERY_CONFIG.blastVerticalTolerance;
    const dealtDamage = hitPlayer ? s.damage : 0;

    const record: ArtilleryImpactRecord = {
      id: s.id,
      target: { ...s.sol.target },
      impactPos: { ...impactPos },
      impactAt: Number(simNowMs.toFixed(1)),
      playerDist: Number(horizDist.toFixed(3)),
      hitPlayer,
      damage: dealtDamage,
    };
    this._lastImpact = record;

    this.spawnImpactVfx(impactPos, s.blastRadius);

    if (hitPlayer && dealtDamage > 0) {
      this._totalHitsDealt++;
      this.opts.onImpactHit?.({
        id: s.id,
        damage: dealtDamage,
        impactPos: { ...impactPos },
        dist: horizDist,
      });
    }
    this.opts.onImpact?.(record);
  }

  private spawnImpactVfx(pos: Vec3, blastRadius: number): void {
    const a = this.assets;
    const group = new THREE.Group();
    group.name = `artillery-impact-${this._totalImpacts}`;
    group.position.set(pos.x, pos.y, pos.z);

    // 1. Compact inner fiery molten core (80 tris — NormalBlending so it never blows out to flat white polygon)
    const fireballMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#FF8C24'),
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      toneMapped: false,
    });
    const fireballMesh = new THREE.Mesh(a.fireballGeo, fireballMat);
    fireballMesh.position.y = 0.52;
    fireballMesh.scale.setScalar(0.35);
    fireballMesh.renderOrder = 14;

    // 2. High-contrast fiery ground shockwave ring (40 tris)
    const shockMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#FF5A16'),
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const shockMesh = new THREE.Mesh(a.shockRingGeo, shockMat);
    shockMesh.name = `artillery-shockwave-${this._totalImpacts}`;
    shockMesh.position.y = 0.09;
    shockMesh.scale.set(0.45, 1, 0.45);
    shockMesh.renderOrder = 13;

    // 3. Fiery ground blast scorch/flash disc (2 tris)
    const flashMat = new THREE.MeshBasicMaterial({
      map: a.explosionTex,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const flashMesh = new THREE.Mesh(a.floorQuadGeo, flashMat);
    flashMesh.position.y = 0.07;
    flashMesh.scale.set(blastRadius * 0.92, 1, blastRadius * 0.92);
    flashMesh.renderOrder = 12;

    // 4. Layered soft-edged explosion fireballs & rising dark blast smoke plumes (6 × 2 = 12 tris)
    const plumeMeshes: THREE.Mesh[] = [];
    const plumeMats: THREE.MeshBasicMaterial[] = [];
    const plumeDirs: Vec3[] = [];
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2 + 0.4;
      const isFire = k < 3;
      const mat = new THREE.MeshBasicMaterial({
        map: isFire ? a.explosionTex : a.smokeTex,
        transparent: true,
        opacity: isFire ? 0.92 : 0.80,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const m = new THREE.Mesh(a.unitQuadGeo, mat);
      const radial = k === 0 ? 0.0 : isFire ? 0.45 : 0.72;
      m.position.set(Math.cos(ang) * radial, 0.65 + k * 0.16, Math.sin(ang) * radial);
      m.scale.setScalar(isFire ? 1.55 : 1.35);
      m.renderOrder = isFire ? 15 : 14;
      group.add(m);
      plumeMeshes.push(m);
      plumeMats.push(mat);
      plumeDirs.push({
        x: Math.cos(ang) * (k === 0 ? 0.15 : isFire ? 1.05 : 1.85),
        y: (isFire ? 2.1 : 3.2) + (k % 3) * 0.45,
        z: Math.sin(ang) * (k === 0 ? 0.15 : isFire ? 1.05 : 1.85),
      });
    }

    group.add(fireballMesh, shockMesh, flashMesh);
    this.root.add(group);

    this.impacts.push({
      group,
      elapsedSec: 0,
      durationSec: ARTILLERY_CONFIG.impactVfxDurationSec,
      blastRadius,
      fireballMesh,
      fireballMat,
      shockMesh,
      shockMat,
      flashMesh,
      flashMat,
      plumeMeshes,
      plumeMats,
      plumeDirs,
    });
  }

  private updateImpactVisual(imp: ActiveImpact): void {
    const u = clamp(imp.elapsedSec / imp.durationSec, 0, 1);
    const easeOut = 1 - Math.pow(1 - u, 3);

    // Compact inner fiery molten core blooms briefly then cools orange -> crimson -> out
    const fbScale = 0.32 + easeOut * (imp.blastRadius * 0.32);
    imp.fireballMesh.scale.set(fbScale, fbScale * 0.85, fbScale);
    imp.fireballMesh.position.y = 0.48 + easeOut * 0.85;
    imp.fireballMat.color.setRGB(
      1.0,
      clamp(0.68 - u * 0.75, 0.14, 0.80),
      clamp(0.24 - u * 0.55, 0.03, 0.30),
    );
    imp.fireballMat.opacity = Math.max(0, 1 - u * 1.8) * 0.78;

    // Ground shockwave ring rockets out past blastRadius with vivid orange-gold rim
    const shockR = 0.50 + easeOut * (imp.blastRadius * 1.15);
    imp.shockMesh.scale.set(shockR, 1, shockR);
    imp.shockMat.color.setRGB(1.0, clamp(0.62 - u * 0.42, 0.18, 0.75), clamp(0.18 - u * 0.16, 0.04, 0.25));
    imp.shockMat.opacity = Math.max(0, 1 - u * 1.05) * 0.94;

    // Ground fiery blast flash burns brightly in first 45% then fades
    const flashFade = clamp(1 - u / 0.52, 0, 1);
    imp.flashMat.opacity = flashFade * 0.86;

    // Layered soft fireball clouds (0..2) + billowing dark blast smoke (3..5)
    for (let k = 0; k < imp.plumeMeshes.length; k++) {
      const m = imp.plumeMeshes[k];
      const mat = imp.plumeMats[k];
      const d = imp.plumeDirs[k];
      const isFire = k < 3;
      m.position.set(d.x * easeOut, (isFire ? 0.65 : 0.45) + d.y * easeOut, d.z * easeOut);
      m.lookAt(tmpCamPos);
      const sz = isFire ? 1.7 + easeOut * 2.1 : 1.45 + easeOut * 2.4;
      m.scale.set(sz, sz, 1);
      mat.opacity = isFire
        ? Math.max(0, 1 - Math.pow(u, 1.15)) * 0.92
        : Math.max(0, 1 - u * u) * 0.78;
    }
  }

  private spawnMuzzleFlash(origin: Vec3): void {
    const a = this.assets;
    const group = new THREE.Group();
    group.name = 'artillery-muzzle-flash';
    group.position.set(origin.x, origin.y, origin.z);

    const starMat = new THREE.MeshBasicMaterial({
      map: a.explosionTex,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const starMesh = new THREE.Mesh(a.unitQuadGeo, starMat);
    starMesh.scale.set(1.6, 1.6, 1);
    starMesh.renderOrder = 15;
    group.add(starMesh);

    const puffMeshes: THREE.Mesh[] = [];
    const puffMats: THREE.MeshBasicMaterial[] = [];
    const puffDirs: Vec3[] = [];
    for (let k = 0; k < 3; k++) {
      const ang = (k / 3) * Math.PI * 2;
      const mat = new THREE.MeshBasicMaterial({
        map: a.smokeTex,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const m = new THREE.Mesh(a.unitQuadGeo, mat);
      m.scale.set(0.7, 0.7, 1);
      m.renderOrder = 14;
      group.add(m);
      puffMeshes.push(m);
      puffMats.push(mat);
      puffDirs.push({ x: Math.cos(ang) * 0.7, y: 1.2 + k * 0.25, z: Math.sin(ang) * 0.7 });
    }

    this.root.add(group);
    this.muzzles.push({
      group,
      elapsedSec: 0,
      durationSec: ARTILLERY_CONFIG.muzzleVfxDurationSec,
      starMesh,
      starMat,
      puffMeshes,
      puffMats,
      puffDirs,
    });
  }

  private updateMuzzleVisual(m: ActiveMuzzleFlash): void {
    const u = clamp(m.elapsedSec / m.durationSec, 0, 1);
    m.starMesh.lookAt(tmpCamPos);
    const s = 1.5 + u * 1.1;
    m.starMesh.scale.set(s, s, 1);
    m.starMat.opacity = Math.max(0, 1 - u * 1.25);

    for (let k = 0; k < m.puffMeshes.length; k++) {
      const pm = m.puffMeshes[k];
      const pd = m.puffDirs[k];
      pm.position.set(pd.x * u, pd.y * u, pd.z * u);
      pm.lookAt(tmpCamPos);
      const sz = 0.7 + u * 1.1;
      pm.scale.set(sz, sz, 1);
      m.puffMats[k].opacity = Math.max(0, (1 - u) * 0.75);
    }
  }

  private destroyShell(s: ActiveShell): void {
    this.root.remove(s.shellGroup);
    s.haloMat.dispose();
    this.root.remove(s.trailMesh);
    s.trailGeo.dispose();
    s.trailMat.dispose();
    for (let i = 0; i < s.smokeMeshes.length; i++) {
      this.root.remove(s.smokeMeshes[i]);
      s.smokeMats[i].dispose();
    }
    this.root.remove(s.telegraphGroup);
    s.outerMat.dispose();
    s.shrinkMat.dispose();
    s.fillMat.dispose();
    s.wallMat.dispose();
    s.beaconMat.dispose();
  }

  private destroyImpact(imp: ActiveImpact): void {
    this.root.remove(imp.group);
    imp.fireballMat.dispose();
    imp.shockMat.dispose();
    imp.flashMat.dispose();
    for (const m of imp.plumeMats) m.dispose();
  }

  private destroyMuzzleFlash(m: ActiveMuzzleFlash): void {
    this.root.remove(m.group);
    m.starMat.dispose();
    for (const pm of m.puffMats) pm.dispose();
  }

  private syncTelemetry(): void {
    const t = this.telemetry;
    t.lastShot = this._lastShot;
    t.lastImpact = this._lastImpact;
    t.totalShotsFired = this._totalShotsFired;
    t.totalImpacts = this._totalImpacts;
    t.totalHitsDealt = this._totalHitsDealt;
    t.activeImpacts = this.impacts.length;
    t.tris = countObjectTriangles(this.root);

    t.activeProjectiles.length = 0;
    t.activeTelegraphs.length = 0;
    for (const s of this.shells) {
      const progress = clamp(s.elapsedSec / s.sol.flightTime, 0, 1);
      const remainingMs = Math.max(0, (s.sol.flightTime - s.elapsedSec) * 1000);
      t.activeProjectiles.push({
        id: s.id,
        origin: { ...s.sol.origin },
        target: { ...s.sol.target },
        pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
        elapsedSec: Number(s.elapsedSec.toFixed(4)),
        flightTime: Number(s.sol.flightTime.toFixed(4)),
        impactAt: Number(s.impactAtMs.toFixed(1)),
        blastRadius: s.blastRadius,
        progress: Number(progress.toFixed(4)),
      });
      t.activeTelegraphs.push({
        id: s.id,
        target: { ...s.sol.target },
        radius: s.blastRadius,
        progress: Number(progress.toFixed(4)),
        remainingMs: Number(remainingMs.toFixed(1)),
        visible: s.telegraphGroup.visible,
        inScene: s.telegraphGroup.parent === this.root,
        ringScale: Number(s.ringScale.toFixed(4)),
      });
    }
  }
}
