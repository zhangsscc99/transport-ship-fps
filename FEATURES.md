# FEATURES — 增量任务清单

> 约定：每条独占列出的文件；`verify:` 必须能真实跑通；`risk:` = low/med/high。
> 勾选前必须真跑 verify 并贴输出（见定时任务里的「勾选前必须留证」）。
> 美术相关条目另需符合 `docs/ART-SPEC.md`。

## M1 可玩骨架（第一批）

- [x] F101 项目脚手架：`package.json`（vite + typescript + three）、`tsconfig.json`（strict）、`vite.config.ts`（base `/transport/`）、`index.html`（viewport 锁定、touch-action:none）、`src/main.ts` 入口空壳、`server/index.js`（Express 静态服务，监听 127.0.0.1:3028，前缀 `/transport`，`GET /api/health` 返回 `{ok:true}`）、`ecosystem.config.cjs`（pm2 进程名 transport-fps）、`scripts/ci-deploy.sh`（build→备份 dist→pm2 restart→健康检查，失败回滚）、`scripts/verify.sh`（tsc + 测试 + 构建 + 健康检查）｜verify: `npm ci && (cd client && npx tsc --noEmit) && npm run build && bash scripts/ci-deploy.sh && curl -s http://127.0.0.1:3028/api/health`｜risk: med
- [x] F102 渲染基座：`src/render/engine.ts`（three.js WebGLRenderer、DPR 上限 2、resize、帧循环、可见性暂停）、`src/render/lighting.ts`（一盏方向光 + 环境光，shadow map 1024，仅主光投影）、`src/main.ts` 接线；空场景能稳定 60fps 渲染蓝色天空+地面平面｜verify: `(cd client && npx tsc --noEmit) && npm run build` 且 `node e2e/smoke.mjs` 断言 canvas 有非空像素、无 JS 错误｜risk: med
- [x] F103 第一人称控制器：`src/game/player.ts`（位置/速度/朝向/蹲/跳状态机，**纯逻辑、不 import three**）、`src/render/camera.ts`（相机跟随、俯仰限制 ±85°、蹲下降低视高）、`src/game/input.ts`（键盘 WASD + 鼠标 pointerlock + 触摸摇杆输入归一化）；补 `player.test.ts`（跳跃曲线、蹲下速度、越界检测 ≥ 6 用例）｜verify: `bash scripts/build-tests.sh && node --test src/game/player.test.js && (cd client && npx tsc --noEmit)`｜risk: med
- [x] F104 地图 blockout（运输船）：`src/game/map.ts`（**纯数据**：甲板、8 个货柜、2×2 哨塔+楼梯、2 条地下管道、船体边界、出生点、可跳点位；导出 colliders 与 spawn 列表）、`src/render/map.ts`（按数据生成 three 几何、灰色系程序化材质）、`map.test.ts`（碰撞体数量、出生点合法性、管道连通性、边界外判定）｜verify: `bash scripts/build-tests.sh && node --test src/game/map.test.js && (cd client && npx tsc --noEmit)`｜risk: high
- [x] F105 碰撞与移动：`src/game/collision.ts`（AABB + 圆柱玩家 vs 盒子，滑动响应、台阶 0.35m 自动上台阶、不可穿货柜）、`collision.test.ts`（正面撞停、贴墙滑动、上台阶、掉出边界 ≥ 6 用例）；`src/render/engine.ts` 接线｜verify: `bash scripts/build-tests.sh && node --test src/game/collision.test.js && (cd client && npx tsc --noEmit)`｜risk: high
- [x] F106 武器与射击：`src/game/weapons.ts`（三把枪的参数表、射速节流、弹匣/换弹状态机、后坐力扩散、命中判定 raycast 的纯函数接口）、`weapons.test.ts`（射速节流、换弹锁定、扩散角度、命中/未命中 ≥ 8 用例）；`src/render/weapon.ts`（第一人称枪模型 + 开火动画 + 枪口火光）｜verify: `bash scripts/build-tests.sh && node --test src/game/weapons.test.js && (cd client && npx tsc --noEmit)`｜risk: high
- [x] F107 命中与伤害：`src/game/damage.ts`（爆头 ×2、距离衰减、霰弹多弹丸、护甲简化、死亡判定），`damage.test.ts`（≥ 6 用例）；`src/game/entities.ts`（玩家/bot 共用实体结构 + 血量 + 重生计时）｜verify: `bash scripts/build-tests.sh && node --test src/game/damage.test.js && (cd client && npx tsc --noEmit)`｜risk: med
- [x] F108 移动端操作层：`src/input/touch.ts`（左摇杆、右半屏转视角、开火/换弹/换枪/跑/蹲/跳按钮，全部热区 ≥ 56 CSS px）、`src/render/hud.ts`（血条、弹药、比分、计时、准星；布局随横竖屏切换）；触摸与鼠标两套输入统一成同一份 `InputState`｜verify: `node e2e/mobile.mjs`（390×844 + hasTouch，断言：无滚动条、摇杆拖动使玩家位移 > 1m、开火使 ammo 减少、HUD 元素命中矩形 ≥ 44px）｜risk: high
- [ ] F109 HUD 与反馈：`src/render/hud.ts` 扩展受击红晕/击中方向指示/击杀提示；`src/audio/sfx.ts`（WebAudio 程序化：脚步、枪声 ×3、命中、换弹、死亡、警报；手势解锁、并发 ≤ 6、静音持久化）｜verify: `(cd client && npx tsc --noEmit) && node e2e/mobile.mjs`｜risk: med
- [ ] F110 游戏循环与状态机：`src/game/match.ts`（对局阶段：菜单→倒计时→进行→结算；击杀计数、5 分钟计时、25 杀判定、重生延迟），`match.test.ts`（≥ 6 用例）；`src/render/menu.ts`（开始菜单：难度三档、开始、设置）｜verify: `bash scripts/build-tests.sh && node --test src/game/match.test.js && (cd client && npx tsc --noEmit)`｜risk: med
- [ ] F111 冒烟 E2E：`e2e/smoke.mjs`（Playwright，桌面 1280×720：加载→点开始→断言 canvas 有画面、玩家能前进、射击掉弹药、无 JS 错误）｜verify: `node e2e/smoke.mjs`｜risk: low
- [ ] F112 部署与线上验证：把 `server/` 跑在 pm2（transport-fps :3028）、服务器 gateway 已有 `/transport` 路由、`scripts/ci-deploy.sh` 最后校验 `https://openfolio.uk/transport/` 200 且页面标题正确｜verify: `bash scripts/ci-deploy.sh && curl -s -o /dev/null -w '%{http_code}' https://openfolio.uk/transport/`（期望 200）｜risk: med
