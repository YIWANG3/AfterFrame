# 相框 / EXIF 水印 — 实施计划

目标:给照片加**漂亮**的边框 / 相机信息水印(对标 OPPO 哈苏、徕卡水印大师、
sspai 那类),核心是**内置丰富、精致的预设**,并支持单图编辑与批量出图。

## 已锁定的决策

- **品牌 logo**(2026-06 修订):前提是 **AfterFrame = 免费 / 开源 / 个人作品**,
  按 simple-icons 的成熟先例 **内置一套精选品牌 logo**,放在**单独、可一键删除的
  目录** `apps/desktop/frame-logos/`(配 `TRADEMARKS.md` 商标声明 +
  收到持有者要求即移除)。同时保留**用户导入自有 logo** + **原创标记**。措辞避免
  暗示官方授权/背书。一旦商业化或做大,回退到「不随包 + 用户导入」。见下「品牌
  Logo 资产」。
  > 之前为"商业产品"定的"默认不内置"已作废 —— 因为(a)用户自备包命名/导入不可控、
  > UX 差;(b)免费个人开源项目执法概率低,且有 simple-icons 等先例。
- **v1 范围**:编辑器内「边框」工具 **+** 批量加边框,一起做。
- **底色**:v1 先做纯色 / 黑白 / 取色;**模糊照片做底**放到 v2。

## 设计原则(保证「漂亮」)

- 留白、字号、logo 尺寸全部**按图像尺寸的比例**计算,任意分辨率都协调。
- 排版克制:每个家族固定一套字号阶梯与对齐;光学对齐而非数学对齐。
- 字体精选(见「字体」),EXIF 用等宽/grotesque,编辑风可配衬线。
- logo 用矢量并在渲染时**着色**(同一资产出黑/白/品牌色三态)。
- 每个预设带**黑/白一键切换**。

---

## 架构

### 1. 模板 = 画布外壳 + 一组锚定元素(元素即图层)

> 核心决定(2026-06 修订):**水印元素就是图层,复用现有文字/图层系统**
> (`textState.js` 的 layer 已自带 `x/y`、`opacity`、`rotation`、字体、颜色、
> 渐变、描边、背景药丸、阴影)。**不另造渲染器,不用 blocks/regions。**

一个**模板(template)**= 声明式 JSON,描述两件事:
1. **画布外壳**:四周留白(按比例)+ 底色(纯色/取色/v2 模糊)。
2. **一组元素**:套用时**实例化成 layers**,之后用户像调任何图层一样调它们。

```jsonc
{
  "id": "hasselblad-bar", "name": "哈苏 信息条", "family": "bar",
  "canvas": { "pad": { "bottom": 0.135 }, "bg": { "type": "solid", "color": "#fff" } },
  "elements": [
    { "type": "text", "content": "{camera_model}",
      "anchor": { "region": "bottom", "h": "left",  "v": "center", "inset": 0.05 },
      "style":  { "font": "grotesk", "weight": 600, "size": 0.30, "color": "#141414" } },
    { "type": "text", "content": "{lens_model}",
      "anchor": { "region": "bottom", "h": "left",  "v": "center", "inset": 0.05, "row": 1 },
      "style":  { "size": 0.22, "color": "#8a8a8a" } },
    { "type": "logo", "brand": "{exif_brand}", "variant": "symbol",
      "anchor": { "region": "bottom", "h": "right", "v": "top",    "inset": 0.05 },
      "style":  { "size": 0.5 } },
    { "type": "exif", "fields": ["focal","aperture","shutter","iso"], "dot": "#ff6a00",
      "anchor": { "region": "bottom", "h": "right", "v": "bottom", "inset": 0.05 },
      "style":  { "size": 0.22, "color": "#6e6e6e" } }
  ]
}
```

- **元素类型**:`text`(含占位符)/ `exif` / `logo` / `shape`(点/线)。
  - `text`/`exif` → `type:"text"` 图层,内容是占位符,白嫖全部文字控件。
  - `logo` → 新增 `type:"logo"` 图层(brand + variant + 着色)。
- **锚点(唯一的新机制)**:`{ region, h, v, inset, row }` 按比例定位,任意长宽比/
  字段开关都不错位;套用时算成 `x/y`。**用户拖动后转为自由 `x/y`**(脱锚)。
- **比例尺寸**:`style.size` 相对条带/画布高,任意分辨率自适应。
- **占位符**:`{camera_model} {lens_model} {focal} {aperture} {shutter} {iso}
  {date} {author} {avatar} {exif_brand}`,由 EXIF + 用户资料填充;无值的元素整块隐藏。

### 1b. 用户保存自己的模板

- 用户套模板后任意微调(增删元素、改位置/透明度/字体/留白/底色/logo 变体),
  可「**另存为模板**」= 把当前画布外壳 + 图层栈**序列化回上面这段 JSON**。
- 存到用户数据目录 `frame-templates.json`(沿用 `ai-styles.json` 持久化模式)。
- 预设库 = 内置模板(我们策展)∪ 用户模板。可重命名/删除/复制。
- 用户**不手写 JSON**——全靠 UI 操作 + 另存。

### 2. 渲染引擎(纯函数,canvas,复用 drawLayers)

`src/components/editor/render/frameRender.js`
`renderFramedCanvas({ photo, exif, template, profile, assets }) -> canvas`

- 由比例算 padding → 扩画布 → 填底 → 画照片(可选内圆角/描边)→
  把模板元素实例化成 layers(锚点 → x/y,占位符 → 文本)→
  **调现有 `render/drawLayers.js` 渲染图层**(text/logo)。
- EXIF 文本复用 `src/utils/format.js`;logo 着色:矢量 → 离屏 canvas 画轮廓 →
  `source-in` 填色(色彩锁定变体不着色)。
- 新增的活很小:`logo` 图层类型 + 渲染、占位符解析、锚点定位、画布外壳。

**统一一条渲染路径**:实时预览、单图导出、批量,全部走这个函数 + drawLayers,
保证所见即所得、字体/logo 只加载一次、文字工具与水印共用一套引擎。

### 3. 接入点

- **编辑器**:`EditorOverlay` 第 5 个工具「边框」(crop/text/sticker/ai 之后)。
  预设网格(实时缩略图)+ 微调(留白厚度、黑白、字段开关、字号、导入 logo)。
  导出走 `saveImage` 的 canvas 合成分支(边框扩画布,本就不能走 sharp 快路径)。
- **批量**:右键选中多张 → 选预设 → 导出文件夹。复用 `renderFramedCanvas`,
  逐张全分辨率渲染;用 **OffscreenCanvas + Worker** 避免卡 UI,进度走现有
  JobDock 模式。

---

## 品牌 Logo 资产(你要收集的一块)

### 一个品牌 = 一套变体(多版本 logo)

品牌 ≠ 单文件。每个品牌有**多种变体**:
- **形态**:`symbol`(图标如 `H`)/ `wordmark`(字标 `HASSELBLAD`)/
  `lockup`(图标+字标,横 `h`/竖 `v`)。
- **颜色**:大多**渲染时着色**(单色 SVG → 黑/白/品牌色,一份三态);
  **色彩锁定**的除外(如徕卡红点)→ 变体标 `colorLocked:true` 不着色。

### 格式与规范

- **单色 SVG**(矢量,透明底,黑色填充,单一 path/group);色彩锁定的保留原色。
- viewBox 归一化、四周**光学等距**内边距。
- 布局:**每品牌一个子目录**,变体文件 `<brand>/<variant>.svg`
  (`hasselblad/symbol.svg`、`hasselblad/wordmark.svg`、`hasselblad/lockup-h.svg`)。
- `logos.json` manifest(品牌 → 变体数组,`file` 相对 frame-logos 根):
  ```jsonc
  { "id":"hasselblad", "name":"Hasselblad", "accent":"#ff6a00", "tags":["camera"],
    "variants":[
      { "id":"symbol", "kind":"symbol",   "file":"hasselblad/symbol.svg",   "aspect":1.0 },
      { "id":"word",   "kind":"wordmark", "file":"hasselblad/wordmark.svg",  "aspect":5.4 },
      { "id":"lockup", "kind":"lockup", "orientation":"h", "file":"hasselblad/lockup-h.svg", "aspect":3.0 }
    ] }
  ```

### 自动选择 + 用户切换(限同品牌)

- **品牌**由 EXIF `make` **自动匹配**(`logos.json` 的 `match` 表),绑定到 logo 元素,
  用户不用挑品牌(也防止张冠李戴)。
- **每个 logo 位**,用户可在 UI 里**切换该品牌的不同变体**(symbol/word/lockup)
  和颜色——**但仅限当前照片所属品牌**,不能跨品牌乱选(水印要反映真实机型)。
- 匹配不到品牌 → 回退到 EXIF 机型文字 + 原创标记,或用户默认 logo。

### 目录与加载(外部资源文件,不打进 bundle)

logo **不走 Vite 打包**,而是**外部资源文件**,运行时从磁盘读——沿用项目既有
`extraResources` + `process.resourcesPath` 约定(和 `native/`、`sidecar/` 同款)。

- **内置品牌 logo**:源在 `apps/desktop/frame-logos/`,经 electron-builder
  `extraResources`(已加 `{from:"frame-logos", to:"frame-logos"}`)ship 到安装包的
  `resources/frame-logos/`。**装好后是普通文件,可不重打包就删/换**(takedown 友好)。
- **加载**:主进程解析基目录(dev = 仓库内 `frame-logos/`;packaged =
  `process.resourcesPath/frame-logos/`),读文件经 `media://` 给渲染层 canvas。
- **用户导入 logo**:用户数据目录(如 `Application Support/afterframe/frame-logos/`),
  同 `logos.json` 结构。**registry = 内置 ∪ 用户导入,同一套加载逻辑**(都是扫目录→读
  文件),用户项同 id 覆盖内置(可用官方版替换我们打包的)。
- 模板里用 `"logo":{ "brand":"{exif_brand}", "variant":"symbol" }`。

> 好处:① 可秒删/秒换、不用重打包(强化 takedown 能力);② 内置与用户 logo 共用
> 一条加载路径,不区分"打包 import"与"磁盘文件";③ 不臃肿 JS bundle。

### 用户导入 logo(两类,支持方式不同)

**A. 个人 logo**(自己的工作室标 / 手写签名章)
- **不绑任何相机品牌**,是用户自己的标识(对应参考里的「个人水印」)。
- 作为一个**可自由放置的 logo 元素源**:放哪、多大、透明度随便调(自己的东西,
  无"张冠李戴"合规顾虑)。给占位符 `{author_logo}` 用。

**B. 品牌 logo 的补充 / 替换**
- 挂到**某个相机品牌**(更好的变体,或我们没内置的品牌)。
- 导入时指定:**归到哪个品牌 + 变体类型(symbol/wordmark/lockup)+ 是否 colorLocked**。
- 进入**该品牌的变体池**,在"按位切换变体"里与内置变体并列(同品牌内,规则不变)。
- 同 `<brand>/<variant>` id 则**覆盖**内置(用户用自己的官方版替换我们打包的)。

**导入流程**
- 入口:Frame 工具「导入 logo」/ 设置 → 水印资料。
- 选文件 → 选用途(个人 / 归某品牌)→ 主进程**拷贝进用户数据目录 + 写 manifest**
  → 渲染经 `media://` 读取(同 stickers/预览机制)。
- **格式**:单色 SVG 最佳(可着色);彩色 SVG / PNG → 当 `colorLocked` 原样用
  (光栅图不可靠改色),PNG 需透明底;导入时校验类型/大小/透明通道。

**logo 元素的来源(UI 三挡)**
1. **自动品牌 logo**(EXIF 匹配,同品牌内切变体——内置 + 用户导入的都在)
2. **我的 logo**(个人,自由放置)
3. **原创标记**(内置通用)

设置 → 「水印资料」管理「我的 logo」列表(导入/重命名/删除)+ 设默认个人 logo。

### ⚠️ 授权(已定:内置 + 可随时删)

前提 = **免费 / 开源 / 个人**。决定**内置精选品牌 logo**,但严格隔离 + 可一键移除:

- **单独目录** `apps/desktop/frame-logos/`——所有品牌 logo 只在这里,
  删掉这个目录即可干净移除全部品牌资产(代码回退到 EXIF 文字 + 原创标记)。
- 目录内含 **`TRADEMARKS.md`**:声明所有 logo 归各自商标持有者所有,本项目不主张
  权利、不暗示授权/合作,**收到任何持有者要求即移除**。
- logo 尽量接近原始形态(可单色化,勿魔改造型);**措辞避免"官方/背书"**
  (叫「相机信息水印」,非「官方哈苏皮肤」)。
- **保留**用户导入自有 logo + 原创标记两条路。
- 现实依据:simple-icons 等开源项目长期内置数千品牌商标,靠"披露 + 下架响应"
  存活;免费个人项目执法概率低。**风险仍在**——一旦商业化/做大,撤包回退。

> 不利点须知:(a) 我们会改色/缩放/压图,削弱"原样使用"保护;(b) 开源 = logo
> 永久躺在公开 repo、可检索可 fork。所以"单独目录 + 可秒删"很重要。

### 收集清单(供你准备,优先级从高到低)

- 相机:Hasselblad、Leica、Sony / Sony α、Canon、Nikon、Fujifilm、
  Panasonic Lumix、OM System(Olympus)、Pentax / Ricoh(GR)、Sigma、
  Phase One、DJI、Insta360、GoPro。
- 镜头/光学:Zeiss、Sigma、Tamron、Voigtländer。
- 手机影像:Apple iPhone、OPPO、vivo、Xiaomi、Huawei、Samsung、
  Google Pixel、OnePlus、Honor。
- 联名(很受欢迎):OPPO×Hasselblad、Xiaomi/Huawei×Leica、vivo×Zeiss。
- 自有原创:AfterFrame 主标、光圈标记、"Shot on" 字标。

每个最好准备**单色 SVG + 透明底**;位图 logo 退而求其次用高分辨率 PNG(@3x)。

---

## 字体(你要收集的另一块)

### 用途映射

| 用途 | 风格 | 免费可打包推荐(SIL OFL) | 常见商业等价(需授权) |
|---|---|---|---|
| EXIF 参数 | 等宽 / 中性 grotesk | Geist Mono、JetBrains Mono、IBM Plex Mono | Helvetica Neue、Univers |
| 机型 / 标题 | 中性 grotesk | Inter、Geist、Manrope、Archivo | Helvetica Neue |
| 疏排小标(留白/编辑) | 几何 / 窄体 | Space Grotesk、Archivo（tracking） | Futura |
| 编辑风衬线 | 优雅衬线 | Fraunces、Source Serif、IBM Plex Serif | Times、GT Sectra |
| 拍立得手写 | 手写 / 衬线 | Caveat、Fraunces italic | — |
| 中文 | 黑体 / 宋体 | Noto Sans/Serif CJK SC、思源黑/宋 | 苹方、华康 |

> 建议:**优先用 OFL 开源字体**(可随包、零授权成本、效果足够好),把
> 商业字体作为「用户自行安装后可选」。注意 Helvetica/Univers/Futura 等
> 打包进分发程序需要桌面 App 授权,有成本与法务风险。

### 加载与渲染

- 打包 `.woff2`/`.ttf` 于 `apps/desktop/src/assets/frame-fonts/`。
- 渲染前用 **FontFace API** `await font.load()` 再画 canvas(否则 canvas
  会静默回退到系统字体,水印字体不生效)。
- 统一走 canvas 渲染路径,字体只在渲染线程加载一次,批量也用同一份,
  避免 sharp / fontconfig 的字体不一致问题。
- 字体清单 `fonts.json`:id → {family, file, weight, fallback, cjk?}。
- 可选优化:EXIF 多为数字 + 少量符号,可子集化(subset)减小体积。
- 回退链:指定字体 → 同类系统字体 → CJK 回退。

---

## 预设库(v1 目标 ~20 个)

按家族 × 变体组织(JSON 数据):

1. **厂牌信息条** bar:白 / 黑;有 logo / 无 logo;紧凑 / 宽松。
2. **美术馆留白** margin:细 / 中 / 厚;白 / 黑;有 caption / 纯净。
3. **拍立得** polaroid:经典白 / 彩色边;有标题 / 纯白底。
4. **杂志编辑风** editorial:衬线标题 + EXIF;顶题 / 底题。
5. **胶片风** filmstrip:齿孔 + 卷标 + 帧号;彩色 / 黑白。
6. **极简角标** corner:仅一角小字 EXIF,极轻量。

用户可基于内置预设**另存为自定义预设**(`frame-presets.json`,用户目录)。

### 官方参考样式 — 哈苏 Phocus Mobile(可直接还原为「哈苏家族」)

哈苏 Phocus Mobile 自带官方相框,4 个代表布局值得 1:1 参考:

1. **图内叠加**(无边框):底部居中 `H` 图标 + `Aperture | f/9.0  Shutter | 16s  ISO | 64`(全词标签 + 竖线,白字压图)。
2. **白色信息条**:左 `Hasselblad CFV 100C/907X`(粗)+ `XCD 3,5-4,5 / 35-75`(灰,镜头),右 `H` 图标。
3. **全留白 + 顶题**:顶部居中斜体衬线字标 `HASSELBLAD`(字距拉开),底部居中 `Aperture  f/9.0  Shutter  16s  ISO  64`。
4. **白边居中**:底部居中 `H` 图标 + 机型 + 镜头。

由此固化的几条引擎能力:
- `exif` 部件支持三种风格:`label|value`(`Aperture | f/9.0`)、`label value`、`value-only`。
- `{lens_model}` 单独成行、原样带出(含欧洲逗号小数 `3,5-4,5`)。
- 厂牌**图标**(`H`)与**斜体衬线 wordmark**(`HASSELBLAD`)是两种独立部件。

> 其余相机厂(佳能/尼康/索尼/富士)官方软件无装饰相框,徕卡 FOTOS 亦无
> (M11-P 是 CAI 防伪数字水印,非装饰)。哈苏是少数例外。

### 签名 + 微调控件(照搬 Phocus 的交互)

- **手写签名**部件:图内或信息条内放置,支持**左/中/右对齐**、**黑/白配色**切换、编辑。
- 预设选择走**横向缩略图条**(实时预览),与编辑器预设网格一致。

---

## 用户资料(个人签名)

设置里新增「水印资料」:姓名 `{author}`、头像 `{avatar}`、默认 logo。
存入 app settings(沿用 `readAppSettings`/`updateAppSettings`),供占位符自动带入。

---

## 分阶段实施

- **P0 资产准备**(你 + 我):收集 logo(单色 SVG)、确定字体集(OFL 优先)、
  落 manifest(`logos.json` / `fonts.json`)。
- **P1 引擎 + 模板数据**:`frameRender.js`(复用 `drawLayers`)+ logo 图层类型 +
  锚点定位 + 占位符填充 + 字体加载 + 内置模板(~20)。先用开发预览页校审美。
- **P2 编辑器「边框」工具**:第 5 工具、模板缩略图条 + 实时预览 + 元素开关 +
  逐元素调(位置/透明度/字体,复用文字图层控件)+ logo 变体切换(限同品牌),
  接 `saveImage` 导出。
- **P3 批量加边框**:右键选中 → 选模板 → 导出文件夹;OffscreenCanvas + Worker +
  JobDock 进度。
- **P4 用户资料 + 自定义模板**:水印资料设置、**另存为模板**(序列化图层栈 →
  `frame-templates.json`)、用户导入 logo。
- **P5(v2)**:模糊照片做底、Live 实况水印、更多家族。

## 涉及文件(预估)

- 新增:`render/frameRender.js`、`editor/frameTemplates.js`(内置模板)、
  `components/editor/FramePanel.jsx`、`frame-logos/*`(含 `logos.json` +
  TRADEMARKS)、`assets/frame-fonts/*` + `fonts.json`、用户 `frame-templates.json`、
  批量入口(Gallery 右键 + electron 批量导出 IPC)。
- 改动:`EditorOverlay.jsx`(工具槽)、`render/drawLayers.js`(+`logo` 图层类型)、
  `layerStack.js`/`textState.js`(+锚点字段、logo 图层)、`render/saveImage.js`
  (边框合成)、设置(水印资料)、i18n(en/zh)。

## 风险 / 注意

- **商标授权**:已定内置品牌 logo,隔离在单独目录 + TRADEMARKS 声明 + 可秒删
  (见「⚠️ 授权」)。商业化前需重新评估/找法务。
- **字体授权**:优先 OFL;商业字体需桌面授权。
- **批量性能**:全分辨率多图 canvas 渲染要走 Worker + 进度,避免卡 UI / 爆内存。
- **EXIF 缺失**:占位符无值时整块隐藏、不留空位(布局自适应)。
- **字体未加载就绘制**:必须 `await FontFace.load()` 后再渲染。
- **编辑器 item 的 EXIF**:确认 `item` 带 camera/lens/exif 字段,缺则在打开
  编辑器时补取 detail。

## 待你拍板

1. 字体:接受「OFL 开源字体为主、商业字体用户自备」吗?还是你已购商业字体要打包?
2. 批量导出命名与目录规则(`<原名>_framed.jpg` ? 导到子目录?覆盖确认?)。
3. v1 预设数量目标(~20 够吗,还是先精做 ~10)。

> ~~品牌 logo 分发~~ 已定:内置 + 单独目录 + 可秒删(见「⚠️ 授权」)。
