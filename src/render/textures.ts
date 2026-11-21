// Procedural canvas textures — zero external assets. Each texture is drawn
// once and cached in a Map; nothing here runs per-frame. ART-SPEC §2:
// ≤512² canvases, palette-only colors, anisotropy capped at 4.

import * as THREE from 'three';
import { PALETTE } from './palette';

export type TextureKey =
  | 'deck'
  | 'deckRough'
  | 'deckNormal'
  | 'puddle'
  | 'puddleAlpha'
  | 'puddleNormal'
  | 'container'
  | 'containerRough'
  | 'containerWear'
  | 'containerNormal'
  | 'metal'
  | 'concrete'
  | 'wood'
  | 'crate'
  | 'rope'
  | 'paint'
  | 'coneTex'
  | 'barrel'
  | 'craneTex'
  | 'grate'
  | 'stripe'
  | 'stencil'
  | 'skid'
  | 'ao'
  | 'aoEdge'
  | 'checker'
  | 'checkerRough'
  | 'checkerNormal'
  | 'steelFrame'
  | 'steelFrameNormal'
  | 'kickplate'
  | 'elecBox';

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

// --- 512² deck normal map: plate seams (128px grid, same as genDeck) read as
// shallow grooves — packed tangent-space: r=x slope, g=y slope, b=up ---
function genDeckNormal(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const h = new Float32Array(size * size);
  const rnd = mulberry32(29);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // distance to nearest 128px seam → a 5px-wide pressed groove
      const dx = Math.min(x % 128, 128 - (x % 128));
      const dy = Math.min(y % 128, 128 - (y % 128));
      const seam = Math.min(dx, dy);
      h[y * size + x] =
        -Math.max(0, 1 - seam / 5) * 1.0 + (rnd() - 0.5) * 0.08; // groove + micro noise
    }
  }
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.9;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.9;
      const il = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-gx * il * 0.5 + 0.5) * 255;
      d[i + 1] = (-gy * il * 0.5 + 0.5) * 255;
      d[i + 2] = (il * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- 256² container corrugation normal map: trapezoidal ISO-panel ribs at
// 32px period with moderate slope (no harsh zebra-black self-shadowing) and
// flat structural header/footer rails along top & bottom edges ---
function genContainerNormal(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rnd = mulberry32(43);
  for (let y = 0; y < size; y++) {
    // Flat header/footer beams in top 20px and bottom 16px
    const railFade =
      y < 18 ? 0 : y < 24 ? (y - 18) / 6 : y > size - 14 ? 0 : y > size - 20 ? (size - 14 - y) / 6 : 1;
    for (let x = 0; x < size; x++) {
      const gx =
        (Math.cos((x * Math.PI * 2) / 32) * 0.65 + Math.cos((x * Math.PI * 2) / 16) * 0.16) *
          railFade +
        (rnd() - 0.5) * 0.1;
      const gy = (y === 20 || y === size - 16 ? 0.55 : 0) + (rnd() - 0.5) * 0.08;
      const il = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-gx * il * 0.5 + 0.5) * 255;
      d[i + 1] = (-gy * il * 0.5 + 0.5) * 255;
      d[i + 2] = (il * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- 128² diagonal hazard stripes (warning yellow / dark slate), worn ---
function genStripes(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(59);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const band = Math.floor((x + y) / 16) % 2;
      ctx.fillStyle = band ? PALETTE.deckLine : '#1e2329';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // wear: knock chips back out so the paint reads scuffed
  ctx.fillStyle = PALETTE.deck[1];
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.06 + rnd() * 0.25;
    const s = 1 + rnd() * 4;
    ctx.fillRect(rnd() * size, rnd() * size, s, s);
  }
  ctx.globalAlpha = 1;
  return c;
}

// --- 512×128 stencil atlas: four shipping-code cells (128×128 each), worn
// off-white stencil paint with generous margins so characters never clip ---
function genStencil(): HTMLCanvasElement {
  const w = 512;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const rnd = mulberry32(71);
  const codes = ['MSKU 4817', 'CSNU 7302', 'TGHU 0559', 'OCLU 2164'];
  const iso = ['22G1', '45G1', '22G1', '42G1'];
  const subs = ['MAX 30480 KG', 'NET 28200 KG', 'TARE 2180 KG', 'CSC-24 SEAL'];
  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  codes.forEach((code, i) => {
    const x0 = i * 128;
    const cx = x0 + 64;
    // subtle weathered stencil divider bar (no sticker-like box border)
    ctx.fillStyle = 'rgba(232,236,240,0.65)';
    ctx.fillRect(x0 + 18, 54, 92, 1.5);
    // primary container reporting mark
    ctx.fillStyle = 'rgba(236,240,244,0.92)';
    ctx.font = "700 17px 'Courier New',monospace";
    ctx.fillText(code, cx, 38);
    // ISO size/type badge
    ctx.font = "700 12px 'Courier New',monospace";
    ctx.fillStyle = 'rgba(232,236,240,0.82)';
    ctx.fillText(iso[i], cx, 69);
    // gross/tare spec line
    ctx.font = "600 11px 'Courier New',monospace";
    ctx.fillStyle = 'rgba(226,230,236,0.74)';
    ctx.fillText(subs[i], cx, 90);
  });
  // sprayed-paint erosion speckle
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 650; i++) {
    ctx.globalAlpha = 0.12 + rnd() * 0.42;
    const s = 0.6 + rnd() * 1.5;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return c;
}

// --- 256² tyre-scuff decal: transparent sheet, a few dark slate arcing streaks ---
function genSkid(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(89);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 5; i++) {
    const x0 = rnd() * size;
    const y0 = rnd() * size;
    const arc = (rnd() - 0.5) * 1.6;
    const len = 90 + rnd() * 120;
    const w = 9 + rnd() * 9;
    ctx.strokeStyle = 'rgba(20,25,31,0.42)';
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(
      x0 + Math.cos(arc) * len * 0.5,
      y0 + Math.sin(arc) * len * 0.5 + (rnd() - 0.5) * 30,
      x0 + Math.cos(arc) * len,
      y0 + Math.sin(arc) * len,
    );
    ctx.stroke();
  }
  // feather the edges with soft speckle
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(20,25,31,${0.05 + rnd() * 0.16})`;
    const s = 2 + rnd() * 7;
    ctx.fillRect(rnd() * size, rnd() * size, s, s);
  }
  return c;
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

// --- grayscale roughness for the wet deck: base ~0.34 (0.25–0.40 band) with
// organic damp sheen blotches and rougher oxidized plate seams ---
function genDeckRough(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(23);
  ctx.fillStyle = '#5a5a5a'; // ~0.35 base wet-steel roughness
  ctx.fillRect(0, 0, size, size);

  // broad damp/dry patches staying within 0.24–0.44
  for (let i = 0; i < 48; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 24 + rnd() * 88;
    const damp = rnd() < 0.55;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, damp ? 'rgba(54,54,54,0.65)' : 'rgba(116,116,116,0.55)');
    g.addColorStop(1, 'rgba(90,90,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  grain(ctx, size, rnd, 0.12);

  // plate seams are rougher (trapped grit & rust)
  ctx.fillStyle = 'rgba(185,185,185,0.55)';
  for (let p = 128; p < size; p += 128) {
    ctx.fillRect(p - 2, 0, 4, size);
    ctx.fillRect(0, p - 2, size, 4);
  }
  return c;
}

// --- puddle mask (linear): white = standing water film on the wet deck ---
function genPuddle(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(31);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 36; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rx = 24 + rnd() * 84;
    const ry = rx * (0.45 + rnd() * 0.75);
    const rot = rnd() * Math.PI;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'rgba(255,255,255,0.92)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.48)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return c;
}

// --- 512² organic puddle silhouette (linear): white = standing water for
// alphaMap. Uses multi-harmonic radial lobes + irregular peripheral inlets and
// a wide feathered damp shoreline so it reads as natural pooled water on steel
// deck plates — never a rectangle or uniform oval sticker.
function genPuddleAlpha(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(77);
  const img = ctx.createImageData(size, size);
  const d = img.data;

  // Deterministic lobe centers inside the quad (generous margin from edges)
  const lobes: { x: number; y: number; rx: number; ry: number; rot: number }[] = [
    { x: 0.46, y: 0.50, rx: 0.30, ry: 0.19, rot: 0.32 },
    { x: 0.62, y: 0.42, rx: 0.21, ry: 0.15, rot: -0.45 },
    { x: 0.31, y: 0.57, rx: 0.19, ry: 0.14, rot: 0.85 },
    { x: 0.56, y: 0.63, rx: 0.17, ry: 0.11, rot: 0.12 },
    { x: 0.39, y: 0.38, rx: 0.15, ry: 0.12, rot: -0.70 },
  ];
  const phases = Array.from({ length: 8 }, () => rnd() * Math.PI * 2);

  for (let py = 0; py < size; py++) {
    const v = py / size;
    for (let px = 0; px < size; px++) {
      const u = px / size;
      // Smooth union (metaball sum) of irregular ellipses
      let field = 0;
      for (const l of lobes) {
        const dx = u - l.x;
        const dy = v - l.y;
        const cs = Math.cos(l.rot);
        const sn = Math.sin(l.rot);
        const lx = (dx * cs + dy * sn) / l.rx;
        const ly = (-dx * sn + dy * cs) / l.ry;
        const r2 = lx * lx + ly * ly;
        field += Math.exp(-r2 * 1.45);
      }
      // Organic shoreline ripple via smooth multi-frequency trigonometric noise
      const n1 = Math.sin(u * 19.0 + phases[0]) * Math.cos(v * 17.0 + phases[1]);
      const n2 = Math.sin((u * 31.0 - v * 27.0) + phases[2]) * 0.5;
      const n3 = Math.cos((u * 47.0 + v * 41.0) + phases[3]) * 0.25;
      const warp = (n1 + n2 + n3) * 0.11;

      // Edge-fade guard so water never touches quad border (zero hard crop)
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const edgeMask = Math.min(1, Math.max(0, (edge - 0.04) / 0.12));

      const raw = (field + warp - 0.62) / 0.42;
      const a = Math.min(1, Math.max(0, raw)) * edgeMask;
      const smooth = a * a * (3 - 2 * a);
      const byte = Math.round(smooth * 255);
      const idx = (py * size + px) * 4;
      d[idx] = byte;
      d[idx + 1] = byte;
      d[idx + 2] = byte;
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- 256² tileable gentle capillary ripple normal map. Low-slope continuous
// swells + soft wind ripples so puddles reflect the sky cleanly like glass
// without waffle-grid artifacts.
function genPuddleNormal(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(97);
  const K: [number, number][] = [
    [1, 2],
    [-2, 1],
    [3, -1],
    [-1, -3],
    [2, 3],
    [-3, 2],
  ];
  const waves = K.map(([mx, my]) => ({
    mx,
    my,
    f: Math.hypot(mx, my),
    slope: 0.028 + rnd() * 0.032,
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

  // corrugation: subtle 32px sine ribs matching genContainerNormal (no harsh black bars)
  const shade = (x: number) =>
    1 + 0.055 * Math.sin((x * Math.PI * 2) / 32) + 0.02 * Math.sin((x * Math.PI * 2) / 16 + 0.8);
  grain(ctx, size, rnd, 0.035, shade);

  // structural top/bottom header rail bands + weld seam shadow
  ctx.fillStyle = 'rgba(228,232,238,0.6)';
  ctx.fillRect(0, 0, size, 18);
  ctx.fillRect(0, size - 14, size, 14);
  ctx.fillStyle = 'rgba(24,28,34,0.34)';
  ctx.fillRect(0, 18, size, 3);
  ctx.fillRect(0, size - 16, size, 2);

  // top grime band + bottom splash gradient (lifted >= #181c22, never pure black)
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(24,28,34,0.42)');
  g.addColorStop(0.16, 'rgba(24,28,34,0)');
  g.addColorStop(0.82, 'rgba(24,28,34,0)');
  g.addColorStop(1, 'rgba(24,28,34,0.38)');
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
  g.addColorStop(0.7, 'rgba(24,22,20,0)');
  g.addColorStop(1, 'rgba(24,22,20,0.22)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 256² weathered poured concrete (towers & stairs): formwork joints,
// tie-rod holes, mineral aggregate grain, subtle vertical rain staining ---
function genConcrete(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(131);
  ctx.fillStyle = '#c8ccd0';
  ctx.fillRect(0, 0, size, size);

  // broad mineral blotches
  for (let i = 0; i < 36; i++) {
    const r = 16 + rnd() * 48;
    ctx.fillStyle = rnd() < 0.5 ? '#b3b8be' : '#dadde0';
    ctx.globalAlpha = 0.08 + rnd() * 0.1;
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  grain(ctx, size, rnd, 0.09);

  // horizontal formwork pour lines + tie holes
  ctx.fillStyle = 'rgba(42,48,56,0.32)';
  for (let y = 64; y < size; y += 64) {
    ctx.fillRect(0, y, size, 2);
    for (let x = 32; x < size; x += 64) {
      ctx.beginPath();
      ctx.arc(x, y - 32, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // vertical rainwater streaks
  for (let i = 0; i < 28; i++) {
    const x = rnd() * size;
    const len = 30 + rnd() * 140;
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(48,54,60,0.20)');
    g.addColorStop(1, 'rgba(48,54,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 1.5 + rnd() * 3, len);
  }
  return c;
}

// --- 256² slatted timber planks (pallets & cable reels) ---
function genWood(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(149);
  ctx.fillStyle = '#d6c8b4';
  ctx.fillRect(0, 0, size, size);

  const plankH = 32;
  for (let row = 0; row < size / plankH; row++) {
    const y = row * plankH;
    const shade = 0.88 + rnd() * 0.24;
    ctx.fillStyle = `rgb(${Math.round(212 * shade)},${Math.round(196 * shade)},${Math.round(172 * shade)})`;
    ctx.fillRect(0, y, size, plankH - 2);
    // wood grain lines
    for (let k = 0; k < 14; k++) {
      ctx.strokeStyle = rnd() < 0.5 ? 'rgba(65,45,25,0.14)' : 'rgba(245,235,215,0.12)';
      ctx.lineWidth = 0.7 + rnd() * 1.2;
      ctx.beginPath();
      const gy = y + 2 + rnd() * (plankH - 5);
      ctx.moveTo(0, gy);
      ctx.bezierCurveTo(size * 0.33, gy + (rnd() - 0.5) * 4, size * 0.66, gy + (rnd() - 0.5) * 4, size, gy);
      ctx.stroke();
    }
    // dark plank gap + nails
    ctx.fillStyle = 'rgba(32,24,18,0.65)';
    ctx.fillRect(0, y + plankH - 2, size, 2);
    ctx.fillStyle = 'rgba(36,34,32,0.55)';
    for (const nx of [18, size - 18]) {
      ctx.fillRect(nx, y + 6, 3, 3);
      ctx.fillRect(nx, y + plankH - 11, 3, 3);
    }
  }
  grain(ctx, size, rnd, 0.05);
  return c;
}

// --- 256² braced shipping crate: wood planks + perimeter frame + diagonal brace ---
function genCrate(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(163);
  ctx.drawImage(genWood(), 0, 0);

  // diagonal cross-batten
  ctx.save();
  ctx.strokeStyle = 'rgba(220,206,184,0.85)';
  ctx.lineWidth = 24;
  ctx.beginPath();
  ctx.moveTo(22, size - 22);
  ctx.lineTo(size - 22, 22);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(40,28,18,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, size - 40, size - 40);
  ctx.restore();

  // outer frame battens
  ctx.fillStyle = 'rgba(225,210,188,0.88)';
  const b = 22;
  ctx.fillRect(0, 0, size, b);
  ctx.fillRect(0, size - b, size, b);
  ctx.fillRect(0, 0, b, size);
  ctx.fillRect(size - b, 0, b, size);
  ctx.strokeStyle = 'rgba(38,28,20,0.65)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  ctx.strokeRect(b, b, size - b * 2, size - b * 2);

  // corner grime & stencil mark
  ctx.fillStyle = 'rgba(34,26,20,0.45)';
  ctx.font = "700 18px 'Courier New',monospace";
  ctx.fillText('CARGO-04', 42, 54);
  grain(ctx, size, rnd, 0.05);
  return c;
}

// --- 128² twisted hemp mooring rope ---
function genRope(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(179);
  ctx.fillStyle = '#c8b89a';
  ctx.fillRect(0, 0, size, size);
  for (let i = -size; i < size * 2; i += 12) {
    ctx.strokeStyle = 'rgba(62,48,30,0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size * 0.65, size);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(248,236,210,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(i + 4, 0);
    ctx.lineTo(i + 4 + size * 0.65, size);
    ctx.stroke();
  }
  grain(ctx, size, rnd, 0.1);
  return c;
}

// --- 128² scuffed safety paint (deck lines) ---
function genPaint(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(191);
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.09);
  ctx.fillStyle = 'rgba(42,48,54,0.35)';
  for (let i = 0; i < 80; i++) {
    ctx.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 5, 1 + rnd() * 3);
  }
  return c;
}

// --- 128² traffic/safety cone with reflective white collar bands ---
function genConeTex(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(197);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 32, size, 16);
  ctx.fillRect(0, 62, size, 12);
  grain(ctx, size, rnd, 0.06);
  return c;
}

// --- 256² steel oil drum: two rolling hoops + brushed metal + base grime ---
function genBarrel(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(211);
  ctx.fillStyle = '#dde0e4';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.06);

  // two embossed horizontal rolling ribs
  for (const ry of [84, 172]) {
    ctx.fillStyle = 'rgba(28,34,40,0.45)';
    ctx.fillRect(0, ry - 4, size, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, ry - 6, size, 3);
  }
  // oil drips & rust spots
  for (let i = 0; i < 24; i++) {
    ctx.fillStyle = `rgba(90,48,26,${0.18 + rnd() * 0.25})`;
    ctx.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 8, 4 + rnd() * 18);
  }
  const g = ctx.createLinearGradient(0, size * 0.72, 0, size);
  g.addColorStop(0, 'rgba(26,28,32,0)');
  g.addColorStop(1, 'rgba(26,28,32,0.34)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 128² weathered girder texture for distant cranes/freighters ---
function genCraneTex(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(223);
  ctx.fillStyle = '#d4dae0';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.08);
  ctx.strokeStyle = 'rgba(30,38,46,0.22)';
  ctx.lineWidth = 2;
  for (let i = 0; i < size; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
  }
  return c;
}

// --- 128² drainage grate: dark steel plate + stamped slots + rim highlight + rust ---
function genGrate(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(67);

  ctx.fillStyle = PALETTE.deck[0];
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.1);

  // recessed frame (>= #141a21, never pure black)
  ctx.strokeStyle = 'rgba(20,26,33,0.92)';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, size - 8, size - 8);

  // drain slots: two columns of recessed slots
  ctx.fillStyle = 'rgba(18,23,29,0.94)';
  for (let col = 0; col < 2; col++) {
    const x = 24 + col * 48;
    for (let i = 0; i < 5; i++) ctx.fillRect(x, 14 + i * 22, 32, 12);
  }
  // stamped lip: thin highlight along each slot's top edge
  ctx.fillStyle = 'rgba(220,232,244,0.22)';
  for (let col = 0; col < 2; col++) {
    const x = 24 + col * 48;
    for (let i = 0; i < 5; i++) ctx.fillRect(x, 14 + i * 22, 32, 1.5);
  }
  rustAlongSeams(ctx, size, 64, rnd, 40);
  return c;
}

// --- 128² radial falloff blob: soft cool-slate contact shadow mask ---
function genAo(): HTMLCanvasElement {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(14,19,26,0.42)');
  g.addColorStop(0.65, 'rgba(14,19,26,0.18)');
  g.addColorStop(1, 'rgba(14,19,26,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 64² linear falloff strip: soft contact-shadow band at collider bases ---
function genAoEdge(): HTMLCanvasElement {
  const size = 64;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(14,19,26,0.36)');
  g.addColorStop(0.5, 'rgba(14,19,26,0.14)');
  g.addColorStop(1, 'rgba(14,19,26,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- Shared height-field for 512² industrial checker plate (diamond tread
// lozenges + welded 128px plate seams + recessed corner drainage holes) ---
function buildCheckerHeight(size: number): Float32Array {
  const h = new Float32Array(size * size);
  const rnd = mulberry32(307);
  const cell = 16; // 32×32 diamond lozenges per tile (~3–4cm pitch in world)
  // 4 drainage holes near plate intersections
  const drains: [number, number][] = [
    [28, 28],
    [284, 28],
    [28, 284],
    [284, 284],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Alternating vertical & horizontal raised diamond/teardrop lugs
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const lx = (x % cell) / cell - 0.5;
      const ly = (y % cell) / cell - 0.5;
      const horiz = (cx + cy) % 2 === 0;
      const u = horiz ? lx : ly;
      const v = horiz ? ly : lx;
      // Sharp diamond tread lug centered in cell
      const dist = Math.abs(u) / 0.36 + Math.abs(v) / 0.14;
      let val = dist < 1 ? (1 - dist * dist) * 0.95 : 0;

      // Welded plate seams every 256px (raised weld bead flanked by groove)
      const sx = Math.min(x % 256, 256 - (x % 256));
      const sy = Math.min(y % 256, 256 - (y % 256));
      const sm = Math.min(sx, sy);
      if (sm < 5) {
        const along = sx < sy ? y : x;
        const bead = 0.45 + 0.35 * Math.sin(along * 0.9);
        val = sm < 2.2 ? bead : -0.35 * (1 - (sm - 2.2) / 2.8);
      }

      // Drainage holes (deep recessed circular scuppers with slight lip)
      for (const [dx0, dy0] of drains) {
        const dr = Math.hypot(x - dx0, y - dy0);
        if (dr < 7.5) {
          val = -1.3;
        } else if (dr < 10) {
          val = Math.max(val, 0.35 * (1 - Math.abs(dr - 8.7) / 1.3));
        }
      }

      h[y * size + x] = val + (rnd() - 0.5) * 0.05;
    }
  }
  return h;
}

let cachedCheckerH: Float32Array | null = null;
function getCheckerHeight(): Float32Array {
  if (!cachedCheckerH) cachedCheckerH = buildCheckerHeight(512);
  return cachedCheckerH;
}

// --- 512² checker-plate albedo: gunmetal steel + bright tread crests +
// welded seams + corner drainage holes + edge wear & rust flecks ---
function genChecker(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const h = getCheckerHeight();
  const rnd = mulberry32(311);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const hv = h[i];
    let base = 188 + hv * 36;
    if (hv < -0.9) base = 26; // recessed drainage hole bore
    const n = (rnd() - 0.5) * 10;
    const v = Math.max(22, Math.min(242, base + n));
    d[i * 4] = v;
    d[i * 4 + 1] = Math.min(245, v + 2);
    d[i * 4 + 2] = Math.min(248, v + 6);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Subtle foot-traffic wear patches & oil smudges
  for (let i = 0; i < 36; i++) {
    const r = 18 + rnd() * 54;
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(32,38,44,0.12)' : 'rgba(225,232,238,0.10)';
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Rust flecks tucked along the 256px weld seams & around drain scuppers
  rustAlongSeams(ctx, size, 256, rnd, 160);
  ctx.fillStyle = PALETTE.rust;
  for (const [dx0, dy0] of [
    [28, 28],
    [284, 28],
    [28, 284],
    [284, 284],
  ]) {
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI * 2;
      const dist = 7 + rnd() * 10;
      ctx.globalAlpha = 0.16 + rnd() * 0.28;
      ctx.fillRect(dx0 + Math.cos(a) * dist, dy0 + Math.sin(a) * dist, 1.5 + rnd() * 2.5, 1.5 + rnd() * 2.5);
    }
  }
  ctx.globalAlpha = 1;
  return c;
}

// --- 512² checker-plate roughness: polished raised lugs (~0.28) vs matte valleys (~0.64) ---
function genCheckerRough(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const h = getCheckerHeight();
  const rnd = mulberry32(313);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const hv = h[i];
    // Raised lugs are worn smoother by boots; grooves/drains stay rough
    let r = hv > 0.25 ? 74 : hv < -0.5 ? 235 : 148 - hv * 40;
    r = Math.max(52, Math.min(245, r + (rnd() - 0.5) * 18));
    d[i * 4] = r;
    d[i * 4 + 1] = r;
    d[i * 4 + 2] = r;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- 512² checker-plate tangent-space normal map ---
function genCheckerNormal(): HTMLCanvasElement {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  const h = getCheckerHeight();
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 1.8;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 1.8;
      const il = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-gx * il * 0.5 + 0.5) * 255;
      d[i + 1] = (-gy * il * 0.5 + 0.5) * 255;
      d[i + 2] = (il * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- 256² structural painted steel (H-beams / I-beams / C-channels): mill
// scale grain, weld seams, rivet rows, edge wear & joint rust ---
function genSteelFrame(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(331);
  ctx.fillStyle = '#d4d9de';
  ctx.fillRect(0, 0, size, size);

  // Subtle rolled-steel tonal streaks
  for (let i = 0; i < 42; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(28,36,44,0.07)' : 'rgba(245,248,252,0.08)';
    ctx.fillRect(0, rnd() * size, size, 2 + rnd() * 8);
  }
  grain(ctx, size, rnd, 0.06);

  // Welded splice bands & bolt heads
  ctx.fillStyle = 'rgba(28,34,42,0.34)';
  ctx.fillRect(0, 124, size, 4);
  ctx.fillStyle = 'rgba(235,240,246,0.28)';
  ctx.fillRect(0, 122, size, 2);
  for (let x = 20; x < size; x += 36) {
    ctx.fillStyle = 'rgba(24,30,36,0.52)';
    ctx.beginPath();
    ctx.arc(x, 114, 3.2, 0, Math.PI * 2);
    ctx.arc(x, 138, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(230,236,242,0.36)';
    ctx.beginPath();
    ctx.arc(x - 1, 113, 1.4, 0, Math.PI * 2);
    ctx.arc(x - 1, 137, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Light rust oxidation weeping from splice & bottom flange
  for (let i = 0; i < 38; i++) {
    ctx.fillStyle = rustRgba(0.9 + rnd() * 0.25, 0.14 + rnd() * 0.28);
    ctx.fillRect(rnd() * size, 120 + rnd() * 34, 1.5 + rnd() * 4, 4 + rnd() * 18);
  }
  const bot = ctx.createLinearGradient(0, size * 0.78, 0, size);
  bot.addColorStop(0, 'rgba(92,50,28,0)');
  bot.addColorStop(1, 'rgba(92,50,28,0.34)');
  ctx.fillStyle = bot;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 256² structural steel normal map: weld seam ridge + rivet bumps + fine scale ---
function genSteelFrameNormal(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const h = new Float32Array(size * size);
  const rnd = mulberry32(337);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = (rnd() - 0.5) * 0.08;
      if (Math.abs(y - 125) < 3) v += 0.6 * (1 - Math.abs(y - 125) / 3);
      for (let bx = 20; bx < size; bx += 36) {
        const d1 = Math.hypot(x - bx, y - 114);
        const d2 = Math.hypot(x - bx, y - 138);
        if (d1 < 3.6) v += 0.7 * (1 - d1 / 3.6);
        if (d2 < 3.6) v += 0.7 * (1 - d2 / 3.6);
      }
      h[y * size + x] = v;
    }
  }
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 1.1;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 1.1;
      const il = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 4;
      d[i] = (-gx * il * 0.5 + 0.5) * 255;
      d[i + 1] = (-gy * il * 0.5 + 0.5) * 255;
      d[i + 2] = (il * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// --- 256² guardrail 100mm kickplate: weathered steel + prominent rust weeping streaks ---
function genKickplate(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(347);
  ctx.fillStyle = '#cdd3da';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.06);

  // Top beveled lip + vertical plate weld joints
  ctx.fillStyle = 'rgba(240,244,248,0.42)';
  ctx.fillRect(0, 0, size, 10);
  ctx.fillStyle = 'rgba(28,34,40,0.4)';
  ctx.fillRect(0, 10, size, 4);
  for (let x = 64; x < size; x += 64) {
    ctx.fillStyle = 'rgba(30,36,42,0.38)';
    ctx.fillRect(x - 1, 0, 3, size);
  }

  // Prominent vertical rust-drip streaks weeping down from top lip & bolts
  for (let i = 0; i < 42; i++) {
    const sx = rnd() * size;
    const sw = 2 + rnd() * 5;
    const len = 50 + rnd() * 190;
    const g = ctx.createLinearGradient(0, 8, 0, 8 + len);
    g.addColorStop(0, rustRgba(0.95 + rnd() * 0.2, 0.55 + rnd() * 0.3));
    g.addColorStop(0.55, rustRgba(0.85, 0.32));
    g.addColorStop(1, rustRgba(0.8, 0));
    ctx.fillStyle = g;
    ctx.fillRect(sx, 8, sw, len);
  }
  // Bottom wet deck splash grime + oxide crust
  const bot = ctx.createLinearGradient(0, size * 0.62, 0, size);
  bot.addColorStop(0, 'rgba(84,44,24,0)');
  bot.addColorStop(1, 'rgba(84,44,24,0.58)');
  ctx.fillStyle = bot;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- 256² marine electrical distribution cabinet (配电箱) ---
function genElecBox(): HTMLCanvasElement {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const rnd = mulberry32(353);
  ctx.fillStyle = '#c8cfd6';
  ctx.fillRect(0, 0, size, size);
  grain(ctx, size, rnd, 0.05);

  // Recessed hinged door seam + weather seal
  ctx.strokeStyle = 'rgba(24,30,38,0.82)';
  ctx.lineWidth = 6;
  ctx.strokeRect(14, 14, size - 28, size - 28);
  ctx.strokeStyle = 'rgba(240,245,250,0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(19, 19, size - 38, size - 38);

  // Hinges on left, locking latch handle on right
  ctx.fillStyle = '#2d3640';
  ctx.fillRect(10, 56, 12, 26);
  ctx.fillRect(10, 174, 12, 26);
  ctx.fillRect(size - 38, 108, 16, 42);
  ctx.fillStyle = '#8d99a6';
  ctx.fillRect(size - 35, 114, 10, 28);

  // Pilot status LEDs (green power / amber ready / red fault)
  const leds: [number, string][] = [
    [62, '#34d399'],
    [92, '#f59e0b'],
    [122, '#ef4444'],
  ];
  for (const [lx, col] of leds) {
    ctx.fillStyle = '#1f262e';
    ctx.beginPath();
    ctx.arc(lx, 46, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(lx, 46, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // High-voltage yellow/black warning triangle decal
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(128, 72);
  ctx.lineTo(176, 152);
  ctx.lineTo(80, 152);
  ctx.closePath();
  ctx.fillStyle = PALETTE.deckLine;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#1a1f24';
  ctx.stroke();
  // Lightning bolt inside triangle
  ctx.fillStyle = '#1a1f24';
  ctx.beginPath();
  ctx.moveTo(132, 92);
  ctx.lineTo(116, 120);
  ctx.lineTo(128, 120);
  ctx.lineTo(122, 144);
  ctx.lineTo(144, 114);
  ctx.lineTo(131, 114);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Bottom ventilation louver slots
  ctx.fillStyle = 'rgba(22,28,34,0.78)';
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(46, 174 + i * 10, 164, 5);
  }
  // Light rust grime along bottom frame
  const g = ctx.createLinearGradient(0, size * 0.78, 0, size);
  g.addColorStop(0, 'rgba(92,50,28,0)');
  g.addColorStop(1, 'rgba(92,50,28,0.36)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

const GEN: Record<TextureKey, () => HTMLCanvasElement> = {
  deck: genDeck,
  deckRough: genDeckRough,
  deckNormal: genDeckNormal,
  puddle: genPuddle,
  puddleAlpha: genPuddleAlpha,
  puddleNormal: genPuddleNormal,
  container: genContainer,
  containerRough: genContainerRough,
  containerWear: genContainerWear,
  containerNormal: genContainerNormal,
  metal: genMetal,
  concrete: genConcrete,
  wood: genWood,
  crate: genCrate,
  rope: genRope,
  paint: genPaint,
  coneTex: genConeTex,
  barrel: genBarrel,
  craneTex: genCraneTex,
  grate: genGrate,
  stripe: genStripes,
  stencil: genStencil,
  skid: genSkid,
  ao: genAo,
  aoEdge: genAoEdge,
  checker: genChecker,
  checkerRough: genCheckerRough,
  checkerNormal: genCheckerNormal,
  steelFrame: genSteelFrame,
  steelFrameNormal: genSteelFrameNormal,
  kickplate: genKickplate,
  elecBox: genElecBox,
};

const SRGB_KEYS: ReadonlySet<TextureKey> = new Set([
  'deck',
  'container',
  'metal',
  'concrete',
  'wood',
  'crate',
  'rope',
  'paint',
  'coneTex',
  'barrel',
  'craneTex',
  'grate',
  'stripe',
  'stencil',
  'skid',
  'checker',
  'steelFrame',
  'kickplate',
  'elecBox',
]);
const DECK_REPEAT: ReadonlySet<TextureKey> = new Set([
  'deck',
  'deckRough',
  'deckNormal',
  'puddle',
]);

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
