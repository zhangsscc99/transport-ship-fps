// Procedural CF Biochemical Mode "Red Terminator" Boss Model (红色·岩浆骨刺终结者 — zero external assets).
//
// Recognizable Features (matched to docs/reference/boss-terminator-ref.png):
//   1. Dark crimson / near-black volcanic crust skin covered in dense self-luminous orange-red
//      molten lava cracks (densest across shoulders, chest, upper back, and forearms/claws).
//   2. Exposed arched bone ribcage exoskeleton (weathered yellowed-ivory, clearly brighter than skin)
//      wrapping cleanly around the glowing molten sternum core.
//   3. Massive swept-back curved dorsal bone-spike clusters erupting from scapulae & spine —
//      twin towering inner scythe-horns, wide sweeping outer wing-scythes with ribbed bone struts,
//      and a serrated spinal ridge defining the silhouette from every angle.
//   4. Seamless articulated 6-segment long tail extending from the sacrum in an organic S-arc,
//      ending in a wicked curved blade-like bone stinger and swaying counter-phase while walking.
//   5. Broad inverted-triangle hunched shoulders with hypertrophied forearms thicker than the waist,
//      lined with heavy protruding outer forearm bone spikes and huge 4-digit (3 fingers + thumb)
//      prominent-knuckle mutated claws.
//   6. Faceless predatory head sitting proudly on a thick hunched neck, crowned by a sculpted bone
//      helmet-crest & swept horns with two blazing orange-red glowing eyes.
//
// Technical Budgets & Contracts:
//   - Purely procedural Three.js BufferGeometries + single procedural Canvas2D atlas (albedo + emissive + normal).
//   - Strictly <= 20,000 triangles (target ~15,000-18,000), <= 6 materials (4 total).
//   - Standing height 4.0-4.2m, soles flush at y = 0, facing -Z.
//   - Melee-only: chest/back core is purely self-emissive with zero projectiles.
//   - Phase 2 / molten surge (hpPct <= 0.35): magma fissures & core self-emissive intensify strongly
//     and bone spike/horn/claw/tail-blade tips glow translucently hot — NO whole-body red flashing.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type BossAnim = 'idle' | 'walk' | 'windup' | 'attack' | 'recover' | 'charge';

export interface BossUpdateState {
  hpPct: number;
  phase: 1 | 2;
  anim: BossAnim;
}

export interface BossParts {
  root: THREE.Group;        // 整体
  torso?: THREE.Object3D;   // 躯干
  head: THREE.Object3D;     // 头部（弱点）
  core: THREE.Object3D;     // 胸/背岩浆核心（弱点，纯自发光）
  leftArm: THREE.Object3D;  // 左臂肩关节
  rightArm: THREE.Object3D; // 右臂肩关节
  tail?: THREE.Object3D;    // 分节长尾根部
}

export interface BossModel {
  parts: BossParts;
  update(dt: number, state: BossUpdateState): void;
  dispose(): void;
}

// ============================================================================
// Deterministic Math & Noise Helpers
// ============================================================================

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

function gauss(d: number, sigma: number): number {
  const r = d / sigma;
  return Math.exp(-0.5 * r * r);
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

function noise3(x: number, y: number, z: number, seed = 11): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = hash3(ix, iy, iz, seed);
  const c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed);
  const c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed);
  const c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed);
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

function fbm3(x: number, y: number, z: number, seed = 11, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = x;
  let py = y;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(px, py, pz, seed + i * 29);
    norm += amp;
    px *= 2.03;
    py *= 2.03;
    pz *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

function ridged3(x: number, y: number, z: number, seed = 37, octaves = 3): number {
  let sum = 0;
  let amp = 0.55;
  let norm = 0;
  let px = x;
  let py = y;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(px, py, pz, seed + i * 31) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    px *= 2.1;
    py *= 2.1;
    pz *= 2.1;
    amp *= 0.48;
  }
  return sum / norm;
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

/** Periodic domain-warped Voronoi edge distance (F2 - F1, ~0 on volcanic fracture seams). */
function voronoiEdgeTile(
  u: number,
  v: number,
  cellsX: number,
  cellsY: number,
  seed: number,
): number {
  const gx = u * cellsX;
  const gy = v * cellsY;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let d1 = 1e9;
  let d2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const wx = ((cx % cellsX) + cellsX) % cellsX;
      const wy = ((cy % cellsY) + cellsY) % cellsY;
      const jx = 0.12 + 0.76 * hash3(wx, wy, 1, seed);
      const jy = 0.12 + 0.76 * hash3(wx, wy, 2, seed + 17);
      const px = cx + jx - gx;
      const py = cy + jy - gy;
      const dist = Math.hypot(px, py);
      if (dist < d1) {
        d2 = d1;
        d1 = dist;
      } else if (dist < d2) {
        d2 = dist;
      }
    }
  }
  return d2 - d1;
}

// ============================================================================
// Single Procedural Canvas2D Atlas (Albedo + Emissive + Normal)
//
// 4 horizontal seamless bands along v (Three.js flipY = true):
//   - Band A (Dense Organic Lava Skin): v in [0.64, 0.98] — shoulders, chest, upper back, forearms
//   - Band B (Flowing Vein Lava Skin):  v in [0.36, 0.60] — thighs, calves, pelvis, tail segments
//   - Band C (Incandescent Molten Core):v in [0.22, 0.33] — chest sternum core & dorsal lava heart
//   - Band D (Weathered Ivory Bone):    v in [0.02, 0.19] — ribs, dorsal spikes, horns, claws, tail blade
//                                       (u = 0 at root -> u = 1 at tip -> Phase 2 tip translucency!)
// ============================================================================

const UV_BAND_LAVA_DENSE: [number, number] = [0.655, 0.975];
const UV_BAND_LAVA_FLOW: [number, number] = [0.375, 0.595];
const UV_BAND_CORE: [number, number] = [0.235, 0.325];
const UV_BAND_BONE: [number, number] = [0.025, 0.185];

interface TerminatorAtlas {
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

function createTerminatorAtlas(): TerminatorAtlas {
  if (typeof document === 'undefined') {
    const albedoMap = makeFallbackTex(68, 22, 18, true);
    const emissiveMap = makeFallbackTex(190, 64, 16, true);
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

      if (v >= 0.63) {
        // --- BAND A: Dense Organic Volcanic Lava-Cracked Skin (shoulders, chest, upper back, arms) ---
        const bv = clamp01((v - 0.63) / 0.37);
        // Strong organic domain warp breaks up geometric Voronoi regularity into jagged magma rivers
        const w1 = fbm2Tile(u, bv, 5, 3, 101, 3) - 0.5;
        const w2 = fbm2Tile(u, bv, 5, 3, 137, 3) - 0.5;
        const warpU = u + w1 * 0.16;
        const warpV = bv + w2 * 0.17;

        const river1 = 1 - Math.abs(fbm2Tile(warpU, warpV, 7, 4, 211, 4) * 2 - 1);
        const river2 = 1 - Math.abs(fbm2Tile(warpU + 0.31, warpV + 0.19, 13, 7, 307, 3) * 2 - 1);
        const cellEdge = voronoiEdgeTile(warpU, warpV, 7, 4, 401);
        const clusterMask = smoothstep((fbm2Tile(u, bv, 4, 2, 463, 3) - 0.32) * 2.1);

        // Thick molten magma rivers + sharp jagged fracture veins (organic, NOT uniform honeycomb!)
        const cRiver = Math.pow(clamp01((river1 - 0.66) / 0.34), 1.55) * (0.65 + 0.35 * clusterMask);
        const cBranch = Math.pow(clamp01((river2 - 0.74) / 0.26), 1.85) * 0.80;
        const cFissure = smoothstep((0.115 - cellEdge) / 0.105) * (0.48 + 0.52 * clusterMask);
        const crack = clamp01(Math.max(cRiver, cBranch, cFissure));
        const hotCore = clamp01(
          Math.pow(clamp01((river1 - 0.85) / 0.15), 1.4) +
            smoothstep((0.048 - cellEdge) / 0.046) * 0.55 * clusterMask,
        );

        const crustMacro = fbm2Tile(u, bv, 10, 6, 509, 3);
        const muscleFibers = 0.5 + 0.5 * Math.sin((u * 18 + w1 * 5.0) * Math.PI * 2);
        height[idx] = (1 - crack) * (0.60 + crustMacro * 0.28 + muscleFibers * 0.12) + crack * 0.12;

        // Rich charred dark crimson-obsidian flesh plates (#320e0b .. #5a1913) — never flat black!
        const crustR = 46 + crustMacro * 38 + muscleFibers * 16;
        const crustG = 14 + crustMacro * 13 + muscleFibers * 5;
        const crustB = 13 + crustMacro * 10 + muscleFibers * 4;

        const r = lerp(crustR, lerp(218, 255, hotCore), crack);
        const g = lerp(crustG, lerp(58, 182, hotCore), crack);
        const b = lerp(crustB, lerp(10, 48, hotCore), crack);
        ad[p4] = Math.round(clamp(r, 14, 255));
        ad[p4 + 1] = Math.round(clamp(g, 6, 255));
        ad[p4 + 2] = Math.round(clamp(b, 6, 255));
        ad[p4 + 3] = 255;

        // Emissive strictly inside the organic magma veins & fissures (0 on cooled dark-red crust)
        const emMask = Math.pow(crack, 1.35);
        ed[p4] = Math.round(clamp01(emMask * 1.12) * 255);
        ed[p4 + 1] = Math.round(clamp01(emMask * 0.36 + hotCore * 0.56) * 255);
        ed[p4 + 2] = Math.round(clamp01(emMask * 0.04 + hotCore * 0.24) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.35) {
        // --- BAND B: Flowing Muscular Lava Skin (legs, pelvis, waist, tail segments) ---
        const bv = clamp01((v - 0.35) / 0.28);
        const w1 = fbm2Tile(u, bv, 4, 2, 701, 3) - 0.5;
        const w2 = fbm2Tile(u, bv, 4, 2, 733, 3) - 0.5;
        const warpU = u + w1 * 0.12;
        const warpV = bv + w2 * 0.10;

        // Elongated vertical glowing magma sinews following thigh/calf/tail anatomy (like reference!)
        const sinew1 = 1 - Math.abs(fbm2Tile(warpU, warpV, 9, 2, 811, 3) * 2 - 1);
        const sinew2 = voronoiEdgeTile(warpU, warpV, 9, 2, 853);
        const crack1 = Math.pow(clamp01((sinew1 - 0.72) / 0.28), 1.65);
        const crack2 = smoothstep((0.10 - sinew2) / 0.09) * 0.72;
        const crack = clamp01(Math.max(crack1, crack2));
        const hotCore = Math.pow(clamp01((sinew1 - 0.87) / 0.13), 1.4);

        const crust = fbm2Tile(u, bv, 14, 4, 907, 3);
        height[idx] = (1 - crack) * (0.64 + crust * 0.30) + crack * 0.14;

        const crustR = 44 + crust * 34;
        const crustG = 13 + crust * 11;
        const crustB = 12 + crust * 9;

        ad[p4] = Math.round(clamp(lerp(crustR, lerp(212, 255, hotCore), crack), 12, 255));
        ad[p4 + 1] = Math.round(clamp(lerp(crustG, lerp(52, 162, hotCore), crack), 6, 255));
        ad[p4 + 2] = Math.round(clamp(lerp(crustB, lerp(8, 38, hotCore), crack), 6, 255));
        ad[p4 + 3] = 255;

        const emMask = Math.pow(crack, 1.4) * 0.90;
        ed[p4] = Math.round(clamp01(emMask * 1.1) * 255);
        ed[p4 + 1] = Math.round(clamp01(emMask * 0.34 + hotCore * 0.48) * 255);
        ed[p4 + 2] = Math.round(clamp01(emMask * 0.04 + hotCore * 0.18) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.21) {
        // --- BAND C: Cracked Molten Furnace Core (charred lava plates over incandescent magma fissures!) ---
        const bv = clamp01((v - 0.21) / 0.14);
        const w1 = fbm2Tile(u, bv, 5, 3, 941, 3) - 0.5;
        const w2 = fbm2Tile(u, bv, 5, 3, 953, 3) - 0.5;
        const wu = u + w1 * 0.14;
        const wv = bv + w2 * 0.14;
        const edge = voronoiEdgeTile(wu, wv, 8, 4, 967);
        const ridge = 1 - Math.abs(fbm2Tile(wu, wv, 10, 5, 977, 3) * 2 - 1);
        const magma = clamp01(Math.max(smoothstep((0.26 - edge) / 0.20), Math.pow(clamp01((ridge - 0.52) / 0.48), 1.3)));
        const superHot = clamp01(smoothstep((0.12 - edge) / 0.10) + Math.pow(clamp01((ridge - 0.78) / 0.22), 1.4) * 0.6);
        height[idx] = (1 - magma) * 0.78 + magma * 0.16;

        // Charred dark volcanic crust fragments floating over blazing deep-orange magma (never clips to flat peach!)
        ad[p4] = Math.round(lerp(36, lerp(225, 255, superHot), magma));
        ad[p4 + 1] = Math.round(lerp(10, lerp(62, 168, superHot), magma));
        ad[p4 + 2] = Math.round(lerp(8, lerp(10, 34, superHot), magma));
        ad[p4 + 3] = 255;

        ed[p4] = Math.round(clamp01(0.18 + magma * 0.82) * 255);
        ed[p4 + 1] = Math.round(clamp01(0.04 + magma * 0.36 + superHot * 0.48) * 255);
        ed[p4 + 2] = Math.round(clamp01(magma * 0.05 + superHot * 0.20) * 255);
        ed[p4 + 3] = 255;
      } else {
        // --- BAND D: Weathered Yellowed-Ivory Bone & Striated Horn Grain ---
        // u = 0 at socket root -> u = 1 at razor tip (Phase 2 bone-tip translucency glow!)
        const bv = clamp01(v / 0.21);
        const grain = fbm2Tile(u, bv, 8, 12, 1013, 3);
        const flutes = 0.5 + 0.5 * Math.sin((bv * 14 + grain * 1.8) * Math.PI * 2);
        const growthRings = 0.5 + 0.5 * Math.sin(u * Math.PI * 12 + grain * 2.5);
        const h = grain * 0.45 + flutes * 0.35 + growthRings * 0.20;
        height[idx] = h;

        // Clean weathered yellowed-ivory bone (clearly brighter than the dark crimson volcanic skin!)
        const rootBlend = smoothstep((u - 0.01) / 0.16);
        const shade = lerp(0.78, 1.05, rootBlend) * (0.86 + h * 0.22);
        ad[p4] = Math.round(clamp(242 * shade, 135, 254));
        ad[p4 + 1] = Math.round(clamp(226 * shade, 118, 248));
        ad[p4 + 2] = Math.round(clamp(186 * shade, 88, 224));
        ad[p4 + 3] = 255;

        // Bone tip subsurface glow mask in emissiveMap:
        //   u <= 0.58 -> 0 (solid bright ivory bone shafts & exposed ribs)
        //   u >  0.58 -> smooth fiery translucent amber-orange glow peaking at spike/claw/blade tips!
        const tipGlow = Math.pow(smoothstep((u - 0.58) / 0.40), 1.45) * (0.80 + 0.20 * flutes);
        ed[p4] = Math.round(clamp01(tipGlow * 1.1) * 255);
        ed[p4 + 1] = Math.round(clamp01(tipGlow * 0.52) * 255);
        ed[p4 + 2] = Math.round(clamp01(tipGlow * 0.12) * 255);
        ed[p4 + 3] = 255;
      }
    }
  }

  albedoCtx.putImageData(albedoImg, 0, 0);
  emCtx.putImageData(emImg, 0, 0);
  const normalCanvas = buildNormalCanvasFromHeight(height, S, 4.2);

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
// Geometry Normalization, UV Band Mapping & Sculpting Primitives
// ============================================================================

type Vec3Tuple = [number, number, number];

function remapUvBand(
  geo: THREE.BufferGeometry,
  band: [number, number],
  uScale = 1.0,
  uOffset = 0.0,
): void {
  const uv = geo.getAttribute('uv');
  if (!uv) return;
  const [vMin, vMax] = band;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) * uScale + uOffset;
    const v = clamp01(uv.getY(i));
    uv.setXY(i, u, lerp(vMin, vMax, v));
  }
  uv.needsUpdate = true;
}

function normalizeForMerge(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position');
  if (!g.getAttribute('uv')) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) * 0.5 + 0.5;
      uvs[i * 2 + 1] = lerp(UV_BAND_LAVA_DENSE[0], UV_BAND_LAVA_DENSE[1], 0.5);
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

interface BlobOpts {
  scale: Vec3Tuple;
  pos?: Vec3Tuple;
  rot?: Vec3Tuple;
  segW?: number;
  segH?: number;
  noiseAmp?: number;
  noiseFreq?: number;
  ridgeAmp?: number;
  seed?: number;
  topTaper?: number;
  botTaper?: number;
  bendZ?: number;
  bendX?: number;
  tint?: Vec3Tuple;
  aoBottom?: number;
  uvBand?: [number, number];
  uScale?: number;
  uOffset?: number;
}

function sculptOrganicBlob(opts: BlobOpts): THREE.BufferGeometry {
  const segW = opts.segW ?? 12;
  const segH = opts.segH ?? 8;
  const geo = new THREE.SphereGeometry(1, segW, segH);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);

  const [sx, sy, sz] = opts.scale;
  const noiseAmp = opts.noiseAmp ?? 0.08;
  const noiseFreq = opts.noiseFreq ?? 2.3;
  const ridgeAmp = opts.ridgeAmp ?? 0.04;
  const seed = opts.seed ?? 17;
  const topTaper = opts.topTaper ?? 1.0;
  const botTaper = opts.botTaper ?? 1.0;
  const bendZ = opts.bendZ ?? 0;
  const bendX = opts.bendX ?? 0;
  const tint = opts.tint ?? [1, 1, 1];
  const aoBottom = opts.aoBottom ?? 0.18;

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x;
    const ny = v.y;
    const nz = v.z;

    const f = fbm3(nx * noiseFreq, ny * noiseFreq, nz * noiseFreq, seed, 3) - 0.5;
    const r = ridged3(nx * noiseFreq * 1.4, ny * noiseFreq * 1.4, nz * noiseFreq * 1.4, seed + 53, 2) - 0.45;
    const disp = 1 + f * noiseAmp * 2 + r * ridgeAmp * 2;

    const uY = ny * 0.5 + 0.5;
    const taper = lerp(botTaper, topTaper, uY);

    const px = nx * sx * taper * disp + bendX * (ny + 0.4 * ny * ny);
    const py = ny * sy * disp;
    const pz = nz * sz * taper * disp + bendZ * (ny + 0.4 * ny * ny);
    pos.setXYZ(i, px, py, pz);

    const heightLight = lerp(1 - aoBottom, 1.12, uY);
    const creviceAO = clamp(0.88 + f * 0.26 + r * 0.22, 0.58, 1.16);
    colors[i * 3] = clamp(tint[0] * heightLight * creviceAO, 0.28, 1.35);
    colors[i * 3 + 1] = clamp(tint[1] * heightLight * creviceAO, 0.28, 1.35);
    colors[i * 3 + 2] = clamp(tint[2] * heightLight * creviceAO, 0.28, 1.35);
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  remapUvBand(geo, opts.uvBand ?? UV_BAND_LAVA_DENSE, opts.uScale ?? 1.0, opts.uOffset ?? 0);
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

interface LimbOpts {
  length: number;
  rTop: number;
  rMid: number;
  rBot: number;
  midPos?: number;
  radialSegs?: number;
  heightSegs?: number;
  striations?: number;
  striationAmp?: number;
  noiseAmp?: number;
  seed?: number;
  bendZ?: number;
  bendX?: number;
  scaleZ?: number;
  pos?: Vec3Tuple;
  rot?: Vec3Tuple;
  tint?: Vec3Tuple;
  uvBand?: [number, number];
  uScale?: number;
}

/** Sculpted muscular limb segment spanning y = 0 (top) down to y = -length (bottom). */
function sculptMuscleLimb(opts: LimbOpts): THREE.BufferGeometry {
  const rSeg = opts.radialSegs ?? 12;
  const hSeg = opts.heightSegs ?? 8;
  const geo = new THREE.CylinderGeometry(1, 1, opts.length, rSeg, hSeg, false);
  geo.translate(0, -opts.length * 0.5, 0);

  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const midPos = opts.midPos ?? 0.45;
  const striations = opts.striations ?? 4;
  const striationAmp = opts.striationAmp ?? 0.08;
  const noiseAmp = opts.noiseAmp ?? 0.075;
  const seed = opts.seed ?? 41;
  const bendZ = opts.bendZ ?? 0;
  const bendX = opts.bendX ?? 0;
  const scaleZ = opts.scaleZ ?? 1.0;
  const tint = opts.tint ?? [1, 1, 1];

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const t = clamp01(-vy / opts.length);
    const radial = Math.hypot(vx, vz);
    const ang = Math.atan2(vz, vx);

    let baseR: number;
    if (t <= midPos) {
      baseR = lerp(opts.rTop, opts.rMid, smoothstep(t / Math.max(0.01, midPos)));
    } else {
      baseR = lerp(opts.rMid, opts.rBot, smoothstep((t - midPos) / Math.max(0.01, 1 - midPos)));
    }
    const endCap = t < 0.05 ? lerp(0.90, 1.0, t / 0.05) : t > 0.95 ? lerp(1.0, 0.88, (t - 0.95) / 0.05) : 1.0;
    const bundle = Math.sin(ang * striations + t * 1.3 + seed * 0.2) * striationAmp * Math.sin(t * Math.PI);
    const nx = Math.cos(ang);
    const nz = Math.sin(ang);
    const f = fbm3(nx * 2.2, t * 3.4, nz * 2.2, seed, 3) - 0.5;
    const radScale = baseR * endCap * (1 + bundle + f * noiseAmp * 2);

    const px = vx * radScale + bendX * Math.sin(t * Math.PI) + bendX * 0.25 * t;
    const py = vy;
    const pz = vz * radScale * scaleZ + bendZ * Math.sin(t * Math.PI) + bendZ * 0.25 * t;
    pos.setXYZ(i, px, py, pz);

    const jointAO = 0.84 + 0.22 * Math.sin(t * Math.PI * 0.86 + 0.22);
    const grooveAO = clamp(0.90 + bundle * 1.1 + f * 0.25 + (radial < 0.2 ? -0.10 : 0), 0.58, 1.15);
    const shade = jointAO * grooveAO;
    colors[i * 3] = clamp(tint[0] * shade, 0.30, 1.3);
    colors[i * 3 + 1] = clamp(tint[1] * shade, 0.30, 1.3);
    colors[i * 3 + 2] = clamp(tint[2] * shade, 0.30, 1.3);
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  remapUvBand(geo, opts.uvBand ?? UV_BAND_LAVA_DENSE, opts.uScale ?? 1.0);
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

interface HornOpts {
  length: number;
  baseR: number;
  tipR?: number;
  bendZ?: number;
  bendX?: number;
  flattenX?: number;
  radialSegs?: number;
  heightSegs?: number;
  pos?: Vec3Tuple;
  rot?: Vec3Tuple;
  baseColor?: Vec3Tuple;
  tipColor?: Vec3Tuple;
  tipGlow?: boolean;
  seed?: number;
}

/** Curved fluted weathered-ivory bone spike, forearm horn, claw, or spine blade (u = 0..1 base->tip). */
function sculptBoneSpike(opts: HornOpts): THREE.BufferGeometry {
  const rSeg = opts.radialSegs ?? 7;
  const hSeg = opts.heightSegs ?? 5;
  const tipR = opts.tipR ?? 0.008;
  const geo = new THREE.CylinderGeometry(tipR, opts.baseR, opts.length, rSeg, hSeg, false);
  geo.translate(0, opts.length * 0.5, 0);

  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const colors = new Float32Array(pos.count * 3);
  const bendZ = opts.bendZ ?? 0.14;
  const bendX = opts.bendX ?? 0;
  const flattenX = opts.flattenX ?? 0.70;
  const baseCol = opts.baseColor ?? [0.80, 0.62, 0.50];
  const tipCol = opts.tipColor ?? [1.22, 1.16, 1.00];
  const tipGlow = opts.tipGlow ?? true;
  const seed = opts.seed ?? 73;

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const t = clamp01(vy / opts.length);

    const ring = 1 + Math.sin(t * Math.PI * 5 + seed) * 0.05 * (1 - t);
    const jitter = 1 + (noise3(vx * 6, vy * 5, vz * 6, seed) - 0.5) * 0.10;
    const curve = t * t;

    const px = vx * flattenX * ring * jitter + bendX * curve;
    const py = vy;
    const pz = vz * ring * jitter + bendZ * curve;
    pos.setXYZ(i, px, py, pz);

    const uMapped = tipGlow ? t : lerp(0.08, 0.48, t);
    const vMapped = lerp(UV_BAND_BONE[0], UV_BAND_BONE[1], clamp01(uv.getX(i)));
    uv.setXY(i, uMapped, vMapped);

    const k = smoothstep(t);
    colors[i * 3] = lerp(baseCol[0], tipCol[0], k);
    colors[i * 3 + 1] = lerp(baseCol[1], tipCol[1], k);
    colors[i * 3 + 2] = lerp(baseCol[2], tipCol[2], k);
  }

  uv.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Curved tapered bone scythe-blade or arched rib extruded along a 3D CatmullRomCurve3,
 * with verified STRICTLY OUTWARD normals (CCW winding checked against radial normal!).
 */
function sculptCurvedBoneBlade(opts: {
  points: Vec3Tuple[];
  radiusStart: number;
  radiusMid: number;
  radiusEnd: number;
  midPos?: number;
  tubularSegs?: number;
  radialSegs?: number;
  bladeAspect?: number;
  tipGlow?: boolean;
  baseColor?: Vec3Tuple;
  tipColor?: Vec3Tuple;
  seed?: number;
}): THREE.BufferGeometry {
  const tubularSegs = opts.tubularSegs ?? 12;
  const radialSegs = opts.radialSegs ?? 7;
  const midPos = opts.midPos ?? 0.36;
  const aspect = opts.bladeAspect ?? 1.40;
  const tipGlow = opts.tipGlow ?? true;
  const baseCol = opts.baseColor ?? [0.78, 0.56, 0.44];
  const tipCol = opts.tipColor ?? [1.24, 1.18, 1.00];
  const seed = opts.seed ?? 97;

  const curve = new THREE.CatmullRomCurve3(opts.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));

  // Parallel-transport (Bishop) frames along the curve: zero 180-degree Frenet twists at inflection points!
  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  for (let s = 0; s <= tubularSegs; s++) {
    tangents.push(curve.getTangentAt(s / tubularSegs).normalize());
  }
  const refAxis = Math.abs(tangents[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const n0 = new THREE.Vector3().crossVectors(refAxis, tangents[0]).normalize();
  const b0 = new THREE.Vector3().crossVectors(tangents[0], n0).normalize();
  normals.push(n0);
  binormals.push(b0);
  const rotAxis = new THREE.Vector3();
  const rotQ = new THREE.Quaternion();
  for (let s = 1; s <= tubularSegs; s++) {
    const prevT = tangents[s - 1];
    const curT = tangents[s];
    const prevN = normals[s - 1];
    const dot = clamp(prevT.dot(curT), -1, 1);
    const nextN = prevN.clone();
    if (dot < 0.999999) {
      rotAxis.crossVectors(prevT, curT);
      if (rotAxis.lengthSq() > 1e-10) {
        rotAxis.normalize();
        rotQ.setFromAxisAngle(rotAxis, Math.acos(dot));
        nextN.applyQuaternion(rotQ);
      }
    }
    // Re-orthonormalize (N, B, T) so N x B = +T strictly at every ring
    nextN.addScaledVector(curT, -nextN.dot(curT)).normalize();
    const nextB = new THREE.Vector3().crossVectors(curT, nextN).normalize();
    normals.push(nextN);
    binormals.push(nextB);
  }

  const ringVerts = radialSegs + 1;
  const vertCount = (tubularSegs + 1) * ringVerts + 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);
  const indices: number[] = [];

  const pt = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();

  for (let s = 0; s <= tubularSegs; s++) {
    const t = s / tubularSegs;
    curve.getPointAt(t, pt);
    // Note: T x N = B => N x B = +T (strictly right-handed everywhere!)
    N.copy(normals[s]);
    B.copy(binormals[s]);

    let rBase: number;
    if (t <= midPos) {
      rBase = lerp(opts.radiusStart, opts.radiusMid, smoothstep(t / Math.max(0.01, midPos)));
    } else {
      rBase = lerp(opts.radiusMid, opts.radiusEnd, smoothstep((t - midPos) / Math.max(0.01, 1 - midPos)));
    }

    const uMapped = tipGlow ? t : lerp(0.08, 0.48, t);
    const colK = smoothstep(t);
    const cr = lerp(baseCol[0], tipCol[0], colK);
    const cg = lerp(baseCol[1], tipCol[1], colK);
    const cb = lerp(baseCol[2], tipCol[2], colK);

    for (let r = 0; r < ringVerts; r++) {
      const frac = r / radialSegs;
      const theta = frac * Math.PI * 2;
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      const ridgeSharp = 1 + 0.14 * Math.pow(Math.abs(cs), 3);
      const jitter = 1 + (noise3(pt.x * 4 + cs, pt.y * 4 + sn, pt.z * 4, seed) - 0.5) * 0.08;
      const rx = cs * rBase * aspect * ridgeSharp * jitter;
      const ry = sn * rBase * (1 / Math.sqrt(aspect)) * jitter;

      const idx = s * ringVerts + r;
      positions[idx * 3] = pt.x + N.x * rx + B.x * ry;
      positions[idx * 3 + 1] = pt.y + N.y * rx + B.y * ry;
      positions[idx * 3 + 2] = pt.z + N.z * rx + B.z * ry;

      uvs[idx * 2] = uMapped;
      uvs[idx * 2 + 1] = lerp(UV_BAND_BONE[0], UV_BAND_BONE[1], frac);

      colors[idx * 3] = cr;
      colors[idx * 3 + 1] = cg;
      colors[idx * 3 + 2] = cb;
    }
  }

  // With right-handed (N, B, T) where N x B = +T:
  //   a -> d is +theta (-sin*N + cos*B)
  //   a -> b is +s (+T)
  //   (d - a) x (b - a) = (-sin*N + cos*B) x T = +cos*N + sin*B = OUTWARD RADIAL NORMAL!
  for (let s = 0; s < tubularSegs; s++) {
    for (let r = 0; r < radialSegs; r++) {
      const a = s * ringVerts + r;
      const b = (s + 1) * ringVerts + r;
      const c = (s + 1) * ringVerts + r + 1;
      const d = s * ringVerts + r + 1;
      indices.push(a, d, b, b, d, c);
    }
  }

  // Outward-facing root & tip end caps
  const startCapIdx = (tubularSegs + 1) * ringVerts;
  const endCapIdx = startCapIdx + 1;
  const pStart = curve.getPointAt(0);
  const pEnd = curve.getPointAt(1);
  positions[startCapIdx * 3] = pStart.x;
  positions[startCapIdx * 3 + 1] = pStart.y;
  positions[startCapIdx * 3 + 2] = pStart.z;
  uvs[startCapIdx * 2] = tipGlow ? 0 : 0.08;
  uvs[startCapIdx * 2 + 1] = (UV_BAND_BONE[0] + UV_BAND_BONE[1]) * 0.5;
  colors[startCapIdx * 3] = baseCol[0];
  colors[startCapIdx * 3 + 1] = baseCol[1];
  colors[startCapIdx * 3 + 2] = baseCol[2];

  positions[endCapIdx * 3] = pEnd.x;
  positions[endCapIdx * 3 + 1] = pEnd.y;
  positions[endCapIdx * 3 + 2] = pEnd.z;
  uvs[endCapIdx * 2] = tipGlow ? 1 : 0.48;
  uvs[endCapIdx * 2 + 1] = (UV_BAND_BONE[0] + UV_BAND_BONE[1]) * 0.5;
  colors[endCapIdx * 3] = tipCol[0];
  colors[endCapIdx * 3 + 1] = tipCol[1];
  colors[endCapIdx * 3 + 2] = tipCol[2];

  for (let r = 0; r < radialSegs; r++) {
    // Root cap normal points -T -> (start, r, r+1) gives N x B = +T, so reverse to (start, r+1, r)
    indices.push(startCapIdx, r, r + 1);
    const lastRing = tubularSegs * ringVerts;
    indices.push(endCapIdx, lastRing + r + 1, lastRing + r);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ============================================================================
// Anatomical Body-Part Builders (CF Red Terminator Silhouette)
// ============================================================================

/**
 * Unified sculpted inverted-triangle hunched Terminator trunk:
 *   - Narrow taut waist (half-width 0.34m) -> broad angular pectoral chest & shoulders (half-width 0.84m)
 *   - Predatory forward hunch along upper spine & chest
 *   - Carved anterior sternum V-cavity cradling the recessed molten lava core inside the bone ribs
 */
function sculptTerminatorTrunk(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 28, 22);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const colors = new Float32Array(pos.count * 3);

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x;
    const ny = v.y; // -1 (hip waist) .. +1 (upper trapezius)
    const nz = v.z; // -1 (chest front) .. +1 (dorsal back)
    const uY = ny * 0.5 + 0.5;

    let py = lerp(-0.04, 1.54, uY);

    // Athletic demonic V-taper: sleek narrow waist -> broad flaring chest/shoulders
    const vFlare = smoothstep((uY - 0.16) / 0.54);
    const topClose = 1 - 0.38 * smoothstep((uY - 0.78) / 0.22);
    const halfWidth = lerp(0.34, 0.84, vFlare) * topClose;

    const halfDepth = lerp(0.26, 0.44, smoothstep((uY - 0.16) / 0.52));

    let px = nx * halfWidth;
    let pz = nz * halfDepth;

    // Forward hunched upper torso & arched upper back
    pz += -0.14 * smoothstep((uY - 0.44) / 0.56) + 0.14 * smoothstep((uY - 0.54) / 0.46) * smoothstep((nz - 0.05) / 0.7);

    const frontMask = smoothstep((-nz - 0.05) / 0.65);
    const backMask = smoothstep((nz - 0.05) / 0.65);
    const absX = Math.abs(nx);

    // 1. Sculpted broad pectoral muscle plates + upper clavicle shelf
    const pec = gauss(uY - 0.68, 0.13) * smoothstep((absX - 0.14) / 0.26) * frontMask;
    const clavicle = gauss(uY - 0.83, 0.05) * smoothstep((absX - 0.10) / 0.28) * frontMask;
    pz -= pec * 0.11 + clavicle * 0.045;
    py += pec * 0.025;

    // 2. Flared latissimus wings tapering smoothly into narrow waist
    const lat = gauss(uY - 0.56, 0.17) * gauss(absX - 0.76, 0.24) * (0.35 + 0.65 * backMask);
    px += Math.sign(nx) * lat * 0.12;
    pz += lat * 0.06 * backMask;

    // 3. Hunched trapezius neck collar
    const trap = smoothstep((uY - 0.66) / 0.32) * (0.4 + 0.6 * backMask);
    py += trap * 0.10;
    pz += trap * 0.08 * backMask;

    // 4. Segmented armored abdomen plates
    const abBand = gauss(uY - 0.27, 0.16) * frontMask * (1 - smoothstep((absX - 0.45) / 0.3));
    pz -= Math.sin(uY * 34) * 0.020 * abBand;

    // 5. Recessed anterior chest core cavity (core glows FROM INSIDE behind the pale curved ribs!)
    const chestCavDist = Math.hypot(px / 0.34, (py - 0.94) / 0.34);
    const chestCav = chestCavDist < 1.0 ? smoothstep(1 - chestCavDist) * frontMask : 0;
    pz += chestCav * 0.16;

    const backCavDist = Math.hypot(px / 0.24, (py - 1.02) / 0.34);
    const backCav = backCavDist < 1.0 ? smoothstep(1 - backCavDist) * backMask : 0;
    pz -= backCav * 0.12;

    // 6. Angular volcanic crust displacement
    const f = fbm3(px * 2.5, py * 2.5, pz * 2.5, 101, 3) - 0.5;
    const r = ridged3(px * 3.6, py * 3.6, pz * 3.6, 139, 2) - 0.45;
    const disp = f * 0.055 + r * 0.036;
    const outLen = Math.hypot(px, pz) || 1;
    px += (px / outLen) * disp;
    pz += (pz / outLen) * disp;

    pos.setXYZ(i, px, py, pz);

    // Clean seam-free Dense Lava UV mapping (no pole stretching!)
    const uOrig = uv.getX(i);
    const vMapped = clamp01(uY * 0.92 + 0.04);
    uv.setXY(i, uOrig * 1.8, lerp(UV_BAND_LAVA_DENSE[0], UV_BAND_LAVA_DENSE[1], vMapped));

    const heightShade = lerp(0.80, 1.12, uY);
    const microAO = clamp(0.88 + f * 0.26 + r * 0.22 - (chestCav + backCav) * 0.20, 0.58, 1.16);
    const heatBoost = clamp01(smoothstep(1.32 - chestCavDist) * frontMask * 0.52 + smoothstep(1.25 - backCavDist) * backMask * 0.42);
    colors[i * 3] = clamp(heightShade * microAO * (1 + heatBoost * 0.32), 0.30, 1.38);
    colors[i * 3 + 1] = clamp(heightShade * microAO * (1 - heatBoost * 0.08), 0.26, 1.24);
    colors[i * 3 + 2] = clamp(heightShade * microAO * (1 - heatBoost * 0.18), 0.24, 1.16);
  }

  uv.needsUpdate = true;
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildTorsoGeometries(): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  // 1. Unified sculpted inverted-triangle hunched trunk
  skinParts.push(sculptTerminatorTrunk());

  // 2. Muscular hunched neck extending upward & forward so the head stands clearly proud of the shoulders!
  skinParts.push(
    sculptMuscleLimb({
      length: 0.34,
      rTop: 0.16,
      rMid: 0.19,
      rBot: 0.25,
      radialSegs: 10,
      heightSegs: 4,
      striations: 3,
      pos: [0, 1.66, -0.22],
      rot: [-0.30, 0, 0],
      seed: 167,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );

  // 3. Exposed Weathered-Ivory Rib Exoskeleton (5 diagonal predatory rib arches cradling the recessed molten sternum!)
  const ribDefs: Array<{ yOuter: number; yInner: number; xBack: number; xSide: number; xInner: number; zFront: number; r: number }> = [
    { yOuter: 1.24, yInner: 1.12, xBack: 0.56, xSide: 0.72, xInner: 0.14, zFront: -0.49, r: 0.036 },
    { yOuter: 1.09, yInner: 0.96, xBack: 0.54, xSide: 0.70, xInner: 0.13, zFront: -0.50, r: 0.038 },
    { yOuter: 0.94, yInner: 0.80, xBack: 0.50, xSide: 0.64, xInner: 0.13, zFront: -0.49, r: 0.036 },
    { yOuter: 0.79, yInner: 0.65, xBack: 0.44, xSide: 0.56, xInner: 0.15, zFront: -0.44, r: 0.033 },
    { yOuter: 0.64, yInner: 0.52, xBack: 0.36, xSide: 0.46, xInner: 0.17, zFront: -0.37, r: 0.029 },
  ];
  for (let i = 0; i < ribDefs.length; i++) {
    const rb = ribDefs[i];
    for (const side of [-1, 1] as const) {
      boneParts.push(
        sculptCurvedBoneBlade({
          points: [
            [side * rb.xBack, rb.yOuter + 0.04, 0.12],
            [side * rb.xSide, rb.yOuter + 0.01, -0.14],
            [side * (rb.xSide * 0.66), lerp(rb.yOuter, rb.yInner, 0.55), rb.zFront],
            [side * rb.xInner, rb.yInner, rb.zFront * 0.96],
          ],
          radiusStart: rb.r * 0.76,
          radiusMid: rb.r * 1.10,
          radiusEnd: rb.r * 0.50,
          midPos: 0.50,
          tubularSegs: 11,
          radialSegs: 7,
          bladeAspect: 1.32,
          tipGlow: false, // exposed bone ribs stay bright weathered yellowed-ivory
          baseColor: [0.96, 0.88, 0.74],
          tipColor: [1.26, 1.20, 1.02],
          seed: 301 + i * 11 + (side > 0 ? 3 : 0),
        }),
      );
    }
  }

  // Clavicle bone collar arches framing the upper chest glowing V-core
  for (const side of [-1, 1] as const) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.08, 1.28, -0.43],
          [side * 0.36, 1.38, -0.35],
          [side * 0.68, 1.40, -0.12],
        ],
        radiusStart: 0.028,
        radiusMid: 0.036,
        radiusEnd: 0.028,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.25,
        tipGlow: false,
        baseColor: [0.98, 0.90, 0.76],
        tipColor: [1.22, 1.14, 0.98],
        seed: side < 0 ? 331 : 337,
      }),
    );
  }

  // 4. ICONIC MASSIVE SWEPT-BACK DORSAL BONE-SPIKE CLUSTERS (背部巨大骨刺簇)
  //    Sleek, wicked scythe-horn arches matching docs/reference/boss-terminator-ref.png (front, side, back)!
  for (const side of [-1, 1] as const) {
    // (a) Towering Upper Inner Crown-Scythe Pair — rises behind head & curves outward-downward
    //     Peaks at torso y = 2.05 -> world y = 1.92 + 2.05 + r = ~4.05m (BOTH neutral & idle inside 4.0-4.2m!)
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.18, 1.38, 0.16],
          [side * 0.28, 1.80, 0.34],
          [side * 0.46, 2.05, 0.50], // peak ~4.05m world!
          [side * 0.70, 1.98, 0.56],
          [side * 0.90, 1.74, 0.50],
        ],
        radiusStart: 0.070,
        radiusMid: 0.054,
        radiusEnd: 0.008,
        midPos: 0.36,
        tubularSegs: 14,
        radialSegs: 7,
        bladeAspect: 1.45,
        tipGlow: true,
        baseColor: [0.78, 0.52, 0.40],
        tipColor: [1.28, 1.22, 1.02],
        seed: side < 0 ? 361 : 367,
      }),
    );

    // (b) Giant Sweeping Outer Wing-Scythe Pair — flares wide beyond shoulders & arcs far backward in side view!
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.38, 1.18, 0.24],
          [side * 0.74, 1.54, 0.68],
          [side * 1.12, 1.84, 0.74],
          [side * 1.38, 1.66, 0.56],
          [side * 1.50, 1.32, 0.36],
        ],
        radiusStart: 0.076,
        radiusMid: 0.062,
        radiusEnd: 0.009,
        midPos: 0.38,
        tubularSegs: 14,
        radialSegs: 7,
        bladeAspect: 1.60,
        tipGlow: true,
        baseColor: [0.72, 0.44, 0.34],
        tipColor: [1.28, 1.22, 1.02],
        seed: side < 0 ? 373 : 379,
      }),
    );

    // (c) Curved Lower Dorsal Bone Arch-Strut bridging mid-back into the giant outer wing-scythe (reference side view!)
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.28, 0.74, 0.28],
          [side * 0.56, 1.02, 0.76],
          [side * 0.84, 1.46, 0.84],
          [side * 1.04, 1.74, 0.74],
        ],
        radiusStart: 0.048,
        radiusMid: 0.040,
        radiusEnd: 0.016,
        midPos: 0.46,
        tubularSegs: 11,
        radialSegs: 6,
        bladeAspect: 1.42,
        tipGlow: true,
        baseColor: [0.74, 0.48, 0.36],
        tipColor: [1.22, 1.16, 0.98],
        seed: side < 0 ? 383 : 389,
      }),
    );

    // (d) Mid-Scapula Backward Sickle Spur (adds fierce layered dorsal silhouette!)
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.34, 0.94, 0.30],
          [side * 0.64, 1.14, 0.76],
          [side * 0.92, 1.06, 0.94],
          [side * 1.04, 0.84, 0.88],
        ],
        radiusStart: 0.052,
        radiusMid: 0.042,
        radiusEnd: 0.008,
        midPos: 0.40,
        tubularSegs: 10,
        radialSegs: 6,
        bladeAspect: 1.52,
        tipGlow: true,
        baseColor: [0.74, 0.46, 0.36],
        tipColor: [1.26, 1.18, 1.00],
        seed: side < 0 ? 397 : 401,
      }),
    );

    // (e) Secondary upward serrated horn barb jutting off the wing arch
    boneParts.push(
      sculptBoneSpike({
        length: 0.42,
        baseR: 0.040,
        tipR: 0.007,
        bendZ: 0.14,
        bendX: side * 0.08,
        flattenX: 0.56,
        radialSegs: 6,
        heightSegs: 4,
        pos: [side * 0.62, 1.44, 0.52],
        rot: [0.66, side * 0.22, -side * 0.48],
        seed: side < 0 ? 409 : 419,
      }),
    );
  }

  // (f) Central Spinal Bone-Spike Ridge running down the back (5 curved dorsal blades)
  const spineSpikes: Array<{ y: number; z: number; rx: number; len: number; r: number }> = [
    { y: 1.42, z: 0.24, rx: 0.72, len: 0.48, r: 0.062 },
    { y: 1.16, z: 0.32, rx: 0.94, len: 0.52, r: 0.066 },
    { y: 0.88, z: 0.32, rx: 1.10, len: 0.46, r: 0.058 },
    { y: 0.62, z: 0.28, rx: 1.24, len: 0.38, r: 0.050 },
    { y: 0.36, z: 0.24, rx: 1.34, len: 0.32, r: 0.042 },
  ];
  for (let i = 0; i < spineSpikes.length; i++) {
    const sp = spineSpikes[i];
    boneParts.push(
      sculptBoneSpike({
        length: sp.len,
        baseR: sp.r,
        tipR: 0.008,
        bendZ: 0.14,
        flattenX: 0.52,
        radialSegs: 6,
        heightSegs: 4,
        pos: [0, sp.y, sp.z],
        rot: [sp.rx, 0, 0],
        seed: 431 + i * 7,
      }),
    );
  }

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/** Purely self-emissive recessed molten sternum V-core & dorsal spine glow (zero projectiles). */
function buildCoreGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Recessed glowing molten sternum furnace nestled cleanly INSIDE the arched ivory bone ribs!
  parts.push(
    sculptOrganicBlob({
      scale: [0.19, 0.30, 0.11],
      pos: [0, 0.0, -0.37],
      segW: 14,
      segH: 10,
      noiseAmp: 0.12,
      ridgeAmp: 0.08,
      seed: 451,
      topTaper: 1.32,
      botTaper: 0.48,
      aoBottom: 0.04,
      uvBand: UV_BAND_CORE,
    }),
  );
  // Glowing molten V-collar flare right below the bone clavicles (reference front view's glowing chest V!)
  for (const side of [-1, 1] as const) {
    parts.push(
      sculptOrganicBlob({
        scale: [0.18, 0.08, 0.08],
        pos: [side * 0.20, 0.23, -0.37],
        rot: [0, 0, side * 0.34],
        segW: 9,
        segH: 6,
        noiseAmp: 0.12,
        seed: side < 0 ? 457 : 461,
        aoBottom: 0.03,
        uvBand: UV_BAND_CORE,
      }),
    );
  }
  // Recessed glowing dorsal spine molten vent
  parts.push(
    sculptOrganicBlob({
      scale: [0.13, 0.26, 0.09],
      pos: [0, 0.08, 0.33],
      segW: 12,
      segH: 8,
      noiseAmp: 0.12,
      ridgeAmp: 0.08,
      seed: 467,
      aoBottom: 0.04,
      uvBand: UV_BAND_CORE,
    }),
  );

  return mergeStrict(parts);
}

/**
 * Faceless Bone-Crowned Head (world y ~3.48..4.02m, sitting clearly proud above the hunched collar):
 *   - No normal human face (no nose/lips); smooth dark crimson armored demon cranium & sharp mandible
 *   - Sculpted ivory-bone crown helmet & twin sweeping curved cranial horns
 *   - Two blazing orange-red glowing predatory eyes recessed beneath the bone brow
 */
function buildHeadGeometries(): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];
  const eyeParts: THREE.BufferGeometry[] = [];

  // Sleek angular predatory faceless cranium
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.18, 0.22, 0.24],
      pos: [0, 0.12, -0.06],
      rot: [0.08, 0, 0],
      segW: 14,
      segH: 10,
      noiseAmp: 0.07,
      ridgeAmp: 0.05,
      seed: 503,
      topTaper: 0.84,
      botTaper: 0.70,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );
  // Sharp faceless armored jaw wedge
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.12, 0.11, 0.17],
      pos: [0, -0.06, -0.14],
      rot: [0.22, 0, 0],
      segW: 10,
      segH: 7,
      noiseAmp: 0.07,
      seed: 521,
      topTaper: 0.94,
      botTaper: 0.52,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );

  // Sleek razor-ridged ivory-bone helmet crown sheathing the forehead & top of skull (predatory, NOT puffy!)
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [0, 0.17, -0.30],
        [0, 0.28, -0.16],
        [0, 0.33, 0.04],
        [0, 0.25, 0.24],
      ],
      radiusStart: 0.034,
      radiusMid: 0.048,
      radiusEnd: 0.016,
      midPos: 0.44,
      tubularSegs: 10,
      radialSegs: 7,
      bladeAspect: 1.55,
      tipGlow: true,
      baseColor: [0.92, 0.80, 0.66],
      tipColor: [1.28, 1.22, 1.02],
      seed: 541,
    }),
  );

  // Twin overhanging bone brow-plates, cheek-guards, & fierce swept ivory cranial horns!
  for (const side of [-1, 1] as const) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.02, 0.16, -0.28],
          [side * 0.13, 0.21, -0.22],
          [side * 0.19, 0.24, -0.05],
          [side * 0.15, 0.21, 0.14],
        ],
        radiusStart: 0.028,
        radiusMid: 0.036,
        radiusEnd: 0.018,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.38,
        tipGlow: false,
        baseColor: [0.94, 0.84, 0.70],
        tipColor: [1.24, 1.16, 0.98],
        seed: side < 0 ? 547 : 557,
      }),
    );

    // Sleek sweeping curved ivory cranial horns arcing boldly upward & back from the bone crown
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.09, 0.23, -0.10],
          [side * 0.19, 0.40, -0.01],
          [side * 0.29, 0.49, 0.14],
          [side * 0.34, 0.40, 0.28],
        ],
        radiusStart: 0.044,
        radiusMid: 0.034,
        radiusEnd: 0.007,
        midPos: 0.36,
        tubularSegs: 9,
        radialSegs: 6,
        bladeAspect: 1.42,
        tipGlow: true,
        baseColor: [0.90, 0.76, 0.62],
        tipColor: [1.30, 1.24, 1.04],
        seed: side < 0 ? 563 : 569,
      }),
    );

    // Armored bone mandible/cheekblade
    boneParts.push(
      sculptBoneSpike({
        length: 0.20,
        baseR: 0.036,
        tipR: 0.009,
        bendZ: -0.04,
        flattenX: 0.58,
        radialSegs: 5,
        heightSegs: 3,
        pos: [side * 0.15, 0.01, -0.10],
        rot: [-1.14, side * 0.36, -side * 0.24],
        tipGlow: false,
        seed: side < 0 ? 571 : 577,
      }),
    );

    // Two fierce glowing orange-red predatory eyes recessed beneath the overhanging bone brow
    const eye = new THREE.SphereGeometry(0.038, 8, 6);
    eye.scale(1.42, 0.55, 0.85);
    eye.rotateZ(-side * 0.34);
    eye.rotateY(side * 0.22);
    eye.translate(side * 0.080, 0.095, -0.238);
    eyeParts.push(eye);
  }

  // Subtle vertical glowing molten visor seam along the faceless center
  const slit = new THREE.BoxGeometry(0.026, 0.075, 0.032);
  slit.translate(0, -0.035, -0.245);
  eyeParts.push(slit);

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
    eyes: mergeStrict(eyeParts),
  };
}

/** Broad integrated volcanic deltoid + muscular bicep (y = 0 down to elbow y = -0.76). */
function buildUpperArmGeometries(side: -1 | 1): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  // Broad muscular deltoid shoulder tapering cleanly into upper arm (angled, NOT a round ball!)
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.30, 0.27, 0.28],
      pos: [side * 0.02, 0.02, 0.0],
      rot: [0, 0, -side * 0.28],
      segW: 12,
      segH: 9,
      noiseAmp: 0.08,
      ridgeAmp: 0.05,
      topTaper: 0.90,
      botTaper: 1.06,
      seed: side < 0 ? 601 : 607,
      uvBand: UV_BAND_LAVA_DENSE,
      uScale: 1.2,
    }),
  );
  // Muscular upper arm shaft
  skinParts.push(
    sculptMuscleLimb({
      length: 0.82,
      rTop: 0.24,
      rMid: 0.22,
      rBot: 0.21,
      midPos: 0.46,
      radialSegs: 12,
      heightSegs: 7,
      striations: 4,
      bendX: side * 0.05,
      bendZ: 0.02,
      scaleZ: 1.06,
      pos: [side * 0.04, 0.0, 0],
      seed: side < 0 ? 613 : 617,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );

  // Curved shoulder bone ridge plate cresting the outer deltoid
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [side * -0.06, 0.22, -0.06],
        [side * 0.14, 0.24, 0.01],
        [side * 0.30, 0.14, 0.06],
        [side * 0.38, -0.02, 0.08],
      ],
      radiusStart: 0.036,
      radiusMid: 0.052,
      radiusEnd: 0.014,
      tubularSegs: 8,
      radialSegs: 6,
      bladeAspect: 1.48,
      tipGlow: true,
      baseColor: [0.76, 0.50, 0.38],
      tipColor: [1.24, 1.18, 1.00],
      seed: side < 0 ? 631 : 641,
    }),
  );

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/**
 * Hypertrophied Terminator Forearm (thicker than half-waist!)
 * heavily armored with dense lava fissures and 4 chunky swept-back outer bone spikes/plates!
 */
function buildForearmGeometries(side: -1 | 1): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  // Seamless elbow blend + swollen armored forearm (radius 0.30m — thicker than half-waist!)
  skinParts.push(
    sculptMuscleLimb({
      length: 0.90,
      rTop: 0.23,
      rMid: 0.30,
      rBot: 0.22,
      midPos: 0.42,
      radialSegs: 14,
      heightSegs: 8,
      striations: 5,
      striationAmp: 0.09,
      bendX: side * 0.04,
      bendZ: -0.05,
      scaleZ: 1.08,
      pos: [0, 0.05, 0],
      seed: side < 0 ? 653 : 659,
      uvBand: UV_BAND_LAVA_DENSE,
      uScale: 1.3,
    }),
  );

  // Heavy swept-back elbow bone spur
  boneParts.push(
    sculptBoneSpike({
      length: 0.32,
      baseR: 0.066,
      tipR: 0.010,
      bendZ: 0.09,
      flattenX: 0.64,
      radialSegs: 6,
      heightSegs: 4,
      pos: [side * 0.05, -0.02, 0.18],
      rot: [1.32, 0, -side * 0.16],
      seed: side < 0 ? 661 : 673,
    }),
  );

  // 4 chunky curved armored bone spikes / horn plates stepping down the outer forearm (angled back-up like reference!)
  const forearmSpikes: Array<{ y: number; z: number; len: number; r: number; rz: number }> = [
    { y: -0.15, z: 0.06, len: 0.28, r: 0.072, rz: -side * 0.92 },
    { y: -0.33, z: 0.03, len: 0.32, r: 0.078, rz: -side * 1.02 },
    { y: -0.51, z: -0.02, len: 0.29, r: 0.070, rz: -side * 1.12 },
    { y: -0.67, z: -0.06, len: 0.23, r: 0.058, rz: -side * 1.22 },
  ];
  for (let i = 0; i < forearmSpikes.length; i++) {
    const sp = forearmSpikes[i];
    boneParts.push(
      sculptBoneSpike({
        length: sp.len,
        baseR: sp.r,
        tipR: 0.013,
        bendZ: 0.10,
        flattenX: 0.72,
        radialSegs: 6,
        heightSegs: 4,
        pos: [side * 0.22, sp.y, sp.z],
        rot: [0.46, -side * 0.26, sp.rz],
        seed: 683 + i * 11 + (side > 0 ? 3 : 0),
      }),
    );
  }

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/**
 * Huge Mutated Clawed Hand: 3 thick predatory curved fingers + 1 opposable thumb,
 * with pronounced bony knuckles and long curved ivory-bone talons!
 */
function buildHandGeometries(side: -1 | 1): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  // Broad mutated volcanic palm bridging cleanly from the thick wrist
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.19, 0.22, 0.20],
      pos: [side * 0.01, -0.12, -0.02],
      segW: 10,
      segH: 7,
      noiseAmp: 0.09,
      seed: side < 0 ? 701 : 709,
      topTaper: 1.06,
      botTaper: 0.96,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );

  // 3 massive mutated clawed fingers with prominent knuckles + sweeping curved talons (NOT thin needles!)
  const fingerDefs: Array<{ x: number; z: number; spreadX: number; len: number; curlZ: number }> = [
    { x: -side * 0.10, z: -0.10, spreadX: -side * 0.07, len: 0.44, curlZ: -0.08 },
    { x: side * 0.01, z: -0.12, spreadX: side * 0.01, len: 0.49, curlZ: -0.09 },
    { x: side * 0.11, z: -0.07, spreadX: side * 0.08, len: 0.42, curlZ: -0.06 },
  ];
  for (let i = 0; i < fingerDefs.length; i++) {
    const f = fingerDefs[i];
    // Prominent swollen lava-skinned base knuckle
    skinParts.push(
      sculptOrganicBlob({
        scale: [0.060, 0.056, 0.062],
        pos: [f.x, -0.27, f.z + 0.03],
        segW: 7,
        segH: 5,
        noiseAmp: 0.08,
        seed: 719 + i * 7 + (side > 0 ? 3 : 0),
        uvBand: UV_BAND_LAVA_DENSE,
      }),
    );
    // Thick proximal phalanx
    skinParts.push(
      sculptMuscleLimb({
        length: 0.18,
        rTop: 0.050,
        rMid: 0.045,
        rBot: 0.040,
        radialSegs: 6,
        heightSegs: 3,
        striations: 2,
        pos: [f.x, -0.28, f.z + 0.02],
        rot: [0.34, 0, -f.spreadX * 2.2],
        seed: 733 + i * 7 + (side > 0 ? 3 : 0),
        uvBand: UV_BAND_LAVA_DENSE,
      }),
    );
    // Pronounced distal bone knuckle boss + curved thick talon blade!
    const knX = f.x + f.spreadX * 0.65;
    const knY = -0.43;
    const knZ = f.z - 0.04;
    boneParts.push(
      sculptOrganicBlob({
        scale: [0.046, 0.042, 0.048],
        pos: [knX, knY, knZ],
        segW: 6,
        segH: 4,
        noiseAmp: 0.08,
        seed: 743 + i * 5 + (side > 0 ? 2 : 0),
        uvBand: UV_BAND_BONE,
        tint: [1.14, 1.06, 0.92],
      }),
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [knX, knY + 0.01, knZ],
          [knX + f.spreadX * 0.45, knY - f.len * 0.34, knZ + f.curlZ * 0.45],
          [knX + f.spreadX * 0.30, knY - f.len * 0.68, knZ + f.curlZ * 0.15 + 0.05],
          [knX - side * 0.02, knY - f.len * 0.84, knZ + 0.13],
        ],
        radiusStart: 0.042,
        radiusMid: 0.032,
        radiusEnd: 0.006,
        midPos: 0.38,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.38,
        tipGlow: true,
        baseColor: [0.80, 0.56, 0.44],
        tipColor: [1.26, 1.20, 1.00],
        seed: 751 + i * 9 + (side > 0 ? 3 : 0),
      }),
    );
  }

  // Opposable mutated clawed thumb (inner edge, prominent knuckle + hooked claw)
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.066, 0.060, 0.066],
      pos: [-side * 0.15, -0.18, -0.09],
      segW: 7,
      segH: 5,
      noiseAmp: 0.09,
      seed: side < 0 ? 769 : 773,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );
  skinParts.push(
    sculptMuscleLimb({
      length: 0.16,
      rTop: 0.052,
      rMid: 0.046,
      rBot: 0.038,
      radialSegs: 6,
      heightSegs: 3,
      striations: 2,
      pos: [-side * 0.16, -0.19, -0.10],
      rot: [0.46, side * 0.48, -side * 0.56],
      seed: side < 0 ? 787 : 797,
      uvBand: UV_BAND_LAVA_DENSE,
    }),
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [-side * 0.23, -0.31, -0.16],
        [-side * 0.28, -0.43, -0.17],
        [-side * 0.22, -0.54, -0.10],
      ],
      radiusStart: 0.042,
      radiusMid: 0.030,
      radiusEnd: 0.006,
      tubularSegs: 7,
      radialSegs: 6,
      bladeAspect: 1.35,
      tipGlow: true,
      baseColor: [0.80, 0.56, 0.44],
      tipColor: [1.26, 1.20, 1.00],
      seed: side < 0 ? 809 : 811,
    }),
  );

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/** Armored volcanic pelvis girdle seamlessly blending waist -> thighs + snug iliac bone hip-crests. */
function buildPelvisGeometries(): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  skinParts.push(
    sculptOrganicBlob({
      scale: [0.46, 0.30, 0.34],
      pos: [0, 0.0, 0.02],
      segW: 14,
      segH: 9,
      noiseAmp: 0.08,
      ridgeAmp: 0.05,
      seed: 821,
      topTaper: 0.82,
      botTaper: 1.06,
      uvBand: UV_BAND_LAVA_FLOW,
    }),
  );

  // Diagonal snug pelvic bone-crest plates blending waist seamlessly into sculpted thighs
  for (const side of [-1, 1] as const) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.12, 0.12, -0.27],
          [side * 0.36, 0.05, -0.12],
          [side * 0.39, -0.06, 0.08],
          [side * 0.22, 0.02, 0.28],
        ],
        radiusStart: 0.024,
        radiusMid: 0.034,
        radiusEnd: 0.022,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.35,
        tipGlow: false,
        baseColor: [0.88, 0.76, 0.62],
        tipColor: [1.18, 1.10, 0.94],
        seed: side < 0 ? 827 : 829,
      }),
    );
  }

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/**
 * Seamless articulated tail segment extending STRICTLY ALONG +Z (z = -0.04 overlap -> +segLen + 0.04)!
 * Segment 0..4: muscular lava-veined tapered tail body + smooth joint cap + armored bone keel/spine.
 * Segment 5 (tip): seamless socket flaring into a wicked curved razor-blade bone stinger!
 */
function buildTailSegmentGeometries(
  index: number,
  segLen: number,
  rStart: number,
  rEnd: number,
  isTip: boolean,
): {
  skin: THREE.BufferGeometry | null;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  if (!isTip) {
    // Joint ball cap at z = 0 so adjacent articulated segments blend seamlessly with ZERO gap at any bend angle!
    skinParts.push(
      sculptOrganicBlob({
        scale: [rStart * 1.02, rStart * 0.98, rStart * 1.02],
        pos: [0, 0, 0],
        segW: 8,
        segH: 6,
        noiseAmp: 0.05,
        seed: 841 + index * 7,
        uvBand: UV_BAND_LAVA_FLOW,
      }),
    );

    // Tapered lava-fissured tail segment extending along +Z:
    // rot X = -Math.PI/2 maps (0, -L, 0) -> (0, 0, +L)!
    skinParts.push(
      sculptMuscleLimb({
        length: segLen + 0.05,
        rTop: rStart,
        rMid: lerp(rStart, rEnd, 0.5) * 1.02,
        rBot: rEnd,
        radialSegs: 10,
        heightSegs: 5,
        striations: 3,
        striationAmp: 0.06,
        noiseAmp: 0.06,
        rot: [-Math.PI * 0.5, 0, 0],
        pos: [0, 0, -0.02],
        seed: 851 + index * 13,
        uvBand: UV_BAND_LAVA_FLOW,
      }),
    );

    // Armored dorsal bone keel/spike + segmented bone collar ridge along each tail vertebra
    boneParts.push(
      sculptBoneSpike({
        length: lerp(0.24, 0.14, index / 4),
        baseR: rStart * 0.42,
        tipR: 0.008,
        bendZ: 0.05,
        flattenX: 0.52,
        radialSegs: 6,
        heightSegs: 3,
        pos: [0, rStart * 0.72, segLen * 0.46],
        rot: [0.96, 0, 0],
        tipGlow: true,
        seed: 877 + index * 7,
      }),
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [-rStart * 0.95, 0.0, segLen * 0.10],
          [0, rStart * 0.96, segLen * 0.18],
          [rStart * 0.95, 0.0, segLen * 0.10],
        ],
        radiusStart: rStart * 0.22,
        radiusMid: rStart * 0.30,
        radiusEnd: rStart * 0.22,
        tubularSegs: 6,
        radialSegs: 5,
        bladeAspect: 1.25,
        tipGlow: false,
        baseColor: [0.88, 0.78, 0.64],
        tipColor: [1.14, 1.06, 0.90],
        seed: 887 + index * 5,
      }),
    );
  } else {
    // Seamless joint ball + tapered muscular base socket transitioning smoothly into the giant razor bone blade!
    skinParts.push(
      sculptOrganicBlob({
        scale: [rStart * 1.02, rStart * 0.98, rStart * 1.02],
        pos: [0, 0, 0],
        segW: 8,
        segH: 6,
        noiseAmp: 0.05,
        seed: 907,
        uvBand: UV_BAND_LAVA_DENSE,
      }),
    );
    skinParts.push(
      sculptMuscleLimb({
        length: segLen * 0.58,
        rTop: rStart,
        rMid: rStart * 0.90,
        rBot: rEnd * 1.05,
        radialSegs: 9,
        heightSegs: 4,
        striations: 2,
        rot: [-Math.PI * 0.5, 0, 0], // STRICTLY along +Z!
        pos: [0, 0, -0.015],
        seed: 911,
        uvBand: UV_BAND_LAVA_DENSE,
      }),
    );

    // Wicked curved blade-like bone stinger (末端刃状骨刺 — rooted cleanly inside the socket at z = segLen * 0.40!)
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [0, 0.0, segLen * 0.38],
          [0, 0.03, segLen * 0.85],
          [0, 0.14, segLen * 1.38],
          [0, 0.30, segLen * 1.82],
        ],
        radiusStart: rStart * 0.96,
        radiusMid: rStart * 1.48,
        radiusEnd: 0.008,
        midPos: 0.36,
        tubularSegs: 11,
        radialSegs: 7,
        bladeAspect: 2.25,
        tipGlow: true,
        baseColor: [0.76, 0.44, 0.34],
        tipColor: [1.30, 1.24, 1.02],
        seed: 919,
      }),
    );
    // Lower reverse hook barb on the tail blade
    boneParts.push(
      sculptBoneSpike({
        length: 0.18,
        baseR: 0.032,
        tipR: 0.006,
        bendZ: -0.04,
        flattenX: 0.48,
        radialSegs: 5,
        heightSegs: 3,
        pos: [0, -0.02, segLen * 0.66],
        rot: [Math.PI * 0.72, 0, 0],
        tipGlow: true,
        seed: 929,
      }),
    );
  }

  return {
    skin: skinParts.length > 0 ? mergeStrict(skinParts) : null,
    bone: mergeStrict(boneParts),
  };
}

/** Muscular volcanic thigh (y = 0 down to knee y = -0.84) with seamless hip/knee blend & bone knee guard. */
function buildThighGeometries(side: -1 | 1): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  skinParts.push(
    sculptMuscleLimb({
      length: 0.92,
      rTop: 0.24,
      rMid: 0.22,
      rBot: 0.16,
      midPos: 0.42,
      radialSegs: 12,
      heightSegs: 8,
      striations: 4,
      bendX: side * 0.02,
      bendZ: -0.05,
      scaleZ: 1.08,
      pos: [0, 0.05, 0],
      seed: side < 0 ? 941 : 947,
      uvBand: UV_BAND_LAVA_FLOW,
      uScale: 1.1,
    }),
  );
  // Smooth knee joint sphere eliminating any cylinder-to-cylinder seam!
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.16, 0.15, 0.17],
      pos: [side * 0.02, -0.84, -0.06],
      segW: 10,
      segH: 7,
      noiseAmp: 0.06,
      seed: side < 0 ? 949 : 951,
      uvBand: UV_BAND_LAVA_FLOW,
    }),
  );

  // Armored bone knee-guard crest + lateral thigh bone ridge
  boneParts.push(
    sculptBoneSpike({
      length: 0.24,
      baseR: 0.068,
      tipR: 0.014,
      bendZ: -0.04,
      flattenX: 0.76,
      radialSegs: 6,
      heightSegs: 3,
      pos: [side * 0.01, -0.78, -0.14],
      rot: [-0.40, 0, 0],
      tipGlow: false,
      seed: side < 0 ? 953 : 967,
    }),
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [side * 0.21, -0.10, 0.02],
        [side * 0.22, -0.40, -0.02],
        [side * 0.14, -0.72, -0.06],
      ],
      radiusStart: 0.026,
      radiusMid: 0.032,
      radiusEnd: 0.018,
      tubularSegs: 7,
      radialSegs: 5,
      bladeAspect: 1.38,
      tipGlow: false,
      baseColor: [0.86, 0.74, 0.60],
      tipColor: [1.16, 1.08, 0.94],
      seed: side < 0 ? 971 : 977,
    }),
  );

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/** Athletic muscular calf/shin (y = 0 down to ankle y = -0.86) + bony shin greave. */
function buildShinGeometries(side: -1 | 1): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];

  skinParts.push(
    sculptMuscleLimb({
      length: 0.92,
      rTop: 0.16,
      rMid: 0.175,
      rBot: 0.115,
      midPos: 0.36,
      radialSegs: 12,
      heightSegs: 8,
      striations: 3,
      bendZ: 0.05,
      scaleZ: 1.12,
      pos: [0, 0.04, 0],
      seed: side < 0 ? 983 : 991,
      uvBand: UV_BAND_LAVA_FLOW,
    }),
  );

  // Sharp anterior bone shin greave ridge
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [0, -0.08, -0.14],
        [0, -0.44, -0.15],
        [0, -0.80, -0.09],
      ],
      radiusStart: 0.040,
      radiusMid: 0.038,
      radiusEnd: 0.022,
      tubularSegs: 7,
      radialSegs: 6,
      bladeAspect: 1.55,
      tipGlow: false,
      baseColor: [0.88, 0.76, 0.62],
      tipColor: [1.18, 1.10, 0.94],
      seed: side < 0 ? 997 : 1009,
    }),
  );

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

/** Broad armored clawed foot flush at local y = -0.22 (world y = 0.000). */
function buildFootGeometries(side: -1 | 1): {
  skin: THREE.BufferGeometry;
  bone: THREE.BufferGeometry;
} {
  const skinParts: THREE.BufferGeometry[] = [];
  const boneParts: THREE.BufferGeometry[] = [];
  const SOLE_Y = -0.22;

  const footBase = sculptOrganicBlob({
    scale: [0.18, 0.12, 0.30],
    pos: [0, -0.12, -0.11],
    segW: 10,
    segH: 7,
    noiseAmp: 0.06,
    seed: side < 0 ? 1013 : 1019,
    uvBand: UV_BAND_LAVA_FLOW,
  });
  const fpos = footBase.getAttribute('position');
  for (let i = 0; i < fpos.count; i++) {
    if (fpos.getY(i) < SOLE_Y) fpos.setY(i, SOLE_Y);
  }
  footBase.computeVertexNormals();
  skinParts.push(footBase);

  const toeXs = [-0.11, 0, 0.11];
  for (let i = 0; i < toeXs.length; i++) {
    const tx = toeXs[i];
    const claw = sculptBoneSpike({
      length: 0.16,
      baseR: 0.036,
      tipR: 0.007,
      bendZ: -0.015,
      pos: [tx, -0.16, -0.35 - (i === 1 ? 0.03 : 0)],
      rot: [-Math.PI * 0.52, -tx * 0.8, 0],
      radialSegs: 5,
      heightSegs: 3,
      tipGlow: false,
      seed: 1031 + i * 7 + (side > 0 ? 3 : 0),
    });
    const cpos = claw.getAttribute('position');
    for (let k = 0; k < cpos.count; k++) {
      if (cpos.getY(k) < SOLE_Y) cpos.setY(k, SOLE_Y);
    }
    claw.computeVertexNormals();
    boneParts.push(claw);
  }

  const heel = sculptBoneSpike({
    length: 0.15,
    baseR: 0.036,
    tipR: 0.007,
    bendZ: 0.02,
    pos: [0, -0.15, 0.14],
    rot: [Math.PI * 0.54, 0, 0],
    radialSegs: 5,
    heightSegs: 3,
    tipGlow: false,
    seed: side < 0 ? 1051 : 1061,
  });
  const hpos = heel.getAttribute('position');
  for (let k = 0; k < hpos.count; k++) {
    if (hpos.getY(k) < SOLE_Y) hpos.setY(k, SOLE_Y);
  }
  heel.computeVertexNormals();
  boneParts.push(heel);

  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
  };
}

// ============================================================================
// Kinematics & Phase 2 Molten Heating Constants
// ============================================================================

const BASE_HIP_Y = 1.92; // thigh (-0.84) + shin (-0.86) + foot sole (-0.22) = 0.000!
const DEG2RAD = Math.PI / 180;
const ATTACK_DURATION = 0.18;
const RECOVER_DURATION = 0.80;
const TAIL_SEG_COUNT = 6;

const LAVA_EMISSIVE_P1 = new THREE.Color('#FF4B0C');
const LAVA_EMISSIVE_P2 = new THREE.Color('#FF8420');
const CORE_EMISSIVE_P1 = new THREE.Color('#FF6414');
const CORE_EMISSIVE_P2 = new THREE.Color('#FFA02E');
const BONE_TIP_EMISSIVE = new THREE.Color('#FF7214');

interface JointPose {
  torso: Vec3Tuple;
  head: Vec3Tuple;
  leftArm: Vec3Tuple;
  elbowL: Vec3Tuple;
  handL: Vec3Tuple;
  rightArm: Vec3Tuple;
  elbowR: Vec3Tuple;
  handR: Vec3Tuple;
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
    leftArm: [0, 0, 0],
    elbowL: [0, 0, 0],
    handL: [0, 0, 0],
    rightArm: [0, 0, 0],
    elbowR: [0, 0, 0],
    handR: [0, 0, 0],
    hips: [0, 0, 0],
    thighL: [0, 0, 0],
    shinL: [0, 0, 0],
    footL: [0, 0, 0],
    thighR: [0, 0, 0],
    shinR: [0, 0, 0],
    footR: [0, 0, 0],
  };
}

// Graceful organic S-curve sweeping backward & downward along +Z, then curling up at the bladed tip
// (positive X rotates +Z downward; negative X curls +Z upward!)
const TAIL_BASE_PITCH = [0.22, 0.34, 0.34, 0.14, -0.34, -0.44];

// ============================================================================
// Public Factory: createBossModel()
// ============================================================================

export function createBossModel(): BossModel {
  const atlas = createTerminatorAtlas();
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

  // --- Strictly 4 PBR Materials (<= 6), sharing the single procedural atlas ---
  // 1. Dark crimson / near-black lava-cracked skin (emissiveMap illuminates organic magma veins only!)
  const skinMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#F2E4E0'),
      map: atlas.albedoMap,
      emissive: LAVA_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.05,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(1.10, 1.10),
      roughness: 0.76,
      metalness: 0.08,
      vertexColors: true,
    }),
  );

  // 2. Exposed weathered yellowed-ivory bone (ribs, dorsal spikes, horns, forearm spikes, claws, tail blade)
  //    Clearly brighter than dark lava skin; Phase 2 (hpPct <= 0.35) heats bone spike/claw/blade tips!
  const boneMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#F2E5C8'),
      map: atlas.albedoMap,
      emissive: BONE_TIP_EMISSIVE.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 0.06,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.90, 0.90),
      roughness: 0.56,
      metalness: 0.05,
      vertexColors: true,
    }),
  );

  // 3. Exposed molten chest & dorsal core (purely self-emissive, deep cracked magma furnace, zero projectiles)
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#421006'),
      map: atlas.albedoMap,
      emissive: CORE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.48,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.42,
      metalness: 0.05,
    }),
  );

  // 4. Two fierce glowing orange-red eyes & narrow molten visor slit
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#2E0602'),
      emissive: new THREE.Color('#FF5210'),
      emissiveIntensity: 3.2,
      roughness: 0.22,
      metalness: 0.05,
    }),
  );

  const makeMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(geo), mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  // --- Articulated Skeleton Hierarchy ---
  const root = new THREE.Group();
  root.name = 'boss-root';

  const body = new THREE.Group();
  body.name = 'boss-body';
  body.position.set(0, BASE_HIP_Y, 0);
  root.add(body);

  // 1. Torso (trunk + exposed ivory ribs + massive swept-back dorsal bone-spike clusters)
  const torso = new THREE.Group();
  torso.name = 'boss-torso';
  body.add(torso);

  const torsoGeo = buildTorsoGeometries();
  torso.add(makeMesh(torsoGeo.skin, skinMat, 'boss-torso-skin'));
  torso.add(makeMesh(torsoGeo.bone, boneMat, 'boss-torso-bone'));

  // 2. Recessed Molten Chest & Dorsal Core (self-emissive only, melee Boss)
  const core = makeMesh(buildCoreGeometry(), coreMat, 'boss-core');
  core.position.set(0, 0.96, 0);
  core.castShadow = false;
  torso.add(core);

  // 3. Faceless Bone-Crowned Head (proudly visible above collar, world y ~3.50..4.02m)
  const head = new THREE.Group();
  head.name = 'boss-head';
  head.position.set(0, 1.56, -0.24);
  torso.add(head);

  const headGeo = buildHeadGeometries();
  head.add(makeMesh(headGeo.skin, skinMat, 'boss-head-skin'));
  head.add(makeMesh(headGeo.bone, boneMat, 'boss-head-bone'));
  const eyesMesh = makeMesh(headGeo.eyes, eyeMat, 'boss-head-eyes');
  eyesMesh.castShadow = false;
  head.add(eyesMesh);

  // 4. Broad-Shouldered Arms with Hypertrophied Spiked Forearms & 4-Digit Claws
  const buildArmChain = (
    side: -1 | 1,
    tag: 'l' | 'r',
    shoulderPos: Vec3Tuple,
  ): { shoulder: THREE.Group; elbow: THREE.Group; hand: THREE.Group } => {
    const shoulder = new THREE.Group();
    shoulder.name = `boss-shoulder-${tag}`;
    shoulder.position.set(shoulderPos[0], shoulderPos[1], shoulderPos[2]);
    torso.add(shoulder);

    const upperGeo = buildUpperArmGeometries(side);
    shoulder.add(makeMesh(upperGeo.skin, skinMat, `boss-upper-arm-skin-${tag}`));
    shoulder.add(makeMesh(upperGeo.bone, boneMat, `boss-upper-arm-bone-${tag}`));

    const elbow = new THREE.Group();
    elbow.name = `boss-elbow-${tag}`;
    elbow.position.set(side * 0.06, -0.76, 0.02);
    shoulder.add(elbow);

    const foreGeo = buildForearmGeometries(side);
    elbow.add(makeMesh(foreGeo.skin, skinMat, `boss-forearm-skin-${tag}`));
    elbow.add(makeMesh(foreGeo.bone, boneMat, `boss-forearm-bone-${tag}`));

    const hand = new THREE.Group();
    hand.name = `boss-hand-${tag}`;
    hand.position.set(side * 0.04, -0.82, -0.04);
    elbow.add(hand);

    const handGeo = buildHandGeometries(side);
    hand.add(makeMesh(handGeo.skin, skinMat, `boss-hand-skin-${tag}`));
    hand.add(makeMesh(handGeo.bone, boneMat, `boss-hand-bone-${tag}`));

    return { shoulder, elbow, hand };
  };

  const armL = buildArmChain(-1, 'l', [-0.88, 1.32, -0.02]);
  const armR = buildArmChain(1, 'r', [0.88, 1.32, -0.02]);

  // 5. Hips, Seamless Articulated 6-Segment Bladed Tail, & Muscular Grounded Legs
  const hips = new THREE.Group();
  hips.name = 'boss-hips';
  body.add(hips);

  const pelvisGeo = buildPelvisGeometries();
  hips.add(makeMesh(pelvisGeo.skin, skinMat, 'boss-pelvis-skin'));
  hips.add(makeMesh(pelvisGeo.bone, boneMat, 'boss-pelvis-bone'));

  // Articulated 6-segment tail hierarchy (tailRoot -> tailSeg[0] -> ... -> tailSeg[5])
  const tailRoot = new THREE.Group();
  tailRoot.name = 'boss-tail';
  tailRoot.position.set(0, 0.08, 0.28);
  hips.add(tailRoot);

  const tailSegLengths = [0.38, 0.36, 0.35, 0.33, 0.31, 0.34];
  const tailSegRadii: Array<[number, number]> = [
    [0.145, 0.118],
    [0.118, 0.098],
    [0.098, 0.082],
    [0.082, 0.068],
    [0.068, 0.054],
    [0.054, 0.036],
  ];
  const tailSegs: THREE.Group[] = [];
  let tailParent: THREE.Object3D = tailRoot;
  for (let i = 0; i < TAIL_SEG_COUNT; i++) {
    const seg = new THREE.Group();
    seg.name = `boss-tail-seg-${i}`;
    if (i > 0) {
      seg.position.set(0, 0, tailSegLengths[i - 1]);
    }
    seg.rotation.set(TAIL_BASE_PITCH[i], 0, 0);
    const isTip = i === TAIL_SEG_COUNT - 1;
    const segGeos = buildTailSegmentGeometries(
      i,
      tailSegLengths[i],
      tailSegRadii[i][0],
      tailSegRadii[i][1],
      isTip,
    );
    if (segGeos.skin) {
      seg.add(makeMesh(segGeos.skin, skinMat, `boss-tail-skin-${i}`));
    }
    seg.add(makeMesh(segGeos.bone, boneMat, `boss-tail-bone-${i}`));
    tailParent.add(seg);
    tailSegs.push(seg);
    tailParent = seg;
  }

  const buildLegChain = (
    side: -1 | 1,
    tag: 'l' | 'r',
  ): { thigh: THREE.Group; shin: THREE.Group; foot: THREE.Group } => {
    const thigh = new THREE.Group();
    thigh.name = `boss-thigh-${tag}`;
    thigh.position.set(side * 0.29, 0.02, 0.02);
    hips.add(thigh);

    const thighGeo = buildThighGeometries(side);
    thigh.add(makeMesh(thighGeo.skin, skinMat, `boss-thigh-skin-${tag}`));
    thigh.add(makeMesh(thighGeo.bone, boneMat, `boss-thigh-bone-${tag}`));

    const shin = new THREE.Group();
    shin.name = `boss-shin-${tag}`;
    shin.position.set(side * 0.02, -0.86, -0.06);
    thigh.add(shin);

    const shinGeo = buildShinGeometries(side);
    shin.add(makeMesh(shinGeo.skin, skinMat, `boss-shin-skin-${tag}`));
    shin.add(makeMesh(shinGeo.bone, boneMat, `boss-shin-bone-${tag}`));

    const foot = new THREE.Group();
    foot.name = `boss-foot-${tag}`;
    foot.position.set(0, -0.86, 0.06);
    shin.add(foot);

    const footGeo = buildFootGeometries(side);
    foot.add(makeMesh(footGeo.skin, skinMat, `boss-foot-skin-${tag}`));
    foot.add(makeMesh(footGeo.bone, boneMat, `boss-foot-bone-${tag}`));

    return { thigh, shin, foot };
  };

  const legL = buildLegChain(-1, 'l');
  const legR = buildLegChain(1, 'r');

  // --- Runtime Animation State (zero per-frame allocations) ---
  const jointNodes: Record<keyof JointPose, THREE.Object3D> = {
    torso,
    head,
    leftArm: armL.shoulder,
    elbowL: armL.elbow,
    handL: armL.hand,
    rightArm: armR.shoulder,
    elbowR: armR.elbow,
    handR: armR.hand,
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
  const tailTargetPitch = new Float32Array(TAIL_SEG_COUNT);
  const tailTargetYaw = new Float32Array(TAIL_SEG_COUNT);
  const tmpEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  const tmpQuat = new THREE.Quaternion();

  let elapsed = 0;
  let animElapsed = 0;
  let lastAnim: BossAnim | null = null;
  let moltenHeat = 0;
  let bodyDropCur = 0;
  let torsoScaleYCur = 1;
  let coreScaleCur = 1;
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
    const isMoltenEnraged = hpPct <= 0.35;
    const heatTarget = isMoltenEnraged ? 1.0 : state.phase === 2 ? 0.38 : 0.0;

    if (state.anim !== lastAnim) {
      lastAnim = state.anim;
      animElapsed = 0;
    }
    elapsed += step;
    animElapsed += step;

    const heatAlpha = step > 0 ? 1 - Math.exp(-7 * step) : 1;
    moltenHeat += (heatTarget - moltenHeat) * heatAlpha;

    let targetBodyDrop = 0;
    let targetTorsoScaleY = 1.0;
    let slerpRate = 10;
    let coreWarnMult = 1.0;

    // Grounded predatory combat stance
    setPose('hips', 0, 0, 0);
    setPose('thighL', 0.05, 0.06, 0.04);
    setPose('shinL', -0.09, 0, 0);
    setPose('footL', 0.04, 0, -0.04);
    setPose('thighR', -0.04, -0.06, -0.04);
    setPose('shinR', -0.07, 0, 0);
    setPose('footR', 0.11, 0, 0.04);

    for (let i = 0; i < TAIL_SEG_COUNT; i++) {
      tailTargetPitch[i] = TAIL_BASE_PITCH[i];
      tailTargetYaw[i] = 0;
    }

    const rageRate = 1 + (1 - hpPct) * 0.30 + moltenHeat * 0.25;

    if (state.anim === 'idle') {
      const breath = 0.5 + 0.5 * Math.sin(elapsed * 2.1 * rageRate);
      const sway = Math.sin(elapsed * 1.1 * rageRate);
      targetTorsoScaleY = 1.0 + 0.018 * breath;
      targetBodyDrop = 0.010 * (1 - breath);

      setPose('hips', 0, sway * 0.035, sway * 0.025);
      setPose('torso', -0.06 - breath * 0.02, sway * 0.05, -sway * 0.03);
      setPose('head', 0.05 - breath * 0.03, -sway * 0.08 + Math.sin(elapsed * 0.65) * 0.06, sway * 0.03);

      setPose('leftArm', 0.12 + breath * 0.05, -0.08, 0.16 + breath * 0.03);
      setPose('elbowL', 0.36 + breath * 0.05, 0, -0.05);
      setPose('handL', 0.14, 0, -0.06);

      setPose('rightArm', 0.14 - breath * 0.04 + sway * 0.04, 0.08, -0.17 - breath * 0.03);
      setPose('elbowR', 0.40 + breath * 0.05, 0, 0.06);
      setPose('handR', 0.16, 0, 0.06);

      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        const w = elapsed * 1.85 * rageRate - i * 0.52;
        tailTargetYaw[i] = Math.sin(w) * (0.09 + i * 0.026);
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] + Math.cos(w * 0.7) * 0.03;
      }
      slerpRate = 8;
    } else if (state.anim === 'walk') {
      const walkFreq = 3.5 * (1 + moltenHeat * 0.15);
      const w = animElapsed * walkFreq + 0.45;
      const s = Math.sin(w);
      const c = Math.cos(w);
      const footStrike = Math.pow(Math.max(0, -Math.cos(w * 2)), 2);

      targetBodyDrop = 0.04 * footStrike;
      targetTorsoScaleY = 1.008 + 0.008 * Math.abs(s);

      setPose('hips', 0.04 * footStrike, -s * 0.10, s * 0.05);
      setPose('torso', -0.15 - 0.04 * footStrike, s * 0.14, -s * 0.07);
      setPose('head', 0.10 + 0.04 * footStrike, -s * 0.10, s * 0.04);

      setPose('thighL', s * 0.48 + 0.05, 0.04, 0.04);
      setPose('shinL', -Math.max(0.08, -c * 0.56 + 0.15), 0, 0);
      setPose('footL', -s * 0.22 + 0.07, 0, -0.04);

      setPose('thighR', -s * 0.48 + 0.05, -0.04, -0.04);
      setPose('shinR', -Math.max(0.08, c * 0.56 + 0.15), 0, 0);
      setPose('footR', s * 0.22 + 0.07, 0, 0.04);

      setPose('leftArm', -s * 0.46 + 0.14, -0.08, 0.18 + Math.abs(s) * 0.05);
      setPose('elbowL', 0.36 + Math.max(0, -s) * 0.22, 0, -0.05);
      setPose('handL', 0.15, 0, -0.05);

      setPose('rightArm', s * 0.48 + 0.16, 0.08, -0.19 - Math.abs(s) * 0.05);
      setPose('elbowR', 0.40 + Math.max(0, s) * 0.24, 0, 0.06);
      setPose('handR', 0.18, 0, 0.06);

      // Articulated tail sways counter-phase to arm swing with natural traveling wave
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        const lagPhase = w - i * 0.42;
        tailTargetYaw[i] = -Math.sin(lagPhase) * (0.14 + i * 0.034);
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] + Math.cos(lagPhase * 2) * 0.032;
      }
      slerpRate = 12;
    } else if (state.anim === 'windup') {
      const backPitch = 16 * DEG2RAD;
      const tremor = Math.sin(animElapsed * 24) * 0.025;
      coreWarnMult = 1.38;
      targetTorsoScaleY = 1.022;
      targetBodyDrop = 0.02;

      setPose('hips', 0.06, -0.14, 0.04);
      setPose('torso', backPitch, -0.26, 0.08);
      setPose('head', -0.14, 0.22, -0.05);

      setPose('leftArm', 0.56, -0.20, 0.32);
      setPose('elbowL', 0.68, 0, -0.10);
      setPose('handL', 0.24, 0, -0.08);

      setPose('rightArm', -1.32 + tremor, 0.18, -0.66);
      setPose('elbowR', 0.82, 0, 0.22);
      setPose('handR', 0.34, 0, 0.14);

      setPose('thighL', 0.24, 0.12, 0.06);
      setPose('shinL', -0.34, 0, 0);
      setPose('footL', 0.10, 0, -0.06);
      setPose('thighR', -0.20, -0.10, -0.06);
      setPose('shinR', -0.24, 0, 0);
      setPose('footR', 0.38, 0, 0.06);

      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] - 0.12 - i * 0.028;
        tailTargetYaw[i] = -0.14 - i * 0.032;
      }
      slerpRate = 14;
    } else if (state.anim === 'attack') {
      const u = clamp01(animElapsed / ATTACK_DURATION);
      const smashEase = 1 - Math.pow(1 - u, 3);
      const armSwingX = lerp(-0.32, 1.38, smashEase);
      const torsoPitchX = lerp(0.08, -0.36, smashEase);

      coreWarnMult = lerp(1.36, 1.12, smashEase);
      targetBodyDrop = 0.07 * smashEase;
      targetTorsoScaleY = lerp(1.02, 0.99, smashEase);

      setPose('hips', -0.07 * smashEase, 0.20 * smashEase, -0.04);
      setPose('torso', torsoPitchX, lerp(-0.20, 0.36, smashEase), -0.10 * smashEase);
      setPose('head', lerp(-0.10, 0.22, smashEase), lerp(0.16, -0.26, smashEase), 0.06);

      setPose('leftArm', lerp(0.38, -0.58, smashEase), -0.16, 0.34);
      setPose('elbowL', lerp(0.56, 0.30, smashEase), 0, -0.08);
      setPose('handL', 0.18, 0, -0.08);

      setPose('rightArm', armSwingX, lerp(0.14, -0.24, smashEase), lerp(-0.44, -0.08, smashEase));
      setPose('elbowR', lerp(0.66, 0.22, smashEase), 0, 0.06);
      setPose('handR', 0.36, 0, 0.08);

      setPose('thighL', 0.34 * smashEase + 0.10, 0.08, 0.06);
      setPose('shinL', -0.44 * smashEase - 0.14, 0, 0);
      setPose('footL', 0.14, 0, -0.06);
      setPose('thighR', -0.26 * smashEase, -0.08, -0.06);
      setPose('shinR', -0.22, 0, 0);
      setPose('footR', 0.40 * smashEase + 0.10, 0, 0.06);

      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] - 0.09 * smashEase;
        tailTargetYaw[i] = lerp(-0.10, 0.20 + i * 0.036, smashEase);
      }
      slerpRate = 34;
    } else if (state.anim === 'recover') {
      const u = smoothstep(animElapsed / RECOVER_DURATION);
      targetBodyDrop = lerp(0.06, 0.010, u);
      targetTorsoScaleY = lerp(0.992, 1.01, u);

      setPose('hips', lerp(-0.05, 0, u), lerp(0.14, 0, u), lerp(-0.03, 0, u));
      setPose('torso', lerp(-0.28, -0.06, u), lerp(0.24, 0, u), lerp(-0.07, 0, u));
      setPose('head', lerp(0.18, 0.05, u), lerp(-0.18, 0, u), 0);

      setPose('leftArm', lerp(-0.36, 0.12, u), -0.08, lerp(0.26, 0.16, u));
      setPose('elbowL', lerp(0.26, 0.36, u), 0, -0.05);
      setPose('handL', 0.12, 0, -0.05);

      setPose('rightArm', lerp(0.96, 0.16, u), lerp(-0.14, 0.06, u), lerp(-0.10, -0.17, u));
      setPose('elbowR', lerp(0.24, 0.40, u), 0, 0.06);
      setPose('handR', lerp(0.28, 0.16, u), 0, 0.06);

      setPose('thighL', lerp(0.30, 0.06, u), 0.06, 0.04);
      setPose('shinL', lerp(-0.40, -0.10, u), 0, 0);
      setPose('footL', lerp(0.12, 0.04, u), 0, -0.04);
      setPose('thighR', lerp(-0.20, -0.04, u), -0.06, -0.04);
      setPose('shinR', lerp(-0.20, -0.07, u), 0, 0);
      setPose('footR', lerp(0.36, 0.11, u), 0, 0.04);

      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetYaw[i] = lerp(0.16, 0, u);
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] + lerp(0.08, 0, u);
      }
      slerpRate = 5.5;
    } else if (state.anim === 'charge') {
      const fwdPitch = -28 * DEG2RAD;
      const runW = animElapsed * 6.5 + 0.5;
      const s = Math.sin(runW);
      const c = Math.cos(runW);
      const stomp = Math.pow(Math.max(0, -Math.cos(runW * 2)), 2);

      coreWarnMult = 1.28;
      targetBodyDrop = 0.05 * stomp + 0.04;
      targetTorsoScaleY = 1.015;

      setPose('hips', -0.10, -s * 0.14, s * 0.06);
      setPose('torso', fwdPitch - 0.04 * stomp, s * 0.12, -s * 0.07);
      setPose('head', -0.42, -s * 0.08, 0);

      setPose('leftArm', -0.86 - s * 0.16, -0.16, 0.34);
      setPose('elbowL', 0.34, 0, -0.08);
      setPose('handL', 0.24, 0, -0.08);

      setPose('rightArm', -0.90 + s * 0.16, 0.16, -0.36);
      setPose('elbowR', 0.38, 0, 0.08);
      setPose('handR', 0.26, 0, 0.08);

      setPose('thighL', s * 0.62 + 0.12, 0.04, 0.04);
      setPose('shinL', -Math.max(0.14, -c * 0.72 + 0.20), 0, 0);
      setPose('footL', -s * 0.26 + 0.12, 0, -0.04);

      setPose('thighR', -s * 0.62 + 0.12, -0.04, -0.04);
      setPose('shinR', -Math.max(0.14, c * 0.72 + 0.20), 0, 0);
      setPose('footR', s * 0.26 + 0.12, 0, 0.04);

      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] * 0.45 - 0.06;
        tailTargetYaw[i] = -Math.sin(runW - i * 0.38) * (0.08 + i * 0.024);
      }
      slerpRate = 16;
    }

    const qAlpha = step > 0 ? 1 - Math.exp(-slerpRate * step) : 1;
    for (let i = 0; i < jointKeys.length; i++) {
      const key = jointKeys[i];
      const [rx, ry, rz] = targetPose[key];
      tmpEuler.set(rx, ry, rz, 'XYZ');
      tmpQuat.setFromEuler(tmpEuler);
      jointNodes[key].quaternion.slerp(tmpQuat, qAlpha);
    }

    const tailAlpha = step > 0 ? 1 - Math.exp(-12 * step) : 1;
    for (let i = 0; i < TAIL_SEG_COUNT; i++) {
      tmpEuler.set(tailTargetPitch[i], tailTargetYaw[i], 0, 'XYZ');
      tmpQuat.setFromEuler(tmpEuler);
      tailSegs[i].quaternion.slerp(tmpQuat, tailAlpha);
    }

    const scalarAlpha = step > 0 ? 1 - Math.exp(-14 * step) : 1;
    bodyDropCur += (targetBodyDrop - bodyDropCur) * scalarAlpha;
    body.position.y = BASE_HIP_Y - bodyDropCur;

    torsoScaleYCur += (targetTorsoScaleY - torsoScaleYCur) * scalarAlpha;
    torso.scale.set(1, torsoScaleYCur, 1);

    // Organic lava heating (Phase 2 / hpPct <= 0.35):
    //   - Magma fissures & chest core self-emissive intensify strongly like heating lava
    //   - Bone spike / horn / claw / tail-blade tips glow translucently amber-orange
    //   - ZERO whole-body red alarm flashing (skinMat.color never flashes!)
    const pulseFreq = 2.6 + (1 - hpPct) * 1.6 + moltenHeat * 1.2;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * pulseFreq);

    skinMat.emissive.copy(LAVA_EMISSIVE_P1).lerp(LAVA_EMISSIVE_P2, moltenHeat);
    skinMat.emissiveIntensity = (1.02 + moltenHeat * 1.55 + pulse * (0.12 + moltenHeat * 0.20)) * (coreWarnMult > 1.2 ? 1.10 : 1.0);

    coreMat.emissive.copy(CORE_EMISSIVE_P1).lerp(CORE_EMISSIVE_P2, moltenHeat);
    coreMat.emissiveIntensity = (1.48 + moltenHeat * 1.38 + pulse * (0.14 + moltenHeat * 0.22)) * coreWarnMult;

    boneMat.emissiveIntensity = 0.06 + moltenHeat * (1.22 + pulse * 0.16);

    const targetCoreScale = 1.0 + moltenHeat * 0.14 + pulse * (0.022 + moltenHeat * 0.028);
    coreScaleCur += (targetCoreScale - coreScaleCur) * scalarAlpha;
    core.scale.setScalar(coreScaleCur);

    eyeMat.emissiveIntensity = (3.1 + moltenHeat * 1.8 + pulse * 0.28) * (coreWarnMult > 1.2 ? 1.15 : 1.0);
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
      leftArm: armL.shoulder,
      rightArm: armR.shoulder,
      tail: tailRoot,
    },
    update,
    dispose,
  };
}
