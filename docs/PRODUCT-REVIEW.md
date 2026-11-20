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
