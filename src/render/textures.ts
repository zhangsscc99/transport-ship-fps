// Procedural canvas textures — zero external assets. Each texture is drawn
// once and cached in a Map; nothing here runs per-frame. ART-SPEC §2:
// ≤512² canvases, palette-only colors, anisotropy capped at 4.

import * as THREE from 'three';
import { PALETTE } from './palette';

export type TextureKey =
  | 'deck'
  | 'deckRough'
  | 'puddle'
  | 'container'
  | 'containerRough'
  | 'metal'
  | 'grate'
  | 'ao'
  | 'aoEdge';

const cache = new Map<TextureKey, THREE.Texture>();

/** Deterministic PRNG so every client renders the identical surface. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Per-pixel multiplicative noise over whatever is already on the canvas. */
function grain(
  ctx: CanvasRenderingContext2D,
  size: number,
  rnd: () => number,
  amp: number,
  cx: (x: number) => number = () => 1,
): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = (1 - amp + rnd() * amp * 2) * cx(x);
      d[i] *= n;
      d[i + 1] *= n;
      d[i + 2] *= n;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Rust speckles clustered near the tile's seam lines (vertical + horizontal). */
function rustAlongSeams(
  ctx: CanvasRenderingContext2D,
  size: number,
  step: number,
  rnd: () => number,
  count: number,
): void {
  ctx.fillStyle = PALETTE.rust;
  const seams: number[] = [];
  for (let s = step; s < size; s += step) seams.push(s);
  for (let i = 0; i < count; i++) {
    const vertical = rnd() < 0.5;
    const seam = seams[Math.floor(rnd() * seams.length)];
    const along = rnd() * size;
    const off = (rnd() * rnd() * 14 + 0.5) * (rnd() < 0.5 ? -1 : 1);
    ctx.globalAlpha = 0.08 + rnd() * 0.3;
    const s = 0.6 + rnd() * 2.6;
    if (vertical) ctx.fillRect(seam + off, along, s, s);
    else ctx.fillRect(along, seam + off, s, s);
  }
  ctx.globalAlpha = 1;
}

// --- 512² deck plates: base tone + blotches + grain + seam grid + scratches + seam rust ---
function genDeck(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(11);

  ctx.fillStyle = PALETTE.deck[1];
  ctx.fillRect(0, 0, size, size);

  // large-scale tonal variation (paint wear / replaced plates)
  for (let i = 0; i < 70; i++) {
    const r = 24 + rnd() * 90;
    ctx.fillStyle = rnd() < 0.5 ? PALETTE.deck[0] : PALETTE.deck[2];
    ctx.globalAlpha = 0.05 + rnd() * 0.08;
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, r, r * (0.5 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  grain(ctx, size, rnd, 0.1);

  // plate seams every 128px → 4×4 plates per tile (≈2m plates at repeat 8×5)
  for (let p = 128; p < size; p += 128) {
    ctx.fillStyle = PALETTE.deck[0];
    ctx.globalAlpha = 0.75;
    ctx.fillRect(p - 1, 0, 2, size);
    ctx.fillRect(0, p - 1, size, 2);
    ctx.fillStyle = PALETTE.deck[2];
    ctx.globalAlpha = 0.28;
    ctx.fillRect(p + 1, 0, 1, size);
    ctx.fillRect(0, p + 1, size, 1);
  }
  ctx.globalAlpha = 1;

  // multi-scale scratches: long faint + short sharp strokes
  for (let i = 0; i < 160; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const a = rnd() * Math.PI;
    const l = 5 + rnd() * 42;
    ctx.strokeStyle = rnd() < 0.55 ? PALETTE.deck[0] : PALETTE.deck[2];
    ctx.globalAlpha = 0.05 + rnd() * 0.13;
    ctx.lineWidth = 0.5 + rnd() * 1.3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  rustAlongSeams(ctx, size, 128, rnd, 240);
  return c;
}

// --- grayscale roughness for the deck: worn paint variation ---
function genDeckRough(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(23);
  ctx.fillStyle = '#cccccc'; // ~0.8 base roughness
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.14);
  return c;
}

// --- puddle mask (linear): white = standing water, sampled by the deck's uWet patch ---
function genPuddle(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(31);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 30; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 18 + rnd() * 72;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

// --- 256² container skin: vertical corrugation + top dark band + corner rust ---
// Near-white base so the per-instance palette tint stays truthful.
function genContainer(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(37);

  ctx.fillStyle = '#e9ebee';
  ctx.fillRect(0, 0, size, size);

  // corrugation: ~10 sine ribs across the sheet + a finer secondary wave
  const shade = (x: number) =>
    1 + 0.11 * Math.sin((x * Math.PI * 2) / 26) + 0.05 * Math.sin((x * Math.PI * 2) / 6.5 + 1.3);
  grain(ctx, size, rnd, 0.04, shade);

  // top dark band + bottom grime gradient
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(10,14,18,0.55)');
  g.addColorStop(0.14, 'rgba(10,14,18,0)');
  g.addColorStop(0.85, 'rgba(10,14,18,0)');
  g.addColorStop(1, 'rgba(10,14,18,0.42)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // rust: corners + along the bottom edge
  ctx.fillStyle = PALETTE.rust;
  for (let i = 0; i < 130; i++) {
    const corner = rnd() < 0.5;
    const x = corner ? (rnd() < 0.5 ? rnd() * 26 : size - rnd() * 26) : rnd() * size;
    const y = corner ? (rnd() < 0.5 ? rnd() * 30 : size - rnd() * 30) : size - rnd() * rnd() * 40;
    ctx.globalAlpha = 0.1 + rnd() * 0.35;
    const s = 0.6 + rnd() * 2.4;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
  return c;
}

// --- grayscale roughness for containers: grooves & rust stay rough ---
function genContainerRough(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(41);
  ctx.fillStyle = '#b3b3b3'; // ~0.7 base
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.08);
  // grime at the bottom is rougher
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0.8, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 256² painted metal (towers / rails / pipes / pallets): near-white so the
// material color tints it; fine noise + streaks + bottom dust ---
function genMetal(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(53);

  ctx.fillStyle = '#dadbde';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.05);

  // faint vertical weathering streaks
  for (let i = 0; i < 40; i++) {
    const x = rnd() * size;
    ctx.strokeStyle = rnd() < 0.5 ? 'rgba(20,24,30,0.1)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.6 + rnd() * 1.8;
    ctx.globalAlpha = 0.5 + rnd() * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, rnd() * size * 0.5);
    ctx.lineTo(x + (rnd() - 0.5) * 6, size);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // dust settling toward the bottom of the sheet
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0.7, 'rgba(22,18,12,0)');
  g.addColorStop(1, 'rgba(22,18,12,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 128² drainage grate: dark plate + stamped slots + rim highlight + rust ---
function genGrate(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(67);

  ctx.fillStyle = PALETTE.deck[0];
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.1);

  // recessed frame
  ctx.strokeStyle = 'rgba(6,9,12,0.9)';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, size - 8, size - 8);

  // drain slots: two columns of long slots, near-black (holes)
  ctx.fillStyle = 'rgba(4,6,9,0.95)';
  for (let col = 0; col < 2; col++) {
    const x = 24 + col * 48;
    for (let i = 0; i < 5; i++) ctx.fillRect(x, 14 + i * 22, 32, 12);
  }
  // stamped lip: thin highlight along each slot's top edge
  ctx.fillStyle = 'rgba(220,230,240,0.14)';
  for (let col = 0; col < 2; col++) {
    const x = 24 + col * 48;
    for (let i = 0; i < 5; i++) ctx.fillRect(x, 14 + i * 22, 32, 1.5);
  }
  rustAlongSeams(ctx, size, 64, rnd, 40);
  return c;
}

// --- 128² radial falloff blob: pure-alpha fake-AO shadow mask ---
function genAo(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,0.6)');
  g.addColorStop(0.65, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 64² linear falloff strip: contact-shadow band, alpha fades away from the base ---
function genAoEdge(): HTMLCanvasElement {
  const size = 64;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

const GEN: Record<TextureKey, () => HTMLCanvasElement> = {
  deck: genDeck,
  deckRough: genDeckRough,
  puddle: genPuddle,
  container: genContainer,
  containerRough: genContainerRough,
  metal: genMetal,
  grate: genGrate,
  ao: genAo,
  aoEdge: genAoEdge,
};

const SRGB_KEYS: ReadonlySet<TextureKey> = new Set(['deck', 'container', 'metal', 'grate']);
const DECK_REPEAT: ReadonlySet<TextureKey> = new Set(['deck', 'deckRough', 'puddle']);

export function getTexture(key: TextureKey): THREE.Texture {
  let t = cache.get(key);
  if (t) return t;
  t = new THREE.CanvasTexture(GEN[key]());
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  if (DECK_REPEAT.has(key)) t.repeat.set(8, 5); // deck slab: 8×5 tiles of ~2m plates
  if (SRGB_KEYS.has(key)) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4; // real cap applied by setAnisotropyCap once the GPU is known
  cache.set(key, t);
  return t;
}

/** ART-SPEC §2: anisotropy = min(4, maxAnisotropy) — call once after renderer init. */
export function setAnisotropyCap(max: number): void {
  for (const t of cache.values()) {
    t.anisotropy = Math.min(4, max);
    t.needsUpdate = true;
  }
}
