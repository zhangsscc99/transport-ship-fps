// Central color palette — the ONLY file allowed to contain color literals.
// Source: docs/ART-SPEC.md §1. Every render material must pull from here.

export const PALETTE = {
  deck: ['#2e343a', '#3a3f45', '#4c555f'], // 甲板钢板：暗/中/亮 3 档
  deckLine: '#c9a227', // 甲板警示黄线
  container: ['#7a3b2e', '#2f5d50', '#41506b', '#6b5a3e'], // 集装箱 4 主色
  containerTop: '#8a8a8a',
  rust: '#6b3a22',
  tower: ['#48535f', '#5a6673'],
  pipe: '#2d353d',
  sea: ['#16242e', '#1b2833', '#2b4252'],
  sky: ['#2b3a49', '#42566a'], // [0] 天顶，[1] 半球光上色
  skyHorizon: '#78889a', // 地平线雾霾亮灰蓝 — 画面里最亮的底色
  fill: '#8899aa', // 反向补光（冷灰蓝）
  fog: '#5b6b78', // 雾色必须贴近天空，不许是黑
  sun: '#ffd9b0', // 主方向光：雨后天光暖白
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
  gun: ['#23282d', '#2b2f33', '#5a6570'], // 枪体：暗/中/亮
  gunHi: '#7a8a99', // 枪身高光条 emissive
  glove: '#4a4c50', // 手臂——比枪身亮，分出层次
  flashCore: '#ffd9a0', // 枪口焰心
  tracer: '#c9a227', // 曳光（同警示黄）
  crosshair: '#eef4fa',
  crosshairEdge: 'rgba(4,8,12,0.85)',
  deadVeil: 'rgba(80,16,14,0.35)',
  hurtVeil: 'rgba(178,44,38,0.85)', // 受击/低血 屏幕边缘红晕外缘
  lampRed: '#e4553f', // 船头红色警示灯
  lampWarm: '#ffc27a', // 哨塔暖黄工作灯 / 亮窗
  wood: '#6d5637', // 木托盘
  crane: '#27333d', // 远处起重机剪影
} as const;
