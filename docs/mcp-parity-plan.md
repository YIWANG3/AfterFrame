# MCP 对等计划：人能做的操作，agent 也能做

> 状态：Phase 1 已实现（2026-08-16，feat/mcp-parity-phase1，17→30 tools；e2e：e2e/26-mcp-parity.spec.js）。裁剪：search_assets 的 collection_id 归 manage_collections browse；missing_original 以 compact 字段呈现（verify_assets 做全量盘点）；search_facet 并入 get_catalog_info/list_tags 不单独立 tool。Phase 2-4 未开始。前置盘点见 `docs/mcp-coverage-audit.md`；MCP 设计与现有 17 个 tool 见 `docs/agent-native-mcp.md`。

## 0. 目标与原则

- **对等（parity）**：UI 里每一个用户动作，都能找到一个 MCP tool 完成同样的结果（产物进同一张 catalog、同一个版本族、同一个 JobDock）。
- **一个来源**：不重写渲染逻辑。合成类输出（拼图/相框/贴纸/文字/发光/补边）继续由现有 React/canvas 代码出图，只是把"状态 → 图片"抽成可被主进程调用的纯入口（详见 §2 渲染桥）。
- **粗粒度、按用户语言命名**：tool 数量控制在 ~35 个以内（Figma 18、Lightroom MCP 13 的量级），一个 tool 多 action，而不是 1:1 镜像 86 条 CLI。
- **可验证、可逆**：写操作后广播 `workspace:catalog-changed`；破坏性操作（删磁盘文件、删人物组）需要显式 `confirm: true`，删磁盘走系统废纸篓。
- **明确的例外**（人能做但 agent 不做）：写入 API key / provider 密钥、切换/新建 catalog（可读不可写，见 §5）、系统级设置。

## 1. 缺口分三类，修法不同

| 类别 | 例子 | 修法 |
|---|---|---|
| A. 无头入口已有，只是没接 tool | 地图、人物、图库维护、RAW 配对、`add-text`、jobs 暂停恢复、重绘历史、预览生成 | 纯 `server.js` 加 tool + `commands.js` 包装，小活 |
| B. 输出靠渲染进程 canvas | 拼图（单/批）、相框水印、贴纸/文字层、发光/描边、叠加层、补边、深度 | 建"渲染桥"：agent → 主进程 → 渲染进程纯渲染函数 → Blob → 保存/登记 |
| C. 数据面缺字段 | `search_assets` 缺过滤（人物/geo/扩展名/快门/合集内/已标注）；`compactAsset` 丢 `asset_type`/`has_face`/`exists_on_disk`/位置 | 补 schema 与字段映射 |

## 2. 关键架构补件：渲染桥（Render Bridge）

现有 `show_in_app` 已经是"agent → 渲染进程"的反向通道（`main.js revealAssetsInApp`：`webContents.send` + 一次性 `ipcMain.once(channel:requestId)` 回执 + 超时）。渲染桥就是把它泛化成通用请求/响应：

```
MCP tool ──▶ main: askRenderer(kind, payload, {timeoutMs})
                │  webContents.send("workspace:agent-render", {requestId, kind, payload})
                ▼
        renderer: renderRegistry[kind](payload) → { blob | ArrayBuffer, width, height }
                │  ipcRenderer.send(`workspace:agent-render-result:${requestId}`, …)
                ▼
             main: 写文件（sharp 编码可选）→ commands.quickRegister(path, originPath, sourceIds)
                   → 广播 catalog-changed → 返回 {asset_id, path, thumbnail_url}
```

- **渲染进程侧**：新增 `src/agent/renderBridge.js`，在 `App.jsx` 挂载时注册处理器；处理器只依赖纯函数，不挂载 UI、不改 UI 状态：
  - `collage`：`computeGroups`/`orderImages`（`collageBatch.js`）+ 把 `CollageCanvas` 的绘制核心抽成 `renderCollagePage({images, template, options}) → canvas`（现在 `exportToBlob` 依赖组件 ref，需要抽出无组件版本）。
  - `edit`：复用 `saveEditedImage(ctx)`——需要把 `EditorOverlay` 里"从状态构造 ctx"的逻辑抽成 `buildSaveContext(state)`，状态由 agent 传 JSON（见 §3 编辑配方）。`drawLayersToCtx` / `frameRender` / `handwritingMatte` 都在这里被复用，零重复实现。
  - `frame`：`edit` 的子集（只有一个 frame 层）。
- **主进程侧**：`electron/agentRender.js` 提供 `askRenderer()`；窗口不存在时返回明确错误（MCP 本来就要求 App 运行；隐藏 BrowserWindow 兜底作为后续可选项）。
- **并发**：渲染桥请求串行化（一个队列），避免 canvas 内存尖峰；长任务（批量拼图 >N 页）走 job（`create-job` 类型 `agent_render`），出现在 JobDock，可取消。
- **像素一致性**：和 UI 导出走同一函数 → agent 出图与人点导出按钮完全一致；这也是不用 sharp 重写的原因。

## 3. 编辑配方（Edit Recipe）：agent 与 UI 的共同语言

`edit_asset` 的输入是一段 JSON，字段与编辑器内部状态一一对应（不新造概念）：

```jsonc
{
  "asset_id": "…",
  "geometry": { "quarter_turns": 0, "free_angle": 0, "flip_x": false, "flip_y": false,
                "crop": { "x": 0.1, "y": 0.1, "w": 0.8, "h": 0.6 } },        // 归一化矩形，可省略
  "canvas":   { "pad": {"top":0.05,"right":0.05,"bottom":0.12,"left":0.05}, "bg": "#ffffff", "scrim": null },
  "layers": [
    { "type": "text", "text": "…", "x": 0.5, "y": 0.9, "size": 0.04, "font": "Inter", "color": "#fff",
      "align": "center", "outline": {"width":2,"color":"#000","opacity":0.6}, "glow": {"radius":8,"color":"#000"} },
    { "type": "sticker", "source": {"sticker_id":"…"} | {"asset_id":"…"} | {"path":"…"}, "x":…, "y":…, "scale":…, "rotation":… },
    { "type": "frame", "template": "insta360-classic", "fields": { "logo": "insta360" } },
    { "type": "overlay", "source": {"asset_id":"…"}, "opacity": 0.5, "blend": "normal" }
  ],
  "output": { "format": "jpeg", "quality": 92, "max_edge": null }
}
```

- 校验在渲染进程用现有 `layerStack.js` / `frameTemplates.js` 的定义做（缺字段用编辑器默认值）。
- 产物 `quickRegister` 为原图的 derived 版本，并把 recipe 存进 `asset_links`/元数据（可选 P3：编辑器"重新打开 agent 的编辑"）。
- `get_editor_capabilities` 返回可用相框模板、字体、贴纸库、层类型的枚举，agent 先查再填。

## 4. 分阶段

### Phase 1 — 数据面对等 + A 类 tool（1～2 天，全部 sidecar/IPC 现成）

| tool | action / 参数 | 底层 |
|---|---|---|
| `search_assets`（升级） | 新增 filters：`asset_type` (photo/video)、`people` (with/without)、`person_id`、`geo` bbox / `near {lat,lng,km}`、`extension`、`shutter_min/max`、`annotated`、`collection_id`、`missing_original`；`compactAsset` 增 `asset_type`、`duration`、`has_face`、`exists_on_disk`、`source_changed`、`location {lat,lng,place}` | `browse-images` filters 已支持大部分 |
| `get_asset`（升级） | 返回 location、faces（person_id 列表）、版本族、重绘历史 | `asset-detail` + `get-asset-location` + `list-repaint-history` |
| `list_people` / `get_person` | list(state)、detail(faces 分页)、similar | `list-people-groups` 等 |
| `update_person` | rename / set_cover / hide / unhide / delete(confirm) / merge(into) / assign_face / remove_face | 对应 CLI |
| `index_people` | 起 people_index job（模型未就绪时返回可读错误 + 提示去设置页） | `run-people-index-job` |
| `browse_map` | bbox / precision / 与 search filters 同构 → 点位聚合 | `browse-map-points` |
| `set_asset_location` | 手动设/清（人能拖点，agent 能写坐标）；`resolve_ai_locations` 回填 | `clear-ai-location` + 需补一条 `set-asset-location` CLI（小） |
| `maintain_library` | verify_assets / refresh_from_disk(asset_ids) / relink(asset_id,new_path) / scan_new_media / cleanup_orphans / list_watched_dirs / add_watched_dir / remove_watched_dir | 全部现成 |
| `raw_pairing` | list_pending / confirm_match / add_raw_root | `list-pending` `confirm-match` `register-roots` |
| `crop_assets`（升级） | 增加 `rect{x,y,w,h}`、`quarter_turns`、`free_angle`、`flip_x/y`（走 `process-and-save` sharp） | IPC 现成 |
| `add_text` | 放开已实现的 sidecar `add-text`（Phase 2 后由 `edit_asset` 取代，但零成本先给） | `create_derived_text` |
| `manage_collections`（升级） | update 支持 `sort_order`；返回 `kind` | `commands.updateCollection` 已支持 |
| `jobs`（升级） | `pause_job` / `resume_job` | CLI 现成 |
| `list_tags` / `search_facet` | 标签补全、任意 facet 值搜索 | 现成 |
| `generate_previews` | 指定 asset_ids / kind(preview, preview-hd) | `run-preview-job` |

改动面：`electron/mcp/server.js`、`electron/sidecar/commands.js`（补 5～8 个包装）、sidecar 补 `set-asset-location`；`initialize.instructions` 同步更新领域说明（人物/地点概念）。测试：扩展 `e2e/08-mcp-http.spec.js`（people 用 `people-catalog.afcatalog` fixture；geo 需给测试 catalog 种 2～3 个坐标）。

### Phase 2 — 渲染桥 + 合成类 tool（3～5 天）

1. 抽纯函数：`renderCollagePage()`（从 `CollageCanvas.jsx`）、`buildSaveContext()`（从 `EditorOverlay`/`useEditorSave`），保证 UI 路径改用同一函数（防分叉）。
2. `electron/agentRender.js` + `src/agent/renderBridge.js`（§2）。
3. tools：

| tool | 说明 |
|---|---|
| `render_collage` | `asset_ids`, `template`(或 `auto`), `per_page`(批量), `canvas {ratio, bg, gap, radius}`, `export_width`, `order`；单页返回 1 个新资产，多页返回列表 + job_id；产物按 UI 同款 `quickRegister(..., collage_source_ids)` |
| `edit_asset` | 输入 §3 配方，输出 derived 版本 |
| `apply_frame` | `edit_asset` 的快捷方式：`template` + `fields` |
| `get_editor_capabilities` | 相框模板/字段、字体、贴纸库条目、层类型与默认值 |
| `open_in_app`（升级 `show_in_app`） | 增 `view: gallery | editor | collage | compare | map | people`，让 agent 能"打开编辑器把接力棒交给人" |

测试：MCP HTTP e2e 真实出图（对照 UI 导出同参数的像素尺寸/文件存在/版本族挂接）；`renderCollagePage` 单测。

### Phase 3 — AI 生成类 + 贴纸 + 视频（2～3 天）

| tool | 说明 |
|---|---|
| `generate_handwriting` | 起 `text_image` job（provider 读 App 设置）；`as: "image" | "sticker"`——sticker 模式经渲染桥跑 `matteHandwriting` 得到透明 PNG，写入贴纸库或直接作为 `edit_asset` 的层 |
| `stickers` | list / extract_from_asset(VisionKit `sticker-detect`) / save / delete / star | 主进程 IPC 现成 |
| `repaint_asset`（升级） | `style_preset` 选择、`list_history` | `get-ai-styles` `list-repaint-history` |
| `video` | keyframes(asset_id, count) 返回 URL；proxy 状态 | `app:video-keyframes` / `app:video-proxy` |
| `compute_depth` | 供 `edit_asset` 深度相关层使用（可选） | `workspace:compute-depth` |

### Phase 4 — 收口与保障（1～2 天）

- **对等清单即测试**：`docs/mcp-parity-matrix.md` 列出"UI 动作 → tool" 全表；每行至少一条 e2e（或标注为例外）。CI 里 08-mcp e2e 覆盖 Phase 1～3 的每个 tool 至少一次。
- `initialize.instructions` 重写：领域模型 + 新概念（人物、地点、配方、渲染桥限制）+ 推荐工作流。
- 设置页"复制 MCP 接入配置"（此前路线图未做项）。
- `get_settings`（只读：语言、HD 预览开关、活跃 provider 名、people/depth 模型是否就绪）——agent 能解释"为什么某功能不可用"。
- 修 §盘点里的小问题：`cli.py` 三个子命令补进 `_dispatch`；MCP `create_collection` 允许 `kind`（若智能合集将来实现）。

## 5. 明确不做 / 需要你拍板

| 项 | 建议 |
|---|---|
| 写 API key / provider 密钥 | 不做（安全）；agent 只读到"已配置的 provider 名" |
| 切换 / 新建 catalog | 建议只读（`get_catalog_info` 已有）；若要写，加 `switch_catalog(path, confirm)` |
| 从磁盘删除 | 建议做，`delete_assets{from_disk:true, confirm:true}` → `shell.trashItem`（人能做，且可撤销） |
| 智能合集 | 产品本身未实现（rules 无人求值），不在本计划内 |
| 隐藏 BrowserWindow 兜底 | 先不做；MCP 已要求 App 运行 |
| 逃生舱 `run_sidecar_command` | 业界共识里的"execute_*"类；建议加但默认关闭（设置开关），供高级用户 |

## 6. 顺序与工作量汇总

Phase 1（1～2 天）→ Phase 2（3～5 天，最大价值：拼图/相框/文字/贴纸全部对等）→ Phase 3（2～3 天）→ Phase 4（1～2 天）。总计约 8～12 个工作日；每个 Phase 独立可发布，Phase 1 完成后 tool 数约 27，全部完成约 34。
