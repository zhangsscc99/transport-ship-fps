# HUD & Viewmodel Baseline (Before F217)

Captured on the unmodified pre-F217 geometry/layout/styling (with only `window.__vmRect()` added for measurement), running Chromium + SwiftShader (`hasTouch: true`) at spawn `(0, 0, 14)`, `yaw=0`, `pitch=0`.

## 1. Landscape Baseline (`844×390`, aspect = 2.164, FOV = 75°)

### Viewmodel (`window.__vmRect()`)

| Weapon | `x` | `y` | `w` | `h` | `x + w` | `y + h` | `scale` | Note |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Rifle (`rifle`, rest midpoint) | 417.5 | 223.9 | 251.7 | 166.1 | 669.2 | 390.0 | 1.0 | Idle breathe/sway envelope: `x` 417.0–417.9, `y` 223.6–224.2, `w` 250.2–253.2, `h` 165.8–166.4 (±1.5 px) |
| Rifle (`rifle`, countdown t≈0.6s) | 417.9 | 223.6 | 253.2 | 166.4 | 671.1 | 390.0 | 1.0 | Pre-F217 unmodified capture |
| Rifle (`rifle`, playing t≈3.7s) | 417.0 | 224.2 | 250.2 | 165.8 | 667.2 | 390.0 | 1.0 | Identical landscape code path |
| Gatling (`gatling`) | 398.4 | 230.3 | 312.2 | 159.7 | 710.6 | 390.0 | 1.0 | Pre-F217 unmodified capture |

### Action Buttons (`LANDSCAPE_LAYOUT`, must remain pixel-identical)

| Button | Anchor (`size@right/bottom`) | `x` | `y` | `w` | `h` | Background | Label font-size / opacity |
|---|---|---:|---:|---:|---:|---|---|
| `fire` | `70@16/16` | 758 | 304 | 70 | 70 | `rgba(8, 12, 18, 0.55)` | 9px / 0.95 |
| `reload` | `48@96/32` | 700 | 310 | 48 | 48 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |
| `swap` | `48@84/88` | 712 | 254 | 48 | 48 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |
| `jump` | `48@26/94` | 770 | 248 | 48 | 48 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |
| `crouch` | `44@28/150` | 772 | 196 | 44 | 44 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |

## 2. Portrait Baseline (`390×844`, aspect = 0.462, FOV = 63.75°)

### Viewmodel (`window.__vmRect()`)

| Weapon | `x` | `y` | `w` | `h` | `x + w` | `y + h` | `scale` | Issues |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Rifle (`rifle`) | 16.3 | 498.6 | 373.7 | 345.4 | 390.0 | 844.0 | 1.0 | Right edge hits 390px (clips right edge behind FIRE/JUMP/CROUCH); intrudes into center-right & bottom-right button cluster |
| Gatling (`gatling`) | 0.0 | 515.8 | 390.0 | 328.2 | 390.0 | 844.0 | 1.0 | Spans full 390px width (`x+w = 390`) |

### Action Buttons (`PORTRAIT_LAYOUT`, pre-F217)

| Button | Anchor (`size@right/bottom`) | `x` | `y` | `w` | `h` | Background | Label font-size / opacity |
|---|---|---:|---:|---:|---:|---|---|
| `fire` | `76@24/24` | 290 | 744 | 76 | 76 | `rgba(8, 12, 18, 0.55)` | 9px / 0.95 |
| `reload` | `52@112/42` | 226 | 750 | 52 | 52 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |
| `swap` | `52@96/102` | 242 | 690 | 52 | 52 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |
| `jump` | `52@36/108` | 302 | 684 | 52 | 52 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |
| `crouch` | `48@38/168` | 304 | 628 | 48 | 48 | `rgba(8, 12, 18, 0.55)` | 7px / 0.78 |

### Baseline Portrait Layout Defects
- `fire` (`290..366, 744..820`) vs `swap` (`242..294, 690..742`): x-intervals overlap by 4px and y-gap is only **2px** (`744 - 742`, below the 6px requirement).
- Button plate `rgba(8, 12, 18, 0.55)` lets gun rails, receiver, and glove bleed through at ~45% background transmittance, while 7px / 0.78-opacity labels become muddied over weapon highlights.
- Viewmodel scale `1.0` + `px = 0.11` pushes the rifle body diagonally across the entire right button cluster (`x + w = 390px > 340px`).
