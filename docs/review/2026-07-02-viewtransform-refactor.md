# Review：viewTransform 重构（文字工具屏幕视图变换）

- **日期**：2026-07-02
- **分支**：feat/unified-canvas（未提交工作区）
- **范围**：独立屏幕视图变换 `viewTransform`（scale/x/y）、`fitViewTransformToStage`、文字工具拖拽平移输出视图、`clearFramePreset`、pad 变化时图层 remap、`useViewportWheel` 防抖提交
- **流程**：8 角度并行查找（约 42 候选）→ 去重 17 条 → 逐条对抗验证
- **结论**：12 CONFIRMED / 3 PLAUSIBLE / 2 REFUTED
- **修复状态**（2026-07-02 晚）：
  - 第一轮：findings 1、3、4、5、6、7、8、9、10 全部修复。核心手法：单一 basis-sync
    effect 让图层头始终按当前 (crop, pad) 基准重算；viewTransform 在 pad=0 恒 identity +
    开图/Apply 重置 + resize/旋转 refit。
  - 第二轮：**finding 2 全部修复** —— `useEditorHistory` 重写为单一时间线（每条历史存
    `{state, layers}`），Cmd+Z 与两个面板撤销按钮统一；预设 apply/clear 为单条原子撤销；
    图层拖拽不再每帧入史；面板滑块/输入按签名去抖合并成一条（Phase 2b）。退役 useLayerHistory。
  - 编辑器 e2e 全绿：03/04/06/07/13/18/20/21 + 19（含新增 Unified undo/redo 三例），
    共 43 例；vite build 通过。

## 总体评价

架构方向正确，验证确认：

- ✅ 保存/导出路径只读 raw crop/pad/layers，不读 viewTransform
- ✅ 拖拽平移是纯视图操作，且是新增能力而非替换编辑语义（重构前照片热区拖拽在文字模式本来就不可达）；视图平移下照片/图层/边框整体移动，屏幕始终是输出的忠实渲染
- ⚠️ 滚轮仍走 imageZoom/imageOffset（编辑状态）机制，e2e 明确期待，属有意设计；但由此形成"拖拽=纯视图、滚轮=编辑状态"双机制，其中横向滚动会平移裁剪、静默改变导出像素（见 P-1）

两条主线问题：

1. **viewTransform 是命令式状态、靠手工同步**（findings 5/6/7 及小项）。
   深层修法：改为派生值，`viewTransform === null` 意为"自动 fit"（渲染时从
   outputView 现算），只在用户主动平移后存具体值。
2. **图层基准换算不完整**（findings 1/2/3/4）。深层修法：统一的
   `convertLayerBasis(layer, fromGeom, toGeom)`（位置 + 尺寸字段）供所有
   路径共用；图层历史快照附带基准标记（pad + crop），恢复时按需换算。

## Findings（按严重程度）

### 1. [x] CONFIRMED · remapLayersAcrossPad 不换算尺寸字段
**修复**：`imageMath.convertLayersBasis` 统一换算位置 + 尺寸；`basisWidth`（pad=0 → 全图宽，
pad>0 → 合成输出宽）给出 k=oldBasisW/newBasisW，`rescaleLayerSize` 按 saveImage 同款字段
（fontSize/shadowBlur/shadowX/shadowY/strokeWidth，sticker.scale）缩放。remapLayersAcrossPad
退役。


`imageMath.js` remapLayersAcrossPad — 只重映射 x/y；fontSize/scale/shadowBlur
等是基准宽度相对的（TextCanvas 按 `imageRect.width/1920`、drawLayers 按
`canvasWidth/1920` 缩放），注释"已照片相对"与实现矛盾。数例：2000×1000 横图、
无裁剪、fontSize=100，pad 0→0.2 后基准宽 2000→2400，文字相对照片放大 20%。
saveImage 的 `k=fullW/contentW` 重缩放与 useFrameTool 的 padZero `×c.width`
换算都证明尺寸依赖基准。修法：remap 时同步换算（× oldBasisW/newBasisW），
或抽统一 convertLayerBasis。

### 2. [x] CONFIRMED · 图层历史不追踪坐标基准 + 预设双栈半撤销
**修复（第二轮：统一历史栈）**：`useEditorHistory` 重写为**单一时间线**，每个历史条目同时存
`{ state, layers }`。由此：
- Cmd+Z 和两个面板（裁剪/文字）的撤销按钮都走同一个 undo/redo，不再是「Cmd+Z 撤 transform、
  面板撤 layer」的错位双栈。
- 图层快照天然与其提交时的 transform 基准配对，撤销时一起恢复 → 「快照不带基准」问题消失
  （无需额外基准标记）。
- 预设 apply/clear 改为 applyState + applyLayers + 单次 commitCurrent，**一条原子历史**，
  单次撤销同时回退边距 + 预设图层。
- basis-sync effect 仍负责撤销/重做「之后」按真实 crop+pad 重算（修 review 的陈旧 crop 换算）。
- 顺带修图层拖拽洪泛：画布移动/旋转/缩放拖拽期间只 applyLayers（实时、不入史），松手才
  commitCurrent 落一条（原先每 pointermove 一条）。
- **文字面板滑块/输入洪泛（Phase 2b）也修了**：`commitLayersCoalesced(next, signature)`
  —— 面板编辑实时生效但按「目标图层 + 字段」签名去抖合并成一条历史，换字段/换动作/撤销
  会先 flush 上一段。fontSize/透明度/描边/阴影/内边距滑块，以及文字输入连打，都各自一条
  undo。TextPanel 只在 `update()` 一个入口接入，未逐个改子组件（PaintRow/滑块等）。
- 退役 useLayerHistory.js。新增 e2e：19-editor-layers「Unified undo/redo」三例
  （全局撤销加文字 / 预设原子撤销 / 面板连编合并成一条）。
- **修复统一栈的一个回归**（实测发现）：基准重算原先走 `replaceCurrentLayers`（原地改
  历史头条目的 layers），但统一栈里那条头是「改动前」的已提交条目，被覆盖成新基准坐标 →
  反复撤销/重做边距时文字每次上移一点。改为：重算只 applyLayers（实时），recordState 把
  重算结果落进「新」条目；只有当头条目状态 == 当前已提交状态时才用 `applyLayersSyncingHead`
  同步头（如 commitAspect 之后）；撤销/重做后把 layerBasisRef 指向还原状态的基准，让 effect
  不再二次换算。e2e：21-canvas-pad「repeated undo/redo … does not drift」。


`useLayerHistory.js` replaceCurrent 只重写栈顶，其余快照保留提交时基准，
layerUndo/layerRedo 原样恢复 → 跨 pad 的 redo 图层跳位。预设 apply/clear 写
两条独立 undo 栈（recordState + commitLayers）：Cmd+Z 全局绑 handleUndo
（transform 栈）、面板 Undo 绑 layerUndo（图层栈），清除预设后 Cmd+Z 只恢复
边框不恢复图层（空白边框条），面板 Undo 反之。另 handleUndo 的 remap 用
渲染闭包里撤销前的 normalizedCrop，撤销步骤同时改了 cropRect 时换算错误。

### 3. [x] CONFIRMED · 裁剪变化不触发图层 remap
**修复**：basis-sync effect 依赖 `[normalizedCrop, editorState.canvas, transformedPreview]`，
pad 激活时 crop/比例变化（commitAspect / 拖拽结束 / 撤销重做，均汇入 editorState）都会把图层头
从旧 (crop,pad) 换到新 (crop,pad)。convertLayersBasis 的 from/to 各带真实 crop+pad。pad=0 时
换算恒为 no-op（图层是全图分数，与 crop 无关），不产生多余重算。


pad>0 时图层基准 = 裁剪内容 + 边距，基准同时依赖 crop；但
remapLayersAcrossPad 只在 pad 变化路径调用，且只接收单一 crop 参数。
带边框时切裁剪工具改裁剪/比例（无任何守卫阻止），图层不重映射 →
预设文字飘出信息条。修法：remap 签名改为 (oldPad, oldCrop, newPad,
newCrop)，裁剪提交路径（commitAspect / 拖拽结束）与 undo/redo 传入真实新旧
crop。

### 4. [x] CONFIRMED · 裁剪工具 Apply 遗漏基准处理
**修复**：handleApply 里在换源之前用 `bakeLayersIntoCrop(head, oldTP, normalized, oldPad)`
把图层从旧合成基准拉进裁剪子区（→ 新全图 pad=0 分数）并按新全图宽（= 裁剪内容宽）重算尺寸；
随后 `setViewTransform(IDENTITY)`、`layerBasisRef = {crop:null, pad0}`、replaceCurrentLayers。
边框语义上被裁剪 Apply 展平（只烘裁剪，不合成边距），故 pad 归零是有意的。


`EditorOverlay.jsx` handleApply — syncHistory + applyState(BASE_STATE)，
图层存活（不调 layerReset）但不 remap 出 pad 基准 → 图层跳位；
viewTransform 不重置（只有 handleTextApply 重置）→ 残留适配变换；
边框/预设被无提示归零。

### 5. [x] CONFIRMED · viewTransform 无边界也无恢复路径
**修复**：beginOutputViewPan 的 onMove 加 clampPan（输出至少 PAN_MIN_VISIBLE=80px 留在舞台内）；
pan hotspot 双击 → resetViewToFit（恢复路径）；viewportSize/旋转变化 effect 里 refit；undo/redo
跨 pad 变化时 refit。（viewTransform 仍是命令式状态，未做「派生化 null=auto-fit」的深层重构。）


平移 onMove 直写 setViewTransform 无钳制，可把画布甩出屏幕；无 fit 按钮、
无双击重置、滚轮不碰 viewTransform，唯一恢复途径是改一次边距间接触发
resetViewToFit。undo/redo 改 pad 后只 remap 图层不 refit；窗口 resize /
旋转照片后 outputView 重排但 viewTransform 保持旧 stage 的适配值。

### 6. [x] CONFIRMED · resetViewToFit 在 pad→0 时锚定含 imageZoom 的全图矩形
**修复**：getFitTransformForState 在 `!hasPad(state.canvas?.pad)` 时直接返回 IDENTITY——pad=0
时输出即照片、crop 空间 placement 已居中，屏幕视图变换应中性，不再把 imageZoom 折进 fit。


getOutputView 的 pad=0 分支返回 rect=imageRect（含 state.imageZoom）。
imageZoom=3 时清除边框/边距归零 → fit scale≈0.31，用户正看的裁剪内容缩到
舞台 1/3；而其余 pad=0 入口（初始、切工具、Apply）都用 IDENTITY，
imageZoom=1 时 fit 恰好等于 identity 才掩盖了不一致。修法：pad→0 直接重置
IDENTITY（或锚定 contentRect 而非全图 photoRect）。

### 7. [x] CONFIRMED · 打开新照片不重置 viewTransform
**修复**：open/sourcePath 重置 effect 里补 `setViewTransform(IDENTITY)` + `layerBasisRef` 归位。


open/sourcePath 重置 effect 重置了工具/历史/图层但没有 setViewTransform；
EditorOverlay 跨照片常驻挂载（App.jsx open={!!editorItem}）。照片 A 平移/
套预设后切照片 B，文字视图无故偏移/缩小，直到碰一次边距。

### 8. [x] CONFIRMED · 滚轮 160ms 防抖提交与撤销/拖拽竞态
**修复**：useViewportWheel 暴露 flushCommit/cancelCommit。handleUndo/handleRedo 先 flush（把待
提交的滚轮编辑落成独立历史条目再移动索引）；beginCropResize/beginRotate/beginImagePan 先 cancel
（定时器不再拖拽中途插入中间态）。


滚轮只 applyState 不入历史，提交延迟 160ms；handleUndo 不 flush 待处理
提交 → 窗口内 Cmd+Z 从上一个已记录头回退，一次吞掉滚轮编辑 + 多退一步；
beginCropResize/beginRotate/beginImagePan 不取消定时器 → 拖拽中途定时器
触发 commitCurrent 插入中间态历史条目。（撤销后定时器晚到的场景已被
equalsHead 去重挡住。）修法：暴露 flush/cancel，undo/redo 前 flush、
拖拽开始时 cancel。

### 9. [x] CONFIRMED · 文字模式滚轮每 tick 全量重建预设缩略图
**修复**：cropKey 量化到 4 位小数（挡住缩放 ULP 漂移）+ thumbs 重建放进 200ms setTimeout 防抖，
cleanup 里 clearTimeout，滚轮/平移期间的连续变化只结算最后一帧，最贵的全图复制不再每 tick 执行。


`useFrameTool.js` thumbs effect 键 cropKey = 未量化的
JSON.stringify(normalizedCrop)；滚轮每 tick applyState → normalizedCrop
重算，平移真改分数、缩放因 ULP 漂移几乎每次变 key → 每 tick 全分辨率
buildBaseCanvas + 全部模板 renderFrame + JPEG 编码；alive 标志在 logo 已
缓存时形同虚设（微任务在 cleanup 前排空），最贵的全图复制在任何检查前执行。
修法：cropKey 量化 ~4 位小数 + 只在提交态变化时重建或加防抖。

### 10. [x] CONFIRMED · 深度遮罩缓存按几何 key 抖动 + 无限增长
**修复**：两级缓存——alphaCache 只按 zPosition 存（几何无关的全场像素循环，复用共享
canvasHelpers.buildDepthAlphaMask，顺带修 P-2 分叉）；urlCache 的 useMemo deps 纳入 geomKey，
几何变化换新 Map、旧全尺寸 base64 被丢弃。几何变化只做廉价 compose（drawImage）。


`TextCanvas.jsx` getMaskUrl — geomKey 由 contentRect 分数 toFixed(4) 拼成，
边距滑块每 tick 变 key → 全量 getImageData + 20 万像素循环 + toDataURL；
maskCache 的 useMemo deps 不含 geomKey，旧几何的全尺寸 base64 永不逐出。
修法：两级缓存（alpha 画布只按 zPosition 缓存，几何变化只重做廉价 compose），
geomKey 纳入 useMemo deps。

## 已确认但未进前 10 的小项

- [x] CONFIRMED · `beginOutputViewPan` 缺 pointercancel / setPointerCapture /
  卸载清理 → **修复**：捕获 event.currentTarget，setPointerCapture(pointerId)，
  window 上加 pointercancel（与 pointerup 同一 onUp），onUp 里 releasePointerCapture
  + 移除 move/up/cancel 监听。
- [~] CONFIRMED · 非组合分支 freeAngle 旋转支点用未变换的 cropCenter →
  **部分修复**：review 的主场景「清除预设残留 fit 变换」随 F6（pad=0 恒 identity）
  消失。残留边角：pad=0 文字模式下先视图平移再显示 freeAngle≠0 的照片仍会支点错位
  （freeAngle 只在 crop 工具可编辑，此时无 viewTransform），低频，未单独处理。
- [x] 清理 · 死掉的 wheelDisabledRef 管线 → **修复**：EditorOverlay/useCropTool/
  useViewportWheel 三处 disabledRef 全删。
- [x] 清理 · clearFramePreset 与 applyFramePreset 尾段大段重复 → **修复**：合成
  `setCanvasPreset(res)`（res=null 即 clear）。handleUndo/handleRedo 仍各自短小
  （只差 raw undo/redo 调用），未强行包装。
- [ ] 清理 · 两个语义不同的 padEquals（EditorOverlay 归一化缺省边 vs
  editorStateModel 原样比较）——实际 state.pad 恒为四边齐全（cloneState 保证），
  仅 setPad 后门传部分边时可能分叉，罕见，暂留。
- [ ] 清理 · backdoor effect 依赖爆炸（含每渲染新建的 screenOutputView）——
  纯测试后门，暂留。
- [x] 清理 · getOutputView 未使用的 viewportSize 参数 → **修复**：删参 + 更新
  两处调用（useEditorViewport / getFitTransformForState）。裁剪投影两分支重复 +
  getFitTransformForState 重导派生链暂留。

## PLAUSIBLE（设计取舍 / 潜伏项）

- **P-1** 滚轮=编辑状态、拖拽=纯视图的双机制：有意设计（e2e 期待
  outputRect 变化 + historyLength+1），但横向滚动平移裁剪会静默改导出像素，
  且缩放仅在 MAX/min zoom 钳制边缘影响裁剪。建议明确取舍或统一。
- **P-2** TextCanvas.getMaskUrl 内联 alpha 循环与 buildDepthAlphaMask 分叉 →
  **已修复**：getMaskUrl 现直接复用 buildDepthAlphaMask，预览遮罩与保存路径逐像素
  一致（钳制也随之统一）。compose 块与 saveImage.buildOutputDepthMask 的重复暂留。
- **P-3** backdoor 重注册"测试窗口期看不到 API"的竞态不成立（React cleanup
  与 re-run 同任务内完成，evaluate 无法插入），但每帧 churn 真实。

## REFUTED（已排除，附理由）

- **画布白屏竞态**（draw effect deps 改为 [transformedPreview,
  !!composedView] 丢失 imageRect 重触发）：getStageBounds 对 viewportSize
  取 Math.max(200,...)，placement 在 transformedPreview 非空时必然非空，
  imageRect 与 preview 同步翻转，声称的窗口不可达。
- **pad=0 平移语义破坏 WYSIWYG**：重构前照片热区拖拽在文字模式本来就不可达
  （TextCanvas z-15 覆盖层拦截），新热区是新增视图能力而非替换编辑语义；
  视图平移下屏幕仍是输出的忠实渲染。

## 第三轮：图层坐标基准无关化（根治漂移类 bug）

**动机**：之前图层坐标存的是「当前基准 (crop, pad) 相对值」，同一份数据换基准就变——所以每次
pad/crop 变都要主动换算 + `layerBasisRef` 记账，漏一处就漂移（第二轮那个回归就是典型）。

**改法**：图层**只存全图坐标**（位置=全图分数、尺寸=全图相对），基准相关坐标改为**渲染时派生**：
- `imageMath`：新增 `layersToDisplay` / `layersFromDisplay`（复用 convertLayersBasis，存储基准=全图）。
- `EditorOverlay`：`displayLayers = useMemo(layersToDisplay(...))` 传给 TextCanvas/TextPanel；改动回调
  用 `layersFromDisplay` 折回存储。**删除** `layerBasisRef`、basis-sync effect、`applyLayersSyncingHead`、
  `applyCanvasPad` 的图层重算、`setCanvasPreset` 的换算、undo/redo 的 `basisForState` 记账。
  applyCanvasPad 现在完全不碰图层。
- `saveImage`：`mapLayer` 合成为**单一**「全图 → (裁剪+边距)输出」映射，pad=0/pad>0 不再分叉。
- `useFrameTool`：预设生成末尾 `layersFromDisplay`，产出全图坐标（并补全 pad=0 的 shadowX/Y/strokeWidth 换算）。
- 退役 `remapLayersAcrossPad`；`useEditorHistory` 不再需要 `replaceCurrentLayers`/`applyLayersSyncingHead`。

**结果**：撤销/重做只还原数据、**永不重算** → 漂移从根上不可能。undo/redo 的 `layerBasisRef` 记账、
basis-sync effect 全部消失，代码显著简化。getState 增加 `displayLayers`（派生坐标）供测试断言。
e2e：21-canvas-pad「centered / drift」改为断言「存储 y 恒为 0.5、派生 y = 0.5/1.3 且循环稳定」。
编辑器 e2e 全绿（03/04/06/07/13/18/19/20/21，44 例）；build 通过。

## 遗留（转后续）

- **viewTransform 派生化**（null=auto-fit）：本轮做的是命令式重置/边界/refit，
  未改为派生值；派生化能进一步消除手工同步面。
- pad=0 文字模式「视图平移 + freeAngle≠0」旋转支点边角（见小项）。
- padEquals 语义统一、backdoor effect 回归 ref、getFitTransformForState 复用
  useEditorViewport 派生链、compose/buildOutputDepthMask 去重（清理项）。
- **P-1**（滚轮=编辑状态、拖拽=纯视图双机制，横向滚动静默改导出像素）：设计取舍，
  未动，待产品定夺是否统一。

## 本轮修复摘要

- 新增 `imageMath.convertLayersBasis / basisWidth / rescaleLayerSize /
  bakeLayersIntoCrop`；退役 remapLayersAcrossPad。
- EditorOverlay 单一 basis-sync effect（`[normalizedCrop, editorState.canvas,
  transformedPreview]`）+ `layerBasisRef`，pad 滑块走 applyCanvasPad 即时换算、
  其余（crop/undo/redo）走 effect 兜底。
- viewTransform：pad=0 恒 identity、开图/两种 Apply 重置、pan 钳制 + 双击复位、
  resize/旋转 refit、undo/redo 跨 pad refit。
- useViewportWheel flush/cancel；useFrameTool cropKey 量化 + 200ms 防抖；
  TextCanvas 两级深度遮罩缓存 + 复用 buildDepthAlphaMask。
- 清理：删 wheelDisabledRef、合成 setCanvasPreset、删 getOutputView 冗余参。
- 验证：编辑器 e2e 03/04/06/07/13/18/19/20/21 共 40 例全绿；vite build 通过。
