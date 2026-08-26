# AfterFrame Agent Native 设计：内嵌 MCP Server

> 状态：2026-08-16 parity Phase 1 落地（docs/mcp-parity-plan.md）：17→30 tools —— 新增 list_people/get_person/update_person/index_people、browse_map/set_asset_location（sidecar 新命令 set-asset-location，manual > exif > ai）、maintain_library、raw_pairing、add_text（放开）、pause/resume_job、list_tags、generate_previews；search_assets 补 asset_type/extension/shutter/people/person_id/annotated/geo(bbox|near) 过滤，compactAsset 补 asset_type/duration/has_face/missing_original/source_changed；crop_assets 增任意矩形+旋转/翻转（sharp process-and-save）。Phase 2（同日）：渲染桥（agent → 渲染进程 canvas，electron/agentRender.js + src/agent/renderBridge.js）+ render_collage / edit_asset / apply_frame / get_editor_capabilities，show_in_app 支持 view 参数——34 tools。
>
> 状态：第 1、2、3 阶段已实现（2026-06-11）。第 3 阶段：sidecar 新模块 `derived.py`（quick-register 注册逻辑抽为 `register_export_file` 复用；Pillow 裁剪保留 EXIF/归一 Orientation；导出支持 max-edge 缩放 + jpeg/png/webp 转码），新 CLI 命令 `create-derived` / `export-assets`，MCP 新 tool `crop_assets`（非破坏，产物入版本族）/ `export_assets`。MCP 共 15 个 tool。第 4 阶段部分完成：initialize 响应携带 `instructions`（领域模型速成：asset/版本族/合集/job 概念 + 工作约定），所有接入 agent 自动获得——替代了原计划的 AGENTS.md（外部 agent 不读仓库文件，但必收 initialize）。
>
> 已完成（2026-06-11 续）：`repaint_asset`（读 Settings→AI 的 aiPreferences activeProvider，起 ai_repaint job，产物自动入版本族）+ `delete_assets`（仅删目录记录与预览缓存，磁盘原文件不动）——MCP 共 17 个 tool。常驻 sidecar：cli 新增 `serve` 模式（行分隔 JSON stdio 协议，每请求重入 main() 重新建连，语义与一次性进程一致），main.js resident 优先 / 超时杀进程重启 / 传输层失败回退 one-shot spawn，切 catalog 与退出时清理；实测 5ms/次 vs 一次性 160ms。`add-text` 已实现到 sidecar 层（CLI + Pillow 渲染 + `--output` 预览模式，CJK 字体链）但按用户决定**不暴露 MCP tool**。
>
> 路线图（未做）：语义搜索（embedding，方案见讨论记录）；设置页"复制 MCP 接入配置"。第 2 阶段新增 4 个 tool：get_selection（renderer 选中态实时镜像到主进程）、update_assets（批量评分/加减 tag）、manage_collections（list/create/rename/delete/add_items/remove_items/browse 单 tool 多 action）、annotate_assets（复用 App 配置的 LLM provider 起标注 job）。写操作后主进程广播 `workspace:catalog-changed`，useWorkspace 按 scope 刷新资产列表/合集/标注缓存。
>
> 第 1 阶段（2026-06-11）——主进程内嵌 MCP server（`apps/desktop/electron/mcp/server.js`，端口 41706）+ `/assets/{id}` 缩略图端点 + 9 个 tool（get_catalog_info / search_assets / get_asset / view_assets / **show_in_app** / import_directory / get_job_status / list_active_jobs / cancel_job）。show_in_app 是 Agent→UI 反向通道：唤起窗口、重置视图、有界翻页定位资产、多选并滚动到位、toast 提示，renderer 回执 {found, missing} 给 agent，仓库根 `.mcp.json` 供 Claude Code 零配置接入。已无头验证：握手、检索、缩略图、view_assets 图片返回、导入全链路。

## 目标

让 AfterFrame 成为 "AI agent native" 的应用：用户可以在 Claude Code（或任何支持 MCP 的 agent）里用自然语言控制它——"把桌面 photos 目录导入"、"找出上个月 35mm 拍的竖构图照片"、"把这几张裁成 4:3"。

## 现状盘点

| 能力 | 状态 |
| --- | --- |
| 导入（scan-raw / run-import-job）、浏览检索、LLM 标注、AI 重绘、jobs 轮询/取消 | ✅ sidecar CLI 已可无 UI 调用（`python3 -m media_workspace --catalog <path> <cmd>`，JSON 输出） |
| 裁剪 / 文字 / 拼图导出 | ❌ 只存在于 React 渲染进程 + Electron IPC（`apps/desktop/electron/ipc/saveFile.js`，sharp 编码），UI 之外不可用 |
| 与运行中 App 的状态互通（选中态、UI 刷新） | ❌ 不存在 |
| 并发写入约定 | ⚠️ catalog 为 SQLite（WAL），App 与外部进程同时写需要约定 |

## 调研结论

### Eagle 的本地 API（实测 localhost:41595 + 官方文档）

- Electron 主进程内嵌 HTTP server，App 启动即监听，无独立守护进程。localhost 请求**免 token**，token 仅用于局域网访问。
- API 面窄而实用：`application/info`、`folder/*`、`item/*`（addFromPath/addFromURL、list、update tags/star/annotation、thumbnail）、`library/*`。统一 `{status, data}` JSON。
- Eagle 4.0 新增 v2 API + AI 语义搜索，并推出官方 MCP 插件（beta）——同类产品已在往 agent native 走。
- **短板（即我们的差异化机会）**：
  1. 不能编辑图片（无裁剪/缩放）；
  2. 读不到 UI 选中状态（"这几张"无解）；
  3. 无事件推送，只能轮询；
  4. thumbnail 端点返回本地文件路径而非图片字节，社区 MCP 被迫自行 base64 桥接；
  5. 检索仅 keyword/tags/folders/ext 平面过滤。

### 业界接入模式（按适配度排序）

| 模式 | 代表 | 评价 |
| --- | --- | --- |
| **App 内嵌本地 MCP/HTTP server** | Figma 桌面版（localhost:3845/mcp + /assets）、Eagle | 我们拥有 App 源码，最干净：直达运行时状态，无插件/桥/配对 |
| 外置脚本 API 包装 | DaVinci Resolve 社区 MCP | 需 App 先有官方脚本 API |
| 插件 + WebSocket 桥 + 外部 MCP | cursor-talk-to-figma、Adobe adb-mcp | 沙箱所迫的妥协，多一个用户要手动启动的部件 |
| 插件开裸 socket + 外部翻译进程 | Blender MCP、Lightroom MCP | 同上 |
| 直接改工程文件，不连 App | CapCut（draft JSON） | 无选中态，体验最差 |

### 跨项目反复出现的设计共识

1. **选中态是上下文锚点**：所有活 App 集成都有无参数的 `get_selection`；Figma 的读 tool 默认作用于当前选中。
2. **粗粒度精选 tool 完胜 1:1 API 镜像**：Figma 官方约 18 个、Lightroom MCP 13 个；440 个 tool 的 Resolve 镜像需要额外 skill 文档才能用。
3. **留一个逃生舱**：成熟集成最终都加了 `execute_*_code` 类任意脚本 tool。
4. **先廉价地图、再昂贵细读**：Figma `get_metadata`（稀疏骨架）→ `get_design_context`（完整上下文）分层，控制 token 成本。
5. **图片用本地 URL 返回，不内联大 base64**：Figma 专设 `/assets/*` 端点。
6. **长任务 = start-job → job-id → poll**，配批量操作变体。
7. **写后可验证、操作可逆**：删除进回收站；agent 改完能重读确认。

## 架构决策：Figma 模式——Electron 主进程内嵌 MCP server

在 Electron **主进程**内嵌 MCP server（streamable-HTTP，`localhost:<port>/mcp`，带 token 门禁），同时开 `/assets/{id}` 静态端点服务 `previews/` 缩略图。

理由：

- 主进程已持有 sidecar 调用、jobs 轮询、catalog 路径，加一个 IPC 即可拿到 renderer 选中态——所有上下文集中一处，无需插件、桥、配对。
- App 统一持有 SQLite 写入，回避外部进程并发写冲突。
- App 未运行时 agent 不可用——Eagle/Figma 均接受此约束，心智简单；真正的无头场景仍可直接用 sidecar CLI 兜底。
- agent 发起的任务走统一 jobs 表，自动出现在 JobDock：用户能看到 agent 在干什么、可取消。

配套：项目根放 `.mcp.json` 供零配置接入；写 `AGENTS.md` 讲清领域模型（asset / resource set / collection / job）；App 设置页提供"复制 MCP 接入配置"。

## 用户高频功能梳理（tool 从"用户会说什么"倒推）

### 第一档：检索与问答（最高频，日常对话）

- "找出上个月用 35mm 拍的、竖构图的照片" → `search_assets`（schema 中相机/镜头/ISO/光圈/焦段/拍摄时间已是现成 facet 列，可远超 Eagle 的平面过滤）
- "库里 XX 的照片有多少张" → 检索 + 统计
- "这张图的参数/原片在哪" → `get_asset`（EXIF、RAW 配对、版本族）
- **缩略图回显**（检索体验闭环的关键，见下节）

### 第二档：导入与整理（高频，最大痛点）

- "把桌面 photos 目录导入" → `import_directory`（内部走 run-import-job + 轮询，agent 视角一个调用）
- "给这批图自动打标签/写描述" → 暴露现有 LLM annotation job；与检索组合即"导入 → 自动标注 → 按内容搜索"全链路（即 Eagle 4.0 主打的 AI 搜索，我们零件已齐）
- "把这几张加到 XX 合集" / "打 5 星 / 加 tag" → collection 与元数据批量写入
- **`get_selection()`**：用户在 UI 框选后对 agent 说"这几张"——桌面 App 独有体验，优先级提前到本档

### 第三档：编辑与导出（中频，差异化卖点——Eagle 做不到）

- "把这几张裁成 4:3 / 1:1" → `crop_assets`，依赖新增 sidecar 命令 `create-derived --asset-id X --crop-ratio 4:3`（Pillow 实现，产物写入 `derived/`，注册进 resource_sets 版本族，不覆盖原图，保留 EXIF）
- "导出这个合集到某目录，长边 2048、转 JPEG" → `export_assets`。注意：批量导出目前**任何一层都不存在**——`saveFile.js` 只能导出编辑器画布成品，离开 UI 不可用。需在 sidecar 新写 CLI 命令（Pillow 缩放/转码/按模板重命名），与 `create-derived` 同层，可跑成 job 进 JobDock，UI 以后也可复用
- 导出按模板批量重命名

### 第四档：基础设施与低频

- jobs 查询/取消（必须有，但用户少主动说）、AI 重绘（暴露现有 job）、删除（进回收站）、切换 catalog

## 缩略图回显

"检索结果带图，而不是只回文件名和 ID"，分两层：

1. **让 agent 看得见图**（更重要）：tool 返回值附带缩略图后，agent 可视觉过滤（"适合做封面的海景"——元数据筛不出来）、确认指代（"猫在窗台那张"）、操作后对比验证。没有这层，agent 是"盲人管理员"。
2. **让用户在对话里看到结果**：回答里直接展示缩略图，用户扫一眼说"第二张，裁成 4:3"。

实现（两者结合，对应"先地图后细读"）：

- `search_assets` 默认只回元数据 + `http://localhost:<port>/assets/{id}` 缩略图 URL（省 token；`previews/` 目录现成，端点≈静态文件服务）。
- 另设 `view_assets(ids)`：按需返回小尺寸（长边 ~256）base64，供 agent 细看。
- 避免 Eagle 的坑：绝不返回本地文件路径字符串。

## v1 Tool 草案（10~15 个精选）

| Tool | 映射 | 档位 |
| --- | --- | --- |
| `search_assets(query, filters, limit)` | browse-exports + facet 过滤，回元数据 + 缩略图 URL | 1 |
| `get_asset(id)` | asset-detail | 1 |
| `view_assets(ids)` | previews → 小图 base64 | 1 |
| `get_selection()` | 主进程 ↔ renderer IPC | 2 |
| `import_directory(path, opts)` | run-import-job（封装轮询） | 2 |
| `annotate_assets(ids \| filter)` | annotation job | 2 |
| `update_assets(ids, {tags, star, annotation})` | 元数据批量写 | 2 |
| `manage_collection(action, ...)` | collection CRUD + 增删条目 | 2 |
| `crop_assets(ids, ratio, gravity)` | 新增 create-derived | 3 |
| `export_assets(ids \| collection, dir, opts)` | 待定（可能新增） | 3 |
| `list_jobs()` / `cancel_job(id)` | jobs 命令 | 4 |
| `delete_assets(ids)`（进回收站） | assets delete | 4 |

## 落地顺序

1. **MCP server v1**：主进程嵌 streamable-HTTP MCP + `/assets` 端点；tool：search / get_asset / view_assets / import_directory / jobs。验收："导入我桌面的 photos 目录"、"找 XX 并展示缩略图"。
2. **整理能力**：get_selection、update_assets、manage_collection、annotate_assets。验收："把我选中的这几张打上 tag 并加进合集"。
3. **编辑下沉**：sidecar 新增 `create-derived`（裁剪），接入 `crop_assets`；评估 `export_assets`。验收："把这几张裁成 4:3"。
4. **打磨**：AGENTS.md、`.mcp.json`、设置页一键接入、（可选）escape-hatch 脚本 tool。

## 已定决策（2026-06-11）

### 端口与认证

2026-06-12 补充：开发版默认端口 **41707**、打包版 **41706**（`AFTERFRAME_MCP_PORT` 可覆盖）——两个版本可同时运行互不冲突；仓库 `.mcp.json` 指向 dev 端口，用户级注册指向 release 端口，agent 确定性地连到对应实例。

固定一个不常用端口（避开 Eagle 的 41595），仅监听 `127.0.0.1`，本地环境不做 token（同 Eagle 策略）。

### UI 感知 agent 写入

内嵌主进程架构的最大红利：**无需文件监听/轮询**。所有写 tool 经过主进程 handler，写完即知道变更内容，直接 `webContents.send()` 推 IPC 事件给 renderer。

需要感知的行为与机制：

| agent 行为 | UI 反应 | 机制 |
| --- | --- | --- |
| 导入完成 | 网格刷新、出现新图 | 复用 job 完成回调触发刷新 |
| 改元数据（tags/星级/注释） | 角标、检查器更新 | `catalog:changed` 事件 |
| 合集增删/新建 | 侧边栏计数、合集视图更新 | `catalog:changed` 事件 |
| 裁剪产出新版本 | 版本族堆叠更新 | `catalog:changed` 事件 |
| 删除（进回收站） | 图从网格消失 | `catalog:changed` 事件 |
| 长任务进行中 | JobDock 显示进度、可取消 | ✅ 已有（统一 jobs 表） |

事件设计：统一 `catalog:changed`，payload `{ scope: 'assets' | 'collections' | 'resource-sets', ids?, reason: 'agent' }`。renderer 按 scope 失效并重取当前可见查询即可（本地 SQLite 足够快，不做单条 patch）。`reason: 'agent'` 供 UI 做轻量提示（toast "Agent 导入了 32 张" / 新图高亮），延续 JobDock 的可见性理念。

## 待定问题

- `export_assets` 与 `crop_assets` 的实现先后（两者都依赖 sidecar 新命令）。
- escape-hatch 脚本 tool 是否纳入 v1。
