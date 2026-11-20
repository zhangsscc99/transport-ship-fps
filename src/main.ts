// Entry point: engine + lighting + ship + collision-driven FPS controller +
// weapons (fire/reload/swap) + HUD + touch controls. Pure game state lives in
// src/game/**; this file only wires it into the renderer.

import * as THREE from 'three';
import { Engine } from './render/engine';
import { addLights, configureRenderer } from './render/lighting';
import { applyAtmosphere } from './render/atmosphere';
import { setAnisotropyCap } from './render/textures';
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
import { createMatch } from './game/match';
import { Menu } from './render/menu';
import { PALETTE } from './render/palette';
import { createSfx } from './audio/sfx';

declare global {
  interface Window {
    __state: {
      x: number;
      y: number;
      z: number;
      hp: number;
      ammo: number;
      dead: boolean;
      yaw: number;
      pitch: number;
      firing: boolean;
    };
    __sfx: { counts: Record<string, number>; muted: boolean; unlocked: boolean };
    __fx: { hits: number; kills: number; flashOpacity: number; lowHpPulse: number };
    __test: { hurt(dmg: number): void };
    __match: {
      phase: string;
      killsA: number;
      killsB: number;
      timeLeftMs: number;
      winner: string | null;
    };
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;

const engine = new Engine(canvas);
configureRenderer(engine.renderer);
const atmo = applyAtmosphere(engine.scene, engine.renderer);
const lights = addLights(engine.scene);
buildMap(engine.scene);
setAnisotropyCap(engine.renderer.capabilities.getMaxAnisotropy());

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

const sfx = createSfx();
hud.setMuted(sfx.muted);
hud.onMuteToggle = (m) => sfx.setMuted(m);
// AudioContext unlock must happen inside a real user gesture (autoplay policy)
const onFirstGesture = () => void sfx.unlock();
window.addEventListener('pointerdown', onFirstGesture, { once: true });
window.addEventListener('keydown', onFirstGesture, { once: true });

const SHOT_SFX = { rifle: 'shotRifle', sniper: 'shotSniper', shotgun: 'shotShotgun' } as const;
/** stride length per footstep — interval scales with move speed via distance */
const STEP_STRIDE = 2.1;
let stepAcc = 0;

const playerEnt = createEntity('player', player.position, 100, PLAYER_RADIUS, MOVE.eyeHeight);
const entities: Entity[] = []; // enemy bots arrive in a later milestone
let spawnIdx = 1;

const match = createMatch();
const menu = new Menu(document.body, {
  onStart: () => {
    match.start(performance.now());
    menu.hide();
    // fresh round: revive and re-arm the player at spawn
    const [rx, ry, rz] = spawnPoint('A', 0);
    playerEnt.alive = true;
    playerEnt.hp = playerEnt.maxHp;
    playerEnt.deadUntil = 0;
    playerEnt.invincibleUntil = 0;
    player.position.x = rx;
    player.position.y = ry;
    player.position.z = rz;
    player.velocity.x = 0;
    player.velocity.y = 0;
    player.velocity.z = 0;
    player.drowned = false;
    player.yaw = 0;
    player.pitch = 0;
    view.snap(player);
    for (const w of rack.list) {
      w.ammo = w.spec.mag;
      w.cancelReload();
    }
  },
});
menu.show();

const scratchMuzzle = new THREE.Vector3();
const scratchFillDir = new THREE.Vector3();
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

/**
 * Shared hurt path — real damage events and window.__test.hurt() both go
 * through here: damage → edge flash + direction arc + hurt sfx.
 * `angleRad` is the attacker's screen-relative bearing (0 = ahead).
 */
function hurtPlayer(dmg: number, angleRad?: number): void {
  const now = performance.now();
  if (!playerEnt.alive || now < playerEnt.invincibleUntil) return;
  applyDamage(playerEnt, dmg, now);
  hud.hitFrom(angleRad ?? Math.random() * Math.PI * 2, now);
  sfx.play('hurt');
}

engine.camera = view.camera;
engine.onResize = (w, h) => view.setAspect(w / h);
engine.onFrame = (dt) => {
  const now = performance.now();
  const prevPhase = match.phase;
  match.tick(now);
  const acting = match.canAct(now);
  const inp = mergeInputs(kb.snapshot(), touch.snapshot());

  menu.setCountdown(match.phase === 'countdown' ? match.countdownLeftMs : null);
  if (match.phase === 'over' && prevPhase !== 'over') {
    menu.showResult({ winner: match.winner, killsA: match.killsA, killsB: match.killsB });
  }

  if (acting && playerEnt.alive) {
    player.update(dt, inp, { collider: world });
    if (player.drowned && playerEnt.alive) hurtPlayer(9999, Math.PI);

    // footsteps — throttled by distance travelled, so interval follows speed
    const hSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.onGround && hSpeed > 0.5) {
      stepAcc += hSpeed * dt;
      if (stepAcc >= STEP_STRIDE) {
        stepAcc = 0;
        sfx.play('footstep');
      }
    } else {
      stepAcc = 0;
    }
  }
  if (acting && !playerEnt.alive) {
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
  lights.update(now * 0.001);
  atmo.update(view.camera.position);

  // camera-follow fill: parked just above/behind the lens, aimed a few metres
  // down the view axis so gun + foreground props keep a readable mid-tone
  view.camera.getWorldDirection(scratchFillDir);
  lights.camFill.position.copy(view.camera.position).addScaledVector(scratchFillDir, -1.5);
  lights.camFill.position.y += 1.2;
  lights.camFill.target.position.copy(view.camera.position).addScaledVector(scratchFillDir, 6);

  const w = rack.current;
  if (acting && playerEnt.alive) {
    if (inp.swap) weaponView.setWeapon(rack.swap().spec.id);
    if (inp.reload && w.reload(now)) sfx.play('reload');
    if (inp.fire && player.onGround) {
      const eye: Vec3 = {
        x: player.position.x,
        y: player.position.y + player.eyeHeight,
        z: player.position.z,
      };
      const shots = w.tryFire(now, eye, aimDir());
      if (shots) {
        weaponView.onFire();
        sfx.play(SHOT_SFX[w.spec.id]);
        weaponView.muzzleWorld(scratchMuzzle);
        for (const ray of shots) {
          const hit = traceHit(ray, MAP.boxes, entities);
          tracers.fire(scratchMuzzle, hit ? hit.point : rayEnd(ray, 80));
          if (hit?.kind === 'entity') {
            const dmg =
              w.spec.dmg *
              falloffFactor(w.spec, hit.dist) *
              (hit.headshot ? HEADSHOT_MULT : 1);
            sfx.play('hit');
            if (applyDamage(hit.entity, dmg, now)) {
              sfx.play('kill');
              hud.notifyKill(now);
            }
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
  dbg.yaw = player.yaw;
  dbg.pitch = player.pitch;
  dbg.firing = inp.fire;
  dbgSfx.muted = sfx.muted;
  dbgSfx.unlocked = sfx.unlocked;

  mdbg.phase = match.phase;
  mdbg.killsA = match.killsA;
  mdbg.killsB = match.killsB;
  mdbg.timeLeftMs = match.timeLeftMs;
  mdbg.winner = match.winner;
};

/** persistent debug handles (no per-frame alloc) — e2e tests read these */
const dbg = { x: 0, y: 0, z: 0, hp: 0, ammo: 0, dead: false, yaw: 0, pitch: 0, firing: false };
window.__state = dbg;
const dbgSfx = { counts: sfx.counts, muted: false, unlocked: false };
window.__sfx = dbgSfx;
window.__fx = hud.fx;
window.__test = { hurt: (dmg: number) => hurtPlayer(dmg) };
const mdbg = {
  phase: 'menu',
  killsA: 0,
  killsB: 0,
  timeLeftMs: 0,
  winner: null as string | null,
};
window.__match = mdbg;

view.snap(player);
engine.start();
