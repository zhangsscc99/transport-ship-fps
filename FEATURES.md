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
- [x] F109 HUD 与反馈：`src/render/hud.ts` 扩展受击红晕/击中方向指示/击杀提示；`src/audio/sfx.ts`（WebAudio 程序化：脚步、枪声 ×3、命中、换弹、死亡、警报；手势解锁、并发 ≤ 6、静音持久化）｜verify: `(cd client && npx tsc --noEmit) && node e2e/mobile.mjs`｜risk: med｜verify(2026-11-19): tsc 0 / 58 tests / feedback+smoke+mobile e2e 全绿（shots=4, flash=0.30, 0 JS errors）/ ci-deploy DEPLOY OK
- [x] F110 游戏循环与状态机：`src/game/match.ts`（对局阶段：菜单→倒计时→进行→结算；击杀计数、5 分钟计时、25 杀判定、重生延迟），`match.test.ts`（≥ 6 用例）；`src/render/menu.ts`（开始菜单：难度三档、开始、设置）｜verify: `bash scripts/build-tests.sh && node --test src/game/match.test.js && (cd client && npx tsc --noEmit)`｜risk: med｜verify(2026-11-19): match.test.ts 8 用例，58 tests 全绿 / smoke+mobile 经开始菜单进 playing 通过 / DEPLOY OK
- [x] F111 冒烟 E2E：`e2e/smoke.mjs`（Playwright，桌面 1280×720：加载→点开始→断言 canvas 有画面、玩家能前进、射击掉弹药、无 JS 错误）｜verify: `node e2e/smoke.mjs`｜risk: low｜verify(2026-11-19): xvfb-run -a node e2e/smoke.mjs → SMOKE OK fps=59.0, ammo 30→26, errors=0
- [x] F112 部署与线上验证：把 `server/` 跑在 pm2（transport-fps :3028）、服务器 gateway 已有 `/transport` 路由、`scripts/ci-deploy.sh` 最后校验 `https://openfolio.uk/transport/` 200 且页面标题正确｜verify: `bash scripts/ci-deploy.sh && curl -s -o /dev/null -w '%{http_code}' https://openfolio.uk/transport/`（期望 200）｜risk: med｜verify(2026-11-19): ci-deploy DEPLOY OK；服务器 127.0.0.1:3028/api/health=200；公网 https://openfolio.uk/transport/=200，title「Transport Ship — FPS」
## M3 视觉批次（10 车道，文件互不重叠，可真正并行）

> 目标：把白盒变成"有码头质感"的画面。**每条独占自己的新文件**，禁止改别人的文件；
> 唯一共享的接线点在 `src/render/engine.ts` 与 `src/main.ts`，由 **F209 集成车道**统一收口。
> 铁律：能 `MeshStandardMaterial` + `onBeforeCompile` 就不开 `RawShaderMaterial`；
> 新增 RawShaderMaterial 必须写清"库做不到什么、输入输出、手机代价"。

- [ ] F201 材质库：新增 `src/render/materials.ts`（板材/集装箱/塔/护栏/海面 5 类材质工厂，全部基于 `MeshStandardMaterial`，贴图来自 `textures.ts` 的 canvas 生成；导出 `getMaterial(kind)` 带缓存），并新增 `src/render/textures.ts`（噪声/接缝/锈迹的程序化贴图生成，512² 上限，`Map` 缓存）；补 `materials.test.ts`（材质缓存命中、贴图只生成一次）｜verify: `bash scripts/build-tests.sh && node --test src/render/materials.test.js && npx tsc --noEmit`｜risk: med
- [ ] F202 平面反射：新增 `src/render/reflection.ts`（镜像相机 + 半分辨率 `WebGLRenderTarget` + 反射矩阵与投影，导出 `createReflection(renderer)` 与 `update(scene, camera)`；水面/湿甲板可见时才渲染，fps<45 降到 1/4 分辨率）；补 `reflection.test.ts`（矩阵计算、开关逻辑、分辨率降级阈值）｜verify: `bash scripts/build-tests.sh && node --test src/render/reflection.test.js && npx tsc --noEmit`｜risk: high
- [ ] F203 海面：新增 `src/render/sea.ts`（大平面 + `MeshStandardMaterial` + 程序化法线噪声 + 菲涅尔近似（用 `onBeforeCompile` 注入），接受 `reflection` 的贴图做反射采样；无反射时优雅降级为纯色+高光）｜verify: `npx tsc --noEmit && node e2e/smoke.mjs`（xvfb）｜risk: med
- [ ] F204 湿甲板：新增 `src/render/deck.ts`（甲板材质：湿润度 uniform 0–1、水洼遮罩、粗糙度调制；用 `onBeforeCompile` 在家板材质上打补丁，不新开 shader）；补 `deck.test.ts`（湿润参数映射到 roughness 的单调性）｜verify: `bash scripts/build-tests.sh && node --test src/render/deck.test.js && npx tsc --noEmit`｜risk: med
- [ ] F205 大气与雾：新增 `src/render/atmosphere.ts`（`FogExp2` 配置 + 高度雾近似 + 天空渐变穹顶 `SphereGeometry` 反面 + 地平线色带；导出 `createSky()` 与 `applyFog(scene, opts)`），夜间/阴天两套预设｜verify: `npx tsc --noEmit && node e2e/smoke.mjs`（xvfb）｜risk: low
- [ ] F206 光照升级：重写 `src/render/lighting.ts`（一盏主方向光（2048 shadow map、PCFSoft、只覆盖船体范围）+ 半球光 + 2 个局部点光（船头警示灯/塔顶），并导出 `shadowBounds` 收窄阴影相机视锥提升阴影分辨率）；补 `lighting.test.ts`（阴影视锥包围盒计算）｜verify: `bash scripts/build-tests.sh && node --test src/render/lighting.test.js && npx tsc --noEmit`｜risk: med
- [ ] F207 道具与贴花：新增 `src/render/props.ts`（集装箱波纹/护栏/箱梯的几何与材质变体，全部 InstancedMesh）与 `src/render/decals.ts`（弹孔/锈迹贴花，单张图集 + rect 索引，最多 64 个循环复用）；补 `decals.test.ts`（分配/回收/上限）｜verify: `bash scripts/build-tests.sh && node --test src/render/decals.test.js && npx tsc --noEmit`｜risk: med
- [ ] F208 曝光与质感：新增 `src/render/grade.ts`（暴露 `renderer.toneMapping = ACESFilmicToneMapping`、`toneMappingExposure`、`outputColorSpace` 的正确设置，并提供"室内/室外"两档曝光过渡；**不引入 EffectComposer**）；补 `grade.test.ts`（曝光插值与钳制）｜verify: `bash scripts/build-tests.sh && node --test src/render/grade.test.js && npx tsc --noEmit`｜risk: low
- [ ] F209 集成车道（唯一允许改 `engine.ts` / `main.ts` / `hud.ts`）：把 F201–F208 的导出接进渲染循环；同时**重做移动端 HUD 布局**——横屏（844×390）摇杆左下、开火右下、换弹/切枪在开火上方、跳/蹲在摇杆上方；竖屏（390×844）改为底边一字排开 + 摇杆浮于左中，禁止按钮重叠；全部热区 ≥56px｜verify: `npx tsc --noEmit && xvfb-run -a node e2e/mobile.mjs && xvfb-run -a node e2e/smoke.mjs`｜risk: high
- [ ] F210 观感验收：新增 `e2e/visual.mjs`（390×844 与 844×390 双视口截图 + 断言：海面存在反射高光、甲板有明暗梯度、集装箱有材质差异、敌人 20m 外可辨轮廓；输出 `e2e/shots/visual-*.png`），并更新 `docs/PRODUCT-REVIEW.md` 记录本轮前后对比｜verify: `xvfb-run -a node e2e/visual.mjs`｜risk: med
