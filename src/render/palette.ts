// Central color palette — the ONLY file allowed to contain color literals.
// Source: docs/ART-SPEC.md §1. Every render material must pull from here.

export const PALETTE = {
  deck: ['#2b3138', '#3a424b', '#4a535e'], // 甲板钢板：暗/中/亮 3 档
  deckLine: '#c9a227', // 甲板警示黄线
  container: ['#7a3b2e', '#2f5d50', '#41506b', '#6b5a3e'], // 集装箱 4 主色
  containerTop: '#8a8a8a',
  rust: '#6b3a22',
  tower: ['#39424d', '#4b5561'],
  pipe: '#20262c',
  sea: ['#13212b', '#1b2f3c', '#27414f'],
  sky: ['#0e1620', '#1a2a38'],
  fog: '#16222c',
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
  gun: ['#242a31', '#363f48', '#4a545f'], // 枪体：暗/中/亮
  flashCore: '#ffd9a0', // 枪口焰心
  tracer: '#c9a227', // 曳光（同警示黄）
  crosshair: '#eef4fa',
  crosshairEdge: 'rgba(4,8,12,0.85)',
  deadVeil: 'rgba(80,16,14,0.35)',
} as const;
