# 无缝切图（Split）设计方案

> UI mock: docs/prototypes/split-ui.html
> **状态（2026-09-15）**: P1 已实现（feat/split）。后续按反馈补了自定义比例、目标目录 + 子目录复选框、web 壳逐张下载（e2e-web/03-web-split）。工具 `split`、`splitMath.js` + 单元测试、`useSplitTool` / `useSplitExport`、`SplitOverlay` / `SplitPanel`、主进程 `processAndSavePanels`（一次解码同一栅格切 N 片，含自由角度），e2e `33-split.spec.js` 已进 CI 子集。与设计的差异：Apply 之后的画布源也能切（canvas 路径，同样一次裁剪再切），仍不支持图层。

## 需求

超宽图（全景、航拍横幅）在小红书 / Instagram 上的常见玩法是切成 N 张等宽的竖图，按顺序发成一组，用户左右翻页时画面无缝衔接。AfterFrame 目前只能手动裁 N 次，且难以保证每张边缘严丝合缝。

新增一个编辑器工具，入口在编辑器右侧工具栏，紧跟在裁剪之后（第二位）。用户可以：

- 选择每一片的长宽比（默认 3:4 竖构图，另有 4:5、1:1、9:16、2:3）
- 选择切成几片（N）
- 在图上拖动、缩放一个「覆盖区域」，区域不必覆盖整张图，覆盖区域的长宽比由 N × 单片比例自动锁定
- 一键导出 N 张到原图旁边的子文件夹，按顺序编号，进入原图的版本堆栈

## 命名

| 语言 | 工具名 | 面板标题 | 备注 |
|---|---|---|---|
| en | Split | Seamless Split | 工具 key 固定为 `split`，与代码中已有的 collage `cell`、UI `panel` 不冲突 |
| zh-CN | 切图 | 无缝切图 | 「切图」比「分屏」「分割」更贴近小红书用户的说法（长图切图、无缝切图） |

备选：zh「轮播切图」「分片」。不建议「九宫格」，那是另一种玩法（3×3 网格），可作为 P2 的纵向 / 网格模式再考虑。

图标：lucide `Columns3`（三个并排竖框），与用户描述一致。工具栏其余图标也来自 lucide，风格统一。若嫌 `Columns3` 竖线太细，可自绘 3 个带间隙的圆角竖矩形。

## 现状（可复用的部分）

- 工具栏：`editor/components/ToolRail.jsx` 是硬编码的 `<ToolTab>` 列表，加一项即可；面板由 `EditorOverlay.jsx` 里的三元链选择，画布覆盖层按 `tool === "xxx"` 各自门控。
- 裁剪工具：`cropMath.js` 的 `ASPECT_PRESETS`、`createCenteredCrop`、`resizeCropRect`、`moveCropRect`，以及 `CropOverlay.jsx` 的 8 个手柄和暗幕。split 的覆盖区域交互与裁剪框几乎一致，只是长宽比永远锁定。
- 坐标约定：`cropRect` 存视口像素，导出时 `getNormalizedCrop(state, imageRect)` 归一化到 0..1。split 沿用同一套。
- 统一历史：`editorStateModel.js` 的 `BASE_STATE` 加一个 `split` 槽位，undo / redo 自动覆盖。
- 导出：`useEditorSave.js` → `render/saveImage.js`。无图层时走 `api.processAndSave`（sharp，原始分辨率，支持旋转翻转 + crop）；有图层时走 canvas 合成。split 只需把「一个 crop」变成「N 个 crop」。
- 入库：`api.quickRegister(savePath, sourcePath)` → sidecar `quick-register` → `attach_asset_to_resource_set(version_kind="derived")`，导出的每一片都会挂到原图版本堆栈。
- 多产物导出模板：`CollageOverlay.jsx` 的 `handleBatchExport`（`_01.jpg` 编号、进度、单页失败计数），直接照抄。

## UI 设计（见 mock）

### 工具栏

裁剪之后的第二个 ToolTab：`Columns3` 图标，`data-testid="tool-split"`。无能力门控（纯画布功能，web 版也可用）。

### 画布覆盖层 `SplitOverlay`

1. 覆盖区域以外压暗，与裁剪一致。
2. 区域内画 N-1 条竖分隔线，每片左上角标编号 1..N（小圆角标签），用户能直观看到每张的取景。
3. 四角手柄等比缩放（长宽比锁定），区域内部拖动平移，边中点不放手柄（比例锁定时边拖没有意义）。
4. 区域不允许超出图片；缩放到贴边时停住。
5. 默认区域：高度 = 图片高度，宽度 = N × 单片宽，水平居中；若 N × 单片宽 > 图片宽，则以宽度为准，高度按比例缩小并垂直居中。

### 右侧面板 `SplitPanel`（从上到下）

1. **长宽比（每片）**：标题、按钮样式与裁剪工具的「长宽比」一致，但语义是单片比例，预设只保留竖向 / 方形：1:1、3:4（默认）、2:3、9:16、4:5，外加一个「自定义」格子（虚线图标，与裁剪的 Free 同款）；选中自定义后在网格下方出现「宽 : 高」两个输入框（1..100，失焦或回车提交），最近一次自定义值随状态保留。改比例或片数时区域保持中心、取能放下的最大尺寸。
2. **片数**：步进器 2..10，默认自动计算：`floor(图片宽 / (图片高 × 单片比例))`，夹到 2..10。用户改比例时若片数是「自动」状态则重新计算，手动改过就保持。
3. **覆盖**：只读信息 + 一个「重置为全高」按钮。显示当前区域占图片的百分比（宽 × 高），以及每片输出尺寸（像素）。
4. **预览条**：N 张缩略图横向排列，中间留 6px 间隙，模拟翻页时的样子。点击任一片，画布高亮对应分片。
5. **输出**：
   - 位置：目标目录默认为原图所在目录，右侧文件夹按钮可改；「创建子目录」复选框默认勾选，勾选时写入 `{目标目录}/{stem}_split/`，不勾选则 N 张直接进目标目录。文件名 `{stem}_split_01.jpg` … `_0N.jpg`。路径框中间省略、保留头尾。
   - Web 壳（无文件系统）：隐藏目录控件，提示「N 张会逐张下载」，走 canvas 路径逐张触发浏览器下载，文件名同上（从 blob URL 的 `#/name` 解码）。
   - 子文件夹在已监听的目录里也没问题：`quick-register` 按解析后的路径 upsert，`scan-new-media` 会跳过已登记路径，不会重复入库。
   - 分辨率固定为原始分辨率，不做长边上限。
   - 主按钮「导出 N 张」，导出中显示 `k / N` 进度，与批量拼图相同的 toast 与「在 Finder 中显示」。

### 与其他工具的关系

- split 作用于变换后的整张图（旋转、翻转、自由角度都生效），忽略裁剪框。这样用户不用先裁再切；如果需要「先裁再切」，覆盖区域本身就是裁剪。
- P1 不支持带图层（文字 / 贴纸 / 边框）的切图：存在图层时导出按钮禁用，并提示「请先应用图层或在无图层版本上切图」。P2 再加「合成一次再切 N 片」的 canvas 路径。
- 进入 split 工具时不改动裁剪状态，切回裁剪工具时裁剪框原样恢复。

## 实现要点

### 1. 状态结构（`BASE_STATE` 内加 `split`）

```js
split: {
  aspectKey: "3:4",     // 单片比例 key，复用 ASPECT_PRESETS 的 key
  count: null,          // null = 自动；数字 = 用户手动指定
  rect: null,           // 视口像素 { x, y, width, height }，null = 尚未初始化（按默认规则生成）
  outputDir: null,      // null = 原图旁 {stem}_split/；用户改过则为绝对路径（不入历史）
}
```

`rect` 与 `cropRect` 一样放在历史快照里，拖动过程中用 `cloneState` / `stateEquals` 的现有路径合并。

### 2. 几何：`editor/splitMath.js`（纯函数 + vitest）

```js
resolveSplitCount({ imageW, imageH, aspect, count })        // 自动片数
createDefaultSplitRect(imageRect, aspect, count)           // 默认覆盖区域
resizeSplitRect(rect, handle, dx, dy, imageRect, aspect * count)  // 等比缩放 + 贴边
moveSplitRect(rect, dx, dy, imageRect)
splitRectToPanels(normalizedRect, count, sourceW, sourceH) // → N 个源图像素矩形
```

`splitRectToPanels` 是无缝的关键：分界线用累计取整，`x_i = round(x0 + i * W / N)`，第 i 片为 `[x_i, x_{i+1})`。这样相邻片既无 1px 缝隙也无重叠，各片宽度最多相差 1px，肉眼不可见。高度对所有片相同。

### 3. 覆盖层与交互：`SplitOverlay.jsx` + `state/useSplitTool.js`

照 `CropOverlay` / `useCropTool` 的结构：`beginSplitResize`、`beginSplitMove`、`handlePointerMove` 挂到同一个 `pointerStateRef`。手柄只保留四角，`resizeSplitRect` 内部固定用 `symmetricResize` 的等比分支。

### 4. 导出：`state/useSplitExport.js`

```
dir = outputDir || `${dirname(sourcePath)}/${stem}_split`   (api.ensureDir，新增一个小 IPC，或让 processAndSave 自动 mkdir -p)
panels = splitRectToPanels(normalizedRect, count, sourceW, sourceH)
for i in 0..N-1:
  path_i = `${dir}/${stem}_split_${pad2(i+1)}.${ext}`
  api.processAndSave({ sourcePath, savePath: path_i, quarterTurns, freeAngle, flipX, flipY, crop: panels[i] (归一化), quality: 92 })
  api.quickRegister(path_i, sourcePath)
  setProgress({ done: i+1, total: N })
完成:  onSaveComplete(最后一张路径) → refreshAll，toast「已导出 N 张」
```

只走 sharp 路径，原始分辨率，无需改 `saveFile.js` 的处理逻辑；只需让它在写文件前 `mkdir -p` 目标目录（目前编辑器保存的目录一定已存在，split 是第一个写子文件夹的调用方）。

单片失败不中断，计数后在 toast 里报「N 张中 k 张失败」，与批量拼图一致。

### 5. i18n

`editor.json` 两个语言文件：`overlay.tools.split`，以及新块 `split: { title, panelAspect, count, auto, coverage, resetFullHeight, preview, output, subfolderHint, chooseFolder, layersBlocked, exportN, exporting, done, partialFail }`。中文文案不用「——」。

### 6. 测试

- `splitMath.test.js`：自动片数、默认区域、贴边缩放、`splitRectToPanels` 的无缝性质（相邻片 `x_{i+1} == x_i + w_i`，总宽度等于区域宽度）。
- e2e `33-split.spec.js`：打开 fixture 里最宽的图 → 选 split → 3:4、3 片 → 导出 → 断言原图旁出现 `{stem}_split/` 且含 3 个文件、每个尺寸为 3:4、三张宽度之和等于覆盖区域宽度、`asset-detail` 里原图的 `version_siblings` 增加 3 个。放进 CI 稳定子集（纯 sharp，无 GPU 依赖）。

### 7. MCP（P2）

内嵌 MCP 已有 `crop_assets`，可加 `split_asset({ asset_id, panel_aspect, count, region? })`，复用 `splitRectToPanels` 的 Python 等价实现，让 agent 也能一句话切图。P1 不做。

## 涉及文件（预估）

| 文件 | 改动 |
|---|---|
| `editor/components/ToolRail.jsx` | 新增 ToolTab |
| `editor/components/SplitPanel.jsx` | 新建 |
| `editor/components/SplitOverlay.jsx` | 新建 |
| `editor/splitMath.js` + `.test.js` | 新建 |
| `editor/state/useSplitTool.js` | 新建 |
| `editor/state/useSplitExport.js` | 新建 |
| `editor/state/editorStateModel.js` | `BASE_STATE.split` |
| `EditorOverlay.jsx` | 面板三元链、覆盖层门控、`showCropUi` 排除 split |
| `electron/ipc/saveFile.js` | 写入前 `mkdir -p` 目标目录 |
| `i18n/locales/{en,zh-CN}/editor.json` | 文案 |
| `e2e/33-split.spec.js`、`.github/workflows/quality.yml` | 测试与 CI 子集 |
| `docs/prototypes/split-ui.html` | mock |

## 风险 / 注意

- 超宽全景原图可能上万像素宽，sharp 路径已 `limitInputPixels: false`，P1 只走这条路径，不受 `PREVIEW_MAX_EDGE = 2200` 降采样影响。
- 分界线取整后各片宽度可能差 1px，社媒平台会把每张再缩放，翻页时看不出来。
- 子文件夹与原图同级，若用户的目录被 AfterFrame 监听，新文件会被扫描到但因已登记而跳过；若用户后来手动删掉子文件夹，版本堆栈里会出现「文件缺失」角标，这是现有行为。
- 导出 N 张会连续调用 N 次 sidecar `quick-register`，走的是串行 resident sidecar，10 张约 1 到 2 秒，可接受；导出中禁用主按钮防止重复点击。
- 版本堆栈里会多出 N 个派生版本，检查器「其他版本」缩略条会变长，P1 先接受，P2 考虑按导出批次折叠。

## 分期

**P1**：横向切分、五个预设比例（默认 3:4）、2..10 片、覆盖区域拖动缩放、原分辨率、输出到 `{stem}_split/` 子文件夹并入库、e2e。

**P2**：带图层切图（合成一次再切）、纵向切分（长图切成多屏）、自定义比例输入、九宫格模式、MCP `split_asset`、版本堆栈按批次折叠、每片单独微调（类似批量拼图的单页覆盖）。

## 已拍板（2026-09-15）

1. 名字：zh「切图 / 无缝切图」，en「Split / Seamless Split」。
2. 默认单片比例 3:4 竖构图，片数默认自动。
3. 输出到原图同目录下的子文件夹 `{stem}_split/`，可改。
4. P1 不支持带图层的切图。
5. 不做长边上限。
