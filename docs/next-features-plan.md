# 下一批功能规划：MCP 接入配置、导入后自动分析人脸、手动修正地点、智能合集、相框模板与水印档案

> **状态（2026-09-20）**：进行中。A（MCP 接入配置，#82）和 B（导入后自动分析人脸，#87）已进 main，随 0.5.3 发布。C（手动地点）搁置。
> **优先级（2026-09-22）**：D（智能合集）v1 已进 main（#91），试用后按「两层筛选模型」重做了交互，见 D 节开头。顺带修了文件夹内筛选无效（#92）。F（拷贝编辑 / 粘贴编辑）暂停，见 F 节。E（相框模板）放到最后。
> 来源是对 `docs/` 历史计划的盘点，挑出未实现且对用户价值高的功能。
> 每个功能的现状都对照代码核实过（只读代码，未运行）。各功能的原始设计仍以各自的文档为准，本文只负责排期、落点和待决问题。

## 总览

| 批次 | 功能 | 原始设计 | 估时 | 依赖 |
|---|---|---|---|---|
| 1 | A. 设置里「复制 MCP 接入配置」 | `mcp-parity-plan.md:123` | 0.5 天 | 无 |
| 1 | B. 导入后自动分析人脸 | `people-recognition-design.md:252` | 0.5 天 | 无 |
| 搁置 | C. 手动修正地点，批量指定地点（按地名选） | `geo-map-design.md:573-574` | 剩余约 3 天 | 2026-09-18 搁置，sidecar 搜索已存档在分支上 |
| 3 | D. 智能合集 v1（保存的筛选条件，含「最近 N 天」） | `mcp-parity-plan.md:134` | 5 到 6 天 | 无 |
| 3 | D2. 智能合集 v2（其余规则扩展） | 同上 | 每项 0.5 到 1 天 | D |
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
   - 三个代码块（第三个见下方 Claude Desktop），各带复制按钮，URL 用实时端口拼出来，不写死
     - Claude Code：`claude mcp add --transport http afterframe http://127.0.0.1:<port>/mcp`
     - `.mcp.json` / Cursor：`{"mcpServers":{"afterframe":{"type":"http","url":"…/mcp"}}}`（与仓库自己的 `.mcp.json` 同形）
   - 端口被占用时，提示常见原因（另一个 AfterFrame 实例）和 `AFTERFRAME_MCP_PORT`
   - 文档链接
4. i18n：`settings.json` 的 en 与 zh-CN 各约 12 个 key。
5. 测试：`e2e/10-settings.spec.js` 加一条（状态为运行中、片段里的端口正确、工具数大于 0）；`getStatus()` 加单测。

**Claude Desktop（2026-09-18 已查）**：`claude_desktop_config.json` 只支持 stdio，没有 `url` 字段，也不认 `type: "http"`，即使是 localhost 也不行。它的「Connectors」是从云端连出去的，够不到本机。所以要给第三个代码块，用 `mcp-remote` 做桥：

```json
{"mcpServers":{"afterframe":{"command":"npx","args":["-y","mcp-remote","http://127.0.0.1:<port>/mcp"]}}}
```

旁边注明需要本机装有 Node。这一段上线前用真实的 Claude Desktop 验证一次。

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

> **2026-09-18 搁置。** 用户判断地图相关的手动标记不好做，先放一放。已完成并存档的部分：分支 `feat/set-location-by-place`（提交 `5977843`，已推送，未开 PR）里有 sidecar 的地名搜索 `search_places()`、`resolve_place_id()`、繁转简表 `data/t2s.json`（889 字，用 macOS 自带 ICU 生成，无新依赖）和 8 条单测。实测 27 万条地名上首次建索引约 0.6 秒，单次查询 12 到 70 毫秒。重启时从下面的步骤 2 接着做。
> 实测确认的事实：Wikidata 的 `zh` 标签繁简混排（东京是「東京都」、首尔是「首爾」），各层级 16% 到 45% 的中文名是繁体，不做折叠的话简体输入搜不到。
>
> 2026-09-18 修订：原方案「在地图上点击放置」作废。离线底图精度很低，用户既给不出精确 GPS，也没法在地图上点准。改为**按地名选**：用户只需要说出城市或知名景点。

**产品定位**

- 手动定位和 AI 猜的定位是**同一种东西**：一个城市级或景点级的地名，不是精确坐标。区别只是谁选的。
- 主要场景是「这批照片没有位置」。有 EXIF GPS 的照片一般不需要改，但允许改，手动的优先。
- 清除时手动和 AI 的定位一起删，保持现在 `--clear` 的行为，不需要改。

**现状**

- 离线地名库 `data/gazetteer.json.gz` 足够支撑这个交互：约 16.6 万个城市、10.2 万个景点、5351 个一级行政区、267 个国家。每条都有英文名、中文名、经纬度，以及 `links`（维基站点链接数，可以当热门程度用）。
- `asset_locations` 表已经有 `precision_level`（exact / locality / admin1 / country）、`place_id`、`country_code`、`admin1`、`locality`、`landmark` 这些列。**手动选的地名可以和 AI 解析出的定位存成完全一样的形状，只是 `source='manual'`。** 不需要改表。
- 这顺带解决了原方案的一个风险：手动定位不再是 `place_id` 为空的裸坐标，按地名筛选的模式能匹配到它。
- 但地名库今天只有「按精确名字查」的索引（`geo_resolver.Gazetteer.lookup`），没有搜索，也没有对渲染进程开放。
- 后端写入目前只支持单张加坐标（`cli.py:322`），渲染进程完全够不到（桥接表里没有对应的行）。
- inspector 的位置区块只在 EXIF 有 GPS 时显示，来源写死为 EXIF。手动定位今天在 inspector 里哪都不显示。

**交互**

选中一张或多张照片 → 右键菜单或 inspector 里的「设置位置…」→ 弹出一个地名搜索框 → 输入「京都」「Golden Gate」→ 下拉列表按热门程度排序，每行显示「名称 · 上级地区 · 国家」和类型（城市 / 景点）→ 选中即写入。

- 单张和批量是同一套机制。
- 不涉及地图交互，不需要暂停视口筛选，也不和网格的原生拖出冲突。
- 写入后地图自动出现对应的点（城市级的点按现有规则显示）。
- 搜索框下方列出「最近用过的地点」，连续给几批照片标同一个城市时不用重复输入。

**步骤**

1. **地名搜索（中）。** `geo_resolver.py` 加 `search_places(query, limit)`：
   - 对 `en`、`zh`、`aliases` 做前缀优先、子串其次的匹配，范围是景点、城市、一级行政区、国家四层。
   - 排序：前缀命中优先，其次按 `links` 降序。
   - 返回 `{place_id, name_en, name_zh, tier, lat, lon, country, admin1}`。
   - sidecar 是常驻进程，地名库只加载一次。27 万条线性扫一遍的耗时需要实测；不够快就在加载时建一个按首字符分桶的索引。
   - 新 CLI `search-places --q --limit`，补 pytest。
2. **按地名写入（小）。** `set-asset-location` 增加 `--place-id`，`--asset-id` 可重复，一个事务内完成。写入时复用 `_resolved()` 的逻辑，填 `precision_level`、`place_id`、地名各列和外接框，`source='manual'`。保留原有的 `--lat/--lng` 给 MCP 用。
3. **有效位置的优先级（小）。** 取有效位置的 CASE 表达式里让 `manual` 压过 RAW 的 EXIF 行。
4. **桥接（小）。** `commands.searchPlaces`、`commands.setAssetLocations`，桥接表加两行，handler 放 `electron/ipc/browse.js`，写完调 `broadcastCatalogChanged`。
5. **地点选择器（中）。** 新建 `src/components/map/PlacePicker.jsx`：输入框加下拉列表，输入防抖约 150ms，键盘上下选择、回车确认、Esc 关闭。中文界面优先显示中文名。
6. **入口（小）。** 网格右键菜单「设置位置…」；inspector 的位置区块改成读 `getAssetLocation`（区分来源，不再只认 EXIF），显示来源（GPS / AI 推测 / 手动），提供「设置位置…」和「清除位置」。
7. **写入后（小）。** `bumpCatalogRevision()` 刷新地图，toast「已为 N 张照片设置位置：京都」带「撤销」。撤销靠写入前抓的快照恢复；超过 50 张时不抓快照，只提供清除。
8. **MCP（小）。** `set_asset_location` 增加 `place_name` 或 `place_id` 参数，agent 也能说「这些是在京都拍的」。新参数写进 `inputSchema`（#79 的测试会强制）。
9. **i18n（小）**、**e2e（中）**：新建 `e2e/46-set-location.spec.js`：选两张无 GPS 的照片 → 打开选择器 → 输入地名 → 选第一项 → 断言 `getAssetLocation(id).source === "manual"` 且 `precision_level === "locality"` → 地图上 marker 数量增加 → 撤销。全程不需要点地图，Playwright 好写。

**风险**

- **地名库的中文名繁简混杂**（样例里有「阿爾及利亞」）。用户输入简体可能搜不到。需要在建索引时做一次繁转简归一化，或者同时索引两种写法。开工前先统计一下繁体条目的比例。
- 重名地点很多（全世界有很多个 Springfield）。靠「上级地区 · 国家」这一行加热门度排序来区分。
- 小众地点不在库里（入库门槛是至少 2 个维基站点链接，景点是 5 个）。兜底方案是让用户选到所在的城市。
- 搜索性能未实测。

---

## D. 智能合集

> **2026-09-22：两层筛选模型（用户拍板，取代下面 v1 里「FilterBar 本身就是规则编辑器」的做法）。**
>
> v1 上线试用后暴露的问题都出自同一个根源：应用没有区分「我在看哪个集合」和「我在这个集合里缩小到什么」。表现为：换位置时筛选条件有的保留有的清掉；筛选栏收起时筛选仍在生效；在智能合集里选一个格式会被当成「改了合集规则」，点「清除」会把规则清空变成全库；下拉里的计数含义不一致。
>
> **模型。** 第一层是位置（全部素材 / 最近添加 / 已评分 / 文件夹 / 智能合集 / 人物 / 地点），决定基础集合；智能合集的规则属于这一层。第二层是细化（筛选栏 + 搜索框），永远只在当前位置之内缩小。
>
> **三条已拍板的规则。**
> 1. 换位置时细化条件清空，排序保留（排序是偏好，不是某次查找）。
> 2. 只要有细化条件在生效，筛选栏强制展开，不能收起。
> 3. 排序在文件夹里生效；「加入时间」成为只在文件夹里出现的排序选项，离开文件夹回落到默认排序。
>
> **由此得到的行为。**
> - 打开智能合集：规则成为 `scope.base`（进浏览 key），筛选栏从空开始。「清除」回到整个合集，不是全库。下拉计数在 base 之内统计。
> - 合集内细化后可以「另存为」：新规则写成 `{…细化, base: 原规则}`，**嵌套而不是合并**（两层可能有同名条件，如都限定标签，合并只能留一个）。嵌套深度上限 4。也可以「把合集收窄到这里」，同样是嵌套在旧规则之上。
> - 文件夹内细化后可以存为智能合集：新增筛选维度 `in_collection`（文件夹成员关系作为条件），存出来的合集跟着文件夹走。
> - 「编辑条件」是侧栏行上的独立入口：进入后筛选栏显示合集自己的顶层条件，网格实时预览，保存 / 取消。嵌套的 base 在编辑时保持不变（筛选栏没法显示它）。
> - 下拉计数：每个数字 =「在当前其他条件下选中它会得到多少张」；分面忽略自己的细化条件（否则没法切换），但不忽略 base 里的同名条件。
>
> **落点。** sidecar `db/browse.py` 的 `_base_clause` / `_view_where`（browse、count、locate、地图点、分面计数都接受 `base`）；`hooks/workspaceLogic.js` 的 `rulesFromScope` / `scopeFromRules` / `editScopeFromRules` / `hasRefinement`；`hooks/useWorkspace.js` 的 `goTo()`（所有位置切换的唯一入口）。测试：`tests/test_two_layer_filters.py`、`workspaceLogic.test.js`、e2e 46 / 47。
>
> **没做的。** 人物仍然是一个细化条件而不是位置（从人物墙进入时是全新的 scope，但筛选栏里显示人物 chip）；AND 之外的逻辑（OR / NOT / 多值）；编辑嵌套规则里的 base 层。

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

1. `date_within_days`（「最近 30 天」）。这是「会自己更新的合集」最主要的存在理由。**已决定并入 v1 一起发。**
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

### 筛选功能的后续阶段（2026-09-21 起）

筛选是核心功能，按这个顺序做：

1. 多选（一个维度内任选其一）+ 筛选维度注册表 `db/facets.py`（#96，已合并）。
2. 位置来源（GPS / AI / 手动 / 无位置）、描述包含、图中文字包含、路径包含（#97，已合并）。
3. **国家/地区、城市（schema 9）。** 筛选项叫「国家/地区」而不是「国家」：ISO 3166 同时收录国家和地区（香港、澳门、台湾），显示名走系统的区域名（中国香港特别行政区），不自己起名。 每条位置记录在写入时用离线地名库反查出规范的国家（ISO 代码）和城市（地名库自己的城市：id、英文名、简体中文名），所以 GPS、AI 猜测、手动标记落在同一组选项上。值存规范名，界面按语言显示。AI 记录精度只到省或国家时不给城市（坐标是区域中心点，说明不了城市）。升级时对已有位置记录回填一次；升级前自动把数据库复制一份（`catalog.sqlite3.schema8.bak`）。国家由离线国界（Natural Earth 50m，`data/countries.json.gz`，`country_shapes.py` 点在多边形内）判定，地名库中心点只在海上兜底：按最近中心点猜国家在边境附近会错（香格里拉曾被算进缅甸）。城市优先取同一国家内的候选。地点数据版本 `PLACE_DATA_VERSION` 存在 `catalog_info`，数据或算法变了，图库下次打开自动重算全部行。已知取舍：反查按「重要性减距离」打分，大城市旁边的小城市可能被并进大城市（泽西城算进纽约）；50m 国界在边境线上约 1 km 误差，澳门 / 梵蒂冈这类太小的靠地名库自己的国家条目兜住。web 版没有地名库，这两个筛选不出现。
4. **用户自定义筛选栏。** 筛选栏末尾「＋ 添加筛选」列出全部维度，勾选常驻哪些；存的是「隐藏的集合」（localStorage，与主题、侧栏宽度同类），这样以后新加的维度默认对所有人可见。没勾但正在生效的维度照样显示（智能合集的规则、从人物墙进来的人物）：正在收窄网格的条件必须在栏上。
5. **色彩（schema 10）。** 调研了三种做法（PhotoPrism 固定 16 命名色、Eagle 任意颜色按距离匹配、Rayleigh 88 桶直方图），选了 Eagle 的形态：每张图从 512px 预览取最多 5 个主色（96px 缩图 median cut 10 色，Lab 距离 12 内合并，占比 2% 以下丢弃），存 hex、占比、Lab。筛选取任意颜色（24 色推荐色板 + HEX 输入），三档容差（严格 / 普通 / 宽松 = ΔE 15 / 25 / 40），匹配规则是「有一个占比 ≥ 3% 的色块在容差内」，SQL 里算平方距离；多选是含任意一个；色块不做计数。Inspector 预览下一条色板，按占比分宽，点一下按该色筛选。提取挂在预览生成里（同一份缩图），存量图库打开时自动跑一个低优先级的「色彩分析」任务补齐。web 版没有，隐藏。以后：按颜色排序、以图找相似配色。

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

## F. 拷贝编辑 / 粘贴编辑（批量处理）

> **2026-09-20 暂停，未进 main。** 代码完整（PR #89，草稿，分支 `feat/paste-edits`），在 dev 里试用后用户判断它是半成品：苹果的这个功能建立在「每张照片都保存着自己的编辑状态」之上，可以从任意一张编辑过的照片拷贝、重新打开接着调、随时回溯；AfterFrame 每次保存只生成一个新文件，不记录它是怎么来的。结果是只能在编辑器开着时拷贝，一次粘贴 50 张没法一键撤销，事后也看不出每张图被改了什么。
>
> **重启的前提：先设计编辑状态的存储。** 已有的落点：`asset_links.recipe_json` 这一列从建表起就在，目前只被批量拼图用来存排序；`mcp-parity-plan.md:66` 和 `unified-canvas-plan.md` Phase 6 都提过把编辑配方存下来，从未实现。思路：保存时把配方写进「原图 → 产物」的链接，由此得到从图库拷贝编辑、在原图上重新编辑（而不是在烘焙过的产物上再压一遍）、撤销一次粘贴。不照搬苹果的「编辑只存参数不落盘」：AfterFrame 是本地优先，用户在 Finder 和别的软件里看到的必须是真实文件。旧产物没有配方，查不到来源。
>
> 不管界面最后怎么做，这个分支里值得保留的部分：`imageDisplaySize`（catalog 里的宽高没应用 EXIF 方向）、`processAndSave` 的 `avoidOverwrite`、`updateToast`、纯几何逻辑 `pasteEdits.js` 和它的单测。
>
> 以下是暂停时的设计，原样保留。参照 iPhone 相册的操作模型。

**范围（用户拍板）**：只做容易批量的几何操作。不做调色（应用里本来就没有任何调色功能），不做文字、贴纸、相框的批量。产物放在每张原图的同目录。

**流程**：编辑器里调好一张 → 「拷贝编辑」→ 勾选要带走哪些（只列出这张图上实际改过的）→ 回到网格多选 → 右键「粘贴编辑」→ 顺序执行并显示进度 → 完成提示（成功几张、跳过几张，可在 Finder 中显示）。

**可拷贝的项目**：旋转 90°、翻转、裁剪（默认勾选）；校正角度（默认不勾，它通常是针对某一张调的）。全部走主进程的 `processAndSave`（sharp，全分辨率，不需要编辑器窗口），不经过长边 2200 像素的编辑器 canvas。

**裁剪的粘贴规则**：目标图与源图宽高比一致（容差 1%，比较发生在粘贴的 90° 旋转之后）时套用同一个相对裁剪框，位置也一致；不一致时保留裁剪比例并居中。粘贴了校正角度时，裁剪框一定内接于旋转后的照片，否则四角会留空。

**产物**：原图同目录，`<原名>_edited.<ext>`，重名自动加序号，登记为原图的一个版本。原图不动。

**跳过**：视频、RAW、HEIC（sharp 读不了）。以后可以改用高清预览图当源。

**做不到的一点**：编辑器保存后不保留编辑参数，所以只能在编辑器打开时拷贝，不能像 iPhone 那样对相册里任意一张编辑过的照片拷贝。要支持它，得在保存时把参数存下来（`mcp-parity-plan.md:66` 提过，未实现）。

**步骤**

1. ✅ 纯逻辑 `src/components/editor/pasteEdits.js` 加 14 条单测。
2. ✅ 剪贴板状态（`src/utils/editClipboard.js`，存 localStorage）和编辑器头部的「拷贝编辑」按钮加勾选面板。
3. ✅ 网格右键「粘贴编辑」：过滤目标、顺序执行、一个原地更新的进度提示、完成提示（`src/utils/runPasteEdits.js`）。
4. ✅ 目标图的显示尺寸：catalog 里的宽高是没应用 EXIF 方向的原始像素尺寸，不能用。新增主进程接口 `imageDisplaySize`（只读文件头）。
5. ✅ i18n（en + zh-CN）、e2e `46-paste-edits.spec.js`。
   - e2e 顺带抓到一个 main 上已有的 bug：`processAndSave` 保存后保留了源文件的 EXIF 方向标签，竖拍手机照片在别的看图软件里会再被转一次。单独修在 #88。
6. 以后：MCP 暴露、RAW 和 HEIC 走高清预览、从已保存的版本拷贝。

---

## 已拍板的事（2026-09-18）

| # | 问题 | 结论 |
|---|---|---|
| 1 | C 的交互 | **按地名选**（城市或景点级）。不用地图点击，也不用拖拽：底图精度太低，用户给不出精确位置 |
| 2 | C：RAW 的 EXIF 位置和手动位置冲突 | 主要场景是没有位置的照片；有位置的也允许手动改，手动优先 |
| 3 | C：清除位置的行为 | 手动和 AI 的定位等价，清除时一起删。保持现有 `--clear` 行为 |
| 4 | D：智能合集的形态 | 就是保存的筛选条件，不做独立的规则引擎 |
| 5 | D：「最近 N 天」 | 要，和 v1 一起发 |
| 6 | E：动态图层保留 source，改过即 dirty | 接受 |
| 8 | A：Claude Desktop | 不支持本机 HTTP，给 `mcp-remote` 桥接片段 |

## 还没定的事

| # | 问题 | 说明 |
|---|---|---|
| 7 | E：「导出设置」的文件里要不要包含用户导入的 logo 图片？ | 应用已有「导出 / 导入设置」功能（`settings-transfer-plan.md`，P1 已实现），用来换电脑时迁移设置。问题是用户自己导入的 logo 图片要不要一起打包进那个文件。到做 E 的第 8 步时再定，不影响前面的任何一步 |
