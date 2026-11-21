// CF-style low-poly humanoid AI enemy renderer:
//   - 潜伏者 (BL - Black List): black-red tactical uniform + balaclava mask + glowing RED eye lamp
//   - 保卫者 (GR - Global Risk): blue-white tactical uniform + ballistic helmet + glowing BLUE eye lamp
//   - Strict geometry budget: <= 2500 triangles per enemy (~1100 tris actual!)
//   - Ultra-low draw calls: 1 vertex-colored SkinnedMesh (12 bones) + 1 glowing visor SkinnedMesh
//     + 1 muzzle flash sprite (visible only during firing) = 2–3 draw calls per enemy!
//   - 6 articulated animations: breathe, walk, aim, fire, hit, dead (collapse to deck).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import type { EnemyBot, Faction } from '../game/ai';
import { clamp01, damp, easeInCubic, easeOutCubic } from './tween';

// Bone indices (12 bones per humanoid)
const B_HIPS = 0;
const B_TORSO = 1;
const B_HEAD = 2;
const B_ARM_L = 3;
const B_FOREARM_L = 4;
const B_ARM_R = 5;
const B_FOREARM_R = 6;
const B_LEG_L = 7;
const B_SHIN_L = 8;
const B_LEG_R = 9;
const B_SHIN_R = 10;
const B_GUN = 11;

interface SkinnedPart {
  geo: THREE.BufferGeometry;
  color: string;
  bone: number;
}

const tmpCol = new THREE.Color();

function prepColoredSkinned(part: SkinnedPart): THREE.BufferGeometry {
  const g = part.geo.index ? part.geo.toNonIndexed() : part.geo;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  const sIdx = new Uint16Array(n * 4);
  const sW = new Float32Array(n * 4);
  tmpCol.set(part.color);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = tmpCol.r;
    colors[i * 3 + 1] = tmpCol.g;
    colors[i * 3 + 2] = tmpCol.b;
    sIdx[i * 4] = part.bone;
    sW[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sW, 4));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  // Remove UV so mergeGeometries never mismatches attributes
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  return g;
}

function addBox(
  list: SkinnedPart[],
  bone: number,
  color: string,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): void {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  list.push({ geo: g, color, bone });
}

function addCyl(
  list: SkinnedPart[],
  bone: number,
  color: string,
  rTop: number,
  rBot: number,
  h: number,
  x: number,
  y: number,
  z: number,
  seg = 8,
  rx = 0,
  rz = 0,
): void {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  list.push({ geo: g, color, bone });
}

function addSphere(
  list: SkinnedPart[],
  bone: number,
  color: string,
  r: number,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
): void {
  const g = new THREE.SphereGeometry(r, 8, 6);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  list.push({ geo: g, color, bone });
}

function makeEnemyFlashTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0.0, '#ffffff');
  g.addColorStop(0.3, PALETTE.flashCore);
  g.addColorStop(0.65, PALETTE.flashMid);
  g.addColorStop(1.0, 'rgba(255, 80, 18, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let sharedFlashTex: THREE.CanvasTexture | null = null;
const sharedVisorMats: Partial<Record<Faction, THREE.MeshBasicMaterial>> = {};

function getVisorMat(faction: Faction): THREE.MeshBasicMaterial {
  let m = sharedVisorMats[faction];
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: faction === 'bl' ? PALETTE.blEye : PALETTE.grEye,
    });
    sharedVisorMats[faction] = m;
  }
  return m;
}

export class EnemyRig {
  readonly root = new THREE.Group();
  readonly faction: Faction;
  readonly triangleCount: number;

  private readonly bones: THREE.Bone[];
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly muzzleMesh: THREE.Mesh;
  private readonly muzzleMat: THREE.MeshBasicMaterial;
  private readonly hpWrap: THREE.Group;
  private readonly hpFillMesh: THREE.Mesh;
  private readonly hpMat: THREE.MeshBasicMaterial;

  private hitFlash = 0;
  private deadProgress = 0;
  private aimBlend = 0;

  constructor(faction: Faction) {
    this.faction = faction;
    this.root.name = `enemy-rig-${faction}`;

    const isBL = faction === 'bl';
    const suit = isBL ? PALETTE.blSuit : PALETTE.grSuit;
    const armor = isBL ? PALETTE.blRed : PALETTE.grWhite;
    const headgear = isBL ? PALETTE.blMask : PALETTE.grHelmet;
    const gear = isBL ? PALETTE.gunDark : PALETTE.steelFrame;
    const eyeCol = isBL ? PALETTE.blEye : PALETTE.grEye;

    // --- 12-bone humanoid skeleton (feet on y=0, total height ~1.75m, facing -Z) ---
    const hips = new THREE.Bone();
    hips.position.set(0, 0.94, 0);

    const torso = new THREE.Bone();
    torso.position.set(0, 0.08, 0);
    hips.add(torso);

    const head = new THREE.Bone();
    head.position.set(0, 0.48, 0);
    torso.add(head);

    const armL = new THREE.Bone();
    armL.position.set(-0.23, 0.39, 0);
    torso.add(armL);
    const forearmL = new THREE.Bone();
    forearmL.position.set(0, -0.27, 0);
    armL.add(forearmL);

    const armR = new THREE.Bone();
    armR.position.set(0.23, 0.39, 0);
    torso.add(armR);
    const forearmR = new THREE.Bone();
    forearmR.position.set(0, -0.27, 0);
    armR.add(forearmR);

    const gun = new THREE.Bone();
    gun.position.set(0, -0.24, -0.06);
    forearmR.add(gun);

    const legL = new THREE.Bone();
    legL.position.set(-0.11, -0.04, 0);
    hips.add(legL);
    const shinL = new THREE.Bone();
    shinL.position.set(0, -0.44, 0);
    legL.add(shinL);

    const legR = new THREE.Bone();
    legR.position.set(0.11, -0.04, 0);
    hips.add(legR);
    const shinR = new THREE.Bone();
    shinR.position.set(0, -0.44, 0);
    legR.add(shinR);

    this.bones = [hips, torso, head, armL, forearmL, armR, forearmR, legL, shinL, legR, shinR, gun];
    this.root.add(hips);
    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.bones);

    // --- Build vertex-colored low-poly CF tactical humanoid in bind pose (feet y=0) ---
    const parts: SkinnedPart[] = [];

    // Pelvis / tactical belt & utility pouches
    addBox(parts, B_HIPS, suit, 0.32, 0.16, 0.21, 0, 0.94, 0);
    addBox(parts, B_HIPS, gear, 0.35, 0.06, 0.23, 0, 1.00, 0);
    addBox(parts, B_HIPS, armor, 0.08, 0.09, 0.05, -0.14, 0.98, -0.11); // waist pouch
    addBox(parts, B_HIPS, armor, 0.08, 0.09, 0.05, 0.14, 0.98, -0.11);

    // Torso + iconic CF ballistic chest armor (BL black+crimson rig / GR navy+white vest!)
    addBox(parts, B_TORSO, suit, 0.36, 0.44, 0.22, 0, 1.24, 0);
    addBox(parts, B_TORSO, armor, 0.32, 0.34, 0.26, 0, 1.27, 0); // bold faction chest plate!
    addBox(parts, B_TORSO, gear, 0.26, 0.10, 0.28, 0, 1.15, -0.01); // mag pouches on chest
    addBox(parts, B_TORSO, armor, 0.12, 0.06, 0.25, -0.16, 1.44, 0); // shoulder straps
    addBox(parts, B_TORSO, armor, 0.12, 0.06, 0.25, 0.16, 1.44, 0);
    // Neck collar
    addCyl(parts, B_TORSO, headgear, 0.068, 0.075, 0.08, 0, 1.49, 0, 8);

    // Head: BL = sleek black balaclava mask + crimson headband / GR = tactical blue helmet + white side rails
    addSphere(parts, B_HEAD, headgear, 0.118, 0, 1.62, 0, 0.94, 1.08, 1.0);
    if (isBL) {
      // 潜伏者: tactical black face mask + crimson bandana/head-stripe + respirator cheek filter
      addBox(parts, B_HEAD, armor, 0.225, 0.042, 0.225, 0, 1.67, 0); // bold red head band
      addBox(parts, B_HEAD, gear, 0.13, 0.075, 0.06, 0, 1.56, -0.105); // mouth mask guard
    } else {
      // 保卫者: tactical helmet dome + visor brim + white helmet flash + ear headsets
      addSphere(parts, B_HEAD, headgear, 0.136, 0, 1.655, 0.006, 1.02, 0.88, 1.06);
      addBox(parts, B_HEAD, armor, 0.23, 0.036, 0.22, 0, 1.69, 0.01); // white helmet stripe
      addBox(parts, B_HEAD, gear, 0.18, 0.028, 0.06, 0, 1.67, -0.115); // helmet front brim
      addBox(parts, B_HEAD, armor, 0.04, 0.07, 0.07, -0.13, 1.61, 0); // tactical comms ear cup
      addBox(parts, B_HEAD, armor, 0.04, 0.07, 0.07, 0.13, 1.61, 0);
    }

    // Arms + Faction shoulder pauldrons & elbow pads + tactical gloves
    for (const [side, bUp, bLo] of [
      [-1, B_ARM_L, B_FOREARM_L],
      [1, B_ARM_R, B_FOREARM_R],
    ] as const) {
      const ax = side * 0.23;
      addBox(parts, bUp, armor, 0.125, 0.13, 0.135, ax, 1.38, 0); // bold faction shoulder pad
      addCyl(parts, bUp, suit, 0.056, 0.050, 0.26, ax, 1.26, 0, 7);
      addCyl(parts, bLo, suit, 0.048, 0.042, 0.24, ax, 1.02, 0, 7);
      addBox(parts, bLo, gear, 0.075, 0.085, 0.075, ax, 0.88, 0); // gloved hand
    }

    // Legs + Faction knee pads + heavy combat boots
    for (const [side, bTh, bSh] of [
      [-1, B_LEG_L, B_SHIN_L],
      [1, B_LEG_R, B_SHIN_R],
    ] as const) {
      const lx = side * 0.11;
      addCyl(parts, bTh, suit, 0.082, 0.068, 0.42, lx, 0.69, 0, 8);
      addBox(parts, bSh, armor, 0.105, 0.095, 0.065, lx, 0.47, -0.055); // faction knee guard
      addCyl(parts, bSh, suit, 0.064, 0.054, 0.36, lx, 0.29, 0, 8);
      addBox(parts, bSh, PALETTE.bootDark, 0.105, 0.11, 0.21, lx, 0.055, -0.035); // combat boot
    }

    // Carried Assault Rifle bound to B_GUN (extends forward along -Z from right hand)
    addBox(parts, B_GUN, PALETTE.gun[1], 0.045, 0.075, 0.32, 0.23, 0.90, -0.22); // receiver
    addBox(parts, B_GUN, PALETTE.gun[0], 0.040, 0.062, 0.22, 0.23, 0.89, 0.04); // stock
    addBox(parts, B_GUN, PALETTE.gunDark, 0.032, 0.14, 0.055, 0.23, 0.80, -0.24, 0.18, 0, 0); // curved mag
    addCyl(parts, B_GUN, PALETTE.gun[2], 0.014, 0.014, 0.32, 0.23, 0.91, -0.50, 6, Math.PI / 2); // barrel

    const mergedBody = mergeGeometries(parts.map(prepColoredSkinned), false)!;
    this.bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.16,
      envMapIntensity: 0.95,
      emissive: new THREE.Color('#000000'),
      emissiveIntensity: 0,
    });
    const bodyMesh = new THREE.SkinnedMesh(mergedBody, this.bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.frustumCulled = false;
    bodyMesh.bind(skeleton);
    this.root.add(bodyMesh);

    // --- Glowing Eye Lamp / Visor SkinnedMesh (bound to B_HEAD — 1 draw call!) ---
    const visorParts: SkinnedPart[] = [];
    // Dual tactical glowing eye-goggle lenses + bridge bar (bright RED for BL / BLUE for GR!)
    addBox(visorParts, B_HEAD, eyeCol, 0.068, 0.032, 0.032, -0.044, 1.635, -0.108);
    addBox(visorParts, B_HEAD, eyeCol, 0.068, 0.032, 0.032, 0.044, 1.635, -0.108);
    addBox(visorParts, B_HEAD, eyeCol, 0.040, 0.016, 0.025, 0, 1.635, -0.108);
    const visorGeo = mergeGeometries(visorParts.map(prepColoredSkinned), false)!;
    const visorMesh = new THREE.SkinnedMesh(visorGeo, getVisorMat(faction));
    visorMesh.frustumCulled = false;
    visorMesh.bind(skeleton);
    this.root.add(visorMesh);

    // --- Enemy Muzzle Flash Quad (attached to gun bone, visible only during shot!) ---
    if (!sharedFlashTex) sharedFlashTex = makeEnemyFlashTex();
    this.muzzleMat = new THREE.MeshBasicMaterial({
      map: sharedFlashTex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const flashGeo = new THREE.PlaneGeometry(0.42, 0.42);
    this.muzzleMesh = new THREE.Mesh(flashGeo, this.muzzleMat);
    this.muzzleMesh.position.set(0, 0.02, -0.62);
    this.muzzleMesh.visible = false;
    this.muzzleMesh.frustumCulled = false;
    gun.add(this.muzzleMesh);

    // --- Compact floating HP indicator (only shown when damaged, 0 clutter at full HP) ---
    this.hpWrap = new THREE.Group();
    this.hpWrap.position.set(0, 1.96, 0);
    this.hpWrap.visible = false;
    const bgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.56, 0.055),
      new THREE.MeshBasicMaterial({ color: '#0b0e13', transparent: true, opacity: 0.72, side: THREE.DoubleSide }),
    );
    this.hpMat = new THREE.MeshBasicMaterial({ color: eyeCol, side: THREE.DoubleSide });
    this.hpFillMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.032), this.hpMat);
    this.hpFillMesh.position.z = 0.002;
    this.hpWrap.add(bgMesh, this.hpFillMesh);
    this.root.add(this.hpWrap);

    const triOf = (g: THREE.BufferGeometry) =>
      g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    this.triangleCount = Math.round(triOf(mergedBody) + triOf(visorGeo) + 2);
  }

  /** Drive all 6 animations (breathe, walk, aim, fire, hit, dead) smoothly from bot state. */
  sync(bot: EnemyBot, dt: number, nowMs: number, cameraPos: THREE.Vector3): void {
    const p = bot.entity.pos;
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.set(0, bot.yaw, 0);

    const hips = this.bones[B_HIPS];
    const torso = this.bones[B_TORSO];
    const head = this.bones[B_HEAD];
    const armL = this.bones[B_ARM_L];
    const forearmL = this.bones[B_FOREARM_L];
    const armR = this.bones[B_ARM_R];
    const forearmR = this.bones[B_FOREARM_R];
    const legL = this.bones[B_LEG_L];
    const shinL = this.bones[B_SHIN_L];
    const legR = this.bones[B_LEG_R];
    const shinR = this.bones[B_SHIN_R];
    const gun = this.bones[B_GUN];

    const tSec = nowMs * 0.001;

    // --- 6. DEAD: smooth 0.6s collapse onto deck ---
    if (bot.state === 'DEAD' || !bot.entity.alive) {
      this.deadProgress = Math.min(1, this.deadProgress + dt / 0.58);
      const u = easeInCubic(this.deadProgress);
      hips.position.set(0, 0.94 - u * 0.78, u * 0.36);
      hips.rotation.set(u * 1.48, 0, u * 0.24 * bot.flankSign);
      torso.rotation.set(u * 0.15, 0, 0);
      head.rotation.set(-u * 0.25, u * 0.35 * bot.flankSign, 0);
      armL.rotation.set(0.3 * u, 0, -0.75 * u);
      forearmL.rotation.set(0.35 * u, 0, 0);
      armR.rotation.set(0.45 * u, 0, 0.68 * u);
      forearmR.rotation.set(0.25 * u, 0, 0);
      legL.rotation.set(-0.22 * u, 0, -0.18 * u);
      shinL.rotation.set(-0.35 * u, 0, 0);
      legR.rotation.set(-0.12 * u, 0, 0.22 * u);
      shinR.rotation.set(-0.20 * u, 0, 0);
      gun.rotation.set(0, 0, 0.4 * u);
      this.muzzleMesh.visible = false;
      this.hpWrap.visible = false;
      this.bodyMat.emissiveIntensity = 0;
      return;
    }

    this.deadProgress = 0;

    // --- 1. BREATHE (always underlying idle life) ---
    const breathe = Math.sin(tSec * 2.4 + bot.slotIndex * 1.7);

    // --- 2. WALK (stride cycle scaled by actual movement speed) ---
    const moveFactor = clamp01(bot.speed / 2.2);
    const stride = Math.sin(bot.walkPhase);
    const strideOpp = Math.sin(bot.walkPhase + Math.PI);

    // --- 3. AIM (combat stance blend when ALERT / ENGAGE / CHASE / COVER) ---
    const wantsAim =
      bot.state === 'ALERT' || bot.state === 'ENGAGE' || bot.state === 'COVER' || bot.hasLos;
    this.aimBlend = damp(this.aimBlend, wantsAim ? 1 : 0, 10, dt);

    // --- 4. FIRE (muzzle flash + rifle recoil kick) ---
    const sinceFire = nowMs - bot.lastFireAt;
    const fireKick = sinceFire >= 0 && sinceFire < 110 ? easeOutCubic(1 - sinceFire / 110) : 0;
    const flashOn = sinceFire >= 0 && sinceFire < 68;
    this.muzzleMesh.visible = flashOn;
    if (flashOn) {
      this.muzzleMat.opacity = 1 - sinceFire / 68;
      this.muzzleMesh.rotation.z = (nowMs * 0.09) % (Math.PI * 2);
      const sc = 0.85 + 0.35 * (1 - sinceFire / 68);
      this.muzzleMesh.scale.set(sc, sc, 1);
    }

    // --- 5. HIT (0.22s sharp flinch + brief rim highlight) ---
    const sinceHit = nowMs - bot.lastHitAt;
    const hitFlinch = sinceHit >= 0 && sinceHit < 220 ? Math.sin((1 - sinceHit / 220) * Math.PI) : 0;
    this.hitFlash = damp(this.hitFlash, hitFlinch, 24, dt);
    this.bodyMat.emissive.set(PALETTE.accent);
    this.bodyMat.emissiveIntensity = this.hitFlash * 0.55;

    // Crouch slightly when taking cover
    const coverDuck = bot.state === 'COVER' && bot.speed < 0.4 ? 0.24 : 0;
    const bobY = Math.abs(stride) * 0.032 * moveFactor;

    hips.position.set(0, 0.94 + bobY - coverDuck - this.aimBlend * 0.04, 0);
    hips.rotation.set(
      moveFactor * 0.07 + coverDuck * 0.35,
      this.aimBlend * 0.22,
      stride * 0.03 * moveFactor,
    );

    torso.rotation.set(
      0.03 * breathe + moveFactor * 0.08 - hitFlinch * 0.34 + fireKick * 0.09,
      -this.aimBlend * 0.16 + hitFlinch * 0.18 * bot.flankSign,
      0,
    );

    head.rotation.set(
      -0.02 * breathe - hitFlinch * 0.28,
      this.aimBlend * 0.06 + Math.sin(tSec * 1.1 + bot.slotIndex) * 0.14 * (1 - this.aimBlend),
      0,
    );

    // Legs & knees
    const legAmp = 0.58 * moveFactor;
    legL.rotation.set(stride * legAmp + this.aimBlend * 0.12 + coverDuck * 0.8, 0, -0.05 * this.aimBlend);
    shinL.rotation.set(-Math.max(0, -stride) * 0.65 * moveFactor - coverDuck * 1.2, 0, 0);
    legR.rotation.set(strideOpp * legAmp - this.aimBlend * 0.14 + coverDuck * 0.8, 0, 0.05 * this.aimBlend);
    shinR.rotation.set(-Math.max(0, -strideOpp) * 0.65 * moveFactor - coverDuck * 1.2, 0, 0);

    // Arms holding rifle (low ready while patrolling → leveled shoulder aim when engaging!)
    const aimLift = 0.55 + this.aimBlend * 0.68;
    const armRx = aimLift + fireKick * 0.20 - hitFlinch * 0.22 + breathe * 0.025;
    const foreRx = 0.32 + this.aimBlend * 0.22;
    armR.rotation.set(armRx, -0.14 * this.aimBlend, 0.06);
    forearmR.rotation.set(foreRx, 0, 0);

    armL.rotation.set(
      aimLift * 0.92 + fireKick * 0.14 + stride * 0.12 * (1 - this.aimBlend),
      0.42 + this.aimBlend * 0.24,
      -0.14,
    );
    forearmL.rotation.set(0.55 + this.aimBlend * 0.22, 0.25, 0);

    // Cancel parent armR + forearmR pitch so carried rifle aims horizontally forward (-Z) directly at player!
    gun.rotation.set(-(armRx + foreRx) + fireKick * 0.16, 0.12 * this.aimBlend, 0);

    // Floating HP bar only when wounded
    const wounded = bot.entity.hp < bot.entity.maxHp && bot.entity.hp > 0;
    this.hpWrap.visible = wounded;
    if (wounded) {
      const frac = Math.max(0.02, bot.entity.hp / bot.entity.maxHp);
      this.hpFillMesh.scale.x = frac;
      this.hpFillMesh.position.x = -(1 - frac) * 0.26;
      this.hpWrap.lookAt(cameraPos);
    }
  }
}

export class EnemyRenderer {
  private readonly scene: THREE.Scene;
  private rigs = new Map<string, EnemyRig>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Synchronize rendered EnemyRigs with active EnemyBots (creates/removes rigs cleanly). */
  sync(bots: readonly EnemyBot[], dt: number, nowMs: number, cameraPos: THREE.Vector3): void {
    const aliveIds = new Set<string>();
    for (const bot of bots) {
      aliveIds.add(bot.id);
      let rig = this.rigs.get(bot.id);
      if (!rig) {
        rig = new EnemyRig(bot.faction);
        this.rigs.set(bot.id, rig);
        this.scene.add(rig.root);
      }
      rig.sync(bot, dt, nowMs, cameraPos);
    }
    for (const [id, rig] of this.rigs) {
      if (!aliveIds.has(id)) {
        this.scene.remove(rig.root);
        this.rigs.delete(id);
      }
    }
  }

  getRigTris(botId: string): number {
    return this.rigs.get(botId)?.triangleCount ?? 0;
  }

  getMaxBotTris(): number {
    let mx = 0;
    for (const r of this.rigs.values()) {
      if (r.triangleCount > mx) mx = r.triangleCount;
    }
    return mx;
  }
}
