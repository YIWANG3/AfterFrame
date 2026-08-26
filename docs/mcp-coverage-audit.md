# MCP 覆盖度盘点（2026-08-16）

对照内嵌 MCP server（`apps/desktop/electron/mcp/server.js`，17 个 tool；权威设计文档 `docs/agent-native-mcp.md`）与当前全部用户功能，标出哪些能被 agent 调用、哪些不能、以及不能的原因（是"没暴露"还是"根本没有无头入口"）。

图例：✅ MCP 已覆盖 · 🟡 有无头入口（sidecar CLI / 主进程 IPC）但没暴露成 tool · 🔴 只存在于渲染进程（React/canvas），没有无头实现 · ⚫ 产品本身未实现

## 1. 一览

| 功能域 | 状态 | 说明 |
|---|---|---|
| 检索 / 问答 / 缩略图 / 唤起 App 定位 | ✅ | `search_assets` `get_asset` `view_assets` `show_in_app` `get_catalog_info` |
| 选中态 | ✅ | `get_selection` |
| 评分 / 标签 | ✅ | `update_assets`（仅 rating + add/remove tag） |
| 合集（手动） | ✅ | `manage_collections` list/create/rename/delete/add/remove/browse |
| 导入目录 / RAW 根注册 | ✅ | `import_directory` |
| AI 标注 | ✅ | `annotate_assets` |
| AI 重绘 | ✅ | `repaint_asset`（读 App 的 activeProvider） |
| 裁剪 | ✅（部分） | `crop_assets` 只支持比例 + gravity；UI 的任意矩形/旋转/翻转走 `workspace:process-and-save`（sharp），未暴露 |
| 导出（缩放/转码） | ✅ | `export_assets` |
| 删除目录记录 | ✅ | `delete_assets` |
| jobs 状态 / 取消 | ✅ | `get_job_status` `list_active_jobs` `cancel_job`（暂停/恢复未暴露） |
| **地图 / 离线地名** | 🟡 | `browse-map-points` `get-asset-location` `resolve-ai-locations` `clear-ai-location` 全在 sidecar；`browse-images` 已支持 `filters.geo` bbox；MCP 一个都没暴露，`compactAsset` 也不带任何位置字段 |
| **人物识别** | 🟡 | 10 条 CLI（列表/详情/相似/改名/封面/隐藏删除/合并/脸移入移出）+ `run-people-index-job` 全有 IPC 包装；搜索过滤 `people=with_faces` / `person_group=<id>` 在 `db/browse.py` 已有；MCP 全无，`compactAsset` 丢了 `has_face` |
| **视频** | 🟡 | 导入随普通链路自动进；`app:video-proxy` / `app:video-keyframes`（Swift）只在主进程；`browse-images` 返回 `asset_type` 但 `compactAsset` 把它丢了 → agent 分不清图片和视频，也没有时长/编码字段，没有视频过滤 |
| **文字层（headless）** | 🟡 | sidecar `add-text` → `create_derived_text`（Pillow，CJK 字体链，`--output` 预览）已实现，按早先决定不暴露；App 自己也没用它 |
| **AI 手写字贴纸** | 🟡→🔴 | 生图 job `run-text-image-job` 是无头的（provider: nanobanana/openai/ark/jimeng/mock）；但"亮度抠图 → 贴纸层 → 合成"在渲染进程（`handwritingMatte.js` + canvas），MCP 只能"生成一张手写字图片"，不能贴到照片上 |
| 图库维护 | 🟡 | `refresh-assets` `verify-assets` `relink-asset` `cleanup-orphan-images` `scan-new-media`、监听目录 IPC 全部无头，都没暴露；`compactAsset` 丢了 `exists_on_disk` / `source_changed`（agent 看不到"缺失原图"） |
| RAW 手动配对 | 🟡 | `list-pending` / `confirm-match` 存在，MCP 只做了 `register-roots + import` |
| 预览生成 / HD 预览 | 🟡 | `generate-previews --kind preview-hd`、`run-preview-job` 无头；未暴露 |
| 重绘历史 / AI 风格预设 / 模型列表 | 🟡 | `list-repaint-history` `list-ai-models`、`get/save-ai-styles`（settingsStore）；未暴露 |
| 标签自动补全 / facet 搜索 | 🟡 | `list-tags` `search-facet`；`get_catalog_info` 只给了固定 facet |
| **单张拼图 / 批量拼图** | 🔴 | 模板 + 平移缩放 + 导出全在 `CollageCanvas.jsx`（canvas.toBlob）；唯一无头的是溯源 `collage-sources` / `quick-register --collage-source-ids` |
| **相框 / EXIF 水印（含 Insta360 / Luna）** | 🔴 | `frameTemplates.js` + `frameRender.js` 纯 canvas |
| 贴纸层 / 贴纸库 / 贴纸板 | 🔴（库是 M） | 贴纸抠图 `workspace:sticker-detect`（VisionKit）与库 CRUD 是主进程 IPC，可包装；但"贴到照片上并合成"只在渲染进程 |
| 外发光 / 描边 / 叠加层 / 画布补边 / 场景深度 | 🔴 | 全在 `drawLayers.js` / `saveImage.js` canvas 分支；深度计算 `workspace:compute-depth` 是主进程 Swift，但消费方只有编辑器 |
| 任意矩形裁剪 + 旋转/翻转 | 🔴→🟡 | `workspace:process-and-save`（sharp）已是无头能力，只是没接 MCP |
| 对比视图 / 灯箱校样 | 🔴 | 纯 UI，本来也不该是 tool（`view_assets` / `show_in_app` 已够） |
| 设置（provider key、标注 provider、locale、HD 预览开关、people/depth 模型、外部编辑器） | 🟡/— | 主进程 IPC；按设计不该让 agent 改 key；locale/HD 开关可选 |
| 智能合集规则、标题/说明手改、旗标/色标/备注 | ⚫ | schema 里就没有 flag/label/note；`rules_json` 有列但没人求值，UI 只建 manual |

## 2. 为什么大块功能是 🔴：所有"合成类"输出都依赖浏览器 canvas

`saveImage.js` 的路径：无图层且不补边 → sharp 快路径（可无头）；只要有文字/贴纸/相框/补边/遮罩 → `<canvas>` 合成 → `toBlob` → `workspace:save-image`。也就是说：**拼图、相框、贴纸、发光、叠加层，本质上是同一个缺口——没有渲染进程之外的合成器**。sidecar 的 `add-text`（Pillow）是唯一的例外，且功能只到单段文字。

要让这些被 MCP cover，有两条路：
1. **主进程 sharp 合成器**：把 `drawLayers.js` 的层模型翻译成 sharp `composite()`（拼图 = resize+extract+composite；相框 = SVG 模板→sharp；贴纸/叠加 = PNG composite；发光/描边 = 预渲染 alpha 膨胀+blur）。文字排版和 CJK 字体是难点（sharp 靠 SVG `<text>` + fontconfig）。
2. **隐藏 BrowserWindow 离屏渲染**：主进程开一个 offscreen 窗口跑现有 React 渲染代码，把编辑器状态 JSON 喂进去出图。零重复实现、像素与 UI 一致，但依赖 App 运行（MCP 本来就要求 App 运行，所以可以接受），需要把 CollageOverlay/EditorOverlay 的"状态 → 出图"抽成纯函数入口。

对拼图/相框这类"参数化、模板化"的功能，路 2 更现实：`render_collage({asset_ids, template, per_page, ...})` 直接复用 `computeGroups` + `CollageCanvas.exportToBlob`。

## 3. 建议的下一批 tool（按价值/成本）

| 优先 | tool | 底层 | 成本 |
|---|---|---|---|
| P0 | `search_assets` 补齐：`asset_type`、`has_face`、`exists_on_disk`、location 字段进 `compactAsset`；filters 加 `people` / `person_group` / `geo` bbox / `extension` / `shutter` / `annotated` / `collection_id` | 已有 SQL | 小 |
| P0 | `list_people` / `get_person` / `update_person`（rename/merge/hide/cover）+ 搜索按人 | 10 条 CLI 已有 | 小 |
| P0 | `browse_map` / `get_asset_location` | CLI 已有 | 小 |
| P1 | `maintain_library`（verify / refresh / relink / scan-new-media / watched dirs） | CLI+IPC 已有 | 小 |
| P1 | `crop_assets` 升级：任意矩形 + 旋转/翻转（接 `process-and-save`） | IPC 已有 | 小 |
| P1 | `render_collage`（单张 + 批量）| 需离屏渲染入口 | 中 |
| P2 | `add_text`（放开已实现的 sidecar 能力） | CLI 已有 | 极小（决策问题） |
| P2 | `apply_frame`（EXIF 水印模板） | 需离屏渲染 | 中 |
| P2 | `generate_handwriting`（只出图，不合成）| `run-text-image-job` | 小 |
| P3 | 贴纸库读写 / 贴纸抠图 | 主进程 IPC | 小；但"贴上去"仍要离屏渲染 |
| — | 设置类（key、模型） | — | 不建议暴露 |

## 4. 顺手发现

- `cli.py` 里 `annotation-test-connection` / `annotation-list-models` / `benchmark-dataset` 有 argparse 子命令但不在 `_dispatch`，CLI 直接调会报错（App 走的是 `ipc/annotation.js` 另一条路）。
- `manage_collections` 的 `update` 只传 name，`commands.updateCollection` 其实支持 `rulesJson` / `sortOrder`。
- `create-collection` 在 MCP 里写死 `kind="manual"`。
