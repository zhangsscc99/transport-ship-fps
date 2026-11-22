// src/render/bossModel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as THREE2 from "three";

// src/render/bossModel.ts
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
var DEG2RAD = Math.PI / 180;
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
function mechSnap(t, power = 3.2) {
  const u = clamp01(t);
  return 1 - Math.pow(1 - u, power);
}
function steppedServoWave(phase, holdFrac = 0.6) {
  const cyc = (phase % 1 + 1) % 1;
  const moveFrac = (1 - holdFrac) * 0.5;
  if (cyc < moveFrac) {
    return lerp(-1, 1, mechSnap(cyc / moveFrac, 2.6));
  }
  if (cyc < moveFrac + holdFrac * 0.5) {
    return 1;
  }
  const mid = moveFrac + holdFrac * 0.5;
  if (cyc < mid + moveFrac) {
    return lerp(1, -1, mechSnap((cyc - mid) / moveFrac, 2.6));
  }
  return -1;
}
function hash3(ix, iy, iz, seed) {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1274126177) ^ Math.imul(seed | 0, 2246822519);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
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
var UV_BAND_ARMOR = [0.555, 0.965];
var UV_BAND_HAZARD = [0.375, 0.495];
var UV_BAND_MECH = [0.205, 0.315];
var UV_BAND_ENERGY = [0.03, 0.15];
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
function createMechAtlas() {
  if (typeof document === "undefined") {
    const albedoMap2 = makeFallbackTex(150, 158, 168, true);
    const emissiveMap2 = makeFallbackTex(190, 96, 26, true);
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
      if (v >= 0.53) {
        const bv = clamp01((v - 0.53) / 0.47);
        const edgeU = Math.min(u, 1 - u);
        const edgeV = Math.min(bv, 1 - bv);
        const borderDist = Math.min(edgeU, edgeV);
        const outerSeam = smoothstep((0.022 - borderDist) / 0.015);
        const innerInset = Math.max(Math.abs(u - 0.5) - 0.43, Math.abs(bv - 0.5) - 0.41);
        const panelGroove = smoothstep((8e-3 - Math.abs(innerInset)) / 6e-3) * 0.65;
        let bolt = 0;
        const bolts = [
          [0.09, 0.1],
          [0.91, 0.1],
          [0.09, 0.9],
          [0.91, 0.9]
        ];
        for (let k = 0; k < bolts.length; k++) {
          const d = Math.hypot(u - bolts[k][0], bv - bolts[k][1]);
          if (d < 0.026) {
            bolt = Math.max(bolt, d < 0.014 ? 0.72 : -0.42);
          }
        }
        const brush = fbm2Tile(u * 2, bv * 20, 6, 32, 109, 3);
        const weather = fbm2Tile(u, bv, 4, 3, 223, 4);
        const streak = fbm2Tile(u * 6, bv * 2, 14, 4, 331, 3);
        const edgeChip = smoothstep((0.055 - borderDist) / 0.04) * smoothstep((streak - 0.52) * 3.8);
        const fineScratch = smoothstep((fbm2Tile(u * 5, bv * 5, 22, 16, 409, 2) - 0.8) * 6.5) * 0.35;
        const h = 0.66 - outerSeam * 0.36 - panelGroove * 0.18 + bolt * 0.18 + (brush - 0.5) * 0.05 + (weather - 0.5) * 0.04;
        height[idx] = clamp01(h);
        const grimeMod = lerp(0.86, 1.04, weather) * lerp(0.95, 1.04, brush);
        const seamAO = 1 - outerSeam * 0.44 - panelGroove * 0.22;
        const baseLum = clamp(184 * grimeMod * seamAO + edgeChip * 38 + fineScratch * 24 + bolt * 14, 58, 228);
        ad[p4] = Math.round(baseLum * 0.96);
        ad[p4 + 1] = Math.round(baseLum * 0.99);
        ad[p4 + 2] = Math.round(clamp(baseLum * 1.04, 58, 232));
        ad[p4 + 3] = 255;
        const seamHeat = smoothstep((0.015 - borderDist) / 0.011) * (0.75 + 0.25 * weather);
        ed[p4] = Math.round(clamp01(seamHeat * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(seamHeat * 0.42) * 255);
        ed[p4 + 2] = Math.round(clamp01(seamHeat * 0.08) * 255);
        ed[p4 + 3] = 255;
      } else if (v >= 0.35) {
        const bv = clamp01((v - 0.35) / 0.18);
        const border = bv < 0.11 || bv > 0.89;
        const diag = ((u * 7 + bv * 1.55) % 1 + 1) % 1;
        const isYellow = diag < 0.5;
        const stripeDist = Math.min(Math.abs(diag - 0.5), Math.min(diag, 1 - diag));
        const chipNoise = fbm2Tile(u * 2, bv, 14, 4, 521, 3);
        const chipped = smoothstep((chipNoise - 0.72) * 5) * smoothstep((0.12 - stripeDist) / 0.12);
        const wear = fbm2Tile(u, bv, 8, 4, 607, 3);
        height[idx] = border ? 0.42 : 0.64 - chipped * 0.16 + (wear - 0.5) * 0.08;
        if (border) {
          const lum = 44 + wear * 18;
          ad[p4] = Math.round(lum * 0.94);
          ad[p4 + 1] = Math.round(lum * 0.98);
          ad[p4 + 2] = Math.round(lum * 1.05);
        } else if (isYellow && chipped < 0.55) {
          const sh = 0.8 + wear * 0.22;
          ad[p4] = Math.round(clamp(182 * sh, 110, 194));
          ad[p4 + 1] = Math.round(clamp(124 * sh, 74, 138));
          ad[p4 + 2] = Math.round(clamp(28 * sh, 16, 44));
        } else {
          const lum = chipped >= 0.55 ? 116 + wear * 24 : 34 + wear * 16;
          ad[p4] = Math.round(lum * 0.95);
          ad[p4 + 1] = Math.round(lum * 0.98);
          ad[p4 + 2] = Math.round(lum * 1.04);
        }
        ad[p4 + 3] = 255;
        ed[p4] = 0;
        ed[p4 + 1] = 0;
        ed[p4 + 2] = 0;
        ed[p4 + 3] = 255;
      } else if (v >= 0.18) {
        const bv = clamp01((v - 0.18) / 0.17);
        const ribPhase = bv * 8 % 1;
        const rib = smoothstep(Math.min(ribPhase, 1 - ribPhase) / 0.24);
        const lathe = fbm2Tile(u * 4, bv * 2, 16, 4, 733, 3);
        height[idx] = clamp01(0.28 + rib * 0.56 + (lathe - 0.5) * 0.08);
        const lum = clamp(102 + rib * 84 + (lathe - 0.5) * 24, 46, 208);
        ad[p4] = Math.round(lum * 0.96);
        ad[p4 + 1] = Math.round(lum * 0.99);
        ad[p4 + 2] = Math.round(lum * 1.04);
        ad[p4 + 3] = 255;
        const ventEm = Math.pow(1 - rib, 1.35);
        ed[p4] = Math.round(clamp01(ventEm * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(ventEm * 0.45) * 255);
        ed[p4 + 2] = Math.round(clamp01(ventEm * 0.08) * 255);
        ed[p4 + 3] = 255;
      } else {
        const bv = clamp01(v / 0.18);
        const flow = fbm2Tile(u * 2, bv, 10, 4, 881, 4);
        const streak = 0.5 + 0.5 * Math.sin((u * 12 + flow * 2.2) * Math.PI * 2);
        const edgeHeat = smoothstep((bv - 0.14) / 0.78);
        const hotCore = clamp01(edgeHeat * 0.82 + streak * 0.14 + flow * 0.12);
        height[idx] = clamp01(0.42 + streak * 0.18);
        const r = lerp(70, 224, hotCore);
        const g = lerp(22, 152, Math.pow(hotCore, 1.3));
        const b = lerp(8, 62, Math.pow(hotCore, 2.1));
        ad[p4] = Math.round(clamp(r, 24, 232));
        ad[p4 + 1] = Math.round(clamp(g, 10, 180));
        ad[p4 + 2] = Math.round(clamp(b, 6, 98));
        ad[p4 + 3] = 255;
        const em = clamp01(0.22 + edgeHeat * 0.78) * (0.86 + 0.14 * streak);
        ed[p4] = Math.round(clamp01(em * 1) * 255);
        ed[p4 + 1] = Math.round(clamp01(em * lerp(0.32, 0.82, edgeHeat)) * 255);
        ed[p4 + 2] = Math.round(clamp01(em * lerp(0.05, 0.36, Math.pow(edgeHeat, 1.8))) * 255);
        ed[p4 + 3] = 255;
      }
    }
  }
  albedoCtx.putImageData(albedoImg, 0, 0);
  emCtx.putImageData(emImg, 0, 0);
  const normalCanvas = buildNormalCanvasFromHeight(height, S, 2.8);
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
var TINT_ARMOR_MAIN = [0.22, 0.26, 0.32];
var TINT_ARMOR_DARK = [0.13, 0.16, 0.2];
var TINT_ARMOR_LIGHT = [0.54, 0.6, 0.67];
var TINT_ARMOR_CRIMSON = [0.52, 0.15, 0.12];
var TINT_ARMOR_TRIM = [0.36, 0.41, 0.48];
var TINT_HAZARD = [0.88, 0.86, 0.82];
var TINT_FRAME_DARK = [0.12, 0.14, 0.18];
var TINT_FRAME_MID = [0.26, 0.3, 0.36];
var TINT_PISTON_CHROME = [0.76, 0.81, 0.88];
var TINT_PISTON_BRASS = [0.82, 0.64, 0.34];
var TINT_CORE_HOT = [1, 0.9, 0.78];
function applyBoxBandUV(geo, band, uvScale = 1) {
  const pos = geo.getAttribute("position");
  const norm = geo.getAttribute("normal");
  const [vMin, vMax] = band;
  const uvs = new Float32Array(pos.count * 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = Math.max(0.05, bb.max.x - bb.min.x);
  const sy = Math.max(0.05, bb.max.y - bb.min.y);
  const sz = Math.max(0.05, bb.max.z - bb.min.z);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const ax = norm ? Math.abs(norm.getX(i)) : 0;
    const ay = norm ? Math.abs(norm.getY(i)) : 1;
    const az = norm ? Math.abs(norm.getZ(i)) : 0;
    let lu;
    let lv;
    if (ax >= ay && ax >= az) {
      lu = (pz - bb.min.z) / sz * uvScale;
      lv = clamp01((py - bb.min.y) / sy);
    } else if (ay >= ax && ay >= az) {
      lu = (px - bb.min.x) / sx * uvScale;
      lv = clamp01((pz - bb.min.z) / sz);
    } else {
      lu = (px - bb.min.x) / sx * uvScale;
      lv = clamp01((py - bb.min.y) / sy);
    }
    uvs[i * 2] = lu;
    uvs[i * 2 + 1] = lerp(vMin, vMax, lv);
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}
function finalizePart(geo, opts = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (opts.faceted) {
    g.computeVertexNormals();
  } else if (!g.getAttribute("normal")) {
    g.computeVertexNormals();
  }
  applyBoxBandUV(g, opts.band ?? UV_BAND_ARMOR, opts.uvScale ?? 1);
  const pos = g.getAttribute("position");
  const norm = g.getAttribute("normal");
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const spanY = Math.max(1e-3, bb.max.y - bb.min.y);
  const tint = opts.tint ?? TINT_ARMOR_MAIN;
  const aoBot = opts.aoBottom ?? 0.22;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const uy = clamp01((pos.getY(i) - bb.min.y) / spanY);
    const ny = norm ? norm.getY(i) : 0;
    const bevelBoost = 0.94 + ny * 0.14;
    const shade = lerp(1 - aoBot, 1.08, uy) * bevelBoost;
    colors[i * 3] = clamp(tint[0] * shade, 0.04, 1.2);
    colors[i * 3 + 1] = clamp(tint[1] * shade, 0.04, 1.2);
    colors[i * 3 + 2] = clamp(tint[2] * shade, 0.04, 1.2);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (opts.rot && (opts.rot[0] || opts.rot[1] || opts.rot[2])) {
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(opts.rot[0], opts.rot[1], opts.rot[2])));
  }
  if (opts.pos && (opts.pos[0] || opts.pos[1] || opts.pos[2])) {
    g.translate(opts.pos[0], opts.pos[1], opts.pos[2]);
  }
  return g;
}
function normalizeForMerge(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const pos = g.getAttribute("position");
  if (!g.getAttribute("uv")) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = 0.5;
      uvs[i * 2 + 1] = lerp(UV_BAND_ARMOR[0], UV_BAND_ARMOR[1], 0.5);
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
function buildChamferBox(w, h, d, bevel = 0.026, opts = {}) {
  const b = Math.min(bevel, w * 0.34, h * 0.34, d * 0.34);
  const hw = Math.max(4e-3, w * 0.5 - b);
  const hh = Math.max(4e-3, h * 0.5 - b);
  const coreD = Math.max(4e-3, d - 2 * b);
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreD,
    bevelEnabled: b > 1e-3,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1
  });
  geo.translate(0, 0, -coreD * 0.5);
  return finalizePart(geo, { faceted: true, ...opts });
}
function buildSlopedPlate(pts, depth, bevel = 0.024, opts = {}) {
  const b = Math.min(bevel, depth * 0.36);
  const coreD = Math.max(4e-3, depth - 2 * b);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i][0], pts[i][1]);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: coreD,
    bevelEnabled: b > 1e-3,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 1
  });
  geo.translate(0, 0, -coreD * 0.5);
  return finalizePart(geo, { faceted: true, ...opts });
}
function buildArmoredFrustum(wBot, dBot, wTop, dTop, h, skewZ = 0, skewX = 0, opts = {}) {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  geo.rotateY(Math.PI / 8);
  const scaleNorm = 1 / Math.cos(Math.PI / 8);
  const pos = geo.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * scaleNorm * 0.5;
    const y = pos.getY(i);
    const z = pos.getZ(i) * scaleNorm * 0.5;
    const isTop = y > 0;
    const w = isTop ? wTop : wBot;
    const d = isTop ? dTop : dBot;
    const ox = isTop ? skewX * 0.5 : -skewX * 0.5;
    const oz = isTop ? skewZ * 0.5 : -skewZ * 0.5;
    pos.setXYZ(i, x * w + ox, y * h, z * d + oz);
  }
  return finalizePart(geo, { faceted: true, ...opts });
}
function buildCylinder(rTop, rBot, len, segs = 12, opts = {}) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, segs, 1, false);
  return finalizePart(geo, { faceted: false, band: UV_BAND_MECH, ...opts });
}
function buildHydraulicPiston(a, b, barrelR, rodR, rodTint = TINT_PISTON_CHROME, barrelTint = TINT_FRAME_DARK) {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  if (len < 0.02) return [];
  const unitDir = dir.clone().divideScalar(len);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), unitDir);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const rot = [euler.x, euler.y, euler.z];
  const barrelLen = len * 0.54;
  const barrelMid = va.clone().addScaledVector(unitDir, barrelLen * 0.5);
  const collarPos = va.clone().addScaledVector(unitDir, barrelLen);
  const rodLen = len * 0.56;
  const rodMid = va.clone().addScaledVector(unitDir, len - rodLen * 0.5);
  return [
    buildCylinder(barrelR, barrelR * 1.04, barrelLen, 10, {
      pos: [barrelMid.x, barrelMid.y, barrelMid.z],
      rot,
      tint: barrelTint,
      band: UV_BAND_MECH
    }),
    buildCylinder(barrelR * 1.26, barrelR * 1.26, Math.min(0.044, len * 0.1), 10, {
      pos: [collarPos.x, collarPos.y, collarPos.z],
      rot,
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH
    }),
    buildCylinder(rodR, rodR, rodLen, 10, {
      pos: [rodMid.x, rodMid.y, rodMid.z],
      rot,
      tint: rodTint,
      band: UV_BAND_MECH,
      aoBottom: 0.04
    }),
    buildCylinder(barrelR * 1.15, barrelR * 1.15, barrelR * 1.8, 8, {
      pos: a,
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH
    }),
    buildCylinder(rodR * 1.45, rodR * 1.45, rodR * 2.3, 8, {
      pos: b,
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID,
      band: UV_BAND_MECH
    })
  ];
}
function buildArmoredConduit(pts, radius, tubularSegs = 12, radialSegs = 7, tint = TINT_FRAME_DARK) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  const geo = new THREE.TubeGeometry(curve, tubularSegs, radius, radialSegs, false);
  return finalizePart(geo, { faceted: false, band: UV_BAND_MECH, tint, uvScale: 2 });
}
function buildLouverBank(w, h, d, slats, pos, rot = [0, 0, 0], tint = TINT_FRAME_MID) {
  const out = [];
  const stepY = h / Math.max(1, slats);
  const slatH = stepY * 0.42;
  const mat = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const v = new THREE.Vector3();
  for (let i = 0; i < slats; i++) {
    const ly = -h * 0.5 + (i + 0.5) * stepY;
    v.set(0, ly, 0).applyMatrix4(mat);
    out.push(
      buildChamferBox(w, slatH, d, 5e-3, {
        pos: [pos[0] + v.x, pos[1] + v.y, pos[2] + v.z],
        rot: [rot[0] + 0.36, rot[1], rot[2]],
        tint,
        band: UV_BAND_MECH
      })
    );
  }
  return out;
}
function buildPlasmaBladeGeometry(length, width, thickness) {
  const shape = new THREE.Shape();
  shape.moveTo(width * 0.14, 0.05);
  shape.lineTo(-width * 0.42, -0.02);
  shape.lineTo(-width * 0.58, -length * 0.12);
  shape.lineTo(-width * 0.56, -length * 0.78);
  shape.lineTo(width * 0.12, -length);
  shape.lineTo(width * 0.16, -length * 0.88);
  shape.lineTo(width * 0.16, 0.05);
  shape.closePath();
  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: thickness * 0.24,
    bevelEnabled: true,
    bevelThickness: thickness * 0.38,
    bevelSize: 8e-3,
    bevelSegments: 1,
    curveSegments: 1
  });
  raw.translate(0, 0, -thickness * 0.12);
  raw.rotateY(-Math.PI * 0.5);
  const g = raw.index ? raw.toNonIndexed() : raw;
  g.computeVertexNormals();
  const pos = g.getAttribute("position");
  const uvs = new Float32Array(pos.count * 2);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const along = clamp01(-py / length);
    const edgeFactor = clamp01((-pz + width * 0.14) / (width * 0.72));
    const heat = clamp01(edgeFactor * 0.86 + along * 0.2);
    uvs[i * 2] = along * 2.4;
    uvs[i * 2 + 1] = lerp(UV_BAND_ENERGY[0], UV_BAND_ENERGY[1], heat);
    const c = lerp(0.84, 1.18, heat);
    colors[i * 3] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}
var BASE_HIP_Y = 1.96;
var THIGH_LEN = 0.88;
var SHIN_LEN = 0.8;
var FOOT_SOLE_Y = -0.24;
var ATTACK_LOCK_SEC = 0.075;
var ATTACK_SWEEP_SEC = 0.095;
var RECOVER_DURATION = 0.78;
function buildTorsoParts() {
  const armor = [];
  const frame = [];
  const core = [];
  const vent = [];
  frame.push(
    buildCylinder(0.24, 0.26, 0.56, 12, { pos: [0, 0.34, 0.02], tint: TINT_FRAME_DARK }),
    buildCylinder(0.32, 0.32, 0.08, 12, { pos: [0, 0.24, 0.02], tint: TINT_FRAME_MID }),
    buildCylinder(0.31, 0.31, 0.08, 12, { pos: [0, 0.44, 0.02], tint: TINT_FRAME_MID })
  );
  armor.push(
    buildArmoredFrustum(0.54, 0.42, 0.62, 0.46, 0.2, -0.02, 0, { pos: [0, 0.28, -0.06], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.62, 0.46, 0.76, 0.52, 0.22, -0.04, 0, { pos: [0, 0.48, -0.08], tint: TINT_ARMOR_MAIN })
  );
  frame.push(
    ...buildHydraulicPiston([-0.32, 0.08, -0.14], [-0.46, 0.66, -0.22], 0.052, 0.03, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.32, 0.08, -0.14], [0.46, 0.66, -0.22], 0.052, 0.03, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([-0.3, 0.08, 0.24], [-0.42, 0.68, 0.3], 0.056, 0.032, TINT_PISTON_BRASS),
    ...buildHydraulicPiston([0.3, 0.08, 0.24], [0.42, 0.68, 0.3], 0.056, 0.032, TINT_PISTON_BRASS)
  );
  frame.push(
    buildArmoredFrustum(0.92, 0.72, 1.38, 0.86, 0.84, -0.06, 0, { pos: [0, 1, 0.02], tint: TINT_FRAME_DARK })
  );
  for (const s of [-1, 1]) {
    const mainPec = [
      [-0.18, -0.32],
      [0.34, -0.26],
      [0.44, 0.26],
      [-0.12, 0.34]
    ];
    armor.push(
      buildSlopedPlate(
        s === 1 ? mainPec : mainPec.map(([x, y]) => [-x, y]).reverse(),
        0.26,
        0.032,
        {
          pos: [s * 0.44, 1.02, -0.34],
          rot: [-0.18, s * 0.28, s * -0.06],
          tint: TINT_ARMOR_MAIN
        }
      )
    );
    const upperPec = [
      [-0.18, -0.14],
      [0.3, -0.1],
      [0.34, 0.16],
      [-0.1, 0.2]
    ];
    armor.push(
      buildSlopedPlate(
        s === 1 ? upperPec : upperPec.map(([x, y]) => [-x, y]).reverse(),
        0.14,
        0.024,
        {
          pos: [s * 0.48, 1.18, -0.46],
          rot: [-0.26, s * 0.3, s * -0.06],
          tint: TINT_ARMOR_LIGHT
        }
      )
    );
    armor.push(
      buildChamferBox(0.38, 0.08, 0.12, 0.012, {
        pos: [s * 0.46, 0.96, -0.49],
        rot: [-0.16, s * 0.28, s * 0.14],
        tint: TINT_ARMOR_CRIMSON
      }),
      // Weathered hazard caution trim on lower chest chin
      buildChamferBox(0.28, 0.075, 0.12, 0.01, {
        pos: [s * 0.4, 0.72, -0.46],
        rot: [-0.14, s * 0.24, 0],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 0.75
      })
    );
    vent.push(
      buildChamferBox(0.24, 0.045, 0.06, 6e-3, {
        pos: [s * 0.46, 1.06, -0.49],
        rot: [-0.2, s * 0.28, s * 0.16],
        tint: TINT_CORE_HOT,
        band: UV_BAND_ENERGY
      })
    );
    armor.push(
      buildChamferBox(0.22, 0.56, 0.68, 0.026, {
        pos: [s * 0.72, 1.02, 0.04],
        rot: [0, 0, s * -0.18],
        tint: TINT_ARMOR_DARK
      })
    );
    frame.push(
      ...buildLouverBank(0.08, 0.34, 0.34, 5, [s * 0.82, 1, 0.04], [0, 0, s * -0.18], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.05, 0.32, 0.26, 8e-3, {
        pos: [s * 0.77, 1, 0.04],
        rot: [0, 0, s * -0.18],
        tint: TINT_CORE_HOT,
        band: UV_BAND_MECH
      })
    );
    armor.push(
      buildChamferBox(0.46, 0.2, 0.48, 0.026, {
        pos: [s * 0.62, 1.38, -0.04],
        rot: [0.06, s * 0.08, s * -0.16],
        tint: TINT_ARMOR_TRIM
      })
    );
    frame.push(
      buildCylinder(0.23, 0.23, 0.38, 12, {
        pos: [s * 0.8, 1.3, 0],
        rot: [0, 0, Math.PI * 0.5],
        tint: TINT_FRAME_MID
      }),
      ...buildHydraulicPiston(
        [s * 0.34, 1.4, -0.14],
        [s * 0.76, 1.44, 0],
        0.046,
        0.026,
        TINT_PISTON_BRASS
      )
    );
  }
  armor.push(
    // Heavy protruding central upper sternal prow hood overhanging reactor recess
    buildChamferBox(0.56, 0.22, 0.34, 0.028, { pos: [0, 1.24, -0.44], rot: [-0.28, 0, 0], tint: TINT_ARMOR_LIGHT }),
    // Crimson command badge stripe across upper sternal brow
    buildChamferBox(0.32, 0.08, 0.14, 0.012, { pos: [0, 1.31, -0.54], rot: [-0.28, 0, 0], tint: TINT_ARMOR_CRIMSON }),
    // Lower sternal armored keel block
    buildChamferBox(0.46, 0.2, 0.3, 0.026, { pos: [0, 0.66, -0.42], rot: [0.24, 0, 0], tint: TINT_ARMOR_MAIN })
  );
  frame.push(
    // Thick recessed outer armored octagonal turbine bezel framing front core
    buildCylinder(0.25, 0.28, 0.18, 8, {
      pos: [0, 0.96, -0.42],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_FRAME_DARK
    }),
    // Diagonal X-brace turbine blast cage + central machined reactor hub cap (exposes 4 glowing quadrants!)
    buildChamferBox(0.42, 0.044, 0.09, 7e-3, { pos: [0, 0.96, -0.51], rot: [0, 0, Math.PI * 0.25], tint: TINT_FRAME_MID }),
    buildChamferBox(0.42, 0.044, 0.09, 7e-3, { pos: [0, 0.96, -0.51], rot: [0, 0, -Math.PI * 0.25], tint: TINT_FRAME_MID }),
    buildCylinder(0.072, 0.082, 0.11, 8, {
      pos: [0, 0.96, -0.5],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_ARMOR_LIGHT
    })
  );
  armor.push(
    // Rear sloped armored bunker cowl behind head
    buildChamferBox(0.74, 0.36, 0.3, 0.03, { pos: [0, 1.54, 0.22], rot: [-0.16, 0, 0], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.62, 0.14, 0.34, 0.022, { pos: [0, 1.68, 0.16], rot: [0.2, 0, 0], tint: TINT_ARMOR_LIGHT }),
    // Low angled front gorget chin-shield (never blocks mono-eye!)
    buildChamferBox(0.44, 0.14, 0.2, 0.018, { pos: [0, 1.4, -0.36], rot: [-0.26, 0, 0], tint: TINT_ARMOR_DARK })
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildChamferBox(0.16, 0.3, 0.46, 0.022, {
        pos: [s * 0.36, 1.52, -0.02],
        rot: [0.06, s * -0.16, s * 0.14],
        tint: TINT_ARMOR_MAIN
      })
    );
    frame.push(
      buildArmoredConduit(
        [
          [s * 0.34, 1.38, -0.32],
          [s * 0.44, 1.58, -0.26],
          [s * 0.44, 1.68, 0.06],
          [s * 0.36, 1.6, 0.26]
        ],
        0.028,
        10,
        6,
        TINT_FRAME_MID
      )
    );
  }
  armor.push(
    buildChamferBox(0.7, 0.86, 0.36, 0.032, { pos: [0, 1.02, 0.44], tint: TINT_ARMOR_DARK })
  );
  frame.push(
    buildCylinder(0.24, 0.27, 0.18, 8, {
      pos: [0, 0.98, 0.56],
      rot: [Math.PI * 0.5, Math.PI / 8, 0],
      tint: TINT_FRAME_DARK
    }),
    buildChamferBox(0.4, 0.055, 0.1, 8e-3, { pos: [0, 1.05, 0.65], tint: TINT_FRAME_MID }),
    buildChamferBox(0.4, 0.055, 0.1, 8e-3, { pos: [0, 0.91, 0.65], tint: TINT_FRAME_MID }),
    buildChamferBox(0.06, 0.36, 0.1, 8e-3, { pos: [0, 0.98, 0.65], tint: TINT_FRAME_MID })
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildArmoredFrustum(0.36, 0.46, 0.42, 0.44, 0.94, 0.06, s * 0.04, {
        pos: [s * 0.48, 1.18, 0.5],
        tint: TINT_ARMOR_MAIN
      }),
      // Titanium upper heat-sink cowl cap + crimson command tip
      buildChamferBox(0.36, 0.24, 0.42, 0.026, {
        pos: [s * 0.5, 1.66, 0.48],
        rot: [0.16, s * -0.12, s * -0.1],
        tint: TINT_ARMOR_LIGHT
      }),
      // Swept dorsal stabilizer wing-fin (breaks up upper back silhouette cleanly!)
      buildSlopedPlate(
        [
          [-0.08, -0.22],
          [0.1, -0.22],
          [0.26, 0.32],
          [0.04, 0.38]
        ],
        0.09,
        0.016,
        {
          pos: [s * 0.62, 1.68, 0.6],
          rot: [0.22, s * -0.24, s * -0.26],
          tint: TINT_ARMOR_CRIMSON
        }
      )
    );
    frame.push(
      buildCylinder(0.082, 0.102, 0.44, 10, {
        pos: [s * 0.44, 1.82, 0.54],
        rot: [0.14, 0, s * -0.1],
        tint: TINT_FRAME_DARK
      }),
      buildCylinder(0.112, 0.112, 0.07, 10, {
        pos: [s * 0.46, 2, 0.57],
        rot: [0.14, 0, s * -0.1],
        tint: TINT_FRAME_MID
      }),
      // Lower thruster exhaust nozzle bell
      buildCylinder(0.11, 0.17, 0.24, 10, {
        pos: [s * 0.46, 0.68, 0.56],
        rot: [0.26, 0, s * -0.06],
        tint: TINT_FRAME_MID
      }),
      // Ribbed armored power conduit arching from backpack over shoulder drum
      buildArmoredConduit(
        [
          [s * 0.5, 1.54, 0.34],
          [s * 0.68, 1.5, 0.14],
          [s * 0.8, 1.38, 0.02]
        ],
        0.048,
        10,
        7,
        TINT_FRAME_DARK
      )
    );
    frame.push(
      ...buildLouverBank(0.26, 0.44, 0.1, 5, [s * 0.48, 1.24, 0.72], [0.06, s * -0.1, 0], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.22, 0.42, 0.05, 8e-3, {
        pos: [s * 0.48, 1.24, 0.69],
        rot: [0.06, s * -0.1, 0],
        tint: TINT_CORE_HOT,
        band: UV_BAND_MECH
      }),
      buildCylinder(0.09, 0.11, 0.07, 10, {
        pos: [s * 0.46, 0.62, 0.58],
        rot: [0.26, 0, s * -0.06],
        tint: TINT_CORE_HOT,
        band: UV_BAND_ENERGY
      })
    );
  }
  core.push(
    // Front deeply recessed inner reactor turbine drum (behind armored cage bars!)
    buildCylinder(0.2, 0.2, 0.12, 14, {
      pos: [0, 0, -0.45],
      rot: [Math.PI * 0.5, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_ENERGY
    }),
    // Rear deeply recessed dorsal reactor turbine drum (matches back-core weakpoint!)
    buildCylinder(0.19, 0.19, 0.12, 14, {
      pos: [0, 0.02, 0.6],
      rot: [Math.PI * 0.5, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_ENERGY
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    core: mergeStrict(core),
    vent: mergeStrict(vent)
  };
}
function buildHeadParts() {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.13, 0.16, 0.2, 10, { pos: [0, 0.04, 0.02], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.12, -0.04, -0.02], [-0.13, 0.15, -0.06], 0.028, 0.016, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.12, -0.04, -0.02], [0.13, 0.15, -0.06], 0.028, 0.016, TINT_PISTON_CHROME)
  );
  frame.push(
    buildCylinder(0.185, 0.185, 0.12, 14, { pos: [0, 0.26, -0.03], tint: [0.05, 0.06, 0.08] }),
    // Thin vertical center visor pillar framing the cyclops bay
    buildChamferBox(0.036, 0.12, 0.06, 6e-3, { pos: [0, 0.14, -0.21], tint: TINT_FRAME_MID })
  );
  armor.push(
    // Sloped titanium top helmet dome angled forward-down over visor slit
    buildArmoredFrustum(0.44, 0.48, 0.34, 0.4, 0.18, -0.04, 0, {
      pos: [0, 0.4, -0.01],
      rot: [0.14, 0, 0],
      tint: TINT_ARMOR_LIGHT
    }),
    // Sharp angled V-brow crimson visor wings (menacing heavy combat mech scowl!)
    buildChamferBox(0.22, 0.075, 0.2, 0.012, {
      pos: [-0.11, 0.345, -0.17],
      rot: [0.22, 0.1, -0.16],
      tint: TINT_ARMOR_CRIMSON
    }),
    buildChamferBox(0.22, 0.075, 0.2, 0.012, {
      pos: [0.11, 0.345, -0.17],
      rot: [0.22, -0.1, 0.16],
      tint: TINT_ARMOR_CRIMSON
    }),
    // Rear heavy helmet occiput armor shell
    buildArmoredFrustum(0.42, 0.28, 0.36, 0.24, 0.28, 0.02, 0, {
      pos: [0, 0.26, 0.12],
      tint: TINT_ARMOR_MAIN
    }),
    // Angular armored lower jaw / muzzle breathing grille block
    buildArmoredFrustum(0.3, 0.28, 0.36, 0.32, 0.15, -0.04, 0, {
      pos: [0, 0.12, -0.09],
      tint: TINT_ARMOR_MAIN
    }),
    buildChamferBox(0.18, 0.085, 0.14, 0.014, { pos: [0, 0.11, -0.22], tint: TINT_ARMOR_LIGHT }),
    // Swept-back tactical commander sensor crest fin reaching local y = +0.62 (world y = 4.10m!)
    buildSlopedPlate(
      [
        [-0.2, 0],
        [0.14, 0],
        [0.2, 0.15],
        [-0.08, 0.18]
      ],
      0.08,
      0.014,
      {
        pos: [0, 0.44, 0.04],
        rot: [0, Math.PI * 0.5, 0],
        tint: TINT_ARMOR_CRIMSON
      }
    )
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildChamferBox(0.1, 0.22, 0.36, 0.018, {
        pos: [s * 0.21, 0.22, -0.02],
        rot: [0.06, s * -0.14, s * 0.1],
        tint: TINT_ARMOR_MAIN
      })
    );
    frame.push(
      buildCylinder(0.072, 0.072, 0.1, 10, {
        pos: [s * 0.25, 0.26, 0.04],
        rot: [0, 0, Math.PI * 0.5],
        tint: TINT_FRAME_MID
      }),
      ...s === 1 ? [
        buildCylinder(0.014, 0.022, 0.22, 6, {
          pos: [0.25, 0.42, 0.08],
          rot: [-0.18, 0, -0.08],
          tint: TINT_FRAME_MID
        })
      ] : []
    );
  }
  const lensSphere = new THREE.SphereGeometry(0.052, 12, 10);
  lensSphere.scale(1, 0.94, 0.62);
  lensSphere.translate(0, 0, -0.194);
  const monoEye = mergeStrict([
    finalizePart(lensSphere, { faceted: false, band: UV_BAND_ENERGY, tint: [1, 1, 1] }),
    // Tight precision laser-rangefinder optical slit flanking the cyclops lens
    buildChamferBox(0.15, 0.02, 0.028, 4e-3, {
      pos: [0, 0, -0.182],
      tint: [0.78, 0.78, 0.78],
      band: UV_BAND_ENERGY
    })
  ]);
  const monoEyeBezel = buildCylinder(0.068, 0.072, 0.045, 12, {
    pos: [0, 0, -0.184],
    rot: [Math.PI * 0.5, 0, 0],
    tint: TINT_FRAME_MID
  });
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    monoEye,
    monoEyeBezel
  };
}
function buildShoulderPauldron(side) {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.2, 0.2, 0.28, 12, {
      pos: [side * 0.04, 0, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_DARK
    }),
    buildChamferBox(0.36, 0.2, 0.52, 0.02, {
      pos: [side * 0.14, 0.16, 0],
      rot: [0, 0, side * -0.18],
      tint: TINT_FRAME_MID
    })
  );
  if (side === -1) {
    armor.push(
      // Sweeping deep-gunmetal armored shoulder hood wrapping seamlessly over shoulder drum
      buildArmoredFrustum(0.58, 0.8, 0.46, 0.66, 0.46, 0, -0.06, {
        pos: [-0.14, 0.18, 0],
        rot: [0, 0, 0.2],
        tint: TINT_ARMOR_MAIN
      }),
      // Cold titanium upper armored cap
      buildChamferBox(0.44, 0.14, 0.64, 0.026, {
        pos: [-0.14, 0.4, 0],
        rot: [0, 0, 0.26],
        tint: TINT_ARMOR_LIGHT
      }),
      // Tall angled fortress buckler riot-shield slab bolted tightly to outer pauldron
      buildSlopedPlate(
        [
          [-0.38, -0.44],
          [0.38, -0.44],
          [0.3, 0.48],
          [-0.3, 0.48]
        ],
        0.15,
        0.026,
        {
          pos: [-0.42, 0.02, 0],
          rot: [0, Math.PI * 0.5, 0.14],
          tint: TINT_ARMOR_LIGHT
        }
      ),
      // Matte crimson-oxide command stripe boss down center of shield
      buildChamferBox(0.09, 0.56, 0.3, 0.018, {
        pos: [-0.49, 0.04, 0],
        rot: [0, 0, 0.14],
        tint: TINT_ARMOR_CRIMSON
      }),
      // Bolted ERA reactive dark gunmetal edge guards
      buildChamferBox(0.09, 0.2, 0.52, 0.016, {
        pos: [-0.48, 0.34, 0],
        rot: [0, 0, 0.14],
        tint: TINT_ARMOR_DARK
      }),
      // Caution hazard band across lower shield lip
      buildChamferBox(0.09, 0.12, 0.6, 0.012, {
        pos: [-0.47, -0.28, 0],
        rot: [0, 0, 0.14],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 1
      })
    );
    frame.push(
      buildChamferBox(0.24, 0.12, 0.18, 0.014, { pos: [-0.3, 0.16, -0.18], tint: TINT_FRAME_MID }),
      buildChamferBox(0.24, 0.12, 0.18, 0.014, { pos: [-0.3, 0.16, 0.18], tint: TINT_FRAME_MID }),
      ...buildLouverBank(0.24, 0.18, 0.08, 3, [-0.18, 0.2, -0.38], [0, 0, 0.2], TINT_FRAME_MID),
      ...buildLouverBank(0.24, 0.18, 0.08, 3, [-0.18, 0.2, 0.38], [0, 0, 0.2], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.2, 0.14, 0.05, 8e-3, { pos: [-0.18, 0.2, -0.35], rot: [0, 0, 0.2], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
      buildChamferBox(0.2, 0.14, 0.05, 8e-3, { pos: [-0.18, 0.2, 0.35], rot: [0, 0, 0.2], tint: TINT_CORE_HOT, band: UV_BAND_MECH })
    );
  } else {
    armor.push(
      buildArmoredFrustum(0.6, 0.76, 0.46, 0.62, 0.42, 0, 0.08, {
        pos: [0.14, 0.16, 0],
        rot: [0, 0, -0.24],
        tint: TINT_ARMOR_MAIN
      }),
      // Swept crimson-oxide upper vanguard ridge
      buildChamferBox(0.46, 0.14, 0.58, 0.024, {
        pos: [0.18, 0.37, 0],
        rot: [0, 0, -0.3],
        tint: TINT_ARMOR_CRIMSON
      }),
      // Angled titanium outer shoulder winglet fairing (clear of high blade arc!)
      buildSlopedPlate(
        [
          [-0.3, -0.26],
          [0.3, -0.26],
          [0.24, 0.26],
          [-0.24, 0.26]
        ],
        0.14,
        0.024,
        {
          pos: [0.42, 0, 0],
          rot: [0, Math.PI * 0.5, -0.4],
          tint: TINT_ARMOR_LIGHT
        }
      ),
      buildChamferBox(0.28, 0.1, 0.52, 0.012, {
        pos: [0.4, 0.2, 0],
        rot: [0, 0, -0.32],
        tint: TINT_HAZARD,
        band: UV_BAND_HAZARD,
        uvScale: 0.9
      })
    );
    frame.push(
      ...buildHydraulicPiston([0.04, 0.32, -0.22], [0.4, 0.12, -0.24], 0.042, 0.024, TINT_PISTON_BRASS),
      ...buildHydraulicPiston([0.04, 0.32, 0.22], [0.4, 0.12, 0.24], 0.042, 0.024, TINT_PISTON_BRASS),
      ...buildLouverBank(0.22, 0.16, 0.08, 3, [0.18, 0.18, -0.36], [0, 0, -0.24], TINT_FRAME_MID),
      ...buildLouverBank(0.22, 0.16, 0.08, 3, [0.18, 0.18, 0.36], [0, 0, -0.24], TINT_FRAME_MID)
    );
    vent.push(
      buildChamferBox(0.2, 0.13, 0.05, 8e-3, { pos: [0.18, 0.18, -0.33], rot: [0, 0, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
      buildChamferBox(0.2, 0.13, 0.05, 8e-3, { pos: [0.18, 0.18, 0.33], rot: [0, 0, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_MECH })
    );
  }
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent)
  };
}
function buildUpperArmParts(side) {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.145, 0.135, 0.78, 12, { pos: [side * 0.05, -0.39, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston(
      [side * 0.04, -0.06, -0.16],
      [side * 0.08, -0.7, -0.14],
      0.048,
      0.028,
      TINT_PISTON_CHROME
    ),
    ...buildHydraulicPiston(
      [side * 0.04, -0.08, 0.16],
      [side * 0.08, -0.7, 0.14],
      0.044,
      0.026,
      TINT_PISTON_BRASS
    ),
    buildCylinder(0.17, 0.17, 0.36, 12, {
      pos: [side * 0.08, -0.78, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID
    })
  );
  armor.push(
    buildArmoredFrustum(0.32, 0.34, 0.38, 0.38, 0.48, 0, 0, {
      pos: [side * 0.08, -0.38, 0],
      tint: TINT_ARMOR_MAIN
    }),
    buildChamferBox(0.1, 0.42, 0.24, 0.018, {
      pos: [side * 0.25, -0.38, 0],
      tint: TINT_ARMOR_LIGHT
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function buildLeftForearmParts() {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.13, 0.15, 0.72, 12, { pos: [0, -0.36, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.14, -0.06, -0.12], [-0.16, -0.68, -0.14], 0.046, 0.026, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.1, -0.06, 0.12], [0.12, -0.68, 0.12], 0.042, 0.024, TINT_PISTON_BRASS),
    buildCylinder(0.15, 0.15, 0.12, 12, { pos: [0, -0.76, 0], tint: TINT_FRAME_MID })
  );
  armor.push(
    buildChamferBox(0.34, 0.24, 0.3, 0.024, { pos: [-0.02, -0.08, 0.14], rot: [0.22, 0, 0], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.42, 0.44, 0.36, 0.38, 0.66, 0, 0, { pos: [-0.02, -0.4, 0], tint: TINT_ARMOR_MAIN }),
    // Heavy outer forearm buckler ram-shield
    buildSlopedPlate(
      [
        [-0.24, -0.44],
        [0.24, -0.36],
        [0.24, 0.34],
        [-0.22, 0.42]
      ],
      0.12,
      0.022,
      {
        pos: [-0.24, -0.42, -0.04],
        rot: [0, Math.PI * 0.5, 0],
        tint: TINT_ARMOR_LIGHT
      }
    ),
    buildChamferBox(0.08, 0.42, 0.18, 0.014, { pos: [-0.3, -0.42, -0.04], tint: TINT_ARMOR_CRIMSON }),
    buildChamferBox(0.42, 0.11, 0.46, 0.014, {
      pos: [-0.02, -0.66, 0],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.9
    })
  );
  vent.push(
    buildChamferBox(0.06, 0.26, 0.16, 8e-3, {
      pos: [-0.19, -0.34, 0.14],
      tint: TINT_CORE_HOT,
      band: UV_BAND_MECH
    })
  );
  armor.push(
    buildChamferBox(0.28, 0.22, 0.34, 0.022, { pos: [0, -0.88, -0.02], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.32, 0.1, 0.38, 0.016, { pos: [-0.02, -0.96, -0.04], tint: TINT_ARMOR_LIGHT })
  );
  for (let i = 0; i < 3; i++) {
    const fz = -0.12 + i * 0.11;
    frame.push(
      buildChamferBox(0.09, 0.16, 0.085, 0.012, { pos: [-0.09, -1.04, fz], rot: [0, 0, 0.22], tint: TINT_FRAME_MID }),
      buildChamferBox(0.085, 0.14, 0.08, 0.01, { pos: [-0.02, -1.14, fz], rot: [0, 0, 0.85], tint: TINT_FRAME_DARK })
    );
  }
  frame.push(
    buildChamferBox(0.11, 0.15, 0.1, 0.014, { pos: [0.11, -0.96, -0.16], rot: [0.3, 0, -0.45], tint: TINT_FRAME_MID }),
    buildChamferBox(0.09, 0.12, 0.09, 0.01, { pos: [0.06, -1.06, -0.2], rot: [0.45, 0, -0.95], tint: TINT_FRAME_DARK })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent)
  };
}
function buildRightForearmAndBladeParts() {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.14, 0.16, 0.78, 12, { pos: [0, -0.39, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([0.16, -0.06, 0.12], [0.18, -0.74, 0.12], 0.048, 0.028, TINT_PISTON_BRASS),
    ...buildHydraulicPiston([-0.12, -0.08, -0.1], [-0.14, -0.72, -0.12], 0.044, 0.026, TINT_PISTON_CHROME),
    buildArmoredConduit(
      [
        [0.14, -0.04, 0.16],
        [0.24, -0.26, 0.18],
        [0.22, -0.52, 0.02],
        [0.16, -0.72, -0.16]
      ],
      0.038,
      10,
      7,
      TINT_FRAME_DARK
    )
  );
  armor.push(
    buildChamferBox(0.36, 0.28, 0.34, 0.026, { pos: [0.02, -0.08, 0.14], rot: [0.2, 0, 0], tint: TINT_ARMOR_DARK }),
    buildArmoredFrustum(0.44, 0.48, 0.38, 0.4, 0.74, -0.02, 0, { pos: [0.02, -0.42, -0.02], tint: TINT_ARMOR_MAIN }),
    // Sleek crimson-oxide + titanium emitter cowling plates
    buildChamferBox(0.13, 0.64, 0.36, 0.022, { pos: [0.22, -0.44, -0.04], tint: TINT_ARMOR_CRIMSON }),
    buildChamferBox(0.28, 0.48, 0.1, 0.018, { pos: [0.02, -0.36, -0.25], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.44, 0.11, 0.5, 0.014, {
      pos: [0.02, -0.73, -0.04],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.9
    })
  );
  frame.push(
    ...buildLouverBank(0.08, 0.34, 0.18, 5, [0.24, -0.42, 0.12], [0, 0, 0], TINT_FRAME_MID)
  );
  vent.push(
    buildChamferBox(0.06, 0.34, 0.16, 8e-3, { pos: [0.2, -0.42, 0.12], tint: TINT_CORE_HOT, band: UV_BAND_MECH }),
    buildChamferBox(0.2, 0.14, 0.06, 8e-3, { pos: [0.02, -0.58, -0.24], tint: TINT_CORE_HOT, band: UV_BAND_ENERGY })
  );
  const spineParts = [
    // Tapered emitter muzzle housing clamping the plasma blade root
    buildChamferBox(0.24, 0.24, 0.3, 0.022, { pos: [0, -0.04, 0.02], tint: TINT_ARMOR_DARK }),
    // Forward & rear angular emitter focus prongs
    buildChamferBox(0.14, 0.3, 0.09, 0.014, { pos: [0, -0.22, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.12, 0.2, 0.08, 0.012, { pos: [0, -0.16, -0.12], tint: TINT_ARMOR_CRIMSON }),
    // Sleek notched dark-gunmetal mechanical blade spine extending cleanly down back edge
    buildChamferBox(0.056, 1.24, 0.075, 0.01, { pos: [0, -0.66, 0.06], tint: TINT_ARMOR_MAIN }),
    // 4 sharp cooling fin teeth along mechanical blade spine
    buildChamferBox(0.082, 0.1, 0.05, 8e-3, { pos: [0, -0.4, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.082, 0.1, 0.05, 8e-3, { pos: [0, -0.64, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.078, 0.1, 0.05, 8e-3, { pos: [0, -0.88, 0.1], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.07, 0.09, 0.04, 7e-3, { pos: [0, -1.1, 0.09], tint: TINT_ARMOR_LIGHT }),
    // Twin slim machined brass plasma containment rails flanking blade spine
    buildCylinder(0.013, 0.01, 1.02, 8, { pos: [0.036, -0.58, 0.02], tint: TINT_PISTON_BRASS }),
    buildCylinder(0.013, 0.01, 1.02, 8, { pos: [-0.036, -0.58, 0.02], tint: TINT_PISTON_BRASS })
  ];
  const bladePlasma = buildPlasmaBladeGeometry(1.54, 0.21, 0.03);
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent),
    bladeSpine: mergeStrict(spineParts),
    bladePlasma
  };
}
function buildPelvisParts() {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.17, 0.17, 1.12, 12, {
      pos: [0, -0.04, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_DARK
    }),
    buildChamferBox(0.72, 0.28, 0.52, 0.024, { pos: [0, 0.04, 0], tint: TINT_FRAME_DARK })
  );
  armor.push(
    buildArmoredFrustum(0.32, 0.38, 0.44, 0.48, 0.44, -0.06, 0, { pos: [0, -0.04, -0.14], tint: TINT_ARMOR_MAIN }),
    buildChamferBox(0.28, 0.26, 0.14, 0.022, { pos: [0, 0.02, -0.36], rot: [0.18, 0, 0], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.22, 0.08, 0.1, 0.01, {
      pos: [0, -0.16, -0.35],
      rot: [0.18, 0, 0],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 0.7
    }),
    // Rear heavy armored bustle bumper (pure hard-surface mech, zero tail)
    buildArmoredFrustum(0.46, 0.34, 0.58, 0.38, 0.36, 0.06, 0, { pos: [0, 0.02, 0.26], tint: TINT_ARMOR_DARK }),
    buildChamferBox(0.4, 0.14, 0.14, 0.02, { pos: [0, 0.1, 0.44], rot: [-0.16, 0, 0], tint: TINT_ARMOR_LIGHT })
  );
  for (const s of [-1, 1]) {
    armor.push(
      buildSlopedPlate(
        [
          [-0.17, -0.18],
          [0.17, -0.14],
          [0.16, 0.18],
          [-0.16, 0.18]
        ],
        0.1,
        0.018,
        {
          pos: [s * 0.42, -0.01, -0.39],
          rot: [-0.36, s * 0.2, s * -0.12],
          tint: TINT_ARMOR_MAIN
        }
      ),
      buildChamferBox(0.14, 0.4, 0.52, 0.022, {
        pos: [s * 0.64, -0.01, 0.02],
        rot: [0, 0, s * -0.22],
        tint: TINT_ARMOR_TRIM
      }),
      buildChamferBox(0.32, 0.36, 0.11, 0.02, {
        pos: [s * 0.38, -0.04, 0.37],
        rot: [0.24, s * -0.14, s * -0.08],
        tint: TINT_ARMOR_MAIN
      })
    );
  }
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function buildThighParts(side) {
  const armor = [];
  const frame = [];
  frame.push(
    buildCylinder(0.16, 0.15, 0.86, 12, { pos: [0, -0.44, 0], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([0, -0.06, -0.22], [0, -0.8, -0.2], 0.054, 0.03, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, -0.08, 0.22], [0, -0.8, 0.2], 0.052, 0.03, TINT_PISTON_BRASS),
    // Prominent rotary knee hub drum
    buildCylinder(0.19, 0.19, 0.46, 14, {
      pos: [0, -THIGH_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID
    }),
    buildCylinder(0.11, 0.12, 0.52, 10, {
      pos: [0, -THIGH_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_PISTON_BRASS
    })
  );
  armor.push(
    buildArmoredFrustum(0.36, 0.38, 0.48, 0.5, 0.72, -0.05, side * 0.04, {
      pos: [0, -0.42, -0.02],
      tint: TINT_ARMOR_MAIN
    }),
    // High-contrast cold titanium sloped front thigh glacis
    buildChamferBox(0.3, 0.54, 0.14, 0.024, {
      pos: [0, -0.42, -0.25],
      rot: [-0.1, 0, 0],
      tint: TINT_ARMOR_LIGHT
    }),
    // Outer armored thigh shield plate with crimson trim stripe
    buildChamferBox(0.14, 0.6, 0.42, 0.024, {
      pos: [side * 0.24, -0.44, 0.02],
      rot: [0, 0, side * -0.1],
      tint: TINT_ARMOR_TRIM
    }),
    buildChamferBox(0.08, 0.32, 0.22, 0.014, {
      pos: [side * 0.29, -0.34, 0.02],
      rot: [0, 0, side * -0.1],
      tint: TINT_ARMOR_CRIMSON
    }),
    buildChamferBox(0.34, 0.56, 0.14, 0.022, {
      pos: [0, -0.42, 0.22],
      tint: TINT_ARMOR_DARK
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function buildShinParts(side) {
  const armor = [];
  const frame = [];
  const vent = [];
  frame.push(
    buildCylinder(0.15, 0.14, 0.78, 12, { pos: [0, -0.4, 0.02], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([side * 0.24, -0.04, 0.04], [side * 0.27, -0.74, 0.02], 0.05, 0.028, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, -0.1, 0.28], [0, -0.76, 0.22], 0.058, 0.034, TINT_PISTON_BRASS),
    buildCylinder(0.155, 0.155, 0.44, 12, {
      pos: [0, -SHIN_LEN, 0],
      rot: [0, 0, Math.PI * 0.5],
      tint: TINT_FRAME_MID
    })
  );
  armor.push(
    buildSlopedPlate(
      [
        [-0.2, -0.2],
        [0.2, -0.2],
        [0.26, 0.08],
        [0.14, 0.28],
        [-0.14, 0.28],
        [-0.26, 0.08]
      ],
      0.16,
      0.026,
      {
        pos: [0, 0.04, -0.28],
        rot: [0.16, 0, 0],
        tint: TINT_ARMOR_LIGHT
      }
    ),
    buildChamferBox(0.22, 0.16, 0.1, 0.016, { pos: [0, 0.06, -0.36], rot: [0.16, 0, 0], tint: TINT_ARMOR_CRIMSON })
  );
  armor.push(
    buildArmoredFrustum(0.54, 0.54, 0.36, 0.38, 0.66, 0.06, side * -0.04, {
      pos: [0, -0.45, -0.03],
      tint: TINT_ARMOR_MAIN
    }),
    // Sloped forward titanium shin glacis apron
    buildSlopedPlate(
      [
        [-0.22, -0.28],
        [0.22, -0.28],
        [0.15, 0.28],
        [-0.15, 0.28]
      ],
      0.14,
      0.024,
      {
        pos: [0, -0.44, -0.26],
        rot: [0.14, 0, 0],
        tint: TINT_ARMOR_LIGHT
      }
    ),
    // Weathered hazard band across flared ankle cuff
    buildChamferBox(0.52, 0.1, 0.52, 0.014, {
      pos: [0, -0.68, -0.04],
      tint: TINT_HAZARD,
      band: UV_BAND_HAZARD,
      uvScale: 1
    }),
    // Angled outer calf thruster housing
    buildChamferBox(0.14, 0.46, 0.38, 0.022, {
      pos: [side * 0.28, -0.42, 0.1],
      rot: [0, 0, side * -0.14],
      tint: TINT_ARMOR_TRIM
    }),
    // Heavy rear calf armored bumper shroud
    buildChamferBox(0.38, 0.44, 0.16, 0.022, {
      pos: [0, -0.38, 0.28],
      rot: [-0.14, 0, 0],
      tint: TINT_ARMOR_DARK
    })
  );
  frame.push(
    ...buildLouverBank(0.24, 0.22, 0.07, 4, [0, -0.36, 0.36], [-0.14, 0, 0], TINT_FRAME_MID)
  );
  vent.push(
    buildChamferBox(0.2, 0.2, 0.05, 8e-3, {
      pos: [0, -0.36, 0.34],
      rot: [-0.14, 0, 0],
      tint: TINT_CORE_HOT,
      band: UV_BAND_MECH
    })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame),
    vent: mergeStrict(vent)
  };
}
function buildFootParts(side) {
  const armor = [];
  const frame = [];
  frame.push(
    buildChamferBox(0.54, 0.08, 0.78, 0.012, { pos: [0, FOOT_SOLE_Y + 0.04, -0.08], tint: TINT_FRAME_DARK }),
    ...buildHydraulicPiston([-0.15, 0.02, -0.14], [-0.17, -0.14, -0.34], 0.038, 0.022, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0.15, 0.02, -0.14], [0.17, -0.14, -0.34], 0.038, 0.022, TINT_PISTON_CHROME),
    ...buildHydraulicPiston([0, 0.02, 0.16], [0, -0.14, 0.28], 0.042, 0.024, TINT_PISTON_BRASS)
  );
  armor.push(
    buildChamferBox(0.48, 0.14, 0.46, 0.022, { pos: [0, FOOT_SOLE_Y + 0.14, -0.06], rot: [0.14, 0, 0], tint: TINT_ARMOR_MAIN }),
    // Twin wide armored mechanical front toe-clamps (strictly flush at y = -0.24!)
    buildChamferBox(0.24, 0.13, 0.38, 0.02, { pos: [-0.15, FOOT_SOLE_Y + 0.065, -0.34], tint: TINT_ARMOR_LIGHT }),
    buildChamferBox(0.24, 0.13, 0.38, 0.02, { pos: [0.15, FOOT_SOLE_Y + 0.065, -0.34], tint: TINT_ARMOR_LIGHT }),
    // Heavy rear armored heel anchor spur (strictly flush at y = -0.24!)
    buildChamferBox(0.4, 0.14, 0.26, 0.02, { pos: [0, FOOT_SOLE_Y + 0.07, 0.26], tint: TINT_ARMOR_DARK }),
    // Outer ankle armored fender guard
    buildChamferBox(0.11, 0.18, 0.36, 0.016, { pos: [side * 0.27, FOOT_SOLE_Y + 0.16, -0.04], tint: TINT_ARMOR_TRIM })
  );
  return {
    armor: mergeStrict(armor),
    frame: mergeStrict(frame)
  };
}
function makeNeutralPose() {
  return {
    torso: [0, 0, 0],
    head: [0, 0, 0],
    leftShoulder: [0, 0, 0],
    rightShoulder: [0, 0, 0],
    leftArm: [0, 0, 0],
    elbowL: [0, 0, 0],
    rightArm: [0, 0, 0],
    elbowR: [0, 0, 0],
    hips: [0, 0, 0],
    thighL: [0, 0, 0],
    shinL: [0, 0, 0],
    footL: [0, 0, 0],
    thighR: [0, 0, 0],
    shinR: [0, 0, 0],
    footR: [0, 0, 0]
  };
}
var SEAM_EMISSIVE_P1 = new THREE.Color("#CC4610");
var SEAM_EMISSIVE_P2 = new THREE.Color("#FF7C1C");
var CORE_EMISSIVE_P1 = new THREE.Color("#FF5212");
var CORE_EMISSIVE_P2 = new THREE.Color("#FF9B2E");
var EYE_EMISSIVE_P1 = new THREE.Color("#FF280C");
var EYE_EMISSIVE_P2 = new THREE.Color("#FF6A1C");
var BLADE_EMISSIVE_P1 = new THREE.Color("#FF6016");
var BLADE_EMISSIVE_P2 = new THREE.Color("#FFB842");
function createBossModel() {
  const atlas = createMechAtlas();
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
  const armorMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#CFD6DF"),
      map: atlas.albedoMap,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      emissive: SEAM_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 0.03,
      metalness: 0.72,
      roughness: 0.36,
      vertexColors: true
    })
  );
  const frameMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#C8D0DA"),
      map: atlas.albedoMap,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
      metalness: 0.88,
      roughness: 0.24,
      vertexColors: true
    })
  );
  const coreMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#280E05"),
      map: atlas.albedoMap,
      emissive: CORE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.38,
      normalMap: atlas.normalMap,
      normalScale: new THREE.Vector2(0.75, 0.75),
      metalness: 0.25,
      roughness: 0.4,
      vertexColors: true
    })
  );
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#2A0503"),
      emissive: EYE_EMISSIVE_P1.clone(),
      emissiveIntensity: 2.55,
      metalness: 0.12,
      roughness: 0.18
    })
  );
  const bladeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color("#381408"),
      map: atlas.albedoMap,
      emissive: BLADE_EMISSIVE_P1.clone(),
      emissiveMap: atlas.emissiveMap,
      emissiveIntensity: 1.65,
      metalness: 0.15,
      roughness: 0.22,
      vertexColors: true
    })
  );
  const makeMesh = (geo, mat, name, castShadow = true) => {
    const mesh = new THREE.Mesh(trackGeo(geo), mat);
    mesh.name = name;
    mesh.castShadow = castShadow;
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
  const torsoParts = buildTorsoParts();
  torso.add(makeMesh(torsoParts.armor, armorMat, "boss-torso-armor"));
  torso.add(makeMesh(torsoParts.frame, frameMat, "boss-torso-frame"));
  const ventGlow = new THREE.Group();
  ventGlow.name = "boss-vent-glow";
  ventGlow.add(makeMesh(torsoParts.vent, coreMat, "boss-torso-vents", false));
  torso.add(ventGlow);
  const core = makeMesh(torsoParts.core, coreMat, "boss-core", false);
  core.position.set(0, 0.96, 0);
  torso.add(core);
  const head = new THREE.Group();
  head.name = "boss-head";
  head.position.set(0, 1.52, -0.12);
  torso.add(head);
  const headParts = buildHeadParts();
  head.add(makeMesh(headParts.armor, armorMat, "boss-head-armor"));
  head.add(makeMesh(headParts.frame, frameMat, "boss-head-frame"));
  const monoEye = new THREE.Group();
  monoEye.name = "boss-mono-eye";
  monoEye.position.set(0, 0.26, -0.03);
  monoEye.add(makeMesh(headParts.monoEyeBezel, frameMat, "boss-mono-eye-bezel", false));
  monoEye.add(makeMesh(headParts.monoEye, eyeMat, "boss-mono-eye-lens", false));
  head.add(monoEye);
  const leftShoulder = new THREE.Group();
  leftShoulder.name = "boss-pauldron-l";
  leftShoulder.position.set(-0.82, 1.28, 0);
  torso.add(leftShoulder);
  const pauldronL = buildShoulderPauldron(-1);
  leftShoulder.add(makeMesh(pauldronL.armor, armorMat, "boss-pauldron-armor-l"));
  leftShoulder.add(makeMesh(pauldronL.frame, frameMat, "boss-pauldron-frame-l"));
  leftShoulder.add(makeMesh(pauldronL.vent, coreMat, "boss-pauldron-vent-l", false));
  const rightShoulder = new THREE.Group();
  rightShoulder.name = "boss-pauldron-r";
  rightShoulder.position.set(0.82, 1.28, 0);
  torso.add(rightShoulder);
  const pauldronR = buildShoulderPauldron(1);
  rightShoulder.add(makeMesh(pauldronR.armor, armorMat, "boss-pauldron-armor-r"));
  rightShoulder.add(makeMesh(pauldronR.frame, frameMat, "boss-pauldron-frame-r"));
  rightShoulder.add(makeMesh(pauldronR.vent, coreMat, "boss-pauldron-vent-r", false));
  const leftArm = new THREE.Group();
  leftArm.name = "boss-shoulder-l";
  leftArm.position.set(-0.92, 1.28, 0);
  torso.add(leftArm);
  const upperArmL = buildUpperArmParts(-1);
  leftArm.add(makeMesh(upperArmL.armor, armorMat, "boss-upper-arm-armor-l"));
  leftArm.add(makeMesh(upperArmL.frame, frameMat, "boss-upper-arm-frame-l"));
  const elbowL = new THREE.Group();
  elbowL.name = "boss-elbow-l";
  elbowL.position.set(-0.08, -0.78, 0);
  elbowL.rotation.set(0.32, 0, 0);
  leftArm.add(elbowL);
  const foreArmL = buildLeftForearmParts();
  elbowL.add(makeMesh(foreArmL.armor, armorMat, "boss-forearm-armor-l"));
  elbowL.add(makeMesh(foreArmL.frame, frameMat, "boss-forearm-frame-l"));
  elbowL.add(makeMesh(foreArmL.vent, coreMat, "boss-forearm-vent-l", false));
  const rightArm = new THREE.Group();
  rightArm.name = "boss-shoulder-r";
  rightArm.position.set(0.92, 1.28, 0);
  torso.add(rightArm);
  const upperArmR = buildUpperArmParts(1);
  rightArm.add(makeMesh(upperArmR.armor, armorMat, "boss-upper-arm-armor-r"));
  rightArm.add(makeMesh(upperArmR.frame, frameMat, "boss-upper-arm-frame-r"));
  const elbowR = new THREE.Group();
  elbowR.name = "boss-elbow-r";
  elbowR.position.set(0.08, -0.78, 0);
  elbowR.rotation.set(0.38, 0, 0);
  rightArm.add(elbowR);
  const foreArmR = buildRightForearmAndBladeParts();
  elbowR.add(makeMesh(foreArmR.armor, armorMat, "boss-forearm-armor-r"));
  elbowR.add(makeMesh(foreArmR.frame, frameMat, "boss-forearm-frame-r"));
  elbowR.add(makeMesh(foreArmR.vent, coreMat, "boss-forearm-vent-r", false));
  const rightBlade = new THREE.Group();
  rightBlade.name = "boss-right-blade";
  rightBlade.position.set(0.04, -0.68, -0.06);
  rightBlade.rotation.set(0.34, 0, 0);
  rightBlade.add(makeMesh(foreArmR.bladeSpine, armorMat, "boss-blade-spine"));
  rightBlade.add(makeMesh(foreArmR.bladePlasma, bladeMat, "boss-blade-plasma", false));
  elbowR.add(rightBlade);
  const hips = new THREE.Group();
  hips.name = "boss-hips";
  body.add(hips);
  const pelvisParts = buildPelvisParts();
  hips.add(makeMesh(pelvisParts.armor, armorMat, "boss-pelvis-armor"));
  hips.add(makeMesh(pelvisParts.frame, frameMat, "boss-pelvis-frame"));
  const buildLegChain = (side, tag) => {
    const thigh = new THREE.Group();
    thigh.name = `boss-thigh-${tag}`;
    thigh.position.set(side * 0.5, -0.04, 0);
    hips.add(thigh);
    const thighParts = buildThighParts(side);
    thigh.add(makeMesh(thighParts.armor, armorMat, `boss-thigh-armor-${tag}`));
    thigh.add(makeMesh(thighParts.frame, frameMat, `boss-thigh-frame-${tag}`));
    const shin = new THREE.Group();
    shin.name = `boss-shin-${tag}`;
    shin.position.set(0, -THIGH_LEN, 0);
    thigh.add(shin);
    const shinParts = buildShinParts(side);
    shin.add(makeMesh(shinParts.armor, armorMat, `boss-shin-armor-${tag}`));
    shin.add(makeMesh(shinParts.frame, frameMat, `boss-shin-frame-${tag}`));
    shin.add(makeMesh(shinParts.vent, coreMat, `boss-shin-vent-${tag}`, false));
    const foot = new THREE.Group();
    foot.name = `boss-foot-${tag}`;
    foot.position.set(0, -SHIN_LEN, 0);
    shin.add(foot);
    const footParts = buildFootParts(side);
    foot.add(makeMesh(footParts.armor, armorMat, `boss-foot-armor-${tag}`));
    foot.add(makeMesh(footParts.frame, frameMat, `boss-foot-frame-${tag}`));
    return { thigh, shin, foot };
  };
  const legL = buildLegChain(-1, "l");
  const legR = buildLegChain(1, "r");
  root.updateMatrixWorld(true);
  const initBox = new THREE.Box3().setFromObject(root);
  const baseHipOffsetY = Number.isFinite(initBox.min.y) ? BASE_HIP_Y - initBox.min.y : BASE_HIP_Y;
  body.position.y = baseHipOffsetY;
  const jointNodes = {
    torso,
    head,
    leftShoulder,
    rightShoulder,
    leftArm,
    elbowL,
    rightArm,
    elbowR,
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
  let elapsed = 0;
  let animElapsed = 0;
  let lastAnim = null;
  let overloadHeat = 0;
  let bodyDropCur = 0;
  let bladeSurgeCur = 0;
  let monoEyeYawCur = 0;
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
    const isOverload = hpPct <= 0.35;
    const heatTarget = isOverload ? 1 : state.phase === 2 ? 0.32 : 0;
    if (state.anim !== lastAnim) {
      lastAnim = state.anim;
      animElapsed = 0;
    }
    elapsed += step;
    animElapsed += step;
    const heatAlpha = step > 0 ? 1 - Math.exp(-6.5 * step) : 1;
    overloadHeat += (heatTarget - overloadHeat) * heatAlpha;
    let targetBodyDrop = 0;
    let slerpRate = 18;
    let targetBladeSurge = 0;
    let coreWarnMult = 1;
    let targetMonoEyeYaw = 0;
    setPose("hips", 0, 0, 0);
    setPose("thighL", 0.08, 0.11, 0.095);
    setPose("shinL", -0.14, 0, 0);
    setPose("footL", 0.06, 0.04, -0.095);
    setPose("thighR", -0.06, -0.11, -0.095);
    setPose("shinR", -0.1, 0, 0);
    setPose("footR", 0.16, -0.04, 0.095);
    const ventFlare = overloadHeat * 0.11;
    setPose("leftShoulder", 0, 0, ventFlare);
    setPose("rightShoulder", 0, 0, -ventFlare);
    if (state.anim === "idle") {
      const scanWave = steppedServoWave(elapsed * 0.32, 0.64);
      const hydroCycle = steppedServoWave(elapsed * 0.55 + 0.15, 0.52);
      const microServo = steppedServoWave(elapsed * 0.85, 0.72);
      targetBodyDrop = 0.018 * (0.5 + 0.5 * hydroCycle);
      targetMonoEyeYaw = scanWave * 0.36;
      setPose("hips", 0, scanWave * 0.02, 0);
      setPose("torso", -0.05 - 0.015 * hydroCycle, scanWave * 0.04, 0);
      setPose("head", 0.03, scanWave * 0.14, 0);
      setPose("leftShoulder", 0, 0, ventFlare + 0.02 * hydroCycle);
      setPose("rightShoulder", 0, 0, -ventFlare - 0.02 * hydroCycle);
      setPose("leftArm", 0.18 + microServo * 0.03, -0.08, 0.14);
      setPose("elbowL", 0.52 + hydroCycle * 0.04, 0, -0.06);
      setPose("rightArm", 0.18 - microServo * 0.04, 0.1, -0.22);
      setPose("elbowR", 0.5 + microServo * 0.05, 0, 0.08);
      slerpRate = 16;
    } else if (state.anim === "walk") {
      const walkFreq = 2.9 * (1 + overloadHeat * 0.14);
      const w = animElapsed * walkFreq + 0.35;
      const rawS = Math.sin(w);
      const s = Math.sign(rawS) * Math.pow(Math.abs(rawS), 0.78);
      const c = Math.cos(w);
      const impact = Math.pow(Math.max(0, -Math.cos(w * 2)), 3.2);
      const midLift = Math.max(0, Math.cos(w * 2)) * 0.018;
      targetBodyDrop = 0.115 * impact - midLift;
      setPose("hips", 0.05 * impact, -s * 0.11, s * 0.055);
      setPose("torso", -0.12 - 0.06 * impact, s * 0.16, -s * 0.07);
      setPose("head", 0.08 + 0.05 * impact, -s * 0.12, s * 0.03);
      targetMonoEyeYaw = -s * 0.08;
      setPose("leftShoulder", -s * 0.16 - 0.06 * impact, 0, ventFlare + 0.05 * impact);
      setPose("rightShoulder", s * 0.16 - 0.06 * impact, 0, -ventFlare - 0.05 * impact);
      const kneeLiftL = Math.pow(Math.max(0, -c), 0.75);
      const kneeLiftR = Math.pow(Math.max(0, c), 0.75);
      setPose("thighL", s * 0.48 + 0.06, 0.05, 0.07);
      setPose("shinL", -0.14 - kneeLiftL * 0.56 - impact * 0.14, 0, 0);
      setPose("footL", -s * 0.24 + 0.08 + impact * 0.08, 0, -0.07);
      setPose("thighR", -s * 0.48 + 0.06, -0.05, -0.07);
      setPose("shinR", -0.14 - kneeLiftR * 0.56 - impact * 0.14, 0, 0);
      setPose("footR", s * 0.24 + 0.08 + impact * 0.08, 0, 0.07);
      setPose("leftArm", -s * 0.44 + 0.18, -0.08, 0.18);
      setPose("elbowL", 0.52 + Math.max(0, -s) * 0.18, 0, -0.05);
      setPose("rightArm", s * 0.46 + 0.16, 0.08, -0.24);
      setPose("elbowR", 0.46 + Math.max(0, s) * 0.18, 0, 0.06);
      slerpRate = 20;
    } else if (state.anim === "windup") {
      const cock = mechSnap(animElapsed / 0.28, 3);
      const clampShudder = animElapsed > 0.28 ? Math.sin(animElapsed * 44) * 8e-3 : 0;
      coreWarnMult = 1.44;
      targetBladeSurge = 0.76 * cock;
      targetBodyDrop = 0.048 * cock;
      targetMonoEyeYaw = 0.16 * cock;
      setPose("hips", 0.06 * cock, -0.18 * cock, 0.04 * cock);
      setPose("torso", 0.24 * cock, -0.38 * cock, 0.08 * cock);
      setPose("head", -0.14 * cock, 0.32 * cock, -0.04 * cock);
      setPose("leftShoulder", 0.16 * cock, 0, ventFlare + 0.08 * cock);
      setPose("rightShoulder", -0.26 * cock, 0, -ventFlare - 0.18 * cock);
      setPose("leftArm", lerp(0.18, 0.64, cock), -0.18 * cock, lerp(0.14, 0.32, cock));
      setPose("elbowL", lerp(0.52, 0.86, cock), 0, -0.1);
      setPose("rightArm", lerp(0.18, -1.58, cock) + clampShudder, 0.26 * cock, lerp(-0.22, -0.78, cock));
      setPose("elbowR", lerp(0.5, 0.96, cock), 0, 0.18 * cock);
      setPose("thighL", 0.26 * cock + 0.08, 0.1, 0.075);
      setPose("shinL", -0.38 * cock - 0.12, 0, 0);
      setPose("footL", 0.12 * cock + 0.04, 0, -0.075);
      setPose("thighR", -0.22 * cock - 0.06, -0.1, -0.075);
      setPose("shinR", -0.24 * cock - 0.1, 0, 0);
      setPose("footR", 0.36 * cock + 0.12, 0, 0.075);
      slerpRate = 24;
    } else if (state.anim === "attack") {
      const inLock = animElapsed < ATTACK_LOCK_SEC;
      const sweepU = inLock ? 0 : mechSnap((animElapsed - ATTACK_LOCK_SEC) / ATTACK_SWEEP_SEC, 3.8);
      const lockTremor = inLock ? Math.sin(animElapsed * 95) * 0.01 : 0;
      coreWarnMult = inLock ? 1.65 : lerp(1.6, 1.2, sweepU);
      targetBladeSurge = inLock ? 1 : lerp(1, 0.78, sweepU);
      targetBodyDrop = inLock ? 0.055 : lerp(0.055, 0.13, sweepU);
      targetMonoEyeYaw = lerp(0.16, -0.22, sweepU);
      setPose("hips", lerp(0.06, -0.1, sweepU), lerp(-0.18, 0.28, sweepU), lerp(0.04, -0.06, sweepU));
      setPose("torso", lerp(0.25, -0.34, sweepU), lerp(-0.38, 0.48, sweepU), lerp(0.08, -0.11, sweepU));
      setPose("head", lerp(-0.14, 0.24, sweepU), lerp(0.32, -0.38, sweepU), lerp(-0.04, 0.06, sweepU));
      setPose("leftShoulder", lerp(0.16, -0.2, sweepU), 0, ventFlare + 0.1);
      setPose("rightShoulder", lerp(-0.28, 0.24, sweepU), 0, -ventFlare - lerp(0.2, 0.04, sweepU));
      setPose("leftArm", lerp(0.64, -0.62, sweepU), -0.18, lerp(0.32, 0.36, sweepU));
      setPose("elbowL", lerp(0.86, 0.36, sweepU), 0, -0.08);
      setPose(
        "rightArm",
        lerp(-1.58, 1.15, sweepU) + lockTremor,
        lerp(0.26, -0.34, sweepU),
        lerp(-0.78, -0.44, sweepU)
      );
      setPose("elbowR", lerp(0.96, 0.32, sweepU), lerp(0, -0.42, sweepU), lerp(0.18, 0.82, sweepU));
      setPose("thighL", lerp(0.32, 0.48, sweepU), 0.1, 0.075);
      setPose("shinL", lerp(-0.48, -0.64, sweepU), 0, 0);
      setPose("footL", lerp(0.16, 0.18, sweepU), 0, -0.075);
      setPose("thighR", lerp(-0.26, -0.34, sweepU), -0.1, -0.075);
      setPose("shinR", -0.32, 0, 0);
      setPose("footR", lerp(0.46, 0.56, sweepU), 0, 0.075);
      slerpRate = inLock ? 42 : 48;
    } else if (state.anim === "recover") {
      const u = animElapsed < 0.14 ? 0 : mechSnap((animElapsed - 0.14) / (RECOVER_DURATION - 0.14), 2.2);
      targetBodyDrop = lerp(0.12, 0.018, u);
      targetBladeSurge = lerp(0.55, 0, u);
      targetMonoEyeYaw = lerp(-0.2, 0, u);
      setPose("hips", lerp(-0.08, 0, u), lerp(0.22, 0, u), lerp(-0.04, 0, u));
      setPose("torso", lerp(-0.3, -0.05, u), lerp(0.4, 0, u), lerp(-0.09, 0, u));
      setPose("head", lerp(0.2, 0.03, u), lerp(-0.3, 0, u), 0);
      setPose("leftShoulder", lerp(-0.16, 0, u), 0, ventFlare);
      setPose("rightShoulder", lerp(0.18, 0, u), 0, -ventFlare);
      setPose("leftArm", lerp(-0.46, 0.18, u), -0.08, lerp(0.3, 0.14, u));
      setPose("elbowL", lerp(0.36, 0.52, u), 0, -0.06);
      setPose("rightArm", lerp(0.98, 0.18, u), lerp(0.3, 0.1, u), lerp(-0.3, -0.22, u));
      setPose("elbowR", lerp(0.24, 0.5, u), lerp(0.32, 0, u), lerp(-0.2, 0.08, u));
      setPose("thighL", lerp(0.42, 0.08, u), 0.08, 0.075);
      setPose("shinL", lerp(-0.56, -0.14, u), 0, 0);
      setPose("footL", lerp(0.18, 0.06, u), 0, -0.075);
      setPose("thighR", lerp(-0.28, -0.06, u), -0.08, -0.075);
      setPose("shinR", lerp(-0.28, -0.1, u), 0, 0);
      setPose("footR", lerp(0.48, 0.16, u), 0, 0.075);
      slerpRate = 12;
    } else if (state.anim === "charge") {
      const fwdPitch = -27 * DEG2RAD;
      const runW = animElapsed * 6 + 0.4;
      const rawS = Math.sin(runW);
      const s = Math.sign(rawS) * Math.pow(Math.abs(rawS), 0.78);
      const c = Math.cos(runW);
      const stomp = Math.pow(Math.max(0, -Math.cos(runW * 2)), 2.8);
      coreWarnMult = 1.38;
      targetBladeSurge = 0.68;
      targetBodyDrop = 0.055 + 0.095 * stomp;
      targetMonoEyeYaw = -s * 0.06;
      setPose("hips", -0.12, -s * 0.14, s * 0.06);
      setPose("torso", fwdPitch - 0.05 * stomp, s * 0.14 + 0.18, -s * 0.07);
      setPose("head", -0.34, -0.16 - s * 0.08, 0);
      setPose("leftShoulder", 0.2, 0, ventFlare + 0.08);
      setPose("rightShoulder", -0.24, 0, -ventFlare - 0.14);
      setPose("leftArm", 0.68 - s * 0.12, -0.24, 0.22);
      setPose("elbowL", 0.96, 0, -0.12);
      setPose("rightArm", -0.96 + s * 0.14, 0.22, -0.44);
      setPose("elbowR", 0.34, 0, 0.08);
      setPose("thighL", s * 0.62 + 0.14, 0.06, 0.07);
      setPose("shinL", -0.16 - Math.max(0, -c) * 0.7 - stomp * 0.14, 0, 0);
      setPose("footL", -s * 0.28 + 0.14, 0, -0.07);
      setPose("thighR", -s * 0.62 + 0.14, -0.06, -0.07);
      setPose("shinR", -0.16 - Math.max(0, c) * 0.7 - stomp * 0.14, 0, 0);
      setPose("footR", s * 0.28 + 0.14, 0, 0.07);
      slerpRate = 24;
    }
    const qAlpha = step > 0 ? 1 - Math.exp(-slerpRate * step) : 1;
    for (let i = 0; i < jointKeys.length; i++) {
      const key = jointKeys[i];
      const [rx, ry, rz] = targetPose[key];
      tmpEuler.set(rx, ry, rz, "XYZ");
      tmpQuat.setFromEuler(tmpEuler);
      jointNodes[key].quaternion.slerp(tmpQuat, qAlpha);
    }
    const scalarAlpha = step > 0 ? 1 - Math.exp(-22 * step) : 1;
    bodyDropCur += (targetBodyDrop - bodyDropCur) * scalarAlpha;
    body.position.y = baseHipOffsetY - bodyDropCur;
    bladeSurgeCur += (targetBladeSurge - bladeSurgeCur) * scalarAlpha;
    monoEyeYawCur += (targetMonoEyeYaw - monoEyeYawCur) * scalarAlpha;
    monoEye.rotation.y = monoEyeYawCur;
    const humFreq = 3.2 + (1 - hpPct) * 1.8 + overloadHeat * 2.4;
    const hum = 0.5 + 0.5 * Math.sin(elapsed * humFreq);
    armorMat.emissive.copy(SEAM_EMISSIVE_P1).lerp(SEAM_EMISSIVE_P2, overloadHeat);
    armorMat.emissiveIntensity = 0.03 + overloadHeat * (0.92 + hum * 0.16);
    coreMat.emissive.copy(CORE_EMISSIVE_P1).lerp(CORE_EMISSIVE_P2, overloadHeat);
    coreMat.emissiveIntensity = (1.38 + overloadHeat * 1.45 + hum * (0.08 + overloadHeat * 0.18)) * coreWarnMult;
    eyeMat.emissive.copy(EYE_EMISSIVE_P1).lerp(EYE_EMISSIVE_P2, overloadHeat);
    eyeMat.emissiveIntensity = (2.55 + overloadHeat * 1.75 + hum * (0.1 + overloadHeat * 0.22)) * (coreWarnMult > 1.25 ? 1.18 : 1);
    bladeMat.emissive.copy(BLADE_EMISSIVE_P1).lerp(BLADE_EMISSIVE_P2, clamp01(overloadHeat + bladeSurgeCur * 0.45));
    bladeMat.emissiveIntensity = 1.65 + overloadHeat * 1.65 + bladeSurgeCur * 1.15 + hum * (0.08 + overloadHeat * 0.16);
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
      leftArm,
      rightArm,
      leftShoulder,
      rightShoulder,
      rightBlade,
      ventGlow,
      monoEye
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
function getMeshMaterial(node) {
  if (node instanceof THREE2.Mesh && node.material instanceof THREE2.MeshStandardMaterial) {
    return node.material;
  }
  let found = null;
  node.traverse((obj) => {
    if (!found && obj instanceof THREE2.Mesh && obj.material instanceof THREE2.MeshStandardMaterial) {
      found = obj.material;
    }
  });
  assert.ok(found, `expected ${node.name || "object"} to have a MeshStandardMaterial`);
  return found;
}
function resolveBossModelSource() {
  const candidates = [
    new URL("./bossModel.ts", import.meta.url),
    new URL("../render/bossModel.ts", import.meta.url)
  ];
  for (const url of candidates) {
    if (existsSync(url)) return readFileSync(url, "utf8");
  }
  throw new Error("Could not locate src/render/bossModel.ts for external-asset audit");
}
test("bossModel: triangle count <= 20000 and material count <= 6 with procedural hard-surface PBR atlas", () => {
  const boss = createBossModel();
  try {
    const tris = countSceneTriangles(boss.parts.root);
    assert.ok(tris > 3e3 && tris <= 2e4, `expected tris in (3000, 20000], got ${tris}`);
    const mats = collectUniqueMaterials(boss.parts.root);
    assert.ok(mats.size >= 3 && mats.size <= 6, `expected 3..6 materials, got ${mats.size}`);
    const torsoArmor = boss.parts.root.getObjectByName("boss-torso-armor");
    assert.ok(torsoArmor, "expected boss-torso-armor mesh");
    const armorMat = torsoArmor.material;
    assert.ok(
      armorMat.map && armorMat.normalMap && armorMat.emissiveMap,
      "expected procedural metal atlas + normalMap + seam emissiveMap"
    );
    assert.ok(armorMat.metalness >= 0.5, `expected metallic armor PBR, got metalness=${armorMat.metalness}`);
    assert.ok(
      armorMat.emissiveIntensity < 0.2,
      `expected subtle Phase 1 armor seam glow, got ${armorMat.emissiveIntensity}`
    );
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
      `expected armored boots grounded flush at y=0, got minY=${box.min.y.toFixed(4)}`
    );
  } finally {
    boss.dispose();
  }
});
test("bossModel: windup and attack produce distinct rightArm joint matrices with brief hydraulic lock", () => {
  const boss = createBossModel();
  try {
    for (let i = 0; i < 20; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "windup" });
    boss.parts.root.updateMatrixWorld(true);
    const windupLocal = boss.parts.rightArm.matrix.clone();
    const windupWorld = boss.parts.rightArm.matrixWorld.clone();
    const windupArmX = boss.parts.rightArm.rotation.x;
    boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
    boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
    const lockedArmX = boss.parts.rightArm.rotation.x;
    assert.ok(
      Math.abs(lockedArmX - windupArmX) < 0.25 && lockedArmX < -1.1,
      `expected rightArm to hold rigid hydraulic lock during first ~75ms of attack (windup=${windupArmX.toFixed(3)}, locked=${lockedArmX.toFixed(3)})`
    );
    for (let i = 0; i < 7; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
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
      maxLocalDiff > 0.6,
      `expected windup vs attack rightArm local matrix to differ significantly, maxDiff=${maxLocalDiff.toFixed(4)}`
    );
    assert.ok(
      maxWorldDiff > 0.6,
      `expected windup vs attack rightArm world matrix to differ significantly, maxDiff=${maxWorldDiff.toFixed(4)}`
    );
  } finally {
    boss.dispose();
  }
});
test("bossModel: zero external model/texture/image asset references (100% procedural)", () => {
  const source = resolveBossModelSource();
  const forbiddenAssetPatterns = [
    ["3D model extension (.glb/.gltf/.fbx/.obj)", /\.(glb|gltf|fbx|obj)\b/gi],
    ["image texture extension (.png/.jpg/.jpeg/.webp/.ktx2/.dds)", /\.(png|jpe?g|webp|ktx2|dds|bmp|tga)\b/gi],
    ["Three.js external loader", /\b(GLTFLoader|FBXLoader|OBJLoader|TextureLoader|ImageLoader|KTX2Loader)\b/g],
    ["network/data fetch or Image element", /\b(fetch\s*\(|new\s+Image\s*\(|XMLHttpRequest)\b/g]
  ];
  let externalRefCount = 0;
  const hits = [];
  for (const [label, re] of forbiddenAssetPatterns) {
    const matches = source.match(re);
    if (matches && matches.length > 0) {
      externalRefCount += matches.length;
      hits.push(`${label}: ${matches.join(", ")}`);
    }
  }
  assert.equal(
    externalRefCount,
    0,
    `expected 0 external asset references in bossModel.ts, found ${externalRefCount} (${hits.join("; ")})`
  );
});
test("bossModel: all required parts + heavy mech assemblies belong to root skeleton hierarchy", () => {
  const boss = createBossModel();
  try {
    const {
      root,
      torso,
      head,
      core,
      leftArm,
      rightArm,
      leftShoulder,
      rightShoulder,
      rightBlade,
      ventGlow,
      monoEye
    } = boss.parts;
    const partEntries = [
      ["root", root],
      ["torso", torso],
      ["head", head],
      ["core", core],
      ["leftArm", leftArm],
      ["rightArm", rightArm],
      ["leftShoulder", leftShoulder],
      ["rightShoulder", rightShoulder],
      ["rightBlade", rightBlade],
      ["ventGlow", ventGlow],
      ["monoEye", monoEye]
    ];
    assert.ok(root instanceof THREE2.Group, "root must be a THREE.Group");
    for (const [name, obj] of partEntries) {
      assert.ok(obj instanceof THREE2.Object3D, `part "${name}" must exist as THREE.Object3D`);
      assert.ok(isUnderRoot(root, obj), `part "${name}" must be attached under root`);
      if (name !== "root") {
        assert.notEqual(obj.parent, null, `part "${name}" must have a parent inside root`);
      }
    }
    assert.equal(root.getObjectByName("boss-tail"), void 0, "heavy mech must not have an organic tail");
    assert.equal(root.getObjectByName("boss-torso-skin"), void 0, "heavy mech must not have organic skin");
    assert.equal(root.getObjectByName("boss-torso-bone"), void 0, "heavy mech must not have organic bone");
    for (const boneName of [
      "boss-body",
      "boss-torso",
      "boss-torso-armor",
      "boss-torso-frame",
      "boss-head",
      "boss-mono-eye",
      "boss-core",
      "boss-pauldron-l",
      "boss-pauldron-r",
      "boss-shoulder-l",
      "boss-elbow-l",
      "boss-shoulder-r",
      "boss-elbow-r",
      "boss-right-blade",
      "boss-blade-plasma",
      "boss-hips",
      "boss-thigh-l",
      "boss-shin-l",
      "boss-foot-l",
      "boss-thigh-r",
      "boss-shin-r",
      "boss-foot-r"
    ]) {
      const bone = root.getObjectByName(boneName);
      assert.ok(bone, `expected mech skeleton node "${boneName}"`);
      assert.ok(isUnderRoot(root, bone), `node "${boneName}" must be under root`);
    }
  } finally {
    boss.dispose();
  }
});
test("bossModel: update() drives heavy mechanical motion across all 6 anim states", () => {
  const anims = ["idle", "walk", "windup", "attack", "recover", "charge"];
  for (const anim of anims) {
    const boss2 = createBossModel();
    try {
      const initialRotX = boss2.parts.rightArm.rotation.x;
      const steps = anim === "attack" ? 10 : 16;
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
    const body = boss.parts.root.getObjectByName("boss-body");
    const thighL = boss.parts.root.getObjectByName("boss-thigh-l");
    const thighR = boss.parts.root.getObjectByName("boss-thigh-r");
    const coreMat = getMeshMaterial(boss.parts.core);
    let minEyeY = Infinity;
    let maxEyeY = -Infinity;
    for (let i = 0; i < 60; i++) {
      boss.update(0.05, { hpPct: 1, phase: 1, anim: "idle" });
      const ey = boss.parts.monoEye.rotation.y;
      minEyeY = Math.min(minEyeY, ey);
      maxEyeY = Math.max(maxEyeY, ey);
    }
    const idleCoreEmissive = coreMat.emissiveIntensity;
    assert.ok(
      maxEyeY - minEyeY > 0.3,
      `idle mono-eye should perform mechanical scan sweep (range=${(maxEyeY - minEyeY).toFixed(3)})`
    );
    let minBodyY = Infinity;
    let maxBodyY = -Infinity;
    let maxStrideDiff = 0;
    let sawCounterShoulders = false;
    for (let i = 0; i < 48; i++) {
      boss.update(0.05, { hpPct: 1, phase: 1, anim: "walk" });
      minBodyY = Math.min(minBodyY, body.position.y);
      maxBodyY = Math.max(maxBodyY, body.position.y);
      maxStrideDiff = Math.max(maxStrideDiff, Math.abs(thighL.rotation.x - thighR.rotation.x));
      const ls = boss.parts.leftShoulder.rotation.x;
      const rs = boss.parts.rightShoulder.rotation.x;
      if (ls * rs < -4e-3) sawCounterShoulders = true;
    }
    assert.ok(
      maxBodyY - minBodyY > 0.06,
      `walk should show pronounced heavy mechanical vertical chassis drop (range=${(maxBodyY - minBodyY).toFixed(3)}m)`
    );
    assert.ok(maxStrideDiff > 0.55, `walk legs should stride distinctly (diff=${maxStrideDiff.toFixed(3)})`);
    assert.ok(sawCounterShoulders, "walk shoulders should counter-swing opposite each other");
    for (let i = 0; i < 20; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "windup" });
    assert.ok(
      boss.parts.rightArm.rotation.x < -1.2,
      `windup rightArm should raise backward/high, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`
    );
    assert.ok(torso.rotation.x > 0.18, `windup torso should lean back, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(
      coreMat.emissiveIntensity > idleCoreEmissive * 1.25,
      `windup core should surge (idle=${idleCoreEmissive.toFixed(2)}, windup=${coreMat.emissiveIntensity.toFixed(2)})`
    );
    for (let i = 0; i < 9; i++) boss.update(0.02, { hpPct: 1, phase: 1, anim: "attack" });
    assert.ok(
      boss.parts.rightArm.rotation.x > 0.9,
      `attack rightArm should cleave forward after lock, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`
    );
    assert.ok(torso.rotation.x < -0.22, `attack torso should lunge forward, got ${torso.rotation.x.toFixed(3)}`);
    for (let i = 0; i < 25; i++) boss.update(0.04, { hpPct: 1, phase: 1, anim: "charge" });
    assert.ok(torso.rotation.x < -0.38, `charge torso should pitch forward steeply, got ${torso.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.head.rotation.x < -0.25, `charge head should hunker down, got ${boss.parts.head.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.leftArm.rotation.x > 0.4, `charge left buckler arm should brace ahead, got ${boss.parts.leftArm.rotation.x.toFixed(3)}`);
    assert.ok(boss.parts.rightArm.rotation.x < -0.6, `charge right blade arm should sweep back, got ${boss.parts.rightArm.rotation.x.toFixed(3)}`);
  } finally {
    boss.dispose();
  }
});
test("bossModel: phase 2 (hpPct <= 0.35) overloads blade, mono-eye, core, and armor seams without whole-body red flash", () => {
  const boss = createBossModel();
  try {
    const torsoArmor = boss.parts.root.getObjectByName("boss-torso-armor");
    const bladePlasma = boss.parts.root.getObjectByName("boss-blade-plasma");
    const monoEyeLens = boss.parts.root.getObjectByName("boss-mono-eye-lens");
    const armorMat = torsoArmor.material;
    const coreMat = getMeshMaterial(boss.parts.core);
    const bladeMat = bladePlasma.material;
    const eyeMat = monoEyeLens.material;
    for (let i = 0; i < 16; i++) boss.update(0.05, { hpPct: 0.85, phase: 1, anim: "idle" });
    const p1ArmorHex = armorMat.color.getHex();
    const p1SeamEm = armorMat.emissiveIntensity;
    const p1CoreEm = coreMat.emissiveIntensity;
    const p1BladeEm = bladeMat.emissiveIntensity;
    const p1EyeEm = eyeMat.emissiveIntensity;
    for (let i = 0; i < 22; i++) boss.update(0.05, { hpPct: 0.35, phase: 2, anim: "idle" });
    const p2ArmorHex = armorMat.color.getHex();
    const p2SeamEm = armorMat.emissiveIntensity;
    const p2CoreEm = coreMat.emissiveIntensity;
    const p2BladeEm = bladeMat.emissiveIntensity;
    const p2EyeEm = eyeMat.emissiveIntensity;
    assert.ok(
      p2BladeEm > p1BladeEm * 1.6,
      `expected phase 2 thermal blade emissive (${p2BladeEm.toFixed(2)}) >> phase 1 (${p1BladeEm.toFixed(2)})`
    );
    assert.ok(
      p2EyeEm > p1EyeEm * 1.5,
      `expected phase 2 mono-eye emissive (${p2EyeEm.toFixed(2)}) >> phase 1 (${p1EyeEm.toFixed(2)})`
    );
    assert.ok(
      p2CoreEm > p1CoreEm * 1.6,
      `expected phase 2 reactor core emissive (${p2CoreEm.toFixed(2)}) >> phase 1 (${p1CoreEm.toFixed(2)})`
    );
    assert.ok(
      p2SeamEm > p1SeamEm * 8,
      `expected phase 2 armor seam bleed (${p2SeamEm.toFixed(2)}) >> phase 1 (${p1SeamEm.toFixed(2)})`
    );
    assert.equal(p2ArmorHex, p1ArmorHex, "armor base albedo must stay steady (no whole-body red alarm flash)");
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
