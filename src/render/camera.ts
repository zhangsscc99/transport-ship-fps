// Maps pure Player state onto a PerspectiveCamera.
// Eye height 1.7 standing / 1.15 crouched (SPEC §移动); pitch already
// clamped to ±85° inside Player.update.

import * as THREE from 'three';
import type { Player } from '../game/player';

export class PlayerCamera {
  readonly camera: THREE.PerspectiveCamera;
  private eyeY = 0;

  constructor(aspect: number, fov = 75) {
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 300);
    this.camera.rotation.order = 'YXZ';
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(player: Player, dt: number): void {
    const p = player.position;
    const targetEye = player.eyeHeight;
    // Critically-damped-ish smoothing so crouching doesn't snap.
    const k = 1 - Math.exp(-18 * dt);
    this.eyeY += (p.y + targetEye - this.eyeY) * k;
    this.camera.position.set(p.x, this.eyeY, p.z);
    this.camera.rotation.set(player.pitch, player.yaw, 0);
  }

  /** Snap to the player (used on spawn/respawn, no lerp). */
  snap(player: Player): void {
    this.eyeY = player.position.y + player.eyeHeight;
    this.update(player, 0);
  }
}
