# Sticker — Feature Spec

## 一句话定位

两件事，分两个工具：

1. **Sticker 工具（新）** — 只管**做 sticker**：抠主体 + 加白边 + 存 PNG 到本地库。**完全不涉及 canvas / 图层**。
2. **Text 工具（已有）** — 在 LAYERS 区加 ➕ Sticker 入口，从 sticker 库挑一张 PNG 作为 image layer，跟现有的 ➕ Text 平起平坐。

这样切干净：
- Sticker 工具 = "内容生产"（产出物：PNG + catalog 条目）
- Text 工具 = "内容消费"（消费 sticker PNG / 消费文字内容，统一图层模型）

## 数据模型

`layers[]` 已有 `type: "text"`，新增 `type: "sticker"`：

```js
// Sticker layer
{
  id: "sticker-7",
  type: "sticker",
  stickerPath: "/Users/.../stickers/abc123.png",  // baked PNG with outline already
  naturalWidth: 1024,
  naturalHeight: 1024,
  // 共用 text 那套位置/变换/深度字段
  x: 0.5, y: 0.5,           // 0..1, normalized to image
  scale: 1.0,
  rotation: 0,
  opacity: 100,
  zPosition: 1.0,           // depth occlusion
  shadow: false, shadowX, shadowY, shadowBlur, shadowColor, shadowOpacity,
}
```

Sticker 是已经烘焙好白边的 PNG，作为 layer 时只控制位置/大小/旋转/透明度/阴影/深度 —— 描边那些参数早就固化在文件里了，编辑器层面不可变（要改就重做一张）。

## Sticker 工具的 UI

工具栏增加第 4 个 icon。点击进入 Sticker 工具后，右侧面板有两个 segmented tab：

```
┌── TEXT — STICKER ──────────────────────────┐
│  ╭─ Library ─╮ ╭─── Create new ───╮         │
│  │ (active)  │ │                  │         │
│  ╰───────────╯ ╰──────────────────╯         │
│                                              │
│  [搜索框]                                    │
│                                              │
│  Recent · Tokyo trip                         │
│  ┌──┐ ┌──┐ ┌──┐ ┌──┐                         │
│  │🗻│ │🏮│ │🌸│ │⛩│                          │
│  └──┘ └──┘ └──┘ └──┘                         │
│                                              │
│  Yesterday                                   │
│  ┌──┐ ┌──┐                                   │
│  │🍜│ │🚄│                                   │
│  └──┘ └──┘                                   │
│                                              │
└──────────────────────────────────────────────┘
```

### Tab 1 · Library（默认 tab） — 库管理

不在这里加图层。这个 tab 只用于**浏览和管理**：
- 搜索框
- 分组 grid：Recent / Yesterday / 按来源照片名
- 点击 sticker → 大图预览 + 元信息（来源、提取时间、尺寸）
- 右键 → Delete / Star / 在原图中查看 / Show in Finder

要把 sticker 加到当前图：切到 **Text 工具 → LAYERS → ➕ Sticker** 选库里的一张。

### Tab 2 · Create new

```
┌────────────────────────────────────────────┐
│  SOURCE                                     │
│  ◉ Use current image                        │
│  ○ Pick another...                          │
│                                              │
│  [Detect subjects]  ← 调 swift              │
│                                              │
│  DETECTED (3)                               │
│  ┌──┐ ┌──┐ ┌──┐                             │
│  │👤│ │👤│ │🐱│  ← 多主体每个一张缩略       │
│  └──┘ └──┘ └──┘                             │
│       (selected)                             │
│                                              │
│  PREVIEW                                    │
│  ┌────────────────┐                          │
│  │   [white-out]  │                          │
│  │     subject    │  ← 实时预览描边效果      │
│  │                │                          │
│  └────────────────┘                          │
│                                              │
│  Outline   ●———————————   8 px              │
│  Color     [⬜][⚫][🟡]                       │
│  Shadow    ⊙  on/off                        │
│                                              │
│  [✓ Save & add to canvas]                   │
│                                              │
└────────────────────────────────────────────┘
```

**操作流**：
1. 默认选 `Use current image` → 自动跑一次 `Detect subjects`
2. swift 返回 N 个主体 mask → 缩略图列出（多主体场景就让用户挑要哪个）
3. 选定后预览区实时 render 描边效果（前端 SVG `feMorphology` + composite，所见即所得）
4. 只调 **outline**（width / color）。**不在这里调阴影** —— 阴影是图层级效果，跨场景不一定一致，统一交给 Sticker layer 的 Inspector
5. 点 `Save sticker`（唯一动作）：
   - 把当前描边效果烘焙成 PNG（前端 canvas，drawImage + 描边滤镜 + toBlob）
   - 写到 `~/Library/Application Support/AfterFrame/stickers/<sha1>.png`
   - 入 catalog `stickers` 表
   - tab 自动切回 Library，新做的 sticker 在最前面 + toast 提示
   - **不**自动加到 canvas。要用就切 Text 工具去加

**烘焙的内容只包含**：原 alpha 抠图 + 描边。不烘焙阴影、不烘焙旋转、不烘焙缩放 —— 那些都是 Text 工具里图层的 runtime 属性。

## 主体抠图（Swift 部分）

新 CLI `extract-sticker.swift`：

```bash
extract-sticker <input-image> <output-dir>
# Outputs:
#   <output-dir>/instance_0.png   alpha-only PNG, full image bbox
#   <output-dir>/instance_1.png
#   ...
#   <output-dir>/manifest.json    [{ index, bbox: [x,y,w,h] }]
```

用 `VNGenerateForegroundInstanceMaskRequest`（iOS 17 / macOS 14+）。多主体每个 instance 单独输出。

输出**不带描边**，纯 alpha。描边交给前端做（这样用户能实时调）。

## 渲染（前端 canvas/SVG）

**预览** （Create tab 的 Preview 区域）：
```jsx
<svg>
  <defs>
    <filter id="outline">
      <!-- 1. 把 alpha 拓宽 outline 像素 -->
      <feMorphology operator="dilate" radius={outlineWidth} in="SourceAlpha" result="dilated"/>
      <!-- 2. 染成描边色 -->
      <feFlood floodColor={outlineColor}/>
      <feComposite in2="dilated" operator="in" result="stroke"/>
      <!-- 3. 把原图叠在描边上面 -->
      <feMerge>
        <feMergeNode in="stroke"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <image href={instanceUrl} filter="url(#outline)" />
</svg>
```

**烘焙** (Save 时)：
- 创建 offscreen canvas，尺寸 = 原图 bbox
- 先 drawImage 在临时 canvas 上做 alpha 拓宽（imageData manipulation 或 canvas filter）
- 填描边色
- 再叠原 instance png
- toBlob → 写盘

**编辑器使用** (Library 拖入 / 现做加入)：
- 是个普通 `<img src={stickerPath}>` 已含描边
- 拖 / 缩放 / 旋转 / 深度遮罩 全部复用 TextLayerEl 那套（提一个公共 `<TransformableLayer>` HOC 出来）

## Text 工具的入口（消费侧）

TextPanel 的 LAYERS section 头部有一个 ➕ T 按钮（加文字图层）。改成 **两个**按钮：

```
LAYERS                         [➕ T]  [➕ Sticker]
─────────────────────────────────
T   Matterhorn                ⋮   ←  既有
🩹  hashi (sticker)            ⋮   ←  新增类型
T   SPRING · 2026             ⋮
```

- 点 `➕ Sticker` → 弹一个轻量级的 sticker picker（modal 或 popover），从库里挑一张
- 选中后作为 `type: "sticker"` 加到 layers[]，居中放置，自动选中
- StickerLayerEl 渲染 + 选中态 + 8 把手 / 旋转把手 全部复用现有 Text 那套 transform 框架

## 跟现有功能整合

| 现有 | 整合点 |
|---|---|
| 工具栏 | 新增 Sticker icon（Crop / Text / AI Repaint / **Sticker**） |
| TextPanel | LAYERS 区加 ➕ Sticker 按钮，弹库 picker |
| layers[] | 新 type: "sticker"，跟 text layer 共存 |
| TextCanvas | 拆 `<TransformableLayer>` 抽出公共框架，TextLayerEl + StickerLayerEl 各实现自己的 inner 渲染 |
| 深度遮罩 | wrapper 上的 mask 不变，sticker 自动支持 zPosition |
| 导出（EditorOverlay 的 ctx.drawImage 循环） | 加分支处理 sticker layer：drawImage(stickerImg, ...) |
| Catalog | sticker 入库，可搜索 |
| Toast | "Sticker saved" / "No subject detected" |

## 分阶段实现

| Phase | 内容 | 估时 |
|---|---|---|
| **P1** | Swift `extract-sticker.swift` + IPC + Sticker 工具空壳（只有 Library tab，假数据） | 2-3 天 |
| **P2** | Library 真数据：catalog `stickers` 表 + grid + 拖入 canvas 作为 sticker layer | 2-3 天 |
| **P3** | sticker layer 渲染：transform handles / depth mask / 导出端 drawImage | 2-3 天 |
| **P4** | Create new tab：调 swift / 多 instance 选择 / 描边预览 / 烘焙 PNG / 入库 | 3-4 天 |

总计 **~2 周**到 v1。

## 风险点

1. **VisionKit 可用性** —— macOS 14+ 才有 `VNGenerateForegroundInstanceMaskRequest`。最低支持版本要查。
2. **多主体时 UI 混乱** —— 一张合影 8 个人，缩略图怎么排不让用户晕？v1 限制最多展示前 6 个，更多需要滚动。
3. **抠图边缘质量** —— Apple 的 mask 在头发 / 半透明物体上一般，白描边正好遮丑，但极端情况（毛玻璃、火焰）还是穿帮。v1 接受。
4. **描边性能** —— SVG `feMorphology` 大半径 + 高分辨率图实时渲染可能卡。预览阶段可以缩到 800px 跑，烘焙时用全分辨率。
5. **导出端体积** —— 大尺寸 sticker PNG 在 ctx.drawImage 时 OK，跟现有 text 渲染开销同级。

## 不做

- v1 不做：sticker 内置素材库 / 云端同步 / sticker 之间互相组合 / 商店 / 会员素材
- 永远不做：自动 AI 构图（自动决定 sticker 摆哪），让用户来摆
