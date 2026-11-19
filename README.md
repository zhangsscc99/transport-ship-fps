# Transport Ship FPS

浏览器里的**单地图 FPS**（穿越火线「运输船」风格），three.js + TypeScript，
**全程序化资源**（无任何美术/音频文件），**手机优先**。

- 线上（开发中）：`https://openfolio.uk/transport/`
- 参考实现（第三方，仅作技术参照）：`https://openfolio.uk/saltline/`
- 端口：`3028`（本机 `127.0.0.1`），pm2 进程名 `transport-fps`

## 一句话目标

拿起手机就能打：左手摇杆跑，右手拖动视角，点开火；和 4 个 AI bot 在运输船上打团队竞技，先到 25 杀赢。

## 文档

| 文件 | 内容 |
|---|---|
| `docs/SPEC.md` | 产品规格：地图、玩法、武器、移动端操作、技术约束 |
| `docs/FEATURES.md` | 增量任务清单（每条带 verify 命令与风险等级） |
| `docs/ART-SPEC.md` | 视觉与声音规范（程序化资源、配色、可读性硬指标） |
| `docs/REFERENCE.md` | 参考项目 Saltline 的技术拆解（只写思路，不含其代码） |

## 技术形态

```
client/   Vite + TypeScript + three.js（唯一运行时依赖）
          程序化几何/贴图/音效，零外部素材
server/   Express 静态服务，监听 127.0.0.1:3028，路由前缀 /transport
scripts/  ci-deploy.sh（构建→备份→重启→健康检查，失败回滚）、verify.sh
```
