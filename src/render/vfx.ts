// Combat VFX system — zero external assets, frame-rate independent, pooled for
// mobile draw-call budgets:
//   1. MuzzleFlashRig: 3-layer muzzle flash (40ms white-hot starburst core,
//      70ms elongated orange-amber flame cone scale.y=1.6, 120ms expanding cyan-
//      white smoke puff), ±15% random scale/rotation + random UV flips per shot,
//      60ms burst stacking up to 3 layers (reuses oldest), plus 2 pre-attached
//      muzzle PointLights (#ffb066, intensity 8→0 exponential over 60ms, 6m).
//   2. WorldVfx:
//      - Muzzle smoke: 3–5 billboard puffs per shot rising + expanding + fading over 500ms
//      - Ejected 7.62 brass shells: 1.2m/s lateral, 8 rad/s spin, gravity, 2 bounces + 1.2s, max 20 ring buffer
//      - Tracers: 6m glowing ribbon, alpha 0.9→0 linear over 50ms
//      - Impacts: 10–14 gravity sparks (0.25s) + bullet-hole decals (max 40 ring) + micro-dust (0.4s)

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import type { Box } from '../game/map';
import type { Vec3 } from '../game/player';
import type { WeaponSpec } from '../game/weapons';

type GunId = WeaponSpec['id'];

export interface VfxTelemetry {
  muzzleParticles: number;
  muzzleFlashSlots: number;
  muzzleLightsActive: number;
  muzzleLightMaxIntensity: number;
  shellsActive: number;
  shellsGrounded: number;
  tracersActive: number;
  sparksActive: number;
  decalsCount: number;
}

// --- Procedural canvas textures (cached once, zero external assets) ----------

function makeCanvas(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Layer 1: white-hot 8-spike starburst sprite. */
function makeCoreStarTex(): THREE.CanvasTexture {
  return makeCanvas(256, (ctx, s) => {
    const cx = s * 0.5;
    const cy = s * 0.5;
    // Soft radial hot bloom
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
    g.addColorStop(0.0, '#ffffff');
    g.addColorStop(0.18, PALETTE.flashCore);
    g.addColorStop(0.42, 'rgba(255, 224, 150, 0.72)');
    g.addColorStop(0.75, 'rgba(255, 160, 60, 0.16)');
    g.addColorStop(1.0, 'rgba(255, 120, 30, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // 8 sharp asymmetric sunburst spikes
    const spikes = 8;
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < spikes; i++) {
      const ang = (i / spikes) * Math.PI * 2 + (i % 2 === 0 ? 0.06 : -0.09);
      const len = cx * (i % 2 === 0 ? 0.96 : 0.68);
      const halfW = cx * (i % 2 === 0 ? 0.13 : 0.09);
      ctx.save();
      ctx.rotate(ang);
      const sg = ctx.createLinearGradient(0, 0, len, 0);
      sg.addColorStop(0.0, '#ffffff');
      sg.addColorStop(0.35, PALETTE.flashCore);
      sg.addColorStop(0.72, 'rgba(255, 198, 95, 0.45)');
      sg.addColorStop(1.0, 'rgba(255, 140, 40, 0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(0, -halfW);
      ctx.quadraticCurveTo(len * 0.45, -halfW * 0.25, len, 0);
      ctx.quadraticCurveTo(len * 0.45, halfW * 0.25, 0, halfW);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // Blinding hot center disc
    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, cx * 0.26);
    cg.addColorStop(0, '#ffffff');
    cg.addColorStop(0.65, '#ffffff');
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(0, 0, cx * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

/** Layer 2: elongated fiery orange-amber conical flame plume (+Y = forward down barrel). */
function makeFlameConeTex(): THREE.CanvasTexture {
  return makeCanvas(256, (ctx, s) => {
    // Base of flame sits near y = s*0.92 (muzzle exit), tip blasts toward y = s*0.04 (+Y in UV)
    const cx = s * 0.5;
    // Outer hot orange-red tongue
    const outerG = ctx.createLinearGradient(0, s * 0.94, 0, s * 0.04);
    outerG.addColorStop(0.0, '#fff7cc');
    outerG.addColorStop(0.22, PALETTE.flashMid);
    outerG.addColorStop(0.65, PALETTE.flashOuter);
    outerG.addColorStop(1.0, 'rgba(255, 60, 10, 0)');
    ctx.fillStyle = outerG;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.08, s * 0.94);
    ctx.bezierCurveTo(cx - s * 0.36, s * 0.72, cx - s * 0.30, s * 0.34, cx - s * 0.10, s * 0.14);
    ctx.lineTo(cx - s * 0.14, s * 0.28);
    ctx.lineTo(cx, s * 0.03);
    ctx.lineTo(cx + s * 0.15, s * 0.26);
    ctx.lineTo(cx + s * 0.12, s * 0.13);
    ctx.bezierCurveTo(cx + s * 0.34, s * 0.35, cx + s * 0.36, s * 0.72, cx + s * 0.08, s * 0.94);
    ctx.closePath();
    ctx.fill();

    // Side compensator gas jets flaring at base
    for (const side of [-1, 1]) {
      const jg = ctx.createRadialGradient(cx + side * s * 0.24, s * 0.76, 2, cx + side * s * 0.24, s * 0.76, s * 0.24);
      jg.addColorStop(0.0, '#ffe28a');
      jg.addColorStop(0.45, 'rgba(255, 130, 30, 0.75)');
      jg.addColorStop(1.0, 'rgba(255, 70, 15, 0)');
      ctx.fillStyle = jg;
      ctx.beginPath();
      ctx.ellipse(cx + side * s * 0.24, s * 0.76, s * 0.22, s * 0.10, side * -0.25, 0, Math.PI * 2);
      ctx.fill();
    }

    // Inner bright yellow-white plasma core tongue
    const innerG = ctx.createLinearGradient(0, s * 0.92, 0, s * 0.22);
    innerG.addColorStop(0.0, '#ffffff');
    innerG.addColorStop(0.35, '#ffea94');
    innerG.addColorStop(0.8, 'rgba(255, 168, 46, 0.55)');
    innerG.addColorStop(1.0, 'rgba(255, 130, 20, 0)');
    ctx.fillStyle = innerG;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.05, s * 0.92);
    ctx.quadraticCurveTo(cx - s * 0.18, s * 0.62, cx, s * 0.18);
    ctx.quadraticCurveTo(cx + s * 0.18, s * 0.62, cx + s * 0.05, s * 0.92);
    ctx.closePath();
    ctx.fill();
  });
}

/** Layer 2b: radial fiery petal crown (readable straight down barrel). */
function makeFlameCrownTex(): THREE.CanvasTexture {
  return makeCanvas(256, (ctx, s) => {
    const cx = s * 0.5;
    const cy = s * 0.5;
    const petals = 6;
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < petals; i++) {
      const ang = (i / petals) * Math.PI * 2 + (i % 2 ? 0.14 : -0.10);
      const len = cx * (i % 2 === 0 ? 0.94 : 0.78);
      ctx.save();
      ctx.rotate(ang);
      const pg = ctx.createLinearGradient(0, 0, len, 0);
      pg.addColorStop(0.0, '#fff4ba');
      pg.addColorStop(0.32, PALETTE.flashMid);
      pg.addColorStop(0.75, 'rgba(255, 78, 18, 0.65)');
      pg.addColorStop(1.0, 'rgba(255, 50, 10, 0)');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.moveTo(0, -cx * 0.15);
      ctx.bezierCurveTo(len * 0.42, -cx * 0.24, len * 0.72, -cx * 0.08, len, 0);
      ctx.bezierCurveTo(len * 0.72, cx * 0.08, len * 0.42, cx * 0.24, 0, cx * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  });
}

/** Layer 3 & Muzzle Smoke: soft multi-lobe wispy cyan-white smoke puff. */
function makeSmokeTex(): THREE.CanvasTexture {
  return makeCanvas(128, (ctx, s) => {
    const lobes: [number, number, number, number][] = [
      [0.50, 0.50, 0.40, 0.72],
      [0.36, 0.44, 0.30, 0.52],
      [0.64, 0.46, 0.29, 0.50],
      [0.48, 0.34, 0.28, 0.46],
      [0.54, 0.64, 0.27, 0.42],
    ];
    for (const [lx, ly, lr, alpha] of lobes) {
      const g = ctx.createRadialGradient(lx * s, ly * s, 0, lx * s, ly * s, lr * s);
      g.addColorStop(0.0, `rgba(218, 238, 248, ${alpha})`);
      g.addColorStop(0.55, `rgba(184, 212, 228, ${alpha * 0.45})`);
      g.addColorStop(1.0, 'rgba(160, 194, 214, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  });
}

/** Charred bullet-hole impact decal (dark crater + chipped metal rim + scorch). */
function makeBulletHoleTex(): THREE.CanvasTexture {
  return makeCanvas(128, (ctx, s) => {
    const cx = s * 0.5;
    const cy = s * 0.5;
    // Outer soot halo
    const soot = ctx.createRadialGradient(cx, cy, s * 0.08, cx, cy, s * 0.46);
    soot.addColorStop(0.0, 'rgba(18, 21, 26, 0.92)');
    soot.addColorStop(0.42, 'rgba(26, 30, 36, 0.55)');
    soot.addColorStop(0.75, 'rgba(30, 34, 40, 0.18)');
    soot.addColorStop(1.0, 'rgba(20, 24, 28, 0)');
    ctx.fillStyle = soot;
    ctx.fillRect(0, 0, s, s);

    // Metallic chipped ring
    ctx.strokeStyle = 'rgba(185, 198, 212, 0.68)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.165, 0, Math.PI * 2);
    ctx.stroke();

    // Jagged radial cracks
    ctx.strokeStyle = 'rgba(12, 14, 18, 0.78)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const r1 = s * 0.15;
      const r2 = s * (0.28 + (i % 3) * 0.06);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a + 0.12) * r2, cy + Math.sin(a + 0.12) * r2);
      ctx.stroke();
    }

    // Deep dark center hole
    ctx.fillStyle = PALETTE.bulletHole;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.13, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Stretched glowing spark / tracer sprite. */
function makeGlowStreakTex(): THREE.CanvasTexture {
  return makeCanvas(128, (ctx, s) => {
    const g = ctx.createRadialGradient(s * 0.5, s * 0.5, 0, s * 0.5, s * 0.5, s * 0.5);
    g.addColorStop(0.0, '#ffffff');
    g.addColorStop(0.32, PALETTE.spark);
    g.addColorStop(0.70, 'rgba(255, 150, 42, 0.45)');
    g.addColorStop(1.0, 'rgba(255, 100, 20, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Patch MeshBasicMaterial with per-instance `aAlpha` so an InstancedMesh stays 1 draw call. */
function makeInstancedAlphaMat(opts: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial(opts);
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vInstAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstAlpha;')
      .replace(
        '#include <dithering_fragment>',
        'gl_FragColor.a *= vInstAlpha;\n#include <dithering_fragment>',
      );
  };
  m.customProgramCacheKey = () => 'inst-alpha-v1';
  return m;
}

/** Build a realistic 7.62 bottleneck brass cartridge casing mesh (~64 tris). */
function makeBrassShellGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const prep = (g: THREE.BufferGeometry, y: number): THREE.BufferGeometry => {
    g.translate(0, y, 0);
    return g.index ? g.toNonIndexed() : g;
  };
  // Scaled slightly heroic (6.4cm long, 1.8cm dia) so casings read clearly on wet steel deck
  parts.push(prep(new THREE.CylinderGeometry(0.0092, 0.0096, 0.006, 8), -0.028)); // rimmed base
  parts.push(prep(new THREE.CylinderGeometry(0.0086, 0.0092, 0.036, 8), -0.007)); // main body
  parts.push(prep(new THREE.CylinderGeometry(0.0056, 0.0086, 0.010, 8), 0.016)); // bottleneck shoulder
  parts.push(prep(new THREE.CylinderGeometry(0.0056, 0.0056, 0.012, 8), 0.027)); // case mouth
  const merged = mergeGeometries(parts, false)!;
  merged.rotateX(Math.PI / 2); // lie along Z when rot=0
  return merged;
}

/** Flip UVs on a 4-vertex PlaneGeometry without cloning GPU textures. */
function randomizePlaneUV(geo: THREE.PlaneGeometry, flipX: boolean, flipY: boolean): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const u0 = flipX ? 1 : 0;
  const u1 = flipX ? 0 : 1;
  const v0 = flipY ? 0 : 1;
  const v1 = flipY ? 1 : 0;
  uv.setXY(0, u0, v0);
  uv.setXY(1, u1, v0);
  uv.setXY(2, u0, v1);
  uv.setXY(3, u1, v1);
  uv.needsUpdate = true;
}

// --- 1. Muzzle Flash (3 layers × 3 burst slots) + 2 Pre-Attached PointLights -

interface MuzzleSlot {
  root: THREE.Group;
  coreMesh: THREE.Mesh;
  coreGeo: THREE.PlaneGeometry;
  coreMat: THREE.MeshBasicMaterial;
  midGroup: THREE.Group;
  midConeA: THREE.Mesh;
  midConeB: THREE.Mesh;
  midCrown: THREE.Mesh;
  midConeGeos: THREE.PlaneGeometry[];
  midCrownGeo: THREE.PlaneGeometry;
  midMat: THREE.MeshBasicMaterial;
  midCrownMat: THREE.MeshBasicMaterial;
  outerMesh: THREE.Mesh;
  outerGeo: THREE.PlaneGeometry;
  outerMat: THREE.MeshBasicMaterial;
  active: boolean;
  justSpawned: boolean;
  age: number;
  baseScale: number;
}

interface MuzzleLightSlot {
  light: THREE.PointLight;
  active: boolean;
  justSpawned: boolean;
  age: number;
}

export class MuzzleFlashRig {
  readonly group = new THREE.Group();
  private slots: MuzzleSlot[] = [];
  private lights: MuzzleLightSlot[] = [];
  private elapsedClock = 0;
  private lastStackTime = -10;
  private lastSlotIdx = 0;

  private static readonly MAX_SLOTS = 3;
  private static readonly STACK_INTERVAL = 0.06; // 60ms burst stacking
  private static readonly CORE_DUR = 0.04; // 40ms
  private static readonly MID_DUR = 0.07; // 70ms
  private static readonly OUTER_DUR = 0.12; // 120ms
  private static readonly LIGHT_DUR = 0.06; // 60ms
  private static readonly LIGHT_PEAK = 8.0;

  constructor() {
    this.group.name = 'muzzle-flash-rig';
    const coreTex = makeCoreStarTex();
    const coneTex = makeFlameConeTex();
    const crownTex = makeFlameCrownTex();
    const smokeTex = makeSmokeTex();

    // 3 independent stacked flash slots
    for (let i = 0; i < MuzzleFlashRig.MAX_SLOTS; i++) {
      const root = new THREE.Group();
      root.name = `muzzle-slot-${i}`;
      root.visible = false;

      // Layer 1: White-hot starburst core sprite (40ms, additive)
      const coreGeo = new THREE.PlaneGeometry(0.28, 0.28);
      const coreMat = new THREE.MeshBasicMaterial({
        map: coreTex,
        color: PALETTE.flashCore,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      coreMesh.name = `muzzle-core-${i}`;
      coreMesh.frustumCulled = false;
      coreMesh.renderOrder = 22;
      coreMesh.position.set(0, 0, -0.02);
      root.add(coreMesh);

      // Layer 2: Fiery orange-amber conical flame elongated along barrel (-Z, scale.y = 1.6, 70ms)
      const midGroup = new THREE.Group();
      midGroup.name = `muzzle-mid-${i}`;
      const midMat = new THREE.MeshBasicMaterial({
        map: coneTex,
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mkConeGeo = (): THREE.PlaneGeometry => {
        const g = new THREE.PlaneGeometry(0.24, 0.28);
        // Shift so base starts at y=0 and extends along +Y (which we rotate to barrel -Z)
        g.translate(0, 0.14, 0);
        return g;
      };
      const coneGeoA = mkConeGeo();
      const coneGeoB = mkConeGeo();
      // Rotate plane so its local +Y points along barrel -Z (elongating scale.y = 1.6 down barrel!)
      const midConeA = new THREE.Mesh(coneGeoA, midMat);
      midConeA.rotation.x = -Math.PI / 2;
      midConeA.scale.set(1, 1.6, 1);
      midConeA.frustumCulled = false;
      midConeA.renderOrder = 21;

      const midConeB = new THREE.Mesh(coneGeoB, midMat);
      midConeB.rotation.set(-Math.PI / 2, 0, 0);
      midConeB.rotateY(Math.PI / 2);
      midConeB.scale.set(1, 1.6, 1);
      midConeB.frustumCulled = false;
      midConeB.renderOrder = 21;

      // Cross-axial fiery petal crown facing the camera so the cone reads dramatically down the sights
      const midCrownGeo = new THREE.PlaneGeometry(0.34, 0.34);
      const midCrownMat = new THREE.MeshBasicMaterial({
        map: crownTex,
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const midCrown = new THREE.Mesh(midCrownGeo, midCrownMat);
      midCrown.position.set(0, 0, -0.05);
      midCrown.frustumCulled = false;
      midCrown.renderOrder = 21;

      midGroup.add(midConeA, midConeB, midCrown);
      root.add(midGroup);

      // Layer 3: Outer pale cyan-white short smoke expanding & fading over 120ms
      const outerGeo = new THREE.PlaneGeometry(0.24, 0.24);
      const outerMat = new THREE.MeshBasicMaterial({
        map: smokeTex,
        color: PALETTE.muzzleSmoke,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const outerMesh = new THREE.Mesh(outerGeo, outerMat);
      outerMesh.name = `muzzle-outer-${i}`;
      outerMesh.position.set(0, 0, -0.08);
      outerMesh.frustumCulled = false;
      outerMesh.renderOrder = 20;
      root.add(outerMesh);

      this.group.add(root);
      this.slots.push({
        root,
        coreMesh,
        coreGeo,
        coreMat,
        midGroup,
        midConeA,
        midConeB,
        midCrown,
        midConeGeos: [coneGeoA, coneGeoB],
        midCrownGeo,
        midMat,
        midCrownMat,
        outerMesh,
        outerGeo,
        outerMat,
        active: false,
        justSpawned: false,
        age: 0,
        baseScale: 1,
      });
    }

    // Exactly 2 pre-attached muzzle PointLights (distance 6m, #ffb066, zero shader recompiles)
    for (let i = 0; i < 2; i++) {
      const light = new THREE.PointLight(PALETTE.muzzleLight, 0, 6, 2);
      light.name = `muzzle-light-${i}`;
      light.position.set(0, 0.03, -0.10);
      this.group.add(light);
      this.lights.push({ light, active: false, justSpawned: false, age: 0 });
    }
  }

  /** Trigger a new 3-layer muzzle flash + exponential muzzle light for weapon `id`. */
  trigger(id: GunId): void {
    const weaponScale = id === 'gatling' ? 1.18 : 1.0;

    // 60ms burst stacking: reuse current slot if <60ms elapsed, otherwise pick free or oldest slot
    let slotIdx = this.lastSlotIdx;
    if (this.elapsedClock - this.lastStackTime >= MuzzleFlashRig.STACK_INTERVAL || !this.slots[slotIdx].active) {
      let free = this.slots.findIndex((s) => !s.active);
      if (free < 0) {
        // All 3 active: reuse the oldest layer
        let oldestIdx = 0;
        let oldestAge = -1;
        for (let i = 0; i < this.slots.length; i++) {
          if (this.slots[i].age > oldestAge) {
            oldestAge = this.slots[i].age;
            oldestIdx = i;
          }
        }
        free = oldestIdx;
      }
      slotIdx = free;
      this.lastStackTime = this.elapsedClock;
      this.lastSlotIdx = slotIdx;
    }

    const s = this.slots[slotIdx];
    s.active = true;
    s.justSpawned = true;
    s.age = 0;
    // Random ±15% scale variation per shot
    s.baseScale = weaponScale * (0.85 + Math.random() * 0.30);

    // Random rotation + UV flip on every shot so no two flashes look identical
    s.coreMesh.rotation.z = Math.random() * Math.PI * 2;
    s.midGroup.rotation.z = Math.random() * Math.PI * 2;
    s.outerMesh.rotation.z = Math.random() * Math.PI * 2;
    randomizePlaneUV(s.coreGeo, Math.random() < 0.5, Math.random() < 0.5);
    for (const g of s.midConeGeos) randomizePlaneUV(g, Math.random() < 0.5, false);
    randomizePlaneUV(s.midCrownGeo, Math.random() < 0.5, Math.random() < 0.5);
    randomizePlaneUV(s.outerGeo, Math.random() < 0.5, Math.random() < 0.5);

    // Slight longitudinal offset so stacked burst layers don't z-fight
    s.root.position.set(0, 0, -slotIdx * 0.012);
    s.root.visible = true;

    // Trigger oldest / inactive muzzle PointLight (max 2 simultaneous, zero add/remove)
    let li = this.lights.findIndex((l) => !l.active);
    if (li < 0) li = this.lights[0].age >= this.lights[1].age ? 0 : 1;
    const ls = this.lights[li];
    ls.active = true;
    ls.justSpawned = true;
    ls.age = 0;
    ls.light.intensity = MuzzleFlashRig.LIGHT_PEAK;
  }

  update(dt: number, telemetry?: VfxTelemetry): void {
    this.elapsedClock += dt;
    let activeSlots = 0;

    for (const s of this.slots) {
      if (!s.active) continue;
      if (s.justSpawned) {
        s.justSpawned = false;
      } else {
        s.age += dt;
      }
      if (s.age >= MuzzleFlashRig.OUTER_DUR) {
        s.active = false;
        s.root.visible = false;
        s.coreMat.opacity = 0;
        s.midMat.opacity = 0;
        s.midCrownMat.opacity = 0;
        s.outerMat.opacity = 0;
        continue;
      }
      activeSlots++;

      // Layer 1: White-hot star core (40ms)
      if (s.age < MuzzleFlashRig.CORE_DUR) {
        const u = s.age / MuzzleFlashRig.CORE_DUR;
        const sc = s.baseScale * (0.95 + u * 0.25);
        s.coreMesh.visible = true;
        s.coreMesh.scale.set(sc, sc, 1);
        s.coreMat.opacity = 1 - u * u;
      } else {
        s.coreMesh.visible = false;
        s.coreMat.opacity = 0;
      }

      // Layer 2: Fiery orange-amber cone elongated scale.y=1.6 along barrel (70ms)
      if (s.age < MuzzleFlashRig.MID_DUR) {
        const u = s.age / MuzzleFlashRig.MID_DUR;
        const sc = s.baseScale * (0.92 + u * 0.28);
        const fade = 1 - u;
        s.midGroup.visible = true;
        s.midConeA.scale.set(sc, sc * 1.6, sc);
        s.midConeB.scale.set(sc, sc * 1.6, sc);
        s.midCrown.scale.set(sc, sc, 1);
        s.midMat.opacity = fade * 0.98;
        s.midCrownMat.opacity = fade * 0.92;
      } else {
        s.midGroup.visible = false;
        s.midMat.opacity = 0;
        s.midCrownMat.opacity = 0;
      }

      // Layer 3: Pale cyan-white short smoke expanding outward & fading (120ms)
      const ou = s.age / MuzzleFlashRig.OUTER_DUR;
      const osc = s.baseScale * (0.95 + ou * 1.45);
      s.outerMesh.visible = true;
      s.outerMesh.scale.set(osc, osc, 1);
      s.outerMesh.position.set(0, ou * 0.04, -0.08 - ou * 0.16);
      s.outerMat.opacity = (1 - ou) * 0.65;
    }

    // Muzzle PointLights: intensity 8 → 0 exponential decay over 60ms
    let lightsActive = 0;
    let maxInt = 0;
    for (const ls of this.lights) {
      if (!ls.active) continue;
      if (ls.justSpawned) {
        ls.justSpawned = false;
      } else {
        ls.age += dt;
      }
      if (ls.age >= MuzzleFlashRig.LIGHT_DUR) {
        ls.active = false;
        ls.light.intensity = 0;
      } else {
        const inten = MuzzleFlashRig.LIGHT_PEAK * Math.exp(-ls.age / 0.015);
        ls.light.intensity = inten;
        lightsActive++;
        if (inten > maxInt) maxInt = inten;
      }
    }

    if (telemetry) {
      telemetry.muzzleFlashSlots = activeSlots;
      telemetry.muzzleLightsActive = lightsActive;
      telemetry.muzzleLightMaxIntensity = maxInt;
    }
  }
}

// --- 2. World VFX: Muzzle Smoke, Brass Shells, 6m Tracers, Impact FX ---------

interface SmokePuff {
  active: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  startScale: number;
  endScale: number;
  peakAlpha: number;
  roll: number;
  vRoll: number;
}

interface ShellCasing {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  vrx: number;
  vry: number;
  vrz: number;
  bounces: number;
  settled: boolean;
  restAge: number;
}

interface TracerBeam {
  active: boolean;
  justSpawned: boolean;
  age: number;
  x0: number;
  y0: number;
  z0: number;
  dx: number;
  dy: number;
  dz: number;
  totalDist: number;
  len: number;
}

interface ImpactSpark {
  active: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

const ZERO_MAT = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpColor = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Fast floor height query under `(x, z)` at or below `y` against MAP.boxes. */
function floorHeightAt(boxes: readonly Box[], x: number, y: number, z: number): number {
  let best = 0;
  for (const b of boxes) {
    if (
      x >= b.x - b.w / 2 &&
      x <= b.x + b.w / 2 &&
      z >= b.z - b.d / 2 &&
      z <= b.z + b.d / 2
    ) {
      const top = b.y + b.h;
      if (top <= y + 0.15 && top > best) best = top;
    }
  }
  return best;
}

export class WorldVfx {
  private readonly boxes: readonly Box[];
  /** Optional callback fired when a brass shell casing bounces on the deck (for shell clink SFX). */
  onShellBounce: ((speed: number) => void) | null = null;

  // Muzzle smoke + impact micro-dust (shared billboard InstancedMesh? Keep separate for clean telemetry & colors!)
  private smokeMesh: THREE.InstancedMesh;
  private smokeAlphas: Float32Array;
  private smokes: SmokePuff[] = [];
  private smokeNext = 0;
  private static readonly MAX_SMOKE = 28;

  private dustMesh: THREE.InstancedMesh;
  private dustAlphas: Float32Array;
  private dusts: SmokePuff[] = [];
  private dustNext = 0;
  private static readonly MAX_DUST = 32;

  // 7.62 Brass shells (max 20 ring buffer)
  private shellMesh: THREE.InstancedMesh;
  private shells: ShellCasing[] = [];
  private shellNext = 0;
  private static readonly MAX_SHELLS = 20;
  private static readonly SHELL_REST_LIFE = 1.2; // 1.2s after 2nd bounce

  // 6m glowing tracer ribbons (50ms linear alpha 0.9→0)
  private tracerMesh: THREE.InstancedMesh;
  private tracerAlphas: Float32Array;
  private tracers: TracerBeam[] = [];
  private tracerNext = 0;
  private static readonly MAX_TRACERS = 16;
  private static readonly TRACER_LIFE = 0.05; // 50ms
  private static readonly TRACER_LEN = 6.0; // 6m

  // Impact sparks (10–14 per hit, 0.25s, gravity)
  private sparkMesh: THREE.InstancedMesh;
  private sparkAlphas: Float32Array;
  private sparks: ImpactSpark[] = [];
  private sparkNext = 0;
  private static readonly MAX_SPARKS = 64;

  // Bullet-hole decals (max 40 ring buffer)
  private decalMesh: THREE.InstancedMesh;
  private decalNext = 0;
  private decalCount = 0;
  private static readonly MAX_DECALS = 40;

  constructor(scene: THREE.Scene, boxes: readonly Box[]) {
    this.boxes = boxes;
    const smokeTex = makeSmokeTex();
    const glowTex = makeGlowStreakTex();
    const holeTex = makeBulletHoleTex();

    // --- Muzzle smoke InstancedMesh (1 draw call) ---
    const smokeGeo = new THREE.PlaneGeometry(1, 1);
    this.smokeAlphas = new Float32Array(WorldVfx.MAX_SMOKE);
    smokeGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.smokeAlphas, 1));
    this.smokeMesh = new THREE.InstancedMesh(
      smokeGeo,
      makeInstancedAlphaMat({
        map: smokeTex,
        color: PALETTE.muzzleSmoke,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      WorldVfx.MAX_SMOKE,
    );
    this.smokeMesh.name = 'vfx-muzzle-smoke';
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.renderOrder = 15;
    for (let i = 0; i < WorldVfx.MAX_SMOKE; i++) {
      this.smokeMesh.setMatrixAt(i, ZERO_MAT);
      this.smokes.push({
        active: false, age: 0, life: 0.5, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        startScale: 0.1, endScale: 0.4, peakAlpha: 0.45, roll: 0, vRoll: 0,
      });
    }
    scene.add(this.smokeMesh);

    // --- Impact micro-dust InstancedMesh (1 draw call) ---
    const dustGeo = new THREE.PlaneGeometry(1, 1);
    this.dustAlphas = new Float32Array(WorldVfx.MAX_DUST);
    dustGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.dustAlphas, 1));
    this.dustMesh = new THREE.InstancedMesh(
      dustGeo,
      makeInstancedAlphaMat({
        map: smokeTex,
        color: PALETTE.dust,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      WorldVfx.MAX_DUST,
    );
    this.dustMesh.name = 'vfx-impact-dust';
    this.dustMesh.frustumCulled = false;
    this.dustMesh.renderOrder = 14;
    for (let i = 0; i < WorldVfx.MAX_DUST; i++) {
      this.dustMesh.setMatrixAt(i, ZERO_MAT);
      this.dusts.push({
        active: false, age: 0, life: 0.4, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        startScale: 0.1, endScale: 0.35, peakAlpha: 0.45, roll: 0, vRoll: 0,
      });
    }
    scene.add(this.dustMesh);

    // --- Ejected 7.62 brass shells (1 draw call, max 20 ring buffer) ---
    const shellMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      emissive: PALETTE.brass,
      emissiveIntensity: 0.24,
      metalness: 0.85,
      roughness: 0.24,
    });
    this.shellMesh = new THREE.InstancedMesh(makeBrassShellGeo(), shellMat, WorldVfx.MAX_SHELLS);
    this.shellMesh.name = 'vfx-shells';
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = false;
    this.shellMesh.receiveShadow = true;
    for (let i = 0; i < WorldVfx.MAX_SHELLS; i++) {
      this.shellMesh.setMatrixAt(i, ZERO_MAT);
      this.shellMesh.setColorAt(i, tmpColor.set(PALETTE.brass));
      this.shells.push({
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, vrx: 0, vry: 0, vrz: 0,
        bounces: 0, settled: false, restAge: 0,
      });
    }
    this.shellMesh.instanceColor!.needsUpdate = true;
    scene.add(this.shellMesh);

    // --- 6m glowing tracer ribbons (1 draw call) ---
    const tracerGeo = new THREE.PlaneGeometry(1, 1); // X = width, Y = length along ray
    this.tracerAlphas = new Float32Array(WorldVfx.MAX_TRACERS);
    tracerGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.tracerAlphas, 1));
    this.tracerMesh = new THREE.InstancedMesh(
      tracerGeo,
      makeInstancedAlphaMat({
        map: glowTex,
        color: PALETTE.tracer,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      WorldVfx.MAX_TRACERS,
    );
    this.tracerMesh.name = 'vfx-tracers';
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 18;
    for (let i = 0; i < WorldVfx.MAX_TRACERS; i++) {
      this.tracerMesh.setMatrixAt(i, ZERO_MAT);
      this.tracers.push({
        active: false, justSpawned: false, age: 0,
        x0: 0, y0: 0, z0: 0, dx: 0, dy: 0, dz: -1, totalDist: 6, len: 6,
      });
    }
    scene.add(this.tracerMesh);

    // --- Impact sparks (1 draw call) ---
    const sparkGeo = new THREE.PlaneGeometry(1, 1);
    this.sparkAlphas = new Float32Array(WorldVfx.MAX_SPARKS);
    sparkGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.sparkAlphas, 1));
    this.sparkMesh = new THREE.InstancedMesh(
      sparkGeo,
      makeInstancedAlphaMat({
        map: glowTex,
        color: PALETTE.spark,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      WorldVfx.MAX_SPARKS,
    );
    this.sparkMesh.name = 'vfx-impact-sparks';
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 17;
    for (let i = 0; i < WorldVfx.MAX_SPARKS; i++) {
      this.sparkMesh.setMatrixAt(i, ZERO_MAT);
      this.sparks.push({ active: false, age: 0, life: 0.25, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    }
    scene.add(this.sparkMesh);

    // --- Bullet-hole decals (1 draw call, max 40 ring buffer) ---
    const decalGeo = new THREE.PlaneGeometry(0.14, 0.14);
    this.decalMesh = new THREE.InstancedMesh(
      decalGeo,
      new THREE.MeshBasicMaterial({
        map: holeTex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      WorldVfx.MAX_DECALS,
    );
    this.decalMesh.name = 'vfx-bullet-holes';
    this.decalMesh.frustumCulled = false;
    this.decalMesh.renderOrder = 6;
    for (let i = 0; i < WorldVfx.MAX_DECALS; i++) {
      this.decalMesh.setMatrixAt(i, ZERO_MAT);
    }
    scene.add(this.decalMesh);
  }

  /** Spawn 3–5 rising billboard muzzle smoke puffs (500ms). */
  spawnMuzzleSmoke(muzzlePos: THREE.Vector3, forwardDir: Vec3): void {
    const count = 3 + Math.floor(Math.random() * 3); // 3–5 particles
    for (let k = 0; k < count; k++) {
      const slot = this.smokes[this.smokeNext];
      this.smokeNext = (this.smokeNext + 1) % WorldVfx.MAX_SMOKE;
      slot.active = true;
      slot.age = 0;
      slot.life = 0.44 + Math.random() * 0.12; // ~500ms
      const spread = 0.06;
      slot.x = muzzlePos.x + forwardDir.x * (0.08 + k * 0.05) + (Math.random() - 0.5) * spread;
      slot.y = muzzlePos.y + forwardDir.y * (0.08 + k * 0.05) + (Math.random() - 0.5) * spread;
      slot.z = muzzlePos.z + forwardDir.z * (0.08 + k * 0.05) + (Math.random() - 0.5) * spread;
      const fwdSpd = 0.45 + Math.random() * 0.55;
      slot.vx = forwardDir.x * fwdSpd + (Math.random() - 0.5) * 0.45;
      slot.vy = 0.55 + Math.random() * 0.50; // rises upward
      slot.vz = forwardDir.z * fwdSpd + (Math.random() - 0.5) * 0.45;
      slot.startScale = 0.09 + Math.random() * 0.04;
      slot.endScale = 0.38 + Math.random() * 0.14;
      slot.peakAlpha = 0.42 + Math.random() * 0.12;
      slot.roll = Math.random() * Math.PI * 2;
      slot.vRoll = (Math.random() - 0.5) * 2.4;
    }
  }

  /** Eject a 7.62 brass shell casing (1.2m/s lateral, 8 rad/s spin, 2 bounces + 1.2s). */
  spawnShell(
    ejectPos: THREE.Vector3,
    cameraRight: THREE.Vector3,
    cameraForward: THREE.Vector3,
    playerVel: Vec3,
    weaponId: GunId,
  ): void {
    const idx = this.shellNext;
    this.shellNext = (this.shellNext + 1) % WorldVfx.MAX_SHELLS;
    const s = this.shells[idx];
    s.active = true;
    s.bounces = 0;
    s.settled = false;
    s.restAge = 0;
    s.x = ejectPos.x;
    s.y = ejectPos.y;
    s.z = ejectPos.z;
    // Lateral speed 1.2 m/s (±12% organic spread) + upward arc
    const lat = 1.2 * (0.88 + Math.random() * 0.24);
    const fwd = (Math.random() - 0.35) * 0.35;
    s.vx = playerVel.x * 0.4 + cameraRight.x * lat + cameraForward.x * fwd;
    s.vy = 0.85 + Math.random() * 0.35;
    s.vz = playerVel.z * 0.4 + cameraRight.z * lat + cameraForward.z * fwd;
    s.rx = Math.random() * Math.PI;
    s.ry = Math.random() * Math.PI * 2;
    s.rz = Math.random() * Math.PI;
    // Spin ~8 rad/s
    const spin = 8 * (0.85 + Math.random() * 0.3);
    s.vrx = spin * (Math.random() < 0.5 ? 1 : -1);
    s.vry = spin * 0.55;
    s.vrz = spin * 0.45 * (Math.random() < 0.5 ? 1 : -1);

    // Gleaming 7.62 brass for both rifle & gatling
    void weaponId;
    this.shellMesh.setColorAt(idx, tmpColor.set(PALETTE.brass));
    this.shellMesh.instanceColor!.needsUpdate = true;
  }

  /** Spawn a 6m tracer beam (alpha 0.9→0 linear over 50ms). */
  spawnTracer(from: Vec3 | THREE.Vector3, to: Vec3 | THREE.Vector3): void {
    const slot = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % WorldVfx.MAX_TRACERS;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.25) return;
    slot.active = true;
    slot.justSpawned = true;
    slot.age = 0;
    slot.x0 = from.x;
    slot.y0 = from.y;
    slot.z0 = from.z;
    slot.dx = dx / dist;
    slot.dy = dy / dist;
    slot.dz = dz / dist;
    slot.totalDist = dist;
    slot.len = Math.min(WorldVfx.TRACER_LEN, dist * 0.92);
  }

  /** Impact VFX on world box hit: 10–14 gravity sparks (0.25s) + bullet-hole decal (max 40) + dust (0.4s). */
  spawnImpact(point: Vec3, normal: Vec3): void {
    // 1. Bullet-hole decal (ring buffer max 40)
    const di = this.decalNext;
    this.decalNext = (this.decalNext + 1) % WorldVfx.MAX_DECALS;
    if (this.decalCount < WorldVfx.MAX_DECALS) this.decalCount++;

    tmpDir.set(normal.x, normal.y, normal.z).normalize();
    tmpP.set(point.x + tmpDir.x * 0.008, point.y + tmpDir.y * 0.008, point.z + tmpDir.z * 0.008);
    tmpQ.setFromUnitVectors(Z_AXIS, tmpDir);
    tmpQ2.setFromAxisAngle(tmpDir, Math.random() * Math.PI * 2);
    tmpQ.premultiply(tmpQ2);
    const dScale = 0.85 + Math.random() * 0.35;
    tmpS.set(dScale, dScale, 1);
    tmpM.compose(tmpP, tmpQ, tmpS);
    this.decalMesh.setMatrixAt(di, tmpM);
    this.decalMesh.instanceMatrix.needsUpdate = true;

    // 2. 10–14 bright gravity sparks (0.25s)
    const sparkCount = 10 + Math.floor(Math.random() * 5);
    for (let k = 0; k < sparkCount; k++) {
      const sp = this.sparks[this.sparkNext];
      this.sparkNext = (this.sparkNext + 1) % WorldVfx.MAX_SPARKS;
      sp.active = true;
      sp.age = 0;
      sp.life = 0.21 + Math.random() * 0.07; // ~0.25s
      sp.x = point.x + normal.x * 0.02;
      sp.y = point.y + normal.y * 0.02;
      sp.z = point.z + normal.z * 0.02;
      const spd = 2.6 + Math.random() * 4.4;
      const rx = normal.x + (Math.random() - 0.5) * 1.3;
      const ry = normal.y + (Math.random() - 0.3) * 1.3;
      const rz = normal.z + (Math.random() - 0.5) * 1.3;
      const rl = Math.hypot(rx, ry, rz) || 1;
      sp.vx = (rx / rl) * spd;
      sp.vy = (ry / rl) * spd + 0.8;
      sp.vz = (rz / rl) * spd;
    }

    // 3. Micro-dust puffs (0.4s)
    for (let k = 0; k < 3; k++) {
      const d = this.dusts[this.dustNext];
      this.dustNext = (this.dustNext + 1) % WorldVfx.MAX_DUST;
      d.active = true;
      d.age = 0;
      d.life = 0.36 + Math.random() * 0.08; // ~0.4s
      d.x = point.x + normal.x * 0.05 + (Math.random() - 0.5) * 0.08;
      d.y = point.y + normal.y * 0.05 + (Math.random() - 0.5) * 0.08;
      d.z = point.z + normal.z * 0.05 + (Math.random() - 0.5) * 0.08;
      d.vx = normal.x * (0.5 + Math.random() * 0.7) + (Math.random() - 0.5) * 0.6;
      d.vy = normal.y * 0.5 + 0.35 + Math.random() * 0.4;
      d.vz = normal.z * (0.5 + Math.random() * 0.7) + (Math.random() - 0.5) * 0.6;
      d.startScale = 0.12;
      d.endScale = 0.38 + Math.random() * 0.12;
      d.peakAlpha = 0.42;
      d.roll = Math.random() * Math.PI * 2;
      d.vRoll = (Math.random() - 0.5) * 1.8;
    }
  }

  private updatePuffs(
    dt: number,
    list: SmokePuff[],
    mesh: THREE.InstancedMesh,
    alphas: Float32Array,
    camQuat: THREE.Quaternion,
  ): number {
    let activeCount = 0;
    let dirty = false;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.active) continue;
      dirty = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        alphas[i] = 0;
        mesh.setMatrixAt(i, ZERO_MAT);
        continue;
      }
      activeCount++;
      const u = p.age / p.life;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      // Air drag on horizontal drift while preserving upward float
      const drag = Math.exp(-3.5 * dt);
      p.vx *= drag;
      p.vz *= drag;
      p.roll += p.vRoll * dt;

      const sc = p.startScale + (p.endScale - p.startScale) * u;
      tmpP.set(p.x, p.y, p.z);
      tmpQ2.setFromAxisAngle(Z_AXIS, p.roll);
      tmpQ.copy(camQuat).multiply(tmpQ2);
      tmpS.set(sc, sc, 1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      mesh.setMatrixAt(i, tmpM);
      alphas[i] = p.peakAlpha * (1 - u);
    }
    if (dirty) {
      mesh.instanceMatrix.needsUpdate = true;
      (mesh.geometry.getAttribute('aAlpha') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    return activeCount;
  }

  update(dt: number, camera: THREE.Camera, telemetry?: VfxTelemetry): void {
    const camQ = camera.quaternion;
    const smokeActive = this.updatePuffs(dt, this.smokes, this.smokeMesh, this.smokeAlphas, camQ);
    this.updatePuffs(dt, this.dusts, this.dustMesh, this.dustAlphas, camQ);

    // --- Shells physics (gravity, 2 bounces, 1.2s settle) ---
    let shellsActive = 0;
    let shellsGrounded = 0;
    let shellsDirty = false;
    const SHELL_R = 0.011;
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (!s.active) continue;
      shellsDirty = true;
      if (!s.settled) {
        s.vy -= 11.5 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
        s.rx += s.vrx * dt;
        s.ry += s.vry * dt;
        s.rz += s.vrz * dt;

        const floorY = floorHeightAt(this.boxes, s.x, s.y, s.z);
        if (s.y <= floorY + SHELL_R && s.vy < 0) {
          this.onShellBounce?.(Math.abs(s.vy));
          s.y = floorY + SHELL_R;
          s.bounces++;
          if (s.bounces >= 2) {
            s.settled = true;
            s.vx = 0;
            s.vy = 0;
            s.vz = 0;
            // Lay flat horizontally on the deck
            s.rx = 0;
            s.rz = 0;
            s.restAge = 0;
          } else {
            s.vy = -s.vy * 0.42;
            s.vx *= 0.65;
            s.vz *= 0.65;
            s.vrx *= 0.55;
            s.vry *= 0.55;
            s.vrz *= 0.55;
          }
        }
      } else {
        s.restAge += dt;
        if (s.restAge >= WorldVfx.SHELL_REST_LIFE) {
          s.active = false;
          this.shellMesh.setMatrixAt(i, ZERO_MAT);
          continue;
        }
        shellsGrounded++;
      }

      shellsActive++;
      // Gentle shrink out during final 0.15s of rest life
      const fadeStart = WorldVfx.SHELL_REST_LIFE - 0.15;
      const sc = s.settled && s.restAge > fadeStart
        ? Math.max(0.01, (WorldVfx.SHELL_REST_LIFE - s.restAge) / 0.15)
        : 1;
      tmpP.set(s.x, s.y, s.z);
      tmpE.set(s.rx, s.ry, s.rz);
      tmpQ.setFromEuler(tmpE);
      tmpS.set(sc, sc, sc);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.shellMesh.setMatrixAt(i, tmpM);
    }
    if (shellsDirty) this.shellMesh.instanceMatrix.needsUpdate = true;

    // --- 6m glowing tracer ribbons (50ms, alpha 0.9→0 linear) ---
    let tracersActive = 0;
    let tracersDirty = false;
    const camPos = camera.position;
    for (let i = 0; i < this.tracers.length; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tracersDirty = true;
      if (tr.justSpawned) {
        tr.justSpawned = false;
      } else {
        tr.age += dt;
      }
      if (tr.age >= WorldVfx.TRACER_LIFE) {
        tr.active = false;
        this.tracerAlphas[i] = 0;
        this.tracerMesh.setMatrixAt(i, ZERO_MAT);
        continue;
      }
      tracersActive++;
      const u = tr.age / WorldVfx.TRACER_LIFE;
      // Ribbon sweeps cleanly forward along shot path over 50ms
      const travel = Math.max(0, tr.totalDist - tr.len);
      const startD = Math.min(travel, travel * u * 1.45);
      const midD = startD + tr.len * 0.5;
      tmpP.set(tr.x0 + tr.dx * midD, tr.y0 + tr.dy * midD, tr.z0 + tr.dz * midD);
      tmpDir.set(tr.dx, tr.dy, tr.dz);
      // Billboard ribbon perpendicular to both ray direction and view vector
      tmpUp.subVectors(camPos, tmpP);
      tmpRight.crossVectors(tmpDir, tmpUp);
      if (tmpRight.lengthSq() < 1e-6) tmpRight.set(1, 0, 0);
      else tmpRight.normalize();
      tmpUp.crossVectors(tmpRight, tmpDir).normalize();
      tmpM.makeBasis(tmpRight, tmpDir, tmpUp);
      tmpM.scale(tmpS.set(0.036, tr.len, 1));
      tmpM.setPosition(tmpP);
      this.tracerMesh.setMatrixAt(i, tmpM);
      this.tracerAlphas[i] = 0.9 * (1 - u);
    }
    if (tracersDirty) {
      this.tracerMesh.instanceMatrix.needsUpdate = true;
      (this.tracerMesh.geometry.getAttribute('aAlpha') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    // --- Impact sparks (0.25s, gravity) ---
    let sparksActive = 0;
    let sparksDirty = false;
    for (let i = 0; i < this.sparks.length; i++) {
      const sp = this.sparks[i];
      if (!sp.active) continue;
      sparksDirty = true;
      sp.age += dt;
      if (sp.age >= sp.life) {
        sp.active = false;
        this.sparkAlphas[i] = 0;
        this.sparkMesh.setMatrixAt(i, ZERO_MAT);
        continue;
      }
      sparksActive++;
      sp.vy -= 15.0 * dt;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      sp.z += sp.vz * dt;
      const u = sp.age / sp.life;
      tmpP.set(sp.x, sp.y, sp.z);
      tmpDir.set(sp.vx, sp.vy, sp.vz);
      const spd = tmpDir.length();
      if (spd > 0.01) tmpDir.divideScalar(spd);
      else tmpDir.copy(Y_AXIS);
      tmpUp.subVectors(camPos, tmpP);
      tmpRight.crossVectors(tmpDir, tmpUp);
      if (tmpRight.lengthSq() < 1e-6) tmpRight.set(1, 0, 0);
      else tmpRight.normalize();
      tmpUp.crossVectors(tmpRight, tmpDir).normalize();
      tmpM.makeBasis(tmpRight, tmpDir, tmpUp);
      const streak = Math.min(0.24, Math.max(0.05, spd * 0.035));
      tmpM.scale(tmpS.set(0.022, streak, 1));
      tmpM.setPosition(tmpP);
      this.sparkMesh.setMatrixAt(i, tmpM);
      this.sparkAlphas[i] = 1 - u;
    }
    if (sparksDirty) {
      this.sparkMesh.instanceMatrix.needsUpdate = true;
      (this.sparkMesh.geometry.getAttribute('aAlpha') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }

    if (telemetry) {
      telemetry.muzzleParticles = telemetry.muzzleFlashSlots + smokeActive;
      telemetry.shellsActive = shellsActive;
      telemetry.shellsGrounded = shellsGrounded;
      telemetry.tracersActive = tracersActive;
      telemetry.sparksActive = sparksActive;
      telemetry.decalsCount = this.decalCount;
    }
  }
}
