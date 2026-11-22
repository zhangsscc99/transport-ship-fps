// Procedural Heavy Armored Mech Colossus Boss Model (重装机械巨人 — zero external assets).
//
// Design Language (4.1m Hard-Surface Industrial Siege Mech):
//   1. Sculpted 3-value industrial military palette calibrated for dark industrial scenes & IBL:
//      deep obsidian-gunmetal primary chassis, cold titanium upper-armor highlight planes
//      (chest brow, pauldron caps, knee prows, helmet crest), selective matte crimson-oxide
//      command armor trim, and weathered ochre-amber hazard stripes for giant-scale cues.
//   2. Heroic colossal proportions: broad V-tapered fortress chest (1.52m) narrowing to an
//      armored piston-braced waist (0.76m), tight armored mono-eye head framed by high
//      collar cowling so the 4.1m stature reads immediately, asymmetric fortress buckler
//      left shoulder vs swept blade-servo right shoulder, and flared armored siege greaves.
//   3. Authentic exposed mechanical engineering: smooth brushed rolled-steel plates (zero
//      noisy tiling), gleaming chrome & machined-brass hydraulic pistons across waist, neck,
//      shoulders, arms, knees, and ankles, twin dorsal radiator towers, and armored conduits.
//   4. Focused melee-only emissive read (zero projectiles): recessed cyclops mono-eye lens
//      scanning inside a deep dark visor slit, armored recessed front & dorsal reactor cores,
//      sleek 1.48m razor-edged forearm thermal plasma cleaver-blade, and recessed 3D cooling
//      vents/seams that surge like internal reactor overload in Phase 2 (hpPct <= 0.35 —
//      never flashing whole armor red).
//   5. Mechanical servo kinematics: stepped detent idle scanning, 75ms hydraulic clamp lock
//      before explosive horizontal-diagonal blade cleave, heavy stomping vertical chassis
//      drop, and counter-swinging armored pauldrons.
//
// Technical Budgets & Contracts:
//   - Purely procedural Three.js BufferGeometries + single 512x512 procedural Canvas2D atlas.
//   - Strictly <= 20,000 triangles, <= 6 PBR materials (5 total).
//   - Standing height 4.0-4.2m (~4.10m), armored boots flush at y = 0, facing -Z.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type BossAnim = 'idle' | 'walk' | 'windup' | 'attack' | 'recover' | 'charge';

export interface BossUpdateState {
  hpPct: number;
  phase: 1 | 2;
  anim: BossAnim;
}

export interface BossParts {
  root: THREE.Group;              // Overall root
  torso?: THREE.Object3D;         // Upper armored chassis
  head: THREE.Object3D;           // Armored mono-eye sensor head (weakpoint)
  core: THREE.Object3D;           // Recessed front/back reactor core (weakpoint, purely self-emissive)
  leftArm: THREE.Object3D;        // Left shoulder arm actuator
  rightArm: THREE.Object3D;       // Right shoulder blade-arm actuator
  tail?: THREE.Object3D;          // Unused on mech (kept optional for interface compatibility)
  leftShoulder?: THREE.Object3D;  // Articulated left fortress buckler pauldron
  rightShoulder?: THREE.Object3D; // Articulated right hydraulic blade-servo pauldron
  rightBlade?: THREE.Object3D;    // Forearm-mounted thermal energy blade assembly
  ventGlow?: THREE.Object3D;      // Recessed chassis & heat-sink overload vent assembly
  monoEye?: THREE.Object3D;       // Scanning optical mono-eye sensor lens
}

export interface BossModel {
  parts: BossParts;
  update(dt: number, state: BossUpdateState): void;
  dispose(): void;
}

// ============================================================================
// Deterministic Math, Mechanical Easing & Noise Helpers
// ============================================================================

type Vec3Tuple = [number, number, number];
type Vec2Tuple = [number, number];

const DEG2RAD = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

/** Mechanical actuator curve: sharp acceleration with crisp hydraulic brake at stop. */
function mechSnap(t: number, power = 3.2): number {
  const u = clamp01(t);
  return 1 - Math.pow(1 - u, power);
}

/** Trapezoidal step-and-hold wave for rigid servo scanning / stepped mechanical stops. */
function steppedServoWave(phase: number, holdFrac = 0.60): number {
  const cyc = ((phase % 1) + 1) % 1;
  const moveFrac = (1 - holdFrac) * 0.5;
  if (cyc < moveFrac) {
    return lerp(-1, 1, mechSnap(cyc / moveFrac, 2.6));
  }
  if (cyc < moveFrac + holdFrac * 0.5) {
    return 1;
  }
  const mid = moveFrac + holdFrac * 0.5;
  if (cyc < mid + moveFrac) {
    return lerp(1, -1, mechSnap((cyc - mid) / moveFrac, 2.6));
  }
  return -1;
}

function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let n =
    Math.imul(ix | 0, 374761393) ^
    Math.imul(iy | 0, 668265263) ^
    Math.imul(iz | 0, 1274126177) ^
    Math.imul(seed | 0, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function hash2Tile(ix: number, iy: number, periodX: number, periodY: number, seed: number): number {
  const wx = ((ix % periodX) + periodX) % periodX;
  const wy = ((iy % periodY) + periodY) % periodY;
  return hash3(wx, wy, 0, seed);
}

function noise2Tile(x: number, y: number, periodX: number, periodY: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2Tile(ix, iy, periodX, periodY, seed);
  const b = hash2Tile(ix + 1, iy, periodX, periodY, seed);
  const c = hash2Tile(ix, iy + 1, periodX, periodY, seed);
  const d = hash2Tile(ix + 1, iy + 1, periodX, periodY, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2Tile(
  u: number,
  v: number,
  periodX: number,
  periodY: number,
  seed: number,
  octaves = 4,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = periodX;
  let py = periodY;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2Tile(u * px, v * py, px, py, seed + i * 23);
    norm += amp;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

// ============================================================================
// Single Procedural 512x512 Mech Atlas (Albedo + Normal + Emissive)
//
// 4 clean horizontal UV bands along v (Three.js flipY = true):
//   - Band A (Forged Rolled Armor Plate): v in [0.54, 0.98] — sleek brushed metal plate,
//                                         perimeter bezel seam & 4 corner fasteners (zero brick grid!),
//                                         fine metallic wear scratches & subtle outer seam heat bleed
//   - Band B (Industrial Hazard Trim):    v in [0.36, 0.51] — weathered 45-deg caution chevrons
//   - Band C (Hydraulic / Louver):        v in [0.19, 0.33] — machined shaft grooves & cooling louvers
//   - Band D (Thermal Reactor / Blade):   v in [0.02, 0.16] — plasma energy grain & superheated edge
// ============================================================================

const UV_BAND_ARMOR: [number, number] = [0.555, 0.965];
const UV_BAND_HAZARD: [number, number] = [0.375, 0.495];
const UV_BAND_MECH: [number, number] = [0.205, 0.315];
const UV_BAND_ENERGY: [number, number] = [0.030, 0.150];

interface MechAtlas {
  albedoMap: THREE.Texture;
  emissiveMap: THREE.Texture;
  normalMap: THREE.Texture;
  all: THREE.Texture[];
}

function makeFallbackTex(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const data = new Uint8Array([
    r, g, b, 255, r, g, b, 255,
    r, g, b, 255, r, g, b, 255,
  ]);
  const tex = new THREE.DataTexture(data, 2, 2);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildNormalCanvasFromHeight(
  height: Float32Array,
  size: number,
  strength: number,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const wrapX = (i: number): number => ((i % size) + size) % size;
  const clampY = (i: number): number => clamp(i, 0, size - 1);

  for (let y = 0; y < size; y++) {
    const ym = clampY(y - 1);
    const yp = clampY(y + 1);
    for (let x = 0; x < size; x++) {
      const xm = wrapX(x - 1);
      const xp = wrapX(x + 1);
      const tl = height[ym * size + xm];
      const t = height[ym * size + x];
      const tr = height[ym * size + xp];
      const l = height[y * size + xm];
      const r = height[y * size + xp];
      const bl = height[yp * size + xm];
      const b = height[yp * size + x];
      const br = height[yp * size + xp];

      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * 0.25 * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * 0.25 * strength;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx * invLen;
      const ny = -dy * invLen;
      const nz = invLen;
      const idx = (y * size + x) * 4;
      d[idx] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
      d[idx + 1] = Math.round(clamp01(ny * 0.5 + 0.5) * 255);
      d[idx + 2] = Math.round(clamp01(nz * 0.5 + 0.5) * 255);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function createMechAtlas(): MechAtlas {
  if (typeof document === 'undefined') {
    const albedoMap = makeFallbackTex(150, 158, 168, true);
    const emissiveMap = makeFallbackTex(190, 96, 26, true);
    const normalMap = makeFallbackTex(128, 128, 255, false);
    return { albedoMap, emissiveMap, normalMap, all: [albedoMap, emissiveMap, normalMap] };
  }

  const S = 512;
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = albedoCanvas.height = S;
  const albedoCtx = albedoCanvas.getContext('2d')!;
  const albedoImg = albedoCtx.createImageData(S, S);
  const ad = albedoImg.data;

  const emCanvas = document.createElement('canvas');
  emCanvas.width = emCanvas.height = S;
  const emCtx = emCanvas.getContext('2d')!;
  const emImg = emCtx.createImageData(S, S);
  const ed = emImg.data;

  const height = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    const v = 1 - (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const idx = y * S + x;
      const p4 = idx * 4;

      if (v >= 0.53) {
        // --- BAND A: Clean Forged Rolled-Steel Military Armor Sheet (NO brick pattern!) ---
        // Each physical 3D plate maps cleanly across this sheet -> single machined plate perimeter
        // bevel seam, 4 recessed corner hex-bolts, brushed rolled-steel sheen, and subtle wear.
        const bv = clamp01((v - 0.53) / 0.47);
        const edgeU = Math.min(u, 1 - u);
        const edgeV = Math.min(bv, 1 - bv);
        const borderDist = Math.min(edgeU, edgeV);

        // Single refined perimeter armor seam groove + subtle inner inspection line
        const outerSeam = smoothstep((0.022 - borderDist) / 0.015);
        const innerInset = Math.max(Math.abs(u - 0.5) - 0.43, Math.abs(bv - 0.5) - 0.41);
        const panelGroove = smoothstep((0.008 - Math.abs(innerInset)) / 0.006) * 0.65;

        // 4 clean industrial recessed corner bolts
        let bolt = 0;
        const bolts: Vec2Tuple[] = [
          [0.09, 0.10], [0.91, 0.10], [0.09, 0.90], [0.91, 0.90],
        ];
        for (let k = 0; k < bolts.length; k++) {
          const d = Math.hypot(u - bolts[k][0], bv - bolts[k][1]);
          if (d < 0.026) {
            bolt = Math.max(bolt, d < 0.014 ? 0.72 : -0.42);
          }
        }

        // Fine directional rolled-steel brushed grain + macro weathering mottling + subtle edge wear
        const brush = fbm2Tile(u * 2, bv * 20, 6, 32, 109, 3);
        const weather = fbm2Tile(u, bv, 4, 3, 223, 4);
        const streak = fbm2Tile(u * 6, bv * 2, 14, 4, 331, 3);
        const edgeChip =
          smoothstep((0.055 - borderDist) / 0.04) * smoothstep((streak - 0.52) * 3.8);
        const fineScratch = smoothstep((fbm2Tile(u * 5, bv * 5, 22, 16, 409, 2) - 0.80) * 6.5) * 0.35;

        // Smooth satin armor height (clean broad planes that catch specular highlights cleanly!)
        const h =
          0.66 -
          outerSeam * 0.36 -
          panelGroove * 0.18 +
          bolt * 0.18 +
          (brush - 0.5) * 0.05 +
          (weather - 0.5) * 0.04;
        height[idx] = clamp01(h);

        // Clean mid-neutral rolled steel albedo (vertex colors drive dark gunmetal / titanium / crimson!)
        const grimeMod = lerp(0.86, 1.04, weather) * lerp(0.95, 1.04, brush);
        const seamAO = 1 - outerSeam * 0.44 - panelGroove * 0.22;
        const baseLum = clamp(184 * grimeMod * seamAO + edgeChip * 38 + fineScratch * 24 + bolt * 14, 58, 228);

        ad[p4] = Math.round(baseLum * 0.96);
        ad[p4 + 1] = Math.round(baseLum * 0.99);
        ad[p4 + 2] = Math.round(clamp(baseLum * 1.04, 58, 232));
        ad[p4 + 3] = 255;

        // Subtle perimeter heat-seam bleed ONLY in the outer plate gap (glows softly in P2 overload!)
        const seamHeat = smoothstep((0.015 - borderDist) / 0.011) * (0.75 + 0.25 * weather);
        ed[p4] = Math.round(clamp01(seamHeat * 1.0) * 255);
        ed[p4 + 1] = Math.round(clamp01(seamHeat * 0.42) * 255);
        ed[p4 + 2] = Math.round(clamp01(seamHeat * 0.08) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.35) {
        // --- BAND B: Weathered Industrial Caution Hazard Stripes ---
        const bv = clamp01((v - 0.35) / 0.18);
        const border = bv < 0.11 || bv > 0.89;
        const diag = ((u * 7 + bv * 1.55) % 1 + 1) % 1;
        const isYellow = diag < 0.50;
        const stripeDist = Math.min(Math.abs(diag - 0.50), Math.min(diag, 1 - diag));
        const chipNoise = fbm2Tile(u * 2, bv, 14, 4, 521, 3);
        const chipped = smoothstep((chipNoise - 0.72) * 5.0) * smoothstep((0.12 - stripeDist) / 0.12);
        const wear = fbm2Tile(u, bv, 8, 4, 607, 3);

        height[idx] = border ? 0.42 : 0.64 - chipped * 0.16 + (wear - 0.5) * 0.08;

        if (border) {
          const lum = 44 + wear * 18;
          ad[p4] = Math.round(lum * 0.94);
          ad[p4 + 1] = Math.round(lum * 0.98);
          ad[p4 + 2] = Math.round(lum * 1.05);
        } else if (isYellow && chipped < 0.55) {
          // Muted weathered industrial amber-ochre (never clips neon under exposure 1.45)
          const sh = 0.80 + wear * 0.22;
          ad[p4] = Math.round(clamp(182 * sh, 110, 194));
          ad[p4 + 1] = Math.round(clamp(124 * sh, 74, 138));
          ad[p4 + 2] = Math.round(clamp(28 * sh, 16, 44));
        } else {
          const lum = chipped >= 0.55 ? 116 + wear * 24 : 34 + wear * 16;
          ad[p4] = Math.round(lum * 0.95);
          ad[p4 + 1] = Math.round(lum * 0.98);
          ad[p4 + 2] = Math.round(lum * 1.04);
        }
        ad[p4 + 3] = 255;
        ed[p4] = 0;
        ed[p4 + 1] = 0;
        ed[p4 + 2] = 0;
        ed[p4 + 3] = 255;
      } else if (v >= 0.18) {
        // --- BAND C: Machined Hydraulic Steel, Cooling Louvers & Segmented Hose Ribs ---
        const bv = clamp01((v - 0.18) / 0.17);
        const ribPhase = (bv * 8) % 1;
        const rib = smoothstep(Math.min(ribPhase, 1 - ribPhase) / 0.24);
        const lathe = fbm2Tile(u * 4, bv * 2, 16, 4, 733, 3);

        height[idx] = clamp01(0.28 + rib * 0.56 + (lathe - 0.5) * 0.08);
        const lum = clamp(102 + rib * 84 + (lathe - 0.5) * 24, 46, 208);
        ad[p4] = Math.round(lum * 0.96);
        ad[p4 + 1] = Math.round(lum * 0.99);
        ad[p4 + 2] = Math.round(lum * 1.04);
        ad[p4 + 3] = 255;

        // Recessed louver slit emissive for heat-sink vents
        const ventEm = Math.pow(1 - rib, 1.35);
        ed[p4] = Math.round(clamp01(ventEm * 1.0) * 255);
        ed[p4 + 1] = Math.round(clamp01(ventEm * 0.45) * 255);
        ed[p4 + 2] = Math.round(clamp01(ventEm * 0.08) * 255);
        ed[p4 + 3] = 255;
      } else {
        // --- BAND D: Thermal Reactor Lattice & Superheated Plasma Energy Blade ---
        // bv = 0 near emitter spine/root -> bv = 1 at blazing white-gold razor edge!
        const bv = clamp01(v / 0.18);
        const flow = fbm2Tile(u * 2, bv, 10, 4, 881, 4);
        const streak = 0.5 + 0.5 * Math.sin((u * 12 + flow * 2.2) * Math.PI * 2);
        const edgeHeat = smoothstep((bv - 0.14) / 0.78);
        const hotCore = clamp01(edgeHeat * 0.82 + streak * 0.14 + flow * 0.12);
        height[idx] = clamp01(0.42 + streak * 0.18);

        const r = lerp(70, 224, hotCore);
        const g = lerp(22, 152, Math.pow(hotCore, 1.3));
        const b = lerp(8, 62, Math.pow(hotCore, 2.1));
        ad[p4] = Math.round(clamp(r, 24, 232));
        ad[p4 + 1] = Math.round(clamp(g, 10, 180));
        ad[p4 + 2] = Math.round(clamp(b, 6, 98));
        ad[p4 + 3] = 255;

        const em = clamp01(0.22 + edgeHeat * 0.78) * (0.86 + 0.14 * streak);
        ed[p4] = Math.round(clamp01(em * 1.0) * 255);
        ed[p4 + 1] = Math.round(clamp01(em * lerp(0.32, 0.82, edgeHeat)) * 255);
        ed[p4 + 2] = Math.round(clamp01(em * lerp(0.05, 0.36, Math.pow(edgeHeat, 1.8))) * 255);
        ed[p4 + 3] = 255;
      }
    }
  }

  albedoCtx.putImageData(albedoImg, 0, 0);
  emCtx.putImageData(emImg, 0, 0);
  const normalCanvas = buildNormalCanvasFromHeight(height, S, 2.8);

  const wrapTex = (c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };

  const albedoMap = wrapTex(albedoCanvas, true);
  const emissiveMap = wrapTex(emCanvas, true);
  const normalMap = wrapTex(normalCanvas, false);
  return { albedoMap, emissiveMap, normalMap, all: [albedoMap, emissiveMap, normalMap] };
}

// ============================================================================
// Hard-Surface CAD Geometry Primitives & Merge Helpers
// ============================================================================

// Bold 3-value industrial military mech palette (calibrated for Saltline exposure 1.45 & IBL 1.9
// AND high silhouette separation in dark industrial scenes — zero pale-concrete washout!):
const TINT_ARMOR_MAIN: Vec3Tuple = [0.22, 0.26, 0.32];    // Deep tactical obsidian-gunmetal steel (55%)
const TINT_ARMOR_DARK: Vec3Tuple = [0.13, 0.16, 0.20];    // Recessed shadowed charcoal under-armor
const TINT_ARMOR_LIGHT: Vec3Tuple = [0.54, 0.60, 0.67];   // Cold battleship titanium highlight plates (25%)
const TINT_ARMOR_CRIMSON: Vec3Tuple = [0.52, 0.15, 0.12]; // Matte industrial crimson-oxide commander trim (12%)
const TINT_ARMOR_TRIM: Vec3Tuple = [0.36, 0.41, 0.48];    // Mid brushed gunsteel secondary armor
const TINT_HAZARD: Vec3Tuple = [0.88, 0.86, 0.82];        // Weathered caution hazard trim
const TINT_FRAME_DARK: Vec3Tuple = [0.12, 0.14, 0.18];    // Oiled carbon-steel inner skeleton
const TINT_FRAME_MID: Vec3Tuple = [0.26, 0.30, 0.36];     // Machined gunsteel rotor drums & clevises
const TINT_PISTON_CHROME: Vec3Tuple = [0.76, 0.81, 0.88]; // Gleaming chrome-steel hydraulic rods
const TINT_PISTON_BRASS: Vec3Tuple = [0.82, 0.64, 0.34];  // Industrial machined bronze-brass rams
const TINT_CORE_HOT: Vec3Tuple = [1.0, 0.90, 0.78];       // Recessed reactor core & thermal vents

interface HardSurfaceOpts {
  pos?: Vec3Tuple;
  rot?: Vec3Tuple;
  tint?: Vec3Tuple;
  band?: [number, number];
  uvScale?: number;
  aoBottom?: number;
  faceted?: boolean;
}

/** Box-projected UVs mapped cleanly into [0..1] of the chosen atlas band (1 forged plate per part!). */
function applyBoxBandUV(
  geo: THREE.BufferGeometry,
  band: [number, number],
  uvScale = 1.0,
): void {
  const pos = geo.getAttribute('position');
  const norm = geo.getAttribute('normal');
  const [vMin, vMax] = band;
  const uvs = new Float32Array(pos.count * 2);

  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const sx = Math.max(0.05, bb.max.x - bb.min.x);
  const sy = Math.max(0.05, bb.max.y - bb.min.y);
  const sz = Math.max(0.05, bb.max.z - bb.min.z);

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const ax = norm ? Math.abs(norm.getX(i)) : 0;
    const ay = norm ? Math.abs(norm.getY(i)) : 1;
    const az = norm ? Math.abs(norm.getZ(i)) : 0;

    let lu: number;
    let lv: number;
    if (ax >= ay && ax >= az) {
      lu = ((pz - bb.min.z) / sz) * uvScale;
      lv = clamp01((py - bb.min.y) / sy);
    } else if (ay >= ax && ay >= az) {
      lu = ((px - bb.min.x) / sx) * uvScale;
      lv = clamp01((pz - bb.min.z) / sz);
    } else {
      lu = ((px - bb.min.x) / sx) * uvScale;
      lv = clamp01((py - bb.min.y) / sy);
    }
    uvs[i * 2] = lu;
    uvs[i * 2 + 1] = lerp(vMin, vMax, lv);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
}

function finalizePart(geo: THREE.BufferGeometry, opts: HardSurfaceOpts = {}): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();

  if (opts.faceted) {
    g.computeVertexNormals();
  } else if (!g.getAttribute('normal')) {
    g.computeVertexNormals();
  }

  applyBoxBandUV(g, opts.band ?? UV_BAND_ARMOR, opts.uvScale ?? 1.0);

  const pos = g.getAttribute('position');
  const norm = g.getAttribute('normal');
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const spanY = Math.max(0.001, bb.max.y - bb.min.y);
  const tint = opts.tint ?? TINT_ARMOR_MAIN;
  const aoBot = opts.aoBottom ?? 0.22;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const uy = clamp01((pos.getY(i) - bb.min.y) / spanY);
    const ny = norm ? norm.getY(i) : 0;
    // Directional bevel top-catch + crisp underside AO
    const bevelBoost = 0.94 + ny * 0.14;
    const shade = lerp(1 - aoBot, 1.08, uy) * bevelBoost;
    colors[i * 3] = clamp(tint[0] * shade, 0.04, 1.2);
    colors[i * 3 + 1] = clamp(tint[1] * shade, 0.04, 1.2);
    colors[i * 3 + 2] = clamp(tint[2] * shade, 0.04, 1.2);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    g.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  return g;
}

function normalizeForMerge(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position');
  if (!g.getAttribute('uv')) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = 0.5;
      uvs[i * 2 + 1] = lerp(UV_BAND_ARMOR[0], UV_BAND_ARMOR[1], 0.5);
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  if (!g.getAttribute('color')) {
    const colors = new Float32Array(pos.count * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
      g.deleteAttribute(key);
    }
  }
  return g;
}

function mergeStrict(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = geos.map((g) => normalizeForMerge(g));
  const merged = mergeGeometries(normalized, false);
  for (const g of normalized) g.dispose();
  if (!merged) throw new Error('bossModel: mergeGeometries failed');
  return merged;
}

/** Hard-surface 45-degree beveled rectangular armor block with exact outer dims (w x h x d). */
function buildChamferBox(
  w: number,
  h: number,
  d: number,
  bevel = 0.026,
  opts: HardSurfaceOpts = {},
): THREE.BufferGeometry {
  const b = Math.min(bevel, w * 0.34, h * 0.34, d * 0.34);
  const hw = Math.max(0.004, w * 0.5 - b);
  const hh = Math.max(0.004, h * 0.5 - b);
  const coreD = Math.max(0.004, d - 2 * b);

  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreD,
    bevelEnabled: b > 0.001,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -coreD * 0.5);
  return finalizePart(geo, { faceted: true, ...opts });
}

/** Extruded custom polygonal armor plate (in XY plane, extruded along Z) with crisp 45-deg chamfers. */
function buildSlopedPlate(
  pts: Vec2Tuple[],
  depth: number,
  bevel = 0.024,
  opts: HardSurfaceOpts = {},
): THREE.BufferGeometry {
  const b = Math.min(bevel, depth * 0.36);
  const coreD = Math.max(0.004, depth - 2 * b);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], pts[i][1]);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreD,
    bevelEnabled: b > 0.001,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.translate(0, 0, -coreD * 0.5);
  return finalizePart(geo, { faceted: true, ...opts });
}

/** Beveled octagonal/tapered armored frustum shell (much more sculpted than raw boxes!). */
function buildArmoredFrustum(
  wBot: number,
  dBot: number,
  wTop: number,
  dTop: number,
  h: number,
  skewZ = 0,
  skewX = 0,
  opts: HardSurfaceOpts = {},
): THREE.BufferGeometry {
  // 8-sided chamfered prism cylinder rotated 22.5 deg so flat faces face +/-X and +/-Z with 45-deg corners!
  const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  geo.rotateY(Math.PI / 8);
  const scaleNorm = 1 / Math.cos(Math.PI / 8);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * scaleNorm * 0.5;
    const y = pos.getY(i);
    const z = pos.getZ(i) * scaleNorm * 0.5;
    const isTop = y > 0;
    const w = isTop ? wTop : wBot;
    const d = isTop ? dTop : dBot;
    const ox = isTop ? skewX * 0.5 : -skewX * 0.5;
    const oz = isTop ? skewZ * 0.5 : -skewZ * 0.5;
    pos.setXYZ(i, x * w + ox, y * h, z * d + oz);
  }
  return finalizePart(geo, { faceted: true, ...opts });
}

/** Smooth-shaded machined cylinder/cone for drums, pistons, bearings, exhaust stacks. */
function buildCylinder(
  rTop: number,
  rBot: number,
  len: number,
  segs = 12,
  opts: HardSurfaceOpts = {},
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, segs, 1, false);
  return finalizePart(geo, { faceted: false, band: UV_BAND_MECH, ...opts });
}

/** Complete mechanical hydraulic actuator connecting point A -> point B (dark barrel + bright chrome/brass rod). */
function buildHydraulicPiston(
  a: Vec3Tuple,
  b: Vec3Tuple,
  barrelR: number,
  rodR: number,
  rodTint: Vec3Tuple = TINT_PISTON_CHROME,
  barrelTint: Vec3Tuple = TINT_FRAME_DARK,
): THREE.BufferGeometry[] {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  if (len < 0.02) return [];

  const unitDir = dir.clone().divideScalar(len);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), unitDir);
  const euler = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  const rot: Vec3Tuple = [euler.x, euler.y, euler.z];

  const barrelLen = len * 0.54;
  const barrelMid = va.clone().addScaledVector(unitDir, barrelLen * 0.5);
  const collarPos = va.clone().addScaledVector(unitDir, barrelLen);
  const rodLen = len * 0.56;
  const rodMid = va.clone().addScaledVector(unitDir, len - rodLen * 0.5);

  return [
    buildCylinder(barrelR, barrelR * 1.04, barrelLen, 10, {
      pos: [barrelMid.x, barrelMid.y, barrelMid.z],
      rot,
      tint: barrelTint,
      band: UV_BAND_MECH,
    }),
    buildCylinder(barrelR * 1.26, barrelR * 1.26, Math.min(0.044, len * 0.10), 10, {
      pos: [collarPos.x, collarPos.y, collarPos.z],
      rot,
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH,
    }),
    buildCylinder(rodR, rodR, rodLen, 10, {
      pos: [rodMid.x, rodMid.y, rodMid.z],
      rot,
      tint: rodTint,
      band: UV_BAND_MECH,
      aoBottom: 0.04,
    }),
    buildCylinder(barrelR * 1.15, barrelR * 1.15, barrelR * 1.8, 8, {
      pos: a,
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH,
    }),
    buildCylinder(rodR * 1.45, rodR * 1.45, rodR * 2.3, 8, {
      pos: b,
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH,
    }),
  ];
}

/** Armored segmented industrial power conduit hose along 3D waypoints. */
function buildArmoredConduit(
  pts: Vec3Tuple[],
  radius: number,
  tubularSegs = 12,
  radialSegs = 7,
  tint: Vec3Tuple = TINT_FRAME_DARK,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const geo = new THREE.TubeGeometry(curve, tubularSegs, radius, radialSegs, false);
  return finalizePart(geo, { faceted: false, band: UV_BAND_MECH, tint, uvScale: 2.0 });
}

/** Stacked angled mechanical radiator louver slats for chest/shoulder/backpack cooling vents. */
function buildLouverBank(
  w: number,
  h: number,
  d: number,
  slats: number,
  pos: Vec3Tuple,
  rot: Vec3Tuple = [0, 0, 0],
  tint: Vec3Tuple = TINT_FRAME_MID,
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const stepY = h / Math.max(1, slats);
  const slatH = stepY * 0.42;
  const mat = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const v = new THREE.Vector3();

  for (let i = 0; i < slats; i++) {
    const ly = -h * 0.5 + (i + 0.5) * stepY;
    v.set(0, ly, 0).applyMatrix4(mat);
    out.push(
      buildChamferBox(w, slatH, d, 0.005, {
        pos: [pos[0] + v.x, pos[1] + v.y, pos[2] + v.z],
        rot: [rot[0] + 0.36, rot[1], rot[2]],
        tint,
        band: UV_BAND_MECH,
      }),
    );
  }
  return out;
}

/**
 * Sleek razor-chisel 1.54m thermal plasma cleaver-sword blade extending along -Y (0 -> -length),
 * razor cutting edge along -Z, heavy mechanical tungsten spine along +Z.
 * Asymmetric futuristic single-edged tanto/chisel point (zero blunt cone look!).
 */
function buildPlasmaBladeGeometry(length: number, width: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  // In XY plane (rotated -90 deg around Y -> +X becomes +Z spine, -X becomes -Z razor cutting edge):
  shape.moveTo(width * 0.14, 0.05);            // Spine emitter socket root
  shape.lineTo(-width * 0.42, -0.02);          // Emitter guard throat
  shape.lineTo(-width * 0.58, -length * 0.12); // Flared plasma heel
  shape.lineTo(-width * 0.56, -length * 0.78); // Long straight razor plasma edge
  shape.lineTo(width * 0.12, -length);         // Razor asymmetric chisel-tanto tip!
  shape.lineTo(width * 0.16, -length * 0.88);  // Short sharp back spine corner
  shape.lineTo(width * 0.16, 0.05);            // Straight mechanical back spine
  shape.closePath();

  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: thickness * 0.24,
    bevelEnabled: true,
    bevelThickness: thickness * 0.38,
    bevelSize: 0.008,
    bevelSegments: 1,
    curveSegments: 1,
  });
  raw.translate(0, 0, -thickness * 0.12);
  raw.rotateY(-Math.PI * 0.5);

  const g = raw.index ? raw.toNonIndexed() : raw;
  g.computeVertexNormals();

  // Heat gradient UV in Band D: emitter spine (+Z) = deep orange root, razor edge (-Z) & chisel tip = incandescent white-gold!
  const pos = g.getAttribute('position');
  const uvs = new Float32Array(pos.count * 2);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const along = clamp01(-py / length);
    const edgeFactor = clamp01((-pz + width * 0.14) / (width * 0.72));
    const heat = clamp01(edgeFactor * 0.86 + along * 0.20);
    uvs[i * 2] = along * 2.4;
    uvs[i * 2 + 1] = lerp(UV_BAND_ENERGY[0], UV_BAND_ENERGY[1], heat);
    const c = lerp(0.84, 1.18, heat);
    colors[i * 3] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// ============================================================================
// Mech Skeleton Dimension Constants (Standing Height = 4.10m, Soles at y = 0.000)
// ============================================================================

const BASE_HIP_Y = 1.96;     // World Y of hip/pelvis pivot
const THIGH_LEN = 0.88;      // Hip (1.92) -> Knee (1.04)
const SHIN_LEN = 0.80;       // Knee (1.04) -> Ankle (0.24)
const FOOT_SOLE_Y = -0.24;   // Ankle (0.24) -> Sole flush at world y = 0.000

const ATTACK_LOCK_SEC = 0.075;   // 75ms rigid hydraulic lock before blade release
const ATTACK_SWEEP_SEC = 0.095;  // 95ms explosive hydraulic cleave sweep
const RECOVER_DURATION = 0.78;

// ============================================================================
// Articulated Component Geometry Builders
// ============================================================================

function buildTorsoParts(): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  vent: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];
  const core: THREE.BufferGeometry[] = [];
  const vent: THREE.BufferGeometry[] = [];

  // --- 1. Compact Tapered Hydraulic Waist Gimbal (V-taper hero proportions! y = 0.12..0.60) ---
  frame.push(
    buildCylinder(0.24, 0.26, 0.56, 12, { pos: [0, 0.34, 0.02], tint: TINT_FRAME_DARK }),
    buildCylinder(0.32, 0.32, 0.08, 12, { pos: [0, 0.24, 0.02], tint: TINT_FRAME_MID }),
    buildCylinder(0.31, 0.31, 0.08, 12, { pos: [0, 0.44, 0.02], tint: TINT_FRAME_MID }),
  );
  // 2 angular V-shaped segmented abdominal armor plates (compact waist!)
  armor.push(
    buildArmoredFrustum(0.54, 0.42, 0.62, 0.46, 0.20, -0.02, 0, { pos: [0, 0.28, -0.06], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.62, 0.46, 0.76, 0.52, 0.22, -0.04, 0, { pos: [0, 0.48, -0.08], tint: TINT_ARMOR_MAIN }),
  );
  // 4 gleaming diagonal heavy waist hydraulic pistons bracing pelvis -> fortress chest!
  frame.push(
    ...buildHydraulicPiston([-0.32, 0.08, -0.14], [-0.46, 0.66, -0.22], 0.052, 0.030, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.32, 0.08, -0.14], [0.46, 0.66, -0.22], 0.052, 0.030, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([-0.30, 0.08, 0.24], [-0.42, 0.68, 0.30], 0.056, 0.032, TINT_PISTON_BRASS),
    ...buildHydraulicPiston([0.30, 0.08, 0.24], [0.42, 0.68, 0.30], 0.056, 0.032, TINT_PISTON_BRASS),
  );

  // --- 2. Broad V-Tapered Angular Fortress Chest Hull (y = 0.56..1.50, width ~1.52m!) ---
  // Core sloped octagonal armored chassis core
  frame.push(
    buildArmoredFrustum(0.92, 0.72, 1.38, 0.86, 0.84, -0.06, 0, { pos: [0, 1.00, 0.02], tint: TINT_FRAME_DARK }),
  );

  // Angled composite reactive-armor pectoral doors framing a deeply recessed central reactor bay!
  for (const s of [-1, 1] as const) {
    // Broad sweeping gunmetal pectoral armor wedge (tilted forward & outward like an armored tank hull!)
    const mainPec: Vec2Tuple[] = [
      [-0.18, -0.32],
      [0.34, -0.26],
      [0.44, 0.26],
      [-0.12, 0.34],
    ];
    armor.push(
      buildSlopedPlate(
        s === 1 ? mainPec : mainPec.map(([x, y]) => [-x, y] as Vec2Tuple).reverse(),
        0.26,
        0.032,
        {
          pos: [s * 0.44, 1.02, -0.34],
          rot: [-0.18, s * 0.28, s * -0.06],
          tint: TINT_ARMOR_MAIN,
        },
      ),
    );
    // High-contrast cold titanium upper pectoral glacis armor plate (creates unmistakable V-chest silhouette!)
    const upperPec: Vec2Tuple[] = [
      [-0.18, -0.14],
      [0.30, -0.10],
      [0.34, 0.16],
      [-0.10, 0.20],
    ];
    armor.push(
      buildSlopedPlate(
        s === 1 ? upperPec : upperPec.map(([x, y]) => [-x, y] as Vec2Tuple).reverse(),
        0.14,
        0.024,
        {
          pos: [s * 0.48, 1.18, -0.46],
          rot: [-0.26, s * 0.30, s * -0.06],
          tint: TINT_ARMOR_LIGHT,
        },
      ),
    );
    // Matte crimson-oxide command chevron accent strip beneath upper chest plate
    armor.push(
      buildChamferBox(0.38, 0.08, 0.12, 0.012, {
        pos: [s * 0.46, 0.96, -0.49],
        rot: [-0.16, s * 0.28, s * 0.14],
        tint: TINT_ARMOR_CRIMSON,
      }),
      // Weathered hazard caution trim on lower chest chin
      buildChamferBox(0.28, 0.075, 0.12, 0.010, {
        pos: [s * 0.40, 0.72, -0.46],
        rot: [-0.14, s * 0.24, 0],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 0.75,
      }),
    );

    // Diagonal recessed glowing chest cooling slits (subtle amber in P1, blazing overload in P2!)
    vent.push(
      buildChamferBox(0.24, 0.045, 0.06, 0.006, {
        pos: [s * 0.46, 1.06, -0.49],
        rot: [-0.20, s * 0.28, s * 0.16],
        tint: TINT_CORE_HOT,
        band: UV_BAND_ENERGY,
      }),
    );

    // Heavy sloped flank rib-armor plates + cooling louver banks
    armor.push(
      buildChamferBox(0.22, 0.56, 0.68, 0.026, {
        pos: [s * 0.72, 1.02, 0.04],
        rot: [0, 0, s * -0.18],
        tint: TINT_ARMOR_DARK,
      }),
    );
    frame.push(
      ...buildLouverBank(0.08, 0.34, 0.34, 5, [s * 0.82, 1.00, 0.04], [0, 0, s * -0.18], TINT_FRAME_MID),
    );
    vent.push(
      buildChamferBox(0.05, 0.32, 0.26, 0.008, {
        pos: [s * 0.77, 1.00, 0.04],
        rot: [0, 0, s * -0.18],
        tint: TINT_CORE_HOT,
        band: UV_BAND_MECH,
      }),
    );

    // Seamless armored clavicle bridge connecting torso into rotary shoulder drum (zero floating gap!)
    armor.push(
      buildChamferBox(0.46, 0.20, 0.48, 0.026, {
        pos: [s * 0.62, 1.38, -0.04],
        rot: [0.06, s * 0.08, s * -0.16],
        tint: TINT_ARMOR_TRIM,
      }),
    );
    frame.push(
      buildCylinder(0.23, 0.23, 0.38, 12, {
        pos: [s * 0.80, 1.30, 0.0],
        rot: [0, 0, Math.PI * 0.5],
        tint: TINT_FRAME_MID,
      }),
      ...buildHydraulicPiston(
        [s * 0.34, 1.40, -0.14],
        [s * 0.76, 1.44, 0.0],
        0.046,
        0.026,
        TINT_PISTON_BRASS,
      ),
    );
  }

  // Deeply Recessed Octagonal Armored Reactor Bay Housing (replaces flat sticker look!)
  // Thick sloped dark bezel walls framing the glowing inner turbine core!
  armor.push(
    // Heavy protruding central upper sternal prow hood overhanging reactor recess
    buildChamferBox(0.56, 0.22, 0.34, 0.028, { pos: [0, 1.24, -0.44], rot: [-0.28, 0, 0], tint: TINT_ARMOR_LIGHT }),
    // Crimson command badge stripe across upper sternal brow
    buildChamferBox(0.32, 0.08, 0.14, 0.012, { pos: [0, 1.31, -0.54], rot: [-0.28, 0, 0], tint: TINT_ARMOR_CRIMSON }),
    // Lower sternal armored keel block
    buildChamferBox(0.46, 0.20, 0.30, 0.026, { pos: [0, 0.66, -0.42], rot: [0.24, 0, 0], tint: TINT_ARMOR_MAIN }),
  );
  frame.push(
    // Thick recessed outer armored octagonal turbine bezel framing front core
    buildCylinder(0.25, 0.28, 0.18, 8, {
      pos: [0, 0.96, -0.42],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_FRAME_DARK,
    }),
    // Diagonal X-brace turbine blast cage + central machined reactor hub cap (exposes 4 glowing quadrants!)
    buildChamferBox(0.42, 0.044, 0.09, 0.007, { pos: [0, 0.96, -0.51], rot: [0, 0, Math.PI * 0.25], tint: TINT_FRAME_MID }),
    buildChamferBox(0.42, 0.044, 0.09, 0.007, { pos: [0, 0.96, -0.51], rot: [0, 0, -Math.PI * 0.25], tint: TINT_FRAME_MID }),
    buildCylinder(0.072, 0.082, 0.11, 8, {
      pos: [0, 0.96, -0.50],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_ARMOR_LIGHT,
    }),
  );

  // --- 3. High Armored Fortress Gorget / Collar Bunker & Rollbars (frames compact head cleanly!) ---
  armor.push(
    // Rear sloped armored bunker cowl behind head
    buildChamferBox(0.74, 0.36, 0.30, 0.030, { pos: [0, 1.54, 0.22], rot: [-0.16, 0, 0], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.62, 0.14, 0.34, 0.022, { pos: [0, 1.68, 0.16], rot: [0.20, 0, 0], tint: TINT_ARMOR_LIGHT }),
    // Low angled front gorget chin-shield (never blocks mono-eye!)
    buildChamferBox(0.44, 0.14, 0.20, 0.018, { pos: [0, 1.40, -0.36], rot: [-0.26, 0, 0], tint: TINT_ARMOR_DARK }),
  );
  for (const s of [-1, 1] as const) {
    // Angled armored collar cheek bunkers flanking neck
    armor.push(
      buildChamferBox(0.16, 0.30, 0.46, 0.022, {
        pos: [s * 0.36, 1.52, -0.02],
        rot: [0.06, s * -0.16, s * 0.14],
        tint: TINT_ARMOR_MAIN,
      }),
    );
    frame.push(
      buildArmoredConduit(
        [
          [s * 0.34, 1.38, -0.32],
          [s * 0.44, 1.58, -0.26],
          [s * 0.44, 1.68, 0.06],
          [s * 0.36, 1.60, 0.26],
        ],
        0.028,
        10,
        6,
        TINT_FRAME_MID,
      ),
    );
  }

  // --- 4. Twin Dorsal Reactor Heat-Sink Towers & Armored Exhaust Stacks (Back +Z) ---
  armor.push(
    buildChamferBox(0.70, 0.86, 0.36, 0.032, { pos: [0, 1.02, 0.44], tint: TINT_ARMOR_DARK }),
  );
  // Armored blast-shutter bezel framing rear dorsal reactor core
  frame.push(
    buildCylinder(0.24, 0.27, 0.18, 8, {
      pos: [0, 0.98, 0.56],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_FRAME_DARK,
    }),
    buildChamferBox(0.40, 0.055, 0.10, 0.008, { pos: [0, 1.05, 0.65], tint: TINT_FRAME_MID }),
    buildChamferBox(0.40, 0.055, 0.10, 0.008, { pos: [0, 0.91, 0.65], tint: TINT_FRAME_MID }),
    buildChamferBox(0.06, 0.36, 0.10, 0.008, { pos: [0, 0.98, 0.65], tint: TINT_FRAME_MID }),
  );

  for (const s of [-1, 1] as const) {
    // Heavy twin vertical turbine heat-sink towers
    armor.push(
      buildArmoredFrustum(0.36, 0.46, 0.42, 0.44, 0.94, 0.06, s * 0.04, {
        pos: [s * 0.48, 1.18, 0.50],
        tint: TINT_ARMOR_MAIN,
      }),
      // Titanium upper heat-sink cowl cap + crimson command tip
      buildChamferBox(0.36, 0.24, 0.42, 0.026, {
        pos: [s * 0.50, 1.66, 0.48],
        rot: [0.16, s * -0.12, s * -0.10],
        tint: TINT_ARMOR_LIGHT,
      }),
      // Swept dorsal stabilizer wing-fin (breaks up upper back silhouette cleanly!)
      buildSlopedPlate(
        [
          [-0.08, -0.22],
          [0.10, -0.22],
          [0.26, 0.32],
          [0.04, 0.38],
        ],
        0.09,
        0.016,
        {
          pos: [s * 0.62, 1.68, 0.60],
          rot: [0.22, s * -0.24, s * -0.26],
          tint: TINT_ARMOR_CRIMSON,
        },
      ),
    );
    // Twin vertical armored exhaust chimney stacks reaching ~3.98m world Y
    frame.push(
      buildCylinder(0.082, 0.102, 0.44, 10, {
        pos: [s * 0.44, 1.82, 0.54],
        rot: [0.14, 0, s * -0.10],
        tint: TINT_FRAME_DARK,
      }),
      buildCylinder(0.112, 0.112, 0.07, 10, {
        pos: [s * 0.46, 2.00, 0.57],
        rot: [0.14, 0, s * -0.10],
        tint: TINT_FRAME_MID,
      }),
      // Lower thruster exhaust nozzle bell
      buildCylinder(0.11, 0.17, 0.24, 10, {
        pos: [s * 0.46, 0.68, 0.56],
        rot: [0.26, 0, s * -0.06],
        tint: TINT_FRAME_MID,
      }),
      // Ribbed armored power conduit arching from backpack over shoulder drum
      buildArmoredConduit(
        [
          [s * 0.50, 1.54, 0.34],
          [s * 0.68, 1.50, 0.14],
          [s * 0.80, 1.38, 0.02],
        ],
        0.048,
        10,
        7,
        TINT_FRAME_DARK,
      ),
    );
    // Dorsal heat-sink vent slats + recessed glowing exhaust chamber
    frame.push(
      ...buildLouverBank(0.26, 0.44, 0.10, 5, [s * 0.48, 1.24, 0.72], [0.06, s * -0.10, 0], TINT_FRAME_MID),
    );
    vent.push(
      buildChamferBox(0.22, 0.42, 0.05, 0.008, {
        pos: [s * 0.48, 1.24, 0.69],
        rot: [0.06, s * -0.10, 0],
        tint: TINT_CORE_HOT,
        band: UV_BAND_MECH,
      }),
      buildCylinder(0.09, 0.11, 0.07, 10, {
        pos: [s * 0.46, 0.62, 0.58],
        rot: [0.26, 0, s * -0.06],
        tint: TINT_CORE_HOT,
        band: UV_BAND_ENERGY,
      }),
    );
  }

  // --- 5. Recessed Front Chest & Rear Dorsal Reactor Core (parts.core, centered at local y = 0.96 -> world 2.92m) ---
  core.push(
    // Front deeply recessed inner reactor turbine drum (behind armored cage bars!)
    buildCylinder(0.20, 0.20, 0.12, 14, {
      pos: [0, 0, -0.45],
      rot: [Math.PI * 0.5, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_ENERGY,
    }),
    // Rear deeply recessed dorsal reactor turbine drum (matches back-core weakpoint!)
    buildCylinder(0.19, 0.19, 0.12, 14, {
      pos: [0, 0.02, 0.60],
      rot: [Math.PI * 0.5, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_ENERGY,
    }),
  );

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    core: mergeStrict(core),
    vent: mergeStrict(vent),
  };
}

function buildHeadParts(): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  monoEye: THREE.BufferGeometry;
  monoEyeBezel: THREE.BufferGeometry;
} {
  // Mounted at torso (0, 1.52, -0.12) -> world (0, 3.48, -0.12).
  // Compact, lethal armored siege helmet (spans local y in [-0.05, +0.62] -> world y = 3.43..4.10m).
  // Tighter head scale vs massive 2.7m shoulders creates instant 4.1m giant-mech monumentality!
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];

  // Hydraulic neck gimbal & twin chrome neck pistons
  frame.push(
    buildCylinder(0.13, 0.16, 0.20, 10, { pos: [0, 0.04, 0.02], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.12, -0.04, -0.02], [-0.13, 0.15, -0.06], 0.028, 0.016, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.12, -0.04, -0.02], [0.13, 0.15, -0.06], 0.028, 0.016, TINT_PISTON_CHROME),
  );

  // Deep recessed matte-dark cylindrical visor track cavity (mono-eye glows INSIDE this dark slit!)
  frame.push(
    buildCylinder(0.185, 0.185, 0.12, 14, { pos: [0, 0.26, -0.03], tint: [0.05, 0.06, 0.08] }),
    // Thin vertical center visor pillar framing the cyclops bay
    buildChamferBox(0.036, 0.12, 0.06, 0.006, { pos: [0, 0.14, -0.21], tint: TINT_FRAME_MID }),
  );

  // Swept angular V-brow Armored Siege Helmet (predatory scowl overhanging recessed visor!)
  armor.push(
    // Sloped titanium top helmet dome angled forward-down over visor slit
    buildArmoredFrustum(0.44, 0.48, 0.34, 0.40, 0.18, -0.04, 0, {
      pos: [0, 0.40, -0.01],
      rot: [0.14, 0, 0],
      tint: TINT_ARMOR_LIGHT,
    }),
    // Sharp angled V-brow crimson visor wings (menacing heavy combat mech scowl!)
    buildChamferBox(0.22, 0.075, 0.20, 0.012, {
      pos: [-0.11, 0.345, -0.17],
      rot: [0.22, 0.10, -0.16],
      tint: TINT_ARMOR_CRIMSON,
    }),
    buildChamferBox(0.22, 0.075, 0.20, 0.012, {
      pos: [0.11, 0.345, -0.17],
      rot: [0.22, -0.10, 0.16],
      tint: TINT_ARMOR_CRIMSON,
    }),
    // Rear heavy helmet occiput armor shell
    buildArmoredFrustum(0.42, 0.28, 0.36, 0.24, 0.28, 0.02, 0, {
      pos: [0, 0.26, 0.12],
      tint: TINT_ARMOR_MAIN,
    }),
    // Angular armored lower jaw / muzzle breathing grille block
    buildArmoredFrustum(0.30, 0.28, 0.36, 0.32, 0.15, -0.04, 0, {
      pos: [0, 0.12, -0.09],
      tint: TINT_ARMOR_MAIN,
    }),
    buildChamferBox(0.18, 0.085, 0.14, 0.014, { pos: [0, 0.11, -0.22], tint: TINT_ARMOR_LIGHT }),
    // Swept-back tactical commander sensor crest fin reaching local y = +0.62 (world y = 4.10m!)
    buildSlopedPlate(
      [
        [-0.20, 0.0],
        [0.14, 0.0],
        [0.20, 0.15],
        [-0.08, 0.18],
      ],
      0.08,
      0.014,
      {
        pos: [0, 0.44, 0.04],
        rot: [0, Math.PI * 0.5, 0],
        tint: TINT_ARMOR_CRIMSON,
      },
    ),
  );

  // Angled side cheek-mandible guards & ear sensor rangefinders
  for (const s of [-1, 1] as const) {
    armor.push(
      buildChamferBox(0.10, 0.22, 0.36, 0.018, {
        pos: [s * 0.21, 0.22, -0.02],
        rot: [0.06, s * -0.14, s * 0.10],
        tint: TINT_ARMOR_MAIN,
      }),
    );
    frame.push(
      buildCylinder(0.072, 0.072, 0.10, 10, {
        pos: [s * 0.25, 0.26, 0.04],
        rot: [0, 0, Math.PI * 0.5],
        tint: TINT_FRAME_MID,
      }),
      ...(s === 1
        ? [
            buildCylinder(0.014, 0.022, 0.22, 6, {
              pos: [0.25, 0.42, 0.08],
              rot: [-0.18, 0, -0.08],
              tint: TINT_FRAME_MID,
            }),
          ]
        : []),
    );
  }

  // Deep-set precision optical Mono-Eye Sensor Lens inside recessed visor cavity (with metallic camera bezel!)
  const lensSphere = new THREE.SphereGeometry(0.052, 12, 10);
  lensSphere.scale(1.0, 0.94, 0.62);
  lensSphere.translate(0, 0, -0.194);
  const monoEye = mergeStrict([
    finalizePart(lensSphere, { faceted: false, band: UV_BAND_ENERGY, tint: [1, 1, 1] }),
    // Tight precision laser-rangefinder optical slit flanking the cyclops lens
    buildChamferBox(0.15, 0.020, 0.028, 0.004, {
      pos: [0, 0, -0.182],
      tint: [0.78, 0.78, 0.78],
      band: UV_BAND_ENERGY,
    }),
  ]);
  // Precision optical housing bezel collar mounted on monoEye pivot so it tracks with the lens!
  const monoEyeBezel = buildCylinder(0.068, 0.072, 0.045, 12, {
    pos: [0, 0, -0.184],
    rot: [Math.PI * 0.5, 0, 0],
    tint: TINT_FRAME_MID,
  });

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    monoEye,
    monoEyeBezel,
  };
}

/** Asymmetric sweeping heavy shoulder pauldrons tucked seamlessly over shoulder drums! */
function buildShoulderPauldron(side: -1 | 1): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  vent: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];
  const vent: THREE.BufferGeometry[] = [];

  // Heavy internal rotary linkage drum & mounting yoke
  frame.push(
    buildCylinder(0.20, 0.20, 0.28, 12, {
      pos: [side * 0.04, 0.0, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_DARK,
    }),
    buildChamferBox(0.36, 0.20, 0.52, 0.020, {
      pos: [side * 0.14, 0.16, 0],
      rot: [0, 0, side * -0.18],
      tint: TINT_FRAME_MID,
    }),
  );

  if (side === -1) {
    // LEFT SHOULDER: Massive Multi-Faceted Aegis Fortress Buckler-Shield Pauldron (tightly nested!)
    armor.push(
      // Sweeping deep-gunmetal armored shoulder hood wrapping seamlessly over shoulder drum
      buildArmoredFrustum(0.58, 0.80, 0.46, 0.66, 0.46, 0, -0.06, {
        pos: [-0.14, 0.18, 0],
        rot: [0, 0, 0.20],
        tint: TINT_ARMOR_MAIN,
      }),
      // Cold titanium upper armored cap
      buildChamferBox(0.44, 0.14, 0.64, 0.026, {
        pos: [-0.14, 0.40, 0],
        rot: [0, 0, 0.26],
        tint: TINT_ARMOR_LIGHT,
      }),
      // Tall angled fortress buckler riot-shield slab bolted tightly to outer pauldron
      buildSlopedPlate(
        [
          [-0.38, -0.44],
          [0.38, -0.44],
          [0.30, 0.48],
          [-0.30, 0.48],
        ],
        0.15,
        0.026,
        {
          pos: [-0.42, 0.02, 0],
          rot: [0, Math.PI * 0.5, 0.14],
          tint: TINT_ARMOR_LIGHT,
        },
      ),
      // Matte crimson-oxide command stripe boss down center of shield
      buildChamferBox(0.09, 0.56, 0.30, 0.018, {
        pos: [-0.49, 0.04, 0],
        rot: [0, 0, 0.14],
        tint: TINT_ARMOR_CRIMSON,
      }),
      // Bolted ERA reactive dark gunmetal edge guards
      buildChamferBox(0.09, 0.20, 0.52, 0.016, {
        pos: [-0.48, 0.34, 0],
        rot: [0, 0, 0.14],
        tint: TINT_ARMOR_DARK,
      }),
      // Caution hazard band across lower shield lip
      buildChamferBox(0.09, 0.12, 0.60, 0.012, {
        pos: [-0.47, -0.28, 0],
        rot: [0, 0, 0.14],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 1.0,
      }),
    );
    // Heavy steel mounting struts + hydraulic shock arms bolting shield onto pauldron
    frame.push(
      buildChamferBox(0.24, 0.12, 0.18, 0.014, { pos: [-0.30, 0.16, -0.18], tint: TINT_FRAME_MID }),
      buildChamferBox(0.24, 0.12, 0.18, 0.014, { pos: [-0.30, 0.16, 0.18], tint: TINT_FRAME_MID }),
      ...buildLouverBank(0.24, 0.18, 0.08, 3, [-0.18, 0.20, -0.38], [0, 0, 0.20], TINT_FRAME_MID),
      ...buildLouverBank(0.24, 0.18, 0.08, 3, [-0.18, 0.20, 0.38], [0, 0, 0.20], TINT_FRAME_MID),
    );
    vent.push(
      buildChamferBox(0.20, 0.14, 0.05, 0.008, { pos: [-0.18, 0.20, -0.35], rot: [0, 0, 0.20], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
      buildChamferBox(0.20, 0.14, 0.05, 0.008, { pos: [-0.18, 0.20, 0.35], rot: [0, 0, 0.20], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
    );
  } else {
    // RIGHT SHOULDER: Swept High-Clearance Blade-Vanguard Pauldron (tightly nested!)
    armor.push(
      buildArmoredFrustum(0.60, 0.76, 0.46, 0.62, 0.42, 0, 0.08, {
        pos: [0.14, 0.16, 0],
        rot: [0, 0, -0.24],
        tint: TINT_ARMOR_MAIN,
      }),
      // Swept crimson-oxide upper vanguard ridge
      buildChamferBox(0.46, 0.14, 0.58, 0.024, {
        pos: [0.18, 0.37, 0],
        rot: [0, 0, -0.30],
        tint: TINT_ARMOR_CRIMSON,
      }),
      // Angled titanium outer shoulder winglet fairing (clear of high blade arc!)
      buildSlopedPlate(
        [
          [-0.30, -0.26],
          [0.30, -0.26],
          [0.24, 0.26],
          [-0.24, 0.26],
        ],
        0.14,
        0.024,
        {
          pos: [0.42, 0.00, 0],
          rot: [0, Math.PI * 0.5, -0.40],
          tint: TINT_ARMOR_LIGHT,
        },
      ),
      buildChamferBox(0.28, 0.10, 0.52, 0.012, {
        pos: [0.40, 0.20, 0],
        rot: [0, 0, -0.32],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 0.9,
      }),
    );
    frame.push(
      ...buildHydraulicPiston([0.04, 0.32, -0.22], [0.40, 0.12, -0.24], 0.042, 0.024, TINT_PISTON_BRASS),
      ...buildHydraulicPiston([0.04, 0.32, 0.22], [0.40, 0.12, 0.24], 0.042, 0.024, TINT_PISTON_BRASS),
      ...buildLouverBank(0.22, 0.16, 0.08, 3, [0.18, 0.18, -0.36], [0, 0, -0.24], TINT_FRAME_MID),
      ...buildLouverBank(0.22, 0.16, 0.08, 3, [0.18, 0.18, 0.36], [0, 0, -0.24], TINT_FRAME_MID),
    );
    vent.push(
      buildChamferBox(0.20, 0.13, 0.05, 0.008, { pos: [0.18, 0.18, -0.33], rot: [0, 0, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
      buildChamferBox(0.20, 0.13, 0.05, 0.008, { pos: [0.18, 0.18, 0.33], rot: [0, 0, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
    );
  }

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent),
  };
}

function buildUpperArmParts(side: -1 | 1): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];

  frame.push(
    buildCylinder(0.145, 0.135, 0.78, 12, { pos: [side * 0.05, -0.39, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston(
      [side * 0.04, -0.06, -0.16],
      [side * 0.08, -0.70, -0.14],
      0.048,
      0.028,
      TINT_PISTON_CHROME,
    ),
    ...buildHydraulicPiston(
      [side * 0.04, -0.08, 0.16],
      [side * 0.08, -0.70, 0.14],
      0.044,
      0.026,
      TINT_PISTON_BRASS,
    ),
    buildCylinder(0.17, 0.17, 0.36, 12, {
      pos: [side * 0.08, -0.78, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
    }),
  );

  // Tapered octagonal upper-arm armor sleeve
  armor.push(
    buildArmoredFrustum(0.32, 0.34, 0.38, 0.38, 0.48, 0, 0, {
      pos: [side * 0.08, -0.38, 0],
      tint: TINT_ARMOR_MAIN,
    }),
    buildChamferBox(0.10, 0.42, 0.24, 0.018, {
      pos: [side * 0.25, -0.38, 0],
      tint: TINT_ARMOR_LIGHT,
    }),
  );

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
  };
}

/** Left Forearm: Heavy Hydraulic Siege Buckler-Gauntlet + Mechanical Block Crusher Fist. */
function buildLeftForearmParts(): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  vent: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];
  const vent: THREE.BufferGeometry[] = [];

  frame.push(
    buildCylinder(0.13, 0.15, 0.72, 12, { pos: [0, -0.36, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.14, -0.06, -0.12], [-0.16, -0.68, -0.14], 0.046, 0.026, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.10, -0.06, 0.12], [0.12, -0.68, 0.12], 0.042, 0.024, TINT_PISTON_BRASS),
    buildCylinder(0.15, 0.15, 0.12, 12, { pos: [0, -0.76, 0], tint: TINT_FRAME_MID }),
  );

  armor.push(
    buildChamferBox(0.34, 0.24, 0.30, 0.024, { pos: [-0.02, -0.08, 0.14], rot: [0.22, 0, 0], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.42, 0.44, 0.36, 0.38, 0.66, 0, 0, { pos: [-0.02, -0.40, 0], tint: TINT_ARMOR_MAIN }),
    // Heavy outer forearm buckler ram-shield
    buildSlopedPlate(
      [
        [-0.24, -0.44],
        [0.24, -0.36],
        [0.24, 0.34],
        [-0.22, 0.42],
      ],
      0.12,
      0.022,
      {
        pos: [-0.24, -0.42, -0.04],
        rot: [0, Math.PI * 0.5, 0],
        tint: TINT_ARMOR_LIGHT,
      },
    ),
    buildChamferBox(0.08, 0.42, 0.18, 0.014, { pos: [-0.30, -0.42, -0.04], tint: TINT_ARMOR_CRIMSON }),
    buildChamferBox(0.42, 0.11, 0.46, 0.014, {
      pos: [-0.02, -0.66, 0],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.9,
    }),
  );

  vent.push(
    buildChamferBox(0.06, 0.26, 0.16, 0.008, {
      pos: [-0.19, -0.34, 0.14],
      tint: TINT_CORE_HOT,
      band: UV_BAND_MECH,
    }),
  );

  // Heavy Mechanical Industrial Crusher Fist (blocky metal knuckle ram + articulated finger blocks)
  armor.push(
    buildChamferBox(0.28, 0.22, 0.34, 0.022, { pos: [0, -0.88, -0.02], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.32, 0.10, 0.38, 0.016, { pos: [-0.02, -0.96, -0.04], tint: TINT_ARMOR_LIGHT }),
  );
  for (let i = 0; i < 3; i++) {
    const fz = -0.12 + i * 0.11;
    frame.push(
      buildChamferBox(0.09, 0.16, 0.085, 0.012, { pos: [-0.09, -1.04, fz], rot: [0, 0, 0.22], tint: TINT_FRAME_MID }),
      buildChamferBox(0.085, 0.14, 0.080, 0.010, { pos: [-0.02, -1.14, fz], rot: [0, 0, 0.85], tint: TINT_FRAME_DARK }),
    );
  }
  frame.push(
    buildChamferBox(0.11, 0.15, 0.10, 0.014, { pos: [0.11, -0.96, -0.16], rot: [0.30, 0, -0.45], tint: TINT_FRAME_MID }),
    buildChamferBox(0.09, 0.12, 0.09, 0.010, { pos: [0.06, -1.06, -0.20], rot: [0.45, 0, -0.95], tint: TINT_FRAME_DARK }),
  );

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent),
  };
}

/** Right Forearm: Sleek Twin-Rail Plasma Emitter Gauntlet + Razor-Edged 1.50m Thermal Energy Blade! */
function buildRightForearmAndBladeParts(): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  vent: THREE.BufferGeometry;
  bladeSpine: THREE.BufferGeometry;
  bladePlasma: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];
  const vent: THREE.BufferGeometry[] = [];

  frame.push(
    buildCylinder(0.14, 0.16, 0.78, 12, { pos: [0, -0.39, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([0.16, -0.06, 0.12], [0.18, -0.74, 0.12], 0.048, 0.028, TINT_PISTON_BRASS),
    ...buildHydraulicPiston([-0.12, -0.08, -0.10], [-0.14, -0.72, -0.12], 0.044, 0.026, TINT_PISTON_CHROME),
    buildArmoredConduit(
      [
        [0.14, -0.04, 0.16],
        [0.24, -0.26, 0.18],
        [0.22, -0.52, 0.02],
        [0.16, -0.72, -0.16],
      ],
      0.038,
      10,
      7,
      TINT_FRAME_DARK,
    ),
  );

  armor.push(
    buildChamferBox(0.36, 0.28, 0.34, 0.026, { pos: [0.02, -0.08, 0.14], rot: [0.20, 0, 0], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.44, 0.48, 0.38, 0.40, 0.74, -0.02, 0, { pos: [0.02, -0.42, -0.02], tint: TINT_ARMOR_MAIN }),
    // Sleek crimson-oxide + titanium emitter cowling plates
    buildChamferBox(0.13, 0.64, 0.36, 0.022, { pos: [0.22, -0.44, -0.04], tint: TINT_ARMOR_CRIMSON }),
    buildChamferBox(0.28, 0.48, 0.10, 0.018, { pos: [0.02, -0.36, -0.25], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.44, 0.11, 0.50, 0.014, {
      pos: [0.02, -0.73, -0.04],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.9,
    }),
  );

  frame.push(
    ...buildLouverBank(0.08, 0.34, 0.18, 5, [0.24, -0.42, 0.12], [0, 0, 0], TINT_FRAME_MID),
  );
  vent.push(
    buildChamferBox(0.06, 0.34, 0.16, 0.008, { pos: [0.20, -0.42, 0.12], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
    buildChamferBox(0.20, 0.14, 0.06, 0.008, { pos: [0.02, -0.58, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_ENERGY }),
  );

  // --- Separate `rightBlade` Assembly: Sleek Armored Emitter Hilt + 1.54m Razor Thermal Cleaver ---
  const spineParts: THREE.BufferGeometry[] = [
    // Tapered emitter muzzle housing clamping the plasma blade root
    buildChamferBox(0.24, 0.24, 0.30, 0.022, { pos: [0, -0.04, 0.02], tint: TINT_ARMOR_DARK }),
    // Forward & rear angular emitter focus prongs
    buildChamferBox(0.14, 0.30, 0.09, 0.014, { pos: [0, -0.22, 0.10], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.12, 0.20, 0.08, 0.012, { pos: [0, -0.16, -0.12], tint: TINT_ARMOR_CRIMSON }),
    // Sleek notched dark-gunmetal mechanical blade spine extending cleanly down back edge
    buildChamferBox(0.056, 1.24, 0.075, 0.010, { pos: [0, -0.66, 0.06], tint: TINT_ARMOR_MAIN }),
    // 4 sharp cooling fin teeth along mechanical blade spine
    buildChamferBox(0.082, 0.10, 0.05, 0.008, { pos: [0, -0.40, 0.10], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.082, 0.10, 0.05, 0.008, { pos: [0, -0.64, 0.10], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.078, 0.10, 0.05, 0.008, { pos: [0, -0.88, 0.10], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.070, 0.09, 0.04, 0.007, { pos: [0, -1.10, 0.09], tint: TINT_ARMOR_LIGHT }),
    // Twin slim machined brass plasma containment rails flanking blade spine
    buildCylinder(0.013, 0.010, 1.02, 8, { pos: [0.036, -0.58, 0.02], tint: TINT_PISTON_BRASS }),
    buildCylinder(0.013, 0.010, 1.02, 8, { pos: [-0.036, -0.58, 0.02], tint: TINT_PISTON_BRASS }),
  ];

  // Sleek, razor-chisel 1.54m double-beveled thermal plasma cleaver-sword!
  const bladePlasma = buildPlasmaBladeGeometry(1.54, 0.21, 0.030);

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent),
    bladeSpine: mergeStrict(spineParts),
    bladePlasma,
  };
}

function buildPelvisParts(): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];

  frame.push(
    buildCylinder(0.17, 0.17, 1.12, 12, {
      pos: [0, -0.04, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_DARK,
    }),
    buildChamferBox(0.72, 0.28, 0.52, 0.024, { pos: [0, 0.04, 0], tint: TINT_FRAME_DARK }),
  );

  // Sloped angular armored groin prow & crimson command crest + mechanical bustle
  armor.push(
    buildArmoredFrustum(0.32, 0.38, 0.44, 0.48, 0.44, -0.06, 0, { pos: [0, -0.04, -0.14], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.28, 0.26, 0.14, 0.022, { pos: [0, 0.02, -0.36], rot: [0.18, 0, 0], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.22, 0.08, 0.10, 0.010, {
      pos: [0, -0.16, -0.35],
      rot: [0.18, 0, 0],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.7,
    }),
    // Rear heavy armored bustle bumper (pure hard-surface mech, zero tail)
    buildArmoredFrustum(0.46, 0.34, 0.58, 0.38, 0.36, 0.06, 0, { pos: [0, 0.02, 0.26], tint: TINT_ARMOR_DARK }),
    buildChamferBox(0.40, 0.14, 0.14, 0.020, { pos: [0, 0.10, 0.44], rot: [-0.16, 0, 0], tint: TINT_ARMOR_LIGHT }),
  );

  // Swept angular armored waist skirts angled clear of forward thigh articulation (zero clipping!)
  for (const s of [-1, 1] as const) {
    armor.push(
      buildSlopedPlate(
        [
          [-0.17, -0.18],
          [0.17, -0.14],
          [0.16, 0.18],
          [-0.16, 0.18],
        ],
        0.10,
        0.018,
        {
          pos: [s * 0.42, -0.01, -0.39],
          rot: [-0.36, s * 0.20, s * -0.12],
          tint: TINT_ARMOR_MAIN,
        },
      ),
      buildChamferBox(0.14, 0.40, 0.52, 0.022, {
        pos: [s * 0.64, -0.01, 0.02],
        rot: [0, 0, s * -0.22],
        tint: TINT_ARMOR_TRIM,
      }),
      buildChamferBox(0.32, 0.36, 0.11, 0.020, {
        pos: [s * 0.38, -0.04, 0.37],
        rot: [0.24, s * -0.14, s * -0.08],
        tint: TINT_ARMOR_MAIN,
      }),
    );
  }

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
  };
}

function buildThighParts(side: -1 | 1): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
} {
  // Mounted at hips (side * 0.47, -0.04, 0) -> world y = 1.92 down to knee at local y = -0.88 (world y = 1.04)
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];

  frame.push(
    buildCylinder(0.16, 0.15, 0.86, 12, { pos: [0, -0.44, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([0, -0.06, -0.22], [0, -0.80, -0.20], 0.054, 0.030, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, -0.08, 0.22], [0, -0.80, 0.20], 0.052, 0.030, TINT_PISTON_BRASS),
    // Prominent rotary knee hub drum
    buildCylinder(0.19, 0.19, 0.46, 14, {
      pos: [0, -THIGH_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
    }),
    buildCylinder(0.11, 0.12, 0.52, 10, {
      pos: [0, -THIGH_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_PISTON_BRASS,
    }),
  );

  // Sculpted tapered octagonal armored thigh housing (thick at hip, tapering sleekly toward knee!)
  armor.push(
    buildArmoredFrustum(0.36, 0.38, 0.48, 0.50, 0.72, -0.05, side * 0.04, {
      pos: [0, -0.42, -0.02],
      tint: TINT_ARMOR_MAIN,
    }),
    // High-contrast cold titanium sloped front thigh glacis
    buildChamferBox(0.30, 0.54, 0.14, 0.024, {
      pos: [0, -0.42, -0.25],
      rot: [-0.10, 0, 0],
      tint: TINT_ARMOR_LIGHT,
    }),
    // Outer armored thigh shield plate with crimson trim stripe
    buildChamferBox(0.14, 0.60, 0.42, 0.024, {
      pos: [side * 0.24, -0.44, 0.02],
      rot: [0, 0, side * -0.10],
      tint: TINT_ARMOR_TRIM,
    }),
    buildChamferBox(0.08, 0.32, 0.22, 0.014, {
      pos: [side * 0.29, -0.34, 0.02],
      rot: [0, 0, side * -0.10],
      tint: TINT_ARMOR_CRIMSON,
    }),
    buildChamferBox(0.34, 0.56, 0.14, 0.022, {
      pos: [0, -0.42, 0.22],
      tint: TINT_ARMOR_DARK,
    }),
  );

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
  };
}

function buildShinParts(side: -1 | 1): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  vent: THREE.BufferGeometry;
} {
  // Mounted at thigh (0, -0.88, 0) -> world y = 1.04 down to ankle at local y = -0.80 (world y = 0.24)
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];
  const vent: THREE.BufferGeometry[] = [];

  frame.push(
    buildCylinder(0.15, 0.14, 0.78, 12, { pos: [0, -0.40, 0.02], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([side * 0.24, -0.04, 0.04], [side * 0.27, -0.74, 0.02], 0.050, 0.028, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, -0.10, 0.28], [0, -0.76, 0.22], 0.058, 0.034, TINT_PISTON_BRASS),
    buildCylinder(0.155, 0.155, 0.44, 12, {
      pos: [0, -SHIN_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
    }),
  );

  // Aggressive protruding double-beveled Heavy Knee-Breaker Prow Shield (cold titanium + crimson boss!)
  armor.push(
    buildSlopedPlate(
      [
        [-0.20, -0.20],
        [0.20, -0.20],
        [0.26, 0.08],
        [0.14, 0.28],
        [-0.14, 0.28],
        [-0.26, 0.08],
      ],
      0.16,
      0.026,
      {
        pos: [0, 0.04, -0.28],
        rot: [0.16, 0, 0],
        tint: TINT_ARMOR_LIGHT,
      },
    ),
    buildChamferBox(0.22, 0.16, 0.10, 0.016, { pos: [0, 0.06, -0.36], rot: [0.16, 0, 0], tint: TINT_ARMOR_CRIMSON }),
  );

  // Iconic Bell-Flared Armored Heavy Siege Greave (narrow at knee, flaring dramatically wide over ankle!)
  armor.push(
    buildArmoredFrustum(0.54, 0.54, 0.36, 0.38, 0.66, 0.06, side * -0.04, {
      pos: [0, -0.45, -0.03],
      tint: TINT_ARMOR_MAIN,
    }),
    // Sloped forward titanium shin glacis apron
    buildSlopedPlate(
      [
        [-0.22, -0.28],
        [0.22, -0.28],
        [0.15, 0.28],
        [-0.15, 0.28],
      ],
      0.14,
      0.024,
      {
        pos: [0, -0.44, -0.26],
        rot: [0.14, 0, 0],
        tint: TINT_ARMOR_LIGHT,
      },
    ),
    // Weathered hazard band across flared ankle cuff
    buildChamferBox(0.52, 0.10, 0.52, 0.014, {
      pos: [0, -0.68, -0.04],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 1.0,
    }),
    // Angled outer calf thruster housing
    buildChamferBox(0.14, 0.46, 0.38, 0.022, {
      pos: [side * 0.28, -0.42, 0.10],
      rot: [0, 0, side * -0.14],
      tint: TINT_ARMOR_TRIM,
    }),
    // Heavy rear calf armored bumper shroud
    buildChamferBox(0.38, 0.44, 0.16, 0.022, {
      pos: [0, -0.38, 0.28],
      rot: [-0.14, 0, 0],
      tint: TINT_ARMOR_DARK,
    }),
  );

  // Rear calf thermal exhaust vent (subtle in P1, glows bright orange in P2!)
  frame.push(
    ...buildLouverBank(0.24, 0.22, 0.07, 4, [0, -0.36, 0.36], [-0.14, 0, 0], TINT_FRAME_MID),
  );
  vent.push(
    buildChamferBox(0.20, 0.20, 0.05, 0.008, {
      pos: [0, -0.36, 0.34],
      rot: [-0.14, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_MECH,
    }),
  );

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent),
  };
}

/** Wide Grounded 3-Point Heavy Armored Mech Boot strictly flush at local y = FOOT_SOLE_Y (-0.24 -> world y = 0.000). */
function buildFootParts(side: -1 | 1): {
  armor: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
} {
  const armor: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];

  frame.push(
    buildChamferBox(0.54, 0.08, 0.78, 0.012, { pos: [0, FOOT_SOLE_Y + 0.04, -0.08], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.15, 0.02, -0.14], [-0.17, -0.14, -0.34], 0.038, 0.022, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.15, 0.02, -0.14], [0.17, -0.14, -0.34], 0.038, 0.022, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, 0.02, 0.16], [0, -0.14, 0.28], 0.042, 0.024, TINT_PISTON_BRASS),
  );

  armor.push(
    buildChamferBox(0.48, 0.14, 0.46, 0.022, { pos: [0, FOOT_SOLE_Y + 0.14, -0.06], rot: [0.14, 0, 0], tint: TINT_ARMOR_MAIN }),
    // Twin wide armored mechanical front toe-clamps (strictly flush at y = -0.24!)
    buildChamferBox(0.24, 0.13, 0.38, 0.020, { pos: [-0.15, FOOT_SOLE_Y + 0.065, -0.34], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.24, 0.13, 0.38, 0.020, { pos: [0.15, FOOT_SOLE_Y + 0.065, -0.34], tint: TINT_ARMOR_LIGHT }),
    // Heavy rear armored heel anchor spur (strictly flush at y = -0.24!)
    buildChamferBox(0.40, 0.14, 0.26, 0.020, { pos: [0, FOOT_SOLE_Y + 0.07, 0.26], tint: TINT_ARMOR_DARK }),
    // Outer ankle armored fender guard
    buildChamferBox(0.11, 0.18, 0.36, 0.016, { pos: [side * 0.27, FOOT_SOLE_Y + 0.16, -0.04], tint: TINT_ARMOR_TRIM }),
  );

  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
  };
}

// ============================================================================
// Joint Pose Table & Emissive Palette Constants
// ============================================================================

interface JointPose {
  torso: Vec3Tuple;
  head: Vec3Tuple;
  leftShoulder: Vec3Tuple;
  rightShoulder: Vec3Tuple;
  leftArm: Vec3Tuple;
  elbowL: Vec3Tuple;
  rightArm: Vec3Tuple;
  elbowR: Vec3Tuple;
  hips: Vec3Tuple;
  thighL: Vec3Tuple;
  shinL: Vec3Tuple;
  footL: Vec3Tuple;
  thighR: Vec3Tuple;
  shinR: Vec3Tuple;
  footR: Vec3Tuple;
}

function makeNeutralPose(): JointPose {
  return {
    torso: [0, 0, 0],
    head: [0, 0, 0],
    leftShoulder: [0, 0, 0],
    rightShoulder: [0, 0, 0],
    leftArm: [0, 0, 0],
    elbowL: [0, 0, 0],
    rightArm: [0, 0, 0],
    elbowR: [0, 0, 0],
    hips: [0, 0, 0],
    thighL: [0, 0, 0],
    shinL: [0, 0, 0],
    footL: [0, 0, 0],
    thighR: [0, 0, 0],
    shinR: [0, 0, 0],
    footR: [0, 0, 0],
  };
}

// Cohesive industrial thermal-orange / molten-amber emissive hierarchy
const SEAM_EMISSIVE_P1 = new THREE.Color('#CC4610');
const SEAM_EMISSIVE_P2 = new THREE.Color('#FF7C1C');
const CORE_EMISSIVE_P1 = new THREE.Color('#FF5212');
const CORE_EMISSIVE_P2 = new THREE.Color('#FF9B2E');
const EYE_EMISSIVE_P1 = new THREE.Color('#FF280C');
const EYE_EMISSIVE_P2 = new THREE.Color('#FF6A1C');
const BLADE_EMISSIVE_P1 = new THREE.Color('#FF6016');
const BLADE_EMISSIVE_P2 = new THREE.Color('#FFB842');

// ============================================================================
// Public Factory: createBossModel()
// ============================================================================

export function createBossModel(): BossModel {
  const atlas = createMechAtlas();
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    ownedMaterials.push(m);
    return m;
  };

  // --- Strictly 5 PBR Materials (<= 6), sharing the single procedural 512x512 mech atlas ---

  // 1. Primary Forged Rolled-Steel Military Armor (gunmetal / titanium / crimson / hazard via vertexColors)
  //    emissiveMap illuminates outer plate seam bleed ONLY during Phase 2 overload — never flashes albedo!
  const armorMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#CFD6DF'),
      map: atlas.albedoMap,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      emissive: SEAM_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 0.03,
      metalness: 0.72,
      roughness: 0.36,
      vertexColors: true,
    }),
  );

  // 2. Exposed Hydraulic Skeleton Frame & Gleaming Chrome/Brass Piston Rods
  const frameMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#C8D0DA'),
      map: atlas.albedoMap,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.80, 0.80),
      metalness: 0.88,
      roughness: 0.24,
      vertexColors: true,
    }),
  );

  // 3. Recessed Reactor Core & 3D Cooling Heat-Sink Vents (self-emissive only, zero projectiles)
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#280E05'),
      map: atlas.albedoMap,
      emissive: CORE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.38,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.75, 0.75),
      metalness: 0.25,
      roughness: 0.40,
      vertexColors: true,
    }),
  );

  // 4. Recessed Cyclops Mono-Eye Optical Sensor Lens
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#2A0503'),
      emissive: EYE_EMISSIVE_P1.clone(),
      emissiveIntensity: 2.55,
      metalness: 0.12,
      roughness: 0.18,
    }),
  );

  // 5. Superheated Forearm Thermal Energy-Blade Plasma Edge
  const bladeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#381408'),
      map: atlas.albedoMap,
      emissive: BLADE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.65,
      metalness: 0.15,
      roughness: 0.22,
      vertexColors: true,
    }),
  );

  const makeMesh = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    name: string,
    castShadow = true,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(geo), mat);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  };

  // --- Articulated Mechanical Skeleton Hierarchy ---
  const root = new THREE.Group();
  root.name = 'boss-root';

  const body = new THREE.Group();
  body.name = 'boss-body';
  body.position.set(0, BASE_HIP_Y, 0);
  root.add(body);

  // 1. Torso Chassis + Dorsal Twin Heat-Sink Towers + Overload Vent Assembly
  const torso = new THREE.Group();
  torso.name = 'boss-torso';
  body.add(torso);

  const torsoParts = buildTorsoParts();
  torso.add(makeMesh(torsoParts.armor, armorMat, 'boss-torso-armor'));
  torso.add(makeMesh(torsoParts.frame, frameMat, 'boss-torso-frame'));

  const ventGlow = new THREE.Group();
  ventGlow.name = 'boss-vent-glow';
  ventGlow.add(makeMesh(torsoParts.vent, coreMat, 'boss-torso-vents', false));
  torso.add(ventGlow);

  // 2. Recessed Front Chest & Rear Dorsal Reactor Core (weakpoint, purely self-emissive)
  const core = makeMesh(torsoParts.core, coreMat, 'boss-core', false);
  core.position.set(0, 0.96, 0);
  torso.add(core);

  // 3. Armored Mono-Eye Sensor Head (compact lethal proportions, world y ~3.43..4.10m!)
  const head = new THREE.Group();
  head.name = 'boss-head';
  head.position.set(0, 1.52, -0.12);
  torso.add(head);

  const headParts = buildHeadParts();
  head.add(makeMesh(headParts.armor, armorMat, 'boss-head-armor'));
  head.add(makeMesh(headParts.frame, frameMat, 'boss-head-frame'));

  const monoEye = new THREE.Group();
  monoEye.name = 'boss-mono-eye';
  monoEye.position.set(0, 0.26, -0.03);
  monoEye.add(makeMesh(headParts.monoEyeBezel, frameMat, 'boss-mono-eye-bezel', false));
  monoEye.add(makeMesh(headParts.monoEye, eyeMat, 'boss-mono-eye-lens', false));
  head.add(monoEye);

  // 4. Asymmetric Articulated Heavy Shoulder Pauldrons (tightly nested over shoulder drums!)
  const leftShoulder = new THREE.Group();
  leftShoulder.name = 'boss-pauldron-l';
  leftShoulder.position.set(-0.82, 1.28, 0);
  torso.add(leftShoulder);
  const pauldronL = buildShoulderPauldron(-1);
  leftShoulder.add(makeMesh(pauldronL.armor, armorMat, 'boss-pauldron-armor-l'));
  leftShoulder.add(makeMesh(pauldronL.frame, frameMat, 'boss-pauldron-frame-l'));
  leftShoulder.add(makeMesh(pauldronL.vent, coreMat, 'boss-pauldron-vent-l', false));

  const rightShoulder = new THREE.Group();
  rightShoulder.name = 'boss-pauldron-r';
  rightShoulder.position.set(0.82, 1.28, 0);
  torso.add(rightShoulder);
  const pauldronR = buildShoulderPauldron(1);
  rightShoulder.add(makeMesh(pauldronR.armor, armorMat, 'boss-pauldron-armor-r'));
  rightShoulder.add(makeMesh(pauldronR.frame, frameMat, 'boss-pauldron-frame-r'));
  rightShoulder.add(makeMesh(pauldronR.vent, coreMat, 'boss-pauldron-vent-r', false));

  // 5. Left Arm: Heavy Hydraulic Siege Buckler-Gauntlet
  const leftArm = new THREE.Group();
  leftArm.name = 'boss-shoulder-l';
  leftArm.position.set(-0.92, 1.28, 0);
  torso.add(leftArm);

  const upperArmL = buildUpperArmParts(-1);
  leftArm.add(makeMesh(upperArmL.armor, armorMat, 'boss-upper-arm-armor-l'));
  leftArm.add(makeMesh(upperArmL.frame, frameMat, 'boss-upper-arm-frame-l'));

  const elbowL = new THREE.Group();
  elbowL.name = 'boss-elbow-l';
  elbowL.position.set(-0.08, -0.78, 0);
  elbowL.rotation.set(0.32, 0, 0);
  leftArm.add(elbowL);

  const foreArmL = buildLeftForearmParts();
  elbowL.add(makeMesh(foreArmL.armor, armorMat, 'boss-forearm-armor-l'));
  elbowL.add(makeMesh(foreArmL.frame, frameMat, 'boss-forearm-frame-l'));
  elbowL.add(makeMesh(foreArmL.vent, coreMat, 'boss-forearm-vent-l', false));

  // 6. Right Arm: Twin-Rail Emitter + Razor-Edged 1.50m Thermal Energy Blade
  const rightArm = new THREE.Group();
  rightArm.name = 'boss-shoulder-r';
  rightArm.position.set(0.92, 1.28, 0);
  torso.add(rightArm);

  const upperArmR = buildUpperArmParts(1);
  rightArm.add(makeMesh(upperArmR.armor, armorMat, 'boss-upper-arm-armor-r'));
  rightArm.add(makeMesh(upperArmR.frame, frameMat, 'boss-upper-arm-frame-r'));

  const elbowR = new THREE.Group();
  elbowR.name = 'boss-elbow-r';
  elbowR.position.set(0.08, -0.78, 0);
  elbowR.rotation.set(0.38, 0, 0);
  rightArm.add(elbowR);

  const foreArmR = buildRightForearmAndBladeParts();
  elbowR.add(makeMesh(foreArmR.armor, armorMat, 'boss-forearm-armor-r'));
  elbowR.add(makeMesh(foreArmR.frame, frameMat, 'boss-forearm-frame-r'));
  elbowR.add(makeMesh(foreArmR.vent, coreMat, 'boss-forearm-vent-r', false));

  const rightBlade = new THREE.Group();
  rightBlade.name = 'boss-right-blade';
  rightBlade.position.set(0.04, -0.68, -0.06);
  // Sleek inline wrist-mounted forward-downward blade angle (clears deck >0.95m, slashes edge-first!)
  rightBlade.rotation.set(0.34, 0, 0);
  rightBlade.add(makeMesh(foreArmR.bladeSpine, armorMat, 'boss-blade-spine'));
  rightBlade.add(makeMesh(foreArmR.bladePlasma, bladeMat, 'boss-blade-plasma', false));
  elbowR.add(rightBlade);

  // 7. Hips & Wide Planted Grounded Heavy Siege Legs
  const hips = new THREE.Group();
  hips.name = 'boss-hips';
  body.add(hips);

  const pelvisParts = buildPelvisParts();
  hips.add(makeMesh(pelvisParts.armor, armorMat, 'boss-pelvis-armor'));
  hips.add(makeMesh(pelvisParts.frame, frameMat, 'boss-pelvis-frame'));

  const buildLegChain = (
    side: -1 | 1,
    tag: 'l' | 'r',
  ): { thigh: THREE.Group; shin: THREE.Group; foot: THREE.Group } => {
    const thigh = new THREE.Group();
    thigh.name = `boss-thigh-${tag}`;
    thigh.position.set(side * 0.50, -0.04, 0);
    hips.add(thigh);

    const thighParts = buildThighParts(side);
    thigh.add(makeMesh(thighParts.armor, armorMat, `boss-thigh-armor-${tag}`));
    thigh.add(makeMesh(thighParts.frame, frameMat, `boss-thigh-frame-${tag}`));

    const shin = new THREE.Group();
    shin.name = `boss-shin-${tag}`;
    shin.position.set(0, -THIGH_LEN, 0);
    thigh.add(shin);

    const shinParts = buildShinParts(side);
    shin.add(makeMesh(shinParts.armor, armorMat, `boss-shin-armor-${tag}`));
    shin.add(makeMesh(shinParts.frame, frameMat, `boss-shin-frame-${tag}`));
    shin.add(makeMesh(shinParts.vent, coreMat, `boss-shin-vent-${tag}`, false));

    const foot = new THREE.Group();
    foot.name = `boss-foot-${tag}`;
    foot.position.set(0, -SHIN_LEN, 0);
    shin.add(foot);

    const footParts = buildFootParts(side);
    foot.add(makeMesh(footParts.armor, armorMat, `boss-foot-armor-${tag}`));
    foot.add(makeMesh(footParts.frame, frameMat, `boss-foot-frame-${tag}`));

    return { thigh, shin, foot };
  };

  const legL = buildLegChain(-1, 'l');
  const legR = buildLegChain(1, 'r');

  // Verify neutral soles sit flush at y = 0.000
  root.updateMatrixWorld(true);
  const initBox = new THREE.Box3().setFromObject(root);
  const baseHipOffsetY = Number.isFinite(initBox.min.y) ? BASE_HIP_Y - initBox.min.y : BASE_HIP_Y;
  body.position.y = baseHipOffsetY;

  // --- Runtime Heavy Mechanical Kinematics State (zero per-frame allocations) ---
  const jointNodes: Record<keyof JointPose, THREE.Object3D> = {
    torso,
    head,
    leftShoulder,
    rightShoulder,
    leftArm,
    elbowL,
    rightArm,
    elbowR,
    hips,
    thighL: legL.thigh,
    shinL: legL.shin,
    footL: legL.foot,
    thighR: legR.thigh,
    shinR: legR.shin,
    footR: legR.foot,
  };
  const jointKeys = Object.keys(jointNodes) as (keyof JointPose)[];
  const targetPose = makeNeutralPose();
  const tmpEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  const tmpQuat = new THREE.Quaternion();

  let elapsed = 0;
  let animElapsed = 0;
  let lastAnim: BossAnim | null = null;
  let overloadHeat = 0;
  let bodyDropCur = 0;
  let bladeSurgeCur = 0;
  let monoEyeYawCur = 0;
  let disposed = false;

  const setPose = (key: keyof JointPose, x: number, y: number, z: number): void => {
    targetPose[key][0] = x;
    targetPose[key][1] = y;
    targetPose[key][2] = z;
  };

  const update = (dt: number, state: BossUpdateState): void => {
    if (disposed) return;
    const step = Math.max(0, Math.min(dt, 0.25));
    const hpPct = clamp01(state.hpPct);
    const isOverload = hpPct <= 0.35;
    const heatTarget = isOverload ? 1.0 : state.phase === 2 ? 0.32 : 0.0;

    if (state.anim !== lastAnim) {
      lastAnim = state.anim;
      animElapsed = 0;
    }
    elapsed += step;
    animElapsed += step;

    const heatAlpha = step > 0 ? 1 - Math.exp(-6.5 * step) : 1;
    overloadHeat += (heatTarget - overloadHeat) * heatAlpha;

    let targetBodyDrop = 0;
    let slerpRate = 18;
    let targetBladeSurge = 0;
    let coreWarnMult = 1.0;
    let targetMonoEyeYaw = 0;

    // Heroic wide-planted 20-ton mech combat stance (broad braced feet, slight aggressive toe-out!)
    setPose('hips', 0, 0, 0);
    setPose('thighL', 0.08, 0.11, 0.095);
    setPose('shinL', -0.14, 0, 0);
    setPose('footL', 0.06, 0.04, -0.095);
    setPose('thighR', -0.06, -0.11, -0.095);
    setPose('shinR', -0.10, 0, 0);
    setPose('footR', 0.16, -0.04, 0.095);

    const ventFlare = overloadHeat * 0.11;
    setPose('leftShoulder', 0, 0, ventFlare);
    setPose('rightShoulder', 0, 0, -ventFlare);

    if (state.anim === 'idle') {
      // Rigid stepped servo scan + periodic pneumatic hydraulic pressure cycle
      const scanWave = steppedServoWave(elapsed * 0.32, 0.64);
      const hydroCycle = steppedServoWave(elapsed * 0.55 + 0.15, 0.52);
      const microServo = steppedServoWave(elapsed * 0.85, 0.72);

      targetBodyDrop = 0.018 * (0.5 + 0.5 * hydroCycle);
      targetMonoEyeYaw = scanWave * 0.36;

      setPose('hips', 0, scanWave * 0.02, 0);
      setPose('torso', -0.05 - 0.015 * hydroCycle, scanWave * 0.04, 0);
      setPose('head', 0.03, scanWave * 0.14, 0);

      setPose('leftShoulder', 0, 0, ventFlare + 0.02 * hydroCycle);
      setPose('rightShoulder', 0, 0, -ventFlare - 0.02 * hydroCycle);

      setPose('leftArm', 0.18 + microServo * 0.03, -0.08, 0.14);
      setPose('elbowL', 0.52 + hydroCycle * 0.04, 0, -0.06);

      // Combat-ready blade guard: forearm slightly raised & angled out so glowing blade silhouette pops!
      setPose('rightArm', 0.18 - microServo * 0.04, 0.10, -0.22);
      setPose('elbowR', 0.50 + microServo * 0.05, 0, 0.08);
      slerpRate = 16;
    } else if (state.anim === 'walk') {
      const walkFreq = 2.9 * (1 + overloadHeat * 0.14);
      const w = animElapsed * walkFreq + 0.35;
      const rawS = Math.sin(w);
      const s = Math.sign(rawS) * Math.pow(Math.abs(rawS), 0.78);
      const c = Math.cos(w);

      const impact = Math.pow(Math.max(0, -Math.cos(w * 2)), 3.2);
      const midLift = Math.max(0, Math.cos(w * 2)) * 0.018;
      // Pronounced heavy mechanical center-of-mass drop on impact (0.115m!)
      targetBodyDrop = 0.115 * impact - midLift;

      setPose('hips', 0.05 * impact, -s * 0.11, s * 0.055);
      setPose('torso', -0.12 - 0.06 * impact, s * 0.16, -s * 0.07);
      setPose('head', 0.08 + 0.05 * impact, -s * 0.12, s * 0.03);
      targetMonoEyeYaw = -s * 0.08;

      setPose('leftShoulder', -s * 0.16 - 0.06 * impact, 0, ventFlare + 0.05 * impact);
      setPose('rightShoulder', s * 0.16 - 0.06 * impact, 0, -ventFlare - 0.05 * impact);

      const kneeLiftL = Math.pow(Math.max(0, -c), 0.75);
      const kneeLiftR = Math.pow(Math.max(0, c), 0.75);

      setPose('thighL', s * 0.48 + 0.06, 0.05, 0.07);
      setPose('shinL', -0.14 - kneeLiftL * 0.56 - impact * 0.14, 0, 0);
      setPose('footL', -s * 0.24 + 0.08 + impact * 0.08, 0, -0.07);

      setPose('thighR', -s * 0.48 + 0.06, -0.05, -0.07);
      setPose('shinR', -0.14 - kneeLiftR * 0.56 - impact * 0.14, 0, 0);
      setPose('footR', s * 0.24 + 0.08 + impact * 0.08, 0, 0.07);

      setPose('leftArm', -s * 0.44 + 0.18, -0.08, 0.18);
      setPose('elbowL', 0.52 + Math.max(0, -s) * 0.18, 0, -0.05);

      setPose('rightArm', s * 0.46 + 0.16, 0.08, -0.24);
      setPose('elbowR', 0.46 + Math.max(0, s) * 0.18, 0, 0.06);
      slerpRate = 20;
    } else if (state.anim === 'windup') {
      // Crisp hydraulic cock-back into rigid clamp lock
      const cock = mechSnap(animElapsed / 0.28, 3.0);
      const clampShudder = animElapsed > 0.28 ? Math.sin(animElapsed * 44) * 0.008 : 0;

      coreWarnMult = 1.44;
      targetBladeSurge = 0.76 * cock;
      targetBodyDrop = 0.048 * cock;
      targetMonoEyeYaw = 0.16 * cock;

      setPose('hips', 0.06 * cock, -0.18 * cock, 0.04 * cock);
      setPose('torso', 0.24 * cock, -0.38 * cock, 0.08 * cock);
      setPose('head', -0.14 * cock, 0.32 * cock, -0.04 * cock);

      setPose('leftShoulder', 0.16 * cock, 0, ventFlare + 0.08 * cock);
      setPose('rightShoulder', -0.26 * cock, 0, -ventFlare - 0.18 * cock);

      setPose('leftArm', lerp(0.18, 0.64, cock), -0.18 * cock, lerp(0.14, 0.32, cock));
      setPose('elbowL', lerp(0.52, 0.86, cock), 0, -0.10);

      // High-wide right thermal blade windup
      setPose('rightArm', lerp(0.18, -1.58, cock) + clampShudder, 0.26 * cock, lerp(-0.22, -0.78, cock));
      setPose('elbowR', lerp(0.50, 0.96, cock), 0, 0.18 * cock);

      setPose('thighL', 0.26 * cock + 0.08, 0.10, 0.075);
      setPose('shinL', -0.38 * cock - 0.12, 0, 0);
      setPose('footL', 0.12 * cock + 0.04, 0, -0.075);
      setPose('thighR', -0.22 * cock - 0.06, -0.10, -0.075);
      setPose('shinR', -0.24 * cock - 0.10, 0, 0);
      setPose('footR', 0.36 * cock + 0.12, 0, 0.075);
      slerpRate = 24;
    } else if (state.anim === 'attack') {
      // Phase A (0..75ms): SHORT RIGID HYDRAULIC LOCK (coiled tension!)
      // Phase B (75..170ms): EXPLOSIVE HYDRAULIC RELEASE & DIAGONAL-HORIZONTAL CLEAVE!
      // Phase C (>170ms): HARD MECHANICAL BRAKE DETENT!
      const inLock = animElapsed < ATTACK_LOCK_SEC;
      const sweepU = inLock
        ? 0
        : mechSnap((animElapsed - ATTACK_LOCK_SEC) / ATTACK_SWEEP_SEC, 3.8);
      const lockTremor = inLock ? Math.sin(animElapsed * 95) * 0.010 : 0;

      coreWarnMult = inLock ? 1.65 : lerp(1.60, 1.20, sweepU);
      targetBladeSurge = inLock ? 1.0 : lerp(1.0, 0.78, sweepU);
      targetBodyDrop = inLock ? 0.055 : lerp(0.055, 0.13, sweepU);
      targetMonoEyeYaw = lerp(0.16, -0.22, sweepU);

      setPose('hips', lerp(0.06, -0.10, sweepU), lerp(-0.18, 0.28, sweepU), lerp(0.04, -0.06, sweepU));
      setPose('torso', lerp(0.25, -0.34, sweepU), lerp(-0.38, 0.48, sweepU), lerp(0.08, -0.11, sweepU));
      setPose('head', lerp(-0.14, 0.24, sweepU), lerp(0.32, -0.38, sweepU), lerp(-0.04, 0.06, sweepU));

      setPose('leftShoulder', lerp(0.16, -0.20, sweepU), 0, ventFlare + 0.10);
      setPose('rightShoulder', lerp(-0.28, 0.24, sweepU), 0, -ventFlare - lerp(0.20, 0.04, sweepU));

      // Left siege buckler arm whips back as mechanical counterweight
      setPose('leftArm', lerp(0.64, -0.62, sweepU), -0.18, lerp(0.32, 0.36, sweepU));
      setPose('elbowL', lerp(0.86, 0.36, sweepU), 0, -0.08);

      // Right blade arm: LOCKED at -1.58 for 75ms, then explodes forward/across with razor plasma edge leading!
      setPose(
        'rightArm',
        lerp(-1.58, 1.15, sweepU) + lockTremor,
        lerp(0.26, -0.34, sweepU),
        lerp(-0.78, -0.44, sweepU),
      );
      setPose('elbowR', lerp(0.96, 0.32, sweepU), lerp(0.0, -0.42, sweepU), lerp(0.18, 0.82, sweepU));

      setPose('thighL', lerp(0.32, 0.48, sweepU), 0.10, 0.075);
      setPose('shinL', lerp(-0.48, -0.64, sweepU), 0, 0);
      setPose('footL', lerp(0.16, 0.18, sweepU), 0, -0.075);
      setPose('thighR', lerp(-0.26, -0.34, sweepU), -0.10, -0.075);
      setPose('shinR', -0.32, 0, 0);
      setPose('footR', lerp(0.46, 0.56, sweepU), 0, 0.075);

      slerpRate = inLock ? 42 : 48;
    } else if (state.anim === 'recover') {
      const u = animElapsed < 0.14 ? 0 : mechSnap((animElapsed - 0.14) / (RECOVER_DURATION - 0.14), 2.2);
      targetBodyDrop = lerp(0.12, 0.018, u);
      targetBladeSurge = lerp(0.55, 0, u);
      targetMonoEyeYaw = lerp(-0.20, 0, u);

      setPose('hips', lerp(-0.08, 0, u), lerp(0.22, 0, u), lerp(-0.04, 0, u));
      setPose('torso', lerp(-0.30, -0.05, u), lerp(0.40, 0, u), lerp(-0.09, 0, u));
      setPose('head', lerp(0.20, 0.03, u), lerp(-0.30, 0, u), 0);

      setPose('leftShoulder', lerp(-0.16, 0, u), 0, ventFlare);
      setPose('rightShoulder', lerp(0.18, 0, u), 0, -ventFlare);

      setPose('leftArm', lerp(-0.46, 0.18, u), -0.08, lerp(0.30, 0.14, u));
      setPose('elbowL', lerp(0.36, 0.52, u), 0, -0.06);

      setPose('rightArm', lerp(0.98, 0.18, u), lerp(0.30, 0.10, u), lerp(-0.30, -0.22, u));
      setPose('elbowR', lerp(0.24, 0.50, u), lerp(0.32, 0, u), lerp(-0.20, 0.08, u));

      setPose('thighL', lerp(0.42, 0.08, u), 0.08, 0.075);
      setPose('shinL', lerp(-0.56, -0.14, u), 0, 0);
      setPose('footL', lerp(0.18, 0.06, u), 0, -0.075);
      setPose('thighR', lerp(-0.28, -0.06, u), -0.08, -0.075);
      setPose('shinR', lerp(-0.28, -0.10, u), 0, 0);
      setPose('footR', lerp(0.48, 0.16, u), 0, 0.075);
      slerpRate = 12;
    } else if (state.anim === 'charge') {
      const fwdPitch = -27 * DEG2RAD;
      const runW = animElapsed * 6.0 + 0.4;
      const rawS = Math.sin(runW);
      const s = Math.sign(rawS) * Math.pow(Math.abs(rawS), 0.78);
      const c = Math.cos(runW);
      const stomp = Math.pow(Math.max(0, -Math.cos(runW * 2)), 2.8);

      coreWarnMult = 1.38;
      targetBladeSurge = 0.68;
      targetBodyDrop = 0.055 + 0.095 * stomp;
      targetMonoEyeYaw = -s * 0.06;

      setPose('hips', -0.12, -s * 0.14, s * 0.06);
      setPose('torso', fwdPitch - 0.05 * stomp, s * 0.14 + 0.18, -s * 0.07);
      setPose('head', -0.34, -0.16 - s * 0.08, 0);

      setPose('leftShoulder', 0.20, 0, ventFlare + 0.08);
      setPose('rightShoulder', -0.24, 0, -ventFlare - 0.14);

      // Left buckler-gauntlet locked ahead as a battering ram; right thermal blade trailed back
      setPose('leftArm', 0.68 - s * 0.12, -0.24, 0.22);
      setPose('elbowL', 0.96, 0, -0.12);

      setPose('rightArm', -0.96 + s * 0.14, 0.22, -0.44);
      setPose('elbowR', 0.34, 0, 0.08);

      setPose('thighL', s * 0.62 + 0.14, 0.06, 0.07);
      setPose('shinL', -0.16 - Math.max(0, -c) * 0.70 - stomp * 0.14, 0, 0);
      setPose('footL', -s * 0.28 + 0.14, 0, -0.07);

      setPose('thighR', -s * 0.62 + 0.14, -0.06, -0.07);
      setPose('shinR', -0.16 - Math.max(0, c) * 0.70 - stomp * 0.14, 0, 0);
      setPose('footR', s * 0.28 + 0.14, 0, 0.07);
      slerpRate = 24;
    }

    const qAlpha = step > 0 ? 1 - Math.exp(-slerpRate * step) : 1;
    for (let i = 0; i < jointKeys.length; i++) {
      const key = jointKeys[i];
      const [rx, ry, rz] = targetPose[key];
      tmpEuler.set(rx, ry, rz, 'XYZ');
      tmpQuat.setFromEuler(tmpEuler);
      jointNodes[key].quaternion.slerp(tmpQuat, qAlpha);
    }

    const scalarAlpha = step > 0 ? 1 - Math.exp(-22 * step) : 1;
    bodyDropCur += (targetBodyDrop - bodyDropCur) * scalarAlpha;
    body.position.y = baseHipOffsetY - bodyDropCur;

    bladeSurgeCur += (targetBladeSurge - bladeSurgeCur) * scalarAlpha;
    monoEyeYawCur += (targetMonoEyeYaw - monoEyeYawCur) * scalarAlpha;
    monoEye.rotation.y = monoEyeYawCur;

    // --- Thermal Reactor & Phase 2 Overload (hpPct <= 0.35) ---
    // Armor base albedo NEVER flashes red! Only plate perimeter heat seams, 3D cooling vents,
    // recessed reactor core, mono-eye, and thermal plasma blade surge like an overheating machine.
    const humFreq = 3.2 + (1 - hpPct) * 1.8 + overloadHeat * 2.4;
    const hum = 0.5 + 0.5 * Math.sin(elapsed * humFreq);

    armorMat.emissive.copy(SEAM_EMISSIVE_P1).lerp(SEAM_EMISSIVE_P2, overloadHeat);
    armorMat.emissiveIntensity = 0.03 + overloadHeat * (0.92 + hum * 0.16);

    coreMat.emissive.copy(CORE_EMISSIVE_P1).lerp(CORE_EMISSIVE_P2, overloadHeat);
    coreMat.emissiveIntensity =
      (1.38 + overloadHeat * 1.45 + hum * (0.08 + overloadHeat * 0.18)) * coreWarnMult;

    eyeMat.emissive.copy(EYE_EMISSIVE_P1).lerp(EYE_EMISSIVE_P2, overloadHeat);
    eyeMat.emissiveIntensity =
      (2.55 + overloadHeat * 1.75 + hum * (0.10 + overloadHeat * 0.22)) *
      (coreWarnMult > 1.25 ? 1.18 : 1.0);

    bladeMat.emissive.copy(BLADE_EMISSIVE_P1).lerp(BLADE_EMISSIVE_P2, clamp01(overloadHeat + bladeSurgeCur * 0.45));
    bladeMat.emissiveIntensity =
      1.65 + overloadHeat * 1.65 + bladeSurgeCur * 1.15 + hum * (0.08 + overloadHeat * 0.16);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();

    const geoSet = new Set<THREE.BufferGeometry>(ownedGeometries);
    const matSet = new Set<THREE.Material>(ownedMaterials);
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) geoSet.add(obj.geometry);
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) matSet.add(m);
        } else if (obj.material) {
          matSet.add(obj.material);
        }
      }
    });
    for (const g of geoSet) g.dispose();
    for (const m of matSet) m.dispose();
    for (const t of atlas.all) t.dispose();
  };

  return {
    parts: {
      root,
      torso,
      head,
      core,
      leftArm,
      rightArm,
      leftShoulder,
      rightShoulder,
      rightBlade,
      ventGlow,
      monoEye,
    },
    update,
    dispose,
  };
}
