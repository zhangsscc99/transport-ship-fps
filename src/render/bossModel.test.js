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
function hash2Tile(ix, iy, periodX, periodY, seed) {
  const wx = (ix % periodX + periodX) % periodX;
  const wy = (iy % periodY + periodY) % periodY;
  return hash3(wx, wy, 0, seed);
}
function noise2Tile(x, y, periodX, periodY, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2Tile(ix, iy, periodX, periodY, seed);
  const b = hash2Tile(ix + 1, iy, periodX, periodY, seed);
  const c = hash2Tile(ix, iy + 1, periodX, periodY, seed);
  const d = hash2Tile(ix + 1, iy + 1, periodX, periodY, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm2Tile(u, v, periodX, periodY, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = periodX;
  let py = periodY;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2Tile(u * px, v * py, px, py, seed + i * 23);
    norm += amp;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}
function voronoiEdgeTile(u, v, cellsX, cellsY, seed) {
  const gx = u * cellsX;
  const gy = v * cellsY;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let d1 = 1e9;
  let d2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cy = iy + dy;
      const wx = (cx % cellsX + cellsX) % cellsX;
      const wy = (cy % cellsY + cellsY) % cellsY;
      const jx = 0.12 + 0.76 * hash3(wx, wy, 1, seed);
      const jy = 0.12 + 0.76 * hash3(wx, wy, 2, seed + 17);
      const px = cx + jx - gx;
      const py = cy + jy - gy;
      const dist = Math.hypot(px, py);
      if (dist < d1) {
        d2 = d1;
        d1 = dist;
      } else if (dist < d2) {
        d2 = dist;
      }
    }
  }
  return d2 - d1;
}
var UV_BAND_LAVA_DENSE = [0.655, 0.975];
var UV_BAND_LAVA_FLOW = [0.375, 0.595];
var UV_BAND_CORE = [0.235, 0.325];
var UV_BAND_BONE = [0.025, 0.185];
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
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
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
  const wrapX = (i) => (i % size + size) % size;
  const clampY = (i) => clamp(i, 0, size - 1);
  for (let y = 0; y < size; y++) {
    const ym = clampY(y - 1);
    const yp = clampY(y + 1);
    for (let x = 0; x < size; x++) {
      const xm = wrapX(x - 1);
      const xp = wrapX(x + 1);
      const tl = height[ym * size + xm];
      const t = height[ym * size + x];
      const tr = height[ym * size + xp];
      const l = height[y * size + xm];
      const r = height[y * size + xp];
      const bl = height[yp * size + xm];
      const b = height[yp * size + x];
      const br = height[yp * size + xp];
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
function createTerminatorAtlas() {
  if (typeof document === "undefined") {
    const albedoMap2 = makeFallbackTex(68, 22, 18, true);
    const emissiveMap2 = makeFallbackTex(190, 64, 16, true);
    const normalMap2 = makeFallbackTex(128, 128, 255, false);
    return { albedoMap: albedoMap2, emissiveMap: emissiveMap2, normalMap: normalMap2, all: [albedoMap2, emissiveMap2, normalMap2] };
  }
  const S = 512;
  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = albedoCanvas.height = S;
  const albedoCtx = albedoCanvas.getContext("2d");
  const albedoImg = albedoCtx.createImageData(S, S);
  const ad = albedoImg.data;
  const emCanvas = document.createElement("canvas");
  emCanvas.width = emCanvas.height = S;
  const emCtx = emCanvas.getContext("2d");
  const emImg = emCtx.createImageData(S, S);
  const ed = emImg.data;
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const v = 1 - (y + 0.5) / S;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const idx = y * S + x;
      const p4 = idx * 4;
      if (v >= 0.63) {
        const bv = clamp01((v - 0.63) / 0.37);
        const w1 = fbm2Tile(u, bv, 5, 3, 101, 3) - 0.5;
        const w2 = fbm2Tile(u, bv, 5, 3, 137, 3) - 0.5;
        const warpU = u + w1 * 0.16;
        const warpV = bv + w2 * 0.17;
        const river1 = 1 - Math.abs(fbm2Tile(warpU, warpV, 7, 4, 211, 4) * 2 - 1);
        const river2 = 1 - Math.abs(fbm2Tile(warpU + 0.31, warpV + 0.19, 13, 7, 307, 3) * 2 - 1);
        const cellEdge = voronoiEdgeTile(warpU, warpV, 7, 4, 401);
        const clusterMask = smoothstep((fbm2Tile(u, bv, 4, 2, 463, 3) - 0.32) * 2.1);
        const cRiver = Math.pow(clamp01((river1 - 0.76) / 0.24), 1.75) * (0.62 + 0.38 * clusterMask);
        const cBranch = Math.pow(clamp01((river2 - 0.82) / 0.18), 2) * 0.72;
        const cFissure = smoothstep((0.078 - cellEdge) / 0.072) * (0.45 + 0.55 * clusterMask);
        const crack = clamp01(Math.max(cRiver, cBranch, cFissure));
        const hotCore = clamp01(
          Math.pow(clamp01((river1 - 0.9) / 0.1), 1.5) + smoothstep((0.032 - cellEdge) / 0.03) * 0.48 * clusterMask
        );
        const crustMacro = fbm2Tile(u, bv, 10, 6, 509, 3);
        const muscleFibers = 0.5 + 0.5 * Math.sin((u * 18 + w1 * 5) * Math.PI * 2);
        height[idx] = (1 - crack) * (0.6 + crustMacro * 0.28 + muscleFibers * 0.12) + crack * 0.12;
        const crustR = 24 + crustMacro * 22 + muscleFibers * 9;
        const crustG = 7 + crustMacro * 6 + muscleFibers * 3;
        const crustB = 7 + crustMacro * 5 + muscleFibers * 3;
        const r = lerp(crustR, lerp(148, 188, hotCore), crack);
        const g = lerp(crustG, lerp(26, 80, hotCore), crack);
        const b = lerp(crustB, lerp(6, 18, hotCore), crack);
        ad[p4] = Math.round(clamp(r, 12, 220));
        ad[p4 + 1] = Math.round(clamp(g, 5, 180));
        ad[p4 + 2] = Math.round(clamp(b, 5, 120));
        ad[p4 + 3] = 255;
        const emMask = Math.pow(crack, 1.55);
        ed[p4] = Math.round(clamp01(emMask * 1.02) * 255);
        ed[p4 + 1] = Math.round(clamp01(emMask * 0.26 + hotCore * 0.44) * 255);
        ed[p4 + 2] = Math.round(clamp01(emMask * 0.03 + hotCore * 0.14) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.35) {
        const bv = clamp01((v - 0.35) / 0.28);
        const w1 = fbm2Tile(u, bv, 4, 2, 701, 3) - 0.5;
        const w2 = fbm2Tile(u, bv, 4, 2, 733, 3) - 0.5;
        const warpU = u + w1 * 0.12;
        const warpV = bv + w2 * 0.1;
        const sinew1 = 1 - Math.abs(fbm2Tile(warpU, warpV, 9, 2, 811, 3) * 2 - 1);
        const sinew2 = voronoiEdgeTile(warpU, warpV, 9, 2, 853);
        const crack1 = Math.pow(clamp01((sinew1 - 0.8) / 0.2), 1.85);
        const crack2 = smoothstep((0.068 - sinew2) / 0.062) * 0.65;
        const crack = clamp01(Math.max(crack1, crack2));
        const hotCore = Math.pow(clamp01((sinew1 - 0.91) / 0.09), 1.5);
        const crust = fbm2Tile(u, bv, 14, 4, 907, 3);
        height[idx] = (1 - crack) * (0.64 + crust * 0.3) + crack * 0.14;
        const crustR = 22 + crust * 20;
        const crustG = 6 + crust * 6;
        const crustB = 6 + crust * 5;
        ad[p4] = Math.round(clamp(lerp(crustR, lerp(142, 182, hotCore), crack), 10, 215));
        ad[p4 + 1] = Math.round(clamp(lerp(crustG, lerp(22, 74, hotCore), crack), 5, 175));
        ad[p4 + 2] = Math.round(clamp(lerp(crustB, lerp(5, 16, hotCore), crack), 5, 115));
        ad[p4 + 3] = 255;
        const emMask = Math.pow(crack, 1.6) * 0.85;
        ed[p4] = Math.round(clamp01(emMask * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(emMask * 0.24 + hotCore * 0.38) * 255);
        ed[p4 + 2] = Math.round(clamp01(emMask * 0.03 + hotCore * 0.12) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.21) {
        const bv = clamp01((v - 0.21) / 0.14);
        const w1 = fbm2Tile(u, bv, 5, 3, 941, 3) - 0.5;
        const w2 = fbm2Tile(u, bv, 5, 3, 953, 3) - 0.5;
        const wu = u + w1 * 0.14;
        const wv = bv + w2 * 0.14;
        const edge = voronoiEdgeTile(wu, wv, 8, 4, 967);
        const ridge = 1 - Math.abs(fbm2Tile(wu, wv, 10, 5, 977, 3) * 2 - 1);
        const magma = clamp01(Math.max(smoothstep((0.22 - edge) / 0.17), Math.pow(clamp01((ridge - 0.58) / 0.42), 1.45)));
        const superHot = clamp01(smoothstep((0.1 - edge) / 0.085) + Math.pow(clamp01((ridge - 0.82) / 0.18), 1.5) * 0.55);
        height[idx] = (1 - magma) * 0.78 + magma * 0.16;
        ad[p4] = Math.round(lerp(24, lerp(168, 206, superHot), magma));
        ad[p4 + 1] = Math.round(lerp(6, lerp(34, 96, superHot), magma));
        ad[p4 + 2] = Math.round(lerp(5, lerp(6, 18, superHot), magma));
        ad[p4 + 3] = 255;
        ed[p4] = Math.round(clamp01(0.12 + magma * 0.84) * 255);
        ed[p4 + 1] = Math.round(clamp01(0.03 + magma * 0.28 + superHot * 0.42) * 255);
        ed[p4 + 2] = Math.round(clamp01(magma * 0.03 + superHot * 0.14) * 255);
        ed[p4 + 3] = 255;
      } else {
        const bv = clamp01(v / 0.21);
        const grain = fbm2Tile(u, bv, 8, 12, 1013, 3);
        const flutes = 0.5 + 0.5 * Math.sin((bv * 14 + grain * 1.8) * Math.PI * 2);
        const growthRings = 0.5 + 0.5 * Math.sin(u * Math.PI * 12 + grain * 2.5);
        const h = grain * 0.45 + flutes * 0.35 + growthRings * 0.2;
        height[idx] = h;
        const rootBlend = smoothstep((u - 0.02) / 0.22);
        const shade = lerp(0.68, 0.98, rootBlend) * (0.82 + h * 0.2);
        ad[p4] = Math.round(clamp(198 * shade, 88, 204));
        ad[p4 + 1] = Math.round(clamp(178 * shade, 76, 184));
        ad[p4 + 2] = Math.round(clamp(144 * shade, 58, 150));
        ad[p4 + 3] = 255;
        const tipGlow = Math.pow(smoothstep((u - 0.58) / 0.4), 1.45) * (0.8 + 0.2 * flutes);
        ed[p4] = Math.round(clamp01(tipGlow * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(tipGlow * 0.44) * 255);
        ed[p4 + 2] = Math.round(clamp01(tipGlow * 0.1) * 255);
        ed[p4 + 3] = 255;
      }
    }
  }
  albedoCtx.putImageData(albedoImg, 0, 0);
  emCtx.putImageData(emImg, 0, 0);
  const normalCanvas = buildNormalCanvasFromHeight(height, S, 4.2);
  const wrapTex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const albedoMap = wrapTex(albedoCanvas, true);
  const emissiveMap = wrapTex(emCanvas, true);
  const normalMap = wrapTex(normalCanvas, false);
  return { albedoMap, emissiveMap, normalMap, all: [albedoMap, emissiveMap, normalMap] };
}
function remapUvBand(geo, band, uScale = 1, uOffset = 0) {
  const uv = geo.getAttribute("uv");
  if (!uv) return;
  const [vMin, vMax] = band;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) * uScale + uOffset;
    const v = clamp01(uv.getY(i));
    uv.setXY(i, u, lerp(vMin, vMax, v));
  }
  uv.needsUpdate = true;
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
      uvs[i * 2 + 1] = lerp(UV_BAND_LAVA_DENSE[0], UV_BAND_LAVA_DENSE[1], 0.5);
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
  const segW = opts.segW ?? 12;
  const segH = opts.segH ?? 8;
  const geo = new THREE.SphereGeometry(1, segW, segH);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const [sx, sy, sz] = opts.scale;
  const noiseAmp = opts.noiseAmp ?? 0.08;
  const noiseFreq = opts.noiseFreq ?? 2.3;
  const ridgeAmp = opts.ridgeAmp ?? 0.04;
  const seed = opts.seed ?? 17;
  const topTaper = opts.topTaper ?? 1;
  const botTaper = opts.botTaper ?? 1;
  const bendZ = opts.bendZ ?? 0;
  const bendX = opts.bendX ?? 0;
  const tint = opts.tint ?? [1, 1, 1];
  const aoBottom = opts.aoBottom ?? 0.18;
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
    const creviceAO = clamp(0.88 + f * 0.26 + r * 0.22, 0.58, 1.16);
    colors[i * 3] = clamp(tint[0] * heightLight * creviceAO, 0.28, 1.35);
    colors[i * 3 + 1] = clamp(tint[1] * heightLight * creviceAO, 0.28, 1.35);
    colors[i * 3 + 2] = clamp(tint[2] * heightLight * creviceAO, 0.28, 1.35);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  remapUvBand(geo, opts.uvBand ?? UV_BAND_LAVA_DENSE, opts.uScale ?? 1, opts.uOffset ?? 0);
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
function sculptMuscleLimb(opts) {
  const rSeg = opts.radialSegs ?? 12;
  const hSeg = opts.heightSegs ?? 8;
  const geo = new THREE.CylinderGeometry(1, 1, opts.length, rSeg, hSeg, false);
  geo.translate(0, -opts.length * 0.5, 0);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const midPos = opts.midPos ?? 0.45;
  const striations = opts.striations ?? 4;
  const striationAmp = opts.striationAmp ?? 0.08;
  const noiseAmp = opts.noiseAmp ?? 0.075;
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
    const endCap = t < 0.05 ? lerp(0.9, 1, t / 0.05) : t > 0.95 ? lerp(1, 0.88, (t - 0.95) / 0.05) : 1;
    const bundle = Math.sin(ang * striations + t * 1.3 + seed * 0.2) * striationAmp * Math.sin(t * Math.PI);
    const nx = Math.cos(ang);
    const nz = Math.sin(ang);
    const f = fbm3(nx * 2.2, t * 3.4, nz * 2.2, seed, 3) - 0.5;
    const radScale = baseR * endCap * (1 + bundle + f * noiseAmp * 2);
    const px = vx * radScale + bendX * Math.sin(t * Math.PI) + bendX * 0.25 * t;
    const py = vy;
    const pz = vz * radScale * scaleZ + bendZ * Math.sin(t * Math.PI) + bendZ * 0.25 * t;
    pos.setXYZ(i, px, py, pz);
    const jointAO = 0.84 + 0.22 * Math.sin(t * Math.PI * 0.86 + 0.22);
    const grooveAO = clamp(0.9 + bundle * 1.1 + f * 0.25 + (radial < 0.2 ? -0.1 : 0), 0.58, 1.15);
    const shade = jointAO * grooveAO;
    colors[i * 3] = clamp(tint[0] * shade, 0.3, 1.3);
    colors[i * 3 + 1] = clamp(tint[1] * shade, 0.3, 1.3);
    colors[i * 3 + 2] = clamp(tint[2] * shade, 0.3, 1.3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  remapUvBand(geo, opts.uvBand ?? UV_BAND_LAVA_DENSE, opts.uScale ?? 1);
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    geo.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
function sculptBoneSpike(opts) {
  const rSeg = opts.radialSegs ?? 7;
  const hSeg = opts.heightSegs ?? 5;
  const tipR = opts.tipR ?? 8e-3;
  const geo = new THREE.CylinderGeometry(tipR, opts.baseR, opts.length, rSeg, hSeg, false);
  geo.translate(0, opts.length * 0.5, 0);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const colors = new Float32Array(pos.count * 3);
  const bendZ = opts.bendZ ?? 0.14;
  const bendX = opts.bendX ?? 0;
  const flattenX = opts.flattenX ?? 0.7;
  const baseCol = opts.baseColor ?? [0.8, 0.62, 0.5];
  const tipCol = opts.tipColor ?? [1.22, 1.16, 1];
  const tipGlow = opts.tipGlow ?? true;
  const seed = opts.seed ?? 73;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const t = clamp01(vy / opts.length);
    const ring = 1 + Math.sin(t * Math.PI * 5 + seed) * 0.05 * (1 - t);
    const jitter = 1 + (noise3(vx * 6, vy * 5, vz * 6, seed) - 0.5) * 0.1;
    const curve = t * t;
    const px = vx * flattenX * ring * jitter + bendX * curve;
    const py = vy;
    const pz = vz * ring * jitter + bendZ * curve;
    pos.setXYZ(i, px, py, pz);
    const uMapped = tipGlow ? t : lerp(0.08, 0.48, t);
    const vMapped = lerp(UV_BAND_BONE[0], UV_BAND_BONE[1], clamp01(uv.getX(i)));
    uv.setXY(i, uMapped, vMapped);
    const k = smoothstep(t);
    colors[i * 3] = clamp(lerp(baseCol[0], tipCol[0], k) * 0.78, 0.22, 0.96);
    colors[i * 3 + 1] = clamp(lerp(baseCol[1], tipCol[1], k) * 0.78, 0.2, 0.94);
    colors[i * 3 + 2] = clamp(lerp(baseCol[2], tipCol[2], k) * 0.78, 0.16, 0.88);
  }
  uv.needsUpdate = true;
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
function sculptCurvedBoneBlade(opts) {
  const tubularSegs = opts.tubularSegs ?? 12;
  const radialSegs = opts.radialSegs ?? 7;
  const midPos = opts.midPos ?? 0.36;
  const aspect = opts.bladeAspect ?? 1.4;
  const tipGlow = opts.tipGlow ?? true;
  const baseCol = opts.baseColor ?? [0.78, 0.56, 0.44];
  const tipCol = opts.tipColor ?? [1.24, 1.18, 1];
  const seed = opts.seed ?? 97;
  const curve = new THREE.CatmullRomCurve3(opts.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const tangents = [];
  const normals = [];
  const binormals = [];
  for (let s = 0; s <= tubularSegs; s++) {
    tangents.push(curve.getTangentAt(s / tubularSegs).normalize());
  }
  const refAxis = Math.abs(tangents[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const n0 = new THREE.Vector3().crossVectors(refAxis, tangents[0]).normalize();
  const b0 = new THREE.Vector3().crossVectors(tangents[0], n0).normalize();
  normals.push(n0);
  binormals.push(b0);
  const rotAxis = new THREE.Vector3();
  const rotQ = new THREE.Quaternion();
  for (let s = 1; s <= tubularSegs; s++) {
    const prevT = tangents[s - 1];
    const curT = tangents[s];
    const prevN = normals[s - 1];
    const dot = clamp(prevT.dot(curT), -1, 1);
    const nextN = prevN.clone();
    if (dot < 0.999999) {
      rotAxis.crossVectors(prevT, curT);
      if (rotAxis.lengthSq() > 1e-10) {
        rotAxis.normalize();
        rotQ.setFromAxisAngle(rotAxis, Math.acos(dot));
        nextN.applyQuaternion(rotQ);
      }
    }
    nextN.addScaledVector(curT, -nextN.dot(curT)).normalize();
    const nextB = new THREE.Vector3().crossVectors(curT, nextN).normalize();
    normals.push(nextN);
    binormals.push(nextB);
  }
  const ringVerts = radialSegs + 1;
  const vertCount = (tubularSegs + 1) * ringVerts + 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);
  const indices = [];
  const pt = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  for (let s = 0; s <= tubularSegs; s++) {
    const t = s / tubularSegs;
    curve.getPointAt(t, pt);
    N.copy(normals[s]);
    B.copy(binormals[s]);
    let rBase;
    if (t <= midPos) {
      rBase = lerp(opts.radiusStart, opts.radiusMid, smoothstep(t / Math.max(0.01, midPos)));
    } else {
      rBase = lerp(opts.radiusMid, opts.radiusEnd, smoothstep((t - midPos) / Math.max(0.01, 1 - midPos)));
    }
    const uMapped = tipGlow ? t : lerp(0.08, 0.48, t);
    const colK = smoothstep(t);
    const cr = clamp(lerp(baseCol[0], tipCol[0], colK) * 0.78, 0.22, 0.96);
    const cg = clamp(lerp(baseCol[1], tipCol[1], colK) * 0.78, 0.2, 0.94);
    const cb = clamp(lerp(baseCol[2], tipCol[2], colK) * 0.78, 0.16, 0.88);
    for (let r = 0; r < ringVerts; r++) {
      const frac = r / radialSegs;
      const theta = frac * Math.PI * 2;
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      const ridgeSharp = 1 + 0.14 * Math.pow(Math.abs(cs), 3);
      const jitter = 1 + (noise3(pt.x * 4 + cs, pt.y * 4 + sn, pt.z * 4, seed) - 0.5) * 0.08;
      const rx = cs * rBase * aspect * ridgeSharp * jitter;
      const ry = sn * rBase * (1 / Math.sqrt(aspect)) * jitter;
      const idx = s * ringVerts + r;
      positions[idx * 3] = pt.x + N.x * rx + B.x * ry;
      positions[idx * 3 + 1] = pt.y + N.y * rx + B.y * ry;
      positions[idx * 3 + 2] = pt.z + N.z * rx + B.z * ry;
      uvs[idx * 2] = uMapped;
      uvs[idx * 2 + 1] = lerp(UV_BAND_BONE[0], UV_BAND_BONE[1], frac);
      colors[idx * 3] = cr;
      colors[idx * 3 + 1] = cg;
      colors[idx * 3 + 2] = cb;
    }
  }
  for (let s = 0; s < tubularSegs; s++) {
    for (let r = 0; r < radialSegs; r++) {
      const a = s * ringVerts + r;
      const b = (s + 1) * ringVerts + r;
      const c = (s + 1) * ringVerts + r + 1;
      const d = s * ringVerts + r + 1;
      indices.push(a, d, b, b, d, c);
    }
  }
  const startCapIdx = (tubularSegs + 1) * ringVerts;
  const endCapIdx = startCapIdx + 1;
  const pStart = curve.getPointAt(0);
  const pEnd = curve.getPointAt(1);
  positions[startCapIdx * 3] = pStart.x;
  positions[startCapIdx * 3 + 1] = pStart.y;
  positions[startCapIdx * 3 + 2] = pStart.z;
  uvs[startCapIdx * 2] = tipGlow ? 0 : 0.08;
  uvs[startCapIdx * 2 + 1] = (UV_BAND_BONE[0] + UV_BAND_BONE[1]) * 0.5;
  colors[startCapIdx * 3] = clamp(baseCol[0] * 0.78, 0.22, 0.96);
  colors[startCapIdx * 3 + 1] = clamp(baseCol[1] * 0.78, 0.2, 0.94);
  colors[startCapIdx * 3 + 2] = clamp(baseCol[2] * 0.78, 0.16, 0.88);
  positions[endCapIdx * 3] = pEnd.x;
  positions[endCapIdx * 3 + 1] = pEnd.y;
  positions[endCapIdx * 3 + 2] = pEnd.z;
  uvs[endCapIdx * 2] = tipGlow ? 1 : 0.48;
  uvs[endCapIdx * 2 + 1] = (UV_BAND_BONE[0] + UV_BAND_BONE[1]) * 0.5;
  colors[endCapIdx * 3] = clamp(tipCol[0] * 0.78, 0.22, 0.96);
  colors[endCapIdx * 3 + 1] = clamp(tipCol[1] * 0.78, 0.2, 0.94);
  colors[endCapIdx * 3 + 2] = clamp(tipCol[2] * 0.78, 0.16, 0.88);
  for (let r = 0; r < radialSegs; r++) {
    indices.push(startCapIdx, r, r + 1);
    const lastRing = tubularSegs * ringVerts;
    indices.push(endCapIdx, lastRing + r + 1, lastRing + r);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
function sculptTerminatorTrunk() {
  const geo = new THREE.SphereGeometry(1, 28, 22);
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
    let py = lerp(-0.04, 1.54, uY);
    const vFlare = smoothstep((uY - 0.16) / 0.54);
    const topClose = 1 - 0.38 * smoothstep((uY - 0.78) / 0.22);
    const halfWidth = lerp(0.34, 0.84, vFlare) * topClose;
    const halfDepth = lerp(0.26, 0.44, smoothstep((uY - 0.16) / 0.52));
    let px = nx * halfWidth;
    let pz = nz * halfDepth;
    pz += -0.14 * smoothstep((uY - 0.44) / 0.56) + 0.14 * smoothstep((uY - 0.54) / 0.46) * smoothstep((nz - 0.05) / 0.7);
    const frontMask = smoothstep((-nz - 0.05) / 0.65);
    const backMask = smoothstep((nz - 0.05) / 0.65);
    const absX = Math.abs(nx);
    const pec = gauss(uY - 0.68, 0.13) * smoothstep((absX - 0.14) / 0.26) * frontMask;
    const clavicle = gauss(uY - 0.83, 0.05) * smoothstep((absX - 0.1) / 0.28) * frontMask;
    pz -= pec * 0.11 + clavicle * 0.045;
    py += pec * 0.025;
    const lat = gauss(uY - 0.56, 0.17) * gauss(absX - 0.76, 0.24) * (0.35 + 0.65 * backMask);
    px += Math.sign(nx) * lat * 0.12;
    pz += lat * 0.06 * backMask;
    const trap = smoothstep((uY - 0.66) / 0.32) * (0.4 + 0.6 * backMask);
    py += trap * 0.1;
    pz += trap * 0.08 * backMask;
    const abBand = gauss(uY - 0.27, 0.16) * frontMask * (1 - smoothstep((absX - 0.45) / 0.3));
    pz -= Math.sin(uY * 34) * 0.02 * abBand;
    const chestCavDist = Math.hypot(px / 0.34, (py - 0.94) / 0.34);
    const chestCav = chestCavDist < 1 ? smoothstep(1 - chestCavDist) * frontMask : 0;
    pz += chestCav * 0.16;
    const backCavDist = Math.hypot(px / 0.24, (py - 1.02) / 0.34);
    const backCav = backCavDist < 1 ? smoothstep(1 - backCavDist) * backMask : 0;
    pz -= backCav * 0.12;
    const f = fbm3(px * 2.5, py * 2.5, pz * 2.5, 101, 3) - 0.5;
    const r = ridged3(px * 3.6, py * 3.6, pz * 3.6, 139, 2) - 0.45;
    const disp = f * 0.055 + r * 0.036;
    const outLen = Math.hypot(px, pz) || 1;
    px += px / outLen * disp;
    pz += pz / outLen * disp;
    pos.setXYZ(i, px, py, pz);
    const uOrig = uv.getX(i);
    const vMapped = clamp01(uY * 0.92 + 0.04);
    uv.setXY(i, uOrig * 1.8, lerp(UV_BAND_LAVA_DENSE[0], UV_BAND_LAVA_DENSE[1], vMapped));
    const heightShade = lerp(0.8, 1.12, uY);
    const microAO = clamp(0.88 + f * 0.26 + r * 0.22 - (chestCav + backCav) * 0.2, 0.58, 1.16);
    const heatBoost = clamp01(smoothstep(1.32 - chestCavDist) * frontMask * 0.52 + smoothstep(1.25 - backCavDist) * backMask * 0.42);
    colors[i * 3] = clamp(heightShade * microAO * (1 + heatBoost * 0.32), 0.3, 1.38);
    colors[i * 3 + 1] = clamp(heightShade * microAO * (1 - heatBoost * 0.08), 0.26, 1.24);
    colors[i * 3 + 2] = clamp(heightShade * microAO * (1 - heatBoost * 0.18), 0.24, 1.16);
  }
  uv.needsUpdate = true;
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}
function buildTorsoGeometries() {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(sculptTerminatorTrunk());
  skinParts.push(
    sculptMuscleLimb({
      length: 0.34,
      rTop: 0.16,
      rMid: 0.19,
      rBot: 0.25,
      radialSegs: 10,
      heightSegs: 4,
      striations: 3,
      pos: [0, 1.66, -0.22],
      rot: [-0.3, 0, 0],
      seed: 167,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  const ribDefs = [
    { yOuter: 1.24, yInner: 1.12, xBack: 0.56, xSide: 0.72, xInner: 0.14, zFront: -0.49, r: 0.036 },
    { yOuter: 1.09, yInner: 0.96, xBack: 0.54, xSide: 0.7, xInner: 0.13, zFront: -0.5, r: 0.038 },
    { yOuter: 0.94, yInner: 0.8, xBack: 0.5, xSide: 0.64, xInner: 0.13, zFront: -0.49, r: 0.036 },
    { yOuter: 0.79, yInner: 0.65, xBack: 0.44, xSide: 0.56, xInner: 0.15, zFront: -0.44, r: 0.033 },
    { yOuter: 0.64, yInner: 0.52, xBack: 0.36, xSide: 0.46, xInner: 0.17, zFront: -0.37, r: 0.029 }
  ];
  for (let i = 0; i < ribDefs.length; i++) {
    const rb = ribDefs[i];
    for (const side of [-1, 1]) {
      boneParts.push(
        sculptCurvedBoneBlade({
          points: [
            [side * rb.xBack, rb.yOuter + 0.04, 0.12],
            [side * rb.xSide, rb.yOuter + 0.01, -0.14],
            [side * (rb.xSide * 0.66), lerp(rb.yOuter, rb.yInner, 0.55), rb.zFront],
            [side * rb.xInner, rb.yInner, rb.zFront * 0.96]
          ],
          radiusStart: rb.r * 0.76,
          radiusMid: rb.r * 1.1,
          radiusEnd: rb.r * 0.5,
          midPos: 0.5,
          tubularSegs: 11,
          radialSegs: 7,
          bladeAspect: 1.32,
          tipGlow: false,
          // exposed bone ribs stay bright weathered yellowed-ivory
          baseColor: [0.96, 0.88, 0.74],
          tipColor: [1.26, 1.2, 1.02],
          seed: 301 + i * 11 + (side > 0 ? 3 : 0)
        })
      );
    }
  }
  for (const side of [-1, 1]) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.08, 1.28, -0.43],
          [side * 0.36, 1.38, -0.35],
          [side * 0.68, 1.4, -0.12]
        ],
        radiusStart: 0.028,
        radiusMid: 0.036,
        radiusEnd: 0.028,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.25,
        tipGlow: false,
        baseColor: [0.98, 0.9, 0.76],
        tipColor: [1.22, 1.14, 0.98],
        seed: side < 0 ? 331 : 337
      })
    );
  }
  for (const side of [-1, 1]) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.18, 1.38, 0.16],
          [side * 0.28, 1.8, 0.34],
          [side * 0.46, 2.05, 0.5],
          // peak ~4.05m world!
          [side * 0.7, 1.98, 0.56],
          [side * 0.9, 1.74, 0.5]
        ],
        radiusStart: 0.07,
        radiusMid: 0.054,
        radiusEnd: 8e-3,
        midPos: 0.36,
        tubularSegs: 14,
        radialSegs: 7,
        bladeAspect: 1.45,
        tipGlow: true,
        baseColor: [0.78, 0.52, 0.4],
        tipColor: [1.28, 1.22, 1.02],
        seed: side < 0 ? 361 : 367
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.38, 1.18, 0.24],
          [side * 0.74, 1.54, 0.68],
          [side * 1.12, 1.84, 0.74],
          [side * 1.38, 1.66, 0.56],
          [side * 1.5, 1.32, 0.36]
        ],
        radiusStart: 0.076,
        radiusMid: 0.062,
        radiusEnd: 9e-3,
        midPos: 0.38,
        tubularSegs: 14,
        radialSegs: 7,
        bladeAspect: 1.6,
        tipGlow: true,
        baseColor: [0.72, 0.44, 0.34],
        tipColor: [1.28, 1.22, 1.02],
        seed: side < 0 ? 373 : 379
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.28, 0.74, 0.28],
          [side * 0.56, 1.02, 0.76],
          [side * 0.84, 1.46, 0.84],
          [side * 1.04, 1.74, 0.74]
        ],
        radiusStart: 0.048,
        radiusMid: 0.04,
        radiusEnd: 0.016,
        midPos: 0.46,
        tubularSegs: 11,
        radialSegs: 6,
        bladeAspect: 1.42,
        tipGlow: true,
        baseColor: [0.74, 0.48, 0.36],
        tipColor: [1.22, 1.16, 0.98],
        seed: side < 0 ? 383 : 389
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.34, 0.94, 0.3],
          [side * 0.64, 1.14, 0.76],
          [side * 0.92, 1.06, 0.94],
          [side * 1.04, 0.84, 0.88]
        ],
        radiusStart: 0.052,
        radiusMid: 0.042,
        radiusEnd: 8e-3,
        midPos: 0.4,
        tubularSegs: 10,
        radialSegs: 6,
        bladeAspect: 1.52,
        tipGlow: true,
        baseColor: [0.74, 0.46, 0.36],
        tipColor: [1.26, 1.18, 1],
        seed: side < 0 ? 397 : 401
      })
    );
    boneParts.push(
      sculptBoneSpike({
        length: 0.42,
        baseR: 0.04,
        tipR: 7e-3,
        bendZ: 0.14,
        bendX: side * 0.08,
        flattenX: 0.56,
        radialSegs: 6,
        heightSegs: 4,
        pos: [side * 0.62, 1.44, 0.52],
        rot: [0.66, side * 0.22, -side * 0.48],
        seed: side < 0 ? 409 : 419
      })
    );
  }
  const spineSpikes = [
    { y: 1.42, z: 0.24, rx: 0.72, len: 0.48, r: 0.062 },
    { y: 1.16, z: 0.32, rx: 0.94, len: 0.52, r: 0.066 },
    { y: 0.88, z: 0.32, rx: 1.1, len: 0.46, r: 0.058 },
    { y: 0.62, z: 0.28, rx: 1.24, len: 0.38, r: 0.05 },
    { y: 0.36, z: 0.24, rx: 1.34, len: 0.32, r: 0.042 }
  ];
  for (let i = 0; i < spineSpikes.length; i++) {
    const sp = spineSpikes[i];
    boneParts.push(
      sculptBoneSpike({
        length: sp.len,
        baseR: sp.r,
        tipR: 8e-3,
        bendZ: 0.14,
        flattenX: 0.52,
        radialSegs: 6,
        heightSegs: 4,
        pos: [0, sp.y, sp.z],
        rot: [sp.rx, 0, 0],
        seed: 431 + i * 7
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildCoreGeometry() {
  const parts = [];
  parts.push(
    sculptOrganicBlob({
      scale: [0.19, 0.3, 0.11],
      pos: [0, 0, -0.37],
      segW: 14,
      segH: 10,
      noiseAmp: 0.12,
      ridgeAmp: 0.08,
      seed: 451,
      topTaper: 1.32,
      botTaper: 0.48,
      aoBottom: 0.04,
      uvBand: UV_BAND_CORE
    })
  );
  for (const side of [-1, 1]) {
    parts.push(
      sculptOrganicBlob({
        scale: [0.18, 0.08, 0.08],
        pos: [side * 0.2, 0.23, -0.37],
        rot: [0, 0, side * 0.34],
        segW: 9,
        segH: 6,
        noiseAmp: 0.12,
        seed: side < 0 ? 457 : 461,
        aoBottom: 0.03,
        uvBand: UV_BAND_CORE
      })
    );
  }
  parts.push(
    sculptOrganicBlob({
      scale: [0.13, 0.26, 0.09],
      pos: [0, 0.08, 0.33],
      segW: 12,
      segH: 8,
      noiseAmp: 0.12,
      ridgeAmp: 0.08,
      seed: 467,
      aoBottom: 0.04,
      uvBand: UV_BAND_CORE
    })
  );
  return mergeStrict(parts);
}
function buildHeadGeometries() {
  const skinParts = [];
  const boneParts = [];
  const eyeParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.18, 0.22, 0.24],
      pos: [0, 0.12, -0.06],
      rot: [0.08, 0, 0],
      segW: 14,
      segH: 10,
      noiseAmp: 0.07,
      ridgeAmp: 0.05,
      seed: 503,
      topTaper: 0.84,
      botTaper: 0.7,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.12, 0.11, 0.17],
      pos: [0, -0.06, -0.14],
      rot: [0.22, 0, 0],
      segW: 10,
      segH: 7,
      noiseAmp: 0.07,
      seed: 521,
      topTaper: 0.94,
      botTaper: 0.52,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [0, 0.17, -0.3],
        [0, 0.28, -0.16],
        [0, 0.33, 0.04],
        [0, 0.25, 0.24]
      ],
      radiusStart: 0.034,
      radiusMid: 0.048,
      radiusEnd: 0.016,
      midPos: 0.44,
      tubularSegs: 10,
      radialSegs: 7,
      bladeAspect: 1.55,
      tipGlow: true,
      baseColor: [0.92, 0.8, 0.66],
      tipColor: [1.28, 1.22, 1.02],
      seed: 541
    })
  );
  for (const side of [-1, 1]) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.02, 0.16, -0.28],
          [side * 0.13, 0.21, -0.22],
          [side * 0.19, 0.24, -0.05],
          [side * 0.15, 0.21, 0.14]
        ],
        radiusStart: 0.028,
        radiusMid: 0.036,
        radiusEnd: 0.018,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.38,
        tipGlow: false,
        baseColor: [0.94, 0.84, 0.7],
        tipColor: [1.24, 1.16, 0.98],
        seed: side < 0 ? 547 : 557
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.09, 0.23, -0.1],
          [side * 0.19, 0.4, -0.01],
          [side * 0.29, 0.49, 0.14],
          [side * 0.34, 0.4, 0.28]
        ],
        radiusStart: 0.044,
        radiusMid: 0.034,
        radiusEnd: 7e-3,
        midPos: 0.36,
        tubularSegs: 9,
        radialSegs: 6,
        bladeAspect: 1.42,
        tipGlow: true,
        baseColor: [0.9, 0.76, 0.62],
        tipColor: [1.3, 1.24, 1.04],
        seed: side < 0 ? 563 : 569
      })
    );
    boneParts.push(
      sculptBoneSpike({
        length: 0.2,
        baseR: 0.036,
        tipR: 9e-3,
        bendZ: -0.04,
        flattenX: 0.58,
        radialSegs: 5,
        heightSegs: 3,
        pos: [side * 0.15, 0.01, -0.1],
        rot: [-1.14, side * 0.36, -side * 0.24],
        tipGlow: false,
        seed: side < 0 ? 571 : 577
      })
    );
    const eye = new THREE.SphereGeometry(0.038, 8, 6);
    eye.scale(1.42, 0.55, 0.85);
    eye.rotateZ(-side * 0.34);
    eye.rotateY(side * 0.22);
    eye.translate(side * 0.08, 0.095, -0.238);
    eyeParts.push(eye);
  }
  const slit = new THREE.BoxGeometry(0.026, 0.075, 0.032);
  slit.translate(0, -0.035, -0.245);
  eyeParts.push(slit);
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts),
    eyes: mergeStrict(eyeParts)
  };
}
function buildUpperArmGeometries(side) {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.3, 0.27, 0.28],
      pos: [side * 0.02, 0.02, 0],
      rot: [0, 0, -side * 0.28],
      segW: 12,
      segH: 9,
      noiseAmp: 0.08,
      ridgeAmp: 0.05,
      topTaper: 0.9,
      botTaper: 1.06,
      seed: side < 0 ? 601 : 607,
      uvBand: UV_BAND_LAVA_DENSE,
      uScale: 1.2
    })
  );
  skinParts.push(
    sculptMuscleLimb({
      length: 0.82,
      rTop: 0.24,
      rMid: 0.22,
      rBot: 0.21,
      midPos: 0.46,
      radialSegs: 12,
      heightSegs: 7,
      striations: 4,
      bendX: side * 0.05,
      bendZ: 0.02,
      scaleZ: 1.06,
      pos: [side * 0.04, 0, 0],
      seed: side < 0 ? 613 : 617,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [side * -0.06, 0.22, -0.06],
        [side * 0.14, 0.24, 0.01],
        [side * 0.3, 0.14, 0.06],
        [side * 0.38, -0.02, 0.08]
      ],
      radiusStart: 0.036,
      radiusMid: 0.052,
      radiusEnd: 0.014,
      tubularSegs: 8,
      radialSegs: 6,
      bladeAspect: 1.48,
      tipGlow: true,
      baseColor: [0.76, 0.5, 0.38],
      tipColor: [1.24, 1.18, 1],
      seed: side < 0 ? 631 : 641
    })
  );
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildForearmGeometries(side) {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(
    sculptMuscleLimb({
      length: 0.9,
      rTop: 0.23,
      rMid: 0.3,
      rBot: 0.22,
      midPos: 0.42,
      radialSegs: 14,
      heightSegs: 8,
      striations: 5,
      striationAmp: 0.09,
      bendX: side * 0.04,
      bendZ: -0.05,
      scaleZ: 1.08,
      pos: [0, 0.05, 0],
      seed: side < 0 ? 653 : 659,
      uvBand: UV_BAND_LAVA_DENSE,
      uScale: 1.3
    })
  );
  boneParts.push(
    sculptBoneSpike({
      length: 0.32,
      baseR: 0.066,
      tipR: 0.01,
      bendZ: 0.09,
      flattenX: 0.64,
      radialSegs: 6,
      heightSegs: 4,
      pos: [side * 0.05, -0.02, 0.18],
      rot: [1.32, 0, -side * 0.16],
      seed: side < 0 ? 661 : 673
    })
  );
  const forearmSpikes = [
    { y: -0.15, z: 0.06, len: 0.28, r: 0.072, rz: -side * 0.92 },
    { y: -0.33, z: 0.03, len: 0.32, r: 0.078, rz: -side * 1.02 },
    { y: -0.51, z: -0.02, len: 0.29, r: 0.07, rz: -side * 1.12 },
    { y: -0.67, z: -0.06, len: 0.23, r: 0.058, rz: -side * 1.22 }
  ];
  for (let i = 0; i < forearmSpikes.length; i++) {
    const sp = forearmSpikes[i];
    boneParts.push(
      sculptBoneSpike({
        length: sp.len,
        baseR: sp.r,
        tipR: 0.013,
        bendZ: 0.1,
        flattenX: 0.72,
        radialSegs: 6,
        heightSegs: 4,
        pos: [side * 0.22, sp.y, sp.z],
        rot: [0.46, -side * 0.26, sp.rz],
        seed: 683 + i * 11 + (side > 0 ? 3 : 0)
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildHandGeometries(side) {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.19, 0.22, 0.2],
      pos: [side * 0.01, -0.12, -0.02],
      segW: 10,
      segH: 7,
      noiseAmp: 0.09,
      seed: side < 0 ? 701 : 709,
      topTaper: 1.06,
      botTaper: 0.96,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  const fingerDefs = [
    { x: -side * 0.1, z: -0.1, spreadX: -side * 0.07, len: 0.44, curlZ: -0.08 },
    { x: side * 0.01, z: -0.12, spreadX: side * 0.01, len: 0.49, curlZ: -0.09 },
    { x: side * 0.11, z: -0.07, spreadX: side * 0.08, len: 0.42, curlZ: -0.06 }
  ];
  for (let i = 0; i < fingerDefs.length; i++) {
    const f = fingerDefs[i];
    skinParts.push(
      sculptOrganicBlob({
        scale: [0.06, 0.056, 0.062],
        pos: [f.x, -0.27, f.z + 0.03],
        segW: 7,
        segH: 5,
        noiseAmp: 0.08,
        seed: 719 + i * 7 + (side > 0 ? 3 : 0),
        uvBand: UV_BAND_LAVA_DENSE
      })
    );
    skinParts.push(
      sculptMuscleLimb({
        length: 0.18,
        rTop: 0.05,
        rMid: 0.045,
        rBot: 0.04,
        radialSegs: 6,
        heightSegs: 3,
        striations: 2,
        pos: [f.x, -0.28, f.z + 0.02],
        rot: [0.34, 0, -f.spreadX * 2.2],
        seed: 733 + i * 7 + (side > 0 ? 3 : 0),
        uvBand: UV_BAND_LAVA_DENSE
      })
    );
    const knX = f.x + f.spreadX * 0.65;
    const knY = -0.43;
    const knZ = f.z - 0.04;
    boneParts.push(
      sculptOrganicBlob({
        scale: [0.046, 0.042, 0.048],
        pos: [knX, knY, knZ],
        segW: 6,
        segH: 4,
        noiseAmp: 0.08,
        seed: 743 + i * 5 + (side > 0 ? 2 : 0),
        uvBand: UV_BAND_BONE,
        tint: [1.14, 1.06, 0.92]
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [knX, knY + 0.01, knZ],
          [knX + f.spreadX * 0.45, knY - f.len * 0.34, knZ + f.curlZ * 0.45],
          [knX + f.spreadX * 0.3, knY - f.len * 0.68, knZ + f.curlZ * 0.15 + 0.05],
          [knX - side * 0.02, knY - f.len * 0.84, knZ + 0.13]
        ],
        radiusStart: 0.042,
        radiusMid: 0.032,
        radiusEnd: 6e-3,
        midPos: 0.38,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.38,
        tipGlow: true,
        baseColor: [0.8, 0.56, 0.44],
        tipColor: [1.26, 1.2, 1],
        seed: 751 + i * 9 + (side > 0 ? 3 : 0)
      })
    );
  }
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.066, 0.06, 0.066],
      pos: [-side * 0.15, -0.18, -0.09],
      segW: 7,
      segH: 5,
      noiseAmp: 0.09,
      seed: side < 0 ? 769 : 773,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  skinParts.push(
    sculptMuscleLimb({
      length: 0.16,
      rTop: 0.052,
      rMid: 0.046,
      rBot: 0.038,
      radialSegs: 6,
      heightSegs: 3,
      striations: 2,
      pos: [-side * 0.16, -0.19, -0.1],
      rot: [0.46, side * 0.48, -side * 0.56],
      seed: side < 0 ? 787 : 797,
      uvBand: UV_BAND_LAVA_DENSE
    })
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [-side * 0.23, -0.31, -0.16],
        [-side * 0.28, -0.43, -0.17],
        [-side * 0.22, -0.54, -0.1]
      ],
      radiusStart: 0.042,
      radiusMid: 0.03,
      radiusEnd: 6e-3,
      tubularSegs: 7,
      radialSegs: 6,
      bladeAspect: 1.35,
      tipGlow: true,
      baseColor: [0.8, 0.56, 0.44],
      tipColor: [1.26, 1.2, 1],
      seed: side < 0 ? 809 : 811
    })
  );
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildPelvisGeometries() {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.46, 0.3, 0.34],
      pos: [0, 0, 0.02],
      segW: 14,
      segH: 9,
      noiseAmp: 0.08,
      ridgeAmp: 0.05,
      seed: 821,
      topTaper: 0.82,
      botTaper: 1.06,
      uvBand: UV_BAND_LAVA_FLOW
    })
  );
  for (const side of [-1, 1]) {
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [side * 0.12, 0.12, -0.27],
          [side * 0.36, 0.05, -0.12],
          [side * 0.39, -0.06, 0.08],
          [side * 0.22, 0.02, 0.28]
        ],
        radiusStart: 0.024,
        radiusMid: 0.034,
        radiusEnd: 0.022,
        tubularSegs: 8,
        radialSegs: 6,
        bladeAspect: 1.35,
        tipGlow: false,
        baseColor: [0.88, 0.76, 0.62],
        tipColor: [1.18, 1.1, 0.94],
        seed: side < 0 ? 827 : 829
      })
    );
  }
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildTailSegmentGeometries(index, segLen, rStart, rEnd, isTip) {
  const skinParts = [];
  const boneParts = [];
  if (!isTip) {
    skinParts.push(
      sculptOrganicBlob({
        scale: [rStart * 1.02, rStart * 0.98, rStart * 1.02],
        pos: [0, 0, 0],
        segW: 8,
        segH: 6,
        noiseAmp: 0.05,
        seed: 841 + index * 7,
        uvBand: UV_BAND_LAVA_FLOW
      })
    );
    skinParts.push(
      sculptMuscleLimb({
        length: segLen + 0.05,
        rTop: rStart,
        rMid: lerp(rStart, rEnd, 0.5) * 1.02,
        rBot: rEnd,
        radialSegs: 10,
        heightSegs: 5,
        striations: 3,
        striationAmp: 0.06,
        noiseAmp: 0.06,
        rot: [-Math.PI * 0.5, 0, 0],
        pos: [0, 0, -0.02],
        seed: 851 + index * 13,
        uvBand: UV_BAND_LAVA_FLOW
      })
    );
    boneParts.push(
      sculptBoneSpike({
        length: lerp(0.24, 0.14, index / 4),
        baseR: rStart * 0.42,
        tipR: 8e-3,
        bendZ: 0.05,
        flattenX: 0.52,
        radialSegs: 6,
        heightSegs: 3,
        pos: [0, rStart * 0.72, segLen * 0.46],
        rot: [0.96, 0, 0],
        tipGlow: true,
        seed: 877 + index * 7
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [-rStart * 0.95, 0, segLen * 0.1],
          [0, rStart * 0.96, segLen * 0.18],
          [rStart * 0.95, 0, segLen * 0.1]
        ],
        radiusStart: rStart * 0.22,
        radiusMid: rStart * 0.3,
        radiusEnd: rStart * 0.22,
        tubularSegs: 6,
        radialSegs: 5,
        bladeAspect: 1.25,
        tipGlow: false,
        baseColor: [0.88, 0.78, 0.64],
        tipColor: [1.14, 1.06, 0.9],
        seed: 887 + index * 5
      })
    );
  } else {
    skinParts.push(
      sculptOrganicBlob({
        scale: [rStart * 1.02, rStart * 0.98, rStart * 1.02],
        pos: [0, 0, 0],
        segW: 8,
        segH: 6,
        noiseAmp: 0.05,
        seed: 907,
        uvBand: UV_BAND_LAVA_DENSE
      })
    );
    skinParts.push(
      sculptMuscleLimb({
        length: segLen * 0.58,
        rTop: rStart,
        rMid: rStart * 0.9,
        rBot: rEnd * 1.05,
        radialSegs: 9,
        heightSegs: 4,
        striations: 2,
        rot: [-Math.PI * 0.5, 0, 0],
        // STRICTLY along +Z!
        pos: [0, 0, -0.015],
        seed: 911,
        uvBand: UV_BAND_LAVA_DENSE
      })
    );
    boneParts.push(
      sculptCurvedBoneBlade({
        points: [
          [0, 0, segLen * 0.38],
          [0, 0.03, segLen * 0.85],
          [0, 0.14, segLen * 1.38],
          [0, 0.3, segLen * 1.82]
        ],
        radiusStart: rStart * 0.96,
        radiusMid: rStart * 1.48,
        radiusEnd: 8e-3,
        midPos: 0.36,
        tubularSegs: 11,
        radialSegs: 7,
        bladeAspect: 2.25,
        tipGlow: true,
        baseColor: [0.76, 0.44, 0.34],
        tipColor: [1.3, 1.24, 1.02],
        seed: 919
      })
    );
    boneParts.push(
      sculptBoneSpike({
        length: 0.18,
        baseR: 0.032,
        tipR: 6e-3,
        bendZ: -0.04,
        flattenX: 0.48,
        radialSegs: 5,
        heightSegs: 3,
        pos: [0, -0.02, segLen * 0.66],
        rot: [Math.PI * 0.72, 0, 0],
        tipGlow: true,
        seed: 929
      })
    );
  }
  return {
    skin: skinParts.length > 0 ? mergeStrict(skinParts) : null,
    bone: mergeStrict(boneParts)
  };
}
function buildThighGeometries(side) {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(
    sculptMuscleLimb({
      length: 0.92,
      rTop: 0.24,
      rMid: 0.22,
      rBot: 0.16,
      midPos: 0.42,
      radialSegs: 12,
      heightSegs: 8,
      striations: 4,
      bendX: side * 0.02,
      bendZ: -0.05,
      scaleZ: 1.08,
      pos: [0, 0.05, 0],
      seed: side < 0 ? 941 : 947,
      uvBand: UV_BAND_LAVA_FLOW,
      uScale: 1.1
    })
  );
  skinParts.push(
    sculptOrganicBlob({
      scale: [0.16, 0.15, 0.17],
      pos: [side * 0.02, -0.84, -0.06],
      segW: 10,
      segH: 7,
      noiseAmp: 0.06,
      seed: side < 0 ? 949 : 951,
      uvBand: UV_BAND_LAVA_FLOW
    })
  );
  boneParts.push(
    sculptBoneSpike({
      length: 0.24,
      baseR: 0.068,
      tipR: 0.014,
      bendZ: -0.04,
      flattenX: 0.76,
      radialSegs: 6,
      heightSegs: 3,
      pos: [side * 0.01, -0.78, -0.14],
      rot: [-0.4, 0, 0],
      tipGlow: false,
      seed: side < 0 ? 953 : 967
    })
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [side * 0.21, -0.1, 0.02],
        [side * 0.22, -0.4, -0.02],
        [side * 0.14, -0.72, -0.06]
      ],
      radiusStart: 0.026,
      radiusMid: 0.032,
      radiusEnd: 0.018,
      tubularSegs: 7,
      radialSegs: 5,
      bladeAspect: 1.38,
      tipGlow: false,
      baseColor: [0.86, 0.74, 0.6],
      tipColor: [1.16, 1.08, 0.94],
      seed: side < 0 ? 971 : 977
    })
  );
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildShinGeometries(side) {
  const skinParts = [];
  const boneParts = [];
  skinParts.push(
    sculptMuscleLimb({
      length: 0.92,
      rTop: 0.16,
      rMid: 0.175,
      rBot: 0.115,
      midPos: 0.36,
      radialSegs: 12,
      heightSegs: 8,
      striations: 3,
      bendZ: 0.05,
      scaleZ: 1.12,
      pos: [0, 0.04, 0],
      seed: side < 0 ? 983 : 991,
      uvBand: UV_BAND_LAVA_FLOW
    })
  );
  boneParts.push(
    sculptCurvedBoneBlade({
      points: [
        [0, -0.08, -0.14],
        [0, -0.44, -0.15],
        [0, -0.8, -0.09]
      ],
      radiusStart: 0.04,
      radiusMid: 0.038,
      radiusEnd: 0.022,
      tubularSegs: 7,
      radialSegs: 6,
      bladeAspect: 1.55,
      tipGlow: false,
      baseColor: [0.88, 0.76, 0.62],
      tipColor: [1.18, 1.1, 0.94],
      seed: side < 0 ? 997 : 1009
    })
  );
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
function buildFootGeometries(side) {
  const skinParts = [];
  const boneParts = [];
  const SOLE_Y = -0.22;
  const footBase = sculptOrganicBlob({
    scale: [0.18, 0.12, 0.3],
    pos: [0, -0.12, -0.11],
    segW: 10,
    segH: 7,
    noiseAmp: 0.06,
    seed: side < 0 ? 1013 : 1019,
    uvBand: UV_BAND_LAVA_FLOW
  });
  const fpos = footBase.getAttribute("position");
  for (let i = 0; i < fpos.count; i++) {
    if (fpos.getY(i) < SOLE_Y) fpos.setY(i, SOLE_Y);
  }
  footBase.computeVertexNormals();
  skinParts.push(footBase);
  const toeXs = [-0.11, 0, 0.11];
  for (let i = 0; i < toeXs.length; i++) {
    const tx = toeXs[i];
    const claw = sculptBoneSpike({
      length: 0.16,
      baseR: 0.036,
      tipR: 7e-3,
      bendZ: -0.015,
      pos: [tx, -0.16, -0.35 - (i === 1 ? 0.03 : 0)],
      rot: [-Math.PI * 0.52, -tx * 0.8, 0],
      radialSegs: 5,
      heightSegs: 3,
      tipGlow: false,
      seed: 1031 + i * 7 + (side > 0 ? 3 : 0)
    });
    const cpos = claw.getAttribute("position");
    for (let k = 0; k < cpos.count; k++) {
      if (cpos.getY(k) < SOLE_Y) cpos.setY(k, SOLE_Y);
    }
    claw.computeVertexNormals();
    boneParts.push(claw);
  }
  const heel = sculptBoneSpike({
    length: 0.15,
    baseR: 0.036,
    tipR: 7e-3,
    bendZ: 0.02,
    pos: [0, -0.15, 0.14],
    rot: [Math.PI * 0.54, 0, 0],
    radialSegs: 5,
    heightSegs: 3,
    tipGlow: false,
    seed: side < 0 ? 1051 : 1061
  });
  const hpos = heel.getAttribute("position");
  for (let k = 0; k < hpos.count; k++) {
    if (hpos.getY(k) < SOLE_Y) hpos.setY(k, SOLE_Y);
  }
  heel.computeVertexNormals();
  boneParts.push(heel);
  return {
    skin: mergeStrict(skinParts),
    bone: mergeStrict(boneParts)
  };
}
var BASE_HIP_Y = 1.92;
var DEG2RAD = Math.PI / 180;
var ATTACK_DURATION = 0.18;
var RECOVER_DURATION = 0.8;
var TAIL_SEG_COUNT = 6;
var LAVA_EMISSIVE_P1 = new THREE.Color("#DE3608");
var LAVA_EMISSIVE_P2 = new THREE.Color("#F26C18");
var CORE_EMISSIVE_P1 = new THREE.Color("#E84E0E");
var CORE_EMISSIVE_P2 = new THREE.Color("#FA8622");
var BONE_TIP_EMISSIVE = new THREE.Color("#E66010");
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
var TAIL_BASE_PITCH = [0.22, 0.34, 0.34, 0.14, -0.34, -0.44];
function createBossModel() {
  const atlas = createTerminatorAtlas();
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
      color: new THREE.Color("#BDA6A0"),
      map: atlas.albedoMap,
      emissive: LAVA_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 0.78,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.84,
      metalness: 0.06,
      vertexColors: true
    })
  );
  const boneMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#C8BCA8"),
      map: atlas.albedoMap,
      emissive: BONE_TIP_EMISSIVE.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 0.06,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.95, 0.95),
      roughness: 0.74,
      metalness: 0.04,
      vertexColors: true
    })
  );
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2B0904"),
      map: atlas.albedoMap,
      emissive: CORE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.15,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.48,
      metalness: 0.05
    })
  );
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2E0602"),
      emissive: new THREE.Color("#FF5210"),
      emissiveIntensity: 2.4,
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
  torso.add(makeMesh(torsoGeo.bone, boneMat, "boss-torso-bone"));
  const core = makeMesh(buildCoreGeometry(), coreMat, "boss-core");
  core.position.set(0, 0.96, 0);
  core.castShadow = false;
  torso.add(core);
  const head = new THREE.Group();
  head.name = "boss-head";
  head.position.set(0, 1.56, -0.24);
  torso.add(head);
  const headGeo = buildHeadGeometries();
  head.add(makeMesh(headGeo.skin, skinMat, "boss-head-skin"));
  head.add(makeMesh(headGeo.bone, boneMat, "boss-head-bone"));
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
    shoulder.add(makeMesh(upperGeo.bone, boneMat, `boss-upper-arm-bone-${tag}`));
    const elbow = new THREE.Group();
    elbow.name = `boss-elbow-${tag}`;
    elbow.position.set(side * 0.06, -0.76, 0.02);
    shoulder.add(elbow);
    const foreGeo = buildForearmGeometries(side);
    elbow.add(makeMesh(foreGeo.skin, skinMat, `boss-forearm-skin-${tag}`));
    elbow.add(makeMesh(foreGeo.bone, boneMat, `boss-forearm-bone-${tag}`));
    const hand = new THREE.Group();
    hand.name = `boss-hand-${tag}`;
    hand.position.set(side * 0.04, -0.82, -0.04);
    elbow.add(hand);
    const handGeo = buildHandGeometries(side);
    hand.add(makeMesh(handGeo.skin, skinMat, `boss-hand-skin-${tag}`));
    hand.add(makeMesh(handGeo.bone, boneMat, `boss-hand-bone-${tag}`));
    return { shoulder, elbow, hand };
  };
  const armL = buildArmChain(-1, "l", [-0.88, 1.32, -0.02]);
  const armR = buildArmChain(1, "r", [0.88, 1.32, -0.02]);
  const hips = new THREE.Group();
  hips.name = "boss-hips";
  body.add(hips);
  const pelvisGeo = buildPelvisGeometries();
  hips.add(makeMesh(pelvisGeo.skin, skinMat, "boss-pelvis-skin"));
  hips.add(makeMesh(pelvisGeo.bone, boneMat, "boss-pelvis-bone"));
  const tailRoot = new THREE.Group();
  tailRoot.name = "boss-tail";
  tailRoot.position.set(0, 0.08, 0.28);
  hips.add(tailRoot);
  const tailSegLengths = [0.38, 0.36, 0.35, 0.33, 0.31, 0.34];
  const tailSegRadii = [
    [0.145, 0.118],
    [0.118, 0.098],
    [0.098, 0.082],
    [0.082, 0.068],
    [0.068, 0.054],
    [0.054, 0.036]
  ];
  const tailSegs = [];
  let tailParent = tailRoot;
  for (let i = 0; i < TAIL_SEG_COUNT; i++) {
    const seg = new THREE.Group();
    seg.name = `boss-tail-seg-${i}`;
    if (i > 0) {
      seg.position.set(0, 0, tailSegLengths[i - 1]);
    }
    seg.rotation.set(TAIL_BASE_PITCH[i], 0, 0);
    const isTip = i === TAIL_SEG_COUNT - 1;
    const segGeos = buildTailSegmentGeometries(
      i,
      tailSegLengths[i],
      tailSegRadii[i][0],
      tailSegRadii[i][1],
      isTip
    );
    if (segGeos.skin) {
      seg.add(makeMesh(segGeos.skin, skinMat, `boss-tail-skin-${i}`));
    }
    seg.add(makeMesh(segGeos.bone, boneMat, `boss-tail-bone-${i}`));
    tailParent.add(seg);
    tailSegs.push(seg);
    tailParent = seg;
  }
  const buildLegChain = (side, tag) => {
    const thigh = new THREE.Group();
    thigh.name = `boss-thigh-${tag}`;
    thigh.position.set(side * 0.29, 0.02, 0.02);
    hips.add(thigh);
    const thighGeo = buildThighGeometries(side);
    thigh.add(makeMesh(thighGeo.skin, skinMat, `boss-thigh-skin-${tag}`));
    thigh.add(makeMesh(thighGeo.bone, boneMat, `boss-thigh-bone-${tag}`));
    const shin = new THREE.Group();
    shin.name = `boss-shin-${tag}`;
    shin.position.set(side * 0.02, -0.86, -0.06);
    thigh.add(shin);
    const shinGeo = buildShinGeometries(side);
    shin.add(makeMesh(shinGeo.skin, skinMat, `boss-shin-skin-${tag}`));
    shin.add(makeMesh(shinGeo.bone, boneMat, `boss-shin-bone-${tag}`));
    const foot = new THREE.Group();
    foot.name = `boss-foot-${tag}`;
    foot.position.set(0, -0.86, 0.06);
    shin.add(foot);
    const footGeo = buildFootGeometries(side);
    foot.add(makeMesh(footGeo.skin, skinMat, `boss-foot-skin-${tag}`));
    foot.add(makeMesh(footGeo.bone, boneMat, `boss-foot-bone-${tag}`));
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
  const tailTargetPitch = new Float32Array(TAIL_SEG_COUNT);
  const tailTargetYaw = new Float32Array(TAIL_SEG_COUNT);
  const tmpEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const tmpQuat = new THREE.Quaternion();
  let elapsed = 0;
  let animElapsed = 0;
  let lastAnim = null;
  let moltenHeat = 0;
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
    const isMoltenEnraged = hpPct <= 0.35;
    const heatTarget = isMoltenEnraged ? 1 : state.phase === 2 ? 0.38 : 0;
    if (state.anim !== lastAnim) {
      lastAnim = state.anim;
      animElapsed = 0;
    }
    elapsed += step;
    animElapsed += step;
    const heatAlpha = step > 0 ? 1 - Math.exp(-7 * step) : 1;
    moltenHeat += (heatTarget - moltenHeat) * heatAlpha;
    let targetBodyDrop = 0;
    let targetTorsoScaleY = 1;
    let slerpRate = 10;
    let coreWarnMult = 1;
    setPose("hips", 0, 0, 0);
    setPose("thighL", 0.05, 0.06, 0.04);
    setPose("shinL", -0.09, 0, 0);
    setPose("footL", 0.04, 0, -0.04);
    setPose("thighR", -0.04, -0.06, -0.04);
    setPose("shinR", -0.07, 0, 0);
    setPose("footR", 0.11, 0, 0.04);
    for (let i = 0; i < TAIL_SEG_COUNT; i++) {
      tailTargetPitch[i] = TAIL_BASE_PITCH[i];
      tailTargetYaw[i] = 0;
    }
    const rageRate = 1 + (1 - hpPct) * 0.3 + moltenHeat * 0.25;
    if (state.anim === "idle") {
      const breath = 0.5 + 0.5 * Math.sin(elapsed * 2.1 * rageRate);
      const sway = Math.sin(elapsed * 1.1 * rageRate);
      targetTorsoScaleY = 1 + 0.018 * breath;
      targetBodyDrop = 0.01 * (1 - breath);
      setPose("hips", 0, sway * 0.035, sway * 0.025);
      setPose("torso", -0.06 - breath * 0.02, sway * 0.05, -sway * 0.03);
      setPose("head", 0.05 - breath * 0.03, -sway * 0.08 + Math.sin(elapsed * 0.65) * 0.06, sway * 0.03);
      setPose("leftArm", 0.12 + breath * 0.05, -0.08, 0.16 + breath * 0.03);
      setPose("elbowL", 0.36 + breath * 0.05, 0, -0.05);
      setPose("handL", 0.14, 0, -0.06);
      setPose("rightArm", 0.14 - breath * 0.04 + sway * 0.04, 0.08, -0.17 - breath * 0.03);
      setPose("elbowR", 0.4 + breath * 0.05, 0, 0.06);
      setPose("handR", 0.16, 0, 0.06);
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        const w = elapsed * 1.85 * rageRate - i * 0.52;
        tailTargetYaw[i] = Math.sin(w) * (0.09 + i * 0.026);
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] + Math.cos(w * 0.7) * 0.03;
      }
      slerpRate = 8;
    } else if (state.anim === "walk") {
      const walkFreq = 3.5 * (1 + moltenHeat * 0.15);
      const w = animElapsed * walkFreq + 0.45;
      const s = Math.sin(w);
      const c = Math.cos(w);
      const footStrike = Math.pow(Math.max(0, -Math.cos(w * 2)), 2);
      targetBodyDrop = 0.04 * footStrike;
      targetTorsoScaleY = 1.008 + 8e-3 * Math.abs(s);
      setPose("hips", 0.04 * footStrike, -s * 0.1, s * 0.05);
      setPose("torso", -0.15 - 0.04 * footStrike, s * 0.14, -s * 0.07);
      setPose("head", 0.1 + 0.04 * footStrike, -s * 0.1, s * 0.04);
      setPose("thighL", s * 0.48 + 0.05, 0.04, 0.04);
      setPose("shinL", -Math.max(0.08, -c * 0.56 + 0.15), 0, 0);
      setPose("footL", -s * 0.22 + 0.07, 0, -0.04);
      setPose("thighR", -s * 0.48 + 0.05, -0.04, -0.04);
      setPose("shinR", -Math.max(0.08, c * 0.56 + 0.15), 0, 0);
      setPose("footR", s * 0.22 + 0.07, 0, 0.04);
      setPose("leftArm", -s * 0.46 + 0.14, -0.08, 0.18 + Math.abs(s) * 0.05);
      setPose("elbowL", 0.36 + Math.max(0, -s) * 0.22, 0, -0.05);
      setPose("handL", 0.15, 0, -0.05);
      setPose("rightArm", s * 0.48 + 0.16, 0.08, -0.19 - Math.abs(s) * 0.05);
      setPose("elbowR", 0.4 + Math.max(0, s) * 0.24, 0, 0.06);
      setPose("handR", 0.18, 0, 0.06);
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        const lagPhase = w - i * 0.42;
        tailTargetYaw[i] = -Math.sin(lagPhase) * (0.14 + i * 0.034);
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] + Math.cos(lagPhase * 2) * 0.032;
      }
      slerpRate = 12;
    } else if (state.anim === "windup") {
      const backPitch = 16 * DEG2RAD;
      const tremor = Math.sin(animElapsed * 24) * 0.025;
      coreWarnMult = 1.38;
      targetTorsoScaleY = 1.022;
      targetBodyDrop = 0.02;
      setPose("hips", 0.06, -0.14, 0.04);
      setPose("torso", backPitch, -0.26, 0.08);
      setPose("head", -0.14, 0.22, -0.05);
      setPose("leftArm", 0.56, -0.2, 0.32);
      setPose("elbowL", 0.68, 0, -0.1);
      setPose("handL", 0.24, 0, -0.08);
      setPose("rightArm", -1.32 + tremor, 0.18, -0.66);
      setPose("elbowR", 0.82, 0, 0.22);
      setPose("handR", 0.34, 0, 0.14);
      setPose("thighL", 0.24, 0.12, 0.06);
      setPose("shinL", -0.34, 0, 0);
      setPose("footL", 0.1, 0, -0.06);
      setPose("thighR", -0.2, -0.1, -0.06);
      setPose("shinR", -0.24, 0, 0);
      setPose("footR", 0.38, 0, 0.06);
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] - 0.12 - i * 0.028;
        tailTargetYaw[i] = -0.14 - i * 0.032;
      }
      slerpRate = 14;
    } else if (state.anim === "attack") {
      const u = clamp01(animElapsed / ATTACK_DURATION);
      const smashEase = 1 - Math.pow(1 - u, 3);
      const armSwingX = lerp(-0.32, 1.38, smashEase);
      const torsoPitchX = lerp(0.08, -0.36, smashEase);
      coreWarnMult = lerp(1.36, 1.12, smashEase);
      targetBodyDrop = 0.07 * smashEase;
      targetTorsoScaleY = lerp(1.02, 0.99, smashEase);
      setPose("hips", -0.07 * smashEase, 0.2 * smashEase, -0.04);
      setPose("torso", torsoPitchX, lerp(-0.2, 0.36, smashEase), -0.1 * smashEase);
      setPose("head", lerp(-0.1, 0.22, smashEase), lerp(0.16, -0.26, smashEase), 0.06);
      setPose("leftArm", lerp(0.38, -0.58, smashEase), -0.16, 0.34);
      setPose("elbowL", lerp(0.56, 0.3, smashEase), 0, -0.08);
      setPose("handL", 0.18, 0, -0.08);
      setPose("rightArm", armSwingX, lerp(0.14, -0.24, smashEase), lerp(-0.44, -0.08, smashEase));
      setPose("elbowR", lerp(0.66, 0.22, smashEase), 0, 0.06);
      setPose("handR", 0.36, 0, 0.08);
      setPose("thighL", 0.34 * smashEase + 0.1, 0.08, 0.06);
      setPose("shinL", -0.44 * smashEase - 0.14, 0, 0);
      setPose("footL", 0.14, 0, -0.06);
      setPose("thighR", -0.26 * smashEase, -0.08, -0.06);
      setPose("shinR", -0.22, 0, 0);
      setPose("footR", 0.4 * smashEase + 0.1, 0, 0.06);
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] - 0.09 * smashEase;
        tailTargetYaw[i] = lerp(-0.1, 0.2 + i * 0.036, smashEase);
      }
      slerpRate = 34;
    } else if (state.anim === "recover") {
      const u = smoothstep(animElapsed / RECOVER_DURATION);
      targetBodyDrop = lerp(0.06, 0.01, u);
      targetTorsoScaleY = lerp(0.992, 1.01, u);
      setPose("hips", lerp(-0.05, 0, u), lerp(0.14, 0, u), lerp(-0.03, 0, u));
      setPose("torso", lerp(-0.28, -0.06, u), lerp(0.24, 0, u), lerp(-0.07, 0, u));
      setPose("head", lerp(0.18, 0.05, u), lerp(-0.18, 0, u), 0);
      setPose("leftArm", lerp(-0.36, 0.12, u), -0.08, lerp(0.26, 0.16, u));
      setPose("elbowL", lerp(0.26, 0.36, u), 0, -0.05);
      setPose("handL", 0.12, 0, -0.05);
      setPose("rightArm", lerp(0.96, 0.16, u), lerp(-0.14, 0.06, u), lerp(-0.1, -0.17, u));
      setPose("elbowR", lerp(0.24, 0.4, u), 0, 0.06);
      setPose("handR", lerp(0.28, 0.16, u), 0, 0.06);
      setPose("thighL", lerp(0.3, 0.06, u), 0.06, 0.04);
      setPose("shinL", lerp(-0.4, -0.1, u), 0, 0);
      setPose("footL", lerp(0.12, 0.04, u), 0, -0.04);
      setPose("thighR", lerp(-0.2, -0.04, u), -0.06, -0.04);
      setPose("shinR", lerp(-0.2, -0.07, u), 0, 0);
      setPose("footR", lerp(0.36, 0.11, u), 0, 0.04);
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetYaw[i] = lerp(0.16, 0, u);
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] + lerp(0.08, 0, u);
      }
      slerpRate = 5.5;
    } else if (state.anim === "charge") {
      const fwdPitch = -28 * DEG2RAD;
      const runW = animElapsed * 6.5 + 0.5;
      const s = Math.sin(runW);
      const c = Math.cos(runW);
      const stomp = Math.pow(Math.max(0, -Math.cos(runW * 2)), 2);
      coreWarnMult = 1.28;
      targetBodyDrop = 0.05 * stomp + 0.04;
      targetTorsoScaleY = 1.015;
      setPose("hips", -0.1, -s * 0.14, s * 0.06);
      setPose("torso", fwdPitch - 0.04 * stomp, s * 0.12, -s * 0.07);
      setPose("head", -0.42, -s * 0.08, 0);
      setPose("leftArm", -0.86 - s * 0.16, -0.16, 0.34);
      setPose("elbowL", 0.34, 0, -0.08);
      setPose("handL", 0.24, 0, -0.08);
      setPose("rightArm", -0.9 + s * 0.16, 0.16, -0.36);
      setPose("elbowR", 0.38, 0, 0.08);
      setPose("handR", 0.26, 0, 0.08);
      setPose("thighL", s * 0.62 + 0.12, 0.04, 0.04);
      setPose("shinL", -Math.max(0.14, -c * 0.72 + 0.2), 0, 0);
      setPose("footL", -s * 0.26 + 0.12, 0, -0.04);
      setPose("thighR", -s * 0.62 + 0.12, -0.04, -0.04);
      setPose("shinR", -Math.max(0.14, c * 0.72 + 0.2), 0, 0);
      setPose("footR", s * 0.26 + 0.12, 0, 0.04);
      for (let i = 0; i < TAIL_SEG_COUNT; i++) {
        tailTargetPitch[i] = TAIL_BASE_PITCH[i] * 0.45 - 0.06;
        tailTargetYaw[i] = -Math.sin(runW - i * 0.38) * (0.08 + i * 0.024);
      }
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
    const tailAlpha = step > 0 ? 1 - Math.exp(-12 * step) : 1;
    for (let i = 0; i < TAIL_SEG_COUNT; i++) {
      tmpEuler.set(tailTargetPitch[i], tailTargetYaw[i], 0, "XYZ");
      tmpQuat.setFromEuler(tmpEuler);
      tailSegs[i].quaternion.slerp(tmpQuat, tailAlpha);
    }
    const scalarAlpha = step > 0 ? 1 - Math.exp(-14 * step) : 1;
    bodyDropCur += (targetBodyDrop - bodyDropCur) * scalarAlpha;
    body.position.y = BASE_HIP_Y - bodyDropCur;
    torsoScaleYCur += (targetTorsoScaleY - torsoScaleYCur) * scalarAlpha;
    torso.scale.set(1, torsoScaleYCur, 1);
    const pulseFreq = 2.6 + (1 - hpPct) * 1.6 + moltenHeat * 1.2;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * pulseFreq);
    skinMat.emissive.copy(LAVA_EMISSIVE_P1).lerp(LAVA_EMISSIVE_P2, moltenHeat);
    skinMat.emissiveIntensity = (0.76 + moltenHeat * 1.15 + pulse * (0.09 + moltenHeat * 0.16)) * (coreWarnMult > 1.2 ? 1.08 : 1);
    coreMat.emissive.copy(CORE_EMISSIVE_P1).lerp(CORE_EMISSIVE_P2, moltenHeat);
    coreMat.emissiveIntensity = (1.15 + moltenHeat * 1.15 + pulse * (0.1 + moltenHeat * 0.18)) * coreWarnMult;
    boneMat.emissiveIntensity = 0.06 + moltenHeat * (1.05 + pulse * 0.14);
    const targetCoreScale = 1 + moltenHeat * 0.14 + pulse * (0.022 + moltenHeat * 0.028);
    coreScaleCur += (targetCoreScale - coreScaleCur) * scalarAlpha;
    core.scale.setScalar(coreScaleCur);
    eyeMat.emissiveIntensity = (2.4 + moltenHeat * 1.4 + pulse * 0.22) * (coreWarnMult > 1.2 ? 1.12 : 1);
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
    for (const t of atlas.all) t.dispose();
  };
  return {
    parts: {
      root,
      torso,
      head,
      core,
      leftArm: armL.shoulder,
      rightArm: armR.shoulder,
      tail: tailRoot
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
function collectUniqueMaterials(root) {
  const mats = /* @__PURE__ */ new Set();
  root.traverse((obj) => {
    if (!(obj instanceof THREE2.Mesh)) return;
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) mats.add(m);
    } else if (obj.material) {
      mats.add(obj.material);
    }
  });
  return mats;
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
test("bossModel: triangle count <= 20000 and material count <= 6 with lava-cracked PBR textures", () => {
  const boss = createBossModel();
  try {
    const tris = countSceneTriangles(boss.parts.root);
    assert.ok(tris > 3e3 && tris <= 2e4, `expected tris in (3000, 20000], got ${tris}`);
    const mats = collectUniqueMaterials(boss.parts.root);
    assert.ok(mats.size >= 2 && mats.size <= 6, `expected <= 6 materials, got ${mats.size}`);
    const torsoSkin = boss.parts.root.getObjectByName("boss-torso-skin");
    assert.ok(torsoSkin, "expected boss-torso-skin mesh");
    const skinMat = torsoSkin.material;
    assert.ok(skinMat.map && skinMat.emissiveMap && skinMat.normalMap, "expected procedural lava atlas + emissiveMap + normalMap");
    assert.ok(skinMat.emissiveIntensity > 0.5, `expected lava fissures to self-glow in Phase 1, got ${skinMat.emissiveIntensity}`);
  } finally {
    boss.dispose();
  }
});
test("bossModel: standing height is within 4.0-4.2m with soles flush at y=0", () => {
  const boss = createBossModel();
  try {
    boss.parts.root.updateMatrixWorld(true);
    const box = new THREE2.Box3().setFromObject(boss.parts.root);
    const height = box.max.y - box.min.y;
    assert.ok(
      height >= 4 && height <= 4.2,
      `expected standing boss height in [4.0, 4.2]m, got ${height.toFixed(3)}m (minY=${box.min.y.toFixed(3)}, maxY=${box.max.y.toFixed(3)})`
    );
    assert.ok(
      Math.abs(box.min.y) <= 0.02,
      `expected feet grounded flush at y=0, got minY=${box.min.y.toFixed(4)}`
    );
  } finally {
    boss.dispose();
  }
});
test("bossModel: windup and attack produce distinct rightArm joint matrices", () => {
  const boss = createBossModel();
  try {
    for (let i = 0; i < 20; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "windup" });
    boss.parts.root.updateMatrixWorld(true);
    const windupLocal = boss.parts.rightArm.matrix.clone();
    const windupWorld = boss.parts.rightArm.matrixWorld.clone();
    for (let i = 0; i < 10; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
    boss.parts.root.updateMatrixWorld(true);
    const attackLocal = boss.parts.rightArm.matrix.clone();
    const attackWorld = boss.parts.rightArm.matrixWorld.clone();
    let maxLocalDiff = 0;
    let maxWorldDiff = 0;
    for (let i = 0; i < 16; i++) {
      maxLocalDiff = Math.max(maxLocalDiff, Math.abs(windupLocal.elements[i] - attackLocal.elements[i]));
      maxWorldDiff = Math.max(maxWorldDiff, Math.abs(windupWorld.elements[i] - attackWorld.elements[i]));
    }
    assert.ok(
      maxLocalDiff > 0.4,
      `expected windup vs attack rightArm local matrix to differ significantly, maxDiff=${maxLocalDiff.toFixed(4)}`
    );
    assert.ok(
      maxWorldDiff > 0.4,
      `expected windup vs attack rightArm world matrix to differ significantly, maxDiff=${maxWorldDiff.toFixed(4)}`
    );
  } finally {
    boss.dispose();
  }
});
test("bossModel: all required parts + articulated 6-segment tail belong to root skeleton hierarchy", () => {
  const boss = createBossModel();
  try {
    const { root, torso, head, core, leftArm, rightArm, tail } = boss.parts;
    const partEntries = [
      ["root", root],
      ["torso", torso],
      ["head", head],
      ["core", core],
      ["leftArm", leftArm],
      ["rightArm", rightArm],
      ["tail", tail]
    ];
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
      "boss-torso-bone",
      "boss-head",
      "boss-core",
      "boss-shoulder-l",
      "boss-elbow-l",
      "boss-hand-l",
      "boss-shoulder-r",
      "boss-elbow-r",
      "boss-hand-r",
      "boss-hips",
      "boss-tail",
      "boss-tail-seg-0",
      "boss-tail-seg-1",
      "boss-tail-seg-2",
      "boss-tail-seg-3",
      "boss-tail-seg-4",
      "boss-tail-seg-5",
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
test("bossModel: update() animates arms, torso, and counter-phase tail across all 6 anim states", () => {
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
    const tailSeg2 = boss.parts.root.getObjectByName("boss-tail-seg-2");
    for (let i = 0; i < 20; i++) boss.update(0.05, { hpPct: 1, phase: 1, anim: "idle" });
    const idleCoreEmissive = coreMat.emissiveIntensity;
    assert.ok(
      torso.scale.y >= 0.999 && torso.scale.y <= 1.022,
      `idle torso breathing scaleY out of range: ${torso.scale.y}`
    );
    let minTailYaw = Infinity;
    let maxTailYaw = -Infinity;
    for (let i = 0; i < 40; i++) {
      boss.update(0.05, { hpPct: 1, phase: 1, anim: "walk" });
      minTailYaw = Math.min(minTailYaw, tailSeg2.rotation.y);
      maxTailYaw = Math.max(maxTailYaw, tailSeg2.rotation.y);
    }
    assert.ok(
      maxTailYaw - minTailYaw > 0.18,
      `walk tail should sway noticeably (range=${(maxTailYaw - minTailYaw).toFixed(3)})`
    );
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "windup" });
    assert.ok(boss.parts.rightArm.rotation.x < -0.95, `windup rightArm should raise backward, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
    assert.ok(torso.rotation.x > 0.2, `windup torso should lean backward, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(
      coreMat.emissiveIntensity > idleCoreEmissive * 1.2,
      `windup core should surge, idle=${idleCoreEmissive.toFixed(2)}, windup=${coreMat.emissiveIntensity.toFixed(2)}`
    );
    for (let i = 0; i < 9; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
    assert.ok(boss.parts.rightArm.rotation.x > 0.85, `attack rightArm should slash forward, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
    assert.ok(torso.rotation.x < -0.18, `attack torso should lunge forward, got ${torso.rotation.x.toFixed(3)}`);
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "charge" });
    assert.ok(torso.rotation.x < -0.38, `charge torso should pitch forward steeply, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.head.rotation.x < -0.3, `charge head should drop low, got ${boss.parts.head.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.leftArm.rotation.x < -0.5, `charge leftArm should sweep back, got ${boss.parts.leftArm.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.rightArm.rotation.x < -0.5, `charge rightArm should sweep back, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
  } finally {
    boss.dispose();
  }
});
test("bossModel: phase 2 (hpPct <= 0.35) heats lava cracks, core, and bone tips without flashing whole skin albedo", () => {
  const boss = createBossModel();
  try {
    const coreMat = getCoreMaterial(boss.parts.core);
    const torsoSkin = boss.parts.root.getObjectByName("boss-torso-skin");
    const torsoBone = boss.parts.root.getObjectByName("boss-torso-bone");
    const skinMat = torsoSkin.material;
    const boneMat = torsoBone.material;
    for (let i = 0; i < 15; i++) boss.update(0.05, { hpPct: 0.8, phase: 1, anim: "idle" });
    const p1CoreEm = coreMat.emissiveIntensity;
    const p1SkinEm = skinMat.emissiveIntensity;
    const p1BoneEm = boneMat.emissiveIntensity;
    const p1ColorHex = skinMat.color.getHex();
    const p1Scale = boss.parts.core.scale.x;
    for (let i = 0; i < 20; i++) boss.update(0.05, { hpPct: 0.35, phase: 2, anim: "idle" });
    const p2CoreEm = coreMat.emissiveIntensity;
    const p2SkinEm = skinMat.emissiveIntensity;
    const p2BoneEm = boneMat.emissiveIntensity;
    const p2ColorHex = skinMat.color.getHex();
    const p2Scale = boss.parts.core.scale.x;
    assert.ok(
      p2CoreEm > p1CoreEm * 1.4,
      `expected phase 2 core emissiveIntensity (${p2CoreEm.toFixed(2)}) >> phase 1 (${p1CoreEm.toFixed(2)})`
    );
    assert.ok(
      p2SkinEm > p1SkinEm * 1.6,
      `expected phase 2 lava crack emissive (${p2SkinEm.toFixed(2)}) >> phase 1 (${p1SkinEm.toFixed(2)})`
    );
    assert.ok(
      p2BoneEm > p1BoneEm * 5,
      `expected phase 2 bone-tip translucency glow (${p2BoneEm.toFixed(2)}) >> phase 1 (${p1BoneEm.toFixed(2)})`
    );
    assert.ok(
      p2Scale > p1Scale + 0.08,
      `expected phase 2 core exposure to enlarge (p1=${p1Scale.toFixed(3)}, p2=${p2Scale.toFixed(3)})`
    );
    assert.equal(p2ColorHex, p1ColorHex, "skin base albedo must stay steady (no whole-body red alarm flash)");
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
