// src/game/hudLayout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/game/player.ts
var MOVE = {
  walkSpeed: 4.2,
  crouchSpeed: 1.9,
  jumpSpeed: 4.8,
  gravity: -18,
  eyeHeight: 1.7,
  crouchEyeHeight: 1.15,
  pitchLimit: 85 * Math.PI / 180
};

// src/game/input.ts
var TOUCH_LOOK_SENSITIVITY = 0.35 * Math.PI / 180;

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
  uiBtnBorder: "rgba(236,232,225,0.48)",
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
  // 战术服袖子（保卫者海军灰蓝）
  tacCuff: "#212d3b",
  // 袖口加厚翻边
  tacVelcro: "#171c22",
  // 袖口魔术贴
  tacStitch: "#6c7c8e",
  // 袖口双排缝线
  blSuit: "#1c1f25",
  // 潜伏者：黑红战术服底色
  blTeam: "#b3221f",
  // 潜伏者：TeamColour 暗红染色
  blRed: "#d4262e",
  // 潜伏者：战术红甲/肩带/臂章
  blMask: "#131519",
  // 潜伏者：黑色战术面罩
  blEye: "#ff2836",
  // 潜伏者：红眼灯
  blTagBg: "rgba(155, 28, 25, 0.88)",
  // 潜伏者头顶标签暗红底
  blTagBorder: "rgba(255, 92, 86, 0.9)",
  grSuit: "#213f68",
  // 保卫者：深蓝战术服
  grTeam: "#2f6fb0",
  // 保卫者：TeamColour 战术蓝染色
  grWhite: "#e6ecf2",
  // 保卫者：白色防弹胸甲/护肩
  grHelmet: "#1a2e4a",
  // 保卫者：蓝色战术头盔
  grEye: "#2ec4ff",
  // 保卫者：蓝眼灯
  grTagBg: "rgba(35, 90, 148, 0.88)",
  // 保卫者头顶标签战术蓝底
  grTagBorder: "rgba(94, 180, 255, 0.9)",
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

// src/render/hud.ts
var HURT_BG = `radial-gradient(ellipse 115% 90% at 50% 50%, transparent 55%, ${PALETTE.hurtVeil} 100%)`;

// src/input/touch.ts
var PORTRAIT_LAYOUT = {
  stick: { left: 20, bottom: 82 },
  btns: {
    fire: { size: 76, side: "right", x: 24, bottom: 24 },
    reload: { size: 52, side: "right", x: 108, bottom: 36 },
    swap: { size: 52, side: "right", x: 92, bottom: 108 },
    jump: { size: 52, side: "right", x: 28, bottom: 108 },
    crouch: { size: 48, side: "right", x: 30, bottom: 168 }
  }
};
var LANDSCAPE_LAYOUT = {
  stick: { left: 20, bottom: 72 },
  btns: {
    fire: { size: 70, side: "right", x: 16, bottom: 16 },
    reload: { size: 48, side: "right", x: 96, bottom: 32 },
    swap: { size: 48, side: "right", x: 84, bottom: 88 },
    jump: { size: 48, side: "right", x: 26, bottom: 94 },
    crouch: { size: 44, side: "right", x: 28, bottom: 150 }
  }
};

// src/game/hudLayout.test.ts
var BTN_IDS = ["fire", "reload", "swap", "jump", "crouch"];
function anchorToRect(id, a, vw, vh) {
  const x = a.side === "right" ? vw - a.x - a.size : a.x;
  const y = vh - a.bottom - a.size;
  return { id, x, y, w: a.size, h: a.size, right: x + a.size, bottom: y + a.size };
}
function layoutRects(spec, vw, vh) {
  const out = {};
  for (const id of BTN_IDS) {
    out[id] = anchorToRect(id, spec.btns[id], vw, vh);
  }
  return out;
}
function rectsOverlap(a, b) {
  return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
}
function rectGap(a, b) {
  const dx = Math.max(0, a.x - b.right, b.x - a.right);
  const dy = Math.max(0, a.y - b.bottom, b.y - a.bottom);
  return Math.hypot(dx, dy);
}
test("portrait 390x844: 5 action button rects never overlap, pairwise gap >= 6px, edge margin >= 8px, FIRE margin 24+-2px", () => {
  const VW = 390;
  const VH = 844;
  const rects = layoutRects(PORTRAIT_LAYOUT, VW, VH);
  const list = BTN_IDS.map((id) => rects[id]);
  for (const r of list) {
    assert.ok(r.w >= 44 && r.h >= 44, `${r.id} size ${r.w}x${r.h} < 44px`);
    assert.ok(r.x >= 8, `${r.id} left margin ${r.x} < 8px`);
    assert.ok(r.y >= 8, `${r.id} top margin ${r.y} < 8px`);
    assert.ok(VW - r.right >= 8, `${r.id} right margin ${VW - r.right} < 8px`);
    assert.ok(VH - r.bottom >= 8, `${r.id} bottom margin ${VH - r.bottom} < 8px`);
  }
  const fire = rects.fire;
  const fireRightMargin = VW - fire.right;
  const fireBottomMargin = VH - fire.bottom;
  assert.ok(
    Math.abs(fireRightMargin - 24) <= 2,
    `FIRE right margin ${fireRightMargin} outside 24+-2px`
  );
  assert.ok(
    Math.abs(fireBottomMargin - 24) <= 2,
    `FIRE bottom margin ${fireBottomMargin} outside 24+-2px`
  );
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      assert.equal(rectsOverlap(a, b), false, `${a.id} overlaps ${b.id}`);
      const gap = rectGap(a, b);
      assert.ok(gap >= 6, `${a.id} <-> ${b.id} gap ${gap.toFixed(1)}px < 6px`);
    }
  }
  const cx = VW / 2;
  const cy = VH / 2;
  for (const r of list) {
    const dx = Math.max(r.x - cx, 0, cx - r.right);
    const dy = Math.max(r.y - cy, 0, cy - r.bottom);
    const dist = Math.hypot(dx, dy);
    assert.ok(dist >= 120, `${r.id} intrudes into 120px crosshair circle (dist=${dist.toFixed(1)}px)`);
  }
});
test("landscape 844x390: all 5 action button rects match baseline anchors pixel-for-pixel", () => {
  const VW = 844;
  const VH = 390;
  const rects = layoutRects(LANDSCAPE_LAYOUT, VW, VH);
  const expected = {
    fire: { x: 758, y: 304, w: 70, h: 70 },
    reload: { x: 700, y: 310, w: 48, h: 48 },
    swap: { x: 712, y: 254, w: 48, h: 48 },
    jump: { x: 770, y: 248, w: 48, h: 48 },
    crouch: { x: 772, y: 196, w: 44, h: 44 }
  };
  for (const id of BTN_IDS) {
    const actual = rects[id];
    const exp = expected[id];
    assert.deepEqual(
      { x: actual.x, y: actual.y, w: actual.w, h: actual.h },
      exp,
      `landscape ${id} rect drifted from baseline`
    );
  }
});
