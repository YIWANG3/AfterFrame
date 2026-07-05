# 统一画布 / 图层模型 — 实施计划

> ## ✅ 已确认方向(2026-07,pivot 锁定)
> **走完全统一(Option A)。相框功能 = 一组 JSON 预设,套用时生成图层 + 设置画布留白 —— 没有独立的相框渲染器。**
>
> - 编辑器画布**可扩展**(照片 = 大画布里的子矩形,四周留白 + 底色)。文字/贴纸/logo 都是**图层**,可在**整张画布(含留白区)**上自由放置/缩放/旋转。
> - 由此用户诉求**自动满足**:新建文字 = 文字工具加图层;加贴纸 = 贴纸工具;签名 = 一张图片图层;相框 = 扩画布 + 放 logo/EXIF 图层(**预设生成**)。
> - **退役**当前烘焙式 `FrameStage` + `FrameEditOverlay`;交互统一走 `TextCanvas`。`SelectionHandles`/`selectionMath` 已抽出、继续共用;`buildFrameLayers`(模板→图层)复用,终点改成塞进真实图层栈。
> - 唯一硬骨头 = **可扩展画布的坐标改造**(下方 Phase 1);`editorState.canvas.pad` 已就位,`pad=0` 时与今天逐像素一致。

把**文字/贴纸编辑器**和**边框(frame)水印工具**合并成**一套** UI + 一套坐标 +
一套渲染:「**可扩展画布 + 图层**」。边框水印 = 在照片外扩出留白 + 在里面摆
文字/logo 图层。模板不再烘焙成一张图,而是**实例化成可编辑图层**丢进编辑器。

> 这是回到 [frame-watermark-plan.md](frame-watermark-plan.md) §1 的原始设计
> (「水印元素就是图层,套用时实例化,用户拖动后脱锚转 x/y」)。当前实现为了
> 快速出成果走了「烘焙一张成品 canvas」的捷径,本计划把它拉回统一模型。

---

## 现状:两套系统,一个渲染器

| | 文字/贴纸工具 | 边框工具 |
|---|---|---|
| 编辑面 | `TextCanvas`(交互:拖拽/选中/吸附),**铺在照片上**(`imageRect`) | `FrameStage`(纯展示:缩放/平移),铺在**扩展后的成品图**上 |
| 坐标 | 图层 `x/y` = **照片内**分数 | 元素锚点 → **输出画布**分数 |
| 位置 | 用户拖的绝对 x/y | 自适应锚点(region/h/v/inset),随比例/机型自动就位 |
| 内容 | 用户手打的静态文字 / 用户选的贴纸 | EXIF 占位符 + 自动匹配品牌 logo + 空值隐藏 |
| 渲染 | `drawLayersOnCanvas` | `renderFrame` → **同一个** `drawLayersOnCanvas` |

**关键事实(已在代码里验证):**
- 渲染器**早就是一套**:`render/drawLayers.js` 的 `drawLayersOnCanvas` 同时画
  `type:"text"` 和 `type:"sticker"`。
- `renderFrame` **已经**把模板元素转成图层:text 元素 → text 层,**logo 元素 →
  `type:"sticker"` 层**(见 `frameRender.js:306`,带 x/y/scale/rotation/opacity,
  和贴纸工具的图层同构),再交给 `drawLayersOnCanvas`。
- 也就是说「模板 → 图层 → 画」这条链**已经存在**,只是 `renderFrame` 把结果
  **烘焙进一张丢弃式 canvas**,而不是放进**可编辑的图层栈**。

**所以真正缺的只有两件事:**
1. **可扩展的编辑画布**:照片从"整个编辑面"变成"大画布里的一个子矩形",四周
   是留白条带 —— 让图层坐标系覆盖到照片外。
2. **模板 → 可编辑图层**:把 `renderFrame` 内部那套"元素转图层"的产物,**写进
   图层栈**(在输出画布坐标下),而不是烘焙。之后就是普通图层,可拖可改。

---

## 目标架构

### 一个编辑面,坐标 = 输出画布

- 引入**画布外壳**:`output = photo 子矩形 + 四周留白(pad) + 底色(bg)`。
- **编辑面 = 输出画布**;照片是其中一个**定位子矩形**。
- **图层 `x/y` = 输出画布分数**(不再是照片分数)。
- `pad = 0` 时 `output === photo`,**和今天的文字工具逐像素等价**(见「不破坏性」)。

### 图层承载一切

- `type:"text"`:静态文字(现状)**+ 可选动态内容**:`source:"{camera_model}"`
  → 渲染时从 EXIF 解析(为空则该层隐藏)。没 `source` 就是普通静态文字。
- `type:"sticker"`:用户贴纸(现状)**∪** 品牌/个人 logo(logo 就是一张可着色的
  图片层,`renderFrame` 现在就是这么发的)。
- 图层可标 `space:"canvas" | "photo"`(默认 canvas):决定加/减留白时**跟着画布**
  还是**跟着照片**移动(见「待定 3」)。

### 模板 = 图层生成器(不再是烘焙器)

「套用预设」= 一个纯函数:`(template, exif, photoRect) → { pad, bg, layers[] }`
- 复用现有 `frameTemplates.js` 数据 + `resolveAnchor` + 占位符解析 + logo 匹配。
- 产出:画布外壳(pad/bg)+ 一组**具体坐标的图层**(锚点已算成 output 分数)。
- **写进图层栈** → 之后用户随便拖/改/删(= 脱锚)。
- 换句话说:把 `renderFrame` 里"建 layers"那段抽出来复用,终点从"丢弃数组"改成
  "图层栈"。

### 工程文件(可重开编辑,单个 JSON,图片强依赖)

统一模型后,**整个编辑状态都是声明式的**,所以「工程文件」= 把它序列化成
**一个 JSON**,可重新打开继续编辑。**决策:图片强依赖路径,不内嵌**(不像 PS 把
像素嵌进文件)。

```jsonc
{
  "version": 1,
  "source": { "path": "/abs/or/relative/photo.jpg", "assetId": "…?" }, // 强依赖,按路径解析
  "transform": { "crop": {…}, "rotate": 0, "flip": {…}, "zoom": 1 },   // 复用 editorState
  "canvas":    { "pad": {…}, "bg": {…} },                              // 画布外壳
  "layers":    [ /* text(含动态 source) / sticker / logo,输出坐标 */ ] // 复用图层栈
}
```

- **强依赖 = 按路径引用,不嵌像素**:工程文件极小(纯 JSON)。打开时解析
  `source.path`;**找不到 → 提示重新定位**(Lightroom「查找缺失文件」式),不静默失败。
- **图层里的图片资源同理不内嵌**:贴纸(`stickerPath`)、用户 logo 都按 key/路径引用
  (它们在 catalog/用户目录里)。跨机器搬 JSON 需资源同在 —— 与"强依赖"立场一致。
- **动态内容随源刷新**:`source` 在,EXIF 可从源图重读,`{camera_model}` 等动态层
  重开时自动更新(也可缓存快照,见「待定 2」)。
- **工程文件 ≠ 模板**:
  - **工程** = 绑定某张照片(含 `source` + transform),重开这张图继续编辑。
  - **模板** = 照片无关(只有 `canvas` + `layers` 排布,内容是占位符),套到任意图上。
  - 两者都是同一套 `{canvas, layers}` 的序列化,区别只在带不带 `source`/是否占位符化。

### 渲染 / 导出:仍是一条路

- 预览:编辑面按 `output` 尺寸,画照片子矩形 + `drawLayersOnCanvas(layers)`。
- 导出:全分辨率 `output` canvas,同一套 `drawLayersOnCanvas`(全分辨率修复保留)。
- `renderFrame` 可**降级为纯导出渲染器**(吃 `{pad,bg,layers}`),或直接并进
  save 路径。烘焙式 `FrameStage` 逐步退役。

---

## 分阶段(每步可独立上线,不破坏现有工具)

> 铁律(沿用编辑器重构):**每个 PR 必须 `npm run e2e` 全绿**;`pad=0` 时行为与
> 今天逐像素一致;任何输出变化都是单独、可审查的提交,不是重构的副作用。

### Phase 1 — 可扩展画布(地基,pad=0 时零变化)
- `editorStateModel` 增 `canvas: { pad:{t,r,b,l}, bg }`(默认全 0 / 透明)。
- `imageMath` / `useEditorViewport`:`placement`/`imageRect` 从「照片铺满视口」改为
  「**输出矩形**铺满视口,照片是其中子矩形」。`pad=0` → 输出 === 照片,**几何不变**。
- `TextCanvas` + `pointFromClient`:坐标基准从 `imageRect` 换成**输出矩形**。
- 导出/save:有 pad 时先扩画布填底再画照片(现在 frame 的做法搬进主 save 路径)。
- **验收**:crop/text/sticker/save 的 golden e2e(03/06/18/19)全绿;pad 仍为 0,
  肉眼无变化。**这一步没有新 UI,纯几何内化。**

### Phase 2 — 留白/底色 UI + 图层可进留白区
- 文字工具面板加「留白(四边或统一)+ 底色 + 比例」控件(复用 frame 的 `比例`
  逻辑 + `SliderRow`)。
- 现在用户能：把照片周围扩白,并把文字/贴纸拖进白边。→ **手动边框水印已可用**。
- **验收**:扩白后拖一个文字到白边,导出坐标正确(新 e2e)。

### Phase 3 — 图层承载 logo + 动态内容
- 图片层统一:贴纸 ∪ logo(可着色);logo 匹配/着色逻辑从 `frameRender` 抽成
  可复用工具,产出一张贴纸层。
- text 层加 `source` 动态内容(EXIF 占位符解析,空则隐藏),`drawLayers` + save 支持。
- **验收**:一个 `{camera_model}` 动态文字层 + 一个品牌 logo 层,导出正确(新 e2e)。

### Phase 4 — 模板变「图层生成器」,frame 工具接入统一编辑器
- 抽 `templateToLayers(template, exif, photoRect) → {pad,bg,layers}`(复用
  `resolveAnchor` + 占位符 + logo 匹配)。
- 「套预设」= 调它 → 设 `canvas` + 把 layers 塞进图层栈(脱锚,之后可拖)。
- FramePanel 的预设网格 → 「套用生成图层」;`留白/比例/logo色` → 画布/图层属性。
- **与旧 frame 工具并行**,达到视觉 parity 前不删旧路径。`20-frame` e2e 迁到新路径。

### Phase 5 — 退役烘焙路径 + 打磨(已落地,2026-07)
- 已删 `FrameStage`/`FramePanel` 烘焙展示与 `useFrameTool` 的 compose/exportTo/
  overrides 管线;`renderFrame` 仅用于预设缩略图。导出全部走 `saveImage`。
- **几何决策更新**:crop 与 pad **组合**(不再互斥)——裁剪几何住在无 pad 空间
  (裁剪工具视图不显示边框),文字工具渲染**组合视图**:输出 = 裁剪内容 + 边距,
  基于裁剪内容短边;save 同基准(`getOutputDimensions(preview, pad, crop)`)。
  scrim 纳入 `canvas.scrim`,预览/导出共用 `drawScrim`/`scrimToCss`。
- 已做打磨:留白区吸附/对齐辅助线;深度遮罩对齐照片内容子矩形(预览+导出)。

### Phase 6(= 原计划 P4)— 工程文件 / 用户资产 / 自定义模板
- **工程文件**(单 JSON,图片强依赖路径,不内嵌):保存/打开 `{source, transform,
  canvas, layers}`;打开时解析 `source.path`,缺失则弹「重新定位」。**几乎白送**——
  统一后编辑状态本就是序列化数据,只差存/读 + relink UI。
- **另存为模板** = 同样序列化,但**去掉 `source`、内容占位符化**(照片无关)→
  `frame-templates.json`(用户目录,沿用 `ai-styles.json` 持久化)。注册表 = 内置 ∪ 用户。
- **用户导入 logo**(个人 + 品牌补充/替换)、**签名**(个人图片层 / 手写字体层)、
  **水印资料**(`{author}/{avatar}` 设置)。

---

## 不破坏性(怎么保证不砸现有功能)

- **`pad=0` 恒等**:Phase 1 后,无留白时输出矩形 === 照片矩形,图层输出分数 ===
  照片分数,几何/渲染/save 与今天逐像素相同。文字/贴纸/裁剪工具无感。
- **两条 undo 栈不动**:`canvas`(pad/bg)归入 transform 态(`editorState`,Cmd+Z),
  图层仍走 `useLayerHistory` —— 与现有分栈一致,不合并。
- **旧 frame 工具并行到 parity**:Phase 4 前 `renderFrame` 烘焙路径原样保留,
  `20-frame` 持续通过;新路径达标后再切、再退役。
- **全分辨率导出保留**:save 仍在 `sourceImage` 上按 `output` 尺寸渲染。
- **golden e2e 每步全绿**:03/06/18/19/20;新增覆盖(扩白坐标、动态层、模板生成层)。

---

## 待定(要你拍板)

1. **留白改变时,照片上的图层要不要跟着挪?**
   建议默认 `space:"canvas"`(图层钉在输出画布上,加留白时不动,自然进入白边);
   照片上的文字若想跟照片走,再给单层标 `space:"photo"`。v1 先只做 canvas。
2. **模板套用后是否保留"重新套用/更新 EXIF"能力?** 建议:动态层保留 `source`,
   套用后仍能随 EXIF 刷新;用户手改过的层标记 dirty 不覆盖。
3. **旧 frame 工具下线时机**:并行验证多久?是否保留一个"经典烘焙"开关兜底?
4. **工程文件放哪 / 什么扩展名?** 用户自选路径的 sidecar(`.afedit` JSON)?还是
   进 catalog 当版本栈的一员?`source.path` 存**绝对**还是**相对工程文件**(可搬运)?
   建议:可选路径的 `.afedit`,路径存绝对 + 相对两份,打开时先相对后绝对再 relink。

---

## 涉及文件(预估)

- 改:`state/editorStateModel.js`(+canvas)、`imageMath.js`(输出矩形几何)、
  `state/useEditorViewport.js`(placement/imageRect 基准)、`TextCanvas.jsx`(坐标基准)、
  `render/drawLayers.js`(动态内容/logo 层)、`render/saveImage.js`(扩画布合成)、
  `EditorOverlay.jsx`(工具合并)、`FramePanel.jsx` → 融入图层面板。
- 抽/复用:`frameRender.js` 的 `resolveAnchor` + 占位符 + logo 匹配 →
  `templateToLayers()`;`renderFrame` 降级为导出渲染器。
- 新:留白/底色控件、`templateToLayers.js`、(Phase 6)工程文件存/读 + relink IPC
  (`.afedit` JSON,路径引用不内嵌)、`frame-templates.json` IPC、logo 导入 IPC、
  水印资料设置。

## 风险

- **坐标基准迁移**是唯一"硬"的一步(Phase 1);靠 `pad=0` 恒等 + golden e2e 兜底。
- **手感**(吸附/旋转元素命中)是新交互面的打磨成本,放 Phase 5,不阻塞主线。
- **模板 parity**:新"生成图层"路径要和旧烘焙视觉一致,靠并行 + 逐模板比对。
