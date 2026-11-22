// src/render/bossModel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE2 from "three";

// src/render/bossModel.ts
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(t) {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}
function gauss(d, sigma) {
  const r = d / sigma;
  return Math.exp(-0.5 * r * r);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash3(ix, iy, iz, seed) {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1274126177) ^ Math.imul(seed | 0, 2246822519);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function noise3(x, y, z, seed = 11) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz, seed);
  const c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed);
  const c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed);
  const c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed);
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}
function fbm3(x, y, z, seed = 11, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = x;
  let py = y;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(px, py, pz, seed + i * 29);
    norm += amp;
    px *= 2.03;
    py *= 2.03;
    pz *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}
function ridged3(x, y, z, seed = 37, octaves = 3) {
  let sum = 0;
  let amp = 0.55;
  let norm = 0;
  let px = x;
  let py = y;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise3(px, py, pz, seed + i * 31) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    px *= 2.1;
    py *= 2.1;
    pz *= 2.1;
    amp *= 0.48;
  }
  return sum / norm;
}
function hash2Tile(ix, iy, period, seed) {
  const wx = (ix % period + period) % period;
  const wy = (iy % period + period) % period;
  return hash3(wx, wy, 0, seed);
}
function noise2Tile(x, y, period, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2Tile(ix, iy, period, seed);
  const b = hash2Tile(ix + 1, iy, period, seed);
  const c = hash2Tile(ix, iy + 1, period, seed);
  const d = hash2Tile(ix + 1, iy + 1, period, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm2Tile(u, v, basePeriod, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2Tile(u * p, v * p, p, seed + i * 23);
    norm += amp;
    p *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}
function makeFallbackTex(r, g, b, srgb) {
  const data = new Uint8Array([
    r,
    g,
    b,
    255,
    r,
    g,
    b,
    255,
    r,
    g,
    b,
    255,
    r,
    g,
    b,
    255
  ]);
  const tex = new THREE.DataTexture(data, 2, 2);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function buildNormalCanvasFromHeight(height, size, strength) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const wrap = (i) => (i % size + size) % size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = height[wrap(y - 1) * size + wrap(x - 1)];
      const t = height[wrap(y - 1) * size + x];
      const tr = height[wrap(y - 1) * size + wrap(x + 1)];
      const l = height[y * size + wrap(x - 1)];
      const r = height[y * size + wrap(x + 1)];
      const bl = height[wrap(y + 1) * size + wrap(x - 1)];
      const b = height[wrap(y + 1) * size + x];
      const br = height[wrap(y + 1) * size + wrap(x + 1)];
      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * 0.25 * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * 0.25 * strength;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const nx = -dx * invLen;
      const ny = -dy * invLen;
      const nz = invLen;
      const idx = (y * size + x) * 4;
      d[idx] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
      d[idx + 1] = Math.round(clamp01(ny * 0.5 + 0.5) * 255);
      d[idx + 2] = Math.round(clamp01(nz * 0.5 + 0.5) * 255);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function wrapCanvasTexture(c, srgb, repeat = 1) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function createProceduralBossTextures() {
  if (typeof document === "undefined") {
    const skinMap2 = makeFallbackTex(210, 218, 206, true);
    const skinNormalMap2 = makeFallbackTex(128, 128, 255, false);
    const skinRoughnessMap2 = makeFallbackTex(225, 225, 225, false);
    const skinVeinEmissiveMap2 = makeFallbackTex(24, 6, 4, true);
    const chitinMap2 = makeFallbackTex(180, 170, 152, true);
    const chitinNormalMap2 = makeFallbackTex(128, 128, 255, false);
    const fleshMap2 = makeFallbackTex(146, 46, 42, true);
    const fleshNormalMap2 = makeFallbackTex(128, 128, 255, false);
    const coreMap2 = makeFallbackTex(90, 28, 12, true);
    const coreEmissiveMap2 = makeFallbackTex(255, 130, 48, true);
    const coreNormalMap2 = makeFallbackTex(128, 128, 255, false);
    return {
      skinMap: skinMap2,
      skinNormalMap: skinNormalMap2,
      skinRoughnessMap: skinRoughnessMap2,
      skinVeinEmissiveMap: skinVeinEmissiveMap2,
      chitinMap: chitinMap2,
      chitinNormalMap: chitinNormalMap2,
      fleshMap: fleshMap2,
      fleshNormalMap: fleshNormalMap2,
      coreMap: coreMap2,
      coreEmissiveMap: coreEmissiveMap2,
      coreNormalMap: coreNormalMap2,
      all: [
        skinMap2,
        skinNormalMap2,
        skinRoughnessMap2,
        skinVeinEmissiveMap2,
        chitinMap2,
        chitinNormalMap2,
        fleshMap2,
        fleshNormalMap2,
        coreMap2,
        coreEmissiveMap2,
        coreNormalMap2
      ]
    };
  }
  const S = 512;
  const skinCanvas = document.createElement("canvas");
  skinCanvas.width = skinCanvas.height = S;
  const skinCtx = skinCanvas.getContext("2d");
  const skinImg = skinCtx.createImageData(S, S);
  const sd = skinImg.data;
  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = roughCanvas.height = S;
  const roughCtx = roughCanvas.getContext("2d");
  const roughImg = roughCtx.createImageData(S, S);
  const rd = roughImg.data;
  const veinEmCanvas = document.createElement("canvas");
  veinEmCanvas.width = veinEmCanvas.height = S;
  const veinEmCtx = veinEmCanvas.getContext("2d");
  veinEmCtx.fillStyle = "#080202";
  veinEmCtx.fillRect(0, 0, S, S);
  const skinHeight = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const idx = y * S + x;
      const macro = fbm2Tile(u, v, 4, 101, 3);
      const mid = fbm2Tile(u, v, 10, 211, 3);
      const pores = fbm2Tile(u, v, 36, 307, 2);
      const warpU = u + (mid - 0.5) * 0.05;
      const warpV = v + (macro - 0.5) * 0.04;
      const foldRaw = 1 - Math.abs(fbm2Tile(warpU, warpV, 12, 409, 3) * 2 - 1);
      const fold = Math.pow(foldRaw, 1.5);
      const pebble = fbm2Tile(u, v, 22, 521, 2);
      const bump = macro * 0.32 + mid * 0.28 + fold * 0.16 + pores * 0.14 + pebble * 0.1;
      skinHeight[idx] = bump;
      const bruise = smoothstep((fbm2Tile(u, v, 5, 617, 3) - 0.54) * 3.6);
      const paleRidge = smoothstep((bump - 0.58) * 3.6);
      const darkCrease = smoothstep((0.44 - bump) * 3.2);
      let cr = 222 + (macro - 0.5) * 44 + (pores - 0.5) * 24 - darkCrease * 48 + paleRidge * 24;
      let cg = 230 + (macro - 0.5) * 40 + (pores - 0.5) * 22 - darkCrease * 44 + paleRidge * 22;
      let cb = 212 + (macro - 0.5) * 36 + (pores - 0.5) * 20 - darkCrease * 42 + paleRidge * 18;
      cr = lerp(cr, cr * 1.18 + 20, bruise * 0.48);
      cg = lerp(cg, cg * 0.72, bruise * 0.48);
      cb = lerp(cb, cb * 0.76, bruise * 0.48);
      const p4 = idx * 4;
      sd[p4] = Math.round(clamp(cr, 72, 252));
      sd[p4 + 1] = Math.round(clamp(cg, 74, 252));
      sd[p4 + 2] = Math.round(clamp(cb, 68, 245));
      sd[p4 + 3] = 255;
      const mucusPatch = smoothstep((fbm2Tile(u * 1.3, v * 0.65, 6, 733, 3) - 0.52) * 3.6);
      const wetVal = clamp01(mucusPatch * 0.68 + darkCrease * 0.2);
      const roughByte = Math.round(lerp(248, 150, wetVal) + (pores - 0.5) * 14);
      const rb = clamp(roughByte, 134, 255);
      rd[p4] = rb;
      rd[p4 + 1] = rb;
      rd[p4 + 2] = rb;
      rd[p4 + 3] = 255;
    }
  }
  skinCtx.putImageData(skinImg, 0, 0);
  roughCtx.putImageData(roughImg, 0, 0);
  const rnd = mulberry32(90421);
  const drawTiledStroke = (ctx, pts, width, style) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let ox = -S; ox <= S; ox += S) {
      for (let oy = -S; oy <= S; oy += S) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i][0] + ox, pts[i][1] + oy);
        }
        ctx.stroke();
      }
    }
  };
  const stampSoftVein = (x0, y0, x1, y1, rad, delta) => {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      const rInt = Math.ceil(rad);
      for (let dy = -rInt; dy <= rInt; dy++) {
        for (let dx = -rInt; dx <= rInt; dx++) {
          const dd = Math.hypot(dx, dy);
          if (dd > rad) continue;
          const fall = Math.cos(dd / rad * Math.PI * 0.5);
          const px = (Math.round(cx + dx) % S + S) % S;
          const py = (Math.round(cy + dy) % S + S) % S;
          skinHeight[py * S + px] += delta * fall * fall;
        }
      }
    }
  };
  for (let v = 0; v < 14; v++) {
    let px = rnd() * S;
    let py = rnd() * S;
    let ang = rnd() * Math.PI * 2;
    const segs = 10 + Math.floor(rnd() * 12);
    const pts = [[px, py]];
    for (let i = 0; i < segs; i++) {
      ang += (rnd() - 0.5) * 0.85;
      const step = 12 + rnd() * 16;
      const nx = px + Math.cos(ang) * step;
      const ny = py + Math.sin(ang) * step;
      pts.push([nx, ny]);
      stampSoftVein(px, py, nx, ny, 4.4, 0.055);
      if (rnd() < 0.38) {
        let bx = nx;
        let by = ny;
        let bang = ang + (rnd() < 0.5 ? 1 : -1) * (0.45 + rnd() * 0.5);
        const bPts = [[bx, by]];
        const bLen = 4 + Math.floor(rnd() * 5);
        for (let k = 0; k < bLen; k++) {
          bang += (rnd() - 0.5) * 0.8;
          const bnx = bx + Math.cos(bang) * (8 + rnd() * 10);
          const bny = by + Math.sin(bang) * (8 + rnd() * 10);
          bPts.push([bnx, bny]);
          stampSoftVein(bx, by, bnx, bny, 2.8, 0.032);
          bx = bnx;
          by = bny;
        }
        drawTiledStroke(skinCtx, bPts, 5, "rgba(105, 30, 32, 0.24)");
        drawTiledStroke(skinCtx, bPts, 1.8, "rgba(162, 34, 30, 0.48)");
        drawTiledStroke(veinEmCtx, bPts, 3.2, "rgba(210, 48, 22, 0.55)");
      }
      px = nx;
      py = ny;
    }
    drawTiledStroke(skinCtx, pts, 9.5, "rgba(92, 28, 34, 0.22)");
    drawTiledStroke(skinCtx, pts, 4.2, "rgba(148, 32, 30, 0.44)");
    drawTiledStroke(skinCtx, pts, 1.6, "rgba(182, 42, 34, 0.50)");
    drawTiledStroke(roughCtx, pts, 6, "rgba(116, 116, 116, 0.35)");
    drawTiledStroke(veinEmCtx, pts, 7.5, "rgba(160, 28, 12, 0.42)");
    drawTiledStroke(veinEmCtx, pts, 2.8, "rgba(255, 88, 34, 0.92)");
  }
  for (let m = 0; m < 28; m++) {
    const sx = rnd() * S;
    const sy = rnd() * S;
    const len = 40 + rnd() * 110;
    const pts = [[sx, sy]];
    let cx = sx;
    let cy = sy;
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      cx += (rnd() - 0.5) * 6;
      cy += len / steps;
      pts.push([cx, cy]);
    }
    drawTiledStroke(roughCtx, pts, 5.5 + rnd() * 5, "rgba(136, 136, 136, 0.45)");
  }
  const skinNormalCanvas = buildNormalCanvasFromHeight(skinHeight, S, 4.4);
  const skinMap = wrapCanvasTexture(skinCanvas, true, 1);
  const skinNormalMap = wrapCanvasTexture(skinNormalCanvas, false, 1);
  const skinRoughnessMap = wrapCanvasTexture(roughCanvas, false, 1);
  const skinVeinEmissiveMap = wrapCanvasTexture(veinEmCanvas, true, 1);
  const C = 256;
  const chCanvas = document.createElement("canvas");
  chCanvas.width = chCanvas.height = C;
  const chCtx = chCanvas.getContext("2d");
  const chImg = chCtx.createImageData(C, C);
  const chHeight = new Float32Array(C * C);
  for (let y = 0; y < C; y++) {
    const v = y / C;
    for (let x = 0; x < C; x++) {
      const u = x / C;
      const idx = y * C + x;
      const grain = fbm2Tile(u * 2, v * 0.5, 16, 811, 3);
      const ring = 0.5 + 0.5 * Math.sin(v * Math.PI * 16 + grain * 4);
      const pit = fbm2Tile(u, v, 20, 829, 2);
      const h = grain * 0.52 + ring * 0.28 + pit * 0.2;
      chHeight[idx] = h;
      const shade = 0.72 + h * 0.44;
      const p4 = idx * 4;
      chImg.data[p4] = Math.round(clamp(206 * shade, 72, 248));
      chImg.data[p4 + 1] = Math.round(clamp(196 * shade, 66, 240));
      chImg.data[p4 + 2] = Math.round(clamp(172 * shade, 54, 224));
      chImg.data[p4 + 3] = 255;
    }
  }
  chCtx.putImageData(chImg, 0, 0);
  const chitinMap = wrapCanvasTexture(chCanvas, true, 1);
  const chitinNormalMap = wrapCanvasTexture(buildNormalCanvasFromHeight(chHeight, C, 4.8), false, 1);
  const flCanvas = document.createElement("canvas");
  flCanvas.width = flCanvas.height = C;
  const flCtx = flCanvas.getContext("2d");
  const flImg = flCtx.createImageData(C, C);
  const flHeight = new Float32Array(C * C);
  for (let y = 0; y < C; y++) {
    const v = y / C;
    for (let x = 0; x < C; x++) {
      const u = x / C;
      const idx = y * C + x;
      const n = fbm2Tile(u, v, 8, 919, 3);
      const fibers = 0.5 + 0.5 * Math.sin((u * 22 + n * 3.5) * Math.PI * 2);
      const h = fibers * 0.58 + n * 0.42;
      flHeight[idx] = h;
      const p4 = idx * 4;
      flImg.data[p4] = Math.round(clamp(150 + fibers * 68 + (n - 0.5) * 34, 68, 236));
      flImg.data[p4 + 1] = Math.round(clamp(38 + fibers * 28 + (n - 0.5) * 18, 16, 94));
      flImg.data[p4 + 2] = Math.round(clamp(38 + fibers * 24 + (n - 0.5) * 16, 18, 86));
      flImg.data[p4 + 3] = 255;
    }
  }
  flCtx.putImageData(flImg, 0, 0);
  const fleshMap = wrapCanvasTexture(flCanvas, true, 1);
  const fleshNormalMap = wrapCanvasTexture(buildNormalCanvasFromHeight(flHeight, C, 6), false, 1);
  const coreCanvas = document.createElement("canvas");
  coreCanvas.width = coreCanvas.height = C;
  const coreCtx = coreCanvas.getContext("2d");
  const coreImg = coreCtx.createImageData(C, C);
  const emCanvas = document.createElement("canvas");
  emCanvas.width = emCanvas.height = C;
  const emCtx = emCanvas.getContext("2d");
  const emImg = emCtx.createImageData(C, C);
  const coreHeight = new Float32Array(C * C);
  for (let y = 0; y < C; y++) {
    const v = y / C;
    for (let x = 0; x < C; x++) {
      const u = x / C;
      const idx = y * C + x;
      const warpX = u + (fbm2Tile(u, v, 6, 1013, 3) - 0.5) * 0.14;
      const warpY = v + (fbm2Tile(u, v, 6, 1031, 3) - 0.5) * 0.14;
      const cell = fbm2Tile(warpX, warpY, 8, 1061, 3);
      const fissure = 1 - Math.abs(fbm2Tile(warpX, warpY, 10, 1093, 3) * 2 - 1);
      const glow = clamp01(Math.pow(fissure, 1.7) * 0.72 + smoothstep((cell - 0.3) * 2.1) * 0.56);
      const crust = smoothstep((0.46 - glow) * 3.3);
      coreHeight[idx] = crust * 0.72 + cell * 0.28;
      const p4 = idx * 4;
      coreImg.data[p4] = Math.round(lerp(185, 34, crust));
      coreImg.data[p4 + 1] = Math.round(lerp(62, 13, crust));
      coreImg.data[p4 + 2] = Math.round(lerp(18, 10, crust));
      coreImg.data[p4 + 3] = 255;
      const hot = smoothstep((glow - 0.68) * 3.4);
      emImg.data[p4] = Math.round(clamp01(glow * 1.15) * 255);
      emImg.data[p4 + 1] = Math.round(clamp01(glow * 0.6 + hot * 0.36) * 255);
      emImg.data[p4 + 2] = Math.round(clamp01(glow * 0.16 + hot * 0.3) * 255);
      emImg.data[p4 + 3] = 255;
    }
  }
  coreCtx.putImageData(coreImg, 0, 0);
  emCtx.putImageData(emImg, 0, 0);
  const coreMap = wrapCanvasTexture(coreCanvas, true, 1);
  const coreEmissiveMap = wrapCanvasTexture(emCanvas, true, 1);
  const coreNormalMap = wrapCanvasTexture(buildNormalCanvasFromHeight(coreHeight, C, 7.2), false, 1);
  return {
    skinMap,
    skinNormalMap,
    skinRoughnessMap,
    skinVeinEmissiveMap,
    chitinMap,
    chitinNormalMap,
    fleshMap,
    fleshNormalMap,
    coreMap,
    coreEmissiveMap,
    coreNormalMap,
    all: [
      skinMap,
      skinNormalMap,
      skinRoughnessMap,
      skinVeinEmissiveMap,
      chitinMap,
      chitinNormalMap,
      fleshMap,
      fleshNormalMap,
      coreMap,
      coreEmissiveMap,
      coreNormalMap
    ]
  };
}
function normalizeForMerge(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const pos = g.getAttribute("position");
  if (!g.getAttribute("uv")) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) * 0.5 + 0.5;
      uvs[i * 2 + 1] = pos.getY(i) * 0.5 + 0.5;
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  }
  if (!g.getAttribute("color")) {
    const colors = new Float32Array(pos.count * 3).fill(1);
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv" && key !== "color") {
      g.deleteAttribute(key);
    }
  }
  return g;
}
function mergeStrict(geos) {
  const normalized = geos.map((g) => normalizeForMerge(g));
  const merged = mergeGeometries(normalized, false);
  for (const g of normalized) g.dispose();
  if (!merged) throw new Error("bossModel: mergeGeometries failed");
  return merged;
}
function sculptOrganicBlob(opts) {
  const segW = opts.segW ?? 14;
  const segH = opts.segH ?? 10;
  const geo = new THREE.SphereGeometry(1, segW, segH);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const [sx, sy, sz] = opts.scale;
  const noiseAmp = opts.noiseAmp ?? 0.1;
  const noiseFreq = opts.noiseFreq ?? 2.3;
  const ridgeAmp = opts.ridgeAmp ?? 0.04;
  const seed = opts.seed ?? 17;
  const topTaper = opts.topTaper ?? 1;
  const botTaper = opts.botTaper ?? 1;
  const bendZ = opts.bendZ ?? 0;
  const bendX = opts.bendX ?? 0;
  const tint = opts.tint ?? [1, 1, 1];
  const aoBottom = opts.aoBottom ?? 0.24;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x;
    const ny = v.y;
    const nz = v.z;
    const f = fbm3(nx * noiseFreq, ny * noiseFreq, nz * noiseFreq, seed, 3) - 0.5;
    const r = ridged3(nx * noiseFreq * 1.4, ny * noiseFreq * 1.4, nz * noiseFreq * 1.4, seed + 53, 2) - 0.45;
    const disp = 1 + f * noiseAmp * 2 + r * ridgeAmp * 2;
    const uY = ny * 0.5 + 0.5;
    const taper = lerp(botTaper, topTaper, uY);
    const px = nx * sx * taper * disp + bendX * (ny + 0.4 * ny * ny);
    const py = ny * sy * disp;
    const pz = nz * sz * taper * disp + bendZ * (ny + 0.4 * ny * ny);
    pos.setXYZ(i, px, py, pz);
    const heightLight = lerp(1 - aoBottom, 1.12, uY);
    const creviceAO = clamp(0.84 + f * 0.34 + r * 0.26, 0.54, 1.16);
    let cr = tint[0] * heightLight * creviceAO;
    let cg = tint[1] * heightLight * creviceAO;
    let cb = tint[2] * heightLight * creviceAO;
    if (opts.crimsonCenter && opts.crimsonRadius) {
      const [rx, ry, rz] = opts.crimsonCenter;
      const dist = Math.hypot(px - rx, py - ry, pz - rz);
      if (dist < opts.crimsonRadius) {
        const ck = smoothstep(1 - dist / opts.crimsonRadius) * (opts.crimsonStrength ?? 0.62);
        cr = lerp(cr, cr * 1.42 + 0.14, ck);
        cg = lerp(cg, cg * 0.52, ck);
        cb = lerp(cb, cb * 0.5, ck);
      }
    }
    colors[i * 3] = clamp(cr, 0.24, 1.35);
    colors[i * 3 + 1] = clamp(cg, 0.24, 1.35);
    colors[i * 3 + 2] = clamp(cb, 0.24, 1.35);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
function sculptUnifiedTorsoTrunk() {
  const geo = new THREE.SphereGeometry(1, 30, 22);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x;
    const ny = v.y;
    const nz = v.z;
    const uY = ny * 0.5 + 0.5;
    let py = lerp(0.04, 2.14, uY);
    const chestEnvelope = smoothstep((uY - 0.18) / 0.52);
    const crownClose = 1 - 0.24 * smoothstep((uY - 0.78) / 0.22);
    const halfWidth = lerp(0.62, 1.06, chestEnvelope) * crownClose;
    const halfDepth = lerp(0.45, 0.65, smoothstep((uY - 0.15) / 0.55));
    let px = nx * halfWidth;
    let pz = nz * halfDepth;
    pz += -0.1 * Math.sin(uY * Math.PI) + 0.14 * smoothstep((uY - 0.62) / 0.38);
    const frontMask = smoothstep((-nz - 0.05) / 0.65);
    const backMask = smoothstep((nz - 0.05) / 0.65);
    const absX = Math.abs(nx);
    const pecBand = gauss(uY - 0.66, 0.12) * smoothstep((absX - 0.12) / 0.26) * frontMask;
    const pecEdge = gauss(uY - 0.57, 0.045) * smoothstep((absX - 0.18) / 0.24) * frontMask;
    const clavicle = gauss(uY - 0.78, 0.05) * smoothstep((absX - 0.1) / 0.3) * frontMask;
    const pecSlab = pecBand * (0.15 + 0.03 * (nx > 0 ? 1 : 0)) + pecEdge * 0.045 + clavicle * 0.055;
    pz -= pecSlab;
    py += pecBand * 0.04 + clavicle * 0.03;
    const trapHump = smoothstep((uY - 0.56) / 0.36) * (0.45 + 0.55 * backMask);
    const rightMut = gauss(nx - 0.42, 0.38) * gauss(uY - 0.8, 0.18);
    py += trapHump * 0.16 + rightMut * 0.14;
    pz += trapHump * 0.14 * backMask;
    px += rightMut * 0.1;
    const latWing = gauss(uY - 0.58, 0.18) * gauss(absX - 0.72, 0.26) * (0.4 + 0.6 * backMask);
    px += Math.sign(nx) * latWing * 0.15;
    pz += latWing * 0.1 * backMask;
    const abBand = gauss(uY - 0.28, 0.14) * frontMask;
    const abSeg = Math.sin(uY * 32) * 0.022 * abBand * (1 - smoothstep((absX - 0.55) / 0.3));
    pz -= abSeg;
    const oblique = gauss(uY - 0.26, 0.14) * gauss(absX - 0.82, 0.22);
    px += Math.sign(nx) * oblique * 0.07;
    const spinalErector = gauss(uY - 0.3, 0.22) * gauss(absX - 0.24, 0.18) * backMask;
    pz += spinalErector * 0.09;
    const chestCavDist = Math.hypot(px / 0.52, (py - 1.06) / 0.42);
    const chestCav = chestCavDist < 1 ? smoothstep(1 - chestCavDist) * frontMask : 0;
    pz += chestCav * 0.28;
    const backCavDist = Math.hypot(px / 0.38, (py - 1.24) / 0.38);
    const backCav = backCavDist < 1 ? smoothstep(1 - backCavDist) * backMask : 0;
    pz -= backCav * 0.24;
    const f = fbm3(px * 2.1, py * 2.1, pz * 2.1, 101, 3) - 0.5;
    const r = ridged3(px * 3.1, py * 3.1, pz * 3.1, 139, 2) - 0.45;
    const organicDisp = f * 0.1 + r * 0.045;
    const outLen = Math.hypot(px, pz) || 1;
    px += px / outLen * organicDisp;
    pz += pz / outLen * organicDisp;
    py += f * 0.04;
    pos.setXYZ(i, px, py, pz);
    uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 1.6);
    const heightShade = lerp(0.76, 1.12, uY);
    const microAO = clamp(0.86 + f * 0.32 + r * 0.24 - (chestCav + backCav) * 0.32, 0.52, 1.15);
    let cr = heightShade * microAO;
    let cg = heightShade * microAO;
    let cb = heightShade * microAO;
    const woundRing = clamp01(
      smoothstep(1.38 - chestCavDist) * frontMask * 0.85 + smoothstep(1.38 - backCavDist) * backMask * 0.8
    );
    cr = lerp(cr, cr * 1.48 + 0.18, woundRing);
    cg = lerp(cg, cg * 0.44, woundRing);
    cb = lerp(cb, cb * 0.42, woundRing);
    colors[i * 3] = clamp(cr, 0.24, 1.38);
    colors[i * 3 + 1] = clamp(cg, 0.22, 1.32);
    colors[i * 3 + 2] = clamp(cb, 0.22, 1.3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}
function sculptMuscleLimb(opts) {
  const rSeg = opts.radialSegs ?? 14;
  const hSeg = opts.heightSegs ?? 8;
  const geo = new THREE.CylinderGeometry(1, 1, opts.length, rSeg, hSeg, false);
  geo.translate(0, -opts.length * 0.5, 0);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const midPos = opts.midPos ?? 0.45;
  const striations = opts.striations ?? 4;
  const striationAmp = opts.striationAmp ?? 0.085;
  const noiseAmp = opts.noiseAmp ?? 0.09;
  const seed = opts.seed ?? 41;
  const bendZ = opts.bendZ ?? 0;
  const bendX = opts.bendX ?? 0;
  const scaleZ = opts.scaleZ ?? 1;
  const tint = opts.tint ?? [1, 1, 1];
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const t = clamp01(-vy / opts.length);
    const radial = Math.hypot(vx, vz);
    const ang = Math.atan2(vz, vx);
    let baseR;
    if (t <= midPos) {
      baseR = lerp(opts.rTop, opts.rMid, smoothstep(t / Math.max(0.01, midPos)));
    } else {
      baseR = lerp(opts.rMid, opts.rBot, smoothstep((t - midPos) / Math.max(0.01, 1 - midPos)));
    }
    const endCap = t < 0.06 ? lerp(0.86, 1, t / 0.06) : t > 0.94 ? lerp(1, 0.84, (t - 0.94) / 0.06) : 1;
    const bundle = Math.sin(ang * striations + t * 1.4 + seed * 0.2) * striationAmp * Math.sin(t * Math.PI);
    const nx = Math.cos(ang);
    const nz = Math.sin(ang);
    const f = fbm3(nx * 2.2, t * 3.8, nz * 2.2, seed, 3) - 0.5;
    const radScale = baseR * endCap * (1 + bundle + f * noiseAmp * 2);
    const px = vx * radScale + bendX * Math.sin(t * Math.PI) + bendX * 0.25 * t;
    const py = vy;
    const pz = vz * radScale * scaleZ + bendZ * Math.sin(t * Math.PI) + bendZ * 0.25 * t;
    pos.setXYZ(i, px, py, pz);
    const jointAO = 0.78 + 0.28 * Math.sin(t * Math.PI * 0.86 + 0.22);
    const grooveAO = clamp(0.88 + bundle * 1.2 + f * 0.3 + (radial < 0.2 ? -0.14 : 0), 0.54, 1.15);
    const shade = jointAO * grooveAO;
    colors[i * 3] = clamp(tint[0] * shade, 0.26, 1.3);
    colors[i * 3 + 1] = clamp(tint[1] * shade, 0.26, 1.3);
    colors[i * 3 + 2] = clamp(tint[2] * shade, 0.26, 1.3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
function sculptCurvedHorn(opts) {
  const rSeg = opts.radialSegs ?? 7;
  const hSeg = opts.heightSegs ?? 5;
  const tipR = opts.tipR ?? 9e-3;
  const geo = new THREE.CylinderGeometry(tipR, opts.baseR, opts.length, rSeg, hSeg, false);
  geo.translate(0, opts.length * 0.5, 0);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const bendZ = opts.bendZ ?? 0.16;
  const bendX = opts.bendX ?? 0;
  const flattenX = opts.flattenX ?? 0.72;
  const baseCol = opts.baseColor ?? [0.56, 0.48, 0.42];
  const tipCol = opts.tipColor ?? [1.32, 1.25, 1.08];
  const seed = opts.seed ?? 73;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const t = clamp01(vy / opts.length);
    const ring = 1 + Math.sin(t * Math.PI * 6 + seed) * 0.07 * (1 - t);
    const jitter = 1 + (noise3(vx * 6, vy * 5, vz * 6, seed) - 0.5) * 0.16;
    const curve = t * t;
    const px = vx * flattenX * ring * jitter + bendX * curve;
    const py = vy;
    const pz = vz * ring * jitter + bendZ * curve;
    pos.setXYZ(i, px, py, pz);
    const k = smoothstep(t);
    colors[i * 3] = lerp(baseCol[0], tipCol[0], k);
    colors[i * 3 + 1] = lerp(baseCol[1], tipCol[1], k);
    colors[i * 3 + 2] = lerp(baseCol[2], tipCol[2], k);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
function sculptOrganicTube(points, radius, tubularSegs, radialSegs, baseCol, tipCol, taperEnds = true, seed = 97) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const geo = new THREE.TubeGeometry(curve, tubularSegs, radius, radialSegs, false);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const ringVerts = radialSegs + 1;
  for (let s = 0; s <= tubularSegs; s++) {
    const t = s / tubularSegs;
    const center = curve.getPointAt(t);
    const endTaper = taperEnds ? 0.36 + 0.64 * Math.sin(t * Math.PI) : lerp(1, 0.52, t);
    for (let r = 0; r < ringVerts; r++) {
      const idx = s * ringVerts + r;
      if (idx >= pos.count) continue;
      const vx = pos.getX(idx) - center.x;
      const vy = pos.getY(idx) - center.y;
      const vz = pos.getZ(idx) - center.z;
      const bump = 1 + (noise3(center.x * 5 + vx * 12, center.y * 5 + vy * 12, center.z * 5 + vz * 12, seed) - 0.5) * 0.24;
      pos.setXYZ(idx, center.x + vx * endTaper * bump, center.y + vy * endTaper * bump, center.z + vz * endTaper * bump);
      const k = smoothstep(t);
      colors[idx * 3] = lerp(baseCol[0], tipCol[0], k);
      colors[idx * 3 + 1] = lerp(baseCol[1], tipCol[1], k);
      colors[idx * 3 + 2] = lerp(baseCol[2], tipCol[2], k);
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}
function buildTorsoGeometries() {
  const skinParts = [];
  const fleshParts = [];
  const chitinParts = [];
  skinParts.push(sculptUnifiedTorsoTrunk());
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.34, 0.28, 0.42],
      pos: [0, 1.66, -0.34],
      rot: [0.42, 0, 0],
      segW: 12,
      segH: 8,
      noiseAmp: 0.11,
      seed: 167,
      tint: [0.94, 0.96, 0.92]
    })
  );
  const tumors = [
    [[0.74, 1.94, 0.14], [0.22, 0.19, 0.2], 201],
    [[0.46, 2.16, 0.22], [0.18, 0.15, 0.17], 203],
    [[0.84, 1.68, 0.28], [0.16, 0.15, 0.16], 207],
    [[-0.64, 1.88, 0.18], [0.18, 0.15, 0.17], 211],
    [[-0.78, 1.48, 0.26], [0.15, 0.14, 0.14], 215],
    [[-0.58, 0.68, -0.24], [0.14, 0.13, 0.12], 219],
    [[0.62, 0.78, 0.26], [0.16, 0.14, 0.14], 223],
    [[0.22, 2.1, 0.34], [0.14, 0.13, 0.14], 227],
    [[-0.26, 1.98, 0.36], [0.13, 0.12, 0.13], 229]
  ];
  for (const [pos, scale, seed] of tumors) {
    skinParts.push(
      sculptOrganicBlob({
        scale,
        pos,
        segW: 8,
        segH: 6,
        noiseAmp: 0.22,
        ridgeAmp: 0.08,
        seed,
        tint: [1.14, 0.86, 0.78]
      })
    );
  }
  fleshParts.push(
    sculptOrganicBlob({
      scale: [0.46, 0.42, 0.18],
      pos: [0, 1.06, -0.44],
      segW: 12,
      segH: 8,
      noiseAmp: 0.18,
      ridgeAmp: 0.09,
      seed: 241,
      tint: [0.95, 0.78, 0.76]
    })
  );
  fleshParts.push(
    sculptOrganicBlob({
      scale: [0.36, 0.38, 0.18],
      pos: [0, 1.24, 0.4],
      segW: 12,
      segH: 8,
      noiseAmp: 0.18,
      ridgeAmp: 0.09,
      seed: 247,
      tint: [0.92, 0.76, 0.74]
    })
  );
  for (const side of [-1, 1]) {
    fleshParts.push(
      sculptOrganicTube(
        [
          [side * 0.26, 1.48, -0.44],
          [side * 0.18, 1.6, -0.54],
          [side * 0.11, 1.68, -0.64]
        ],
        0.052,
        7,
        6,
        [0.88, 0.68, 0.68],
        [1, 0.8, 0.78],
        true,
        side < 0 ? 251 : 257
      )
    );
    fleshParts.push(
      sculptOrganicTube(
        [
          [side * 0.34, 0.78, -0.34],
          [side * 0.22, 0.54, -0.38],
          [side * 0.18, 0.26, -0.3]
        ],
        0.042,
        7,
        6,
        [0.92, 0.68, 0.68],
        [0.72, 0.5, 0.5],
        true,
        side < 0 ? 263 : 269
      )
    );
  }
  const ribLevels = [
    [1.3, 0.64, 0.22, 0.056],
    [1.12, 0.68, 0.18, 0.058],
    [0.94, 0.64, 0.2, 0.054],
    [0.76, 0.56, 0.26, 0.048]
  ];
  for (let i = 0; i < ribLevels.length; i++) {
    const [ry, xOuter, xInner, rad] = ribLevels[i];
    for (const side of [-1, 1]) {
      chitinParts.push(
        sculptOrganicTube(
          [
            [side * xOuter, ry + 0.04, -0.2],
            [side * (xOuter * 0.78), ry + 0.02, -0.58],
            [side * xInner, ry - 0.05, -0.66]
          ],
          rad,
          9,
          6,
          [0.58, 0.5, 0.44],
          [1.34, 1.26, 1.08],
          false,
          301 + i * 11 + (side > 0 ? 3 : 0)
        )
      );
    }
  }
  const dorsalSpines = [
    // Nape crest blades pushing total standing height cleanly to ~4.05m
    { pos: [0.02, 2.06, 0.08], rot: [0.52, 0, -0.04], len: 0.62, baseR: 0.122, bendZ: 0.2 },
    { pos: [-0.02, 1.92, 0.28], rot: [0.78, 0, 0.04], len: 0.72, baseR: 0.132, bendZ: 0.24 },
    { pos: [0.02, 1.68, 0.42], rot: [1.02, 0, -0.04], len: 0.64, baseR: 0.118, bendZ: 0.2 },
    // Flanking curved bone plates framing the dorsal molten core rupture
    { pos: [-0.28, 1.44, 0.42], rot: [1.14, -0.28, 0.24], len: 0.56, baseR: 0.1, bendZ: 0.16 },
    { pos: [0.28, 1.44, 0.42], rot: [1.14, 0.28, -0.24], len: 0.56, baseR: 0.1, bendZ: 0.16 },
    { pos: [-0.25, 1.04, 0.4], rot: [1.26, -0.24, 0.2], len: 0.5, baseR: 0.09, bendZ: 0.14 },
    { pos: [0.25, 1.04, 0.4], rot: [1.26, 0.24, -0.2], len: 0.5, baseR: 0.09, bendZ: 0.14 },
    // Lower spine blades rooted deeply inside lumbar musculature (zero side-view gap!)
    { pos: [0, 0.74, 0.28], rot: [1.34, 0, 0], len: 0.5, baseR: 0.088, bendZ: 0.12 },
    { pos: [0, 0.42, 0.22], rot: [1.44, 0, 0], len: 0.44, baseR: 0.076, bendZ: 0.09 },
    // Asymmetric brutal bone-horn crests erupting from right & left trapezius humps
    { pos: [0.64, 1.96, -0.02], rot: [0.22, -0.18, -0.44], len: 0.6, baseR: 0.114, bendZ: 0.16 },
    { pos: [0.82, 1.76, 0.06], rot: [0.38, -0.32, -0.68], len: 0.5, baseR: 0.094, bendZ: 0.14 },
    { pos: [-0.58, 1.88, 0.04], rot: [0.28, 0.2, 0.46], len: 0.48, baseR: 0.092, bendZ: 0.13 }
  ];
  for (let i = 0; i < dorsalSpines.length; i++) {
    const sp = dorsalSpines[i];
    chitinParts.push(
      sculptCurvedHorn({
        length: sp.len,
        baseR: sp.baseR,
        tipR: 0.014,
        bendZ: sp.bendZ,
        flattenX: 0.58,
        radialSegs: 7,
        heightSegs: 5,
        pos: sp.pos,
        rot: sp.rot,
        seed: 350 + i * 7
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    flesh: mergeStrict(fleshParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildCoreGeometries() {
  const coreParts = [];
  const cageParts = [];
  coreParts.push(
    sculptOrganicBlob({
      scale: [0.31, 0.31, 0.23],
      pos: [0, -0.02, -0.49],
      segW: 16,
      segH: 12,
      noiseAmp: 0.16,
      ridgeAmp: 0.1,
      seed: 401,
      aoBottom: 0.08
    })
  );
  const nodules = [
    [[-0.19, 0.14, -0.53], [0.12, 0.11, 0.1], 409],
    [[0.2, 0.12, -0.53], [0.13, 0.11, 0.1], 419],
    [[-0.15, -0.18, -0.51], [0.11, 0.1, 0.09], 421],
    [[0.16, -0.17, -0.51], [0.12, 0.1, 0.09], 431]
  ];
  for (const [pos, scale, seed] of nodules) {
    coreParts.push(
      sculptOrganicBlob({
        scale,
        pos,
        segW: 10,
        segH: 6,
        noiseAmp: 0.18,
        ridgeAmp: 0.08,
        seed,
        aoBottom: 0.06
      })
    );
  }
  coreParts.push(
    sculptOrganicBlob({
      scale: [0.24, 0.3, 0.22],
      pos: [0, 0.16, 0.44],
      segW: 14,
      segH: 10,
      noiseAmp: 0.16,
      ridgeAmp: 0.1,
      seed: 439,
      aoBottom: 0.08
    })
  );
  coreParts.push(
    sculptOrganicBlob({
      scale: [0.12, 0.15, 0.11],
      pos: [0, -0.1, 0.47],
      segW: 10,
      segH: 6,
      noiseAmp: 0.16,
      seed: 443,
      aoBottom: 0.06
    })
  );
  const straps = [
    [
      [-0.31, 0.21, -0.54],
      [-0.04, 0.06, -0.71],
      [0.27, -0.16, -0.56]
    ],
    [
      [0.29, 0.22, -0.54],
      [0.04, -0.02, -0.71],
      [-0.25, -0.22, -0.55]
    ],
    [
      [-0.22, 0.34, 0.48],
      [0.02, 0.16, 0.65],
      [0.22, -0.04, 0.49]
    ],
    [
      [0.22, 0.34, 0.48],
      [-0.03, 0.14, 0.65],
      [-0.2, -0.04, 0.49]
    ]
  ];
  for (let i = 0; i < straps.length; i++) {
    cageParts.push(
      sculptOrganicTube(
        straps[i],
        0.026,
        7,
        5,
        [0.45, 0.22, 0.2],
        [0.32, 0.16, 0.15],
        true,
        461 + i * 7
      )
    );
  }
  return {
    coreGeo: mergeStrict(coreParts),
    cageGeo: mergeStrict(cageParts)
  };
}
function buildHeadGeometries() {
  const skinParts = [];
  const fleshParts = [];
  const chitinParts = [];
  const eyeParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.25, 0.24, 0.31],
      pos: [0, 0.12, -0.08],
      rot: [0.14, 0, 0],
      segW: 16,
      segH: 12,
      noiseAmp: 0.11,
      ridgeAmp: 0.06,
      seed: 503,
      topTaper: 0.84,
      botTaper: 1.06
    })
  );
  for (const side of [-1, 1]) {
    skinParts.push(
      sculptOrganicBlob({
        scale: [0.135, 0.068, 0.13],
        pos: [side * 0.105, 0.165, -0.32],
        rot: [0.18, side * 0.24, -side * 0.24],
        segW: 8,
        segH: 6,
        noiseAmp: 0.14,
        seed: side < 0 ? 509 : 521,
        tint: [0.84, 0.86, 0.82]
      })
    );
    skinParts.push(
      sculptOrganicBlob({
        scale: [0.098, 0.088, 0.16],
        pos: [side * 0.168, 0.02, -0.22],
        rot: [0, side * 0.22, 0],
        segW: 8,
        segH: 6,
        noiseAmp: 0.12,
        seed: side < 0 ? 523 : 541,
        tint: [0.9, 0.88, 0.86]
      })
    );
  }
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.165, 0.11, 0.2],
      pos: [0, 0.03, -0.29],
      rot: [0.08, 0, 0],
      segW: 10,
      segH: 8,
      noiseAmp: 0.12,
      seed: 547,
      crimsonCenter: [0, -0.06, -0.15],
      crimsonRadius: 0.19,
      crimsonStrength: 0.58
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.175, 0.095, 0.22],
      pos: [0, -0.15, -0.25],
      rot: [0.36, 0, 0],
      segW: 12,
      segH: 8,
      noiseAmp: 0.13,
      seed: 557,
      topTaper: 0.92,
      botTaper: 0.76,
      crimsonCenter: [0, 0.04, -0.1],
      crimsonRadius: 0.2,
      crimsonStrength: 0.65
    })
  );
  fleshParts.push(
    sculptOrganicBlob({
      scale: [0.135, 0.115, 0.165],
      pos: [0, -0.055, -0.27],
      segW: 10,
      segH: 6,
      noiseAmp: 0.14,
      seed: 563,
      tint: [0.85, 0.55, 0.55]
    })
  );
  for (const side of [-1, 1]) {
    fleshParts.push(
      sculptOrganicTube(
        [
          [side * 0.155, 0.02, -0.27],
          [side * 0.165, -0.06, -0.27],
          [side * 0.145, -0.14, -0.25]
        ],
        0.026,
        5,
        5,
        [0.95, 0.65, 0.65],
        [0.75, 0.45, 0.45],
        true,
        side < 0 ? 569 : 571
      )
    );
  }
  const fangSpecs = [
    [[-0.09, -0.01, -0.4], [Math.PI + 0.16, 0, 0.08], 0.088],
    [[0.09, -0.01, -0.4], [Math.PI + 0.16, 0, -0.08], 0.088],
    [[-0.038, -0.01, -0.43], [Math.PI + 0.12, 0, 0], 0.065],
    [[0.038, -0.01, -0.43], [Math.PI + 0.12, 0, 0], 0.065],
    [[-0.1, -0.13, -0.39], [0.22, 0, 0.14], 0.095],
    [[0.1, -0.13, -0.39], [0.22, 0, -0.14], 0.095],
    [[-0.044, -0.14, -0.41], [0.16, 0, 0], 0.062],
    [[0.044, -0.14, -0.41], [0.16, 0, 0], 0.062]
  ];
  for (let i = 0; i < fangSpecs.length; i++) {
    const [pos, rot, len] = fangSpecs[i];
    chitinParts.push(
      sculptCurvedHorn({
        length: len,
        baseR: 0.022,
        tipR: 4e-3,
        bendZ: -0.016,
        radialSegs: 5,
        heightSegs: 3,
        pos,
        rot,
        seed: 577 + i * 3
      })
    );
  }
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.3,
      baseR: 0.058,
      tipR: 9e-3,
      bendZ: 0.1,
      pos: [0, 0.27, 0.02],
      rot: [0.58, 0, 0],
      radialSegs: 6,
      heightSegs: 4,
      seed: 601
    })
  );
  for (const side of [-1, 1]) {
    chitinParts.push(
      sculptCurvedHorn({
        length: 0.28,
        baseR: 0.046,
        tipR: 8e-3,
        bendZ: 0.09,
        bendX: side * 0.05,
        pos: [side * 0.17, 0.22, -0.1],
        rot: [0.5, side * 0.26, -side * 0.38],
        radialSegs: 6,
        heightSegs: 4,
        seed: side < 0 ? 607 : 613
      })
    );
  }
  for (const side of [-1, 1]) {
    eyeParts.push(
      sculptOrganicBlob({
        scale: [0.056, 0.028, 0.038],
        pos: [side * 0.098, 0.108, -0.355],
        rot: [0.08, side * 0.28, -side * 0.28],
        segW: 8,
        segH: 6,
        noiseAmp: 0.04,
        seed: side < 0 ? 617 : 619,
        aoBottom: 0
      })
    );
  }
  eyeParts.push(
    sculptOrganicBlob({
      scale: [0.11, 0.045, 0.062],
      pos: [0, -0.07, -0.355],
      segW: 8,
      segH: 6,
      noiseAmp: 0.12,
      seed: 631,
      aoBottom: 0
    })
  );
  return {
    skin: mergeStrict(skinParts),
    flesh: mergeStrict(fleshParts),
    chitin: mergeStrict(chitinParts),
    eyes: mergeStrict(eyeParts)
  };
}
function buildUpperArmGeometries(side) {
  const bulk = side > 0 ? 1.13 : 1;
  const skinParts = [];
  const chitinParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.35 * bulk, 0.37 * bulk, 0.36 * bulk],
      pos: [side * 0.05, -0.02, 0],
      rot: [0, 0, -side * 0.18],
      segW: 14,
      segH: 10,
      noiseAmp: 0.12,
      ridgeAmp: 0.055,
      seed: side < 0 ? 701 : 709
    })
  );
  skinParts.push(
    sculptMuscleLimb({
      length: 1.02,
      rTop: 0.28 * bulk,
      rMid: 0.3 * bulk,
      rBot: 0.23 * bulk,
      midPos: 0.44,
      radialSegs: 12,
      heightSegs: 8,
      striations: 4,
      striationAmp: 0.09,
      noiseAmp: 0.085,
      seed: side < 0 ? 719 : 727,
      bendX: side * 0.05,
      bendZ: 0.04,
      scaleZ: 1.08
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.14 * bulk, 0.13 * bulk, 0.13 * bulk],
      pos: [side * 0.3 * bulk, 0.08, 0.08],
      segW: 8,
      segH: 6,
      noiseAmp: 0.2,
      seed: side < 0 ? 733 : 739,
      tint: [1.14, 0.86, 0.8]
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.22 * bulk, 0.2 * bulk, 0.23 * bulk],
      pos: [side * 0.05, -0.98, 0.04],
      segW: 10,
      segH: 6,
      noiseAmp: 0.11,
      seed: side < 0 ? 743 : 751,
      tint: [0.92, 0.92, 0.88]
    })
  );
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.48 * bulk,
      baseR: 0.095 * bulk,
      tipR: 0.013,
      bendZ: 0.12,
      bendX: side * 0.1,
      pos: [side * 0.24 * bulk, 0.16, -0.02],
      rot: [0.12, 0, -side * 0.72],
      radialSegs: 7,
      heightSegs: 5,
      seed: side < 0 ? 757 : 761
    })
  );
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.36 * bulk,
      baseR: 0.074 * bulk,
      tipR: 0.011,
      bendZ: 0.09,
      pos: [side * 0.28 * bulk, -0.04, 0.12],
      rot: [0.35, side * 0.18, -side * 1.05],
      radialSegs: 6,
      heightSegs: 4,
      seed: side < 0 ? 769 : 773
    })
  );
  if (side > 0) {
    chitinParts.push(
      sculptCurvedHorn({
        length: 0.4,
        baseR: 0.078,
        tipR: 0.011,
        bendZ: 0.12,
        pos: [0.28, -0.28, 0.02],
        rot: [0.18, -0.2, -1.22],
        radialSegs: 6,
        heightSegs: 4,
        seed: 787
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildForearmGeometries(side) {
  const bulk = side > 0 ? 1.16 : 1;
  const skinParts = [];
  const chitinParts = [];
  skinParts.push(
    sculptMuscleLimb({
      length: 1.04,
      rTop: 0.24 * bulk,
      rMid: 0.32 * bulk,
      rBot: 0.22 * bulk,
      midPos: 0.56,
      radialSegs: 14,
      heightSegs: 8,
      striations: 5,
      striationAmp: 0.095,
      noiseAmp: 0.1,
      seed: side < 0 ? 809 : 811,
      bendZ: -0.07,
      bendX: side * 0.03,
      scaleZ: 1.06
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.15 * bulk, 0.22 * bulk, 0.16 * bulk],
      pos: [side * 0.21 * bulk, -0.56, 0.06],
      segW: 8,
      segH: 6,
      noiseAmp: 0.18,
      seed: side < 0 ? 821 : 823,
      tint: [1.1, 0.88, 0.82]
    })
  );
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.38 * bulk,
      baseR: 0.078 * bulk,
      tipR: 0.011,
      bendZ: 0.1,
      pos: [side * 0.06, -0.06, 0.18 * bulk],
      rot: [1.75, 0, -side * 0.18],
      radialSegs: 6,
      heightSegs: 4,
      seed: side < 0 ? 827 : 829
    })
  );
  const spurYs = side > 0 ? [-0.34, -0.58, -0.82] : [-0.4, -0.72];
  for (let i = 0; i < spurYs.length; i++) {
    chitinParts.push(
      sculptCurvedHorn({
        length: (0.32 + i * 0.05) * bulk,
        baseR: (0.062 + i * 8e-3) * bulk,
        tipR: 0.01,
        bendZ: 0.08,
        pos: [side * 0.24 * bulk, spurYs[i], 0.04],
        rot: [0.55, side * 0.15, -side * (1.22 + i * 0.1)],
        radialSegs: 6,
        heightSegs: 4,
        seed: 839 + i * 13 + (side > 0 ? 5 : 0)
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildHandGeometries(side) {
  const bulk = side > 0 ? 1.16 : 1;
  const skinParts = [];
  const chitinParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.22 * bulk, 0.22 * bulk, 0.19 * bulk],
      pos: [0, -0.15, -0.02],
      segW: 10,
      segH: 8,
      noiseAmp: 0.12,
      seed: side < 0 ? 853 : 857,
      crimsonCenter: [0, -0.18, -0.1],
      crimsonRadius: 0.24,
      crimsonStrength: 0.45
    })
  );
  const fingerOffsets = [-0.12, -0.04, 0.04, 0.12];
  for (let i = 0; i < fingerOffsets.length; i++) {
    const fz = fingerOffsets[i] * bulk;
    const fLen = (0.14 + (i === 1 || i === 2 ? 0.03 : 0)) * bulk;
    skinParts.push(
      sculptMuscleLimb({
        length: fLen,
        rTop: 0.048 * bulk,
        rMid: 0.044 * bulk,
        rBot: 0.038 * bulk,
        radialSegs: 6,
        heightSegs: 3,
        striations: 2,
        noiseAmp: 0.07,
        seed: 863 + i * 7 + (side > 0 ? 3 : 0),
        pos: [side * 0.08 * bulk, -0.27, fz],
        rot: [0, 0, -side * 0.28]
      })
    );
    const kX = side * 0.08 * bulk - side * Math.sin(0.28) * fLen;
    const kY = -0.27 - Math.cos(0.28) * fLen;
    skinParts.push(
      sculptMuscleLimb({
        length: fLen * 0.82,
        rTop: 0.038 * bulk,
        rMid: 0.034 * bulk,
        rBot: 0.028 * bulk,
        radialSegs: 6,
        heightSegs: 2,
        striations: 2,
        noiseAmp: 0.06,
        seed: 873 + i * 7 + (side > 0 ? 3 : 0),
        pos: [kX, kY, fz],
        rot: [0, 0, -side * 0.85]
      })
    );
    const tipX = kX - side * Math.sin(0.85) * (fLen * 0.78);
    const tipY = kY - Math.cos(0.85) * (fLen * 0.78);
    chitinParts.push(
      sculptCurvedHorn({
        length: 0.19 * bulk,
        baseR: 0.032 * bulk,
        tipR: 5e-3,
        bendX: -side * 0.06,
        bendZ: 0,
        pos: [tipX, tipY, fz],
        rot: [0, 0, Math.PI - side * 1.05],
        radialSegs: 5,
        heightSegs: 3,
        seed: 881 + i * 5 + (side > 0 ? 2 : 0)
      })
    );
  }
  skinParts.push(
    sculptMuscleLimb({
      length: 0.19 * bulk,
      rTop: 0.054 * bulk,
      rMid: 0.048 * bulk,
      rBot: 0.035 * bulk,
      radialSegs: 6,
      heightSegs: 3,
      striations: 2,
      noiseAmp: 0.08,
      seed: side < 0 ? 907 : 911,
      pos: [-side * 0.12 * bulk, -0.17, -0.14 * bulk],
      rot: [0.46, 0, -side * 0.42]
    })
  );
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.16 * bulk,
      baseR: 0.03 * bulk,
      tipR: 5e-3,
      bendX: side * 0.06,
      pos: [-side * 0.05 * bulk, -0.32, -0.21 * bulk],
      rot: [0.42, 0, Math.PI - side * 0.35],
      radialSegs: 5,
      heightSegs: 3,
      seed: side < 0 ? 919 : 929
    })
  );
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildPelvisGeometries() {
  const skinParts = [];
  const chitinParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.74, 0.44, 0.5],
      pos: [0, 0.08, 0.02],
      segW: 18,
      segH: 12,
      noiseAmp: 0.15,
      ridgeAmp: 0.08,
      seed: 937,
      topTaper: 0.82,
      botTaper: 1.06,
      tint: [0.88, 0.9, 0.86]
    })
  );
  for (const side of [-1, 1]) {
    skinParts.push(
      sculptOrganicBlob({
        scale: [0.38, 0.36, 0.38],
        pos: [side * 0.44, -0.06, 0.1],
        rot: [0.12, 0, side * 0.18],
        segW: 12,
        segH: 8,
        noiseAmp: 0.1,
        seed: side < 0 ? 941 : 947,
        tint: [0.86, 0.88, 0.84]
      })
    );
    chitinParts.push(
      sculptCurvedHorn({
        length: 0.32,
        baseR: 0.064,
        tipR: 0.011,
        bendZ: 0.09,
        pos: [side * 0.66, 0.14, 0.05],
        rot: [0.35, 0, -side * 0.95],
        radialSegs: 6,
        heightSegs: 4,
        seed: side < 0 ? 953 : 967
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildThighGeometries(side) {
  const skinParts = [];
  const chitinParts = [];
  skinParts.push(
    sculptMuscleLimb({
      length: 0.78,
      rTop: 0.4,
      rMid: 0.36,
      rBot: 0.27,
      midPos: 0.42,
      radialSegs: 14,
      heightSegs: 8,
      striations: 4,
      striationAmp: 0.09,
      noiseAmp: 0.09,
      seed: side < 0 ? 971 : 977,
      bendZ: -0.1,
      bendX: side * 0.04,
      scaleZ: 1.1,
      pos: [0, 0.12, 0],
      rot: [0.22, 0, 0],
      tint: [0.92, 0.94, 0.9]
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.24, 0.22, 0.25],
      pos: [side * 0.02, -0.62, -0.15],
      segW: 10,
      segH: 6,
      noiseAmp: 0.12,
      seed: side < 0 ? 983 : 991,
      tint: [0.88, 0.9, 0.86]
    })
  );
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.25,
      baseR: 0.056,
      tipR: 9e-3,
      bendZ: -0.05,
      pos: [side * 0.03, -0.6, -0.34],
      rot: [-1.18, 0, -side * 0.14],
      radialSegs: 6,
      heightSegs: 4,
      seed: side < 0 ? 997 : 1009
    })
  );
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildShinGeometries(side) {
  const skinParts = [];
  const chitinParts = [];
  skinParts.push(
    sculptMuscleLimb({
      length: 0.72,
      rTop: 0.28,
      rMid: 0.31,
      rBot: 0.22,
      midPos: 0.4,
      radialSegs: 12,
      heightSegs: 7,
      striations: 4,
      striationAmp: 0.09,
      noiseAmp: 0.095,
      seed: side < 0 ? 1013 : 1019,
      bendZ: 0.1,
      scaleZ: 1.14,
      pos: [0, 0.06, 0],
      rot: [-0.18, 0, 0],
      tint: [0.9, 0.92, 0.88]
    })
  );
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.26,
      baseR: 0.05,
      tipR: 9e-3,
      bendZ: 0.06,
      pos: [side * 0.22, -0.24, 0.08],
      rot: [0.55, 0, -side * 1.2],
      radialSegs: 6,
      heightSegs: 4,
      seed: side < 0 ? 1021 : 1031
    })
  );
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
function buildFootGeometries(side) {
  const skinParts = [];
  const chitinParts = [];
  const instep = sculptOrganicBlob({
    scale: [0.27, 0.15, 0.34],
    pos: [0, -0.1, -0.1],
    segW: 10,
    segH: 6,
    noiseAmp: 0.1,
    seed: side < 0 ? 1033 : 1039,
    tint: [0.86, 0.88, 0.84]
  });
  const ipos = instep.getAttribute("position");
  for (let i = 0; i < ipos.count; i++) {
    if (ipos.getY(i) < -0.24) ipos.setY(i, -0.24);
  }
  instep.computeVertexNormals();
  skinParts.push(instep);
  const toeXs = [-0.15, 0, 0.15];
  for (let i = 0; i < toeXs.length; i++) {
    const tx = toeXs[i];
    const toe = sculptOrganicBlob({
      scale: [0.085, 0.075, 0.17],
      pos: [tx, -0.17, -0.36 - (i === 1 ? 0.04 : 0)],
      rot: [0, -tx * 0.9, 0],
      segW: 7,
      segH: 5,
      noiseAmp: 0.09,
      seed: 1049 + i * 7 + (side > 0 ? 3 : 0),
      tint: [0.88, 0.86, 0.82]
    });
    const tpos = toe.getAttribute("position");
    for (let k = 0; k < tpos.count; k++) {
      if (tpos.getY(k) < -0.24) tpos.setY(k, -0.24);
    }
    toe.computeVertexNormals();
    skinParts.push(toe);
    chitinParts.push(
      sculptCurvedHorn({
        length: 0.18,
        baseR: 0.038,
        tipR: 6e-3,
        bendZ: -0.02,
        pos: [tx * 1.12, -0.18, -0.46 - (i === 1 ? 0.04 : 0)],
        rot: [-Math.PI * 0.54, -tx * 0.9, 0],
        radialSegs: 5,
        heightSegs: 3,
        seed: 1061 + i * 5 + (side > 0 ? 2 : 0)
      })
    );
  }
  chitinParts.push(
    sculptCurvedHorn({
      length: 0.16,
      baseR: 0.038,
      tipR: 7e-3,
      bendZ: 0.03,
      pos: [0, -0.17, 0.18],
      rot: [Math.PI * 0.56, 0, 0],
      radialSegs: 5,
      heightSegs: 3,
      seed: side < 0 ? 1087 : 1091
    })
  );
  return {
    skin: mergeStrict(skinParts),
    chitin: mergeStrict(chitinParts)
  };
}
var BASE_HIP_Y = 1.52;
var SKIN_COLOR_P1 = new THREE.Color("#3A3F38");
var SKIN_COLOR_P2 = new THREE.Color("#4B2B29");
var SKIN_VEIN_EMISSIVE_P2 = new THREE.Color("#D42612");
var CORE_COLOR_P1 = new THREE.Color("#FF6A2B");
var CORE_COLOR_P2 = new THREE.Color("#FF8636");
var DEG2RAD = Math.PI / 180;
var ATTACK_DURATION = 0.18;
var RECOVER_DURATION = 0.8;
function makeNeutralPose() {
  return {
    torso: [0, 0, 0],
    head: [0, 0, 0],
    leftArm: [0, 0, 0],
    elbowL: [0, 0, 0],
    handL: [0, 0, 0],
    rightArm: [0, 0, 0],
    elbowR: [0, 0, 0],
    handR: [0, 0, 0],
    hips: [0, 0, 0],
    thighL: [0, 0, 0],
    shinL: [0, 0, 0],
    footL: [0, 0, 0],
    thighR: [0, 0, 0],
    shinR: [0, 0, 0],
    footR: [0, 0, 0]
  };
}
function createBossModel() {
  const textures = createProceduralBossTextures();
  const ownedGeometries = [];
  const ownedMaterials = [];
  const trackGeo = (g) => {
    ownedGeometries.push(g);
    return g;
  };
  const trackMat = (m) => {
    ownedMaterials.push(m);
    return m;
  };
  const skinMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: SKIN_COLOR_P1.clone(),
      map: textures.skinMap,
      normalMap: textures.skinNormalMap,
      normalScale: new THREE.Vector2(1.05, 1.05),
      roughnessMap: textures.skinRoughnessMap,
      roughness: 0.84,
      metalness: 0.05,
      emissive: SKIN_VEIN_EMISSIVE_P2.clone(),
      emissiveMap: textures.skinVeinEmissiveMap,
      emissiveIntensity: 0,
      vertexColors: true
    })
  );
  const chitinMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#807562"),
      map: textures.chitinMap,
      normalMap: textures.chitinNormalMap,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 0.66,
      metalness: 0.06,
      vertexColors: true
    })
  );
  const fleshMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#66201E"),
      map: textures.fleshMap,
      normalMap: textures.fleshNormalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.42,
      metalness: 0.04,
      vertexColors: true
    })
  );
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#481608"),
      map: textures.coreMap,
      emissive: CORE_COLOR_P1.clone(),
      emissiveMap: textures.coreEmissiveMap,
      emissiveIntensity: 1.75,
      normalMap: textures.coreNormalMap,
      normalScale: new THREE.Vector2(1.25, 1.25),
      roughness: 0.36,
      metalness: 0.05
    })
  );
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2B0404"),
      emissive: new THREE.Color("#E22014"),
      emissiveIntensity: 2.5,
      roughness: 0.25,
      metalness: 0.05
    })
  );
  const makeMesh = (geo, mat, name) => {
    const mesh = new THREE.Mesh(trackGeo(geo), mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const root = new THREE.Group();
  root.name = "boss-root";
  const body = new THREE.Group();
  body.name = "boss-body";
  body.position.set(0, BASE_HIP_Y, 0);
  root.add(body);
  const torso = new THREE.Group();
  torso.name = "boss-torso";
  body.add(torso);
  const torsoGeo = buildTorsoGeometries();
  torso.add(makeMesh(torsoGeo.skin, skinMat, "boss-torso-skin"));
  torso.add(makeMesh(torsoGeo.flesh, fleshMat, "boss-torso-flesh"));
  torso.add(makeMesh(torsoGeo.chitin, chitinMat, "boss-torso-chitin"));
  const coreGeos = buildCoreGeometries();
  const core = makeMesh(coreGeos.coreGeo, coreMat, "boss-core");
  core.position.set(0, 1.08, 0);
  core.castShadow = false;
  core.add(makeMesh(coreGeos.cageGeo, fleshMat, "boss-core-cage"));
  torso.add(core);
  const head = new THREE.Group();
  head.name = "boss-head";
  head.position.set(0, 1.66, -0.56);
  torso.add(head);
  const headGeo = buildHeadGeometries();
  head.add(makeMesh(headGeo.skin, skinMat, "boss-head-skin"));
  head.add(makeMesh(headGeo.flesh, fleshMat, "boss-head-flesh"));
  head.add(makeMesh(headGeo.chitin, chitinMat, "boss-head-chitin"));
  const eyesMesh = makeMesh(headGeo.eyes, eyeMat, "boss-head-eyes");
  eyesMesh.castShadow = false;
  head.add(eyesMesh);
  const buildArmChain = (side, tag, shoulderPos) => {
    const shoulder = new THREE.Group();
    shoulder.name = `boss-shoulder-${tag}`;
    shoulder.position.set(shoulderPos[0], shoulderPos[1], shoulderPos[2]);
    torso.add(shoulder);
    const upperGeo = buildUpperArmGeometries(side);
    shoulder.add(makeMesh(upperGeo.skin, skinMat, `boss-upper-arm-skin-${tag}`));
    shoulder.add(makeMesh(upperGeo.chitin, chitinMat, `boss-upper-arm-chitin-${tag}`));
    const elbow = new THREE.Group();
    elbow.name = `boss-elbow-${tag}`;
    elbow.position.set(side * 0.05, -0.98, 0.04);
    shoulder.add(elbow);
    const foreGeo = buildForearmGeometries(side);
    elbow.add(makeMesh(foreGeo.skin, skinMat, `boss-forearm-skin-${tag}`));
    elbow.add(makeMesh(foreGeo.chitin, chitinMat, `boss-forearm-chitin-${tag}`));
    const hand = new THREE.Group();
    hand.name = `boss-hand-${tag}`;
    hand.position.set(side * 0.02, -1, -0.04);
    elbow.add(hand);
    const handGeo = buildHandGeometries(side);
    hand.add(makeMesh(handGeo.skin, skinMat, `boss-hand-skin-${tag}`));
    hand.add(makeMesh(handGeo.chitin, chitinMat, `boss-hand-chitin-${tag}`));
    return { shoulder, elbow, hand };
  };
  const armL = buildArmChain(-1, "l", [-1.02, 1.56, -0.05]);
  const armR = buildArmChain(1, "r", [1.06, 1.6, -0.03]);
  const hips = new THREE.Group();
  hips.name = "boss-hips";
  body.add(hips);
  const pelvisGeo = buildPelvisGeometries();
  hips.add(makeMesh(pelvisGeo.skin, skinMat, "boss-pelvis-skin"));
  hips.add(makeMesh(pelvisGeo.chitin, chitinMat, "boss-pelvis-chitin"));
  const buildLegChain = (side, tag) => {
    const thigh = new THREE.Group();
    thigh.name = `boss-thigh-${tag}`;
    thigh.position.set(side * 0.54, 0, 0.02);
    hips.add(thigh);
    const thighGeo = buildThighGeometries(side);
    thigh.add(makeMesh(thighGeo.skin, skinMat, `boss-thigh-skin-${tag}`));
    thigh.add(makeMesh(thighGeo.chitin, chitinMat, `boss-thigh-chitin-${tag}`));
    const shin = new THREE.Group();
    shin.name = `boss-shin-${tag}`;
    shin.position.set(side * 0.02, -0.64, -0.14);
    thigh.add(shin);
    const shinGeo = buildShinGeometries(side);
    shin.add(makeMesh(shinGeo.skin, skinMat, `boss-shin-skin-${tag}`));
    shin.add(makeMesh(shinGeo.chitin, chitinMat, `boss-shin-chitin-${tag}`));
    const foot = new THREE.Group();
    foot.name = `boss-foot-${tag}`;
    foot.position.set(0, -0.64, 0.12);
    shin.add(foot);
    const footGeo = buildFootGeometries(side);
    foot.add(makeMesh(footGeo.skin, skinMat, `boss-foot-skin-${tag}`));
    foot.add(makeMesh(footGeo.chitin, chitinMat, `boss-foot-chitin-${tag}`));
    return { thigh, shin, foot };
  };
  const legL = buildLegChain(-1, "l");
  const legR = buildLegChain(1, "r");
  const jointNodes = {
    torso,
    head,
    leftArm: armL.shoulder,
    elbowL: armL.elbow,
    handL: armL.hand,
    rightArm: armR.shoulder,
    elbowR: armR.elbow,
    handR: armR.hand,
    hips,
    thighL: legL.thigh,
    shinL: legL.shin,
    footL: legL.foot,
    thighR: legR.thigh,
    shinR: legR.shin,
    footR: legR.foot
  };
  const jointKeys = Object.keys(jointNodes);
  const targetPose = makeNeutralPose();
  const tmpEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const tmpQuat = new THREE.Quaternion();
  const tmpColor = new THREE.Color();
  let elapsed = 0;
  let animElapsed = 0;
  let lastAnim = null;
  let phaseBlend = 0;
  let bodyDropCur = 0;
  let torsoScaleYCur = 1;
  let coreScaleCur = 1;
  let disposed = false;
  const setPose = (key, x, y, z) => {
    targetPose[key][0] = x;
    targetPose[key][1] = y;
    targetPose[key][2] = z;
  };
  const update = (dt, state) => {
    if (disposed) return;
    const step = Math.max(0, Math.min(dt, 0.25));
    const hpPct = clamp01(state.hpPct);
    const isPhase2 = state.phase === 2;
    if (state.anim !== lastAnim) {
      lastAnim = state.anim;
      animElapsed = 0;
    }
    elapsed += step;
    animElapsed += step;
    const phaseTarget = isPhase2 ? 1 : 0;
    const phaseAlpha = step > 0 ? 1 - Math.exp(-9 * step) : 1;
    phaseBlend += (phaseTarget - phaseBlend) * phaseAlpha;
    let targetBodyDrop = 0;
    let targetTorsoScaleY = 1;
    let slerpRate = 10;
    let coreWarnMult = 1;
    setPose("hips", 0, 0, 0);
    setPose("thighL", 0.06, 0.08, 0.05);
    setPose("shinL", -0.1, 0, 0);
    setPose("footL", 0.04, 0, -0.05);
    setPose("thighR", -0.04, -0.08, -0.05);
    setPose("shinR", -0.08, 0, 0);
    setPose("footR", 0.12, 0, 0.05);
    const rageRate = 1 + (1 - hpPct) * 0.35 + phaseBlend * 0.25;
    if (state.anim === "idle") {
      const breathPhase = 0.5 + 0.5 * Math.sin(elapsed * 2.2 * rageRate);
      targetTorsoScaleY = 1 + 0.02 * breathPhase;
      const sway = Math.sin(elapsed * 1.15 * rageRate);
      setPose("hips", 0, sway * 0.04, sway * 0.035);
      setPose("torso", -0.07 - breathPhase * 0.03, sway * 0.06, -sway * 0.045);
      setPose("head", 0.04 - breathPhase * 0.04, -sway * 0.1 + Math.sin(elapsed * 0.7) * 0.08, sway * 0.04);
      setPose("leftArm", 0.14 + breathPhase * 0.06, -0.08, 0.16 + breathPhase * 0.04);
      setPose("elbowL", 0.36 + breathPhase * 0.05, 0, -0.06);
      setPose("handL", 0.12, 0, -0.08);
      setPose("rightArm", 0.16 - breathPhase * 0.05 + sway * 0.04, 0.08, -0.18 - breathPhase * 0.04);
      setPose("elbowR", 0.42 + breathPhase * 0.06, 0, 0.08);
      setPose("handR", 0.16, 0, 0.08);
      targetBodyDrop = 8e-3 * (1 - breathPhase);
      slerpRate = 8;
    } else if (state.anim === "walk") {
      const walkFreq = 3.4 * (1 + phaseBlend * 0.14);
      const w = animElapsed * walkFreq + 0.45;
      const s = Math.sin(w);
      const c = Math.cos(w);
      const footStrike = Math.pow(Math.max(0, -Math.cos(w * 2)), 2);
      targetBodyDrop = 0.04 * footStrike;
      targetTorsoScaleY = 1.008 + 8e-3 * Math.abs(s);
      setPose("hips", 0.04 * footStrike, -s * 0.1, s * 0.06);
      setPose("torso", -0.14 - 0.04 * footStrike, s * 0.14, -s * 0.085);
      setPose("head", 0.1 + 0.04 * footStrike, -s * 0.1, s * 0.04);
      setPose("thighL", s * 0.46 + 0.06, 0.05, 0.05);
      setPose("shinL", -Math.max(0.08, -c * 0.56 + 0.16), 0, 0);
      setPose("footL", -s * 0.22 + 0.08, 0, -0.04);
      setPose("thighR", -s * 0.46 + 0.06, -0.05, -0.05);
      setPose("shinR", -Math.max(0.08, c * 0.56 + 0.16), 0, 0);
      setPose("footR", s * 0.22 + 0.08, 0, 0.04);
      setPose("leftArm", -s * 0.44 + 0.14, -0.08, 0.18 + Math.abs(s) * 0.05);
      setPose("elbowL", 0.34 + Math.max(0, -s) * 0.22, 0, -0.06);
      setPose("handL", 0.14, 0, -0.06);
      setPose("rightArm", s * 0.46 + 0.16, 0.08, -0.2 - Math.abs(s) * 0.05);
      setPose("elbowR", 0.4 + Math.max(0, s) * 0.24, 0, 0.08);
      setPose("handR", 0.18, 0, 0.08);
      slerpRate = 12;
    } else if (state.anim === "windup") {
      const backPitch = 15 * DEG2RAD;
      const tremor = Math.sin(animElapsed * 24) * 0.025;
      coreWarnMult = 1.4;
      targetTorsoScaleY = 1.025;
      targetBodyDrop = 0.02;
      setPose("hips", 0.06, -0.14, 0.04);
      setPose("torso", backPitch, -0.26, 0.09);
      setPose("head", -0.14, 0.24, -0.05);
      setPose("leftArm", 0.52, -0.22, 0.34);
      setPose("elbowL", 0.64, 0, -0.12);
      setPose("handL", 0.22, 0, -0.1);
      setPose("rightArm", -1.2 + tremor, 0.16, -0.62);
      setPose("elbowR", 0.72, 0, 0.22);
      setPose("handR", 0.3, 0, 0.14);
      setPose("thighL", 0.24, 0.14, 0.08);
      setPose("shinL", -0.34, 0, 0);
      setPose("footL", 0.1, 0, -0.08);
      setPose("thighR", -0.2, -0.12, -0.08);
      setPose("shinR", -0.24, 0, 0);
      setPose("footR", 0.4, 0, 0.08);
      slerpRate = 14;
    } else if (state.anim === "attack") {
      const u = clamp01(animElapsed / ATTACK_DURATION);
      const smashEase = 1 - Math.pow(1 - u, 3);
      const armSwingX = lerp(-0.35, 1.32, smashEase);
      const torsoPitchX = lerp(0.1, -0.32, smashEase);
      coreWarnMult = lerp(1.38, 1.12, smashEase);
      targetBodyDrop = 0.065 * smashEase;
      targetTorsoScaleY = lerp(1.02, 0.99, smashEase);
      setPose("hips", -0.06 * smashEase, 0.18 * smashEase, -0.04);
      setPose("torso", torsoPitchX, lerp(-0.18, 0.32, smashEase), -0.1 * smashEase);
      setPose("head", lerp(-0.1, 0.22, smashEase), lerp(0.15, -0.24, smashEase), 0.06);
      setPose("leftArm", lerp(0.36, -0.52, smashEase), -0.14, 0.34);
      setPose("elbowL", lerp(0.55, 0.28, smashEase), 0, -0.08);
      setPose("handL", 0.16, 0, -0.08);
      setPose("rightArm", armSwingX, lerp(0.12, -0.18, smashEase), lerp(-0.42, -0.06, smashEase));
      setPose("elbowR", lerp(0.62, 0.22, smashEase), 0, 0.08);
      setPose("handR", 0.32, 0, 0.06);
      setPose("thighL", 0.34 * smashEase + 0.12, 0.1, 0.08);
      setPose("shinL", -0.44 * smashEase - 0.14, 0, 0);
      setPose("footL", 0.14, 0, -0.08);
      setPose("thighR", -0.26 * smashEase, -0.1, -0.08);
      setPose("shinR", -0.22, 0, 0);
      setPose("footR", 0.42 * smashEase + 0.1, 0, 0.08);
      slerpRate = 34;
    } else if (state.anim === "recover") {
      const u = smoothstep(animElapsed / RECOVER_DURATION);
      targetBodyDrop = lerp(0.055, 8e-3, u);
      targetTorsoScaleY = lerp(0.992, 1.01, u);
      setPose("hips", lerp(-0.05, 0, u), lerp(0.14, 0, u), lerp(-0.03, 0, u));
      setPose("torso", lerp(-0.26, -0.07, u), lerp(0.22, 0, u), lerp(-0.07, 0, u));
      setPose("head", lerp(0.18, 0.04, u), lerp(-0.18, 0, u), 0);
      setPose("leftArm", lerp(-0.34, 0.14, u), -0.08, lerp(0.28, 0.16, u));
      setPose("elbowL", lerp(0.26, 0.36, u), 0, -0.06);
      setPose("handL", 0.12, 0, -0.06);
      setPose("rightArm", lerp(0.92, 0.18, u), lerp(-0.12, 0.06, u), lerp(-0.1, -0.18, u));
      setPose("elbowR", lerp(0.24, 0.42, u), 0, 0.08);
      setPose("handR", lerp(0.28, 0.16, u), 0, 0.08);
      setPose("thighL", lerp(0.3, 0.08, u), 0.08, 0.06);
      setPose("shinL", lerp(-0.4, -0.12, u), 0, 0);
      setPose("footL", lerp(0.12, 0.04, u), 0, -0.05);
      setPose("thighR", lerp(-0.2, -0.04, u), -0.08, -0.06);
      setPose("shinR", lerp(-0.2, -0.08, u), 0, 0);
      setPose("footR", lerp(0.36, 0.12, u), 0, 0.05);
      slerpRate = 5.5;
    } else if (state.anim === "charge") {
      const fwdPitch = -25 * DEG2RAD;
      const runW = animElapsed * 6.4 + 0.5;
      const s = Math.sin(runW);
      const c = Math.cos(runW);
      const stomp = Math.pow(Math.max(0, -Math.cos(runW * 2)), 2);
      coreWarnMult = 1.25;
      targetBodyDrop = 0.045 * stomp + 0.03;
      targetTorsoScaleY = 1.015;
      setPose("hips", -0.08, -s * 0.14, s * 0.06);
      setPose("torso", fwdPitch - 0.04 * stomp, s * 0.12, -s * 0.07);
      setPose("head", -0.44, -s * 0.08, 0);
      setPose("leftArm", -0.82 - s * 0.16, -0.18, 0.36);
      setPose("elbowL", 0.34, 0, -0.1);
      setPose("handL", 0.22, 0, -0.08);
      setPose("rightArm", -0.88 + s * 0.16, 0.18, -0.38);
      setPose("elbowR", 0.38, 0, 0.1);
      setPose("handR", 0.24, 0, 0.08);
      setPose("thighL", s * 0.62 + 0.12, 0.06, 0.06);
      setPose("shinL", -Math.max(0.14, -c * 0.72 + 0.22), 0, 0);
      setPose("footL", -s * 0.26 + 0.12, 0, -0.05);
      setPose("thighR", -s * 0.62 + 0.12, -0.06, -0.06);
      setPose("shinR", -Math.max(0.14, c * 0.72 + 0.22), 0, 0);
      setPose("footR", s * 0.26 + 0.12, 0, 0.05);
      slerpRate = 16;
    }
    const qAlpha = step > 0 ? 1 - Math.exp(-slerpRate * step) : 1;
    for (let i = 0; i < jointKeys.length; i++) {
      const key = jointKeys[i];
      const [rx, ry, rz] = targetPose[key];
      tmpEuler.set(rx, ry, rz, "XYZ");
      tmpQuat.setFromEuler(tmpEuler);
      jointNodes[key].quaternion.slerp(tmpQuat, qAlpha);
    }
    const scalarAlpha = step > 0 ? 1 - Math.exp(-14 * step) : 1;
    bodyDropCur += (targetBodyDrop - bodyDropCur) * scalarAlpha;
    body.position.y = BASE_HIP_Y - bodyDropCur;
    torsoScaleYCur += (targetTorsoScaleY - torsoScaleYCur) * scalarAlpha;
    torso.scale.set(1, torsoScaleYCur, 1);
    const pulseFreq = 3 + (1 - hpPct) * 2.2 + phaseBlend * 1.6;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * pulseFreq);
    const phaseBaseEmissive = isPhase2 ? 2.45 + 0.95 * phaseBlend : 1.68 + 0.55 * phaseBlend;
    const pulseAmp = isPhase2 ? 0.26 : 0.16;
    coreMat.emissiveIntensity = (phaseBaseEmissive + pulse * pulseAmp) * coreWarnMult;
    coreMat.emissive.copy(CORE_COLOR_P1).lerp(CORE_COLOR_P2, phaseBlend);
    const targetCoreScale = (isPhase2 ? 1.14 + 0.1 * phaseBlend : 1) + pulse * (isPhase2 ? 0.055 : 0.03);
    coreScaleCur += (targetCoreScale - coreScaleCur) * scalarAlpha;
    core.scale.setScalar(coreScaleCur);
    tmpColor.copy(SKIN_COLOR_P1).lerp(SKIN_COLOR_P2, phaseBlend);
    skinMat.color.copy(tmpColor);
    skinMat.emissiveIntensity = phaseBlend * (0.72 + 0.32 * pulse);
    eyeMat.emissiveIntensity = (2.4 + phaseBlend * 1.5 + pulse * 0.28) * (coreWarnMult > 1.2 ? 1.18 : 1);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    const geoSet = new Set(ownedGeometries);
    const matSet = new Set(ownedMaterials);
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        if (obj.geometry) geoSet.add(obj.geometry);
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) matSet.add(m);
        } else if (obj.material) {
          matSet.add(obj.material);
        }
      }
    });
    for (const g of geoSet) g.dispose();
    for (const m of matSet) m.dispose();
    for (const t of textures.all) t.dispose();
  };
  return {
    parts: {
      root,
      torso,
      head,
      core,
      leftArm: armL.shoulder,
      rightArm: armR.shoulder
    },
    update,
    dispose
  };
}

// src/render/bossModel.test.ts
function countSceneTriangles(root) {
  let total = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE2.Mesh)) return;
    const geo = obj.geometry;
    if (!geo) return;
    const idx = geo.getIndex();
    if (idx) {
      total += Math.round(idx.count / 3);
    } else {
      const pos = geo.getAttribute("position");
      if (pos) total += Math.round(pos.count / 3);
    }
  });
  return total;
}
function isUnderRoot(root, node) {
  let cur = node;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}
function getCoreMaterial(core) {
  if (core instanceof THREE2.Mesh && core.material instanceof THREE2.MeshStandardMaterial) {
    return core.material;
  }
  let found = null;
  core.traverse((obj) => {
    if (!found && obj instanceof THREE2.Mesh && obj.material instanceof THREE2.MeshStandardMaterial) {
      found = obj.material;
    }
  });
  assert.ok(found, "expected core to have a MeshStandardMaterial");
  return found;
}
test("bossModel: triangle budget <= 20000, height in 3.5-4.5m, organic PBR skin bounds", () => {
  const boss = createBossModel();
  try {
    const tris = countSceneTriangles(boss.parts.root);
    assert.ok(tris > 2e3 && tris <= 2e4, `expected tris in (2000, 20000], got ${tris}`);
    boss.parts.root.updateMatrixWorld(true);
    const box = new THREE2.Box3().setFromObject(boss.parts.root);
    const height = box.max.y - box.min.y;
    assert.ok(
      height >= 3.5 && height <= 4.5,
      `expected standing boss height in [3.5, 4.5]m, got ${height.toFixed(3)}m (minY=${box.min.y.toFixed(3)}, maxY=${box.max.y.toFixed(3)})`
    );
    assert.ok(
      Math.abs(box.min.y) <= 0.12,
      `expected feet grounded near y=0, got minY=${box.min.y.toFixed(3)}`
    );
    const torsoSkin = boss.parts.root.getObjectByName("boss-torso-skin");
    assert.ok(torsoSkin, "expected boss-torso-skin mesh");
    const skinMat = torsoSkin.material;
    assert.ok(
      skinMat.roughness >= 0.75 && skinMat.roughness <= 0.9,
      `expected skin roughness in [0.75, 0.9], got ${skinMat.roughness}`
    );
    assert.ok(
      Math.abs(skinMat.metalness - 0.05) < 1e-6,
      `expected skin metalness 0.05, got ${skinMat.metalness}`
    );
    assert.equal(skinMat.color.getHex(), new THREE2.Color("#3A3F38").getHex());
    assert.ok(skinMat.map && skinMat.normalMap && skinMat.roughnessMap, "expected procedural skin textures");
  } finally {
    boss.dispose();
  }
});
test("bossModel: all 6 parts exist and belong to root skeleton hierarchy", () => {
  const boss = createBossModel();
  try {
    const { root, torso, head, core, leftArm, rightArm } = boss.parts;
    const partEntries = [
      ["root", root],
      ["torso", torso],
      ["head", head],
      ["core", core],
      ["leftArm", leftArm],
      ["rightArm", rightArm]
    ];
    assert.equal(partEntries.length, 6);
    assert.ok(root instanceof THREE2.Group, "root must be a THREE.Group");
    for (const [name, obj] of partEntries) {
      assert.ok(obj instanceof THREE2.Object3D, `part "${name}" must exist as THREE.Object3D`);
      assert.ok(isUnderRoot(root, obj), `part "${name}" must be attached under root`);
      if (name !== "root") {
        assert.notEqual(obj.parent, null, `part "${name}" must have a parent inside root`);
      }
    }
    for (const boneName of [
      "boss-body",
      "boss-torso",
      "boss-head",
      "boss-core",
      "boss-shoulder-l",
      "boss-elbow-l",
      "boss-hand-l",
      "boss-shoulder-r",
      "boss-elbow-r",
      "boss-hand-r",
      "boss-hips",
      "boss-thigh-l",
      "boss-shin-l",
      "boss-foot-l",
      "boss-thigh-r",
      "boss-shin-r",
      "boss-foot-r"
    ]) {
      const bone = root.getObjectByName(boneName);
      assert.ok(bone, `expected skeleton bone "${boneName}"`);
      assert.ok(isUnderRoot(root, bone), `bone "${boneName}" must be under root`);
    }
  } finally {
    boss.dispose();
  }
});
test("bossModel: update() animates rightArm.rotation.x across all 6 anim states with expected kinematics", () => {
  const anims = ["idle", "walk", "windup", "attack", "recover", "charge"];
  for (const anim of anims) {
    const boss2 = createBossModel();
    try {
      const initialRotX = boss2.parts.rightArm.rotation.x;
      const steps = anim === "attack" ? 9 : 16;
      const dt = anim === "attack" ? 0.02 : 0.04;
      for (let i = 0; i < steps; i++) {
        boss2.update(dt, { hpPct: 1, phase: 1, anim });
      }
      const afterRotX = boss2.parts.rightArm.rotation.x;
      const delta = Math.abs(afterRotX - initialRotX);
      assert.ok(
        delta > 0.05,
        `anim "${anim}" must change rightArm.rotation.x (init=${initialRotX.toFixed(3)}, after=${afterRotX.toFixed(3)})`
      );
      assert.equal(boss2.parts.root.position.x, 0);
      assert.equal(boss2.parts.root.position.y, 0);
      assert.equal(boss2.parts.root.position.z, 0);
    } finally {
      boss2.dispose();
    }
  }
  const boss = createBossModel();
  try {
    const torso = boss.parts.torso;
    const coreMat = getCoreMaterial(boss.parts.core);
    for (let i = 0; i < 20; i++) boss.update(0.05, { hpPct: 1, phase: 1, anim: "idle" });
    const idleCoreEmissive = coreMat.emissiveIntensity;
    assert.ok(
      torso.scale.y >= 0.999 && torso.scale.y <= 1.022,
      `idle torso breathing scaleY out of range: ${torso.scale.y}`
    );
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "windup" });
    const windupArmX = boss.parts.rightArm.rotation.x;
    assert.ok(windupArmX < -0.95, `windup rightArm should raise backward (~-1.2rad), got ${windupArmX.toFixed(3)}`);
    assert.ok(torso.rotation.x > 0.2, `windup torso should lean backward (+15\xB0), got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(
      coreMat.emissiveIntensity > idleCoreEmissive * 1.2,
      `windup core should surge (~+40%), idle=${idleCoreEmissive.toFixed(2)}, windup=${coreMat.emissiveIntensity.toFixed(2)}`
    );
    for (let i = 0; i < 9; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
    const attackArmX = boss.parts.rightArm.rotation.x;
    assert.ok(
      attackArmX > 0.85,
      `attack rightArm should smash forward/down within 0.18s, got ${attackArmX.toFixed(3)}`
    );
    assert.ok(torso.rotation.x < -0.18, `attack torso should pitch forward, got ${torso.rotation.x.toFixed(3)}`);
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "charge" });
    assert.ok(torso.rotation.x < -0.35, `charge torso should pitch forward ~25\xB0, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.head.rotation.x < -0.3, `charge head should drop low, got ${boss.parts.head.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.leftArm.rotation.x < -0.5, `charge leftArm should sweep back, got ${boss.parts.leftArm.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.rightArm.rotation.x < -0.5, `charge rightArm should sweep back, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
  } finally {
    boss.dispose();
  }
});
test("bossModel: phase 2 increases core emissiveIntensity, enlarges core exposure, and dark-reddens skin", () => {
  const boss = createBossModel();
  try {
    const coreMat = getCoreMaterial(boss.parts.core);
    const torsoSkin = boss.parts.root.getObjectByName("boss-torso-skin");
    const skinMat = torsoSkin.material;
    for (let i = 0; i < 12; i++) boss.update(0.05, { hpPct: 0.8, phase: 1, anim: "idle" });
    const p1Emissive = coreMat.emissiveIntensity;
    const p1Scale = boss.parts.core.scale.x;
    const p1Red = skinMat.color.r;
    for (let i = 0; i < 12; i++) boss.update(0.05, { hpPct: 0.35, phase: 2, anim: "idle" });
    const p2Emissive = coreMat.emissiveIntensity;
    const p2Scale = boss.parts.core.scale.x;
    const p2Red = skinMat.color.r;
    assert.ok(
      p2Emissive > p1Emissive,
      `expected phase 2 core emissiveIntensity (${p2Emissive.toFixed(2)}) > phase 1 (${p1Emissive.toFixed(2)})`
    );
    assert.ok(
      p2Scale > p1Scale + 0.08,
      `expected phase 2 core to enlarge (p1=${p1Scale.toFixed(3)}, p2=${p2Scale.toFixed(3)})`
    );
    assert.ok(
      p2Red > p1Red,
      `expected phase 2 skin to shift toward dark crimson (p1R=${p1Red.toFixed(3)}, p2R=${p2Red.toFixed(3)})`
    );
  } finally {
    boss.dispose();
  }
});
test("bossModel: dispose() detaches root from parent and disposes all geometries and materials", () => {
  const scene = new THREE2.Scene();
  const boss = createBossModel();
  scene.add(boss.parts.root);
  assert.equal(boss.parts.root.parent, scene);
  const geos = /* @__PURE__ */ new Set();
  const mats = /* @__PURE__ */ new Set();
  boss.parts.root.traverse((obj) => {
    if (obj instanceof THREE2.Mesh) {
      geos.add(obj.geometry);
      if (Array.isArray(obj.material)) {
        for (const m of obj.material) mats.add(m);
      } else {
        mats.add(obj.material);
      }
    }
  });
  assert.ok(geos.size > 0, "expected geometries to track");
  assert.ok(mats.size > 0, "expected materials to track");
  let geoDisposed = 0;
  let matDisposed = 0;
  for (const g of geos) {
    const orig = g.dispose.bind(g);
    g.dispose = () => {
      geoDisposed++;
      orig();
    };
  }
  for (const m of mats) {
    const orig = m.dispose.bind(m);
    m.dispose = () => {
      matDisposed++;
      orig();
    };
  }
  boss.dispose();
  assert.equal(boss.parts.root.parent, null, "root.parent must be null after dispose()");
  assert.equal(geoDisposed, geos.size, `expected all ${geos.size} geometries disposed, got ${geoDisposed}`);
  assert.equal(matDisposed, mats.size, `expected all ${mats.size} materials disposed, got ${matDisposed}`);
  boss.dispose();
  assert.equal(geoDisposed, geos.size);
  assert.equal(matDisposed, mats.size);
});
