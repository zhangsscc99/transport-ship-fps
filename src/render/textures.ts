// Procedural canvas textures — zero external assets. Each texture is drawn
// once and cached in a Map; nothing here runs per-frame. ART-SPEC §2:
// ≤512² canvases, palette-only colors, anisotropy capped at 4.

import * as THREE from 'three';
import { PALETTE } from './palette';

export type TextureKey =
  | 'deck'
  | 'deckRough'
  | 'puddle'
  | 'puddleAlpha'
  | 'puddleNormal'
  | 'container'
  | 'containerRough'
  | 'containerWear'
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

// --- 512² puddle silhouette (linear): white = open water for alphaMap.
// Varied-radius circles stamped along a curving, swaying spine give an
// elongated organic blob; every stamp is clamped so all ink fades out ≥42px
// before the texture edge — no cropped straight rims on the quad.
function genPuddleAlpha(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(71);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const count = 6 + Math.floor(rnd() * 5); // 6..10 stamps along the spine
  const dir = rnd() * Math.PI * 2; // spine direction
  const bend = (rnd() - 0.5) * 1.4; // spine curvature
  const span = 200 + rnd() * 60; // half-length the stamps wander out to
  const perpA = 30 + rnd() * 40; // sideways sway amplitude
  const wob = 1.5 + rnd() * 1.5; // sway frequency along the spine
  const ph = rnd() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1); // 0..1 along the spine
    const along = (t - 0.5) * 2 * span;
    const side = Math.sin(t * Math.PI * wob + ph) * perpA + (rnd() - 0.5) * 26;
    const a = dir + bend * (t - 0.5);
    let px = cx + Math.cos(a) * along - Math.sin(a) * side;
    let py = cy + Math.sin(a) * along + Math.cos(a) * side;
    const r = 66 + rnd() * 46;
    const lim = size / 2 - 42 - r;
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    if (d > lim && d > 0) {
      px = cx + (dx / d) * lim;
      py = cy + (dy / d) * lim;
    }
    const g = ctx.createRadialGradient(px, py, r * 0.3, px, py, r);
    // F212c: wider outer feather — alpha 0.35→0.05 now spans ~17% of the
    // stamp radius (was ~9%), so the shoreline fades in steps instead of
    // snapping on like a sticker cut.
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

// --- 256² tileable water-ripple normal map. Integer wave vectors make the
// summed-sine height field exactly periodic; the analytic gradient is packed
// as rgb = normalize(-dh/dx, -dh/dy, 1)*0.5+0.5 with z dominant, so it reads
// as ripples instead of fake dunes. Frequencies stay ≤5 cycles/tile — the
// analytic gradient is already perfectly smooth, and keeping the spectrum in
// the mid band means no pixel-scale normal jumps (no blocky sparkle).
function genPuddleNormal(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(97);
  // (mx, my) = cycles per uv tile; 1/hypot(m) all lands in the 0.19..0.7 band
  const K: [number, number][] = [
    [4, 1],
    [-3, 4],
    [2, -4],
    [-4, -2],
    [1, 3],
    [5, -2],
    [-2, -3],
  ];
  const waves = K.map(([mx, my]) => ({
    mx,
    my,
    f: Math.hypot(mx, my),
    slope: 0.055 + rnd() * 0.1, // per-wave gradient amplitude — ripples, not dunes
    ph: rnd() * Math.PI * 2,
  }));
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let gx = 0;
      let gy = 0;
      for (const w of waves) {
        // h = sin(2π m·uv + φ) scaled so |∇h| peak == slope
        const s = (w.slope * Math.cos(Math.PI * 2 * (w.mx * u + w.my * v) + w.ph)) / w.f;
        gx += s * w.mx;
        gy += s * w.my;
      }
      const iz = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-gx * iz * 0.5 + 0.5) * 255;
      d[i + 1] = (-gy * iz * 0.5 + 0.5) * 255;
      d[i + 2] = (iz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- shared rust-mark model for the container skin: the same deterministic
// mark list is stamped onto the colour canvas in rust tones AND onto the
// roughness canvas in bright ink, so every rust patch also reads matte ---
interface RustStreak {
  x: number;
  y0: number;
  w: number;
  len: number;
  a: number;
}
interface RustSpot {
  x: number;
  y: number;
  w: number;
  h: number;
  a: number;
  dark: boolean;
}
interface RustPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  a: number;
}
interface RustScratch {
  x: number;
  y: number;
  dx: number;
  dy: number;
  a: number;
}

const CONTAINER_MARKS = (() => {
  const size = 256;
  const rnd = mulberry32(101);

  // run-off streaks weeping down from the top lip — 2–3 thin runs of
  // uneven length, no mid-face rain of rust
  const streaks: RustStreak[] = [];
  for (let i = 0; i < 14; i++) {
    streaks.push({
      x: 3 + rnd() * (size - 6),
      y0: rnd() * 8,
      w: 1.0 + rnd() * 1.8,
      len: 16 + rnd() * rnd() * 110,
      a: 0.42 + rnd() * 0.4,
    });
  }

  // rust freckles hugging the corrugation troughs (rib roots), biased low
  const spots: RustSpot[] = [];
  for (let i = 0; i < 110; i++) {
    const trough = 19.5 + 26 * Math.floor(rnd() * 10);
    spots.push({
      x: trough + (rnd() - 0.5) * 8,
      y: size * (0.4 + rnd() * 0.6),
      w: 1.0 + rnd() * 3.0,
      h: 1.0 + rnd() * 2.8,
      a: 0.22 + rnd() * 0.42,
      dark: rnd() < 0.35,
    });
  }

  // scabby patches inside the bottom grime band
  const grime: RustPatch[] = [];
  for (let i = 0; i < 60; i++) {
    const r = rnd() * rnd();
    grime.push({
      x: rnd() * size,
      y: size - r * 46 - 3,
      w: 5 + rnd() * 15,
      h: 2 + rnd() * 6,
      a: 0.24 + rnd() * 0.36,
    });
  }

  // shallow scratches scraped back to pale primer — one or two, not a cage
  const scratches: RustScratch[] = [];
  for (let i = 0; i < 2; i++) {
    const len = 18 + rnd() * 40;
    const ang = (rnd() - 0.5) * 0.7; // mostly horizontal
    scratches.push({
      x: rnd() * size,
      y: size * (0.1 + rnd() * 0.6),
      dx: Math.cos(ang) * len,
      dy: Math.sin(ang) * len,
      a: 0.22 + rnd() * 0.2,
    });
  }
  return { streaks, spots, grime, scratches };
})();

// PALETTE.rust (0x6b3a22) with a ±15% lightness jitter so neighbouring
// marks aren't one flat stencil tone.
function rustRgba(j: number, a: number): string {
  const r = Math.min(255, Math.round(0x6b * j));
  const g = Math.min(255, Math.round(0x3a * j));
  const b = Math.min(255, Math.round(0x22 * j));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// --- 256² container skin: vertical corrugation + top dark band + layered rust ---
// Near-white base so the per-instance palette tint stays truthful.
function genContainer(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(37);

  ctx.fillStyle = '#e9ebee';
  ctx.fillRect(0, 0, size, size);

  // large soft wear blotches so the painted sheet isn't a flat fill
  for (let i = 0; i < 9; i++) {
    const r = 30 + rnd() * 70;
    ctx.fillStyle = rnd() < 0.5 ? '#d2d5da' : '#f2f3f5';
    ctx.globalAlpha = 0.05 + rnd() * 0.06;
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, r, r * (0.4 + rnd() * 0.6), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

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

  // rust run-off: faint wide halo + darker narrow core, fading down its run.
  // Each streak gets its own ±15% tone jitter so no two weep the same colour.
  for (const s of CONTAINER_MARKS.streaks) {
    const j = 0.85 + rnd() * 0.3;
    const halo = ctx.createLinearGradient(0, s.y0, 0, s.y0 + s.len);
    halo.addColorStop(0, rustRgba(j * 1.12, s.a * 0.35));
    halo.addColorStop(1, rustRgba(j * 1.12, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(s.x - s.w, s.y0, s.w * 3, s.len);
    const core = ctx.createLinearGradient(0, s.y0, 0, s.y0 + s.len);
    core.addColorStop(0, rustRgba(j * 0.82, s.a));
    core.addColorStop(0.75, rustRgba(j * 0.82, s.a * 0.5));
    core.addColorStop(1, rustRgba(j * 0.82, 0));
    ctx.fillStyle = core;
    ctx.fillRect(s.x - s.w / 2, s.y0, s.w, s.len);
  }

  // freckles at the rib roots — two depths + per-mark jitter, stamped twice
  // (soft wide pass under a tighter core) so the pitting reads layered
  for (const p of CONTAINER_MARKS.spots) {
    ctx.fillStyle = p.dark ? `rgba(78,42,24,${(p.a * 0.8).toFixed(3)})` : rustRgba(0.85 + rnd() * 0.3, p.a * 0.55);
    ctx.fillRect(p.x - 0.6, p.y - 0.6, p.w + 1.2, p.h + 1.2);
    ctx.fillStyle = p.dark ? `rgba(60,30,16,${p.a.toFixed(3)})` : rustRgba(0.8 + rnd() * 0.3, p.a);
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }

  // scabs inside the bottom grime band — jittered tone, then a few paint-
  // coloured chips knocked back out so the scab edges read ragged, not airbrushed
  for (const p of CONTAINER_MARKS.grime) {
    ctx.fillStyle = rustRgba(0.85 + rnd() * 0.3, p.a);
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = 'rgba(210,214,220,0.35)';
    const chips = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < chips; k++) {
      ctx.fillRect(p.x + rnd() * p.w, p.y + rnd() * p.h, 1 + rnd() * 2, 1 + rnd() * 1.5);
    }
  }
  // sparse speckle hugging the lower edge only (was a full-face brown spray)
  for (let i = 0; i < 40; i++) {
    const x = rnd() * size;
    const y = size - rnd() * rnd() * 34;
    ctx.fillStyle = rustRgba(0.85 + rnd() * 0.3, 0.12 + rnd() * 0.25);
    const s = 0.6 + rnd() * 2;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;

  // scratches: pale primer line with a thin rust bled along its lower lip
  for (const s of CONTAINER_MARKS.scratches) {
    ctx.globalAlpha = s.a;
    ctx.strokeStyle = '#c8cdd2';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + s.dx, s.y + s.dy);
    ctx.stroke();
    ctx.globalAlpha = s.a * 0.6;
    ctx.strokeStyle = '#5a3220';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y + 1);
    ctx.lineTo(s.x + s.dx, s.y + s.dy + 1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return c;
}

// --- 256² tileable two-channel weather mask (linear). .r = broad wear/grime
// cells (unchanged); .g = dedicated rust mask: mid-scale irregular scabs plus
// run-off drips so the container shader can stain the diffuse AFTER the
// per-instance tint — rust painted into the colour map was being re-tinted by
// instanceColor and never read as rust. Sampled at ~1/6 the skin's uv scale
// plus a large per-instance offset, so the weather differs box-to-box even
// when two containers tile the same skin pixels. Wrap-around gradient stamps
// keep both channels perfectly periodic.
function genContainerWear(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(83);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const stamp = (x: number, y: number, r: number, a: number, ink: string) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + dx, y + dy, r * 0.15, x + dx, y + dy, r);
        g.addColorStop(0, `rgba(${ink},${a})`);
        g.addColorStop(0.7, `rgba(${ink},${(a * 0.5).toFixed(3)})`);
        g.addColorStop(1, `rgba(${ink},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  // .r cells — same stamp list as before, red ink keeps the channel identical
  // ~12 broad blobs — these read as metre-scale weather cells on the box
  for (let i = 0; i < 12; i++) stamp(rnd() * size, rnd() * size, 46 + rnd() * 78, 0.5 + rnd() * 0.4, '255,0,0');
  // ~18 smaller mottle blobs so the big cells have ragged insides
  for (let i = 0; i < 18; i++) stamp(rnd() * size, rnd() * size, 14 + rnd() * 30, 0.25 + rnd() * 0.35, '255,0,0');

  // .g rust marks — 'lighter' so each stamp can only add to the channel and
  // never eat back into the .r cells. Elliptical stamps with ry down-face
  // (v) so the shapes lean with the run-off direction.
  ctx.globalCompositeOperation = 'lighter';
  const rust = (x: number, y: number, rx: number, ry: number, rot: number, a: number) => {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.save();
        ctx.translate(x + dx, y + dy);
        ctx.rotate(rot);
        ctx.scale(1, ry / rx);
        const g = ctx.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx);
        g.addColorStop(0, `rgba(0,255,0,${a})`);
        g.addColorStop(0.55, `rgba(0,255,0,${(a * 0.55).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,255,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  };

  // scab cells — a broad feathered halo with a tighter, darker core stamped
  // back on top, so the edges read layered instead of airbrushed. F213e:
  // count/radius/alpha up so a clear share of any face clears the shader's
  // smoothstep(0.45,0.8) gate — the old density left most faces under it.
  for (let i = 0; i < 30; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rx = 17 + rnd() * 24;
    const ry = rx * (1.2 + rnd() * 0.8);
    const rot = (rnd() - 0.5) * 0.5;
    const a = 0.7 + rnd() * 0.3;
    rust(x, y, rx, ry, rot, a);
    rust(x, y, rx * 0.55, ry * 0.6, rot, Math.min(0.95, a * 1.35));
  }
  // weep drips — narrow, tall, near-vertical run-off threads
  for (let i = 0; i < 36; i++) {
    rust(rnd() * size, rnd() * size, 3 + rnd() * 5.5, 28 + rnd() * 48, (rnd() - 0.5) * 0.22, 0.4 + rnd() * 0.32);
  }
  // fine freckles so the rust zones stay pitted at close range
  for (let i = 0; i < 55; i++) {
    const rx = 2.5 + rnd() * 5.5;
    rust(rnd() * size, rnd() * size, rx, rx * (1 + rnd() * 0.8), rnd() * Math.PI, 0.26 + rnd() * 0.34);
  }
  ctx.globalCompositeOperation = 'source-over';
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

  // same mark list as the colour skin, bright ink → rust/grime reads matte
  ctx.fillStyle = '#ffffff';
  for (const s of CONTAINER_MARKS.streaks) {
    ctx.globalAlpha = s.a * 0.7;
    ctx.fillRect(s.x - s.w, s.y0, s.w * 3, s.len);
  }
  for (const p of CONTAINER_MARKS.spots) {
    ctx.globalAlpha = p.a * 0.8;
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }
  for (const p of CONTAINER_MARKS.grime) {
    ctx.globalAlpha = p.a * 0.8;
    ctx.fillRect(p.x, p.y, p.w, p.h);
  }
  ctx.globalAlpha = 1;

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
  puddleAlpha: genPuddleAlpha,
  puddleNormal: genPuddleNormal,
  container: genContainer,
  containerRough: genContainerRough,
  containerWear: genContainerWear,
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
  if (key === 'puddleAlpha') {
    // single quad, transparent margin — never tile the silhouette
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
  } else {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
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
