# UI 截图

2026-09-12 / 13 新版界面截图。按界面语言归档：`cn/` 为简体中文，`en/` 为英文。

- `*.png`：原始截图，仅重命名，未裁剪或修改内容。
- 同名 `*.webp`：README 和官网引用的轻量版，宽 2000 px、保持比例。
- 根目录中的旧截图暂时保留以兼容历史引用；新增页面不要再引用旧 UI。`logo.png` 和手写字作品展示图继续使用。
- 本目录是文档素材，不属于示例图库，不应作为照片导入源。

| 场景 / 文件名 | 中文 | 英文 |
| --- | --- | --- |
| `library`：图库与检查面板 | ✓ | ✓ |
| `library-actions`：导入与标注菜单 | ✓ | ✓ |
| `lightbox`：大图浏览 | ✓ | ✓ |
| `people`：人物库 | ✓ | ✓ |
| `editor-crop`：裁剪 | ✓ | ✓ |
| `editor-text`：Tokyo 文字编辑 | ✓ | ✓ |
| `editor-text-new-york`：New York 文字编辑 | ✓ | — |
| `editor-text-depth`：Matterhorn 深度文字 | — | ✓ |
| `editor-handwriting`：AI 手写字 | — | ✓ |
| `collage-batch`：批量拼图 | ✓ | ✓ |
| `collage`：单张拼图 | — | ✓ |
| `ai-repaint-compare`：重绘前后对比 | ✓ | ✓ |
| `frame-hasselblad`：哈苏相框 | — | ✓ |
| `frame-hasselblad-louvre`：卢浮宫哈苏相框 | — | ✓ |
| `frame-canon`：佳能相框 | — | ✓ |
| `agent-mcp`：Agent 操作图库 | — | ✓ |

共 24 张原图。卢浮宫相框原先放在 `cn/`，实际为英文界面，已归入 `en/`。没有中文版本的手写字、深度文字、相框、MCP 示例使用英文截图，并在中文说明中标注；人物演示图为 AI 生成。

## 更新方式

替换对应原始 PNG 后，在仓库根目录运行（先安装 `apps/desktop` 依赖）：

```sh
node site/scripts/build-screenshots.mjs
node --test site/scripts/screenshots.test.mjs
```

README 使用 `docs/assets/{cn,en}/*.webp`；官网使用 `assets/{cn,en}/*.webp`。开发时 `site/assets` 链接到本目录，GitHub Pages 工作流将本目录复制到站点。合入 `main` 后自动部署。
