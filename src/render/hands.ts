// Realistic articulated low-poly human hands (left & right) for FPS viewmodel:
//   - 5 separated fingers (thumb, index, middle, ring, pinky), 2 articulated
//     phalanx segments per finger (MCP + PIP/IP bends, 0°–85° keyframe range)
//   - Sculpted anatomical palm & dorsum with raised MCP knuckle topography
//   - Human skin PBR: roughness 0.55 + procedural skin/crease/nail texture +
//     warm-tinted subsurface envMap & wrap-diffuse shader approximation
//   - Half-finger tactical glove (knuckle guard + palm wrap) + BDU tactical
//     sleeve with stitched cuff & Velcro retention strap
//   - Strict geometry budget: <= 1200 triangles per hand (<= 2400 total),
//     rendered via 3 SkinnedMeshes per hand (only 6 draw calls for both hands!)

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { lerp } from './tween';

export type HandSide = 'left' | 'right';

export interface FingerAngles {
  /** Base joint (MCP / CMC) curl in degrees [0..85] */
  mcp: number;
  /** Second phalanx joint (PIP / IP) curl in degrees [0..85] */
  pip: number;
  /** Optional lateral splay/abduction in degrees [-20..25] */
  splay?: number;
}

export interface HandPose {
  thumb: FingerAngles;
  index: FingerAngles;
  middle: FingerAngles;
  ring: FingerAngles;
  pinky: FingerAngles;
  /** Optional thumb opposition rotation across palm (degrees [0..75]) */
  thumbOppose?: number;
  /** Optional wrist flexion (degrees) */
  wristPitch?: number;
  /** Optional wrist radial/ulnar deviation (degrees) */
  wristYaw?: number;
}

export function lerpHandPose(a: HandPose, b: HandPose, t: number, out?: HandPose): HandPose {
  const lf = (fa: FingerAngles, fb: FingerAngles): FingerAngles => ({
    mcp: lerp(fa.mcp, fb.mcp, t),
    pip: lerp(fa.pip, fb.pip, t),
    splay: lerp(fa.splay ?? 0, fb.splay ?? 0, t),
  });
  const res: HandPose = out ?? {
    thumb: { mcp: 0, pip: 0, splay: 0 },
    index: { mcp: 0, pip: 0, splay: 0 },
    middle: { mcp: 0, pip: 0, splay: 0 },
    ring: { mcp: 0, pip: 0, splay: 0 },
    pinky: { mcp: 0, pip: 0, splay: 0 },
    thumbOppose: 0,
    wristPitch: 0,
    wristYaw: 0,
  };
  res.thumb = lf(a.thumb, b.thumb);
  res.index = lf(a.index, b.index);
  res.middle = lf(a.middle, b.middle);
  res.ring = lf(a.ring, b.ring);
  res.pinky = lf(a.pinky, b.pinky);
  res.thumbOppose = lerp(a.thumbOppose ?? 35, b.thumbOppose ?? 35, t);
  res.wristPitch = lerp(a.wristPitch ?? 0, b.wristPitch ?? 0, t);
  res.wristYaw = lerp(a.wristYaw ?? 0, b.wristYaw ?? 0, t);
  return res;
}

// --- Procedural Canvas Textures & Warm Subsurface EnvMap (cached once) -------

let cachedMaterials: {
  skin: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  sleeve: THREE.MeshStandardMaterial;
} | null = null;

function makeWarmSkinEnvMap(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0.0, '#f3d4bc'); // warm overhead daylight
  g.addColorStop(0.45, '#e8a882'); // peach horizon scattering
  g.addColorStop(0.70, '#c86f4d'); // subsurface crimson-warm bounce
  g.addColorStop(1.0, '#6b3a28'); // deep warm shadow floor
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 64);
  // Warm sun highlight lobe
  const sun = ctx.createRadialGradient(88, 22, 2, 88, 22, 28);
  sun.addColorStop(0, '#fff2df');
  sun.addColorStop(0.5, 'rgba(255, 200, 155, 0.55)');
  sun.addColorStop(1, 'rgba(255, 180, 130, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeSkinTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  // Base natural warm skin gradient along V (0 = wrist/base, 1 = fingertip)
  const bg = ctx.createLinearGradient(0, 256, 0, 0);
  bg.addColorStop(0.0, '#c88d6b');
  bg.addColorStop(0.35, PALETTE.skinBase);
  bg.addColorStop(0.75, '#daa685');
  bg.addColorStop(1.0, '#d69878');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 256);

  // Subtle dermal pore variation & warm blood-flow patches
  for (let i = 0; i < 900; i++) {
    const x = (i * 73) % 256;
    const y = (i * 137) % 256;
    const r = 1 + (i % 3);
    ctx.fillStyle = i % 2 === 0 ? 'rgba(176, 98, 70, 0.065)' : 'rgba(248, 214, 188, 0.055)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Knuckle crease wrinkles & warm flush bands at V ~ 0.35 and V ~ 0.65
  for (const cy of [92, 168]) {
    const kg = ctx.createLinearGradient(0, cy - 16, 0, cy + 16);
    kg.addColorStop(0, 'rgba(170, 88, 62, 0)');
    kg.addColorStop(0.5, 'rgba(170, 88, 62, 0.20)');
    kg.addColorStop(1, 'rgba(170, 88, 62, 0)');
    ctx.fillStyle = kg;
    ctx.fillRect(0, cy - 16, 256, 32);
    ctx.strokeStyle = 'rgba(115, 62, 44, 0.28)';
    ctx.lineWidth = 1.5;
    for (let k = -4; k <= 4; k += 4) {
      ctx.beginPath();
      ctx.moveTo(0, cy + k);
      ctx.lineTo(256, cy + k);
      ctx.stroke();
    }
  }

  // Fingernail band at top strip (V > 0.84, dorsal side U in [0.22..0.78])
  ctx.fillStyle = PALETTE.skinNail;
  ctx.beginPath();
  ctx.roundRect(56, 6, 144, 34, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(165, 110, 90, 0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Pale nail lunula crescent at base of nail
  ctx.fillStyle = 'rgba(255, 240, 232, 0.55)';
  ctx.beginPath();
  ctx.ellipse(128, 36, 42, 8, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeGloveTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = PALETTE.tacGlove;
  ctx.fillRect(0, 0, 256, 256);

  // Ripstop tactical fabric micro-grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 256; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i, 256);
    ctx.moveTo(0, i); ctx.lineTo(256, i);
    ctx.stroke();
  }
  // Leather reinforcement palm strips & stitching
  ctx.fillStyle = 'rgba(20, 24, 30, 0.35)';
  ctx.fillRect(0, 96, 256, 64);
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = PALETTE.tacStitch;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 98); ctx.lineTo(256, 98);
  ctx.moveTo(0, 158); ctx.lineTo(256, 158);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeSleeveTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = PALETTE.tacSleeve;
  ctx.fillRect(0, 0, 256, 256);

  // Tactical ripstop BDU fabric weave
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 256; i += 6) {
    ctx.beginPath();
    ctx.moveTo(i, 0); ctx.lineTo(i, 256);
    ctx.moveTo(0, i); ctx.lineTo(256, i);
    ctx.stroke();
  }
  // Subtle digital/tactical cloth creases
  ctx.fillStyle = 'rgba(12, 18, 28, 0.18)';
  for (let i = 0; i < 8; i++) {
    ctx.fillRect((i * 47) % 220, (i * 31) % 200, 48, 22);
  }
  // Cuff darker band near V=0..0.28 + double-row cuff stitching (缝线)
  ctx.fillStyle = PALETTE.tacCuff;
  ctx.fillRect(0, 184, 256, 72);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = PALETTE.tacStitch;
  ctx.lineWidth = 2;
  for (const sy of [188, 195, 242, 248]) {
    ctx.beginPath();
    ctx.moveTo(0, sy); ctx.lineTo(256, sy);
    ctx.stroke();
  }
  // Forearm vertical seam double-stitch
  ctx.beginPath();
  ctx.moveTo(124, 0); ctx.lineTo(124, 184);
  ctx.moveTo(132, 0); ctx.lineTo(132, 184);
  ctx.stroke();
  ctx.setLineDash([]);

  // Velcro patch zone near cuff
  ctx.fillStyle = PALETTE.tacVelcro;
  ctx.fillRect(16, 202, 88, 32);
  ctx.strokeStyle = 'rgba(130, 148, 168, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(18, 204, 84, 28);
  // Hook-and-loop stipple dots on Velcro
  ctx.fillStyle = 'rgba(160, 175, 190, 0.16)';
  for (let vx = 22; vx < 98; vx += 4) {
    for (let vy = 208; vy < 230; vy += 4) {
      ctx.fillRect(vx, vy, 1.5, 1.5);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function getHandMaterials() {
  if (cachedMaterials) return cachedMaterials;

  const skinEnv = makeWarmSkinEnvMap();
  const skin = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: makeSkinTexture(),
    roughness: 0.55,
    metalness: 0.02,
    envMap: skinEnv,
    envMapIntensity: 1.25,
    emissive: new THREE.Color(PALETTE.skinWarm),
    emissiveIntensity: 0.08,
  });
  // Warm subsurface scattering approximation (wrap diffuse + warm crimson edge scatter)
  skin.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
        vec3 sV = normalize( vViewPosition );
        float rimSss = pow( 1.0 - clamp( dot( normal, sV ), 0.0, 1.0 ), 2.2 );
        outgoingLight += vec3( 0.24, 0.075, 0.042 ) * ( 0.28 + rimSss * 0.65 );
      }
      #include <opaque_fragment>`,
    );
  };
  skin.customProgramCacheKey = () => 'human-skin-sss-v1';

  const glove = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: makeGloveTexture(),
    roughness: 0.82,
    metalness: 0.08,
    envMapIntensity: 0.9,
    emissive: new THREE.Color(PALETTE.tacGlove),
    emissiveIntensity: 0.14,
  });

  const sleeve = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: makeSleeveTexture(),
    roughness: 0.85,
    metalness: 0.05,
    envMapIntensity: 0.85,
    emissive: new THREE.Color(PALETTE.tacSleeve),
    emissiveIntensity: 0.14,
  });

  cachedMaterials = { skin, glove, sleeve };
  return cachedMaterials;
}

// --- Low-Poly Anatomical Loft & Skinning Helpers -----------------------------

/** Tag every vertex of `geo` with skinIndex & skinWeight (supports smooth 2-bone blend). */
function attachSkinWeights(
  geo: THREE.BufferGeometry,
  boneA: number,
  boneB = boneA,
  weightFn?: (x: number, y: number, z: number) => number,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const wB =
      boneB === boneA || !weightFn
        ? 0
        : Math.max(0, Math.min(1, weightFn(pos.getX(i), pos.getY(i), pos.getZ(i))));
    const wA = 1 - wB;
    indices[i * 4] = boneA;
    indices[i * 4 + 1] = boneB;
    indices[i * 4 + 2] = 0;
    indices[i * 4 + 3] = 0;
    weights[i * 4] = wA;
    weights[i * 4 + 1] = wB;
    weights[i * 4 + 2] = 0;
    weights[i * 4 + 3] = 0;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/**
 * Build an anatomically sculpted lofted tube along -Z (from z=0 to z=-len)
 * with elliptical cross-section, knuckle ridge bumps, and optional rounded fingertip.
 * Radial segments kept at 6–8 so each hand stays strictly <= 1200 triangles.
 */
function buildLoftedSegment(opts: {
  rings: { z: number; rx: number; ry: number; cy?: number; cx?: number; v: number; dorsumRidge?: number }[];
  radialSegs: number;
  capStart?: boolean;
  capEnd?: boolean;
  domeTipLen?: number;
}): THREE.BufferGeometry {
  const { rings, radialSegs, capStart = true, capEnd = true, domeTipLen = 0 } = opts;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const allRings = [...rings];
  if (domeTipLen > 0) {
    const last = rings[rings.length - 1];
    allRings.push({
      z: last.z - domeTipLen * 0.55,
      rx: last.rx * 0.72,
      ry: last.ry * 0.68,
      cx: last.cx,
      cy: (last.cy ?? 0) - last.ry * 0.08,
      v: Math.min(0.96, last.v + 0.08),
    });
    allRings.push({
      z: last.z - domeTipLen,
      rx: last.rx * 0.25,
      ry: last.ry * 0.22,
      cx: last.cx,
      cy: (last.cy ?? 0) - last.ry * 0.14,
      v: 0.99,
    });
  }

  const stride = radialSegs + 1;
  for (let r = 0; r < allRings.length; r++) {
    const ring = allRings[r];
    const cx = ring.cx ?? 0;
    const cy = ring.cy ?? 0;
    const ridge = ring.dorsumRidge ?? 0;
    for (let s = 0; s <= radialSegs; s++) {
      const u = s / radialSegs;
      const ang = u * Math.PI * 2;
      // cos(ang) along X, sin(ang) along Y (+Y is dorsum / nail side)
      let x = cx + Math.cos(ang) * ring.rx;
      let y = cy + Math.sin(ang) * ring.ry;
      // Subtle anatomical dorsal bone undulation when dorsumRidge > 0
      if (ridge > 0 && Math.sin(ang) > 0.25) {
        const wave = Math.sin(Math.cos(ang) * Math.PI * 4) * 0.5 + 0.5;
        y += ridge * wave * Math.sin(ang);
      }
      positions.push(x, y, ring.z);
      uvs.push(u, ring.v);
    }
  }

  for (let r = 0; r < allRings.length - 1; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const a = r * stride + s;
      const b = a + 1;
      const c = (r + 1) * stride + s;
      const d = c + 1;
      // Ring increases along -Z, ang increases CCW in XY: outward normal = (a, b, c) & (b, d, c)
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  if (capStart) {
    const r0 = allRings[0];
    const centerIdx = positions.length / 3;
    positions.push(r0.cx ?? 0, r0.cy ?? 0, r0.z);
    uvs.push(0.5, r0.v);
    for (let s = 0; s < radialSegs; s++) {
      indices.push(centerIdx, s + 1, s);
    }
  }
  if (capEnd) {
    const lastIdx = allRings.length - 1;
    const rLast = allRings[lastIdx];
    const centerIdx = positions.length / 3;
    positions.push(rLast.cx ?? 0, rLast.cy ?? 0, rLast.z - (domeTipLen > 0 ? 0.001 : 0));
    uvs.push(0.5, rLast.v);
    const base = lastIdx * stride;
    for (let s = 0; s < radialSegs; s++) {
      indices.push(centerIdx, base + s, base + s + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Build a single 2-segment finger geometry in palm bind space (proximal + distal). */
function buildFingerSkinned(opts: {
  basePos: THREE.Vector3;
  baseYaw: number;
  baseRoll: number;
  proxLen: number;
  distLen: number;
  rBase: number;
  rMid: number;
  rTip: number;
  palmBone: number;
  proxBone: number;
  distBone: number;
  radialSegs: number;
}): THREE.BufferGeometry {
  const {
    basePos,
    baseYaw,
    baseRoll,
    proxLen,
    distLen,
    rBase,
    rMid,
    rTip,
    palmBone,
    proxBone,
    distBone,
    radialSegs,
  } = opts;

  // Continuous 2-phalanx sculpted finger mesh (zero seam gap at PIP knuckle!)
  const geo = buildLoftedSegment({
    radialSegs,
    capStart: true,
    capEnd: true,
    domeTipLen: rTip * 1.15,
    rings: [
      { z: 0.003, rx: rBase * 1.04, ry: rBase * 0.94, v: 0.08 },
      // MCP knuckle flare
      { z: -proxLen * 0.14, rx: rBase * 1.06, ry: rBase * 1.00, cy: 0.0008, v: 0.20 },
      // Proximal shaft taper
      { z: -proxLen * 0.65, rx: rBase * 0.93, ry: rBase * 0.86, v: 0.36 },
      // PIP joint subtle knuckle swell
      { z: -proxLen, rx: rMid * 1.04, ry: rMid * 0.98, cy: 0.0010, v: 0.52 },
      // Distal shaft taper
      { z: -(proxLen + distLen * 0.58), rx: rTip * 1.06, ry: rTip * 0.90, v: 0.74 },
      // Fingernail / distal tip base
      { z: -(proxLen + distLen), rx: rTip * 0.95, ry: rTip * 0.78, v: 0.88 },
    ],
  });

  // Compute smooth skin weights in finger-local coordinates BEFORE transforming into palm space
  const nonIdx = geo.toNonIndexed();
  const pos = nonIdx.getAttribute('position') as THREE.BufferAttribute;
  const count = pos.count;
  const skinIdx = new Uint16Array(count * 4);
  const skinW = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const lz = pos.getZ(i); // 0 at MCP, -proxLen at PIP, -(proxLen+distLen) at tip
    if (lz >= -proxLen * 0.18) {
      // Blend smoothly between palm & proximal bone at MCP crease
      const u = Math.max(0, Math.min(1, (-lz + 0.003) / (proxLen * 0.22)));
      skinIdx[i * 4] = proxBone;
      skinIdx[i * 4 + 1] = palmBone;
      skinW[i * 4] = 0.25 + u * 0.75;
      skinW[i * 4 + 1] = 1 - skinW[i * 4];
    } else if (lz >= -(proxLen - 0.005)) {
      skinIdx[i * 4] = proxBone;
      skinW[i * 4] = 1;
    } else if (lz >= -(proxLen + 0.007)) {
      // Smooth PIP joint bend zone
      const u = (-lz - (proxLen - 0.005)) / 0.012;
      skinIdx[i * 4] = distBone;
      skinIdx[i * 4 + 1] = proxBone;
      skinW[i * 4] = Math.max(0, Math.min(1, u));
      skinW[i * 4 + 1] = 1 - skinW[i * 4];
    } else {
      skinIdx[i * 4] = distBone;
      skinW[i * 4] = 1;
    }
  }
  nonIdx.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4));
  nonIdx.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4));

  // Transform vertices from finger-local into palm bind-pose space
  const mat = new THREE.Matrix4().compose(
    basePos,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, baseYaw, baseRoll, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
  nonIdx.applyMatrix4(mat);
  nonIdx.computeVertexNormals();
  return nonIdx;
}

// --- Bone indices ---
const B_PALM = 0;
const B_THUMB0 = 1;
const B_THUMB1 = 2;
const B_INDEX0 = 3;
const B_INDEX1 = 4;
const B_MID0 = 5;
const B_MID1 = 6;
const B_RING0 = 7;
const B_RING1 = 8;
const B_PINKY0 = 9;
const B_PINKY1 = 10;
const B_FOREARM = 11;

const DEG = Math.PI / 180;

export class HumanHand {
  readonly side: HandSide;
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  readonly skeleton: THREE.Skeleton;
  readonly triangleCount: number;
  readonly skinMesh: THREE.SkinnedMesh;
  readonly gloveMesh: THREE.SkinnedMesh;
  readonly sleeveMesh: THREE.SkinnedMesh;

  private readonly thumbBaseEuler: THREE.Euler;
  private readonly fingerBaseYaws: number[];
  private readonly fingerBaseRolls: number[];
  private readonly sign: number;

  constructor(side: HandSide) {
    this.side = side;
    // Left hand: thumb on +X, pinky on -X; Right hand mirrors X cleanly (thumb on -X, pinky on +X)
    const s = side === 'left' ? 1 : -1;
    this.sign = s;
    this.root.name = `human-hand-${side}`;

    // --- 1. Build 12-bone anatomical hand skeleton ---
    const palm = new THREE.Bone();
    palm.name = `${side}-palm`;

    // Finger MCP attachment positions & anatomical lengths (meters)
    // Palm spans z ∈ [+0.048 (wrist) .. -0.044 (knuckles)], x width ≈ 0.082m
    const thumbPos = new THREE.Vector3(s * 0.036, -0.008, 0.012);
    const thumbYaw = -s * 0.56;
    const thumbRoll = -s * 0.72;
    this.thumbBaseEuler = new THREE.Euler(-0.14, thumbYaw, thumbRoll, 'YXZ');

    const fingerSpecs = [
      { name: 'index', pos: new THREE.Vector3(s * 0.029, 0.001, -0.043), yaw: -s * 0.05, roll: -s * 0.06, prox: 0.042, dist: 0.035, rb: 0.0088, rm: 0.0078, rt: 0.0068 },
      { name: 'middle', pos: new THREE.Vector3(s * 0.009, 0.003, -0.046), yaw: 0, roll: 0, prox: 0.047, dist: 0.038, rb: 0.0091, rm: 0.0080, rt: 0.0070 },
      { name: 'ring', pos: new THREE.Vector3(-s * 0.011, 0.001, -0.044), yaw: s * 0.04, roll: s * 0.05, prox: 0.043, dist: 0.035, rb: 0.0085, rm: 0.0075, rt: 0.0065 },
      { name: 'pinky', pos: new THREE.Vector3(-s * 0.030, -0.002, -0.039), yaw: s * 0.10, roll: s * 0.12, prox: 0.034, dist: 0.027, rb: 0.0074, rm: 0.0065, rt: 0.0056 },
    ];
    this.fingerBaseYaws = fingerSpecs.map((f) => f.yaw);
    this.fingerBaseRolls = fingerSpecs.map((f) => f.roll);

    const thumb0 = new THREE.Bone();
    thumb0.name = `${side}-thumb0`;
    thumb0.position.copy(thumbPos);
    thumb0.rotation.copy(this.thumbBaseEuler);
    const thumb1 = new THREE.Bone();
    thumb1.name = `${side}-thumb1`;
    thumb1.position.set(0, 0, -0.034);
    thumb0.add(thumb1);
    palm.add(thumb0);

    const fingerBones: [THREE.Bone, THREE.Bone][] = [];
    for (const f of fingerSpecs) {
      const b0 = new THREE.Bone();
      b0.name = `${side}-${f.name}0`;
      b0.position.copy(f.pos);
      b0.rotation.set(0, f.yaw, f.roll, 'YXZ');
      const b1 = new THREE.Bone();
      b1.name = `${side}-${f.name}1`;
      b1.position.set(0, 0, -f.prox);
      b0.add(b1);
      palm.add(b0);
      fingerBones.push([b0, b1]);
    }

    const forearm = new THREE.Bone();
    forearm.name = `${side}-forearm`;
    forearm.position.set(0, -0.002, 0.048);
    palm.add(forearm);

    this.bones = [
      palm,
      thumb0,
      thumb1,
      fingerBones[0][0],
      fingerBones[0][1],
      fingerBones[1][0],
      fingerBones[1][1],
      fingerBones[2][0],
      fingerBones[2][1],
      fingerBones[3][0],
      fingerBones[3][1],
      forearm,
    ];
    this.root.add(palm);
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);

    // --- 2. Build Skin Geometry (palm skin + knuckle domes + 5 articulated 2-segment fingers) ---
    const skinParts: THREE.BufferGeometry[] = [];

    // Sculpted palm core (wrist → metacarpals → knuckle arch with dorsal bone undulation)
    const palmCore = buildLoftedSegment({
      radialSegs: 8,
      capStart: true,
      capEnd: true,
      rings: [
        { z: 0.048, rx: 0.030, ry: 0.017, cy: -0.002, v: 0.05 },
        { z: 0.022, rx: 0.038, ry: 0.019, cx: s * 0.004, cy: -0.002, v: 0.16, dorsumRidge: 0.0022 },
        { z: -0.012, rx: 0.042, ry: 0.017, cx: s * 0.002, cy: 0.000, v: 0.28, dorsumRidge: 0.0032 },
        { z: -0.043, rx: 0.040, ry: 0.014, cy: 0.001, v: 0.42, dorsumRidge: 0.0036 },
      ],
    });
    skinParts.push(attachSkinWeights(palmCore, B_PALM));

    // Fleshy thenar thumb-base muscle pad on palm radial side
    const thenar = new THREE.SphereGeometry(0.018, 6, 5);
    thenar.scale(1.0, 0.72, 1.35);
    thenar.translate(s * 0.024, -0.012, 0.014);
    skinParts.push(attachSkinWeights(thenar, B_PALM, B_THUMB0, (_x, _y, z) => (z < 0.010 ? 0.35 : 0)));

    // 4 raised anatomical MCP knuckle bone prominences along dorsum edge
    for (const f of fingerSpecs) {
      const kDome = new THREE.SphereGeometry(f.rb * 0.96, 6, 4);
      kDome.scale(1.05, 0.82, 1.05);
      kDome.translate(f.pos.x, f.pos.y + 0.0065, f.pos.z + 0.005);
      skinParts.push(attachSkinWeights(kDome, B_PALM));
    }

    // Articulated 2-segment Thumb (in palm bind space matching thumb0's initial transform)
    const thumbGeo = buildLoftedSegment({
      radialSegs: 6,
      capStart: true,
      capEnd: true,
      domeTipLen: 0.011,
      rings: [
        { z: 0.003, rx: 0.0118, ry: 0.0105, v: 0.10 },
        { z: -0.018, rx: 0.0106, ry: 0.0096, v: 0.32 },
        { z: -0.034, rx: 0.0105, ry: 0.0095, cy: 0.001, v: 0.52 },
        { z: -0.052, rx: 0.0096, ry: 0.0084, v: 0.74 },
        { z: -0.064, rx: 0.0090, ry: 0.0074, v: 0.88 },
      ],
    }).toNonIndexed();
    {
      const pAttr = thumbGeo.getAttribute('position') as THREE.BufferAttribute;
      const cnt = pAttr.count;
      const sIdx = new Uint16Array(cnt * 4);
      const sW = new Float32Array(cnt * 4);
      for (let i = 0; i < cnt; i++) {
        const lz = pAttr.getZ(i);
        if (lz >= -0.029) {
          sIdx[i * 4] = B_THUMB0;
          sW[i * 4] = 1;
        } else if (lz >= -0.039) {
          const u = (-lz - 0.029) / 0.010;
          sIdx[i * 4] = B_THUMB1;
          sIdx[i * 4 + 1] = B_THUMB0;
          sW[i * 4] = u;
          sW[i * 4 + 1] = 1 - u;
        } else {
          sIdx[i * 4] = B_THUMB1;
          sW[i * 4] = 1;
        }
      }
      thumbGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
      thumbGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sW, 4));
      const tm = new THREE.Matrix4().compose(
        thumbPos,
        new THREE.Quaternion().setFromEuler(this.thumbBaseEuler),
        new THREE.Vector3(1, 1, 1),
      );
      thumbGeo.applyMatrix4(tm);
      thumbGeo.computeVertexNormals();
      skinParts.push(thumbGeo);
    }

    // Articulated 2-segment Index, Middle, Ring, Pinky (all 4 cleanly separated!)
    const fBonePairs: [number, number][] = [
      [B_INDEX0, B_INDEX1],
      [B_MID0, B_MID1],
      [B_RING0, B_RING1],
      [B_PINKY0, B_PINKY1],
    ];
    for (let i = 0; i < fingerSpecs.length; i++) {
      const f = fingerSpecs[i];
      skinParts.push(
        buildFingerSkinned({
          basePos: f.pos,
          baseYaw: f.yaw,
          baseRoll: f.roll,
          proxLen: f.prox,
          distLen: f.dist,
          rBase: f.rb,
          rMid: f.rm,
          rTip: f.rt,
          palmBone: B_PALM,
          proxBone: fBonePairs[i][0],
          distBone: fBonePairs[i][1],
          radialSegs: 6,
        }),
      );
    }

    // --- 3. Build Tactical Half-Finger Glove Mesh (covers palm/back up to knuckle line) ---
    const gloveParts: THREE.BufferGeometry[] = [];
    const gloveWrap = buildLoftedSegment({
      radialSegs: 8,
      capStart: false,
      capEnd: false,
      rings: [
        { z: 0.044, rx: 0.0325, ry: 0.0195, cy: -0.002, v: 0.12 },
        { z: 0.016, rx: 0.0405, ry: 0.0215, cx: s * 0.003, cy: -0.002, v: 0.42 },
        { z: -0.014, rx: 0.0445, ry: 0.0195, cx: s * 0.002, cy: 0.000, v: 0.72, dorsumRidge: 0.004 },
        { z: -0.034, rx: 0.0430, ry: 0.0165, cy: 0.001, v: 0.94, dorsumRidge: 0.0045 },
      ],
    });
    gloveParts.push(attachSkinWeights(gloveWrap, B_PALM));

    // Molded tactical knuckle armor ridge strip across hand dorsum (4 raised domes)
    const knuckleBar = new THREE.BoxGeometry(0.072, 0.008, 0.018);
    knuckleBar.translate(0, 0.0165, -0.025);
    gloveParts.push(attachSkinWeights(knuckleBar, B_PALM));
    for (const f of fingerSpecs) {
      const cap = new THREE.BoxGeometry(0.014, 0.007, 0.014);
      cap.translate(f.pos.x, 0.0205, -0.026);
      gloveParts.push(attachSkinWeights(cap, B_PALM));
    }

    // --- 4. Build Tactical Sleeve + Stitched Cuff + Velcro Strap (bound to forearm bone) ---
    const sleeveParts: THREE.BufferGeometry[] = [];
    // Forearm BDU sleeve extending from wrist (+0.048) to elbow (+0.34)
    const forearmTube = buildLoftedSegment({
      radialSegs: 8,
      capStart: true,
      capEnd: true,
      rings: [
        { z: 0.34, rx: 0.046, ry: 0.042, cy: -0.004, v: 0.02 },
        { z: 0.24, rx: 0.042, ry: 0.038, cy: -0.003, v: 0.34 },
        { z: 0.14, rx: 0.037, ry: 0.032, cy: -0.002, v: 0.65 },
        { z: 0.078, rx: 0.035, ry: 0.028, cy: -0.002, v: 0.74 },
        { z: 0.044, rx: 0.034, ry: 0.024, cy: -0.002, v: 0.98 },
      ],
    });
    sleeveParts.push(attachSkinWeights(forearmTube, B_FOREARM));

    // Thickened stitched cuff collar ring at wrist
    const cuffRing = buildLoftedSegment({
      radialSegs: 8,
      capStart: true,
      capEnd: true,
      rings: [
        { z: 0.084, rx: 0.0385, ry: 0.031, cy: -0.002, v: 0.76 },
        { z: 0.046, rx: 0.0375, ry: 0.027, cy: -0.002, v: 0.96 },
      ],
    });
    sleeveParts.push(attachSkinWeights(cuffRing, B_FOREARM));

    // Raised Velcro retention strap tab wrapping across outer/dorsal wrist cuff (魔术贴)
    const velcroTab = new THREE.BoxGeometry(0.042, 0.007, 0.022);
    velcroTab.translate(-s * 0.010, 0.029, 0.064);
    sleeveParts.push(attachSkinWeights(velcroTab, B_FOREARM));
    // Velcro buckle side loop
    const velcroSide = new THREE.BoxGeometry(0.008, 0.024, 0.020);
    velcroSide.translate(-s * 0.036, 0.010, 0.064);
    sleeveParts.push(attachSkinWeights(velcroSide, B_FOREARM));

    // Merge each material group into ONE SkinnedMesh (total = 3 draw calls per hand!)
    const mats = getHandMaterials();
    const skinGeo = mergeGeometries(skinParts, false)!;
    const gloveGeo = mergeGeometries(gloveParts, false)!;
    const sleeveGeo = mergeGeometries(sleeveParts, false)!;

    this.skinMesh = new THREE.SkinnedMesh(skinGeo, mats.skin);
    this.gloveMesh = new THREE.SkinnedMesh(gloveGeo, mats.glove);
    this.sleeveMesh = new THREE.SkinnedMesh(sleeveGeo, mats.sleeve);

    for (const m of [this.skinMesh, this.gloveMesh, this.sleeveMesh]) {
      m.frustumCulled = false;
      m.bind(this.skeleton);
      this.root.add(m);
    }

    const triOf = (g: THREE.BufferGeometry) =>
      g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    this.triangleCount = Math.round(triOf(skinGeo) + triOf(gloveGeo) + triOf(sleeveGeo));
  }

  /** Apply articulated finger joint angles (degrees, clamped to 0..85° per spec). */
  setPose(pose: HandPose): void {
    const clampDeg = (d: number) => Math.max(0, Math.min(85, d));
    const s = this.sign;

    // Thumb: oppose rotates inward across palm + curl bends CMC & IP joints
    const opp = Math.max(0, Math.min(75, pose.thumbOppose ?? 35)) * DEG;
    const tMcp = clampDeg(pose.thumb.mcp) * DEG;
    const tPip = clampDeg(pose.thumb.pip) * DEG;
    const tSplay = (pose.thumb.splay ?? 0) * DEG;
    this.bones[B_THUMB0].rotation.set(
      this.thumbBaseEuler.x - tMcp * 0.85,
      this.thumbBaseEuler.y + s * (opp * 0.72 + tSplay),
      this.thumbBaseEuler.z - s * opp * 0.32,
      'YXZ',
    );
    this.bones[B_THUMB1].rotation.set(-tPip, 0, 0);

    // Index, Middle, Ring, Pinky: MCP + PIP curl around local X (negative = curl into palm)
    const fingers: [number, number, FingerAngles, number][] = [
      [B_INDEX0, B_INDEX1, pose.index, 0],
      [B_MID0, B_MID1, pose.middle, 1],
      [B_RING0, B_RING1, pose.ring, 2],
      [B_PINKY0, B_PINKY1, pose.pinky, 3],
    ];
    for (const [b0, b1, ang, idx] of fingers) {
      const mcp = clampDeg(ang.mcp) * DEG;
      const pip = clampDeg(ang.pip) * DEG;
      const splay = (ang.splay ?? 0) * DEG;
      this.bones[b0].rotation.set(
        -mcp,
        this.fingerBaseYaws[idx] + s * splay,
        this.fingerBaseRolls[idx],
        'YXZ',
      );
      this.bones[b1].rotation.set(-pip, 0, 0);
    }

    // Subtle natural wrist flexion
    const wp = (pose.wristPitch ?? 0) * DEG;
    const wy = (pose.wristYaw ?? 0) * DEG;
    this.bones[B_FOREARM].rotation.set(wp, wy, 0);
  }

  /**
   * Aim the forearm smoothly from the wrist toward a virtual elbow/shoulder target
   * in the parent (gun) coordinate space so sleeves exit naturally off-screen.
   */
  aimForearmToward(targetInGunSpace: THREE.Vector3): void {
    const forearm = this.bones[B_FOREARM];
    // Convert target from gun space into palm local space
    this.root.updateMatrix();
    const invPalm = _tmpMat.copy(this.root.matrix).invert();
    const localTarget = _tmpVec.copy(targetInGunSpace).applyMatrix4(invPalm);
    const dir = localTarget.sub(forearm.position);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    // Forearm mesh extends along local +Z
    _tmpQuat.setFromUnitVectors(_POS_Z, dir);
    forearm.quaternion.copy(_tmpQuat);
  }
}

const _tmpMat = new THREE.Matrix4();
const _tmpVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _POS_Z = new THREE.Vector3(0, 0, 1);

// --- Standard Articulated Hand Poses (all angles strictly in 0°–85°) ---------

export const HAND_POSES = {
  /** Left hand cradling rifle handguard from below-left */
  rifleLeftRest: {
    thumb: { mcp: 22, pip: 18, splay: 10 },
    index: { mcp: 46, pip: 52, splay: 4 },
    middle: { mcp: 54, pip: 60, splay: 0 },
    ring: { mcp: 58, pip: 64, splay: -3 },
    pinky: { mcp: 62, pip: 68, splay: -6 },
    thumbOppose: 28,
  } as HandPose,

  /** Stage ①: Left hand releases handguard — all 5 fingers open straight (0–12°) */
  leftOpenSpread: {
    thumb: { mcp: 6, pip: 8, splay: 18 },
    index: { mcp: 5, pip: 8, splay: 12 },
    middle: { mcp: 4, pip: 6, splay: 2 },
    ring: { mcp: 7, pip: 10, splay: -6 },
    pinky: { mcp: 10, pip: 12, splay: -14 },
    thumbOppose: 12,
  } as HandPose,

  /** Stage ②a: Left thumb presses magazine release latch while fingers close on mag */
  leftThumbRelease: {
    thumb: { mcp: 64, pip: 58, splay: 4 },
    index: { mcp: 42, pip: 48, splay: 4 },
    middle: { mcp: 56, pip: 62, splay: 0 },
    ring: { mcp: 62, pip: 68, splay: -2 },
    pinky: { mcp: 66, pip: 70, splay: -4 },
    thumbOppose: 58,
  } as HandPose,

  /** Stage ②b: Left hand catches falling magazine firmly */
  leftCatchMag: {
    thumb: { mcp: 52, pip: 48, splay: 0 },
    index: { mcp: 70, pip: 76, splay: 2 },
    middle: { mcp: 74, pip: 80, splay: 0 },
    ring: { mcp: 76, pip: 82, splay: -2 },
    pinky: { mcp: 78, pip: 82, splay: -4 },
    thumbOppose: 52,
  } as HandPose,

  /** Stage ③: Left hand emerging from belt with open cupped grip holding fresh mag */
  leftHoldFreshMag: {
    thumb: { mcp: 28, pip: 22, splay: 12 },
    index: { mcp: 34, pip: 38, splay: 10 },
    middle: { mcp: 40, pip: 46, splay: 2 },
    ring: { mcp: 44, pip: 50, splay: -4 },
    pinky: { mcp: 48, pip: 54, splay: -10 },
    thumbOppose: 36,
  } as HandPose,

  /** Stage ④a: Palm pushing fresh magazine base up into magwell */
  leftPushMag: {
    thumb: { mcp: 32, pip: 28, splay: 8 },
    index: { mcp: 24, pip: 30, splay: 8 },
    middle: { mcp: 28, pip: 34, splay: 2 },
    ring: { mcp: 34, pip: 38, splay: -4 },
    pinky: { mcp: 38, pip: 42, splay: -8 },
    thumbOppose: 34,
  } as HandPose,

  /** Stage ④b: Left thumb presses upward to confirm mag lock */
  leftThumbConfirm: {
    thumb: { mcp: 72, pip: 68, splay: 2 },
    index: { mcp: 14, pip: 18, splay: 10 },
    middle: { mcp: 18, pip: 22, splay: 2 },
    ring: { mcp: 22, pip: 26, splay: -4 },
    pinky: { mcp: 26, pip: 30, splay: -8 },
    thumbOppose: 64,
  } as HandPose,

  /** Right hand rest on pistol grip: thumb wraps left tang, index on trigger, 3 fingers wrap */
  rifleRightRest: {
    thumb: { mcp: 48, pip: 42, splay: 6 },
    index: { mcp: 18, pip: 46, splay: 4 },
    middle: { mcp: 70, pip: 76, splay: 0 },
    ring: { mcp: 74, pip: 80, splay: -2 },
    pinky: { mcp: 78, pip: 82, splay: -5 },
    thumbOppose: 54,
  } as HandPose,

  /** Stage ⑤a: Right hand releases grip — index off trigger straight, palm turns sideways */
  rightReleaseToBolt: {
    thumb: { mcp: 18, pip: 14, splay: 14 },
    index: { mcp: 6, pip: 10, splay: 10 },
    middle: { mcp: 18, pip: 22, splay: 2 },
    ring: { mcp: 28, pip: 32, splay: -4 },
    pinky: { mcp: 34, pip: 38, splay: -8 },
    thumbOppose: 22,
  } as HandPose,

  /** Stage ⑤b: Right hand hooks & pulls charging handle rearward */
  rightRackBolt: {
    thumb: { mcp: 42, pip: 38, splay: 6 },
    index: { mcp: 76, pip: 84, splay: 2 },
    middle: { mcp: 72, pip: 80, splay: 0 },
    ring: { mcp: 52, pip: 58, splay: -4 },
    pinky: { mcp: 46, pip: 52, splay: -8 },
    thumbOppose: 44,
  } as HandPose,

  /** Gatling left hand firmly wrapping top chainsaw carry handle */
  gatlingLeftRest: {
    thumb: { mcp: 54, pip: 52, splay: 4 },
    index: { mcp: 72, pip: 78, splay: 2 },
    middle: { mcp: 76, pip: 82, splay: 0 },
    ring: { mcp: 76, pip: 82, splay: -2 },
    pinky: { mcp: 78, pip: 82, splay: -4 },
    thumbOppose: 56,
  } as HandPose,

  /** Gatling right hand gripping rear spade trigger grip */
  gatlingRightRest: {
    thumb: { mcp: 52, pip: 46, splay: 4 },
    index: { mcp: 22, pip: 50, splay: 2 },
    middle: { mcp: 72, pip: 78, splay: 0 },
    ring: { mcp: 76, pip: 82, splay: -2 },
    pinky: { mcp: 78, pip: 82, splay: -4 },
    thumbOppose: 54,
  } as HandPose,
};

// --- Hand-to-Gun Minimum Clearance Checker (enforces >= 2cm non-clipping) ----

export interface LocalBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Distance from point p to the outside surface of AABB b (0 if inside). */
export function pointToBoxDistance(p: THREE.Vector3, b: LocalBox): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
  return Math.hypot(dx, dy, dz);
}

/** Minimum distance from point p to any box in `boxes`. */
export function minClearanceToGun(p: THREE.Vector3, boxes: readonly LocalBox[]): number {
  let best = Infinity;
  for (const b of boxes) {
    const d = pointToBoxDistance(p, b);
    if (d < best) best = d;
  }
  return best;
}
