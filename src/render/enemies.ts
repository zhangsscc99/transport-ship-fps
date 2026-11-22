// Rigged Humanoid AI Enemy Renderer (CC0 Low-poly Squad Kit — toolbenchdev.com):
//   - Loads public/models/soldier.glb (3368 tris, 22 bones, 53 clips) &
//     public/models/weapon_rifle.glb (300 tris) ONCE via GLTFLoader,
//     reused per enemy via SkeletonUtils.clone().
//   - Rifle attached directly to bone Socket_Hand_R at (0,0,0), rotation (0,0,0).
//   - Faction dyeing:
//       潜伏者 (bl): TeamColour -> #b3221f, other materials darkened x0.55 + RED emissive eye orb on Head
//       保卫者 (gr): TeamColour -> #2f6fb0, other materials brightened x1.05 + BLUE emissive eye orb on Head
//   - Per-enemy AnimationMixer driving strict 9-clip FSM with 0.18s crossFadeTo transitions:
//       idle_rifle / walk_rifle / run_rifle / aim_rifle / fire_rifle / reload_rifle / crouch_rifle / hit / die
//   - Model facing smoothly interpolated via model.rotation.y at 8 rad/s.
//   - Death: die clip plays to completion, holds last frame for 2.5s, then fades out cleanly.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { BOT_TURN_RATE, type EnemyBot, type EnemyClip, type Faction } from '../game/ai';
import { computeFootLift, sampleClipMinY } from '../game/enemyFoot';

export const SOLDIER_MODEL_SOURCE = 'public/models/soldier.glb';
export const RIFLE_MODEL_SOURCE = 'public/models/weapon_rifle.glb';

const CROSSFADE_SEC = 0.18;
const FIRE_CLIP_TARGET_SEC = 0.35;
const RELOAD_CLIP_TARGET_SEC = 2.2;
const HIT_CLIP_TARGET_SEC = 0.25;
const CORPSE_HOLD_SEC = 2.5;
const CORPSE_FADE_SEC = 0.6;
const DEATH_LIFT_RELAX_SEC = 0.25;

/** Grounded contact shadow disc anchored directly under each enemy's boots. */
const CONTACT_SHADOW_DIAMETER = 1.0;
const CONTACT_SHADOW_Y = 0.012;
const CONTACT_SHADOW_OPACITY = 0.85;
const CONTACT_SHADOW_RENDER_ORDER = -1;
const CLIP_MINY_SAMPLES = 32;

const REQUIRED_CLIPS: readonly EnemyClip[] = [
  'idle_rifle',
  'walk_rifle',
  'run_rifle',
  'aim_rifle',
  'fire_rifle',
  'reload_rifle',
  'crouch_rifle',
  'hit',
  'die',
];

const GROUNDED_CLIPS: readonly EnemyClip[] = [
  'idle_rifle',
  'walk_rifle',
  'run_rifle',
  'aim_rifle',
  'fire_rifle',
  'reload_rifle',
  'crouch_rifle',
  'hit',
];

interface ClipMinYTable {
  samples: Float32Array;
  duration: number;
  loop: boolean;
}

interface LoadedSoldierAssets {
  soldierScene: THREE.Group;
  clips: Map<EnemyClip, THREE.AnimationClip>;
  rifleParts: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[];
  soldierTris: number;
  rifleTris: number;
  dieDurationSec: number;
  modelMinY: number;
  bootMeshName: string;
  clipMinYTables: Map<EnemyClip, ClipMinYTable>;
}

let cachedAssets: LoadedSoldierAssets | null = null;
let assetsPromise: Promise<LoadedSoldierAssets> | null = null;
let sharedFlashTex: THREE.CanvasTexture | null = null;
let sharedEyeGeo: THREE.SphereGeometry | null = null;
let sharedShadowTex: THREE.CanvasTexture | null = null;
let sharedShadowGeo: THREE.PlaneGeometry | null = null;

function countGeoTris(g: THREE.BufferGeometry): number {
  return Math.round(g.index ? g.index.count / 3 : g.getAttribute('position').count / 3);
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

/** Local procedural 128² radial-gradient contact shadow texture (created once, no external assets). */
function makeContactShadowTex(): THREE.CanvasTexture {
  const size = 128;
  const half = size / 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half - 2);
  g.addColorStop(0.0, 'rgba(16, 22, 30, 0.72)');
  g.addColorStop(0.28, 'rgba(16, 22, 30, 0.56)');
  g.addColorStop(0.54, 'rgba(16, 22, 30, 0.28)');
  g.addColorStop(0.78, 'rgba(16, 22, 30, 0.08)');
  g.addColorStop(1.0, 'rgba(16, 22, 30, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Measure exact current skinned bounding-box minY for a model hierarchy. */
function measureHierarchyMinY(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    const sm = obj as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.update();
  });
  const box = new THREE.Box3().setFromObject(root, true);
  return box.isEmpty() || !Number.isFinite(box.min.y) ? 0 : box.min.y;
}

function isOneShotClip(name: EnemyClip): boolean {
  return name === 'fire_rifle' || name === 'reload_rifle' || name === 'hit' || name === 'die';
}

/** Merge static rifle child meshes by material (13 meshes -> 3 meshes) to keep draw calls lean. */
function buildMergedRifleParts(
  rifleScene: THREE.Group,
): { parts: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[]; tris: number } {
  rifleScene.updateMatrixWorld(true);
  const byMat = new Map<
    string,
    { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[] }
  >();
  let totalTris = 0;

  rifleScene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const rawMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const std = (rawMat as THREE.MeshStandardMaterial) ?? new THREE.MeshStandardMaterial();
    const key = std.name || std.uuid;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    const nonIdx = g.index ? g.toNonIndexed() : g;
    // Strip inconsistent optional attributes so mergeGeometries always succeeds
    for (const attrName of Object.keys(nonIdx.attributes)) {
      if (attrName !== 'position' && attrName !== 'normal') {
        nonIdx.deleteAttribute(attrName);
      }
    }
    if (!nonIdx.getAttribute('normal')) nonIdx.computeVertexNormals();
    totalTris += countGeoTris(nonIdx);
    let bucket = byMat.get(key);
    if (!bucket) {
      bucket = { mat: std, geos: [] };
      byMat.set(key, bucket);
    }
    bucket.geos.push(nonIdx);
  });

  const parts: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[] = [];
  for (const { mat, geos } of byMat.values()) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (merged) {
      parts.push({ geo: merged, mat });
    }
  }
  return { parts, tris: totalTris };
}

function resolveModelBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? '/transport/';
}

export function preloadEnemyModels(): Promise<LoadedSoldierAssets> {
  if (cachedAssets) return Promise.resolve(cachedAssets);
  if (assetsPromise) return assetsPromise;

  const loader = new GLTFLoader();
  const base = resolveModelBase();
  assetsPromise = Promise.all([
    loader.loadAsync(`${base}models/soldier.glb`),
    loader.loadAsync(`${base}models/weapon_rifle.glb`),
  ]).then(([soldierGltf, rifleGltf]) => {
    let soldierTris = 0;
    let bootMeshName = '';
    let lowestGeoY = Infinity;
    soldierGltf.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh && m.geometry) {
        soldierTris += countGeoTris(m.geometry);
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const geoMinY = m.geometry.boundingBox?.min.y ?? Infinity;
        if (geoMinY < lowestGeoY) {
          lowestGeoY = geoMinY;
          bootMeshName = m.name;
        }
      }
    });

    const clips = new Map<EnemyClip, THREE.AnimationClip>();
    for (const name of REQUIRED_CLIPS) {
      const found = soldierGltf.animations.find((a) => a.name === name);
      if (found) clips.set(name, found);
    }

    // Measure model-space bind-pose minY and per-clip foot minY curves ONCE at load time
    const modelMinY = measureHierarchyMinY(soldierGltf.scene);
    const clipMinYTables = new Map<EnemyClip, ClipMinYTable>();
    const sampleScene = SkeletonUtils.clone(soldierGltf.scene);
    const sampleTarget = (bootMeshName && sampleScene.getObjectByName(bootMeshName)) || sampleScene;
    const sampleMixer = new THREE.AnimationMixer(sampleScene);
    for (const name of GROUNDED_CLIPS) {
      const clip = clips.get(name);
      if (!clip) continue;
      const action = sampleMixer.clipAction(clip);
      action.reset().setEffectiveWeight(1).play();
      const samples = new Float32Array(CLIP_MINY_SAMPLES + 1);
      for (let i = 0; i <= CLIP_MINY_SAMPLES; i++) {
        sampleMixer.setTime((clip.duration * i) / CLIP_MINY_SAMPLES);
        sampleScene.updateMatrixWorld(true);
        samples[i] = measureHierarchyMinY(sampleTarget);
      }
      action.stop();
      clipMinYTables.set(name, {
        samples,
        duration: clip.duration,
        loop: !isOneShotClip(name),
      });
    }
    sampleMixer.stopAllAction();

    const rifle = buildMergedRifleParts(rifleGltf.scene);
    const dieClip = clips.get('die');
    cachedAssets = {
      soldierScene: soldierGltf.scene,
      clips,
      rifleParts: rifle.parts,
      soldierTris,
      rifleTris: rifle.tris,
      dieDurationSec: dieClip ? dieClip.duration : 2.333,
      modelMinY,
      bootMeshName,
      clipMinYTables,
    };
    return cachedAssets;
  });
  return assetsPromise;
}

function wrapPi(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

function turnAngleToward(current: number, target: number, maxStep: number): number {
  const diff = wrapPi(target - current);
  if (Math.abs(diff) <= maxStep) return wrapPi(target);
  return wrapPi(current + Math.sign(diff) * maxStep);
}

export class EnemyRig {
  readonly root = new THREE.Group();
  readonly faction: Faction;

  private model: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<EnemyClip, THREE.AnimationAction>();
  private activeClip: EnemyClip | null = null;
  private activeAction: THREE.AnimationAction | null = null;
  private lastFireAnimStartAt = -10000;
  private lastHitAt = -10000;

  private headBone: THREE.Object3D | null = null;
  private bootMesh: THREE.SkinnedMesh | null = null;
  private shadowMesh: THREE.Mesh | null = null;
  private shadowMat: THREE.MeshBasicMaterial | null = null;
  private baseModelMinY = 0;
  private clipMinYTables: Map<EnemyClip, ClipMinYTable> | null = null;
  private currentFootLift = 0;
  private deathStartFootLift = 0;
  private readonly scratchBox = new THREE.Box3();
  private muzzleAnchor: THREE.Object3D | null = null;
  private muzzleMesh: THREE.Mesh | null = null;
  private muzzleMat: THREE.MeshBasicMaterial | null = null;
  private bodyMaterials: THREE.MeshStandardMaterial[] = [];
  private eyeMat: THREE.MeshStandardMaterial | null = null;
  private hitFlash = 0;

  private modelYaw = 0;
  private yawInitialized = false;
  private loaded = false;
  private triCount = 0;
  private dieDurationSec = 2.333;
  private deadElapsedSec = 0;
  private deadStarted = false;
  private fadePrepared = false;
  private disposed = false;

  /** Clips played by this enemy instance (diagnostic telemetry for e2e). */
  readonly clipsPlayed = new Set<EnemyClip>();

  constructor(faction: Faction) {
    this.faction = faction;
    this.root.name = `enemy-rig-${faction}`;
    if (cachedAssets) {
      this.hydrate(cachedAssets);
    }
  }

  get triangleCount(): number {
    return this.triCount;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get currentClip(): EnemyClip {
    return this.activeClip ?? 'idle_rifle';
  }

  get isFinishedCorpse(): boolean {
    return this.disposed;
  }

  /** Build the cloned soldier, faction materials, rifle on Socket_Hand_R, eye orb on Head, and AnimationMixer. */
  hydrate(assets: LoadedSoldierAssets): void {
    if (this.loaded) return;
    const isBL = this.faction === 'bl';
    const eyeCol = isBL ? PALETTE.blEye : PALETTE.grEye;

    // Clone rigged humanoid via SkeletonUtils.clone() (never re-parses GLB)
    const cloned = SkeletonUtils.clone(assets.soldierScene);
    cloned.name = `soldier-${this.faction}`;
    this.model = cloned;
    this.dieDurationSec = assets.dieDurationSec;

    // Faction dyeing:
    //   潜伏者 (bl): TeamColour -> #b3221f, other materials darkened to 0.55 brightness
    //   保卫者 (gr): TeamColour -> #2f6fb0, other materials brightened to 1.05 brightness
    const seenMats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const dyeMaterial = (orig: THREE.Material): THREE.MeshStandardMaterial => {
      const existing = seenMats.get(orig);
      if (existing) return existing;
      const mat = (orig as THREE.MeshStandardMaterial).clone();
      if (mat.name === 'TeamColour') {
        mat.color.set(isBL ? PALETTE.blTeam : PALETTE.grTeam);
      } else {
        const mult = isBL ? 0.55 : 1.05;
        mat.color.r = Math.min(1, mat.color.r * mult);
        mat.color.g = Math.min(1, mat.color.g * mult);
        mat.color.b = Math.min(1, mat.color.b * mult);
      }
      mat.envMapIntensity = 0.85;
      mat.emissive.set('#000000');
      mat.emissiveIntensity = 0;
      seenMats.set(orig, mat);
      this.bodyMaterials.push(mat);
      return mat;
    };

    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(dyeMaterial);
      } else if (mesh.material) {
        mesh.material = dyeMaterial(mesh.material);
      }
    });

    // Attach weapon_rifle.glb onto Socket_Hand_R at position (0,0,0), rotation (0,0,0)
    const handSocket = cloned.getObjectByName('Socket_Hand_R') ?? cloned.getObjectByName('Hand_R');
    const rifleGroup = new THREE.Group();
    rifleGroup.name = 'enemy-rifle';
    rifleGroup.position.set(0, 0, 0);
    rifleGroup.rotation.set(0, 0, 0);
    for (const part of assets.rifleParts) {
      const rMat = part.mat.clone();
      rMat.envMapIntensity = 0.9;
      this.bodyMaterials.push(rMat);
      const rMesh = new THREE.Mesh(part.geo, rMat);
      rMesh.castShadow = false;
      rMesh.receiveShadow = true;
      rMesh.frustumCulled = false;
      rifleGroup.add(rMesh);
    }

    // Muzzle anchor & muzzle flash quad at brake tip (+0.64, 0, -0.062) in weapon_rifle local space
    this.muzzleAnchor = new THREE.Object3D();
    this.muzzleAnchor.position.set(0.64, 0, -0.062);
    rifleGroup.add(this.muzzleAnchor);

    if (!sharedFlashTex) sharedFlashTex = makeEnemyFlashTex();
    this.muzzleMat = new THREE.MeshBasicMaterial({
      map: sharedFlashTex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.muzzleMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), this.muzzleMat);
    this.muzzleMesh.position.set(0.66, 0, -0.062);
    this.muzzleMesh.rotation.y = Math.PI / 2;
    this.muzzleMesh.visible = false;
    this.muzzleMesh.frustumCulled = false;
    rifleGroup.add(this.muzzleMesh);

    if (handSocket) {
      handSocket.add(rifleGroup);
    } else {
      cloned.add(rifleGroup);
    }

    // Glowing emissive eye lamp orb mounted on Head bone (red for BL, blue for GR)
    this.headBone = cloned.getObjectByName('Head') ?? null;
    if (!sharedEyeGeo) sharedEyeGeo = new THREE.SphereGeometry(0.038, 10, 8);
    this.eyeMat = new THREE.MeshStandardMaterial({
      color: eyeCol,
      emissive: eyeCol,
      emissiveIntensity: 2.4,
      roughness: 0.2,
      metalness: 0.1,
    });
    const eyeOrb = new THREE.Mesh(sharedEyeGeo, this.eyeMat);
    eyeOrb.name = `eye-lamp-${this.faction}`;
    // Head world y=1.55; visor front sits at local (0, +0.112, +0.128) along +Z face direction
    eyeOrb.position.set(0, 0.112, 0.128);
    eyeOrb.castShadow = false;
    eyeOrb.frustumCulled = false;
    if (this.headBone) {
      this.headBone.add(eyeOrb);
    } else {
      eyeOrb.position.set(0, 1.662, 0.128);
      cloned.add(eyeOrb);
    }

    // Align model boots with root.position.y using load-time Box3 minY
    this.baseModelMinY = assets.modelMinY;
    this.clipMinYTables = assets.clipMinYTables;
    this.currentFootLift = computeFootLift(assets.modelMinY);
    cloned.position.y = this.currentFootLift;
    const bootCandidate = assets.bootMeshName ? cloned.getObjectByName(assets.bootMeshName) : null;
    this.bootMesh =
      bootCandidate && (bootCandidate as THREE.SkinnedMesh).isSkinnedMesh
        ? (bootCandidate as THREE.SkinnedMesh)
        : null;

    // Soft radial contact shadow disc sitting at entity.pos.y + 0.012 under root (independent of model lift/yaw)
    if (!sharedShadowTex) sharedShadowTex = makeContactShadowTex();
    if (!sharedShadowGeo) {
      sharedShadowGeo = new THREE.PlaneGeometry(CONTACT_SHADOW_DIAMETER, CONTACT_SHADOW_DIAMETER);
      sharedShadowGeo.rotateX(-Math.PI / 2);
    }
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: sharedShadowTex,
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      depthWrite: false,
    });
    this.shadowMesh = new THREE.Mesh(sharedShadowGeo, this.shadowMat);
    this.shadowMesh.name = `enemy-shadow-${this.faction}`;
    this.shadowMesh.position.set(0, CONTACT_SHADOW_Y, 0);
    this.shadowMesh.renderOrder = CONTACT_SHADOW_RENDER_ORDER;
    this.shadowMesh.castShadow = false;
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.frustumCulled = false;
    this.root.add(this.shadowMesh);

    this.root.add(cloned);

    // Independent AnimationMixer + all 9 state-machine actions
    this.mixer = new THREE.AnimationMixer(cloned);
    for (const [clipName, clip] of assets.clips) {
      const action = this.mixer.clipAction(clip);
      if (clipName === 'fire_rifle') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.timeScale = clip.duration / FIRE_CLIP_TARGET_SEC;
      } else if (clipName === 'reload_rifle') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.timeScale = clip.duration / RELOAD_CLIP_TARGET_SEC;
      } else if (clipName === 'hit') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.timeScale = clip.duration / HIT_CLIP_TARGET_SEC;
      } else if (clipName === 'die') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.timeScale = 1.0;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.timeScale = 1.0;
      }
      this.actions.set(clipName, action);
    }

    this.triCount = assets.soldierTris + assets.rifleTris + countGeoTris(sharedEyeGeo);
    this.loaded = true;
  }

  /** Smoothly crossFadeTo target clip over 0.18s (never instant cut). */
  private transitionTo(clip: EnemyClip, forceRestart = false): void {
    if (!this.mixer) return;
    const next = this.actions.get(clip);
    if (!next) return;

    if (this.activeClip === clip && !forceRestart) return;

    const prev = this.activeAction;
    this.activeClip = clip;
    this.activeAction = next;
    this.clipsPlayed.add(clip);

    if (!prev) {
      next.enabled = true;
      next.reset();
      next.setEffectiveWeight(1);
      next.play();
      return;
    }

    if (prev === next) {
      // Re-trigger same one-shot clip (e.g., consecutive hits) cleanly
      next.enabled = true;
      next.reset();
      next.setEffectiveWeight(1);
      next.play();
      return;
    }

    next.enabled = true;
    next.reset();
    next.setEffectiveWeight(1);
    next.play();
    prev.crossFadeTo(next, CROSSFADE_SEC, false);
  }

  /** Measure live model-space boot minY during brief crossfade transitions. */
  private measureBootModelMinY(): number {
    if (!this.model || !this.bootMesh) return this.baseModelMinY;
    this.model.position.y = 0;
    this.root.updateMatrixWorld(true);
    this.bootMesh.skeleton.update();
    this.scratchBox.setFromObject(this.bootMesh, true);
    if (this.scratchBox.isEmpty() || !Number.isFinite(this.scratchBox.min.y)) {
      return this.baseModelMinY;
    }
    return this.scratchBox.min.y - this.root.position.y;
  }

  /** Keep soles flush on root.position.y across idle, walk, run, crouch, aim, fire, reload & hit clips. */
  private updateFootGrounding(): void {
    if (!this.model) return;
    let activeCount = 0;
    let singleClip: EnemyClip | null = null;
    let singleAction: THREE.AnimationAction | null = null;

    if (this.clipMinYTables) {
      for (const name of GROUNDED_CLIPS) {
        const action = this.actions.get(name);
        if (!action || !action.isScheduled() || action.getEffectiveWeight() <= 0.001) continue;
        activeCount++;
        singleClip = name;
        singleAction = action;
      }
    }

    let minY = this.baseModelMinY;
    if (activeCount === 1 && singleClip && singleAction && this.clipMinYTables) {
      const table = this.clipMinYTables.get(singleClip);
      if (table) {
        minY = sampleClipMinY(table.samples, table.duration, singleAction.time, table.loop);
      }
    } else if (activeCount > 1) {
      // Mid-crossfade (0.18s): measure blended boot pose so transitions never float or sink
      minY = this.measureBootModelMinY();
    }

    this.currentFootLift = computeFootLift(minY);
    this.model.position.y = this.currentFootLift;
  }

  /** Real-time world-space Box3 lowest Y of the soldier model (excludes contact shadow). Called on demand only. */
  measureFeetWorldY(): number | null {
    if (!this.loaded || !this.model) return null;
    this.root.updateMatrixWorld(true);
    this.model.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.update();
    });
    const box = new THREE.Box3().setFromObject(this.model, true);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return null;
    return box.min.y;
  }

  /** Read actual world-space head top (0.25m above Head bone) so overhead tags track standing/crouch. */
  getHeadTopWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.headBone) {
      this.headBone.getWorldPosition(out);
      out.y += 0.25;
      return out;
    }
    return out.set(this.root.position.x, this.root.position.y + 1.8, this.root.position.z);
  }

  /** Read actual rifle barrel tip world position for enemy bullet tracers. */
  getMuzzleWorld(out: THREE.Vector3): boolean {
    if (!this.muzzleAnchor || !this.loaded) return false;
    this.muzzleAnchor.getWorldPosition(out);
    return true;
  }

  /** Synchronize position, smooth model.rotation.y (8 rad/s), AnimationMixer, muzzle flash & death fade. */
  sync(bot: EnemyBot, dt: number, nowMs: number): void {
    const p = bot.entity.pos;
    this.root.position.set(p.x, p.y, p.z);

    if (!this.loaded) {
      if (cachedAssets) this.hydrate(cachedAssets);
      else return;
    }

    // soldier.glb faces +Z while ai.ts yaw=0 faces -Z -> target model.rotation.y = bot.yaw + PI
    const targetModelYaw = wrapPi(bot.yaw + Math.PI);
    if (!this.yawInitialized) {
      this.modelYaw = targetModelYaw;
      this.yawInitialized = true;
    } else if (bot.state !== 'DEAD' && bot.entity.alive) {
      this.modelYaw = turnAngleToward(this.modelYaw, targetModelYaw, BOT_TURN_RATE * dt);
    }
    if (this.model) {
      this.model.rotation.y = this.modelYaw;
    }

    // --- DEAD state: play die to last frame, hold 2.5s, then fade out ---
    if (bot.state === 'DEAD' || !bot.entity.alive) {
      this.advanceDeath(dt);
      return;
    }

    // Select clip strictly from AI state machine
    const desiredClip: EnemyClip = bot.anim;
    const isNewFire =
      desiredClip === 'fire_rifle' && bot.fireAnimStartAt !== this.lastFireAnimStartAt;
    const isNewHit = desiredClip === 'hit' && bot.lastHitAt !== this.lastHitAt;
    if (isNewFire) this.lastFireAnimStartAt = bot.fireAnimStartAt;
    if (isNewHit) this.lastHitAt = bot.lastHitAt;

    this.transitionTo(desiredClip, isNewFire || isNewHit);

    if (this.mixer) {
      this.mixer.update(dt);
    }
    this.updateFootGrounding();

    // Muzzle flash quad visible briefly at the 0.18s shot moment (bot.lastFireAt)
    if (this.muzzleMesh && this.muzzleMat) {
      const sinceFire = nowMs - bot.lastFireAt;
      const flashOn = sinceFire >= 0 && sinceFire < 75;
      this.muzzleMesh.visible = flashOn;
      if (flashOn) {
        this.muzzleMat.opacity = 1 - sinceFire / 75;
        this.muzzleMesh.rotation.x = (nowMs * 0.11) % (Math.PI * 2);
        const sc = 0.85 + 0.35 * (1 - sinceFire / 75);
        this.muzzleMesh.scale.set(sc, sc, 1);
      }
    }

    // Subtle red emissive hit highlight during 0.25s hit flinch
    const sinceHit = nowMs - bot.lastHitAt;
    const targetFlash = sinceHit >= 0 && sinceHit < 250 ? Math.sin((1 - sinceHit / 250) * Math.PI) : 0;
    this.hitFlash += (targetFlash - this.hitFlash) * Math.min(1, 20 * dt);
    for (const mat of this.bodyMaterials) {
      if (this.hitFlash > 0.01) {
        mat.emissive.set(PALETTE.accent);
        mat.emissiveIntensity = this.hitFlash * 0.42;
      } else if (mat.emissiveIntensity !== 0) {
        mat.emissiveIntensity = 0;
      }
    }
  }

  /** Advance die animation, 2.5s last-frame hold, and 0.6s fade-out (works both while in bots[] and as detached corpse). */
  advanceDeath(dt: number): void {
    if (!this.loaded) {
      this.disposed = true;
      return;
    }
    if (!this.deadStarted) {
      this.deadStarted = true;
      this.deadElapsedSec = 0;
      this.deathStartFootLift = this.currentFootLift;
      this.transitionTo('die', false);
      if (this.muzzleMesh) this.muzzleMesh.visible = false;
      for (const mat of this.bodyMaterials) {
        mat.emissiveIntensity = 0;
      }
    }

    this.deadElapsedSec += dt;
    if (this.mixer) {
      this.mixer.update(dt);
    }
    if (this.model) {
      const relaxT = Math.min(1, this.deadElapsedSec / DEATH_LIFT_RELAX_SEC);
      const baseLift = computeFootLift(this.baseModelMinY);
      this.currentFootLift = this.deathStartFootLift + (baseLift - this.deathStartFootLift) * relaxT;
      this.model.position.y = this.currentFootLift;
    }

    const fadeStartSec = this.dieDurationSec + CORPSE_HOLD_SEC;
    if (this.deadElapsedSec >= fadeStartSec) {
      if (!this.fadePrepared) {
        this.fadePrepared = true;
        for (const mat of this.bodyMaterials) {
          mat.transparent = true;
          mat.depthWrite = false;
          mat.needsUpdate = true;
        }
        if (this.eyeMat) {
          this.eyeMat.transparent = true;
          this.eyeMat.depthWrite = false;
          this.eyeMat.needsUpdate = true;
        }
      }
      const u = Math.min(1, (this.deadElapsedSec - fadeStartSec) / CORPSE_FADE_SEC);
      const opacity = 1 - u;
      for (const mat of this.bodyMaterials) {
        mat.opacity = opacity;
      }
      if (this.eyeMat) {
        this.eyeMat.opacity = opacity;
        this.eyeMat.emissiveIntensity = 2.4 * opacity;
      }
      if (this.shadowMat) {
        this.shadowMat.opacity = CONTACT_SHADOW_OPACITY * opacity;
      }
      if (u >= 1) {
        if (this.shadowMesh) this.shadowMesh.visible = false;
        this.disposed = true;
      }
    }
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    for (const mat of this.bodyMaterials) mat.dispose();
    this.bodyMaterials.length = 0;
    this.eyeMat?.dispose();
    this.shadowMat?.dispose();
    this.muzzleMat?.dispose();
    this.muzzleMesh?.geometry.dispose();
  }
}

export class EnemyRenderer {
  private readonly scene: THREE.Scene;
  private rigs = new Map<string, EnemyRig>();
  /** Corpses detached from active bot slots so die + 2.5s hold + fade-out always completes. */
  private dyingCorpses: EnemyRig[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // Start preloading soldier.glb + weapon_rifle.glb immediately on page boot
    void preloadEnemyModels().then((assets) => {
      for (const rig of this.rigs.values()) {
        if (!rig.isLoaded) rig.hydrate(assets);
      }
    });
  }

  get isModelLoaded(): boolean {
    return cachedAssets !== null;
  }

  get modelSource(): string {
    return SOLDIER_MODEL_SOURCE;
  }

  /** Synchronize rendered EnemyRigs with active EnemyBots (creates rigs & preserves fading corpses). */
  sync(bots: readonly EnemyBot[], dt: number, nowMs: number, _cameraPos?: THREE.Vector3): void {
    const aliveIds = new Set<string>();
    for (const bot of bots) {
      aliveIds.add(bot.id);
      let rig = this.rigs.get(bot.id);
      if (!rig) {
        rig = new EnemyRig(bot.faction);
        this.rigs.set(bot.id, rig);
        this.scene.add(rig.root);
      }
      rig.sync(bot, dt, nowMs);
    }

    for (const [id, rig] of this.rigs) {
      if (!aliveIds.has(id)) {
        this.rigs.delete(id);
        if (rig.currentClip === 'die' && !rig.isFinishedCorpse) {
          this.dyingCorpses.push(rig);
        } else {
          this.scene.remove(rig.root);
          rig.dispose();
        }
      }
    }

    // Advance detached dying corpses through last-frame hold & fade-out
    for (let i = this.dyingCorpses.length - 1; i >= 0; i--) {
      const c = this.dyingCorpses[i];
      c.advanceDeath(dt);
      if (c.isFinishedCorpse) {
        this.scene.remove(c.root);
        c.dispose();
        this.dyingCorpses.splice(i, 1);
      }
    }
  }

  /** Immediately remove all live rigs and fading corpses (menu reset / e2e clearEnemies). */
  clearAll(): void {
    for (const rig of this.rigs.values()) {
      this.scene.remove(rig.root);
      rig.dispose();
    }
    this.rigs.clear();
    for (const c of this.dyingCorpses) {
      this.scene.remove(c.root);
      c.dispose();
    }
    this.dyingCorpses.length = 0;
  }

  getRigTris(botId: string): number {
    return this.rigs.get(botId)?.triangleCount ?? 0;
  }

  getActiveClip(botId: string): EnemyClip {
    return this.rigs.get(botId)?.currentClip ?? 'idle_rifle';
  }

  getClipsPlayed(botId: string): EnemyClip[] {
    const rig = this.rigs.get(botId);
    return rig ? Array.from(rig.clipsPlayed) : [];
  }

  getHeadTopWorld(botId: string, out: THREE.Vector3): boolean {
    const rig = this.rigs.get(botId);
    if (!rig) return false;
    rig.getHeadTopWorld(out);
    return true;
  }

  getMuzzleWorld(botId: string, out: THREE.Vector3): boolean {
    const rig = this.rigs.get(botId);
    if (!rig) return false;
    return rig.getMuzzleWorld(out);
  }

  getMaxBotTris(): number {
    let mx = 0;
    for (const r of this.rigs.values()) {
      if (r.triangleCount > mx) mx = r.triangleCount;
    }
    return mx;
  }

  measureFeetWorldY(botId: string): number | null {
    return this.rigs.get(botId)?.measureFeetWorldY() ?? null;
  }
}
