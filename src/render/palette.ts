// Central color palette — the ONLY file allowed to contain color literals.
// Source: docs/ART-SPEC.md §1. Every render material must pull from here.

export const PALETTE = {
  deck: ['#323940', '#3f4750', '#545f6b'], // 甲板钢板：暗/中/亮 3 档
  deckLine: '#d1a82e', // 甲板警示黄线
  container: ['#8f3b2e', '#2b4d6f', '#3f5940', '#7d6138'], // 集装箱 4 主色：锈红 / 深蓝 / 橄榄绿 / 赭黄
  containerTop: '#6e7378',
  rust: '#7a3f22',
  tower: ['#5d656d', '#6e7780'], // 混凝土哨塔（中性偏冷灰）
  pipe: '#485460', // 管件/系缆桩——金属高光吃 IBL
  sea: ['#192a36', '#213544', '#314c60'],
  sky: ['#384c63', '#6f8db3'], // [0] 天顶，[1] 半球光天光色
  skyGround: '#2a2622', // 半球光地面反弹色（暖暗甲板）
  skyHorizon: '#8ca1b6', // 地平线雾霾亮灰蓝 — 与雾色贴合
  // Saltline-inspired dusk/maritime sky — linear-space RGB triples
  skyZen: [0.09, 0.14, 0.22],
  skyHor: [0.98, 0.72, 0.44],
  skyHorAway: [0.24, 0.33, 0.44],
  fill: '#5b7fb3', // 冷色反方向补光
  fog: '#788da3', // 指数雾色：取地平线灰蓝，与远景吊机/海面自然融出
  sun: '#ffe6c4', // 主方向光：低角度暖白太阳（15° 仰角）
  teamA: '#4fa4f1', // 我方：蓝
  teamB: '#d9534f', // 敌方：红
  hpFull: '#5fd35f',
  hpMid: '#e0c341',
  hpLow: '#d9534f',
  uiPanel: 'rgba(12,18,24,0.78)',
  uiBorder: '#3f5666',
  uiText: '#dfe7ee',
  uiDim: '#8fa0ad',
  accent: '#ff8b3d', // 开火/命中/危险提示
  gun: ['#2e343b', '#3a4149', '#67727f'], // 枪体：暗/中/亮
  gunDark: '#252b32', // 弹匣/小件：偏暗哑光
  gunHi: '#8ea0b0', // 枪身高光条 emissive
  glove: '#5d6167', // 手臂——比枪身亮，分出层次
  flashCore: '#ffd9a0', // 枪口焰心
  tracer: '#c9a227', // 曳光（同警示黄）
  crosshair: '#eef4fa',
  crosshairEdge: 'rgba(4,8,12,0.85)',
  deadVeil: 'rgba(80,16,14,0.35)',
  hurtVeil: 'rgba(178,44,38,0.85)', // 受击/低血 屏幕边缘红晕外缘
  lampRed: '#e4553f', // 船头红色警示灯
  lampWarm: '#ffc27a', // 哨塔暖黄工作灯 / 亮窗
  wood: '#785e3c', // 木托盘/木箱
  crane: '#354352', // 远处港口吊机剪影（靠指数雾自然淡入地平线）
  hull: '#353e47', // 船体外板——深海灰钢，吃金属 IBL 反光
  hullBand: '#7a3222', // 水线防污漆——氧化红
  cone: '#d66d22', // 警示锥——安全橙
  rope: '#917a55', // 缆绳卷——麻色
} as const;
