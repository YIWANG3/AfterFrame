# AfterFrame Web 版方案（拼图 / 加文字 / AI 重绘 BYOK）

日期：2026-08-22　状态：Phase 0 + Phase 1 骨架已实现（feat/web-shell，worktree ../media-resource-management-web）

**入口形态（2026-08-23 已定，取代下文 §1.3 的落地页设想）**：web 版不做自定义落地页，直接跑真实 `App.jsx`——打开即空 catalog（侧栏/工具栏/图库/Inspector 与桌面一致），用户通过 `+` 或拖拽导入照片（文件不上传，object URL 内存 catalog），之后编辑/拼图走桌面版原有入口（选中 → E / 右键菜单）。browser bridge 扮演"内存 catalog 后端"（`src/api/browser/bridge.js`，271 行）。已在 Chrome 全链路验证：导入 → 图库 → 编辑器（文字图层）→ 拼图（单张+批量）→ 导出下载，console 干净。

**已知待办（web 打磨项）**：
- [ ] capability 门控桌面残留 UI：右键菜单 Reveal in Finder / Refresh from Disk / Delete from Disk、导出 toast 的 "Show in Finder"、TextPanel 的 Scene Depth 区块、Settings 中桌面项
- [x] 编辑器首开布局竞态 + 窗口 resize 裁剪框不跟随——同一根源已修（useCropTool 在 placement 变化时对 cropRect/pan 做等比重映射，两端生效）
- [ ] 部署体积：地图懒加载 chunk（~22MB）应从 web 构建剔除或按需拆分
- [ ] Playwright e2e 补 web.html 目标（vite dev server + 浏览器，覆盖 StrictMode）
- [ ] Cloudflare Pages 部署 workflow（build:web → dist-web）
- [ ] 剩余 ~60 处桌面模块直连 window.mediaWorkspace 渐进收敛（不影响 web 主路径）

目标：把桌面版中可移植的功能放到纯静态 Web 端做推广引流。硬约束：

1. **零后端**——不部署任何我们控制的服务器进程。
2. **不重写组件**——Web 端只是一个"壳"，组件代码与桌面版共用同一份源码，桌面端的改动自动同步到 Web。

---

## 1. 总体架构：同一份组件 + 可替换 bridge

### 1.1 现状（对我们非常有利）

- renderer 本来就是标准 Web 栈：Vite 7 + React 19 + Tailwind，`vite build` 产物已是纯静态（`base: "./"`），且已支持多页入口（`frame-lab.html` 就是现成的纯浏览器页面，零 Electron）。
- Electron 默认开启 contextIsolation，renderer 没有 Node 权限，全部桌面能力走唯一的 preload bridge `window.mediaWorkspace`。
- 抽象层已存在：`src/api/client.js`（`bridge()` / `invoke()` / `__setBridgeForTests`）+ `src/api/index.js` facade，注释里已写明"组件永远不要直接碰 window.mediaWorkspace"。

### 1.2 唯一的欠账

facade 迁移只做了一半：全 renderer 还有约 **124 处直接 `window.mediaWorkspace` 调用**，且恰好集中在要移植的模块：

| 模块 | 直接调用数 |
|---|---|
| `AiRepaintPanel.jsx` | 15 |
| `CollageOverlay.jsx` | 10 |
| `StickerPanel.jsx` | 9 |
| `editor/render/saveImage.js` | 5 |
| editor state hooks | 各 2–6 |

### 1.3 目标形态

```
apps/desktop/src/            ← 组件唯一源码（不动、不复制）
  api/client.js              ← bridge() 按环境返回不同实现
  api/browser/               ← 新增：浏览器版 bridge 实现
      bridge.js              ←   文件、导出、设置、AI 任务的 Web 实现
  ...
apps/desktop/web.html        ← 新增：Web 入口（同 frame-lab.html 模式）
apps/desktop/src/web-main.jsx← 新增：Web 壳（安装 browser bridge → 挂载共用组件）
```

- Web 壳启动时检测 `window.mediaWorkspace` 不存在 → 调 `__setBridge(browserBridge)`（把现有 `__setBridgeForTests` 提升为正式注入口）。
- **能力标志（capability flags）**：bridge 增加 `api.capabilities`（如 `{ depth: false, stickerExtract: false, catalog: false, systemFonts: false }`），组件用它隐藏 Web 端不支持的 UI，而不是靠 `typeof window.mediaWorkspace` 到处判断。
- 组件代码今后只 import `api.*`。桌面端改功能 → Web 端 `vite build` 自然带上，无同步成本。

### 1.4 browser bridge 各能力的 Web 实现

| 桌面能力 | Web 实现 |
|---|---|
| `browseCollection` / `browseImages`（取图源） | `<input type=file multiple>` + 拖拽；`URL.createObjectURL`（不污染 canvas） |
| `ensureHdPreviews` / HD 预览链 | 整段删掉——Web 端直接读用户原文件，本来就是全分辨率 |
| `pickSavePath` / `saveImage`（落盘） | `<a download>`；批量导出用 JSZip 打包；渐进增强 File System Access API |
| EXIF 继承（saveFile.js 里 sharp 拷贝） | Phase 1 放弃；后续可用 exifr/piexifjs 在浏览器拷 JPEG EXIF |
| `quickRegister`（写回 catalog） | no-op 删掉 |
| `listSystemFonts` | 打包字体列表（`@fontsource` 已是 woff2）+ 渐进增强 `queryLocalFonts()`（Chromium） |
| `getFrameLogos` | SVG 当静态资源打包（frame-lab 已用 `import.meta.glob` 这么做） |
| settings / provider token | `localStorage`（key 默认仅存内存，见 §3） |
| repaint job 队列（SQLite） | 内存态 job + IndexedDB 历史（可选） |

---

## 2. 功能取舍

| 功能 | Web 版 | 依据 |
|---|---|---|
| 拼图（单张 + 批量） | ✅ Phase 1 | 渲染/导出 100% canvas；Electron 只在取图和落盘两个边界，全部收敛在 `CollageOverlay.jsx` |
| 文字 / 相框 / 水印 | ✅ Phase 2 | 渲染引擎（`drawLayers.js` / `frameRender.js` 等）已环境无关，frame-lab.html 是现成证明 |
| 景深文字遮挡 | ❌ 不移植 | CoreML DepthAnythingV2，macOS 独占；depth 是可选参数（`depthFieldCanvas == null` 自动跳过），剥离成本低。**在 Web UI 里放"桌面版专属"入口做转化** |
| 贴纸：贴合/导出 | ✅ 随 Phase 2 | 纯 canvas |
| 贴纸：自动抠图 | ❌ 暂缓 | macOS VisionKit + Swift；Web 端先只支持用户自己上传 PNG，后续可评估 wasm 分割模型 |
| AI 重绘 | ✅ Phase 3，**仅 Gemini** | 见 §3 |
| 手写字贴纸（AI 文生图） | 可选，随 Phase 3 | 与重绘同一 provider 栈，Gemini 链路通了以后成本很低 |

---

## 3. AI 重绘 BYOK：CORS 结论与信任设计

### 3.1 各 provider 浏览器直连可行性

桌面版重绘的 HTTP 调用在 Python sidecar（`ai_repaint.py`），**全部是手写 REST、没有用 SDK**，改写成浏览器 `fetch` 基本是一比一直译。但 CORS 是硬门槛：

| provider | 浏览器直连 | 说明 |
|---|---|---|
| Gemini（`generativelanguage.googleapis.com`） | ✅ 支持 CORS | 官方 JS SDK 本身就支持浏览器运行；`x-goog-api-key` header 认证 |
| OpenAI（`api.openai.com`） | ❌ 无 CORS | 官方有意禁止浏览器直连 |
| 火山方舟 ark | ❌ 无 CORS | |
| 即梦 jimeng | ❌ 且需 AK/SK 签名 | 签名逻辑放浏览器等于公开 secret，架构上就不成立 |
| openai_compatible（自填 base_url） | ⚠️ 取决于对方 | 可保留为高级选项；对方不开 CORS 就明确报错 |

**结论：Web 版只上 Gemini 一条链路。** 这不是妥协——桌面端实测本来就是 Gemini 效果最好（默认模型 `gemini-3-pro-image-preview`），而且"零后端 + key 不经过任何第三方"恰好只有 Gemini 能做到。

**（2026-08-23 调研更新）BYOK 版图比上表更宽，新增两个可行通道：**

| 通道 | 浏览器直连 | 能做什么 | 说明 |
|---|---|---|---|
| **OpenRouter**（`openrouter.ai/api/v1`） | ✅ 官方支持 CORS | **重绘 + 打标签都行**：图像生成/编辑走 chat completions + `modalities:["image","text"]`（含 nano banana / Gemini 3.1 Flash Image，即桌面 nanobanana 同款模型family），vision 打标走标准 chat（任意 vision 模型：Claude/GPT-4o/Gemini） | 杀手锏是 **OAuth PKCE**：用户点"连接 OpenRouter"一键授权拿 key，无需复制粘贴、无需后端、key 归用户账号管——BYOK 摩擦最低的方案 |
| **Anthropic**（`api.anthropic.com`） | ✅ 加 header `anthropic-dangerous-direct-browser-access: true` | 打标签（vision caption/tags）——桌面 annotation 的主 adapter 就是 Anthropic，请求形状原样可移植 | 官方明确说该通道就是为 BYOK/内部工具场景开的 |

修正后的结论：
- **重绘**：Gemini 直连 + OpenRouter（一个小 adapter，chat 格式返回图片）两条链路；OpenAI/ark/即梦直连仍不可行，但 OpenRouter 间接覆盖了多模型需求。
- **打标签（AI 标注）也可以上 web**：Anthropic 直连 + Gemini 直连 + OpenRouter 三条链路可选；桌面 sidecar 的 anthropic / openai_compatible 两个 adapter 直译成 fetch 即可（OpenRouter 就是 openai_compatible 形状）。标注数据落内存 catalog（随 P1 持久化落 IndexedDB），直接提升 web 端搜索质量。
- 推荐产品形态：BYOK 设置里给两个入口——"Gemini API Key"（手动填）+"连接 OpenRouter"（PKCE 一键），后者同时解锁重绘与标注的多模型。

### 3.2 不需要 Node 转发，且不转发反而是卖点

你担心的两个方案对比：

- **我们的 server 转发**：解决 CORS，但用户的 key 要过我们的服务器——信任问题你自己都指出来了，而且违背"零后端"。
- **浏览器直连 Gemini（推荐）**：key 只存在用户浏览器里，请求直达 Google。信任故事非常干净，可以写在 UI 上：
  1. "你的 key 只保存在本机浏览器，唯一的网络请求发往 `googleapis.com`——打开 DevTools Network 面板即可验证"；
  2. key 默认只存内存（sessionStorage），勾选"记住"才落 localStorage；
  3. （若仓库开源/部分开源）附源码链接。

将来如果一定要支持 OpenAI 等，再考虑 Cloudflare Worker 做无状态透明转发（Worker 代码开源、不记录 key），作为独立的 Phase 4 决策，不影响现在的架构。

### 3.3 一个诚实的提醒

Gemini API 在中国大陆不可直连。如果推广受众主要在小红书（大陆用户），BYOK 重绘对他们有"科学上网 + 有 Google key"两道门槛。拼图/加文字完全无此问题，所以**推广主打拼图和加文字，AI 重绘作为进阶彩蛋**更合理。

---

## 4. 托管方案

### 4.1 结论：Cloudflare Pages（官网可一并迁过去，也可先不动）

GitHub Pages 其实**能**跑这个 Web 应用（纯静态、无 SPA 路由需求），但有三个实际短板：

1. **大陆访问**：`*.github.io` 在大陆经常被墙/DNS 污染——对小红书引流是致命的；
2. **无自定义响应头**：以后若要上 wasm 多线程（如浏览器端抠图）需要 COOP/COEP header，GitHub Pages 给不了；
3. 带宽软限制 100GB/月，图片类工具页容易碰到。

Cloudflare Pages（免费档）：不限带宽、`_headers` 文件可自定义响应头、git push 自动构建、预览部署。注意 `*.pages.dev` 域名在大陆同样不稳，**务必绑自定义域名**（如 `app.afterframe.xxx`），走 Cloudflare 边缘后大陆一般可达（速度一般但可用）。若未来对大陆速度有硬要求，那是"备案 + 国内托管"的另一档决策，现在不必做。

### 4.2 部署形态

- 官网（`site/`，手写静态页）可以继续留在 GitHub Pages，也可以顺手一起迁 Cloudflare——两者共存也没问题，官网加个"在线试用"按钮指向 Web 应用即可。
- Web 应用部署：Cloudflare Pages 直连 GitHub 仓库，build 命令 `npm run build:web`（新增 script，跑 `vite build --config vite.web.config.js`），输出目录指向 `apps/desktop/dist-web`。
- 每个 PR 自动出 preview URL，正好配合"桌面组件改动自动同步 Web"的验证。

---

## 5. 实施阶段

**先专注电脑浏览器端**（已定）：Phase 0–3 均按桌面浏览器（Chrome/Edge/Safari/Firefox，≥1280px 视口）验收，移动端作为独立的 Phase 4 后置。

- **Phase 0（重构，桌面端也受益）**：把要移植模块里的直接 `window.mediaWorkspace` 调用收敛进 `src/api/` facade（优先 CollageOverlay、AiRepaintPanel、render/saveImage、editor hooks，约 40 处；其余 80 处可渐进）。加 `api.capabilities`。现有 vitest/e2e 保证不回归。
- **Phase 1（拼图上线）**：web.html 入口 + browser bridge（文件选择、blob 下载、JSZip 批量导出）+ Cloudflare Pages 部署 + 官网入口。拼图是最容易传播的功能，先打样整条链路。
- **Phase 2（加文字/相框/水印）**：隐藏 depth UI（capability flag），补字体列表与 EXIF 读取（exifr），贴纸仅支持上传 PNG。
- **Phase 3（AI 重绘 BYOK）**：`ai_repaint.py` 的 Gemini 请求直译成 fetch，key 管理 UI（默认不落盘），内存态 job。
- **Phase 4（移动端适配）**：见 §6。
- **贯穿**：Web 版所有"桌面版专属"能力（景深、RAW、人脸/语义搜索、catalog 管理）都留转化入口，这是推广的本意。
- **贯穿（为 Phase 4 留余地）**：桌面阶段写 browser bridge 时，导出、图片解码等实现留出按设备分叉的接口位（如 `bridge.export()` 内部判端），避免 Phase 4 变成重写。手机端访问先显示"建议用电脑浏览器打开"的提示页（功能不阻断）。

---

## 6. 移动端策略（Phase 4，后置）

已决策：先专注电脑浏览器端。移动端难点按严重程度分四层，届时逐层解决：

### 6.1 保存/出图链路（最影响体验，有标准解法）

- 手机用户预期"存到相册"，而 `<a download>` 在 iOS Safari 存到"文件"App，用户找不到；JSZip 批量下载在手机上不可用。
- 解法：移动端导出走 **Web Share API**（`navigator.share({ files })`）唤起系统分享面板（内有"存储图像"直达相册），降级为展示结果图 + 引导长按保存。批量导出改为逐张分享/长按。
- 含义：browser bridge 的导出实现需按设备分叉（桌面阶段留好接口位）。

### 6.2 内存与 canvas 上限（最隐蔽，失败是静默的）

- iOS Safari 对单 canvas 尺寸和总 canvas 内存有硬上限，超限**不报错、给空白画布**。批量拼图导出开多个 2000px+ offscreen canvas 的模式在 iPhone 上易踩线。
- 手机原片动辄 48MP，批量选几十张全分辨率解码会被系统杀标签页。
- 解法：导入即降采样（`createImageBitmap` + `resizeWidth`，封顶约 4096px），移动端限制导出分辨率与单批张数。属 bridge 层职责，不动组件。

### 6.3 交互与布局改造（工作量最大）

- 拖拽/缩放：pointer events 可响应 touch，但桌面滚轮缩放需补双指捏合；canvas 区域需 `touch-action: none` 防整页滚动/下拉刷新。
- 文字编辑是 contentEditable 所见即所得：虚拟键盘顶视口、选区手柄与 CSS transform 冲突等经典问题，需真机调教。
- **最大成本**：`TextPanel`（1600 行）、拼图侧边面板均为桌面多栏设计，手机需改底部抽屉（bottom sheet）。为保持"组件不分叉"，必须用响应式布局而非另写移动组件。

### 6.4 内嵌 webview 限制（可控）

- 微信/小红书 webview：下载被禁、`navigator.share` 不可用、存储可能被清。
- 小红书本不支持可点外链，用户必然"复制链接 → 系统浏览器打开"，避开了最糟环境；真正要做的只是微信内打开时的"点右上角 → 浏览器打开"引导浮层（成熟套路）。

### 6.5 小坑清单

- iPhone HEIC 走 `<input type=file>` 会被 iOS 自动转 JPEG（没问题）；Android 部分机型 HEIC 无法解码，需明确报错。
- EXIF 方向：现代浏览器 canvas 已自动处理，真机过一遍即可。
- `queryLocalFonts` 移动端不存在，仅打包字体（可接受）。
- AI 重绘在手机上输 key 体验差，维持桌面浏览器进阶功能定位。

### 6.6 届时的分级建议

拼图按"手机完整可用"标准做（降采样、Web Share、捏合手势、底部抽屉）；文字编辑器"桌面优先、手机能看能简单用"。

## 6.5 Web 完善路线（2026-08-23 排期，AI 最后）

- [x] **P0 EXIF（exifr）+ 视频/RAW 拒收提示**：相机/镜头/曝光/拍摄时间/GPS 进 image_metadata，Inspector/相框参数/按拍摄时间排序生效
- [x] **P1 IndexedDB 持久化**：资产记录 + 原图/512/2000 blob 全落库，懒恢复（ensureRestored），评分/删除写穿，刷新不丢
- [x] **P2 收藏夹**：完整 collections 面（sidecar 行形状），IndexedDB 持久化，删资产自动清成员
- [x] **P3 筛选器**：getFacetValues/searchFacet 内存聚合 + browseImages 全量 facet 过滤（相机/镜头/格式/ISO/光圈/焦距/日期/星级/构图），人脸/标注/人物筛选按 capability 隐藏
- [x] **P4 地图**：browseMapPoints（EXIF GPS，sidecar 行形状）+ filters.geo 视口过滤（含反子午线分割）；离线 topojson 地图原样可用。GPS 阳性路径待真实带 GPS 照片实测
- [x] **web e2e**：`npm run e2e:web`（playwright.web.config.js + e2e-web/，Chromium 驱动 web.html，dev/StrictMode），6 条冒烟 ~17s：启动+锁定项、导入+EXIF、持久化、编辑器保存下载、拼图导出下载、视频拒收
- [x] **AI BYOK**（bridge 直连 fetch，key 仅存内存）：重绘 = Gemini（ai_repaint.py 同款请求；结果登记为资产 + IndexedDB v2 repaints 历史；listAiModels 查真实模型表；ProviderModal 在 web 只出 Gemini）；标注 = Anthropic（官方浏览器 header）/ OpenAI-compatible（OpenRouter 填 base_url 即用），复刻 sidecar 的 prompt/JSON 规范化，含批量任务（ActivityCenter 进度）、tag 增删、搜索/筛选吃标注数据。**真实 Gemini 调用待用户 key 实测**；OpenRouter PKCE 一键连接为后续增强
- 暂缓：Compare/Lightbox 专项验证、真视频支持、Cloudflare Pages 部署 workflow、OpenRouter PKCE、贴纸上传 PNG

## 7. 风险与开口问题

1. **124 处直接调用的收敛**是唯一体力活，但方向早已确定（facade 注释已写明），属于还技术债。
2. 导出丢 EXIF（Phase 1 接受，后续 exifr 补）。
3. `queryLocalFonts` 仅 Chromium 且需授权；Safari/Firefox 用户只有打包字体——可接受。
4. 域名：目前尚无自定义域名（官网在 `yiwang3.github.io`）。购买域名可后置，但需知：绑定自定义域名之前，`github.io` 与 `pages.dev` 在大陆均不稳定，大陆可达性要等域名到位才真正解决。
5. Web 版要不要独立域名/品牌（`app.afterframe.xxx` vs 官网子路径）——推广口径问题，随购买域名一并决策。
