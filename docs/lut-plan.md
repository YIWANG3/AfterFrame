# LUT 预览（套 LUT）设计方案

> **状态（2026-10-07）**：P1 已在 `feat/lut` 上实现，只做 Mac。e2e 是 `67-lut.spec.js`，单测在 `src/components/editor/lut/` 和 `electron/lutLibrary.test.js`。
>
> 在作者的真实素材上实测（M1 Max）：
> - RAW：索尼 A7M4、富士 GFX50S II、尼康 Z8 高效率 RAW、哈苏 907X 1 亿像素都以 Apple 渲染为底。预览套用约 0.1 秒，全尺寸保存 1.0–3.1 秒。
> - LUT 库：引用 1209 个 LUT 的文件夹，首次扫描 4.5 秒、重扫 0.3 秒；导入 404 个 LUT 的包用 14 秒，主进程最长只卡 10 ms。
> - 内存：同一组 RAW 连跑三轮，强制回收后渲染进程内存持平（约 2.3 GB，比 main 多约 0.7 GB，主要是同一张 RAW 被解码两次留下的有上限缓存），没有泄漏。
>
> 与下文设计的差异：
> - Log 的手动标记按「文件名 + 大小」记住，不按内容哈希：文件挪到别的文件夹也不丢，又不用为每个引用的 LUT 算哈希。内容哈希只用于导入去重。
> - 「导入」和「添加文件夹」合成一个「＋ 添加 LUT」按钮，菜单里每项写一句它对文件做什么（两个裸图标用户看不懂）。
> - 窗口回到前台时自动重扫 LUT 库：用户在访达里往库文件夹或引用文件夹放进、删掉 LUT，切回来就能看到。
> - 引用的文件夹读不到（被移动、改名、硬盘没接）时，面板顶部提示，带「重新定位…」和「不再读取」；选中的 LUT 文件不见了也会直接说明。
> - 分组可以一键全部展开或收起。
> - 浏览辅助（2026-10-07）：
>   - 方向键逐个切换，←→ 按显示顺序，↑↓ 到上下一行的同一列。快速翻看时只有停下的那个记一步撤销，也只有它进「最近使用」。
>   - 收藏和最近使用（12 个）排在最前，同样按「文件名 + 大小」记，文件挪走也不丢。
>   - 「全部 / 收藏」筛选和「隐藏 Log 版」。
>   - 每行 2 个或 3 个缩略图。
>   - 选中后显示 LUT 尺寸和来源，悬停看完整路径。
>   - 筛选、列数这些是个人习惯，存在浏览器的 localStorage 里，不进设置文件。
> - 缩略图长边 280 px（两列时约 140 px 一格，按 2 倍密度），按 LUT 分到最多 4 个 Worker 并行生成。
> - 编辑器关闭时结束 Worker、清空 LUT 缓存。
> - 引用文件夹的 LUT 不能在应用里删除，只有库里的副本能移到废纸篓。
>
> 实测数据来自作者的 Mac（M1 Max）和它上面的 2576 个真实 .cube 文件；开源项目的做法来自 2026-10-05 读源码时的 commit（见文末来源）。

## 需求

摄影用户手上有大量买来、存来的 LUT 包（LUTIFY、和一盐柯达胶片、聿铭、索尼风格化、剪映导出的 LUT 等），想在 AfterFrame 里直接把 LUT 套到照片上：先在一张图上快速看一遍各个 LUT 的效果，挑一个，调强度，存成新版本。

**只做套 LUT。** 不做曝光、曲线、HSL 这类调色（应用里本来就没有任何调色功能，见 `next-features-plan.md` F 节）。

## 已拍板（2026-10-05、10-06）

1. 只放在编辑器里，作为一个新工具；灯箱不加入口。
2. 做强度滑杆。
3. 给 Log 素材用的 LUT 打标签提示，不隐藏、不拦截。
4. 内置 LUT：先放一放，P1 不带。
5. LUT 拷贝进应用会占存储：设置里必须告诉用户 LUT 存在哪个目录、占多大，用户能自己清理。
6. **只做 Mac。** P1 在 Windows 上隐藏 LUT 工具（能力开关，同抠图贴纸），以后放开只改一处。（10-06）
7. Mac 上 RAW 套 LUT 一律用 Apple 中性渲染作底图，不用相机内嵌 JPEG。（10-06）
8. 「RAW 按 Log 素材处理」放 P2。（10-06）
9. Log 模式只用自动曝光，不做曝光微调滑杆。（10-06）

## 调研结论

### 实测（M1 Max，sample-03；脚本见 `docs/prototypes/lut/`）

| 操作 | JS 四面体（单线程） | JS 三线性（单线程） | Pillow `Color3DLUT`（三线性） |
|---|---|---|---|
| 缩略图，260px | 0.9 ms | 1.0–1.4 ms | 0.7–4.5 ms |
| 编辑器预览，约 2200px | 56 ms | 71–96 ms | 35 ms |
| 全分辨率，24MP | **0.39 s** | 0.53–0.72 s | 0.31 s |

- JS 四面体和浮点参考实现最多差 1 级（8-bit），平均 0.001。注意 `Uint8ClampedArray` 写入时自己会四舍五入，再加 0.5 会整体偏高半级。
- 四面体每个像素只读 4 个格点，三线性读 8 个，所以在 JS 里四面体反而快将近一倍。
- 三线性和四面体之间最多差 1–5 级，平均不到 0.2 级。
- JS 和 Pillow 的三线性最多差 1 级。
- 解析一个 .cube：33³ 约 10 ms，65³ 约 95 ms。
- Windows 慢机没测。

### 本机 .cube 普查（2576 个文件）

- **尺寸：** 33³ 占 46%，32³ 占 37%，64³ 占 13%，65³ 37 个，其余为 16/17/21/25。没有超过 65 的。
- **格式变体：**
  - 147 个是 CRLF 换行，1236 个有 TITLE，90 个有 DOMAIN_MIN/MAX，29 个有 `LUT_3D_INPUT_RANGE`。
  - 57 个是只有 1D 表的文件，1 个是 1D + 3D（shaper）。
  - 输入范围不是 0–1 的只出现在达芬奇自带的 HDR / VFX 工具 LUT 里。
- **越界值：** 197 个文件的表里有超出 0–1 的值。如果在格点上就截断到 0–1，Log 转换类 LUT 约 1% 的像素会差到 8–17 级（平均差不到 0.1 级）。所以内存里的表要保留浮点，只在输出时截断。
- **作者自己的 LUT 库：**
  - 2027 个文件，其中 1214 个是重复拷贝，去重后 813 个，文本合计 2.1 GB（一个 64³ 文件约 7 MB）。
  - 大多在外置盘 G-DRIVE 上。
- **约三分之一（662 个）从文件名或所在文件夹看是给 Log 或特定摄影机素材用的。** LUTIFY 每个风格都有 `STANDARD/…Rec709`、`LOG/`、`ALEXA/`、`REDLOGFILM/` 四个版本。照片上只有 Rec709 版是对的，Log 版会压暗部、加饱和。

### 别人怎么做

| 项目 | 格式 | 插值 / 在哪算 | 强度 | Log | LUT 存哪 | 选择界面 |
|---|---|---|---|---|---|---|
| 达芬奇 Resolve | .cube 等 | GPU | 节点混合 | 由色彩管理处理 | **不导入**：固定 LUT 文件夹，用户自己拷进去，再点「更新列表」；另可在偏好设置里添加 LUT 文件夹（含网络盘），只引用不拷贝；工程按路径引用 | LUT 浏览器，子文件夹即分组 |
| 剪映 | .cube | GPU | 有 | 无 | **导入即拷贝**：每个 LUT 一个文件夹（.cube + 一张约 90 KB 的 jpeg 预览图 + 两个 json）；本机 294 个占 551 MB | 列表 |
| darktable | .cube / .3dl / Hald / gmz | 四面体（默认）/ 三线性 / 金字塔，CPU + OpenCL | 无（用通用混合不透明度） | 无，可选 sRGB / Rec709 / 线性等输入空间 | 偏好设置里一个根文件夹，引用不拷贝，记录相对路径 | 文件选择器 + 下拉框 |
| RawTherapee / ART | Hald（ART 另有 CLF/CTL） | 三线性，CPU | 0–100，sRGB 编码值上混合 | 无 | 一个用户指定的文件夹，子文件夹成为子菜单 | 层级菜单 |
| digiKam | Hald | 三线性，CPU | 1–100 | 无 | 应用数据目录 | **当前照片 128px 套每个 LUT 的图标网格**，后台线程渲染 |
| RapidRAW（约 1 万 star） | .cube / .3dl / Hald | 四面体，GPU（因三线性出色带而改，#540） | 0–100，`mix` | 只认内置 LUT | **导入即拷贝**进 `appData/luts`，重名加 (1) | **当前照片 112px 缩略图网格**；悬停预览大图；再点取消 |
| LumaForge（Web） | .cube | WebGPU + CPU 后备 | 默认 70%，有 轻/标准/强 三档 | **唯一做检测的**：文件名、TITLE、注释推断，先去掉 "to Rec709" 这类输出端；用户可改，按内容哈希记住 | — | 文字条 |
| immich-edit | .cube | 四面体，WGSL | 0–100 | 无 | 按内容哈希去重，重复导入时直接选中已有的 | 可搜索下拉框 |
| OBS / three.js / GPUImage | .cube / 查找表 PNG | GPU 3D 纹理 | `mix(orig, lut, k)` | 无 | — | — |

共同点：
- 强度一律是原图和 LUT 结果按比例混合，范围 0–100%，没有超过 100% 的。只有 OBS 和 LumaForge 在线性光里混，其余都在编码值上混。
- 「放大 LUT 相对恒等表的偏移」和「按比例混合输出」在三线性、四面体插值下数学上等价。
- 只有 LumaForge 检测 Log。
- 缩略图网格只有 digiKam 和 RapidRAW 做了。RapidRAW 一次性渲染全部 LUT，没有懒加载，这一点不学。

## 设计

### 1. LUT 存在哪、怎么清理

**采用达芬奇的「LUT 文件夹」模式，再加一个导入按钮。**

1. **文件夹本身就是 LUT 库。**
   - 默认库文件夹是 `userData/afterframe/luts/`，在 macOS 上即 `~/Library/Application Support/AfterFrame/afterframe/luts/`。
   - 里面放的就是原样的 .cube 文件，子文件夹即分组。
   - 应用扫描文件夹来生成列表，不靠清单记录有哪些 LUT。所以用户在访达里往里拖、删、改名，应用都认，和达芬奇一样。
   - 不用不透明的二进制格式存，因为 AfterFrame 是本地优先，用户在访达里看到的必须是真实文件。
2. **「导入…」= 拷贝进默认库文件夹。**
   - 支持选文件、选文件夹、拖进 LUT 面板。
   - 选文件夹时保留原文件夹名作为分组；嵌套的厂商目录（如 `3D LUTs (CUBE)/STANDARD/`）只取最后一两级，避免分组名过长。
   - 按内容哈希去重：已存在就跳过，并选中已有的那个（immich-edit 的做法）。导入结束提示「导入 N 个，跳过 M 个重复」。作者的库导入后会从 2027 个变成 813 个。
3. **「添加 LUT 文件夹…」= 只引用，不拷贝。**
   - 对应达芬奇偏好设置里的 LUT 文件夹。
   - 适合 LUT 已经整理在外置盘上的用户，零占用。
   - 外置盘没插时，这一组在面板里显示为「不可用」。这不影响已经保存的照片，因为 AfterFrame 保存时就把效果写进新文件，不存编辑参数，也就没有达芬奇、darktable、RapidRAW 那种「工程里引用的 LUT 不见了」的问题。
4. **设置 → 资料库 → 缓存与存储，加一行「LUT 库」**（`LibrarySettings.jsx` 现有分组）：
   - 显示默认库文件夹的路径、LUT 个数、占用大小。大小在打开设置时异步统计。
   - 按钮：「在访达中打开」，与现有行一致；「清空…」需二次确认，**把文件移到废纸篓（`shell.trashItem`），不永久删除**。
   - 说明文字：「导入的 LUT 副本。删除会移到废纸篓，原来的文件不受影响。」
   - 下面列出引用的文件夹，每个可「移除」。**移除只断开引用，不删任何文件。**
5. **单个 LUT 的清理也放在 LUT 面板里**（用户不看文档，不能只靠设置页）：
   - 右键菜单：「在访达中显示」「移到废纸篓」，后者只对默认库里的 LUT 可用。
   - 面板底部常驻一行小字「LUT 库 · 128 个 · 210 MB」，点击跳到设置。
6. **索引缓存**：`userData/afterframe/luts-index.json`，以路径 + 大小 + 修改时间为键，记录内容哈希、尺寸、TITLE、Log 推断，以及用户对 Log 标签的手动修改（以内容哈希为键，改名或挪位置也不丢）。它只是缓存，删掉会重新扫描生成。

设置导出（`.afsettings`）不带 LUT 文件：体积太大，那里有 5 MB 上限。要在 `settings-scope.md` 的表里加一行，写明 LUT 库属于 app 级。

### 2. 解析：`shared/cubeLut.mjs`（纯函数，主进程和渲染进程共用，配 vitest）

照下面这张清单写自己的解析器。three.js、FFmpeg、OBS、darktable、RapidRAW 各自在其中某几条上出过问题。

- **容错：**
  - 去掉文件开头的 BOM。CRLF、CR、LF 换行都接受，文件最后没有换行也行。
  - 任意空白（包括 Tab）都算分隔符。
  - 关键字不区分大小写。`#` 注释可以出现在任何位置，包括数据之后。
  - TITLE 有没有引号都接受。
  - 数字解析不受系统区域设置影响。
  - 不认识的关键字直接忽略。
- **尺寸：** `LUT_3D_SIZE` 必须是 2–65 的整数，先检查再分配内存。65 是 Pillow 的上限，给 P2 留后路；本机普查里没有更大的。
- **输入范围：**
  - `DOMAIN_MIN/MAX`（每个通道分开）和 `LUT_3D_INPUT_RANGE`（一个标量）都要支持，min 必须小于 max。
  - 实现上，把偏移和缩放折进下面第 3 节 256 项的预计算表里，运行时零开销。
- **1D LUT：** `LUT_1D_SIZE`（只有 1D 表、或 1D 加 3D）P1 直接拒绝，错误码 `lut_1d_unsupported`。
- **数据行：**
  - 每行必须正好是 3 个有限数。`-1`、`.5`、`1e-3` 都要接受，NaN 和 Inf 拒绝。
  - 行数必须正好是 N³，否则报出「实际 X 行，应有 Y 行」。
  - 数据按 R 变化最快的顺序排：下标为 `r + g·N + b·N²`。
- **存储与输出：**
  - 内存里存 `Float32Array`，不在格点上截断（原因见普查里的越界值）。
  - 只在最终输出时截断到 0–1 并四舍五入到 8 位。
- **错误码**：照 `personalLogos.js` 的 `{ error: code }` 风格，界面上翻译成人话。

### 3. 套用：四面体插值，放在 Web Worker 里算

- `src/components/editor/render/lutApply.js`：
  - 按 256 种输入值，预计算每个通道的格点下标和小数部分（已含 DOMAIN 映射），然后对每个像素做四面体插值。
  - 输入、输出都是 RGBA 的 `Uint8ClampedArray`，alpha 原样保留。
  - 强度 `k` 在同一个函数里完成：`out = src + k·(lut − src)`，在 sRGB 编码值上混合，和 RawTherapee、digiKam、RapidRAW、GPUImage 的做法一致。
- `lutWorker.js`：
  - 这是渲染进程里第一个应用自己的 Worker。Vite 用 `new Worker(new URL("./lutWorker.js", import.meta.url), { type: "module" })`，web 版的 vite 配置也要验证一下。
  - 解析好的 LUT 放在 Worker 内存里，按内容哈希做 LRU 缓存，最多约 50 个（65³ 每个约 3.3 MB）。
  - 全分辨率保存时，按行切成若干块分给 `min(4, hardwareConcurrency − 1)` 个 Worker 并行算，用可转移的 ArrayBuffer，不复制。
- 不用 WebGL/WebGPU，原因有三：
  - 编辑器里目前没有 WebGL。
  - 没有 GPU 的机器上 WebGL 可能不可用。
  - 预览和保存走同一份 CPU 代码，结果才能保证一致；也避开了 GPU 硬件三线性的 8 位权重和 8 位纹理带来的色带（RapidRAW #540）。

### 4. 编辑器工具

- **命名**：工具 key 为 `lut`；文案待定（zh「LUT」或「滤镜」，en「LUT」）。
- **ToolRail**：`ToolRail.jsx` 加一个 ToolTab，用 `api.can("lut")` 门控：`electron/capabilities.js` 的非 darwin 分支加 `lut: false`，和 `stickerExtract` 一样。web 版没有文件系统，另用 `api.has("listLuts")` 隐藏。
- **面板 `LutPanel`**（从上到下）：
  1. 搜索框（按文件名）+「导入…」按钮。
  2. 按文件夹分组、可折叠的缩略图网格，每行 2–3 列：
     - 每格是当前照片（已含旋转、翻转，不含裁剪）缩到约 200px 后套这个 LUT 的效果，下方是文件名。
     - Log 推断为真的格子角上显示「Log」标签，悬停说明：「为 Log 视频素材设计，套在照片上通常会偏暗、偏艳。」
     - 渲染是懒的：用 IntersectionObserver 加小批队列，只渲染滚到附近的格子（lut-shelf、lut_viewer 的做法）。缓存以照片 + 变换 + LUT 哈希为键。
     - 缩略图生成照抄相框预设的做法（`useFrameTool.js:302` 起），但计算放进 Worker。
  3. 点一个格子就选中并预览，再点一次已选的格子取消（RapidRAW）。
  4. 强度滑杆 0–100%，默认 100%：
     - 拖动时不重新计算，用透明度把「套好 LUT 的预览层」叠在原图上。这和第 3 节的混合公式完全等价，所以零延迟，结果与保存一致。
     - 松手后再按新强度生成一次真正的混合结果，供后续的帧缩略图等使用。
  5. 「按住对比原图」按钮，也可以按住某个快捷键（键位待定，不和现有快捷键冲突）。
  6. 底部一行库信息，见 §1.5。
- **预览接入点**：`EditorOverlay.jsx:624` 的 `transformedPreview` 之前（对 `previewSource` 套 LUT）。这样相框缩略图、切图视图、合成视图都会自动带上效果。

### 5. 状态与历史

- `editorStateModel.js` 的 `BASE_STATE` 加：`lut: { hash: null, name: null, strength: 1 }`。同步更新相等判断和克隆函数，撤销、重做和「已编辑」标记就都有了。
- LUT 不在「应用」时写进图像：
  - 裁剪的「应用」（`handleApply`）和文字的「应用」（`handleTextApply`）都会把结果写回 `sourceImage`，它们必须基于未套 LUT 的原图。
  - LUT 永远只在预览和保存的最后一步才套上。

### 6. 保存

- `render/saveImage.js:76` 的 sharp 快速保存条件要加上 `!lut`。有 LUT 时一律走 canvas 路径，因为 sharp 不支持 3D LUT。
- 在 `cutRotatedCrop` 之后（`saveImage.js:123`）对 `content` 套 LUT，再接加边框、`scrim` 和各图层。这样文字、贴纸、相框、蒙层都不会被调色。
- **顺手修一个现有问题**：
  - `electron/ipc/saveFile.js:94` 的 `workspace:save-image` 没把画质传给 `writeImageWithSourceMetadata`，sharp 会按默认的 q80 再压一遍，这样就压了两次（canvas 一次 q0.92，sharp 一次 q80）。
  - 有 LUT 的保存全都会走这条路，所以要把 92 传下去，和快速保存路径一致。
- **切图导出**：`useSplitExport` 在没有图层时走 `processAndSavePanels`（sharp）。有 LUT 时要改走 canvas 路径，那条路径已经支持「应用之后再切」。
- **入库**：与现在一样，存成 `<stem>_edited.<ext>`，通过 `quickRegister` 登记为原图的一个版本。P1 不新增 `version_kind`。
- **色彩空间**：编辑器全程是 8 位 sRGB；P3 照片在解码时就已转成 sRGB（现在就是这样）。这正好符合 Rec709 / sRGB LUT 的设计前提，P1 不做额外的色彩管理。

### 7. Log 标签规则：`shared/lutLogGuess.mjs`（纯函数，配 vitest）

1. **候选文本**：文件名、导入时的原始文件夹名（取最后两级）、TITLE、文件头部的注释。
2. **先去掉输出端**：
   - "SLog3 to Rec709"、"LogC_to_709"、"…2Rec709" 都只看 "to" / "2" 前面那段（LumaForge 的做法）。
   - 这类 LUT 的输入确实是 Log，应该打标签。
3. **关键字**按词边界匹配，不区分大小写：
   - 各家 Log：`s-?log[23]?`、`f-?log2?`、`v-?log`、`c-?log[23]?`、`d-?log`、`n-?log`、`l-?log`、`i-?log`、`h-?log`
   - ARRI 和 RED：`log-?c[34]?`、`alexa`、`redlogfilm`、`log3g10`
   - 其他：`bmd ?film`、`cineon`，以及单独成词的 `log`
   - 已知例子：LUTIFY 的 `LOG/` 和 `ALEXA/` 文件夹能命中。
4. **已知误报**：中文 LUT 包常用「Vlog」指视频博客风格，例如 `Vlog-海边人像.cube`，它不是松下 V-Log。所以不带连字符的「vlog」单独出现时不算 Log；带连字符（`V-Log`），或同一名称里还有 `panasonic`、`lumix`、`vgamut`、`v709`、`to 709` / `to rec709` 时才算。本机的松下 LUT 全部写作 `V-Log`（如 `Panasonic V-Log.cube`、`V-Log to V-709.cube`），能命中。剩下的误判交给用户手动改。
5. **用户手动修改**：右键「标记为 Log / 取消 Log 标记」，按内容哈希存进索引，优先级高于自动推断。

### 8. i18n

- `editor.json`（en / zh-CN）：
  - 在 `overlay.tools` 下加 `lut`。
  - 新增一块 `lut: { title, search, import, importDone, importSkipped, empty, emptyHint, strength, compare, logBadge, logHint, markLog, unmarkLog, revealInFinder, moveToTrash, folderUnavailable, libraryFooter, errors.* }`。
- `settings.json`：`library.lutLibrary`、`lutLibraryHint`、`lutFolders`、`addLutFolder`、`removeLutFolder`、`clearLuts`、`clearLutsConfirm`。
- 空状态必须写清楚，因为用户不看文档：「把 .cube 文件或整个 LUT 文件夹拖到这里，或点导入。也可以添加你已有的 LUT 文件夹，不占额外空间。」
- 中文文案不用「——」。

### 9. 测试

- **单测（vitest）：**
  - `cubeLut.test.js`：覆盖解析清单的每一条。fixture 全部由测试代码现场生成，不带第三方 LUT。
  - `lutApply.test.js`：
    - 恒等 LUT 输出等于输入。
    - 一个已知的仿射 LUT（如交换通道、反相）结果精确。
    - 四面体和浮点参考最多差 1 级。
    - 强度 0 / 0.5 / 1 的结果正确。
  - `lutLogGuess.test.js`：本机普查里的典型文件名和文件夹名，包括 Vlog 误报。
- **主进程单测**：LUT 库的 IPC 处理代码，覆盖导入、去重、引用文件夹、移到废纸篓、索引重建。新 IPC 通道要通过 `ipcChannels.test.js` 和 `apiSurface.test.js`。
- **e2e `67-lut.spec.js`**（编号取开工时的下一个空号，2026-10-06 是 67）：
  - 导入一个生成的 17³ LUT。
  - 选中，强度调到 50%，保存。
  - 断言生成了新版本，且输出像素与预期相差不超过 1 级。
  - 断言文件名带 `SLog3` 的 LUT 显示 Log 标签。
  - 断言设置页显示 LUT 个数和大小。
  - 用 `e2e/fixtures/raw/` 里的 DNG 打开 LUT 工具，断言底图标签是「Apple RAW 渲染」，保存后的尺寸等于 RAW 的完整尺寸。
  - 非 Mac 平台整条跳过（工具被隐藏），写法同现有的平台相关 spec（如 `14-video`）；另加一条断言：Windows 上工具栏里没有 LUT 工具。
  - 这条 e2e 纯 CPU，不依赖 GPU，可以进 CI 子集。

## RAW

> 2026-10-05 补充调研：相机厂商、Lightroom / Capture One / DxO 等商业软件、开源项目，外加用作者 G-DRIVE 上的真实 RAW 做的实测（M1 Max，32 GB）。实验脚本和 Mac 原型在 [`docs/prototypes/lut/`](prototypes/lut/README.md)。

### 结论

1. **把 LUT「正确地」套在 RAW 上，业界没有现成答案，只能自己设计。**
   - 没有一家相机厂商把用户 LUT 套到 RAW 上。松下 Real Time LUT 是唯一能在机内给照片套 .cube 的，但手册写明「不能用于 RAW」，RW2 里只记录 Photo Style。
   - Lightroom 和 Capture One 都没有原生 LUT 工具。
   - DxO PhotoLab（v7 起）有，要用户在「LUT 色彩空间」菜单里自己选。
2. **底图决定结果。** 同一个 Rec709 LUT，套在相机内嵌 JPEG、Apple 渲染、LibRaw 渲染上，出来是三种颜色（见实测 1）。
3. **Log 版 LUT 用在 RAW 上可以做对，Mac 上已验证。** 流程是 RAW → 线性浮点 → 按官方公式编码成 S-Log3 → 套 LUT。这样还有个好处：索尼的 S-Log3 风格 LUT 也能用在尼康、哈苏、富士的 RAW 上，LUT 只认输入编码，不认机身。
4. **JPEG / HEIC 上的 Log 版 LUT 做不对**，因为高光已经裁掉了。这类照片维持只打标签。

### 别人怎么做

| | RAW 上套 LUT | 输入色彩空间 | 强度 | 备注 |
|---|---|---|---|---|
| 松下 LUMIX | 机内只套 JPEG / HEIF；LUMIX Lab 手机 App 能对 RW2 套 | 机内以 V-Log 或所选 Photo Style 为底 | 有浓度调节，可叠 2 个 | RAW 回家后，LR / C1 都还原不了机内用的 LUT |
| 索尼、佳能、尼康、富士、徕卡、大疆 | 不能。机内 LUT 都只用于视频 | — | — | RAW 里只存相机风格标签 |
| Lightroom / Camera Raw | 没有 LUT 工具，只能把 LUT 做成「创意配置文件」 | 制作时手选（sRGB 等，没有 Rec709） | 0–200% | 教程都建议先切到 Adobe 标准，避免叠两层风格 |
| Capture One | 没有 LUT 工具（需求挂着「未来考虑」） | — | — | 变通办法：LUT 转成 ICC 塞进「基本特性」，或用厂商分 RAW / JPG 两版的风格包 |
| DxO PhotoLab | 有，RAW 和 RGB 都能用 | 有「LUT 色彩空间」菜单，默认 sRGB | 只能往下调 | LUT 文件只引用不拷贝 |
| Dehancer（照片插件） | 不接 RAW，只吃 16 位 sRGB TIFF | sRGB | — | 要求先把底图调平：曝光 −1、对比度 −40、线性曲线 |

### 开源参考

RapidRAW 不是唯一的参考，但每个项目只覆盖一部分：

- **RapidRAW：**
  - 界面形态最接近我们。
  - 用户导入的 LUT 一律在最后一步、在显示空间里套。
  - 只有自带的胶片 LUT 会先编码成 V-Log，而且读源码没看到 sRGB → V-Gamut 的色域矩阵（未实测，可能偏艳）。
- **[Raw-Alchemy](https://github.com/shenmintao/Raw-Alchemy)**（中文）：
  - 流程：rawpy 线性 → ProPhoto → 选一种 Log（13 种）→ 四面体插值套 LUT。
  - 有一步没写进文档的「相机匹配增强」：饱和度 ×1.25、对比度 ×1.1。
  - issue 里有人反映：高光不压缩（#8）；和松下机内 LUT 比，偏色、噪点更多（#29）。
- **[rawlut](https://github.com/sadhfdw129/rawlut)**：LibRaw 线性 → 选编码（sRGB / Rec709 / 线性等）→ 套 LUT。FAQ 提醒 S-Log3→709 的 LUT 要先做对应的 Log 编码。
- **darktable：**
  - lut3d 模块排在影调映射（filmic / sigmoid）之后。
  - 用户可选 LUT 的输入空间：sRGB、Adobe RGB、Rec709、线性。没有 Log 选项。
  - 手册建议在「中性的图」上套 LUT。
- **ART：** 最干净的模型。LUT 一律吃线性 ACES，摄影机 Log 的转换交给 OpenColorIO。

### 实测

**1. 同一个 Rec709 LUT，三种底图**（索尼 A7M4、佳能 R6m2、富士 GFX50S II、哈苏 907X）

- **索尼、佳能：** 内嵌 JPEG 和 Apple 渲染接近。LibRaw（AfterFrame 在 Windows 上的参数）发灰偏暗，没有影调曲线，套 LUT 后更闷。
- **富士 GFX：** 内嵌图只有 4000×2664，AfterFrame 会改用完整渲染。结果 Mac（Apple 渲染）和 Windows（LibRaw）的底图完全不同，相机里选的胶片模拟也都丢了。

**2. Log 管线（Python，索尼 A7M4）**

- RAW 按官方公式编码成 S-Log3 后，套索尼官方的 `SLog3SGamut3.CineToLC-709TypeA`，结果和相机 JPEG 接近，说明管线正确。
- 同一个 Log 版风格 LUT：走 Log 管线效果自然；直接套在相机 JPEG 上，天空死蓝、暗部死黑。
- Log 先量化成 8 位，天空的不同颜色从 4245 种降到 354 种。这张图噪点多，看不出色带。按调研里的计算，8 位 Log 在中灰附近每档只有约 18 个色阶，干净的渐变上有色带风险。

**3. Mac 原生原型**（Swift + Core Image `CIRAWFilter`，全分辨率，分块处理，浮点四面体插值）

| 文件 | Apple 渲染 + Rec709 LUT | 线性 → S-Log3 → LUT | 峰值内存 |
|---|---|---|---|
| 索尼 A7M4，33MP | 1.0 s | 9.0 s | 0.6 GB |
| 尼康 Z8 高效率 RAW，45MP | — | 5.5 s | 1.3 GB |
| 哈苏 907X，1 亿像素 | 2.0 s | 9.5 s | 2.5 GB |

S-Log3 那一列的时间，大半是原型里粗糙的自动曝光试算（在 1/8 尺寸上试 41 档）。

**4. `CIRAWFilter` 自带每台机身的基准曝光**（`baselineExposure`）：
- 实测：索尼 0.3、佳能 0.45、富士 0.99、哈苏 −0.35、尼康 0.4。
- `boostAmount = 0` 时输出线性数据：最大值 0.98–1.18，中间亮度 0.03–0.055。
- 两个推论：
  - 要对到 Log 要求的 18% 灰，需要提 1.1–1.7 EV；这个值取决于参照，没有标准答案。
  - 照片在中灰以上只有约 2.5–3 档余量，视频 Log 有 6–8 档，所以 LUT 为高光设计的柔和过渡在照片上用不到。

**5. 尼康高效率 RAW（Z8 / Z9 / Zf / Z6III 的 HE / HE★）**
- 用的是 intoPIX 的 TicoRAW 专利压缩。
- LibRaw 0.22（rawpy 0.27.1）直接报不支持，盘上两张 Z8 实测打不开。
- LibRaw 官方在 [PR #826](https://github.com/LibRaw/LibRaw/pull/826) 里说，今年秋天的公开版会加入解码器。
- macOS 能完整解码，苹果有授权。
- 这些文件的内嵌 JPEG 是全尺寸的，Windows 上编辑器用内嵌图不受影响。
- **专利风险：** RapidRAW 的维护者在 [#655](https://github.com/CyberTimon/RapidRAW/issues/655) 里明确表示，即使有了开源解码器（dnglab [#835](https://github.com/dnglab/dnglab/pull/835)，仍未合并）也不会打包进应用。理由是 TicoRAW 基于 JPEG XS，专利很重，和 HEVC 的情况一样：开源项目放源码通常没事，但发行带未授权解码器的二进制有法律风险。
  - 所以 LibRaw 秋天的新版加入 HE 解码器后，AfterFrame 的 sidecar 要不要随 rawpy 一起带上，需要先看清授权情况。
  - Mac 上走苹果的系统解码器，没有这个问题。

**6. 哈苏 907X**
- 3FR 一张 202 MB，11664×8750，内嵌图只有 3888×2918。
- 完整解码：LibRaw 4.7 秒、峰值 1.4 GB；输出 16 位线性时 3.2 秒、1.7 GB；Apple 引擎 1.8 秒、1.4 GB。

### 各机身的内嵌 JPEG（决定编辑器用不用完整渲染）

| 机身 | 内嵌 JPEG | 来源 |
|---|---|---|
| 索尼 a7 IV 及之后 | 全尺寸（A7M4 7008×4672） | 实测 |
| 索尼较老机身（A7C、A7R IV、A9 II 等） | 1616×1080 | 调研 |
| 佳能 | 全尺寸（R6m2 6000×4000），带 Picture Style | 实测 |
| 尼康 | 全尺寸，带 Picture Control | 调研；Z8 实测可取出 |
| 富士 X 系列 | 1920–4416 px，带胶片模拟 | 调研 |
| 富士 GFX | 4000 px（GFX50S II 4000×2664） | 实测 |
| 松下 | 约 1920 px | 调研 |
| 哈苏 907X | 3888×2918 | 实测 |
| 大疆 DNG | 约 960 px | 调研 |
| iPhone ProRAW | 全尺寸 | 调研 |
| 徕卡 | 未知（M10 为 1440×960） | 调研 |

内嵌图本身带着相机风格（胶片模拟、Picture Control、Leica Looks，松下的机内 LUT 可能也在）。在它上面套 LUT，等于「相机风格 + LUT」叠了两层。

### 方案（只做 Mac）

**P1：RAW 上套普通（Rec709）LUT**
- **LUT 工具对 RAW 一律用 Apple 渲染作底图，不用内嵌 JPEG。**
  - **实现：** 复用现有的完整渲染路径：`electron/rawEditSource.js` 加 sidecar 的 `render_raw_full`，在 Mac 上就是 `sips`，即 Image I/O，底层和 `CIRAWFilter` 是同一个 Apple RAW 引擎。
    - 现在只有内嵌图不到 RAW 尺寸的 98% 时才走这条路；LUT 工具里改为强制走。
    - 渲染结果缓存在 `userData/raw-edit-cache`，保留最近 6 张。
    - **P1 不需要新写 Swift 程序**，Swift 常驻进程留给 P2。
  - **切换底图：** 进入 LUT 工具时，如果当前底图是内嵌图，就在后台渲染。实测 Apple 引擎全分辨率约 1–2 秒，哈苏 1 亿像素约 2 秒。渲染完成后再换底图，缩略图也基于新底图生成。
  - **底图标签：** 面板上标注「底图：Apple RAW 渲染（不含相机风格）」。换底图后，即使强度为 0，颜色也会和进入工具前不同（相机的胶片模拟、Picture Style 不再保留），标签要让用户看明白。「按住对比」对比的是 Apple 渲染的底图。
  - **sips 失败：** sips 偶尔会渲染出全黑的图，现有逻辑会退回 LibRaw，这时标签改为「底图：LibRaw 渲染」。
  - **开工时确认：** sips 的输出和 `CIRAWFilter` 默认参数的结果一致。两者是同一个引擎，应该一致。
  - LUT 仍由第 3 节的 JS 代码来套，和 JPEG 走同一条路。
- **理由：**
  - 各机身底图一致，都是全分辨率。
  - 不会和相机风格叠两层；这和 Lightroom 教程「先切到 Adobe 标准」的思路一致。
  - 尼康高效率 RAW 和 1 亿像素的文件都能处理。
  - 这一步没有 Log 编码，8 位精度够用。
- **Log 版 LUT 用在 RAW 上：** P1 和 JPEG 一样，只打标签。

**P2（仅 Mac）：「RAW 按 Log 素材处理」**
- **新 Swift 常驻进程 `raw-lut`**，形式同 `people-worker`：
  - 处理流程：`CIRAWFilter` 输出线性浮点（`boostAmount = 0`）→ 3×3 矩阵转到目标色域 → 按官方公式做 Log 编码 → 浮点四面体插值套 LUT → 分块输出 8 位 sRGB。
  - 一张照片的小尺寸线性数据常驻内存，用来批量生成缩略图。
- **支持的 Log：** S-Log3 / S-Gamut3.Cine、F-Log2 / F-Gamut、V-Log / V-Gamut、LogC3 / AWG3。公式和原色在厂商白皮书里都是公开的，见调研来源。佳能、尼康、大疆的 Log 在 colour-science 里有参考实现。
- **LUT 的输入空间：**
  - 先用 Log 标签规则推断 Log 类型。
  - 推断不出时（比如 LUTIFY 那种只写「LOG」的），让用户从下拉框选一次，按内容哈希记住。
  - 不弹阻塞式对话框。
- **曝光：** 只用自动曝光，不做微调滑杆（已拍板）。默认按元数据把中灰对到 0.18，用 `baselineExposure` 加 ISO 12232 的规则（中灰约在裁切点的 12.7%）；原型里的「匹配 Apple 渲染的中间亮度」作为备选。开工时用一批真实照片比较这两种方法，选更稳的那个。
- **强度：** 在 sRGB 编码值上，与 Apple 的显示渲染按比例混合。Lightroom 调低创意配置文件的强度时，也是往基础配置文件混。
- **局限：**
  - 照片的高光余量只有 2.5–3 档，用不到 LUT 的高光过渡。
  - 暗部噪点会被 Log 提起来。
  - 通用 3×3 矩阵和厂商机内的转换有差异，主要在高饱和色。
  - S-Gamut3 和 S-Gamut3.Cine 容易混淆。
- **卖点：** LUMIX 用户在相机里用的 LUT 只进了 JPEG，RAW 回家后 Lightroom / C1 都还原不了。走 V-Log 管线可以做到。

## 涉及文件（预估）

| 文件 | 改动 |
|---|---|
| `shared/cubeLut.mjs` + 测试 | 新建：解析 |
| `shared/lutLogGuess.mjs` + 测试 | 新建：Log 推断 |
| `electron/ipc/luts.js` + 测试 | 新建：扫描、导入（拷贝 + 去重）、引用文件夹、移到废纸篓、统计大小 |
| `electron/main.js` | 注册 `luts.register` |
| `shared/ipcChannels.mjs` | 新通道：listLuts、importLuts、addLutFolder、removeLutFolder、trashLut、clearLutLibrary、lutLibraryStats、readLut |
| `src/components/editor/render/lutApply.js`、`lutWorker.js` + 测试 | 新建：四面体插值和强度混合 |
| `src/components/editor/state/useLutTool.js` | 新建：选中项、缩略图队列、预览 |
| `src/components/editor/LutPanel.jsx` | 新建 |
| `editor/components/ToolRail.jsx` | 加 ToolTab（`api.can("lut")` 门控） |
| `electron/capabilities.js` + 测试 | 非 darwin 加 `lut: false` |
| `electron/rawEditSource.js`、`electron/ipc/assets.js`（`workspace:raw-edit-source`） | 加一个选项：LUT 工具里强制完整渲染，并返回底图来自哪个引擎（Apple / LibRaw），供面板标签使用 |
| `editor/state/editorStateModel.js` | `BASE_STATE.lut` |
| `EditorOverlay.jsx` | 面板切换、预览接入、拖放导入 |
| `editor/render/saveImage.js` | 快速保存条件、在 content 上套 LUT |
| `editor/state/useSplitExport.js` | 有 LUT 时走 canvas 路径 |
| `electron/ipc/saveFile.js` | `save-image` 传画质 92 |
| `components/settings/LibrarySettings.jsx` | 「LUT 库」一行和引用文件夹列表 |
| `i18n/locales/{en,zh-CN}/{editor,settings}.json` | 文案 |
| `e2e/67-lut.spec.js` | 新建（编号取开工时的下一个空号） |
| `docs/settings-scope.md` | 加一行：LUT 库属于 app 级 |

## 风险 / 注意

- **大库首次打开**：800 个 LUT 全解析一遍约 8 秒，所以只解析看得到的格子。如果实测还是慢，P2 再加持久化的缩略图专用降采样表（17³，约 29 KB 一个，放在缓存目录，可清理）。
- **RAW 换底图会变色**：进入 LUT 工具后，RAW 从相机内嵌图换成 Apple 渲染，颜色会变。面板必须标注底图，见「RAW」一节的方案。
- **1 亿像素保存**：全分辨率 canvas 的 RGBA 约 400 MB，`getImageData` 还要再占一份；JS 四面体插值约 1.5 秒（按 24MP 0.39 秒推算）。用多个 Worker 并行，并显示保存进度。
- **以后放开 Windows 时**：
  - 慢机上全分辨率保存估计要几秒，需要在 Kamatera 测试机上实测。
  - RAW 底图只能用内嵌图或 LibRaw；富士、哈苏、松下、大疆的效果会打折扣。
- **外置盘拔掉**：引用的文件夹会变成「不可用」，扫描要处理文件夹不存在或没有读权限的情况，不能卡住界面。
- **重复导入**：同名但内容不同的文件按「名称 (1)」改名后存入；同内容直接跳过。
- **用户在访达里直接改了库文件夹**：每次打开 LUT 工具时增量扫描，按修改时间和大小判断，不常驻监听目录。
- **AI 重绘、文字应用等**都作用在未套 LUT 的原图上。重绘结果作为新照片打开后，可以再单独套 LUT。
- **Log LUT**：JPEG / HEIC 上只打标签，不做 Log 转换预处理，因为高光已经裁掉了，转成 Log 也还原不出视频素材上的效果。RAW 上的做法见「RAW」一节。

## 分期

**P1**（只做 Mac；Windows 隐藏）：
- 只支持 .cube 3D LUT。
- RAW 用 Apple 渲染作底图，复用现有的完整渲染路径。
- 默认库文件夹 + 导入（拷贝、去重）+ 引用文件夹。
- 设置里的 LUT 库一行：大小、打开、清空到废纸篓。
- 编辑器 LUT 工具：缩略图网格、分组、搜索、Log 标签和手动修改、强度、按住对比。
- 保存走 canvas 路径，修复 q80 重复压缩。
- 单测 + e2e。

**P2**：
- 悬停预览大图。
- 拖动分割线对比（复用 `BeforeAfterCompare`）。
- 收藏。
- 持久化的缩略图降采样表。
- 1D + 3D shaper、.3dl、Hald PNG。
- 内置 LUT（自己制作，避免版权问题）。
- 批量套 LUT 到多选照片：用渲染进程的 Worker，或 sidecar 的 numpy 四面体实现。不用 Pillow 的三线性，否则和编辑器结果最多差 5 级。如果走 sidecar，要先把预览图保留的 P3 配置文件转成 sRGB。
- MCP 工具 `apply_lut`。
- 库文件夹换位置（比如放到外置盘）。
- 「RAW 按 Log 素材处理」：自动曝光，没有曝光滑杆，见「RAW」一节。
- Windows 放开（JPEG 可直接用；RAW 底图见风险一节）。

## 不做

- 曝光、曲线、HSL 等任何调色。
- JPEG / HEIC 上的 Log 转换。RAW 上的 Log 处理是 P2 提案，见「RAW」一节。
- 阻塞式的「选择输入色彩空间」对话框。
- Log 模式的曝光微调滑杆。
- 超过 100% 的强度。
- WebGL / WebGPU 渲染。
- 16 位或广色域输出。
- 制作或导出 LUT。

## 附：调研来源（2026-10-05 读源码时的 commit）

- 达芬奇：LUT 文件夹、「打开 LUT 文件夹」「更新列表」，偏好设置 → 系统 → 常规 → LUT Locations（[davinciresolveclub](https://davinciresolveclub.com/how-to-use-luts-in-davinci-resolve/)）。本机 `/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/` 占 581 MB。
- 剪映：本机 `~/Movies/JianyingPro/User Data/Resources/Lut/`，294 个，551 MB，每个 LUT 一个文件夹。
- darktable [`src/iop/lut3d.c`](https://github.com/darktable-org/darktable/blob/abc10290a71b/src/iop/lut3d.c)
- RawTherapee [`rtengine/clutstore.cc`](https://github.com/RawTherapee/RawTherapee/blob/5f486d3678b3/rtengine/clutstore.cc)
- ART [`src/engine/clutstore.cc`](https://github.com/artraweditor/ART/blob/beed70438964/src/engine/clutstore.cc)
- digiKam `core/libs/dimg/filters/fx/colorfxfilter.cpp`（invent.kde.org，a0d0d6b4e747）
- RapidRAW [`src-tauri/src/lut_processing.rs`](https://github.com/CyberTimon/RapidRAW/blob/1cc99d5/src-tauri/src/lut_processing.rs)、[`LUTControl.tsx`](https://github.com/CyberTimon/RapidRAW/blob/1cc99d5/src/components/ui/LUTControl.tsx)、issue [#264](https://github.com/CyberTimon/RapidRAW/issues/264)、[#540](https://github.com/CyberTimon/RapidRAW/issues/540)
- LumaForge [`lut-profile-resolution.ts`](https://github.com/ChrAlpha/LumaForge/blob/93846b9/packages/luma-color-runtime/src/lut-profile-resolution.ts)、[`LUT_AND_EXPORT_FAQ_zh.md`](https://github.com/ChrAlpha/LumaForge/blob/93846b9/docs/LUT_AND_EXPORT_FAQ_zh.md)
- immich-edit [`lut.rs`](https://github.com/haavardnk/immich-edit/blob/241b0a7/crates/raw-pipeline/src/lut.rs)、[`Lut.svelte`](https://github.com/haavardnk/immich-edit/blob/241b0a7/web/src/lib/panels/Lut.svelte)
- lut-shelf [`app.js`](https://github.com/ZSinCos/lut-shelf/blob/c3afbc5/js/app.js)；lut_viewer [`app.js`](https://github.com/Velkan/lut_viewer/blob/103a824/js/app.js)
- OBS [`color-grade-filter.c`](https://github.com/obsproject/obs-studio/blob/c5bcbca63f/plugins/obs-filters/color-grade-filter.c)
- FFmpeg [`vf_lut3d.c`](https://github.com/FFmpeg/FFmpeg/blob/47313ad3f9/libavfilter/vf_lut3d.c)
- OpenColorIO `FileFormatIridasCube.cpp` / `FileFormatResolveCube.cpp`（22dd9c4faa）
- three.js [`LUTCubeLoader.js`](https://github.com/mrdoob/three.js/blob/f0a6731/examples/jsm/loaders/LUTCubeLoader.js)、[`LUTPass.js`](https://github.com/mrdoob/three.js/blob/f0a6731/examples/jsm/postprocessing/LUTPass.js)
- GPUImage [`GPUImageLookupFilter.m`](https://github.com/BradLarson/GPUImage/blob/167b0389bc/framework/Source/GPUImageLookupFilter.m)
- pillow-lut-tools [`loaders.py`](https://github.com/homm/pillow-lut-tools/blob/b7364cd145/pillow_lut/loaders.py)
- Raw-Alchemy（RAW → Log → LUT 的 Python 工具）[core.py](https://github.com/shenmintao/Raw-Alchemy/blob/main/src/raw_alchemy/core.py)；rawlut [repo](https://github.com/sadhfdw129/rawlut)
- RAW 部分：
  - 松下 Real Time LUT：[说明](https://shop.panasonic.com/pages/lumix-color-science-real-time-lut)，S5M2 手册（[不能用于 RAW](https://eww.pavc.panasonic.co.jp/dscoi/DC-S5M2/html/DC-S5M2_DVQP2839_eng/0069.html)），[LUMIX Lab](https://av.jpn.support.panasonic.com/support/global/cs/soft/lumix_lab/en/cts/a1.html)
  - 索尼：[a7 V 的 LUT 只用于视频](https://helpguide.sony.net/ilc/2540/v1/en/contents/211h_display_lut.html)
  - 佳能：[R5 II Custom Picture](https://cam.start.canon/en/C017/manual/html/UG-03_Shooting-2_0130.html)
  - 尼康：[ZR 的 LUT](https://onlinemanual.nikonimglib.com/zr/en/09-05-105.html)
  - 富士：[官方 LUT](https://www.fujifilm-x.com/en-us/lut)
  - Adobe：[创意配置文件与强度](https://jkost.com/blog/2024/07/the-power-of-profiles-in-lightroom-classic.html)，[Rec709 需求](https://community.adobe.com/t5/camera-raw-ideas/p-add-rec-709-to-lut-color-spaces-in-new-enhanced-profiles/idi-p/12221136)
  - Capture One：[LUT 需求](https://captureone.ideas.aha.io/ideas/FR-I-1011)，[变通办法](https://alexonraw.com/how-to-use-lut-in-capture-one/)
  - DxO：[用户指南](https://userguides.dxo.com/photolab/en/the-customize-tab/)
  - Dehancer：[色彩空间](https://www.dehancer.com/learn/article/color-spaces)
  - darktable：[lut3d 手册](https://github.com/darktable-org/dtdocs/blob/master/content/module-reference/processing-modules/lut-3D.md)，[iop_order.c](https://github.com/darktable-org/darktable/blob/master/src/common/iop_order.c)
  - ART：[LUT 说明](https://artraweditor.github.io/Luts)
  - rawtoaces：[repo](https://github.com/AcademySoftwareFoundation/rawtoaces)
  - Log 公式和原色：[S-Log3](https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf)，[F-Log](https://dl.fujifilm-x.com/support/lut/F-Log_DataSheet_E_Ver.1.1.pdf)，[F-Log2](https://dl.fujifilm-x.com/support/lut/F-Log2_DataSheet_E_Ver.1.0.pdf)，[V-Log](https://pro-av.panasonic.net/en/cinema_camera_varicam_eva/support/pdf/VARICAM_V-Log_V-Gamut.pdf)，[LogC3](https://www.arri.com/resource/blob/31918/66f56e6abb6e5b6553929edf9aa7483e/2017-03-alexa-logc-curve-in-vfx-data.pdf)，[colour-science](https://github.com/colour-science/colour/tree/develop/colour/models/rgb/transfer_functions)
  - 尼康高效率 RAW：[LibRaw PR #826](https://github.com/LibRaw/LibRaw/pull/826)
  - Apple：[`CIRAWFilter.boostAmount`](https://developer.apple.com/documentation/coreimage/cirawfilter/boostamount)
