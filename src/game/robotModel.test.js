// src/game/robotModel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE3 from "three";

// src/render/robotModel.ts
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// src/render/palette.ts
var PALETTE = {
  deck: ["#22282e", "#2c333b", "#3d4651"],
  // 甲板钢板：深海冷钢 3 档，拉出湿反光与明暗层次
  deckLine: "#d1a82e",
  // 甲板警示黄线
  container: ["#8f3b2e", "#2b4d6f", "#3f5940", "#7d6138"],
  // 集装箱 4 主色：锈红 / 深蓝 / 橄榄绿 / 赭黄
  containerTop: "#6e7378",
  rust: "#7a3f22",
  tower: ["#5d656d", "#6e7780"],
  // 混凝土哨塔（中性偏冷灰）
  steelFrame: "#4a5764",
  // 平台 H 型钢 / 工字钢 / 槽钢工业钢构（蓝灰漆钢）
  checker: "#535e69",
  // 花纹钢板台面与踏板
  kickplate: "#5b6570",
  // 护栏踢脚板（带锈迹流痕底色）
  elecBox: "#6a7580",
  // 配电箱工业灰漆箱体
  cabGlass: "#7fa8c4",
  // 吊机驾驶室反光玻璃
  oilStain: "#1a2028",
  // 地面油渍暗泽
  pipe: "#485460",
  // 管件/系缆桩——金属高光吃 IBL
  sea: ["#152430", "#1c2f3e", "#2c465a"],
  sky: ["#384c63", "#6f8db3"],
  // [0] 天顶，[1] 半球光天光色
  skyGround: "#2a2622",
  // 半球光地面反弹色（暖暗甲板）
  skyHorizon: "#7c93aa",
  // 地平线雾霾灰蓝 — 与雾色贴合
  // Saltline-inspired dusk/maritime sky — linear-space RGB triples
  skyZen: [0.065, 0.11, 0.185],
  skyHor: [0.86, 0.58, 0.34],
  skyHorAway: [0.19, 0.27, 0.38],
  fill: "#5b7fb3",
  // 冷色反方向补光
  fog: "#6c8298",
  // 指数雾色：取地平线灰蓝，与远景吊机/海面自然融出
  sun: "#ffe6c4",
  // 主方向光：低角度暖白太阳（15° 仰角）
  teamA: "#4fa4f1",
  // 我方：蓝
  teamB: "#ff4655",
  // 敌方：红
  hpFull: "#ece8e1",
  // VALORANT 灰白血条（非饱和色块）
  hpSeg2: "#b8e0ff",
  // 第二段 100–200 护甲级战术亮蓝白
  hpMid: "#d5d1ca",
  hpLow: "#ff4655",
  // 仅低血量/危险使用 Valorant 红
  uiPanel: "rgba(8,12,18,0.55)",
  uiBtnPanel: "rgba(14,19,27,0.90)",
  uiBtnGradTop: "rgba(188,208,230,0.048)",
  uiBtnGradMid: "rgba(14,19,27,0.00)",
  uiBtnGradBot: "rgba(2,5,10,0.14)",
  uiBtnHiTop: "rgba(255,255,255,0.28)",
  uiBtnHiInnerBot: "rgba(0,0,0,0.45)",
  uiBtnPressedTop: "rgba(255,255,255,0.24)",
  uiBtnPressedMid: "rgba(255,255,255,0.14)",
  uiBtnPressedBot: "rgba(255,255,255,0.08)",
  uiBtnPressedGlow: "rgba(255,255,255,0.22)",
  uiBtnActiveTop: "rgba(255,70,85,0.18)",
  uiBtnActiveMid: "rgba(255,70,85,0.12)",
  uiBtnActiveBot: "rgba(255,70,85,0.08)",
  uiBtnBorder: "rgba(236,232,225,0.48)",
  uiBtnBorderDisabled: "rgba(154,164,176,0.42)",
  uiBtnFgDisabled: "rgba(176,184,194,0.58)",
  uiBtnFireInnerRing: "rgba(255,70,85,0.34)",
  uiBtnReloadTrack: "rgba(236,232,225,0.18)",
  uiBtnReloadSweep: "rgba(255,70,85,0.22)",
  uiBtnShadow: "rgba(4,7,12,0.58)",
  uiBorder: "rgba(255,255,255,0.18)",
  uiBorderActive: "rgba(236,232,225,0.72)",
  uiText: "#ece8e1",
  uiDim: "rgba(236,232,225,0.60)",
  uiEmpty: "rgba(255,255,255,0.14)",
  accent: "#ff4655",
  // Valorant 红 — 仅用于危险/开火/低血量
  gun: ["#2e343b", "#3a4149", "#67727f"],
  // 枪体：暗/中/亮
  gunDark: "#252b32",
  // 弹匣/小件：偏暗哑光
  gunHi: "#8ea0b0",
  // 枪身高光条 emissive
  glove: "#5d6167",
  // 手臂——比枪身亮，分出层次
  skinBase: "#d49d7a",
  // 真人肤色基色（暖自然肤）
  skinWarm: "#c27958",
  // 肤色指节/皮下暖散射近似色
  skinNail: "#e4c2ae",
  // 指甲盖浅暖色
  tacGlove: "#2d333b",
  // 战术露指手套主料
  tacKnuckle: "#1d2228",
  // 手背护骨甲
  tacSleeve: "#2b3b4e",
  // 战术服袖子（海军灰蓝）
  tacCuff: "#212d3b",
  // 袖口加厚翻边
  tacVelcro: "#171c22",
  // 袖口魔术贴
  tacStitch: "#6c7c8e",
  // 袖口双排缝线
  // 赛博朋克机器人（全程序化金属 PBR，阵营仅靠发光色区分）
  robotArmor: "#2e3542",
  // 深灰蓝金属装甲漆面（避开 ACES 暗部死黑压暗，兼顾明暗背景对比）
  robotFrame: "#171a21",
  // 机械骨架与关节暗金属
  robotGun: "#2b303a",
  // 机器人脉冲步枪机匣
  robotEdge: "#6c7a92",
  // 装甲边缘 1px 弱发光亮边
  robotGlowEnemy: "#ff2d95",
  // 敌方强发光：品红
  robotGlowAlly: "#22e0ff",
  // 我方/AI 友军强发光：青
  robotHitFlash: "#ffffff",
  // 受击 0.12s 视带闪白
  // 敌人头顶距离牌 & 极简血条
  tagGlassBg: "rgba(8,12,20,0.62)",
  // 深色半透明玻璃底
  tagBorderCyan: "rgba(120,255,255,0.35)",
  // 1px 常规冷青内发光描边
  tagBorderWarm: "#ffb454",
  // <10m 暖色警示描边与 4px 圆点
  tagGlowCyan: "rgba(120,255,255,0.22)",
  // 常规 1px 内发光
  tagGlowWarm: "rgba(255,180,84,0.32)",
  // <10m 暖色内发光
  tagText: "#eef4fa",
  // 距离牌等宽数字色
  tagHpTrack: "rgba(255,255,255,0.14)",
  // 血条轨道底色
  tagHpHigh: "#22e0ff",
  // 血量 >60%：青
  tagHpMid: "#ffd166",
  // 血量 30%–60%：黄
  tagHpLow: "#ff4655",
  // 血量 <=30%：红
  bootDark: "#17191d",
  // 战术军靴
  brass: "#d8b054",
  // 弹壳 / 弹匣顶弹 / 加特林弹链黄铜
  gatlingAccent: "#f5b041",
  // 加特林重武 HUD 琥珀橙
  gatlingReady: "#5ee39a",
  // 加特林预热就绪绿
  gatlingBlur: "#9ab4cc",
  // 加特林枪管高速旋转残影
  flashCore: "#fffdf2",
  // 枪口白热星形核心
  flashMid: "#ff9626",
  // 枪口中层橙黄锥形火焰
  flashOuter: "#ff4812",
  // 枪口火焰外缘灼橙
  muzzleSmoke: "#cfe8f5",
  // 枪口外层淡青白短烟
  muzzleLight: "#ffb066",
  // 枪口 PointLight 暖光
  spark: "#ffd26a",
  // 命中火花
  dust: "#a6b0b8",
  // 命中微尘
  bulletHole: "#14171c",
  // 弹孔中心焦黑
  tracer: "#ffd670",
  // 曳光亮条
  crosshair: "#f2f6fa",
  crosshairHit: "#ff4655",
  crosshairEdge: "rgba(4,8,12,0.85)",
  deadVeil: "rgba(8,12,18,0.76)",
  hurtVeil: "rgba(255,70,85,0.72)",
  // 受击/低血 屏幕边缘红晕外缘
  lampRed: "#e4553f",
  // 船头红色警示灯
  lampWarm: "#ffc27a",
  // 哨塔暖黄工作灯 / 亮窗
  wood: "#785e3c",
  // 木托盘/木箱
  crane: "#354352",
  // 远处港口吊机剪影（靠指数雾自然淡入地平线）
  hull: "#353e47",
  // 船体外板——深海灰钢，吃金属 IBL 反光
  hullBand: "#7a3222",
  // 水线防污漆——氧化红
  cone: "#d66d22",
  // 警示锥——安全橙
  rope: "#917a55"
  // 缆绳卷——麻色
};

// src/render/robotModel.ts
var ARMOR_FRESNEL_CACHE_KEY = "robot-armor-fresnel-v1";
var ARMOR_EMISSIVE_INTENSITY = 0.16;
var ARMOR_FRESNEL_K = {
  enemy: 2.6,
  ally: 2
};
var ARMOR_HIT_FRESNEL_K = 3.6;
var VISOR_HALO_OPACITY = 0.9;
var cachedMaterials = null;
var cachedGeometries = null;
function countGeoTris(g) {
  const idx = g.getIndex();
  if (idx) return Math.round(idx.count / 3);
  const pos = g.getAttribute("position");
  return pos ? Math.round(pos.count / 3) : 0;
}
function makePart(geo, pos, rot = [0, 0, 0], tint = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  geo.dispose();
  if (rot[0] !== 0 || rot[1] !== 0 || rot[2] !== 0) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
    g.applyMatrix4(m);
  }
  if (pos[0] !== 0 || pos[1] !== 0 || pos[2] !== 0) {
    g.translate(pos[0], pos[1], pos[2]);
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") {
      g.deleteAttribute(name);
    }
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const count = g.getAttribute("position").count;
  const cols = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    cols[i * 3] = tint[0];
    cols[i * 3 + 1] = tint[1];
    cols[i * 3 + 2] = tint[2];
  }
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return g;
}
function mergeStrict(parts) {
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) throw new Error("robotModel: mergeGeometries failed");
  if (parts.length > 1) {
    for (const p of parts) p.dispose();
  }
  return merged;
}
function createFlashTexture() {
  if (typeof document === "undefined") {
    const tex2 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex2.needsUpdate = true;
    return tex2;
  }
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, PALETTE.robotHitFlash);
  g.addColorStop(0.32, PALETTE.flashCore);
  g.addColorStop(0.68, PALETTE.flashMid);
  g.addColorStop(1, "rgba(255, 80, 18, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function createVisorGlowTexture() {
  if (typeof document === "undefined") {
    const tex2 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex2.needsUpdate = true;
    return tex2;
  }
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    const ny = (y - half) / half;
    for (let x = 0; x < size; x++) {
      const nx = (x - half) / half;
      const barDx = Math.max(0, Math.abs(nx) - 0.32) / 0.68;
      const barR = Math.hypot(barDx, ny * 1.45);
      const core = Math.exp(-barR * barR * 6.5);
      const outerR = Math.hypot(nx, ny);
      const halo = outerR < 1 ? Math.pow(1 - outerR, 2.2) : 0;
      const edgeFade = outerR < 1 ? Math.min(1, (1 - outerR) * 4.5) : 0;
      const alpha = Math.max(0, Math.min(1, (core * 0.85 + halo * 0.72) * edgeFade));
      const idx = (y * size + x) * 4;
      d[idx] = 255;
      d[idx + 1] = 255;
      d[idx + 2] = 255;
      d[idx + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function applyArmorFresnel(mat, rimHex, rimStrength) {
  const rimColor = new THREE.Color(rimHex);
  mat.userData.fresnelRimColor = rimHex;
  mat.userData.fresnelRimStrength = rimStrength;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = rimStrength;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;"
    ).replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
{
	float rimNdotV = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
	float rimFactor = pow( 1.0 - rimNdotV, 3.0 );
	totalEmissiveRadiance += uRimColor * rimFactor * uRimStrength;
}`
    );
  };
  mat.customProgramCacheKey = () => ARMOR_FRESNEL_CACHE_KEY;
}
function getMaterials() {
  if (cachedMaterials) return cachedMaterials;
  const makeArmor = (rimHex, rimK, emissiveHex = PALETTE.robotEdge, emissiveInt = ARMOR_EMISSIVE_INTENSITY) => {
    const mat = new THREE.MeshStandardMaterial({
      color: PALETTE.robotArmor,
      emissive: emissiveHex,
      emissiveIntensity: emissiveInt,
      metalness: 0.86,
      roughness: 0.26,
      envMapIntensity: 2.9,
      vertexColors: true
    });
    applyArmorFresnel(mat, rimHex, { value: rimK });
    return mat;
  };
  const makeGlow = (hex) => new THREE.MeshStandardMaterial({
    color: hex,
    emissive: hex,
    emissiveIntensity: 4.4,
    metalness: 0.85,
    roughness: 0.2,
    envMapIntensity: 1.4
  });
  const makeEdgeTrim = (hex) => new THREE.MeshStandardMaterial({
    color: PALETTE.robotEdge,
    emissive: hex,
    emissiveIntensity: 0.55,
    metalness: 0.92,
    roughness: 0.22,
    envMapIntensity: 2.2
  });
  const makeEdgeLine = (hex) => {
    const col = new THREE.Color(PALETTE.robotEdge).lerp(new THREE.Color(hex), 0.48);
    return new THREE.LineBasicMaterial({
      color: col,
      transparent: true,
      opacity: 0.82
    });
  };
  const visorGlowTex = createVisorGlowTexture();
  const makeVisorHalo = (hex, opacity) => new THREE.SpriteMaterial({
    map: visorGlowTex,
    color: hex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false
  });
  const visorFlash = new THREE.MeshStandardMaterial({
    color: PALETTE.robotHitFlash,
    emissive: PALETTE.robotHitFlash,
    emissiveIntensity: 4.8,
    metalness: 0.85,
    roughness: 0.2
  });
  cachedMaterials = {
    armor: {
      enemy: makeArmor(PALETTE.robotGlowEnemy, ARMOR_FRESNEL_K.enemy),
      ally: makeArmor(PALETTE.robotGlowAlly, ARMOR_FRESNEL_K.ally)
    },
    armorHitFlash: makeArmor(PALETTE.robotHitFlash, ARMOR_HIT_FRESNEL_K, PALETTE.robotHitFlash, 0.42),
    glow: {
      enemy: makeGlow(PALETTE.robotGlowEnemy),
      ally: makeGlow(PALETTE.robotGlowAlly)
    },
    edgeTrim: {
      enemy: makeEdgeTrim(PALETTE.robotGlowEnemy),
      ally: makeEdgeTrim(PALETTE.robotGlowAlly)
    },
    edgeLine: {
      enemy: makeEdgeLine(PALETTE.robotGlowEnemy),
      ally: makeEdgeLine(PALETTE.robotGlowAlly)
    },
    visorFlash,
    visorHalo: {
      enemy: makeVisorHalo(PALETTE.robotGlowEnemy, VISOR_HALO_OPACITY),
      ally: makeVisorHalo(PALETTE.robotGlowAlly, VISOR_HALO_OPACITY)
    },
    visorHaloFlash: makeVisorHalo(PALETTE.robotHitFlash, 0.98),
    visorGlowTex,
    flashTex: createFlashTexture()
  };
  return cachedMaterials;
}
var TINT_ARMOR = [1, 1, 1];
var TINT_ARMOR_HI = [1.75, 1.82, 1.95];
var TINT_FRAME = [0.62, 0.66, 0.74];
var TINT_GUN = [1.35, 1.42, 1.52];
function buildUpperArm(side) {
  const pauldronMain = makePart(
    new THREE.BoxGeometry(0.15, 0.125, 0.21),
    [side * 0.045, 0.025, 0],
    [0, 0, -side * 0.32],
    TINT_ARMOR
  );
  const pauldronWing = makePart(
    new THREE.BoxGeometry(0.06, 0.14, 0.175),
    [side * 0.105, -0.025, 5e-3],
    [0, 0, -side * 0.14],
    TINT_ARMOR_HI
  );
  const pauldronCap = makePart(
    new THREE.BoxGeometry(0.12, 0.032, 0.16),
    [side * 0.03, 0.092, 0],
    [0, 0, -side * 0.28],
    TINT_ARMOR_HI
  );
  const armorPlates = mergeStrict([pauldronMain.clone(), pauldronWing.clone(), pauldronCap.clone()]);
  const edgeLine = new THREE.EdgesGeometry(armorPlates, 26);
  armorPlates.dispose();
  const armor = mergeStrict([
    pauldronMain,
    pauldronWing,
    pauldronCap,
    // Mechanical shoulder ball joint
    makePart(new THREE.CylinderGeometry(0.052, 0.052, 0.1, 8), [0, -0.01, 0], [0, 0, Math.PI / 2], TINT_FRAME),
    // Inner hydraulic bicep strut
    makePart(new THREE.CylinderGeometry(0.036, 0.032, 0.22, 8), [side * 0.01, -0.14, 0], [0, 0, 0], TINT_FRAME),
    // Outer split bicep guard
    makePart(new THREE.BoxGeometry(0.068, 0.15, 0.095), [side * 0.042, -0.145, 0], [0, 0, -side * 0.08], TINT_ARMOR),
    // Elbow hinge drum
    makePart(new THREE.CylinderGeometry(0.038, 0.038, 0.085, 8), [side * 0.01, -0.25, 0], [0, 0, Math.PI / 2], TINT_FRAME)
  ]);
  const glow = makePart(
    new THREE.BoxGeometry(0.02, 0.016, 0.165),
    [side * 0.085, 0.062, 0],
    [0, 0, -side * 0.28],
    TINT_ARMOR
  );
  return { armor, edgeLine, glow };
}
function buildForearm(side) {
  return mergeStrict([
    // Inner mechanical wrist strut
    makePart(new THREE.CylinderGeometry(0.032, 0.026, 0.23, 8), [0, -0.125, 0], [0, 0, 0], TINT_FRAME),
    // Split outer cyber gauntlet plate
    makePart(new THREE.BoxGeometry(0.072, 0.19, 0.098), [side * 0.022, -0.125, -8e-3], [0, 0, -side * 0.06], TINT_ARMOR),
    // Dorsal knuckle/cuff armor ridge
    makePart(new THREE.BoxGeometry(0.056, 0.12, 0.042), [side * 0.016, -0.14, -0.052], [0.08, 0, 0], TINT_ARMOR_HI),
    // Cyber mechanical hand clamp
    makePart(new THREE.BoxGeometry(0.058, 0.072, 0.068), [0, -0.255, -0.012], [0, 0, 0], TINT_FRAME)
  ]);
}
function buildThigh(side) {
  return mergeStrict([
    // Inner structural femur actuator
    makePart(new THREE.CylinderGeometry(0.052, 0.042, 0.41, 8), [0, -0.21, 0], [0, 0, 0], TINT_FRAME),
    // Front split thigh armor plate
    makePart(new THREE.BoxGeometry(0.115, 0.3, 0.105), [side * 0.012, -0.2, -0.028], [-0.06, 0, 0], TINT_ARMOR),
    // Outer angled thigh side-plate
    makePart(new THREE.BoxGeometry(0.052, 0.26, 0.13), [side * 0.068, -0.19, 5e-3], [0, 0, -side * 0.08], TINT_ARMOR_HI),
    // Rear hydraulic thigh guard
    makePart(new THREE.BoxGeometry(0.088, 0.22, 0.065), [0, -0.2, 0.055], [0.06, 0, 0], TINT_ARMOR)
  ]);
}
function buildShin(side) {
  const kneeCap = makePart(
    new THREE.BoxGeometry(0.096, 0.11, 0.075),
    [0, -0.015, -0.062],
    [0.22, 0, 0],
    TINT_ARMOR_HI
  );
  const greaveFront = makePart(
    new THREE.BoxGeometry(0.105, 0.31, 0.095),
    [side * 8e-3, -0.22, -0.032],
    [0.06, 0, 0],
    TINT_ARMOR
  );
  const greaveSide = makePart(
    new THREE.BoxGeometry(0.044, 0.27, 0.11),
    [side * 0.058, -0.215, 4e-3],
    [0, 0, -side * 0.05],
    TINT_ARMOR_HI
  );
  const plateBundle = mergeStrict([kneeCap.clone(), greaveFront.clone(), greaveSide.clone()]);
  const edgeLine = new THREE.EdgesGeometry(plateBundle, 26);
  plateBundle.dispose();
  const armor = mergeStrict([
    kneeCap,
    greaveFront,
    greaveSide,
    // Knee rotary drum
    makePart(new THREE.CylinderGeometry(0.046, 0.046, 0.1, 8), [0, 0, 0], [0, 0, Math.PI / 2], TINT_FRAME),
    // Inner shin strut & rear piston
    makePart(new THREE.CylinderGeometry(0.038, 0.032, 0.4, 8), [0, -0.21, 0.012], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.018, 0.016, 0.3, 6), [0, -0.22, 0.068], [-0.08, 0, 0], TINT_FRAME)
  ]);
  return { armor, edgeLine };
}
function getGeometries() {
  if (cachedGeometries) return cachedGeometries;
  const pelvis = mergeStrict([
    makePart(new THREE.BoxGeometry(0.26, 0.11, 0.18), [0, 0, 0], [0, 0, 0], TINT_FRAME),
    // Split front/rear waist armor skirts
    makePart(new THREE.BoxGeometry(0.15, 0.125, 0.055), [0, -0.01, -0.098], [0.16, 0, 0], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.16, 0.1, 0.05), [0, 5e-3, 0.095], [-0.14, 0, 0], TINT_ARMOR),
    // Hip flank guards
    makePart(new THREE.BoxGeometry(0.045, 0.09, 0.15), [-0.145, 0.01, 0], [0, 0, 0.18], TINT_ARMOR_HI),
    makePart(new THREE.BoxGeometry(0.045, 0.09, 0.15), [0.145, 0.01, 0], [0, 0, -0.18], TINT_ARMOR_HI),
    // Hip axle cylinders
    makePart(new THREE.CylinderGeometry(0.044, 0.044, 0.29, 8), [0, -0.02, 0], [0, 0, Math.PI / 2], TINT_FRAME)
  ]);
  const chestL = makePart(
    new THREE.BoxGeometry(0.175, 0.21, 0.13),
    [-0.102, 0.27, -0.082],
    [-0.14, 0.22, 0.06],
    TINT_ARMOR
  );
  const chestR = makePart(
    new THREE.BoxGeometry(0.175, 0.21, 0.13),
    [0.102, 0.27, -0.082],
    [-0.14, -0.22, -0.06],
    TINT_ARMOR
  );
  const chestUpperL = makePart(
    new THREE.BoxGeometry(0.16, 0.075, 0.16),
    [-0.105, 0.375, -0.02],
    [0.18, 0.12, 0.12],
    TINT_ARMOR_HI
  );
  const chestUpperR = makePart(
    new THREE.BoxGeometry(0.16, 0.075, 0.16),
    [0.105, 0.375, -0.02],
    [0.18, -0.12, -0.12],
    TINT_ARMOR_HI
  );
  const ribL = makePart(
    new THREE.BoxGeometry(0.085, 0.16, 0.18),
    [-0.155, 0.145, -0.01],
    [0, 0.08, -0.1],
    TINT_ARMOR
  );
  const ribR = makePart(
    new THREE.BoxGeometry(0.085, 0.16, 0.18),
    [0.155, 0.145, -0.01],
    [0, -0.08, 0.1],
    TINT_ARMOR
  );
  const collarL = makePart(new THREE.BoxGeometry(0.045, 0.065, 0.17), [-0.105, 0.425, 0.01], [0, 0, -0.22], TINT_ARMOR_HI);
  const collarR = makePart(new THREE.BoxGeometry(0.045, 0.065, 0.17), [0.105, 0.425, 0.01], [0, 0, 0.22], TINT_ARMOR_HI);
  const collarRear = makePart(new THREE.BoxGeometry(0.19, 0.078, 0.045), [0, 0.435, 0.095], [0.22, 0, 0], TINT_ARMOR_HI);
  const packTop = makePart(new THREE.BoxGeometry(0.24, 0.065, 0.14), [0, 0.375, 0.16], [-0.18, 0, 0], TINT_ARMOR);
  const packBot = makePart(new THREE.BoxGeometry(0.2, 0.06, 0.12), [0, 0.115, 0.145], [0.2, 0, 0], TINT_ARMOR);
  const packFinL = makePart(new THREE.BoxGeometry(0.042, 0.24, 0.135), [-0.115, 0.245, 0.175], [0, -0.18, -0.06], TINT_ARMOR_HI);
  const packFinR = makePart(new THREE.BoxGeometry(0.042, 0.24, 0.135), [0.115, 0.245, 0.175], [0, 0.18, 0.06], TINT_ARMOR_HI);
  const torsoArmorPlates = mergeStrict([
    chestL.clone(),
    chestR.clone(),
    chestUpperL.clone(),
    chestUpperR.clone(),
    ribL.clone(),
    ribR.clone(),
    collarL.clone(),
    collarR.clone(),
    collarRear.clone(),
    packTop.clone(),
    packBot.clone(),
    packFinL.clone(),
    packFinR.clone()
  ]);
  const torsoEdgeLine = new THREE.EdgesGeometry(torsoArmorPlates, 26);
  torsoArmorPlates.dispose();
  const torsoArmor = mergeStrict([
    chestL,
    chestR,
    chestUpperL,
    chestUpperR,
    ribL,
    ribR,
    collarL,
    collarR,
    collarRear,
    packTop,
    packBot,
    packFinL,
    packFinR,
    // Inner mechanical spine & core block
    makePart(new THREE.BoxGeometry(0.22, 0.34, 0.18), [0, 0.21, 0.01], [0, 0, 0], TINT_FRAME),
    // Segmented abdomen hydraulic plates
    makePart(new THREE.BoxGeometry(0.16, 0.055, 0.08), [0, 0.06, -0.075], [0.08, 0, 0], TINT_FRAME),
    makePart(new THREE.BoxGeometry(0.18, 0.055, 0.09), [0, 0.125, -0.085], [0.04, 0, 0], TINT_ARMOR),
    // Back core containment rings (dark metallic bands around glowing cylinder)
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.3, 0.195], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.245, 0.195], [0, 0, 0], TINT_FRAME),
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.022, 10), [0, 0.19, 0.195], [0, 0, 0], TINT_FRAME)
  ]);
  const torsoEdgeTrim = mergeStrict([
    makePart(new THREE.BoxGeometry(0.155, 0.012, 0.014), [-0.105, 0.365, -0.145], [0, 0.22, 0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.155, 0.012, 0.014), [0.105, 0.365, -0.145], [0, -0.22, -0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.014, 0.22, 0.014), [-0.135, 0.245, 0.238], [0, 0, -0.06], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.014, 0.22, 0.014), [0.135, 0.245, 0.238], [0, 0, 0.06], TINT_ARMOR)
  ]);
  const torsoGlow = mergeStrict([
    // Main back energy core cylinder (bold & unmistakable from rear & 3/4 angles!)
    makePart(new THREE.CylinderGeometry(0.074, 0.074, 0.26, 12), [0, 0.245, 0.205], [0, 0, 0], TINT_ARMOR),
    // Dual exposed side core conduit vents (visible from side & 3/4 front angles!)
    makePart(new THREE.BoxGeometry(0.028, 0.185, 0.048), [-0.148, 0.255, 0.148], [0, 0, -0.08], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.028, 0.185, 0.048), [0.148, 0.255, 0.148], [0, 0, 0.08], TINT_ARMOR),
    // Front sternum vertical power slit between split chest plates
    makePart(new THREE.BoxGeometry(0.026, 0.15, 0.03), [0, 0.275, -0.128], [-0.12, 0, 0], TINT_ARMOR),
    // Magnetic levitation emitter ring inside neck collar (reinforces floating head!)
    makePart(new THREE.CylinderGeometry(0.07, 0.074, 0.02, 12, 1, true), [0, 0.408, 0], [0, 0, 0], TINT_ARMOR)
  ]);
  const helmCrown = makePart(new THREE.BoxGeometry(0.165, 0.085, 0.22), [0, 0.075, 8e-3], [0.12, 0, 0], TINT_ARMOR_HI);
  const helmFace = makePart(new THREE.BoxGeometry(0.17, 0.095, 0.19), [0, -0.015, 5e-3], [0, 0, 0], TINT_ARMOR);
  const helmJaw = makePart(new THREE.BoxGeometry(0.125, 0.055, 0.155), [0, -0.075, -5e-3], [-0.14, 0, 0], TINT_ARMOR);
  const helmBack = makePart(new THREE.BoxGeometry(0.13, 0.11, 0.09), [0, 0.04, 0.115], [-0.32, 0, 0], TINT_ARMOR_HI);
  const earFinL = makePart(new THREE.BoxGeometry(0.022, 0.105, 0.08), [-0.096, 0.035, 0.035], [-0.35, 0, 0.12], TINT_ARMOR_HI);
  const earFinR = makePart(new THREE.BoxGeometry(0.022, 0.105, 0.08), [0.096, 0.035, 0.035], [-0.35, 0, -0.12], TINT_ARMOR_HI);
  const headPlates = mergeStrict([
    helmCrown.clone(),
    helmFace.clone(),
    helmJaw.clone(),
    helmBack.clone(),
    earFinL.clone(),
    earFinR.clone()
  ]);
  const headEdgeLine = new THREE.EdgesGeometry(headPlates, 26);
  headPlates.dispose();
  const headArmor = mergeStrict([
    helmCrown,
    helmFace,
    helmJaw,
    helmBack,
    earFinL,
    earFinR,
    // Dark recessed visor channel behind glowing horizontal band
    makePart(new THREE.BoxGeometry(0.178, 0.052, 0.05), [0, 8e-3, -0.076], [0, 0, 0], TINT_FRAME),
    // Underside magnetic hover base plate (floating gap visible below this!)
    makePart(new THREE.CylinderGeometry(0.048, 0.038, 0.018, 10), [0, -0.105, 0], [0, 0, 0], TINT_FRAME)
  ]);
  const headVisor = mergeStrict([
    makePart(new THREE.BoxGeometry(0.186, 0.042, 0.026), [0, 8e-3, -0.1], [0, 0, 0], TINT_ARMOR),
    // Wraparound temple light accents
    makePart(new THREE.BoxGeometry(0.02, 0.032, 0.074), [-0.09, 8e-3, -0.062], [0, 0, 0], TINT_ARMOR),
    makePart(new THREE.BoxGeometry(0.02, 0.032, 0.074), [0.09, 8e-3, -0.062], [0, 0, 0], TINT_ARMOR)
  ]);
  const upperL = buildUpperArm(-1);
  const upperR = buildUpperArm(1);
  upperL.edgeLine.dispose();
  upperR.edgeLine.dispose();
  upperL.glow.dispose();
  upperR.glow.dispose();
  const forearmL = buildForearm(-1);
  const forearmR = buildForearm(1);
  const weaponBody = mergeStrict([
    // Main angular receiver
    makePart(new THREE.BoxGeometry(0.058, 0.095, 0.42), [0, 0.01, -0.22], [0, 0, 0], TINT_GUN),
    // Forward rail barrel shroud
    makePart(new THREE.BoxGeometry(0.046, 0.068, 0.28), [0, 0.018, -0.52], [0, 0, 0], TINT_ARMOR_HI),
    // Inner barrel cylinder
    makePart(new THREE.CylinderGeometry(0.015, 0.015, 0.24, 8), [0, 0.02, -0.62], [Math.PI / 2, 0, 0], TINT_FRAME),
    // Buttstock
    makePart(new THREE.BoxGeometry(0.046, 0.082, 0.18), [0, -5e-3, 0.05], [0, 0, 0], TINT_ARMOR),
    // Slanted energy magazine
    makePart(new THREE.BoxGeometry(0.036, 0.15, 0.062), [0, -0.09, -0.26], [0.2, 0, 0], TINT_FRAME),
    // Pistol grip
    makePart(new THREE.BoxGeometry(0.034, 0.095, 0.045), [0, -0.068, -0.07], [-0.26, 0, 0], TINT_FRAME),
    // Holographic sight hood
    makePart(new THREE.BoxGeometry(0.042, 0.038, 0.095), [0, 0.074, -0.18], [0, 0, 0], TINT_ARMOR_HI)
  ]);
  const weaponGlow = mergeStrict([
    // Glowing faction plasma rails along left & right sides of barrel shroud
    makePart(new THREE.BoxGeometry(0.054, 0.013, 0.34), [0, 0.025, -0.44], [0, 0, 0], TINT_ARMOR),
    // Sight reticle emitter
    makePart(new THREE.BoxGeometry(0.024, 0.014, 0.016), [0, 0.076, -0.18], [0, 0, 0], TINT_ARMOR)
  ]);
  const thighL = buildThigh(-1);
  const thighR = buildThigh(1);
  const shinL = buildShin(-1);
  const shinR = buildShin(1);
  shinL.edgeLine.dispose();
  shinR.edgeLine.dispose();
  const foot = mergeStrict([
    // Main cyber sole (bottom at y = -0.080)
    makePart(new THREE.BoxGeometry(0.11, 0.042, 0.24), [0, -0.059, -0.035], [0, 0, 0], TINT_FRAME),
    // Split armored toe hood
    makePart(new THREE.BoxGeometry(0.105, 0.052, 0.135), [0, -0.028, -0.078], [0.2, 0, 0], TINT_ARMOR),
    // Heel stabilizer spur
    makePart(new THREE.BoxGeometry(0.088, 0.058, 0.085), [0, -0.036, 0.055], [-0.14, 0, 0], TINT_ARMOR_HI)
  ]);
  const muzzleQuad = new THREE.PlaneGeometry(0.38, 0.38);
  const totalTris = countGeoTris(pelvis) + countGeoTris(torsoArmor) + countGeoTris(torsoEdgeTrim) + countGeoTris(torsoGlow) + countGeoTris(headArmor) + countGeoTris(headVisor) + countGeoTris(upperL.armor) + countGeoTris(upperR.armor) + countGeoTris(forearmL) + countGeoTris(forearmR) + countGeoTris(weaponBody) + countGeoTris(weaponGlow) + countGeoTris(thighL) + countGeoTris(thighR) + countGeoTris(shinL.armor) + countGeoTris(shinR.armor) + countGeoTris(foot) * 2 + 2;
  cachedGeometries = {
    pelvis,
    torsoArmor,
    torsoEdgeTrim,
    torsoEdgeLine,
    torsoGlow,
    headArmor,
    headEdgeLine,
    headVisor,
    upperArmL: upperL.armor,
    upperArmR: upperR.armor,
    forearmL,
    forearmR,
    weaponBody,
    weaponGlow,
    thighL,
    thighR,
    shinL: shinL.armor,
    shinR: shinR.armor,
    foot,
    muzzleQuad,
    totalTris
  };
  return cachedGeometries;
}
function createRobot(faction = "enemy") {
  const mats = getMaterials();
  const geos = getGeometries();
  const armorMat = mats.armor[faction];
  const glowMat = mats.glow[faction];
  const edgeTrimMat = mats.edgeTrim[faction];
  const edgeLineMat = mats.edgeLine[faction];
  const visorHaloMat = mats.visorHalo[faction];
  const factionGlowHex = faction === "enemy" ? PALETTE.robotGlowEnemy : PALETTE.robotGlowAlly;
  const root = new THREE.Group();
  root.name = `cyber-robot-${faction}`;
  const bodyMeshes = [];
  const armorMeshes = [];
  const glowMeshes = [];
  const edgeLines = [];
  const addMesh = (parent, geo, mat, isGlow = false, castShadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = castShadow;
    m.receiveShadow = true;
    m.frustumCulled = false;
    parent.add(m);
    if (isGlow) glowMeshes.push(m);
    else {
      bodyMeshes.push(m);
      if (mat === armorMat) armorMeshes.push(m);
    }
    return m;
  };
  const addEdge = (parent, geo) => {
    const ls = new THREE.LineSegments(geo, edgeLineMat);
    ls.frustumCulled = false;
    parent.add(ls);
    edgeLines.push(ls);
  };
  const bodyPivot = new THREE.Group();
  bodyPivot.name = "robot-body";
  bodyPivot.position.set(0, 0.96, 0);
  root.add(bodyPivot);
  addMesh(bodyPivot, geos.pelvis, armorMat);
  const torsoPivot = new THREE.Group();
  torsoPivot.name = "robot-torso";
  torsoPivot.position.set(0, 0.08, 0);
  bodyPivot.add(torsoPivot);
  addMesh(torsoPivot, geos.torsoArmor, armorMat);
  addMesh(torsoPivot, geos.torsoEdgeTrim, edgeTrimMat, false, false);
  addMesh(torsoPivot, geos.torsoGlow, glowMat, true, false);
  addEdge(torsoPivot, geos.torsoEdgeLine);
  const headPivot = new THREE.Group();
  headPivot.name = "robot-head";
  headPivot.position.set(0, 0.56, 0);
  torsoPivot.add(headPivot);
  addMesh(headPivot, geos.headArmor, armorMat);
  addEdge(headPivot, geos.headEdgeLine);
  const visorMesh = addMesh(headPivot, geos.headVisor, glowMat, true, false);
  visorMesh.name = "robot-visor";
  const visorHalo = new THREE.Sprite(visorHaloMat);
  visorHalo.name = "robot-visor-halo";
  visorHalo.position.set(0, 8e-3, -0.124);
  visorHalo.scale.set(0.46, 0.24, 1);
  visorHalo.frustumCulled = false;
  visorHalo.renderOrder = 2;
  headPivot.add(visorHalo);
  const headTopAnchor = new THREE.Object3D();
  headTopAnchor.position.set(0, 0.16, 0);
  headPivot.add(headTopAnchor);
  const shoulderL = new THREE.Group();
  shoulderL.name = "robot-shoulder-l";
  shoulderL.position.set(-0.245, 0.34, 0);
  torsoPivot.add(shoulderL);
  addMesh(shoulderL, geos.upperArmL, armorMat, false, false);
  const elbowL = new THREE.Group();
  elbowL.name = "robot-elbow-l";
  elbowL.position.set(-0.01, -0.25, 0);
  shoulderL.add(elbowL);
  addMesh(elbowL, geos.forearmL, armorMat, false, false);
  const shoulderR = new THREE.Group();
  shoulderR.name = "robot-shoulder-r";
  shoulderR.position.set(0.245, 0.34, 0);
  torsoPivot.add(shoulderR);
  addMesh(shoulderR, geos.upperArmR, armorMat, false, false);
  const elbowR = new THREE.Group();
  elbowR.name = "robot-elbow-r";
  elbowR.position.set(0.01, -0.25, 0);
  shoulderR.add(elbowR);
  addMesh(elbowR, geos.forearmR, armorMat, false, false);
  const weaponMount = new THREE.Group();
  weaponMount.name = "robot-weapon";
  weaponMount.position.set(-0.01, -0.24, -0.02);
  elbowR.add(weaponMount);
  addMesh(weaponMount, geos.weaponBody, armorMat, false, false);
  addMesh(weaponMount, geos.weaponGlow, glowMat, true, false);
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.position.set(0, 0.02, -0.76);
  weaponMount.add(muzzleAnchor);
  const muzzleMat = new THREE.MeshBasicMaterial({
    map: mats.flashTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const muzzleMesh = new THREE.Mesh(geos.muzzleQuad, muzzleMat);
  muzzleMesh.position.set(0, 0.02, -0.78);
  muzzleMesh.visible = false;
  muzzleMesh.frustumCulled = false;
  weaponMount.add(muzzleMesh);
  const hipL = new THREE.Group();
  hipL.name = "robot-hip-l";
  hipL.position.set(-0.115, -0.02, 0);
  bodyPivot.add(hipL);
  addMesh(hipL, geos.thighL, armorMat, false, true);
  const kneeL = new THREE.Group();
  kneeL.name = "robot-knee-l";
  kneeL.position.set(0, -0.44, 0);
  hipL.add(kneeL);
  addMesh(kneeL, geos.shinL, armorMat, false, false);
  const ankleL = new THREE.Group();
  ankleL.name = "robot-ankle-l";
  ankleL.position.set(0, -0.42, 0);
  kneeL.add(ankleL);
  addMesh(ankleL, geos.foot, armorMat, false, false);
  const soleProbeL = new THREE.Object3D();
  soleProbeL.position.set(0, -0.08, -0.02);
  ankleL.add(soleProbeL);
  const hipR = new THREE.Group();
  hipR.name = "robot-hip-r";
  hipR.position.set(0.115, -0.02, 0);
  bodyPivot.add(hipR);
  addMesh(hipR, geos.thighR, armorMat, false, true);
  const kneeR = new THREE.Group();
  kneeR.name = "robot-knee-r";
  kneeR.position.set(0, -0.44, 0);
  hipR.add(kneeR);
  addMesh(kneeR, geos.shinR, armorMat, false, false);
  const ankleR = new THREE.Group();
  ankleR.name = "robot-ankle-r";
  ankleR.position.set(0, -0.42, 0);
  kneeR.add(ankleR);
  addMesh(ankleR, geos.foot, armorMat, false, false);
  const soleProbeR = new THREE.Object3D();
  soleProbeR.position.set(0, -0.08, -0.02);
  ankleR.add(soleProbeR);
  let hitFlashOn = false;
  let fadeClones = null;
  let fadeRimStrength = null;
  const setHitFlash = (active) => {
    if (fadeClones) return;
    if (active === hitFlashOn) return;
    hitFlashOn = active;
    visorMesh.material = active ? mats.visorFlash : glowMat;
    visorHalo.material = active ? mats.visorHaloFlash : visorHaloMat;
    const targetArmor = active ? mats.armorHitFlash : armorMat;
    for (const m of armorMeshes) {
      m.material = targetArmor;
    }
  };
  const setDeathFade = (opacity) => {
    const a = Math.max(0, Math.min(1, opacity));
    if (!fadeClones) {
      hitFlashOn = false;
      const fArmor2 = armorMat.clone();
      fArmor2.transparent = true;
      fArmor2.depthWrite = false;
      const fRimStrength = { value: ARMOR_FRESNEL_K[faction] };
      applyArmorFresnel(fArmor2, factionGlowHex, fRimStrength);
      const fTrim2 = edgeTrimMat.clone();
      fTrim2.transparent = true;
      fTrim2.depthWrite = false;
      const fGlow2 = glowMat.clone();
      fGlow2.transparent = true;
      fGlow2.depthWrite = false;
      const fLine2 = edgeLineMat.clone();
      fLine2.transparent = true;
      const fHalo2 = visorHaloMat.clone();
      fHalo2.transparent = true;
      fHalo2.depthWrite = false;
      fadeClones = [fArmor2, fTrim2, fGlow2, fLine2, fHalo2];
      fadeRimStrength = fRimStrength;
      for (const m of bodyMeshes) {
        m.material = m.material === edgeTrimMat ? fTrim2 : fArmor2;
      }
      for (const m of glowMeshes) {
        m.material = fGlow2;
      }
      for (const ls of edgeLines) {
        ls.material = fLine2;
      }
      visorHalo.material = fHalo2;
    }
    const [fArmor, fTrim, fGlow, fLine, fHalo] = fadeClones;
    fArmor.opacity = a;
    fArmor.emissiveIntensity = ARMOR_EMISSIVE_INTENSITY * a;
    if (fadeRimStrength) fadeRimStrength.value = ARMOR_FRESNEL_K[faction] * a;
    fTrim.opacity = a;
    fTrim.emissiveIntensity = 0.55 * a;
    fGlow.opacity = a;
    fGlow.emissiveIntensity = 0.45 * a;
    fLine.opacity = 0.62 * a;
    fHalo.opacity = VISOR_HALO_OPACITY * a;
  };
  const dispose = () => {
    muzzleMat.dispose();
    if (fadeClones) {
      for (const m of fadeClones) m.dispose();
      fadeClones = null;
      fadeRimStrength = null;
    }
  };
  return {
    root,
    faction,
    joints: {
      bodyPivot,
      torsoPivot,
      headPivot,
      shoulderL,
      elbowL,
      shoulderR,
      elbowR,
      weaponMount,
      hipL,
      kneeL,
      ankleL,
      hipR,
      kneeR,
      ankleR
    },
    visorMesh,
    visorHalo,
    glowMeshes,
    edgeLines,
    bodyMeshes,
    headTopAnchor,
    muzzleAnchor,
    muzzleMesh,
    muzzleMat,
    soleProbeL,
    soleProbeR,
    triangleCount: geos.totalTris,
    setHitFlash,
    setDeathFade,
    dispose
  };
}
function disposeRobotCache() {
  if (cachedGeometries) {
    const g = cachedGeometries;
    g.pelvis.dispose();
    g.torsoArmor.dispose();
    g.torsoEdgeTrim.dispose();
    g.torsoEdgeLine.dispose();
    g.torsoGlow.dispose();
    g.headArmor.dispose();
    g.headEdgeLine.dispose();
    g.headVisor.dispose();
    g.upperArmL.dispose();
    g.upperArmR.dispose();
    g.forearmL.dispose();
    g.forearmR.dispose();
    g.weaponBody.dispose();
    g.weaponGlow.dispose();
    g.thighL.dispose();
    g.thighR.dispose();
    g.shinL.dispose();
    g.shinR.dispose();
    g.foot.dispose();
    g.muzzleQuad.dispose();
    cachedGeometries = null;
  }
  if (cachedMaterials) {
    const m = cachedMaterials;
    m.armor.enemy.dispose();
    m.armor.ally.dispose();
    m.armorHitFlash.dispose();
    m.glow.enemy.dispose();
    m.glow.ally.dispose();
    m.edgeTrim.enemy.dispose();
    m.edgeTrim.ally.dispose();
    m.edgeLine.enemy.dispose();
    m.edgeLine.ally.dispose();
    m.visorFlash.dispose();
    m.visorHalo.enemy.dispose();
    m.visorHalo.ally.dispose();
    m.visorHaloFlash.dispose();
    m.visorGlowTex.dispose();
    m.flashTex.dispose();
    cachedMaterials = null;
  }
}
function getRobotTriangleCount() {
  return getGeometries().totalTris;
}

// src/render/enemies.ts
import * as THREE2 from "three";

// src/game/entities.ts
function createEntity(id, pos, maxHp = 100, radius = 0.35, height = 1.7) {
  return {
    id,
    pos,
    radius,
    height,
    hp: maxHp,
    maxHp,
    alive: true,
    deadUntil: 0,
    invincibleUntil: 0
  };
}

// src/game/difficulty.ts
var DIFFICULTIES = [
  {
    id: "easy",
    label: "EASY",
    subLabel: "\u7B80\u5355",
    enemyDmg: 8,
    hitRate: 0.25,
    reactionMs: 900,
    moveSpeed: 2.4,
    totalEnemies: 3,
    maxSimultaneous: 3,
    canTakeCover: false,
    flankPairs: false,
    respawnDelayMs: 3600,
    advanceAfterMs: 18e3
  },
  {
    id: "normal",
    label: "NORMAL",
    subLabel: "\u666E\u901A",
    enemyDmg: 12,
    hitRate: 0.4,
    reactionMs: 600,
    moveSpeed: 3,
    totalEnemies: 5,
    maxSimultaneous: 5,
    canTakeCover: true,
    flankPairs: false,
    respawnDelayMs: 3e3,
    advanceAfterMs: 14e3
  },
  {
    id: "hard",
    label: "HARD",
    subLabel: "\u56F0\u96BE",
    enemyDmg: 16,
    hitRate: 0.55,
    reactionMs: 350,
    moveSpeed: 3.4,
    totalEnemies: 7,
    maxSimultaneous: 5,
    canTakeCover: true,
    flankPairs: true,
    respawnDelayMs: 1800,
    advanceAfterMs: 1e4
  }
];
var DIFFICULTY_MAP = {
  easy: DIFFICULTIES[0],
  normal: DIFFICULTIES[1],
  hard: DIFFICULTIES[2]
};

// src/game/ai.ts
var BOT_TURN_RATE = 8;
var VISION_FOV_DEG = 100;
var VISION_COS_HALF = Math.cos(VISION_FOV_DEG * 0.5 * Math.PI / 180);

// src/render/enemies.ts
var HIT_FLASH_MS = 120;
var FIRE_RECOIL_MS = 220;
var DEATH_COLLAPSE_SEC = 0.72;
var CORPSE_HOLD_SEC = 2.5;
var CORPSE_FADE_SEC = 0.6;
var CONTACT_SHADOW_DIAMETER = 1.05;
var CONTACT_SHADOW_Y = 0.012;
var CONTACT_SHADOW_OPACITY = 0.82;
var CONTACT_SHADOW_RENDER_ORDER = -1;
var sharedShadowTex = null;
var sharedShadowGeo = null;
function makeContactShadowTex() {
  if (typeof document === "undefined") {
    const tex2 = new THREE2.DataTexture(new Uint8Array([12, 16, 24, 180]), 1, 1);
    tex2.needsUpdate = true;
    return tex2;
  }
  const size = 128;
  const half = size / 2;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(half, half, 0, half, half, half - 2);
  g.addColorStop(0, "rgba(12, 16, 24, 0.74)");
  g.addColorStop(0.32, "rgba(12, 16, 24, 0.56)");
  g.addColorStop(0.58, "rgba(12, 16, 24, 0.26)");
  g.addColorStop(0.82, "rgba(12, 16, 24, 0.07)");
  g.addColorStop(1, "rgba(12, 16, 24, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE2.CanvasTexture(c);
  tex.colorSpace = THREE2.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
function wrapPi(a) {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}
function turnAngleToward(current, target, maxStep) {
  const diff = wrapPi(target - current);
  if (Math.abs(diff) <= maxStep) return wrapPi(target);
  return wrapPi(current + Math.sign(diff) * maxStep);
}
function dampVal(cur, target, lambda, dt) {
  if (dt <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function defaultTargets() {
  return {
    bodyY: 0.96,
    bodyPitch: 0,
    bodyRoll: 0,
    torsoPitch: 0,
    torsoYaw: 0,
    headY: 0.56,
    headPitch: 0,
    headYaw: 0,
    shLX: 0.34,
    shLY: -0.22,
    shLZ: 0.14,
    elLX: 0.62,
    elLY: 0.18,
    shRX: 0.24,
    shRY: 0.18,
    shRZ: -0.06,
    elRX: 0.66,
    elRZ: 0.04,
    wpnX: -1.1,
    wpnY: -0.24,
    wpnZ: -0.06,
    wpnPosZ: -0.02,
    hipLX: 0.04,
    hipLZ: 0.04,
    kneeLX: -0.08,
    ankleLX: 0.04,
    hipRX: -0.04,
    hipRZ: -0.04,
    kneeRX: -0.08,
    ankleRX: 0.12
  };
}
var EnemyRig = class {
  root = new THREE2.Group();
  faction;
  robot;
  shadowMesh;
  shadowMat;
  pose = defaultTargets();
  targetPose = defaultTargets();
  activeClip = "idle_rifle";
  modelYaw = 0;
  yawInitialized = false;
  animTime = 0;
  reloadStartMs = -1e4;
  wasReloading = false;
  deadStarted = false;
  deadElapsedSec = 0;
  deathSideSign = 1;
  disposed = false;
  tmpSoleL = new THREE2.Vector3();
  tmpSoleR = new THREE2.Vector3();
  /** Clips played by this enemy instance (diagnostic telemetry for e2e). */
  clipsPlayed = /* @__PURE__ */ new Set();
  constructor(faction) {
    this.faction = faction;
    this.root.name = `enemy-rig-${faction}`;
    this.robot = createRobot(faction);
    this.root.add(this.robot.root);
    if (!sharedShadowTex) sharedShadowTex = makeContactShadowTex();
    if (!sharedShadowGeo) {
      sharedShadowGeo = new THREE2.PlaneGeometry(CONTACT_SHADOW_DIAMETER, CONTACT_SHADOW_DIAMETER);
      sharedShadowGeo.rotateX(-Math.PI / 2);
    }
    this.shadowMat = new THREE2.MeshBasicMaterial({
      map: sharedShadowTex,
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      depthWrite: false
    });
    this.shadowMesh = new THREE2.Mesh(sharedShadowGeo, this.shadowMat);
    this.shadowMesh.name = `enemy-shadow-${faction}`;
    this.shadowMesh.position.set(0, CONTACT_SHADOW_Y, 0);
    this.shadowMesh.renderOrder = CONTACT_SHADOW_RENDER_ORDER;
    this.shadowMesh.castShadow = false;
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.frustumCulled = false;
    this.root.add(this.shadowMesh);
    this.applyJointsToRig();
    this.groundFeet();
  }
  get triangleCount() {
    return this.robot.triangleCount;
  }
  get isLoaded() {
    return true;
  }
  get currentClip() {
    return this.activeClip;
  }
  get isFinishedCorpse() {
    return this.disposed;
  }
  /** Real-time world-space Box3 lowest Y of the robot chassis (excludes contact shadow). */
  measureFeetWorldY() {
    this.root.updateMatrixWorld(true);
    const box = new THREE2.Box3().setFromObject(this.robot.root);
    if (box.isEmpty() || !Number.isFinite(box.min.y)) return null;
    return box.min.y;
  }
  /** Compute world-space Box3 of the robot chassis (excludes ground contact shadow). */
  getChassisWorldBox(out) {
    this.root.updateMatrixWorld(true);
    out.setFromObject(this.robot.root);
    return !out.isEmpty();
  }
  /** Toggle 3D robot chassis visibility while keeping grounded scene shadows intact for A/B diff. */
  setRobotVisible(visible) {
    this.robot.root.visible = visible;
  }
  /** Read actual world-space head top (top of floating helmet) for overhead distance tags. */
  getHeadTopWorld(out) {
    this.root.updateMatrixWorld(true);
    this.robot.headTopAnchor.getWorldPosition(out);
    return out;
  }
  /** Read actual pulse carbine muzzle world position for enemy tracers. */
  getMuzzleWorld(out) {
    this.root.updateMatrixWorld(true);
    this.robot.muzzleAnchor.getWorldPosition(out);
    return true;
  }
  applyJointsToRig() {
    const j = this.robot.joints;
    const p = this.pose;
    j.bodyPivot.position.set(0, p.bodyY, 0);
    j.bodyPivot.rotation.set(p.bodyPitch, 0, p.bodyRoll);
    j.torsoPivot.rotation.set(p.torsoPitch, p.torsoYaw, 0);
    j.headPivot.position.set(0, p.headY, 0);
    j.headPivot.rotation.set(p.headPitch, p.headYaw, 0);
    j.shoulderL.rotation.set(p.shLX, p.shLY, p.shLZ);
    j.elbowL.rotation.set(p.elLX, p.elLY, 0);
    j.shoulderR.rotation.set(p.shRX, p.shRY, p.shRZ);
    j.elbowR.rotation.set(p.elRX, 0, p.elRZ);
    j.weaponMount.rotation.set(p.wpnX, p.wpnY, p.wpnZ);
    j.weaponMount.position.set(-0.01, -0.24, p.wpnPosZ);
    j.hipL.rotation.set(p.hipLX, 0, p.hipLZ);
    j.kneeL.rotation.set(p.kneeLX, 0, 0);
    j.ankleL.rotation.set(p.ankleLX, 0, 0);
    j.hipR.rotation.set(p.hipRX, 0, p.hipRZ);
    j.kneeR.rotation.set(p.kneeRX, 0, 0);
    j.ankleR.rotation.set(p.ankleRX, 0, 0);
  }
  /** Keep the supporting boot sole flush with root.position.y (deck y=0) across all live poses. */
  groundFeet() {
    this.robot.root.position.y = 0;
    this.root.updateMatrixWorld(true);
    this.robot.soleProbeL.getWorldPosition(this.tmpSoleL);
    this.robot.soleProbeR.getWorldPosition(this.tmpSoleR);
    const minWorldY = Math.min(this.tmpSoleL.y, this.tmpSoleR.y);
    const localMinY = minWorldY - this.root.position.y;
    if (Number.isFinite(localMinY)) {
      this.robot.root.position.y = -localMinY;
    }
  }
  computeTargetPose(bot, nowMs) {
    const t = this.targetPose;
    const base = defaultTargets();
    Object.assign(t, base);
    const clip = bot.anim;
    const phase = bot.walkPhase;
    const idleT = this.animTime;
    const hoverBob = Math.sin(idleT * 3.1 + bot.slotIndex * 1.3) * 0.016;
    t.headY = 0.56 + hoverBob;
    const baseClip = clip === "hit" ? bot.state === "PATROL" ? bot.advancing ? "run_rifle" : "walk_rifle" : bot.state === "CHASE" ? "run_rifle" : bot.state === "COVER" ? "crouch_rifle" : bot.state === "RELOAD" ? "reload_rifle" : bot.state === "ENGAGE" || bot.state === "ALERT" ? "aim_rifle" : "idle_rifle" : clip;
    if (baseClip === "idle_rifle") {
      const breathe = Math.sin(idleT * 2.1 + bot.slotIndex) * 0.012;
      t.bodyY = 0.96 + breathe;
      t.torsoPitch = -0.03 + Math.sin(idleT * 1.6) * 0.018;
      t.torsoYaw = Math.sin(idleT * 0.9 + bot.slotIndex) * 0.07;
      t.headYaw = Math.sin(idleT * 1.35 + bot.slotIndex * 1.7) * 0.24;
      t.headPitch = Math.sin(idleT * 0.8) * 0.04;
      t.shLX = 0.36;
      t.shLY = -0.26;
      t.shLZ = 0.14;
      t.elLX = 0.68;
      t.elLY = 0.22;
      t.shRX = 0.24;
      t.shRY = 0.16;
      t.shRZ = -0.06;
      t.elRX = 0.66;
      t.wpnX = -1.1;
      t.wpnY = -0.24;
      t.hipLX = 0.08;
      t.hipLZ = 0.05;
      t.kneeLX = -0.14;
      t.ankleLX = 0.06;
      t.hipRX = -0.06;
      t.hipRZ = -0.05;
      t.kneeRX = -0.12;
      t.ankleRX = 0.18;
    } else if (baseClip === "walk_rifle" || baseClip === "run_rifle") {
      const isRun = baseClip === "run_rifle";
      const amp = isRun ? 0.68 : 0.44;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const bounce = Math.abs(c) * (isRun ? 0.045 : 0.025);
      t.bodyY = (isRun ? 0.91 : 0.945) + bounce;
      t.torsoPitch = isRun ? -0.22 : -0.1;
      t.torsoYaw = -s * (isRun ? 0.16 : 0.1);
      t.headYaw = -t.torsoYaw * 0.65;
      t.headPitch = isRun ? 0.14 : 0.06;
      t.hipLX = s * amp;
      t.kneeLX = -Math.max(0.08, -c * (isRun ? 0.85 : 0.55) + 0.18);
      t.ankleLX = -t.hipLX * 0.45 - t.kneeLX * 0.4;
      t.hipRX = -s * amp;
      t.kneeRX = -Math.max(0.08, c * (isRun ? 0.85 : 0.55) + 0.18);
      t.ankleRX = -t.hipRX * 0.45 - t.kneeRX * 0.4;
      const armSway = s * (isRun ? 0.14 : 0.07);
      t.shRX = (isRun ? 0.42 : 0.34) - armSway;
      t.shRY = 0.24;
      t.shRZ = -0.08;
      t.elRX = isRun ? 0.88 : 0.76;
      t.wpnX = -(t.shRX + t.elRX) - (isRun ? 0.12 : 0.06);
      t.wpnY = -0.34;
      t.wpnZ = -0.1;
      t.shLX = (isRun ? 0.58 : 0.46) + armSway;
      t.shLY = -0.44;
      t.shLZ = 0.18;
      t.elLX = isRun ? 0.92 : 0.78;
      t.elLY = 0.28;
    } else if (baseClip === "aim_rifle" || baseClip === "fire_rifle") {
      const strafeS = bot.speed > 0.15 ? Math.sin(phase) * 0.22 : 0;
      t.bodyY = 0.91;
      t.torsoPitch = -0.07;
      t.torsoYaw = 0.26;
      t.headYaw = -0.26;
      t.headPitch = 0.04;
      t.shRX = 0.48;
      t.shRY = 0.08;
      t.shRZ = -0.08;
      t.elRX = 0.96;
      t.elRZ = 0.08;
      t.wpnX = -(t.shRX + t.elRX);
      t.wpnY = -0.32;
      t.wpnZ = 0;
      t.shLX = 0.86;
      t.shLY = -0.52;
      t.shLZ = 0.22;
      t.elLX = 0.84;
      t.elLY = 0.32;
      t.hipLX = 0.22 + strafeS;
      t.hipLZ = 0.08;
      t.kneeLX = -0.36;
      t.ankleLX = 0.14;
      t.hipRX = -0.18 - strafeS;
      t.hipRZ = -0.08;
      t.kneeRX = -0.28;
      t.ankleRX = 0.42;
      if (baseClip === "fire_rifle") {
        const sinceStart = Math.max(0, nowMs - bot.fireAnimStartAt);
        const kickU = clamp01(1 - sinceStart / FIRE_RECOIL_MS);
        const kick = Math.sin(kickU * Math.PI);
        t.torsoPitch += kick * 0.09;
        t.shRX += kick * 0.2;
        t.elRX -= kick * 0.08;
        t.wpnX = -(t.shRX + t.elRX) + kick * 0.14;
        t.wpnPosZ = -0.02 + kick * 0.065;
        t.headPitch += kick * 0.04;
      }
    } else if (baseClip === "crouch_rifle") {
      const strafeS = bot.speed > 0.15 ? Math.sin(phase) * 0.32 : 0;
      t.bodyY = 0.68;
      t.torsoPitch = -0.2;
      t.torsoYaw = 0.22;
      t.headYaw = -0.22;
      t.headPitch = 0.15;
      t.shRX = 0.56;
      t.shRY = 0.1;
      t.shRZ = -0.08;
      t.elRX = 0.94;
      t.wpnX = -(t.shRX + t.elRX) + 0.12;
      t.wpnY = -0.28;
      t.shLX = 0.88;
      t.shLY = -0.48;
      t.shLZ = 0.22;
      t.elLX = 0.86;
      t.elLY = 0.28;
      t.hipLX = 0.72 + strafeS;
      t.hipLZ = 0.1;
      t.kneeLX = -1.12;
      t.ankleLX = 0.4;
      t.hipRX = 0.48 - strafeS;
      t.hipRZ = -0.1;
      t.kneeRX = -1.04;
      t.ankleRX = 0.56;
    } else if (baseClip === "reload_rifle") {
      const elapsed = Math.max(0, nowMs - this.reloadStartMs);
      const u = clamp01(elapsed / 2200);
      const dip = Math.sin(u * Math.PI);
      const magReach = u > 0.18 && u < 0.72 ? Math.sin((u - 0.18) / 0.54 * Math.PI) : 0;
      t.bodyY = 0.91 - dip * 0.03;
      t.torsoPitch = -0.14 - dip * 0.08;
      t.torsoYaw = 0.18;
      t.headYaw = -0.1;
      t.headPitch = -0.18 * dip;
      t.shRX = 0.42;
      t.shRY = 0.24;
      t.shRZ = -0.12;
      t.elRX = 0.92;
      t.wpnX = -(t.shRX + t.elRX) + 0.22 * dip;
      t.wpnY = -0.42;
      t.wpnZ = 0.35 * dip;
      t.shLX = 0.78 - magReach * 0.58;
      t.shLY = -0.42 + magReach * 0.28;
      t.shLZ = 0.18 + magReach * 0.12;
      t.elLX = 0.86 - magReach * 0.32;
      t.elLY = 0.25;
      t.hipLX = 0.16;
      t.kneeLX = -0.24;
      t.ankleLX = 0.08;
      t.hipRX = -0.12;
      t.kneeRX = -0.22;
      t.ankleRX = 0.34;
    }
    const sinceHit = nowMs - bot.lastHitAt;
    const hitFlashActive = sinceHit >= 0 && sinceHit < HIT_FLASH_MS;
    this.robot.setHitFlash(hitFlashActive);
    if (hitFlashActive) {
      const hu = sinceHit / HIT_FLASH_MS;
      const compress = Math.sin(Math.pow(hu, 0.55) * Math.PI);
      t.bodyY -= compress * 0.12;
      t.torsoPitch += compress * 0.22;
      t.headY -= compress * 0.055;
      t.headPitch += compress * 0.14;
      t.shLZ -= compress * 0.18;
      t.shRZ += compress * 0.18;
      t.kneeLX -= compress * 0.26;
      t.kneeRX -= compress * 0.26;
    }
  }
  /** Synchronize position, yaw, procedural joint animation, hit flash, muzzle flash & death collapse. */
  sync(bot, dt, nowMs) {
    const p = bot.entity.pos;
    this.root.position.set(p.x, p.y, p.z);
    const targetModelYaw = wrapPi(bot.yaw);
    if (!this.yawInitialized) {
      this.modelYaw = targetModelYaw;
      this.yawInitialized = true;
    } else if (bot.state !== "DEAD" && bot.entity.alive) {
      this.modelYaw = turnAngleToward(this.modelYaw, targetModelYaw, BOT_TURN_RATE * dt);
    }
    this.robot.root.rotation.y = this.modelYaw;
    if (bot.state === "DEAD" || !bot.entity.alive) {
      this.activeClip = "die";
      this.clipsPlayed.add("die");
      this.advanceDeath(dt);
      return;
    }
    this.animTime += dt;
    this.activeClip = bot.anim;
    this.clipsPlayed.add(bot.anim);
    if (bot.anim === "reload_rifle" && !this.wasReloading) {
      this.reloadStartMs = nowMs;
      this.wasReloading = true;
    } else if (bot.anim !== "reload_rifle") {
      this.wasReloading = false;
    }
    this.computeTargetPose(bot, nowMs);
    const sinceHit = nowMs - bot.lastHitAt;
    const dampRate = sinceHit >= 0 && sinceHit < HIT_FLASH_MS + 40 ? 40 : 16;
    for (const key of Object.keys(this.pose)) {
      this.pose[key] = dampVal(this.pose[key], this.targetPose[key], dampRate, dt);
    }
    this.applyJointsToRig();
    this.groundFeet();
    const sinceFire = nowMs - bot.lastFireAt;
    const flashOn = sinceFire >= 0 && sinceFire < 75;
    this.robot.muzzleMesh.visible = flashOn;
    if (flashOn) {
      this.robot.muzzleMat.opacity = 1 - sinceFire / 75;
      this.robot.muzzleMesh.rotation.z = nowMs * 0.13 % (Math.PI * 2);
      const sc = 0.85 + 0.35 * (1 - sinceFire / 75);
      this.robot.muzzleMesh.scale.set(sc, sc, 1);
    }
  }
  /** Articulated robotic collapse, 2.5s deck hold, and 0.6s clean dissolve. */
  advanceDeath(dt) {
    if (!this.deadStarted) {
      this.deadStarted = true;
      this.deadElapsedSec = 0;
      this.deathSideSign = Math.sin(this.modelYaw * 3.1) >= 0 ? 1 : -1;
      this.robot.muzzleMesh.visible = false;
      this.robot.setHitFlash(false);
    }
    this.deadElapsedSec += dt;
    const u = clamp01(this.deadElapsedSec / DEATH_COLLAPSE_SEC);
    const buckle = clamp01(u / 0.35);
    const fall = clamp01((u - 0.18) / 0.82);
    const fallEase = fall * fall * (3 - 2 * fall);
    const p = this.pose;
    p.bodyY = dampVal(p.bodyY, 0.96 - buckle * 0.28 - fallEase * 0.48, 22, dt);
    p.bodyPitch = dampVal(p.bodyPitch, fallEase * 1.44, 18, dt);
    p.bodyRoll = dampVal(p.bodyRoll, fallEase * 0.28 * this.deathSideSign, 18, dt);
    p.torsoPitch = dampVal(p.torsoPitch, 0.12 + fallEase * 0.14, 16, dt);
    p.torsoYaw = dampVal(p.torsoYaw, 0.15 * this.deathSideSign, 16, dt);
    p.headY = dampVal(p.headY, 0.56 - fallEase * 0.11, 20, dt);
    p.headPitch = dampVal(p.headPitch, -0.35 * fallEase, 16, dt);
    p.headYaw = dampVal(p.headYaw, 0.45 * this.deathSideSign * fallEase, 16, dt);
    p.shLX = dampVal(p.shLX, -0.35 * fallEase, 14, dt);
    p.shLZ = dampVal(p.shLZ, 0.68 * fallEase, 14, dt);
    p.elLX = dampVal(p.elLX, 0.25, 14, dt);
    p.shRX = dampVal(p.shRX, -0.25 * fallEase, 14, dt);
    p.shRZ = dampVal(p.shRZ, -0.62 * fallEase, 14, dt);
    p.elRX = dampVal(p.elRX, 0.22, 14, dt);
    p.hipLX = dampVal(p.hipLX, 0.38 * buckle - 0.25 * fallEase, 16, dt);
    p.kneeLX = dampVal(p.kneeLX, -0.95 * buckle + 0.55 * fallEase, 16, dt);
    p.hipRX = dampVal(p.hipRX, 0.22 * buckle - 0.15 * fallEase, 16, dt);
    p.kneeRX = dampVal(p.kneeRX, -0.75 * buckle + 0.45 * fallEase, 16, dt);
    this.applyJointsToRig();
    this.robot.root.position.y = dampVal(this.robot.root.position.y, 0, 12, dt);
    const fadeStartSec = DEATH_COLLAPSE_SEC + CORPSE_HOLD_SEC;
    if (this.deadElapsedSec >= fadeStartSec) {
      const fu = clamp01((this.deadElapsedSec - fadeStartSec) / CORPSE_FADE_SEC);
      const opacity = 1 - fu;
      this.robot.setDeathFade(opacity);
      this.shadowMat.opacity = CONTACT_SHADOW_OPACITY * opacity;
      if (fu >= 1) {
        this.shadowMesh.visible = false;
        this.disposed = true;
      }
    }
  }
  dispose() {
    this.robot.dispose();
    this.shadowMat.dispose();
  }
};

// src/game/robotModel.test.ts
function makeMockBot(overrides = {}) {
  const entity = createEntity("bot-test", { x: 0, y: 0, z: 0 }, 100, 0.35, 1.62);
  return {
    id: "bot-test",
    slotIndex: 0,
    faction: "enemy",
    entity,
    state: "IDLE",
    yaw: 0,
    speed: 0,
    ammo: 30,
    mag: 30,
    shotsFired: 0,
    reloadingUntil: 0,
    waypointIdx: 0,
    stateUntil: 0,
    sightAcquiredAt: -1,
    firstShotAt: -1,
    firstSightAt: -1,
    hasLos: false,
    lastSeenPos: null,
    lastSeenAt: -1e4,
    lastContactAt: -1e4,
    advancing: false,
    fireAnimStartAt: -1e4,
    fireAnimEndAt: 0,
    fireHitAt: 0,
    fireHitPending: false,
    nextFireCycleAt: 0,
    flankSign: 1,
    strafeSwitchAt: 0,
    coverTarget: null,
    lastFireAt: -1e4,
    lastHitAt: -1e4,
    diedAt: -1,
    replaceAt: -1,
    anim: "idle_rifle",
    walkPhase: 0,
    ...overrides
  };
}
test("robotModel: single robot <= 2500 tris, metallic PBR bounds, shared cache, emissive-only faction distinction", () => {
  disposeRobotCache();
  const enemy1 = createRobot("enemy");
  const enemy2 = createRobot("enemy");
  const ally = createRobot("ally");
  try {
    const tris = getRobotTriangleCount();
    assert.ok(tris > 400 && tris <= 2500, `expected single robot tris in (400, 2500], got ${tris}`);
    assert.equal(enemy1.triangleCount, tris);
    assert.equal(ally.triangleCount, tris, "enemy and ally must share identical geometry");
    assert.equal(enemy1.bodyMeshes[0].material, enemy2.bodyMeshes[0].material, "armor material must be cached");
    assert.equal(enemy1.bodyMeshes[0].geometry, ally.bodyMeshes[0].geometry, "chassis geometry must be shared");
    assert.equal(enemy1.visorMesh.geometry, ally.visorMesh.geometry, "visor geometry must be identical");
    assert.notEqual(enemy1.visorMesh.material, ally.visorMesh.material, "faction glow material must differ");
    const armorMat = enemy1.bodyMeshes[0].material;
    const enemyGlow = enemy1.visorMesh.material;
    const allyGlow = ally.visorMesh.material;
    assert.ok(armorMat.metalness >= 0.85 && armorMat.metalness <= 0.95, `armor metalness=${armorMat.metalness}`);
    assert.ok(armorMat.roughness >= 0.2 && armorMat.roughness <= 0.35, `armor roughness=${armorMat.roughness}`);
    assert.equal(armorMat.color.getHex(), new THREE3.Color(PALETTE.robotArmor).getHex());
    assert.ok(enemyGlow.metalness >= 0.85 && enemyGlow.metalness <= 0.95, `glow metalness=${enemyGlow.metalness}`);
    assert.ok(enemyGlow.roughness >= 0.2 && enemyGlow.roughness <= 0.35, `glow roughness=${enemyGlow.roughness}`);
    assert.equal(enemyGlow.emissive.getHex(), new THREE3.Color(PALETTE.robotGlowEnemy).getHex());
    assert.equal(allyGlow.emissive.getHex(), new THREE3.Color(PALETTE.robotGlowAlly).getHex());
    assert.ok(enemyGlow.emissiveIntensity >= 3, `strong emissive expected, got ${enemyGlow.emissiveIntensity}`);
    assert.ok(enemy1.joints.headPivot.position.y >= 0.54, "head must float above torso collar");
    enemy1.setHitFlash(true);
    const flashMat = enemy1.visorMesh.material;
    assert.equal(flashMat.emissive.getHex(), new THREE3.Color(PALETTE.robotHitFlash).getHex());
    enemy1.setHitFlash(false);
    assert.equal(enemy1.visorMesh.material, enemyGlow);
  } finally {
    enemy1.dispose();
    enemy2.dispose();
    ally.dispose();
    disposeRobotCache();
  }
});
test("EnemyRig: all 6 animation states (idle/walk/aim/fire/hit/death) articulate joints distinctly", () => {
  disposeRobotCache();
  const rig = new EnemyRig("enemy");
  const getJointSnap = () => {
    const r = rig.root.children[0];
    const body = r.getObjectByName("robot-body");
    const torso = r.getObjectByName("robot-torso");
    const head = r.getObjectByName("robot-head");
    const shR = r.getObjectByName("robot-shoulder-r");
    const hipL = r.getObjectByName("robot-hip-l");
    const kneeL = r.getObjectByName("robot-knee-l");
    const weapon = r.getObjectByName("robot-weapon");
    const visor = r.getObjectByName("robot-visor");
    return {
      bodyY: body.position.y,
      bodyPitch: body.rotation.x,
      torsoPitch: torso.rotation.x,
      torsoYaw: torso.rotation.y,
      headY: head.position.y,
      headYaw: head.rotation.y,
      shRX: shR.rotation.x,
      hipLX: hipL.rotation.x,
      kneeLX: kneeL.rotation.x,
      wpnPosZ: weapon.position.z,
      visorHex: visor.material.emissive.getHex()
    };
  };
  try {
    const stepState = (anim, patch, steps = 15, dt = 0.05, nowMs = 1e3) => {
      const bot = makeMockBot({ anim, ...patch });
      for (let i = 0; i < steps; i++) {
        rig.sync(bot, dt, nowMs + i * dt * 1e3);
      }
      return getJointSnap();
    };
    const idleA = stepState("idle_rifle", { state: "IDLE" }, 5, 0.05, 1e3);
    const idleB = stepState("idle_rifle", { state: "IDLE" }, 20, 0.05, 1500);
    assert.ok(Math.abs(idleB.headYaw - idleA.headYaw) > 0.02, "idle head should scan, not stay frozen");
    const walkA = stepState("walk_rifle", { state: "PATROL", walkPhase: Math.PI / 2, speed: 1.4 }, 18, 0.05, 3e3);
    const walkB = stepState("walk_rifle", { state: "PATROL", walkPhase: -Math.PI / 2, speed: 1.4 }, 18, 0.05, 4e3);
    assert.ok(Math.abs(walkA.hipLX - walkB.hipLX) > 0.5, "walk must articulate hip stride");
    const aim = stepState("aim_rifle", { state: "ENGAGE" }, 20, 0.05, 5e3);
    assert.ok(Math.abs(aim.torsoYaw) > 0.15 && aim.shRX > 0.4, "aim must articulate torso & weapon arms");
    const fire = stepState(
      "fire_rifle",
      { state: "ENGAGE", fireAnimStartAt: 6e3, lastFireAt: 6e3 },
      4,
      0.02,
      6040
    );
    assert.ok(fire.wpnPosZ > aim.wpnPosZ + 0.015, "fire must produce weapon recoil displacement");
    assert.ok(fire.shRX > aim.shRX + 0.05, "fire must kick right shoulder");
    const hit = stepState("hit", { state: "ENGAGE", lastHitAt: 7e3 }, 3, 0.015, 7035);
    assert.ok(hit.bodyY < aim.bodyY - 0.04, "hit must compress armor downward");
    assert.equal(hit.visorHex, new THREE3.Color(PALETTE.robotHitFlash).getHex(), "hit must flash visor white");
    const postHit = stepState("aim_rifle", { state: "ENGAGE", lastHitAt: 7e3 }, 2, 0.016, 7200);
    assert.equal(postHit.visorHex, new THREE3.Color(PALETTE.robotGlowEnemy).getHex(), "visor must restore after 0.12s");
    const deadBot = makeMockBot({ state: "DEAD", anim: "die" });
    deadBot.entity.alive = false;
    for (let i = 0; i < 30; i++) {
      rig.sync(deadBot, 0.03, 8e3 + i * 30);
    }
    const dead = getJointSnap();
    assert.ok(dead.bodyPitch > 1, `death must topple chassis (bodyPitch=${dead.bodyPitch})`);
    assert.ok(dead.bodyY < 0.45, `death must drop pelvis onto deck (bodyY=${dead.bodyY})`);
    assert.ok(dead.headY < aim.headY - 0.06, "death must drop floating head as magnetic power cuts");
  } finally {
    rig.dispose();
    disposeRobotCache();
  }
});
test("robotModel: Fresnel rim shader injection, visor additive halo, hit-flash & death-fade clones", () => {
  disposeRobotCache();
  const enemy = createRobot("enemy");
  const enemyPeer = createRobot("enemy");
  const ally = createRobot("ally");
  try {
    const enemyArmor = enemy.bodyMeshes[0].material;
    const allyArmor = ally.bodyMeshes[0].material;
    assert.equal(enemyArmor.customProgramCacheKey(), ARMOR_FRESNEL_CACHE_KEY);
    assert.equal(allyArmor.customProgramCacheKey(), ARMOR_FRESNEL_CACHE_KEY);
    assert.equal(enemyArmor.userData.fresnelRimColor, PALETTE.robotGlowEnemy);
    assert.equal(allyArmor.userData.fresnelRimColor, PALETTE.robotGlowAlly);
    assert.ok(enemyArmor.userData.fresnelRimStrength.value > 0);
    assert.ok(allyArmor.userData.fresnelRimStrength.value > 0);
    const mockShader = {
      uniforms: {},
      fragmentShader: "#include <common>\nvoid main() {\n#include <emissivemap_fragment>\n}",
      vertexShader: ""
    };
    enemyArmor.onBeforeCompile(mockShader, {});
    assert.ok(mockShader.uniforms.uRimColor, "uRimColor uniform must be injected");
    assert.ok(mockShader.uniforms.uRimStrength, "uRimStrength uniform must be injected");
    assert.match(mockShader.fragmentShader, /pow\(\s*1\.0\s*-\s*rimNdotV,\s*3\.0\s*\)/);
    assert.match(mockShader.fragmentShader, /totalEmissiveRadiance\s*\+=\s*uRimColor/);
    const haloMat = enemy.visorHalo.material;
    assert.equal(haloMat.blending, THREE3.AdditiveBlending);
    assert.equal(haloMat.depthWrite, false);
    assert.equal(haloMat.fog, false);
    assert.equal(haloMat.color.getHex(), new THREE3.Color(PALETTE.robotGlowEnemy).getHex());
    const allyHaloMat = ally.visorHalo.material;
    assert.equal(allyHaloMat.color.getHex(), new THREE3.Color(PALETTE.robotGlowAlly).getHex());
    enemy.setHitFlash(true);
    const hitArmor = enemy.bodyMeshes[0].material;
    const hitHalo = enemy.visorHalo.material;
    assert.equal(hitArmor.userData.fresnelRimColor, PALETTE.robotHitFlash);
    assert.equal(hitArmor.customProgramCacheKey(), ARMOR_FRESNEL_CACHE_KEY);
    assert.equal(hitHalo.color.getHex(), new THREE3.Color(PALETTE.robotHitFlash).getHex());
    assert.equal(enemyPeer.bodyMeshes[0].material, enemyArmor);
    enemy.setHitFlash(false);
    assert.equal(enemy.bodyMeshes[0].material, enemyArmor);
    assert.equal(enemy.visorHalo.material, haloMat);
    const baseRimK = enemyArmor.userData.fresnelRimStrength.value;
    enemy.setDeathFade(0.5);
    const fadeArmor = enemy.bodyMeshes[0].material;
    const fadeHalo = enemy.visorHalo.material;
    assert.notEqual(fadeArmor, enemyArmor, "death fade must clone armor material");
    assert.equal(fadeArmor.transparent, true);
    assert.equal(fadeArmor.opacity, 0.5);
    assert.equal(fadeArmor.customProgramCacheKey(), ARMOR_FRESNEL_CACHE_KEY);
    assert.equal(fadeArmor.userData.fresnelRimColor, PALETTE.robotGlowEnemy);
    assert.ok(Math.abs(fadeArmor.userData.fresnelRimStrength.value - baseRimK * 0.5) < 1e-6);
    assert.ok(fadeHalo.opacity < haloMat.opacity && fadeHalo.opacity > 0);
    assert.equal(enemyPeer.bodyMeshes[0].material.opacity, 1);
    assert.equal(enemyArmor.userData.fresnelRimStrength.value, baseRimK);
  } finally {
    enemy.dispose();
    enemyPeer.dispose();
    ally.dispose();
    disposeRobotCache();
  }
});
