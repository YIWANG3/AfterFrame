# LUT 调研原型

`docs/lut-plan.md` 里的实测数字都来自这些脚本（2026-10-05，M1 Max，32 GB）。它们只是一次性的实验代码，不属于应用，也不参与构建。

## 环境

- **Python：** 用 3.12 的 venv（`/usr/bin/python3` 是 3.9，跑不了）：
  - `uv venv --python 3.12 .venv`
  - `VIRTUAL_ENV=.venv uv pip install "Pillow==12.3.0" numpy "rawpy>=0.27.1,<0.28"`

  版本和 sidecar 锁定的一致：Pillow 12.3，rawpy 0.27.1，内含 LibRaw 0.22.1。
- **JS：** 在 `apps/desktop` 目录里运行，借用它的 `sharp`。
- **Swift：** `xcrun -sdk macosx swiftc -O -target arm64-apple-macos14.0 <file>.swift -o <name>`

## 脚本

| 文件 | 做什么 | 对应文档里的哪部分 |
|---|---|---|
| `lut_bench.py` | `.cube` 解析（`parse_cube`）。Pillow `Color3DLUT` 和 numpy 浮点三线性、四面体插值的速度与精度对比 | 调研结论 → 实测 |
| `lut_js_bench.mjs` | JS 解析器，以及三线性、四面体两种插值（渲染进程 Worker 里会用的写法）。可以和 Pillow 的输出对比 | 调研结论 → 实测；设计 §3 |
| `cube_census.py` | 对一份 `.cube` 路径清单做普查：尺寸、关键字、换行、1D / shaper、输入范围、越界值、重复文件、Log 命名 | 调研结论 → 本机 .cube 普查 |
| `raw_bases.py` | 同一个 Rec709 LUT 分别套在内嵌 JPEG、Apple Image I/O（`sips`）、LibRaw（AfterFrame 的参数）三种底图上，出对比图 | RAW → 实测 1 |
| `raw_slog3.py` | 索尼 ARW 的 Log 管线：LibRaw 线性 XYZ → S-Gamut3.Cine / S-Log3 → 浮点四面体插值套 LUT；对比直接套在 JPEG 上、8 位 Log 输入 | RAW → 实测 2 |
| `rawlut.swift` | Mac 原生原型：`CIRAWFilter` 渲染后套 Rec709 LUT（`rec709`）；或线性 → S-Log3 → LUT（`slog3`），曝光按「索尼官方 LC-709 LUT 的结果对齐 Apple 渲染的中间亮度」自动匹配；分块、浮点运算、全分辨率 | RAW → 实测 3 |
| `rawprobe.swift` | 打印 `CIRAWFilter` 的 `baselineExposure`，以及 `boostAmount = 0` 时线性输出的最大值和中间亮度 | RAW → 实测 4 |

## 用法示例

```bash
python lut_bench.py <lut.cube> apps/desktop/sample-photos/sample-03.jpg
python raw_bases.py <rec709.cube> out.jpg a.ARW b.CR3 c.RAF d.3FR
python raw_slog3.py a.ARW SLog3SGamut3.CineToLC-709TypeA.cube <slog3-look.cube> out.jpg
./rawlut a.ARW <rec709.cube> out.jpg rec709
./rawlut a.ARW <slog3-look.cube> out.jpg slog3 SLog3SGamut3.CineToLC-709TypeA.cube
./rawprobe a.ARW b.NEF c.3FR
```

索尼官方的 `SLog3SGamut3.CineToLC-709TypeA.cube` 随达芬奇安装，位于 `/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/Sony/`。

## 没有放进仓库的

- **对比图：** 用的是作者自己的 RAW（有街拍人物）和买来的 LUT，没放进仓库。重跑上面的脚本即可生成。
- **测试素材：** 第三方 LUT 和 RAW 文件都不放进仓库。

## 已知的粗糙之处（真做时要改）

- `rawlut.swift` 的曝光匹配在 1/8 尺寸上逐档试 41 次，占了 S-Log3 模式的大半耗时。方案里改为按元数据（`baselineExposure` 加 ISO 12232）确定默认值。
- `rawlut.swift` 只有 S-Log3 / S-Gamut3.Cine 一种 Log。
- 两个解析器都只处理了最常见的关键字，完整的规则清单见方案 §2。
- JS 原型的表是 16 位定点数，方案改成 Float32（原因见方案里的越界值实测）。
