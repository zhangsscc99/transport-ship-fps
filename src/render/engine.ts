// WebGL render loop. Mobile-first settings per docs/ART-SPEC.md §5:
// antialias off, DPR capped at 2, pause when the tab is hidden.

import * as THREE from 'three';

declare global {
  interface Window {
    __fps: number;
    __frames: number;
  }
}

export type FrameCallback = (dt: number) => void;
export type ResizeCallback = (w: number, h: number) => void;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  camera: THREE.Camera | null = null;
  onFrame: FrameCallback = () => {};
  onResize: ResizeCallback = () => {};

  private rafId = 0;
  private running = false;
  private lastT = 0;
  private emaDt = 1 / 60;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();

    window.addEventListener('resize', () => this.handleResize());
    window.addEventListener('orientationchange', () => this.handleResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.resume();
    });

    window.__fps = 0;
    window.__frames = 0;
  }

  private handleResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.onResize(w, h);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      let dt = (t - this.lastT) / 1000;
      this.lastT = t;
      if (dt > 0.1) dt = 0.1; // clamp hitches
      if (dt <= 0) dt = 1 / 240;
      this.emaDt += (dt - this.emaDt) * 0.05;
      window.__fps = 1 / this.emaDt;
      window.__frames++;
      this.onFrame(dt);
      if (this.camera) this.renderer.render(this.scene, this.camera);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  pause(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  resume(): void {
    this.start(); // lastT resets inside start()
  }

  /** Render the current scene once without advancing simulation or clocks (for paused A/B checks). */
  renderOnce(freezeShadowMap = false): void {
    if (!this.camera) return;
    if (freezeShadowMap) {
      const prevAuto = this.renderer.shadowMap.autoUpdate;
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.render(this.scene, this.camera);
      this.renderer.shadowMap.autoUpdate = prevAuto;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    this.pause();
    this.renderer.dispose();
  }
}
