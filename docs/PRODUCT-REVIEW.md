# PRODUCT-REVIEW — 产品审视与回退记录

> 由调度轮次维护：每轮记录「真实玩一遍看到的问题 / 逻辑死路 / 回退事件」。
> 不是功能清单（那是 FEATURES.md），这里只写判断与方向。

## 2026-11-19 轮次（F109 / F110）

### 回退记录

- **QUOTA→回退: F110**
  - 事实：`swe-2-high` 在 10:30Z 报 `Reached free model rate limit ... reset in 29 minutes (at 11:01 UTC)`，
    当时该车道**已经写完代码并提交**（commit `3615dbd`）。
  - 处理：不再 spawn devin，由调度器接管该条的验收与合并（tsc 0 / 58 tests / smoke+mobile+feedback e2e / deploy 全部按原标准跑，未降级）。
  - 另：09:54Z 首次派活时两条车道同时被额度墙挡住（reset at 10:01Z），调度器等额度重置后重派，未重复 spawn。
- **QUOTA→回退: F109** 未发生（F109 在 10:12Z 正常完成）。

### 环境事故（已定位，供后续轮次复用）

- `WAYLAND_DISPLAY=wayland-0` 从 Windows 侧继承进 WSL，**headless Firefox 会先试 Wayland 再回退 X11 并卡死**，
  表现是 Playwright 的 juggler 握手超时（看起来像「Firefox 起不来」）。已在 `/usr/local/bin/xvfb-run` 包一层
  `env -u WAYLAND_DISPLAY`，并在 e2e 调用处带 `LIBGL_ALWAYS_SOFTWARE=1`（firefox 的 glxtest 探测在 WSL 上偶发挂住）。
- 这台 Windows 机器当晚多次整机掉线（ssh 2223 与 3028 隧道同时断开 5–10 分钟），调度器只能等待恢复，不做隧道重启。

### 产品判断（真人视角玩一遍）

1. **对局是个空局**：`src/main.ts` 里 `entities` 仍是空数组（`// enemy bots arrive in a later milestone`）。
   F110 的 25 杀 / 5 分钟 / 结算逻辑因此跑不到：开局等到 5 分钟，0:0 平局结算。**这是当前最大的逻辑死路**，
   优先级应高于任何美术工作 —— 没有可击杀目标，枪法、命中反馈、比分、结算全是空转。
2. **重生后没有方向感**：重生只把 `yaw/pitch` 归零，玩家不知道谁在打自己（F109 的方向弧只在受击瞬间出现）；
   需要「死亡镜头看击杀者 1.5 秒」或重生后 1 秒的来袭方向提示。
3. **难度三档目前是纯 UI**：菜单里的简单/普通/困难没有任何消费方（无 bot 可调），必须和 bot AI 同批落地，
   否则又是一个「看起来有、其实没有」的控件。
4. **竖屏提示语混在 HUD 顶部**（"建议横屏游玩"）会与 FPS 计数器抢视线；建议改为一次性 toast，3 秒后消失。
5. 触屏控件已 8 个（摇杆/视角/开火/换弹/换枪/跑/蹲/跳 + 静音），在 390×844 上已接近拇指热区上限：
   下一批**不要再加按钮**，改为长按/滑动组合。

## 2026-11-20 轮次（F211：视模型重做 + 消除纯黑体块）

### F211 前后对比

**改动**：`src/render/weapon.ts`（手臂/握枪几何重做 + 视模型材质克隆加自发光地板）、
`src/render/lighting.ts`（反向补光 0.4→0.85，新增相机跟随补光 camFill 0.6）、`src/render/palette.ts`
（gun/glove/pipe 基色抬一档）、`src/main.ts`（每帧把 camFill 挂到相机前方 6m、上方 1.2m）。
新闸门 `scripts/dark-block.mjs`：双分辨率 × 3 机位，4 邻域统计 luma<12 连通块，阈值 1200px。

**「左边缘黑条」定性**：不是 HUD、不是视模型 —— 是 **(-8,19.3) 系缆桩（bollard）+ z=19.65 护栏端头**，
出生左转 ~90° 后它们落在画面左边缘 2.3m 内，-z 面完全背光（太阳在 +z、反向补光也照不到）→ 压成纯黑。
fill 0.85 + camFill 后该区域从 luma≈5 升到可见灰阶，连通块 5896px → 696px。

**数字**（SwiftShader，本机 build）：

| 指标 | 前 | 后 |
|---|---|---|
| measure-look mean | 77.5（出生）/ 31.6（低头） | 82.47 |
| measure-look top30 | — | 129.70 |
| measure-look darkFrac(luma<10) | 2.1%（luma<12 口径） | 0.00 |
| measure-look p95 | 66（低头） | 154.96 |
| dark-block 最大连通块 | 枪体 4797px / 左缘 5896px | land 225 / 251 / 696；port 43 / 21 / 26（全 ≤1200） |

**截图**：`e2e/shots/dark-land-spawn.png`、`dark-land-down.png`、`dark-land-downleft.png`、
`dark-port-*.png`、`gun-crop.png`（3× 放大的枪体，可见导轨高光、机匣中间调、手套亮一档、前臂斜出右下角）。

## 2026-11-21 轮次（F215：修「空局」——bot 渗透推进 + 队友报点）

### 上一轮遗留的最高优先缺陷已实证并修掉

上一轮记录「玩家站 A 点不动 60s，hp 恒 200、killsB=0，5 个 bot 距离 29–41m 不变」。
根因：bot 只在固定 `PATROL_WAYPOINTS` 以 1.4 m/s 绕圈，`VISION_RANGE=40` 而两队出生区相距 >40m，
`ENGAGE_MAX_DIST=16` 又要求贴身才开火 → 双方各自在自家半场走，整局零交火。

### 改后线上实测（3028 部署构建 `index-CDd1EGNC.js`，竖屏 390×844，NORMAL，5 bot，玩家全程不动）

| 仿真时刻 | 最近敌人距离 | ENGAGE 数 | 累计开火 | 状态分布 |
|---|---|---|---|---|
| 开局 (t0) | 27.3 m | 0 | 0 | 3×IDLE / 2×PATROL |
| +16 s | 8.5 m | 1 | 2 | 3×PATROL(advancing) / 1×CHASE / 1×ENGAGE |
| +25 s | 8.0 m | 4 | 23 | 4×ENGAGE / 1×PATROL(advancing) |

玩家视角 HUD 血量 200 → 92（被 bot 打中 9 次），即「站着不动也不会被冷落」；
单测侧 NORMAL 10 seed：20 s 内最小距离 7.98–22.93 m，首次 LOS 7.5–22.3 s，首枪 13.7–24.1 s，
击杀静止玩家 25.4–36.2 s。

### 本轮人工审视新发现（下一轮候选，按优先级）

1. **敌人脚部悬空 ~8–12 cm**：`e2e/shots/ai-engage-portrait.jpg` 里 8 m 的潜伏者靴底与甲板之间有可见缝隙
   （估 5–7% 身高），且没有接触阴影。推断 enemy root 的 Y 偏移/GLB 原点问题 → 建议给士兵 GLB 加脚底对齐修正，
   并补一个「脚底贴地」断言（bot 站立时 `feetY` 与甲板高差 < 2 cm）。
2. **枪口火光在静帧里完全看不到**：`ai-engage-portrait.jpg` 时刻 23 发已打出去，敌人枪口无火光/无烟。
   需确认是「900 ms 间隔恰好落在两发之间」还是 VFX 只对玩家武器生效；若是后者，敌人开火要有 1 帧 muzzle flash。
3. **竖屏右下按钮被枪模压住**（上轮 #3 仍在）：FIRE 按钮左缘被枪管+手套覆盖，SWAP/RELOAD 文字贴枪身，
   触控热区未受损但观感廉价 → 建议竖屏把视模型右移 3–4%，或按钮盘面向右收 6 px。
4. **公网源站仍未指向本机**（上轮部署面发现，复验仍成立）：`https://openfolio.uk/transport/` 的 index.html
   仍引用旧 bundle `index-D6lu3ojB.js`（655 KB），本机 dist 已是 `index-CDd1EGNC.js`；本机两个 transport 目录、
   pm2、nginx 均无 D6lu3ojB → 对外节点在别处（rev-tunnel/HK）。**每轮上线用户在跑旧版本**，需运维定位源站。


## 2026-11-22 轮次（F216：敌人脚部贴地 + 接触阴影）

### 结论先说：上一轮记的「靴底悬空 8–12 cm」根因不是模型原点偏移
- 部署构建里实测：士兵 GLB 绑定姿势 `minY = 0`，`idle_rifle`/`aim_rifle` 剪辑的 `minY` 也在 −0.007…0 之间 → 模型原点本来就在鞋底，
  不是「整体抬高 8–12 cm」。
- 真正的来源是**剪辑相位**：`run_rifle` 在一段步态里最低点升到 **+0.092 m**（双脚腾空帧）。上一轮那张 8 m 截图（`ai-engage-portrait.jpg`）
  里的敌人正在推进/跑动，慢帧率把它定格在腾空帧上，于是读成「悬空」。所以这既是渲染问题，也是**帧率问题**：0.7 fps 的 SwiftShader 截图会
  随机定格在腾空相位，人眼在真机上（60 fps）看到的是正常跑动起伏。

### 本轮改法与代价
- 每帧把最低点钉在甲板面上（`model.position.y = -minY`，按剪辑采样曲线，交叉淡入时实时量 boot 网格）。5 个 bot 全状态实测 `gap` ≤ 7.8e-5 m。
- **代价（必须下轮人眼复核）**：跑动腾空相位被抹平，身体不再上下起伏 → 有可能看起来像「滑行」。若确实如此，应改成
  「只在脚低于地面时抬升、下压量 ≤ 3 cm」，保留 2–3 cm 步态弹跳。

### 新发现（下一轮候选）
1. **接触阴影已渲染但太弱**：A/B 差分测得脚下一片 120 px 宽椭圆、峰值压暗仅 9–18 luma，肉眼在竖屏 9 m 处基本看不出。
   建议 alpha 首停 0.72→0.9、直径 1.0→1.3 m，并把「A/B 差分峰值 ≥ 25 luma」写成闸门，避免以后静默消失。
2. **竖屏右下按钮仍被枪模压住**（连续第三轮）：SWAP/RELOAD 文字贴着枪身，FIRE 左缘被枪管覆盖；热区未受损但观感廉价。
3. **敌人开火时枪口火光依旧拍不到**（代码有 75 ms 窗口）：需确认是「两发之间」还是敌人 VFX 失效 —— 建议加一次性常亮 debug 开关再拍。
4. **公网源站仍旧**：`https://openfolio.uk/transport/` 仍是旧 bundle，本机两个 200 但用户跑的是旧版本（需运维，非本轮范畴）。
5. 本轮受宿主负载影响：两条其它项目的并行车道占满 CPU（load 12–20），SwiftShader 只能跑 ~0.7 fps，`measure-look`/`dark-block` 两个闸门本轮**未跑**（超时风险），下轮低负载时补跑。
