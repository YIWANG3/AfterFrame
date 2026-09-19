# 下一批功能规划：MCP 接入配置、导入后自动分析人脸、手动修正地点、智能合集、相框模板与水印档案

> **状态（2026-09-18）**：规划稿，未开工。来源是对 `docs/` 历史计划的盘点，挑出 5 个未实现且对用户价值高的功能。
> 每个功能的现状都对照代码核实过（只读代码，未运行）。各功能的原始设计仍以各自的文档为准，本文只负责排期、落点和待决问题。

## 总览

| 批次 | 功能 | 原始设计 | 估时 | 依赖 |
|---|---|---|---|---|
| 1 | A. 设置里「复制 MCP 接入配置」 | `mcp-parity-plan.md:123` | 0.5 天 | 无 |
| 1 | B. 导入后自动分析人脸 | `people-recognition-design.md:252` | 0.5 天 | 无 |
| 2 | C. 手动修正地点，批量指定地点 | `geo-map-design.md:573-574` | 2 到 3 天 | 无 |
| 3 | D. 智能合集 v1（保存的筛选条件） | `mcp-parity-plan.md:134` | 4 到 5 天 | 无 |
| 3 | D2. 智能合集 v2（相对日期等规则扩展） | 同上 | 每项 0.5 到 1 天 | D |
| 4 | E. 水印档案、相框存为模板、导入自己的 logo | `frame-watermark-plan.md:285-303`、`unified-canvas-plan.md:153-160` | 6 到 8 天 | 需要先拍板一个悬而未决的设计问题 |

排序原则：先做半天能完成、立刻有人受益的（A、B）；再做后端已有、只差界面的（C）；然后是改动面最广的（D）；最后是范围最大、还有设计问题没定的（E）。

每个功能一个分支、一个 PR。所有新增的 IPC 都要在 `apps/desktop/shared/ipcChannels.mjs` 的表里登记一行，`electron/ipcChannels.test.js` 和 `src/api/apiSurface.test.js` 会强制「一行一个 handler」。

---

## A. 设置里「复制 MCP 接入配置」

**现状**

- 端口在 `electron/main.js:740` 一次性决定：`AFTERFRAME_MCP_PORT`，否则打包版 41706、dev 41707。
- **没有 token，也没有局域网模式**。server 只绑 `127.0.0.1`（`electron/mcp/server.js:1624`），`:1560` 记录了「不做 token 是用户的明确决定」。界面上不要出现 token 字段。
- server 不能关闭；`start()` 遇到 `EADDRINUSE` 会吞掉错误返回 `null`，没有任何地方记录它是否在运行；渲染进程读不到端口。
- 应用里目前没有任何 MCP 相关界面。
- 落点现成：`src/components/settings/IntegrationsSettings.jsx`，它的 tab 已经由 `cap: "integrations"` 控制，web 版自动显示「仅桌面版」，不需要额外处理。

**步骤**

1. `electron/mcp/server.js`：记录状态 `starting / running / port_in_use / error`，加 `getStatus()` 返回 `{status, port, url, toolCount, error}`。
2. `electron/main.js`：`ipcMain.handle("app:mcp-status", …)`。桥接表加一行 `["getMcpStatus", "app:mcp-status", 0]`。
3. 新建 `src/components/settings/McpConnectionGroup.jsx`，放在 Integrations 页的编辑器分组上方：
   - 状态点加文字（运行中、端口被占用、出错），URL，工具数量
   - 两个代码块，各带复制按钮，URL 用实时端口拼出来，不写死
     - Claude Code：`claude mcp add --transport http afterframe http://127.0.0.1:<port>/mcp`
     - `.mcp.json` / Cursor：`{"mcpServers":{"afterframe":{"type":"http","url":"…/mcp"}}}`（与仓库自己的 `.mcp.json` 同形）
   - 端口被占用时，提示常见原因（另一个 AfterFrame 实例）和 `AFTERFRAME_MCP_PORT`
   - 文档链接
4. i18n：`settings.json` 的 en 与 zh-CN 各约 12 个 key。
5. 测试：`e2e/10-settings.spec.js` 加一条（状态为运行中、片段里的端口正确、工具数大于 0）；`getStatus()` 加单测。

**待核实**：Claude Desktop 是否接受 `type: "http"` 的条目，没有确认。上线前验证；不行就只标「Claude Code / Cursor」，或提供 `npx mcp-remote` 的桥接写法。

---

## B. 导入后自动分析人脸

**现状**

- 标注的 `autoOnImport` 是在**渲染进程**里触发的：`src/App.jsx:555-562`，`onJobFinished` 里判断 `jobType === "import" && status === "succeeded"`。照这个模式抄。
- `startPeopleIndex()` 在没有可用模型时会抛错；已有 people job 在跑时直接返回那个 job，不会起第二个，等于自带防抖。
- 人脸任务是增量的（已索引的图按输入哈希跳过），可暂停、可恢复，JobDock 已经能显示。
- 标注和人脸是两个独立的 sidecar 进程，一个吃网络、一个吃本地 Core ML，同时跑可以接受。

**步骤**

1. `electron/ipc/people.js`：`state()` 加 `autoIndexOnImport`；新 handler `workspace:set-people-auto-index`，照抄 `set-people-auto-download`（`:378`）。桥接表加一行。
2. `PeopleSettings.jsx`：索引分组里加一个开关，模型不可用时禁用。
3. `App.jsx:555`：标注判断之后，读人物设置；开关打开且模型可用时 `api.startPeopleIndex({priority: 1})`（低于手动触发的 5），再派发 `people-index:started`。包在 try/catch 里，前置条件不满足时不弹任何提示。用 `api.can("people")` 守卫。
4. i18n：标题「导入后自动分析人物」；说明「默认关闭。导入完成后在后台分析新照片，需要已安装模型，可在任务栏暂停。」
5. 测试：沿用 `e2e/18-people-flows.spec.js` 的配方（`catalogFixture: "people"`）。测「没装模型时开关禁用」和「没装模型时导入不报错」；开关打开的路径用 people.js 的单测覆盖。

**不要承诺的事**：设计文档明确说过，编辑或导出时自动降速、空闲恢复、低电量感知都还没做。开关的说明文字不能写「不会拖慢你的 Mac」。

**已知局限**：触发点在渲染进程，导入中途关窗就不会触发。标注今天也是这样。每次导入后聚类阶段都会整体重跑；库很大时可以以后再把新导入的 asset id 传下去。

---

## C. 手动修正地点，批量指定地点

**现状**

- 后端只支持单张加坐标：CLI `set-asset-location`（`cli.py:322`）收一个 `--asset-id` 加 `--lat/--lng` 或 `--clear`。MCP 工具是逐张循环调用。
- 写入的是 `source='manual'`、`precision_level='exact'`，地名字段全空。EXIF 和 AI 的写入路径不会覆盖手动行。
- **`--clear` 会连 AI 的定位一起删掉**：它删掉现有的任何一行，再从元数据重建 EXIF 行。清除手动定位后，之前的 AI 猜测不会回来，除非重跑 `resolve-ai-locations`。
- 渲染进程完全够不到这个功能：桥接表里没有对应的行。
- 地图（`PhotoMap.jsx`，maplibre-gl，离线底图）没有右键、没有空白处点击、没有 drop 处理。
- inspector 的位置区块只在 EXIF 有 GPS 时显示，来源写死为 EXIF。手动定位今天在 inspector 里哪都不显示。
- 一旦用户平移地图，视口筛选会把没有位置的照片从网格里筛掉。所以任何「放置」流程都必须先暂停视口筛选。

**交互方案：选中照片 → 「设置位置…」→ 在地图上点一下**

不做「把照片拖到地图上」，原因：

- 桌面版的网格拖拽已经被原生文件拖出占用（`Gallery.jsx:366-407`），没有 HTML5 的 `dragend`，落在地图上的方案很脆。
- Playwright 驱动不了原生拖拽，没法写 e2e。
- 点击放置对单张和批量是同一套机制；「放置模式」是显式状态，暂停视口筛选很简单。

**步骤**

1. **sidecar 批量化（小）。** `--asset-id` 可重复，一个事务内完成。`--clear` 改成只清 `source='manual'` 的行。补 pytest。MCP 的循环改成一次批量调用。
2. **桥接（小）。** `commands.setAssetLocations`，桥接表加一行，handler 放 `electron/ipc/browse.js`，写完调 `broadcastCatalogChanged`。
3. **放置模式（中）。** `App.jsx` 里加 `placing = {assetIds}` 状态，它会展开地图，并给 `useMapViewportFilter` 传 `enabled: false`。`PhotoMap` 加 `placing` 属性：十字光标，`map.on("click")` 返回经纬度，放置期间忽略 marker 点击。`MapDrawer` 顶部一条横幅：「在地图上点击，放置 N 张照片 · Esc 取消」。
4. **入口（小）。** 网格右键菜单「设置位置…」；inspector 的位置区块改成读 `getAssetLocation`（区分来源，不再只认 EXIF），来源是手动时显示「设置位置…」和「清除手动位置」。
5. **写入与撤销（小）。** 点击后写入，`bumpCatalogRevision()` 刷新地图，toast 带「撤销」。撤销靠写入前抓的快照恢复；超过 50 张时不抓快照，只提供清除。
6. **i18n（小）**、**e2e（中）**：新建 `e2e/46-set-location.spec.js`，照 `23-map.spec.js` 的写法，等 `data-map-ready`，用 `map.click`。

**v2**：地名搜索。gazetteer 今天只有精确名索引，没有对渲染进程开放。需要新 CLI `search-places`、桥接和一个 inspector 里的搜索框；同时用现成的反向地理编码给手动点补上地名。

**风险**

- dev 下 StrictMode 会把 effect 挂两次，点击监听要注册在只执行一次的构造 effect 里，用 `callbacksRef` 取最新回调。
- 低缩放级别下点一下的精度很差。考虑要求缩放 ≥ 5，或者弹确认。
- **RAW 优先的有效位置**：RAW 的 EXIF 行会压过写在图片上的手动定位。要么两边都写，要么在取有效位置的 CASE 表达式里让 manual 优先。需要定一个。
- 手动定位的 `place_id` 为空，按地名筛选的模式匹配不到它。

---

## D. 智能合集

**核心结论：不需要新的规则引擎。** 智能合集就是一份保存下来的 `{status, search, filters, sort}`，由渲染进程解析成普通的浏览 scope，走现有的浏览路径。这样浏览、定位、地图点、排序、翻页都不用改 sidecar，web 版也直接能用。

**现状**

- 表结构已经有：`collections.kind CHECK IN ('manual','smart')`、`rules_json`。`SCHEMA_VERSION = 8`，v1 **不需要迁移**。
- `rules_json` 有地方写，没有任何地方读。`commands.createCollection` 会把 rules 丢掉。
- 侧栏只渲染 `kind === "manual"` 的行，智能合集今天是隐形的。`item_count` 只统计 `collection_items`，智能合集永远显示 0。
- 现有筛选维度已经够用：相机、镜头、ISO、光圈、焦距、快门、拍摄日期、最低评分、方向、类型、标签、扩展名、人脸、是否标注、人物、地理范围。
- FilterBar 自己不持有状态，渲染的就是同一个扁平的 filters 字典。所以「打开智能合集 = 把它的筛选条件装进 FilterBar」，**FilterBar 本身就是规则编辑器**。

**v1 步骤**

1. **规则格式（小）。** `rules_json = {"version":1, "status", "search", "filters", "sort"?}`。旧的 `'[]'` 按空处理。新建 `db/smart_rules.py` 做解析和白名单校验，白名单与 `_facet_clauses` 的 key 集合共用一个常量。
2. **sidecar 求值（中）。** `db/browse.py` 加 `count_image_assets`；抽一个共享的 `_browse_where(status, search, filters)`；`browse_collection`、`locate_image_asset`、`list_map_points`、标注目标、`job_runner` 遇到智能合集 id 时改走规则。`list_collections` 给智能合集填实时数量。`add_collection_items` 拒绝智能合集。新建 `tests/test_smart_collections.py`。
3. **传输（小）。** `createCollection` 多传一个 `rulesJson`，桥接表里的 arity 从 2 改成 3。
4. **渲染进程 scope（中）。** `DEFAULT_SCOPE` 加 `smartCollectionId`（只用于显示，不进 `scopeKeyOf`）。`workspaceLogic.js` 加 `rulesFromScope`、`scopeFromRules`、`rulesDirty` 和单测。规则里带 `person_group` 而该分组已不存在时，丢掉这个条件并提示。
5. **界面（中）。**
   - FilterBar：「清除」旁边加「存为智能合集」；当前 scope 与已存规则不一致时显示「更新」和「另存为」。
   - 侧栏：文件夹上方加「智能合集」小节。行不能作为拖放目标，不能拖动排序。悬停操作：改名、删除、「快照为普通合集」。
   - 处于智能合集时，隐藏「从合集移除」和按加入时间排序。
   - 图标用 lucide 的 `FolderSearch` 或 `ListFilter`。`Sparkles` 已经被 AI 功能占用，不要用。
6. **web bridge（小）。** 存 `rules_json`，用现有的筛选谓词算数量。
7. **MCP（小到中）。** `manage_collections`：`create` 支持 `kind: "smart"` 加 `rules`（与 `search_assets` 的参数同形）、新动作 `update_rules`、`list` 返回规则和实时数量、对智能合集 `add_items` 返回明确的错误。`search_assets` 加 `collection_id`。重写 server instructions 里「智能合集在这里只读」那句。每个新参数都要写进 `inputSchema`。
8. **i18n（小）**、**e2e（中）**：新建 `e2e/46-smart-collections.spec.js`（设最低评分 → 保存 → 行出现且有数量 → 再给一张图评分 → 数量和网格更新 → 重启后还在 → 快照为普通合集）；`26-mcp-parity.spec.js` 补智能合集的创建和浏览。

**v2：按价值排序的规则扩展**

每一项都是同样的四处改动：`_facet_clauses` 一个 `add(...)`、web bridge 的 `matchesFacetFilters` 一行、MCP 一个属性、FilterBar 一个控件。

1. `date_within_days`（「最近 30 天」）。这是「会自己更新的合集」最主要的存在理由，建议紧跟 v1。
2. `tags_all` / `tags_any` 多标签。
3. `rating_max` 或 `rating_eq`，支持「未评分」。
4. 排除条件（NOT）。
5. 属于或不属于某个普通合集（需要防循环）。
6. 多相机、多镜头（IN）。
7. 通用的 OR 分组。需要单独的规则编辑对话框，延后。

**风险**

- 绕过渲染进程直接调 sidecar 的调用方，可能看到不一致的集合。所以只保留一个 `_browse_where`。
- 保存的是绝对日期：用户以为存的是「今年」，实际是固定区间。v2 第 1 项解决。
- 数量只在 `catalogChanged` 触发时刷新，要覆盖 assets、评分、标签三种 scope，不只是 collections。
- web bridge 的 `matchesFacetFilters` 是筛选逻辑的第二份实现，容易漂移。每个 key 加一个共享 fixture 测试。
- 规则里存的 `person_group` 和 `place_id` 可能过期。

---

## E. 水印档案、相框存为模板、导入自己的 logo

**两个会改变范围的发现**

1. **「把当前效果存为模板」不是简单的序列化。** 应用模板的时候，模板被「去锚点化」，来源信息全丢了：文字图层存的是解析后的字符串而不是 token；logo 变成了 `stickerPath` 是上色后 data URL 的贴纸图层；留白被换算成短边基准。只剩一个 `fromPreset: true`。
2. **用户模板没法直接被 MCP 的 `apply_frame` 使用。** `apply_frame` 走的是 `renderFrame` 烘焙路径，只认静态的 `FRAME_TEMPLATES`。用户模板得走图层路径。

**需要先拍板的设计问题**（`unified-canvas-plan.md:190` 的悬而未决问题 2）

文档自己的建议是：「动态图层保留 `source`；用户改过的图层标记为 dirty」。这一批功能绕不开它。下面的步骤 2 假设接受这个建议：

- 应用模板时，给文字图层盖上 `tokenSource`（原始的带 token 字符串），给 logo 图层盖上 `logoRef: {variant, color, kind}`。
- 用户手动改了某个文字图层的内容，就清掉它的 `tokenSource`。
- 保存模板时，产出第二种模板 `{kind: "layers", canvas, layers}`，坐标用整张照片的相对坐标，文字从 `tokenSource` 还原成 token。
- 不做「从图层反推锚点」。

**文档里已经锁定的约束**

- 水印元素就是图层，不引入新的渲染器（`frame-watermark-plan.md:37-39`）。
- 用户看到的模板是「内置 ∪ 用户」，用户永远不手写 JSON，模板可以改名、删除、复制（`:72-78`）。
- 档案存在 app settings 里（`:285-286`）。
- 导入 logo 是把文件拷进 userData 加 manifest，通过 `media://` 读取；单色 SVG 可上色，PNG 和彩色 SVG 锁色（`:169-176`）。
- 品牌 logo 隔离在 `frame-logos/`，可以一步移除（`:8-15`）。

**步骤**（每一步都能独立上线）

1. **档案打通（小）。** 桥接表加 `getWatermarkProfile` / `saveWatermarkProfile`，用 `updateAppSettings` 存 `settings.watermarkProfile = {author, avatarFile, defaultLogoId}`。`{author}` token 其实已经实现了，只是所有调用方都传 `profile: {}`（`state/useFrameTool.js` 两处、`src/agent/renderBridge.js:221`），改成传真实档案。web 版用 localStorage。补 `frameRender.test.js`。
2. **图层来源标记（中）。** 如上。确认 `useEditorHistory` 会克隆新字段、`editorStateModel` 的相等比较覆盖它们。
3. **设置里的「水印」页（中）。** 新建 `settings/WatermarkSettings.jsx`，先只做作者名。
4. **模板持久化（中）。** 新建 `electron/ipc/frameTemplates.js`，存 `userData/afterframe/frame-templates.json`，照抄 `ai.js:24-38` 的整存整取。`useFrameTool.templates` 变成内置 ∪ 用户，用户模板的 id 加 `user:` 前缀。`generatePresetLayers` 加 `kind: "layers"` 分支：重新解析 token 和 logo。
5. **存为模板的界面（中）。** `editor/TextPanel.jsx` 的边框区块里加保存、改名、复制、删除。保存时丢掉 data URL，只留 `logoRef`。
6. **MCP（小）。** `get_editor_capabilities` 返回并集并标 `user: true`；`handleFrame` 遇到用户模板走图层路径。扩展 `e2e/28-mcp-render.spec.js`。
7. **导入 logo（大）。** 主进程：文件选择、校验类型和大小、**清洗 SVG**（去掉脚本和外部引用）、拷进 `userData/afterframe/frame-logos/`、写 manifest、`addAllowedMediaDir`。设置页里加「我的 logo」列表、默认 logo、头像。TextPanel 里加「添加我的 logo / 签名」，产出带 `logoRef: {source: "personal"}` 的贴纸图层；签名复用 `HandwritingModal`。web 版没有文件导入，需要一个 capability 开关。
8. **设置迁移（小）。** `electron/settingsTransfer.js` 加 `watermark` 分区，带上档案和模板。logo 文件要么限制大小后 base64 内嵌，要么明确写「不包含」。

**测试**：照 `e2e/20-frame.spec.js`（fixtures 目录、`applyFramePreset` / `saveAs` 后门、sharp 像素断言）。新建 `e2e/46-frame-user-templates.spec.js`：保存 → 重启 → 模板还在 → 应用到另一张照片 → 断言 token 按新照片重新解析。

**风险**

- 在裁过或转过的照片上保存的模板，必须归一化成相对留白的坐标。要用一张宽高比不同的照片来测。
- 导入的 SVG 是 XSS 和 `media://` 的风险点。
- 用户 logo 如果覆盖了内置 id，内置模板的缩略图也会跟着变。
- 模板 id 必须稳定，只允许改显示名，否则拿着旧 id 的 agent 会失效。
- 重新应用模板时，DOM 测量之前字体必须已经加载。

---

## 待你拍板的事

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | C 的交互用「点击放置」还是「拖到地图」？ | 点击放置。拖拽和原生文件拖出冲突，也没法写 e2e |
| 2 | C：RAW 的 EXIF 位置和图片上的手动位置冲突时谁赢？ | 手动优先，改 CASE 表达式 |
| 3 | C：`--clear` 是否改成只清手动行？ | 是。现在的行为会误删 AI 定位 |
| 4 | D：智能合集就是「保存的筛选条件」，不做独立的规则引擎？ | 是 |
| 5 | D：v2 的「最近 N 天」要不要紧跟 v1 一起发？ | 要。否则「今年」会变成固定区间 |
| 6 | E：接受「动态图层保留 source，改过即 dirty」？ | 接受。不接受的话，存为模板基本做不了 |
| 7 | E：设置备份里要不要包含 logo 文件？ | 限制大小后内嵌 |
| 8 | A：Claude Desktop 的配置片段怎么给？ | 先核实；不确定就只标 Claude Code / Cursor |
