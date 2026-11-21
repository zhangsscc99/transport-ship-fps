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
  hpMid: '#d5d1ca',
  hpLow: '#ff4655', // 仅低血量/危险使用 Valorant 红
  uiPanel: 'rgba(8,12,18,0.55)',
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
  brass: '#d8b054', // 弹壳 / 弹匣顶弹黄铜
  shellRed: '#b8322a', // 霰弹红色弹体
  flashCore: '#ffd9a0', // 枪口焰心
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
