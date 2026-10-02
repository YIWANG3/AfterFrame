# 官网与文档素材

UI 截图按界面语言归档：`cn/` 为简体中文，`en/` 为英文；各目录下的 `light/` 保存浅色界面。共 24 张深色截图和 14 张浅色截图。

- `*.png`：保留完整应用界面的高清素材，裁剪边界见下表。
- 同名 `*.webp`：网页展示版本，保留 PNG 的像素尺寸、比例与透明边缘，质量 95。
- 根目录的 `logo.png` 用于应用标志（与 `apps/desktop/build/icon.png` 同一张图：圆角已做进图片，四角透明，各处不再用 CSS 加圆角），`editor-handwriting-gallery.jpg` 为手写字摄影作品展示图。
- 本目录用于官网和文档，不属于示例图库。

## 截图边界与来源

| 素材 | 来源与裁剪 | 最终尺寸 |
| --- | --- | --- |
| 23 张深色整窗截图 | 原始 3024 × 1964 截图只裁掉顶部 66 px macOS 空白条 | 3024 × 1898 |
| 13 张浅色整窗截图 | 安装版 AfterFrame 的 Chromium 渲染器，1440 × 920 视口、3 倍像素密度；不裁顶部 | 4320 × 2760 |
| 深浅 MCP 设置截图 | 从 4320 × 2760 渲染中截取 `(840, 360, 2640, 2040)` 设置弹窗 | 2640 × 2040 |

截图保留应用标题、文件名、保存按钮和面板边距。窗口圆角外侧编码为透明 alpha；官网不再通过外框或百分比圆角二次裁切。浅色截图直接渲染自浅色 UI，没有放大低清截图或重画界面。

人物演示只使用用户提供的 `ai-portrait.afcatalog` 中的 AI 生成图片。浅色图库、文字、深度、拼图和 AI 重绘示例使用夏威夷风景。MCP 图不包含 API 密钥；AI 重绘和手写字截图展示工具面板。

## 深色截图索引

| 场景 / 文件名 | 中文 | 英文 |
| --- | --- | --- |
| `library`：图库与检查面板 | ✓ | ✓ |
| `library-actions`：导入与标注菜单 | ✓ | ✓ |
| `lightbox`：大图浏览 | ✓ | ✓ |
| `people`：人物库 | ✓ | ✓ |
| `editor-crop`：裁剪 | ✓ | ✓ |
| `editor-text`：文字编辑 | ✓ | ✓ |
| `editor-text-new-york`：New York 文字编辑 | ✓ | — |
| `editor-text-depth`：深度文字 | — | ✓ |
| `editor-handwriting`：AI 手写字 | — | ✓ |
| `collage-batch`：批量拼图 | ✓ | ✓ |
| `collage`：单张拼图 | — | ✓ |
| `ai-repaint-compare`：重绘前后对比 | ✓ | ✓ |
| `frame-hasselblad`：哈苏相框 | — | ✓ |
| `frame-hasselblad-louvre`：卢浮宫哈苏相框 | — | ✓ |
| `frame-canon`：佳能相框 | — | ✓ |
| `agent-mcp`：MCP 连接设置 | — | ✓ |

中文页面需要借用英文界面截图时，在图片说明中标注界面语言。

## 品牌素材

- `brand/logo-backdrop-black.webp`、`brand/logo-backdrop-white.webp`：原版霓虹相框的 Blender 4096 × 4096 渲染，导出为 3200 × 3200 WebP。白底版在原版基础上加强彩色光晕，保留细亮边和原有颜色分布。
- `brand/afterframe-wordmark.woff`：Nanum Myeongjo 的 “AfterFrame” 字标子集，使用独立字体名称 “AfterFrame Brand”；许可证见 `brand/OFL.txt`。
- 官网首页与使用指南随系统主题和手动主题切换深浅配图。浅色背景的光影单独调整强度，截图本身不加色彩滤镜；README 使用深色配图。

## 更新与验证

替换对应 PNG 后，在仓库根目录运行（先安装 `apps/desktop` 依赖）：

```sh
node site/scripts/build-screenshots.mjs
node --test site/scripts/screenshots.test.mjs
```

构建脚本递归处理 `cn/`、`en/` 及其 `light/` 子目录。检查覆盖图片引用、标注尺寸、深浅配对和 WebP 原始分辨率。

README 引用 `docs/assets/{cn,en}/*.webp`；官网引用 `assets/{cn,en}/*.webp`。开发时 `site/assets` 链接到本目录，GitHub Pages 工作流将其复制到站点；合入 `main` 后自动部署。

Blender 源文件、渲染试稿和裁剪复核资料保存在制作工作区，不放入官网素材目录。
