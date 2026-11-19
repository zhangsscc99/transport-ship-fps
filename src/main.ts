// Entry point: engine + lighting + ship blockout + FPS controller.

import * as THREE from 'three';
import { Engine } from './render/engine';
import { addLights } from './render/lighting';
import { buildMap } from './render/map';
import { PlayerCamera } from './render/camera';
import { Player } from './game/player';
import { isInsideBounds, spawnPoint } from './game/map';
import { createInput } from './game/input';
import { PALETTE } from './render/palette';

const canvas = document.getElementById('game') as HTMLCanvasElement;

const engine = new Engine(canvas);
engine.scene.background = new THREE.Color(PALETTE.sky[0]);
engine.scene.fog = new THREE.Fog(PALETTE.fog, 45, 190);

addLights(engine.scene);
buildMap(engine.scene);

const [sx, sy, sz] = spawnPoint('A', 0);
const player = new Player({ x: sx, y: sy, z: sz });
const input = createInput(canvas);
const view = new PlayerCamera(window.innerWidth / window.innerHeight);

engine.camera = view.camera;
engine.onResize = (w, h) => view.setAspect(w / h);
engine.onFrame = (dt) => {
  player.update(dt, input.snapshot(), {
    isInside: isInsideBounds,
    groundHeight: () => 0, // flat deck until F105 collision lands
  });
  view.update(player, dt);
};

view.snap(player);
engine.start();
