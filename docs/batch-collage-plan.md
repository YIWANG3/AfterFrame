# 批量拼图（Batch Collage）实现方案

> UI mock: `docs/prototypes/batch-collage-ui.html`（浏览器直接打开，可交互）
>
> **状态（2026-08-14）**：P1 已实现并通过 e2e（`e2e/25-collage-batch.spec.js`，5 用例含真实导出）。
> 额外纳入 P1 的：单页布局（卡片右上角悬停按钮 → 弹窗，只改这一页；右栏「布局」= 所有页并清掉各页单独设置，不引入"覆盖/同步/选页"概念）、跨页拖拽换图（按住任一格拖到任意页任意格松手即交换；非"选择顺序"排序时先把当前顺序固化再交换）。默认进批量的阈值 = 单张模板上限 12 张（≤12 单张，>12 批量）；页预览网格整块居中、行内从左往右排（CSS grid auto-fit + justify-content:center）。
> 单页微调也已在批量页内直接支持：格内拖动 = 平移、拖出格子 = 交换（同页/跨页）、滚轮/捏合 = 缩放；平移/缩放状态按图片（asset_id）记录并在所有页共享，跨页交换后跟着图片走。P2 已无剩余项。

## 需求

一次选中 N 张图片（如 12 张），选择"每几张拼一张"，统一设置布局、画布、导出尺寸，一次导出多张拼图。

## 现状（可复用的部分）

单张拼图已具备全部核心能力，批量模式是在其上加一层"分组 + 逐页渲染"：

- `CollageOverlay.jsx`：全屏编辑器，入口在 `App.jsx`（多选 → 拼图）
- `collageTemplates.js`：按图片数（2~12）定义归一化 cell 布局；`getTemplatesForCount()` 已支持"数量不足时回退到更小模板"
- `CollageCanvas.jsx`：交互画布 + `exportToBlob(targetWidth)` 离屏导出
- 导出链路：`pickSavePath` → `saveImage`（带 EXIF 源）→ `quickRegister`（登记回目录并关联源资产）

## UI 设计（见 mock）

顶栏加 **单张 | 批量** 模式切换。选中图片数 > 12（单张模板上限）时默认进批量，≤ 12 进单张，可手动切换。

- **左侧**：分页预览网格，每页实时渲染缩略拼图；点击选页；cell 上右键 → 替换… / 移除（与单张模式画布右键一致，不做单独的图片列表）。增删图片会改变分组，需重置 `pageOverrides` 与选页
- **右栏**（自上而下）：
  1. ~~选中页覆盖卡~~（已否决：概念太重）→ 单页布局改为卡片右上角悬停按钮 + 弹窗
  2. **分组**：每张拼图 2/3/4/6/9 张（+自定义）；图片顺序（选择顺序/拍摄时间/文件名）；**余图处理**：单独成图（默认，自动用小模板）/ 并入最后一张 / 不使用；底部「＋ 添加图片」按钮（复用现有 `ImagePickerModal`，追加到序列末尾后自动重新分组，用于凑整余图）
  3. **布局**：全局模板（应用到所有页），SVG 缩略图同现有面板
  4. **画布**：宽高比 / 间距 / 页边距 / 圆角 / 背景色（全局）
  5. **导出**：宽度 1080~4096；文件名前缀 + 序号预览（`travel_01.jpg …`）
- **导出按钮**：`导出 N 张到文件夹`，选文件夹而非单文件

## 实现要点

### 1. 状态结构（CollageOverlay 内加 mode）

```js
mode: "single" | "batch"
batch: {
  groupSize, orderBy, remainderMode,      // 分组
  globalTemplateId,                        // 全局布局（按 groupSize 的模板池）
  pageOverrides: Map<pageIdx, { templateId?, cellStates? }>,  // 单页覆盖
}
// ratio/gap/padding/radius/bg/exportWidth 沿用现有全局 state
```

分组是纯函数：`computeGroups(images, groupSize, remainderMode)`，派生不存储。

### 2. 分页预览渲染

两个方案：

- **A（推荐）**：每页复用一个只读小尺寸 `CollageCanvas`（禁用交互，仅绘制）。改造点：加 `interactive={false}` prop 跳过事件绑定。图片加载已有 `loadedImgsRef` 缓存逻辑，12 张图 3~4 个 canvas 开销可忽略（用 512px 缩略图绘制预览即可，导出时才用 HD）
- B：抽出纯绘制函数 `drawCollage(ctx, images, template, opts)` 供预览/导出共用。重构更干净但动到现有代码更多

### 3. 单页编辑

点击"进入单页编辑"→ 把该页的 images/template/cellStates 灌进现有单张编辑视图（同一个 overlay 内切视图，不是新 overlay），完成后把 cellStates 写回 `pageOverrides`。第一版可以只做"换布局"，pan/zoom 微调放第二版。

### 4. 批量导出

```js
const dir = await window.mediaWorkspace.pickDirectory();   // 新 IPC，或 pickSavePath 变体
for (const [i, group] of groups.entries()) {
  const blob = await renderPageToBlob(group, templateFor(i), opts);  // 离屏，逐页
  const name = `${prefix}_${String(i+1).padStart(2,"0")}.jpg`;
  await window.mediaWorkspace.saveImage(join(dir, name), buf, group[0].image_path);
  await window.mediaWorkspace.quickRegister(path, group[0].image_path, group.map(g=>g.asset_id));
}
```

- 需要新增 `pickDirectory` IPC（`dialog.showOpenDialog({ properties: ["openDirectory"] })`）
- 导出前对全部图片跑现有 `ensureHdPreviews`（现有逻辑只对画布上的图跑，批量要覆盖所有组）
- 逐页串行导出 + 进度条（`导出中 2/4…`），失败单页跳过并汇总提示

### 5. 模板池边界

`groupSize` 允许 2~12（模板已覆盖）；余图 `own` 模式下最后一页数量可能是 1，需要加一个 `1: [full]` 模板（现有模板从 2 起）。

## 分期

- **P1**：模式切换 + 分组 + 全局设置 + 分页预览 + 添加图片 / cell 右键替换移除 + 批量导出（含 pickDirectory IPC、进度）
- ~~P2~~：全部并入 P1（单页布局、跨页拖拽、格内平移/缩放）
- **不做**：每页独立宽高比/背景（保持批量语义简单，有需要单张模式处理）
