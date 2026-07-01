<p align="center">
  <img src="docs/assets/logo.png" width="140" alt="AfterFrame logo" />
</p>

# AfterFrame

[English](README.md) | **简体中文**

一个本地优先的摄影工作台，用于浏览、编辑和管理大规模照片库。

AfterFrame 面向拥有大量导出图片的摄影师，提供快速的可视化浏览、整理、裁剪、文字叠加和 AI 风格迁移功能 — 全部在一个应用内完成。

## 下载

从 [Releases](../../releases) 下载最新 `.dmg`。

> 仅支持 macOS（Apple Silicon）。已使用 Apple Developer ID 签名。若某个版本尚未公证，macOS 首次打开时可能会提示 — 右键点选 **打开**，或前往系统设置 → 隐私与安全性中允许打开。

![AfterFrame — 浏览与检查](docs/assets/browse-zh.png)

## 目录

- [功能](#功能)
  - [素材库管理](#素材库管理)
  - [浏览与整理](#浏览与整理)
  - [搜索与筛选](#搜索与筛选)
  - [编辑](#编辑)
  - [视频](#视频)
  - [AI 重绘（BYOK）](#ai-重绘byok)
  - [AI 自动标注（BYOK）](#ai-自动标注byok)
  - [Agent 原生（MCP）](#agent-原生mcp)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [自定义](#自定义)
- [构建方式](#构建方式)

## 功能

### 素材库管理
AfterFrame 的核心 —— 基于 Catalog 的工作流，原图始终留在硬盘上，其余一切都被索引、保持快速。

- 基于 Catalog 的工作流 — 每个项目一个 `.afcatalog`
- 导入流水线：自动提取元数据与生成预览
- 两档预览：始终生成快速的 512px 缩略图，另有可选的 2000px 高清预览（设置 → 图库 开关，默认关闭以节省磁盘）
- 可选的 RAW 源文件索引与按文件名匹配
- HEIC / HEIF 支持 — 原图按需转码为 JPEG，iPhone 照片在 Lightbox、编辑器、拼图中以全分辨率正常显示
- 统一后台活动面板：导入、预览、标注、AI 任务的进度集中显示，随时可取消
- 中英双语界面（English / 简体中文）—— 在 设置 → 通用 中实时切换
- 本地优先：文件始终保留在你的硬盘上，不会上传

![浏览与检查面板](docs/assets/browse-inspector.png)

### 浏览与整理
- 网格、瓦片、对齐、瀑布流四种布局模式
- 按导入时间、拍摄时间、评分或文件名排序
- 智能集合和手动文件夹
- 完整元数据检查器：EXIF、相机、镜头、曝光、日期
- 星级评分（自动导入 Lightroom XMP 评分）
- 虚拟滚动画廊，流畅处理 10,000+ 张图片

![灯箱浏览](docs/assets/lightbox.png)

### 搜索与筛选
- 全文搜索：跨 文件名、相机/镜头、以及 AI 标注（描述、识别文字/OCR、标签）—— 按照片"内容"找图
- Facet 筛选条：相机、镜头、ISO / 光圈 / 焦距 区间、拍摄日期范围、星级评分 —— 实时组合
- 标签筛选：在检查面板点任意标签,或从可搜索的标签列表中选（服务端搜索,支持数千标签）

### 编辑
- **裁剪**：预设比例、旋转、翻转

![裁剪编辑器](docs/assets/editor-crop.png)

- **文字叠加**：系统字体、纯色/渐变填充、描边、阴影、背景、透明度、自动吸附居中线

![文字编辑器](docs/assets/editor-text.png)

- **深度感知文字**：本地 CoreML 深度推理（Depth Anything V2），让文字像 iPhone 锁屏壁纸一样落在主体后面。支持选择自定义模型，偏好设置自动持久化

![深度感知文字](docs/assets/editor-text-depth.png)

- **贴纸**：一键从任意照片中抠出主体（macOS 14+ 使用 VisionKit），存入按 catalog 隔离的贴纸库，可选描边与阴影；再把贴纸作为图层放到其他照片上，深度、不透明度、旋转控件与文字图层共用一套

![贴纸库](docs/assets/sticker-library.png)

- **拼图**：8 种布局模板，可调间距/内边距/圆角，自定义背景色，支持高分辨率导出。每个格子可独立平移与缩放，提供居中吸附辅助线、精细缩放滑条以及触控板捏合联动 —— 拖动调整构图，将一张图拖到另一格上即可交换两图

![拼图](docs/assets/collage.png)

- **相框**：由 EXIF 驱动的品牌相机水印相框。提供 20+ 预设（底栏、双 logo、竖排侧边条），以哈苏、索尼、佳能、尼康、徕卡、富士、松下 Lumix、理光的真实品牌 logo 与配色渲染，另有一套简洁通用版。自适应明暗对比、logo 颜色选择（原色 / 黑 / 白 / 灰 / 金）、文字与留白缩放，并可按原图分辨率导出

![相框 · 哈苏字标](docs/assets/frame-hasselblad.png)

![相框 · 索尼底栏](docs/assets/frame-sony.png)

![相框 · 品牌预设](docs/assets/frame-presets.png)

### 视频
- 视频与照片一同索引 —— 导入时探测时长、分辨率与编码，并自动生成封面帧
- 画廊卡片显示封面与时长徽章；鼠标悬停即可在关键帧胶片条上拖动预览，无需打开
- 在灯箱中完整播放，自定义播放器（播放/暂停、进度条、音量、全屏、空格键）
- 对系统无法原生解码的编码（如 10-bit HEVC）自动按需转出 H.264 代理，保证仍能流畅播放

### AI 重绘（BYOK）
自带 API Key 模式。AfterFrame 不内置也不代理任何 AI 服务 — 你自行配置 API 密钥，所有请求从你的电脑直连 API。

- 支持 Gemini、GPT Image、即梦，或任意 OpenAI 兼容端点——在 设置 → AI Repaint 中管理服务商与各自的默认模型
- 25 个内置风格提示词（油画、动漫、水彩、水墨、概念艺术等）
- 并排和上下对比的前后效果预览
- 每次重绘的版本历史记录

![AI 重绘 — 前后对比](docs/assets/ai-repaint-compare.png)

### AI 自动标注（BYOK）
用你自己的 LLM 服务（Anthropic、OpenAI,或任意 OpenAI 兼容端点）为照片生成描述、标签和地点推测。与 AI 重绘一样,请求从你的电脑直连 API。

- 可标注单张、多选、整个文件夹,或全库未标注资产 —— 都是带实时进度的后台任务
- 可选「导入时自动标注」
- 中英双语标签,标签数量与描述长度可配置
- 手动编辑每张图的标签 —— 删除错误标签或自行添加（带标签搜索）
- 标注结果直接驱动上面的「搜索与筛选」;支持 HEIC / RAW 输入

### Agent 原生（MCP）
AfterFrame 内嵌了 [MCP](https://modelcontextprotocol.io) 服务器——任何 AI agent（Claude Code、Claude Desktop 或其他 MCP 兼容客户端）都能在 App 运行时用自然语言操作你的图库：

> 「把我桌面的照片导入进来」 · 「找出上个月拍的竖构图照片给我看看」 · 「这几张裁成 4:3 发小红书」 · 「把还没打标签的图全部标注一遍」 · 「这个合集导出成长边 2048 的 JPEG」

- **17 个工具**：检索（全文 + EXIF 筛选）、agent 真正"看得见"的缩略图、导入、裁剪、导出、标签/评分、合集、AI 标注与重绘任务、删除，以及任务控制
- **双向选中桥**——你在 App 里框选后直接说"这几张"；agent 挑中的图也会在你的画廊里高亮并滚动到位（`show_in_app`）
- **可见、可取消**——agent 发起的工作和你自己的一样出现在后台活动面板里，有实时进度和取消按钮
- **纯本地**——App 运行期间服务监听 `127.0.0.1:41706`；隐私立场与 BYOK 一致

**接入方法**（需 AfterFrame 处于运行状态）：

```bash
# Claude Code —— 一次性配置，任意目录可用
claude mcp add --transport http afterframe http://127.0.0.1:41706/mcp
```

在本仓库内开发？无需任何操作——自带的 `.mcp.json` 会让 Claude Code 自动连接。其他 MCP 客户端（Claude Desktop 等）：添加远程 HTTP 服务器，URL 相同。

然后直接说：*「找几张加州的照片，在 App 里给我看看」*

![Agent 驱动的工作流](docs/assets/agent-claude-code.png)

## 快速开始

### 环境要求
- macOS（Apple Silicon）
- Python 3.10+（sidecar 服务，仅开发需要）
- Node.js 18+（仅开发需要）

### 开发环境

```bash
# 安装前端依赖
cd apps/desktop
npm install

# 启动开发服务器
npm start
```

### 构建

```bash
cd apps/desktop
npm run dist:mac          # 重打 sidecar，再打包 + 签名（Developer ID）
npm run dist:mac:release  # 额外公证 —— 需设置 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
```

`.dmg` 输出在 `apps/desktop/release/`。sidecar 步骤需要 `pyinstaller`（`pip3 install pyinstaller`）。签名使用钥匙串中的 Developer ID Application 证书；`dist:mac:release` 会额外把构建上传到 Apple 公证。

## 项目结构

```
apps/desktop/          Electron + React 桌面应用（electron/mcp/ 内嵌 MCP 服务器）
services/sidecar/      Python 后端（SQLite catalog、元数据、AI 重绘）
RESOURCES/             AI 风格提示词库、设计资源
docs/                  截图与开发文档
```

## 自定义

### AI 风格提示词
编辑 `~/Library/Application Support/afterframe/ai-styles.json` 即可添加或修改风格提示词，重启后生效。

```json
[
  { "id": "my-style", "name": "我的风格", "prompt": "将这张照片转换为..." }
]
```

## 构建方式

本项目通过 [Claude Code](https://claude.ai/code) vibe coding 完成。

---

实现细节请参阅 [docs/developer-setup.md](docs/developer-setup.md)。
