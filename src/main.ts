// Entry point: engine + lighting + ship + collision-driven FPS controller +
// weapons (fire/reload/swap) + HUD + touch controls. Pure game state lives in
// src/game/**; this file only wires it into the renderer.

import * as THREE from 'three';
import { Engine } from './render/engine';
import { addLights } from './render/lighting';
import { buildMap } from './render/map';
import { PlayerCamera } from './render/camera';
import { WeaponView, TracerPool } from './render/weapon';
import { Hud } from './render/hud';
import { Player, MOVE, type Vec3 } from './game/player';
import { MAP, spawnPoint } from './game/map';
import { CollisionWorld, PLAYER_RADIUS } from './game/collision';
import { KeyboardMouseInput, mergeInputs } from './game/input';
import { TouchControls } from './input/touch';
import { WeaponRack } from './game/weapons';
import { createEntity, type Entity } from './game/entities';
import { traceHit, falloffFactor, applyDamage, updateRespawn, HEADSHOT_MULT, type Ray } from './game/damage';
import { PALETTE } from './render/palette';

declare global {
  interface Window {
    __state: { x: number; y: number; z: number; hp: number; ammo: number; dead: boolean };
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;

const engine = new Engine(canvas);
engine.scene.background = new THREE.Color(PALETTE.sky[0]);
engine.scene.fog = new THREE.Fog(PALETTE.fog, 45, 190);

addLights(engine.scene);
buildMap(engine.scene);

const world = new CollisionWorld(MAP.boxes, MAP.bounds, MAP.waterY);
const [sx, sy, sz] = spawnPoint('A', 0);
const player = new Player({ x: sx, y: sy, z: sz });
const kb = new KeyboardMouseInput(canvas);
const touch = new TouchControls(document.body);
const view = new PlayerCamera(window.innerWidth / window.innerHeight);

const rack = new WeaponRack();
const weaponView = new WeaponView();
view.camera.add(weaponView.group);
engine.scene.add(view.camera);
const tracers = new TracerPool(engine.scene);
const hud = new Hud(document.body, touch.enabled);

const playerEnt = createEntity('player', player.position, 100, PLAYER_RADIUS, MOVE.eyeHeight);
const entities: Entity[] = []; // enemy bots arrive in a later milestone
let spawnIdx = 1;

const scratchMuzzle = new THREE.Vector3();
const rayEnd = (ray: Ray, dist: number): Vec3 => ({
  x: ray.origin.x + ray.dir.x * dist,
  y: ray.origin.y + ray.dir.y * dist,
  z: ray.origin.z + ray.dir.z * dist,
});

/** camera-space aim direction derived from yaw/pitch (matches Player.forward) */
function aimDir(): Vec3 {
  const cp = Math.cos(player.pitch);
  return {
    x: -Math.sin(player.yaw) * cp,
    y: Math.sin(player.pitch),
    z: -Math.cos(player.yaw) * cp,
  };
}

engine.camera = view.camera;
engine.onResize = (w, h) => view.setAspect(w / h);
engine.onFrame = (dt) => {
  const now = performance.now();
  const inp = mergeInputs(kb.snapshot(), touch.snapshot());

  if (playerEnt.alive) {
    player.update(dt, inp, { collider: world });
    if (player.drowned) applyDamage(playerEnt, 9999, now);
  }
  if (!playerEnt.alive) {
    const [rx, ry, rz] = spawnPoint('A', spawnIdx);
    if (updateRespawn(playerEnt, now, { x: rx, y: ry, z: rz })) {
      spawnIdx++;
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
      player.drowned = false;
      player.yaw = 0;
      player.pitch = 0;
      view.snap(player);
    }
  }

  view.update(player, dt);

  const w = rack.current;
  if (playerEnt.alive) {
    if (inp.swap) weaponView.setWeapon(rack.swap().spec.id);
    if (inp.reload) w.reload(now);
    if (inp.fire && player.onGround) {
      const eye: Vec3 = {
        x: player.position.x,
        y: player.position.y + player.eyeHeight,
        z: player.position.z,
      };
      const shots = w.tryFire(now, eye, aimDir());
      if (shots) {
        weaponView.onFire();
        weaponView.muzzleWorld(scratchMuzzle);
        for (const ray of shots) {
          const hit = traceHit(ray, MAP.boxes, entities);
          tracers.fire(scratchMuzzle, hit ? hit.point : rayEnd(ray, 80));
          if (hit?.kind === 'entity') {
            const dmg =
              w.spec.dmg *
              falloffFactor(w.spec, hit.dist) *
              (hit.headshot ? HEADSHOT_MULT : 1);
            applyDamage(hit.entity, dmg, now);
          }
        }
      }
    }
  }

  weaponView.group.visible = playerEnt.alive;
  weaponView.update(dt);
  tracers.update(dt);

  const focalPx = window.innerHeight / 2 / Math.tan((view.camera.fov / 2) * (Math.PI / 180));
  hud.update({
    hp: playerEnt.hp,
    maxHp: playerEnt.maxHp,
    ammo: w.ammo,
    reloading: w.reloading,
    weaponName: w.spec.name,
    spreadPx: Math.tan(w.spreadAt(now)) * focalPx,
    fps: window.__fps,
    dead: !playerEnt.alive,
    respawnIn: (playerEnt.deadUntil - now) / 1000,
  });

  dbg.x = player.position.x;
  dbg.y = player.position.y;
  dbg.z = player.position.z;
  dbg.hp = playerEnt.hp;
  dbg.ammo = w.ammo;
  dbg.dead = !playerEnt.alive;
};

/** persistent debug handle (no per-frame alloc) — e2e tests read this */
const dbg = { x: 0, y: 0, z: 0, hp: 0, ammo: 0, dead: false };
window.__state = dbg;

view.snap(player);
engine.start();
