// Central color palette — the ONLY file allowed to contain color literals.
// Source: docs/ART-SPEC.md §1. Every render material must pull from here.

export const PALETTE = {
  deck: ['#22282e', '#2c333b', '#3d4651'], // 甲板钢板：深海冷钢 3 档，拉出湿反光与明暗层次
  deckLine: '#d1a82e', // 甲板警示黄线
  container: ['#8f3b2e', '#2b4d6f', '#3f5940', '#7d6138'], // 集装箱 4 主色：锈红 / 深蓝 / 橄榄绿 / 赭黄
  containerTop: '#6e7378',
  rust: '#7a3f22',
  tower: ['#5d656d', '#6e7780'], // 混凝土哨塔（中性偏冷灰）
  steelFrame: '#4a5764', // 平台 H 型钢 / 工字钢 / 槽钢工业钢构（蓝灰漆钢）
  checker: '#535e69', // 花纹钢板台面与踏板
  kickplate: '#5b6570', // 护栏踢脚板（带锈迹流痕底色）
  elecBox: '#6a7580', // 配电箱工业灰漆箱体
  cabGlass: '#7fa8c4', // 吊机驾驶室反光玻璃
  oilStain: '#1a2028', // 地面油渍暗泽
  pipe: '#485460', // 管件/系缆桩——金属高光吃 IBL
  sea: ['#152430', '#1c2f3e', '#2c465a'],
  sky: ['#384c63', '#6f8db3'], // [0] 天顶，[1] 半球光天光色
  skyGround: '#2a2622', // 半球光地面反弹色（暖暗甲板）
  skyHorizon: '#7c93aa', // 地平线雾霾灰蓝 — 与雾色贴合
  // Saltline-inspired dusk/maritime sky — linear-space RGB triples
  skyZen: [0.065, 0.11, 0.185],
  skyHor: [0.86, 0.58, 0.34],
  skyHorAway: [0.19, 0.27, 0.38],
  fill: '#5b7fb3', // 冷色反方向补光
  fog: '#6c8298', // 指数雾色：取地平线灰蓝，与远景吊机/海面自然融出
  sun: '#ffe6c4', // 主方向光：低角度暖白太阳（15° 仰角）
  teamA: '#4fa4f1', // 我方：蓝
  teamB: '#ff4655', // 敌方：红
  hpFull: '#ece8e1', // VALORANT 灰白血条（非饱和色块）
  hpSeg2: '#b8e0ff', // 第二段 100–200 护甲级战术亮蓝白
  hpMid: '#d5d1ca',
  hpLow: '#ff4655', // 仅低血量/危险使用 Valorant 红
  uiPanel: 'rgba(8,12,18,0.55)',
  uiBtnPanel: 'rgba(14,19,27,0.90)',
  uiBtnGradTop: 'rgba(188,208,230,0.048)',
  uiBtnGradMid: 'rgba(14,19,27,0.00)',
  uiBtnGradBot: 'rgba(2,5,10,0.14)',
  uiBtnHiTop: 'rgba(255,255,255,0.28)',
  uiBtnHiInnerBot: 'rgba(0,0,0,0.45)',
  uiBtnPressedTop: 'rgba(255,255,255,0.24)',
  uiBtnPressedMid: 'rgba(255,255,255,0.14)',
  uiBtnPressedBot: 'rgba(255,255,255,0.08)',
  uiBtnPressedGlow: 'rgba(255,255,255,0.22)',
  uiBtnActiveTop: 'rgba(255,70,85,0.18)',
  uiBtnActiveMid: 'rgba(255,70,85,0.12)',
  uiBtnActiveBot: 'rgba(255,70,85,0.08)',
  uiBtnBorder: 'rgba(236,232,225,0.48)',
  uiBtnBorderDisabled: 'rgba(154,164,176,0.42)',
  uiBtnFgDisabled: 'rgba(176,184,194,0.58)',
  uiBtnFireInnerRing: 'rgba(255,70,85,0.34)',
  uiBtnReloadTrack: 'rgba(236,232,225,0.18)',
  uiBtnReloadSweep: 'rgba(255,70,85,0.22)',
  uiBtnShadow: 'rgba(4,7,12,0.58)',
  uiBorder: 'rgba(255,255,255,0.18)',
  uiBorderActive: 'rgba(236,232,225,0.72)',
  uiText: '#ece8e1',
  uiDim: 'rgba(236,232,225,0.60)',
  uiEmpty: 'rgba(255,255,255,0.14)',
  accent: '#ff4655', // Valorant 红 — 仅用于危险/开火/低血量
  gun: ['#2e343b', '#3a4149', '#67727f'], // 枪体：暗/中/亮
  gunDark: '#252b32', // 弹匣/小件：偏暗哑光
  gunHi: '#8ea0b0', // 枪身高光条 emissive
  glove: '#5d6167', // 手臂——比枪身亮，分出层次
  skinBase: '#d49d7a', // 真人肤色基色（暖自然肤）
  skinWarm: '#c27958', // 肤色指节/皮下暖散射近似色
  skinNail: '#e4c2ae', // 指甲盖浅暖色
  tacGlove: '#2d333b', // 战术露指手套主料
  tacKnuckle: '#1d2228', // 手背护骨甲
  tacSleeve: '#2b3b4e', // 战术服袖子（海军灰蓝）
  tacCuff: '#212d3b', // 袖口加厚翻边
  tacVelcro: '#171c22', // 袖口魔术贴
  tacStitch: '#6c7c8e', // 袖口双排缝线
  // 赛博朋克机器人（全程序化金属 PBR，阵营仅靠发光色区分）
  robotArmor: '#2e3542', // 深灰蓝金属装甲漆面（避开 ACES 暗部死黑压暗，兼顾明暗背景对比）
  robotFrame: '#171a21', // 机械骨架与关节暗金属
  robotGun: '#2b303a', // 机器人脉冲步枪机匣
  robotEdge: '#6c7a92', // 装甲边缘 1px 弱发光亮边
  robotGlowEnemy: '#ff2d95', // 敌方强发光：品红
  robotGlowAlly: '#22e0ff', // 我方/AI 友军强发光：青
  robotHitFlash: '#ffffff', // 受击 0.12s 视带闪白
  // 敌人头顶距离牌 & 极简血条
  tagGlassBg: 'rgba(8,12,20,0.62)', // 深色半透明玻璃底
  tagBorderCyan: 'rgba(120,255,255,0.35)', // 1px 常规冷青内发光描边
  tagBorderWarm: '#ffb454', // <10m 暖色警示描边与 4px 圆点
  tagGlowCyan: 'rgba(120,255,255,0.22)', // 常规 1px 内发光
  tagGlowWarm: 'rgba(255,180,84,0.32)', // <10m 暖色内发光
  tagText: '#eef4fa', // 距离牌等宽数字色
  tagHpTrack: 'rgba(255,255,255,0.14)', // 血条轨道底色
  tagHpHigh: '#22e0ff', // 血量 >60%：青
  tagHpMid: '#ffd166', // 血量 30%–60%：黄
  tagHpLow: '#ff4655', // 血量 <=30%：红
  bootDark: '#17191d', // 战术军靴
  brass: '#d8b054', // 弹壳 / 弹匣顶弹 / 加特林弹链黄铜
  gatlingAccent: '#f5b041', // 加特林重武 HUD 琥珀橙
  gatlingReady: '#5ee39a', // 加特林预热就绪绿
  gatlingBlur: '#9ab4cc', // 加特林枪管高速旋转残影
  flashCore: '#fffdf2', // 枪口白热星形核心
  flashMid: '#ff9626', // 枪口中层橙黄锥形火焰
  flashOuter: '#ff4812', // 枪口火焰外缘灼橙
  muzzleSmoke: '#cfe8f5', // 枪口外层淡青白短烟
  muzzleLight: '#ffb066', // 枪口 PointLight 暖光
  spark: '#ffd26a', // 命中火花
  dust: '#a6b0b8', // 命中微尘
  bulletHole: '#14171c', // 弹孔中心焦黑
  tracer: '#ffd670', // 曳光亮条
  crosshair: '#f2f6fa',
  crosshairHit: '#ff4655',
  crosshairEdge: 'rgba(4,8,12,0.85)',
  deadVeil: 'rgba(8,12,18,0.76)',
  hurtVeil: 'rgba(255,70,85,0.72)', // 受击/低血 屏幕边缘红晕外缘
  lampRed: '#e4553f', // 船头红色警示灯
  lampWarm: '#ffc27a', // 哨塔暖黄工作灯 / 亮窗
  wood: '#785e3c', // 木托盘/木箱
  crane: '#354352', // 远处港口吊机剪影（靠指数雾自然淡入地平线）
  hull: '#353e47', // 船体外板——深海灰钢，吃金属 IBL 反光
  hullBand: '#7a3222', // 水线防污漆——氧化红
  cone: '#d66d22', // 警示锥——安全橙
  rope: '#917a55', // 缆绳卷——麻色
} as const;
