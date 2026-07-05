# Review：相框功能集成到文字编辑工具（存档，已全部修复）

- **日期**：2026-07-02（早于同日的 viewtransform-refactor review）
- **分支**：feat/unified-canvas
- **范围**：BorderControls、边框渐变背景、margin/crop 交互、frameRender/saveImage、useFrameTool
- **流程**：8 角度并行查找（约 39 候选）→ 14 条逐条验证（12 CONFIRMED / 2 PLAUSIBLE）→ 报告 10 条
- **状态**：10 条 findings + 若干小项全部修复，编辑器相关 e2e（03/04/06/07/13/18/19/20/21）全绿

## Findings（全部已修复 ✔）

1. [x] CONFIRMED · generatePresetLayers 以裁剪画布为基准而预览/导出用全图 →
   **修复**：统一 crop+pad 组合几何（输出 = 裁剪内容 + 边距），三方共用
   getOutputDimensions(preview, pad, crop)
2. [x] CONFIRMED · overlay 预设丢失 scrim 与亮度自适应文字色 → **修复**：scrim
   纳入 canvas.scrim 状态（预览 CSS / 导出 drawScrim），生成时画采样画布恢复
   自适应色
3. [x] CONFIRMED · logo 注册表 IPC 竞态静默丢 logo 层 → **修复**：
   generatePresetLayers await loadLogos() 同一 promise
4. [x] CONFIRMED · linked 边距显示 max(四边) 且一步摧毁非对称预设 →
   **修复**：非对称 pad 自动解除联动、输入框永远显示真实值
5. [x] CONFIRMED · 深度遮罩被拉伸到整个含边距画布 → **修复**：白底 + 深度场
   裁剪子区域映射到照片内容矩形（预览 TextCanvas.depthMaskGeom + 导出
   buildOutputDepthMask 两侧）
6. [x] PLAUSIBLE · pad>0 时裁剪被忽略（当时是有意设计但 UX 突兀）→
   **修复**：升级为 crop+pad 真组合，裁剪几何住无 pad 空间
7. [x] CONFIRMED · 退役烘焙渲染 effect 在文字工具热路径全量空跑 + 缩略图/EXIF
   每次切工具重跑 → **修复**：useFrameTool 重写，删 compose/exportTo/overrides
   管线，thumbs 按内容 key 缓存、EXIF 按 asset_id 取一次
8. [x] CONFIRMED · placement 依赖 canvas 对象标识每帧抖动 + 拖拽中途 re-clamp
   注入 → **修复**：placement 回归 pad-free（[viewportSize, transformedPreview]）
9. [x] CONFIRMED · NumberDragInput blur 无变化也 commit + record() 不去重 →
   **修复**：blur 值变化守卫 + record/commitCurrent 用 stateEquals 与栈顶去重
10. [x] CONFIRMED · 硬编码中文 tooltip「收起/展开」→ **修复**：border.collapse/
    expand i18n 键（en + zh-CN）

## 小项（已修复 ✔）

- [x] hasPad 判断 5 处复制粘贴 → 提取 imageMath.hasPad
- [x] saveImage 与 getOutputDimensions 取整不一致（可差 1px）→ 共用同一函数
- [x] 色板忽略渐变不透明度 → 共享 bgToCss（canvasHelpers）
- [x] EditorOverlay 死的 tool==='frame' panelMeta 分支 + overlay.tools.frame /
  border.applyHint 孤儿 i18n 键
- [x] SliderRow 无人使用的 onCommit prop
- [x] pad=0 + 裁剪导出时 fontSize/阴影/描边未按裁剪基准换算（mapLayer 补 k 缩放）

## 遗留（转后续）

- 文字工具"应用"按钮在边框激活时烘焙基准仍是旧语义（已挂后续任务
  task_8b845a30：让它复用 saveImage 合成或禁用）
- 旧烘焙导出 e2e 后门（exportFrame/setFrameAspect）与比例外扩功能随死代码下线
