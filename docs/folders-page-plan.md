# 文件夹管理页设计方案

> **状态（2026-10-15）**：P1 已在 `feat/folders-page` 实现。页面是 `src/components/FoldersView.jsx`（纯逻辑在 `foldersPage.js`，单测同名），
> sidecar 的统计在 `db/collections.py collection_stats`（`tests/test_collection_stats.py`），e2e 是 `e2e/78-folders-page.spec.js`。
> 原型见 [prototypes/folders-page.html](prototypes/folders-page.html)。第 7 节的决定已于 2026-10-15 全部拍板：侧栏不截断、不做分组（保持扁平）、不做合并、封面取最近加入的那张。
>
> 与下文设计的差异：
> - 统计字段不走 `with_stats` 开关，`list-collections` 一律带上（一次 GROUP BY，几十毫秒），侧栏 / 发现页 / MCP `list` 直接读 `cover_preview_paths[0]`，不再各自取封面。
> - 文件夹少于 4 张时，没有就绪预览的照片不占拼图格。
> - 右键选中的是多选中的一个时，菜单对整个选区生效（只剩标注和删除）。
> - 页面内删除会先确认；侧栏里的单个删除按钮保持原样（不确认）。
> - "＋ 添加筛选"没做：四个 facet 常驻。
> - P2（带搜索的"加入文件夹"选择器、设封面、侧栏"最近使用"排序）未开始。

## 1. 问题

应用里的"文件夹"就是 `collections` 表里 `kind = 'manual'` 的那些行（智能合集是另一种 kind，不在本文范围）。
它们只有一个入口：侧栏。侧栏已经做了搜索、四种排序、文字 / 封面两种视图、拖拽排序（`Sidebar.jsx`、`folderList.js`），
几十个文件夹时够用，上百个之后这些手段都失效：

1. **列表长到一屏放不下，而侧栏只有那么宽。** 封面视图里每个文件夹单独调一次 `browseCollection(limit 1)` 取封面，`Sidebar.jsx:140` 和 `DiscoverView.jsx:214` 各写了一遍。
2. **看不到文件夹"里面是什么"。** 只有张数。没有时间跨度、没有最近一次加入的时间，分不清哪些是空的、哪些名字重了、哪些一年没动过。
3. **没有批量操作。** 删除是逐个悬停点垃圾桶；没有多选，没有"把这些都标注了"。
4. **右键"加入文件夹"子菜单是全量平铺**（`Gallery.jsx:321`），没有搜索也没有最近使用，超过一屏就不可用。
5. **拖拽排序对 100+ 个文件夹没有意义**，自定义顺序维护不过来，但它是默认排序。
6. `collections.parent_collection_id` 在 schema 里（`schema.py:198`），从没被任何代码写过。

## 2. 目标与非目标

**目标**

- 一个独立页面，在文件夹数量上百时也能找到、看清、整理文件夹：搜索、按多种维度排序、按状态筛（空 / 最近有变化）、多选、批量删除、批量标注。
- 每个文件夹一眼看到：封面、名称、张数、拍摄时间跨度、最近加入时间。
- 复用现有的页面骨架（`PeopleView` + `LibraryToolbar` 的做法），不发明新的 chrome。
- 顺手把文件夹封面的取法收口到一个 sidecar 查询，侧栏和发现页不再各自发 N 个请求。

**非目标**

- 不改文件夹的数据语义：仍然是扁平的手动合集，不做文件夹套文件夹（2026-10-15 用户定）。
- 不做合并文件夹（2026-10-15 用户定）。
- 不替换侧栏的列表（用户在那里形成了习惯），侧栏只加一个入口。
- 不做文件夹描述、不做拖拽照片到页面上的卡片（侧栏已经能接拖拽）。
- 不碰智能合集；它们继续待在侧栏上面那一节。

## 3. 页面设计

### 3.1 入口

- **侧栏**："文件夹"小节标题右侧那排小图标（搜索 / 排序 / 视图 / 新建）再加一个"管理"（lucide `FolderCog`），点了进页面，页面打开时这个图标是选中态（和搜索图标按下时一样的 `text-text`）。**不**在文件夹列表里加导航行，也不在列表末尾加"管理 N 个…"那种行——列表只放文件夹（2026-10-15 用户定）。
- **发现页**的"相册"货架右上角加"查看全部 ›"，进同一页（次要入口）。
- 菜单 视图 › 文件夹。快捷键不加；若要加，走 `shortcuts/store.js` 的可改绑体系。

进入页面时 `viewMode = "folders"`，和 `people` / `discover` / `stickers` 并列；`workspace.clearCollection()`，侧栏的文件夹行全部取消高亮。

### 3.2 布局

顶部**和全部素材页一样是两行**，样式直接复用（用户要求尽量复用 gallery 的筛选组件样式）：

```
行 1（Toolbar，h-11）   ＋   文件夹 · 128                       [最近加入照片 ▾]  ▦ ☰   [🔍 搜索文件夹]  [⚙︎¹]
行 2（FilterBar，h-6 chips） [状态 ▾] [张数 ▾] [拍摄时间 ▾] [最近加入 ▾]  ＋ 添加筛选                    清除 1
```

- 行 1：左边 `＋`（新建文件夹，和侧栏一样行内起名，建好后滚到它那里进入重命名态）、标题 + 过滤前总数；右边排序按钮（`Toolbar.jsx:182` 那个 100 px 宽的边框按钮）、网格 / 列表切换（`toolbar-modes` 的图标按钮样式）、搜索框（`Toolbar.jsx:357` 同款）、筛选开关（`SlidersHorizontal` + 角标数量）。`Toolbar.jsx` 本身和 gallery 的 props 绑得太死，不直接套用；做法是把它的 `IconButton`、排序按钮、搜索框抽成 `ui/toolbarParts.jsx` 给两边用，`LibraryToolbar` 也顺手换上。
- 行 2：复用 `FilterBar.jsx` 的 `Popover` facet 组件（导出它）和行容器的 class（`flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-chrome/60 px-2 py-1.5`），chip 是 h-6 圆角边框 + 11 px + `ChevronDown`，选中态 `border-accent/50 bg-accent/10`，右侧"清除 N"用 `ACTION_CHIP`。facet 见第 3.6 节。筛选开关关掉时行 2 收起，和 gallery 一样。
- 排序：侧栏的四种（自定义 / 名称 / 最近创建 / 照片最多）再加两种：**最近加入照片**、**拍摄时间**。排序和视图各自记在 localStorage（`folders.sort`、`folders.view`），与侧栏的键分开——侧栏按自定义顺序，页面按最近加入，是合理的组合。
- 搜索：只匹配名称，和侧栏一样用 `Intl.Collator` 不分大小写；输入即筛，Esc 清空。

内容区和人物页一样是一个滚动容器，按 80 个一页用 `IntersectionObserver` 追加（`PeopleView.jsx` 的 `PAGE_SIZE` 模式），不虚拟化。

### 3.3 网格卡片

```
┌──────┬───────┐
│      │       │   封面：1:1，圆角 12，多张图拼起来（规则见下）
├──────┼───────┤   空文件夹：填充色 + Folder 图标
│      │       │
└──────┴───────┘
 东京 2025                ← 名称，13px，一行截断，双击 / F2 改名
 128 张 · 3月–6月         ← 元信息，11px muted
```

封面拼图（用户 2026-10-15 要求）：取最近加入的最多 4 张，按张数定版式，缝 1 px 用面板底色：

| 张数 | 版式 |
|---|---|
| 1 | 整格 |
| 2 | 左右各半 |
| 3 | 左边一张通高，右边两张上下 |
| ≥ 4 | 2 × 2 |

每格 `object-fit: cover`，用 512 px 预览。列表视图的 28 px 缩略图和侧栏封面视图只用第一张，拼图在那个尺寸看不清。

- 卡片宽 160–200 px 自适应列数（`grid-template-columns: repeat(auto-fill, minmax(168px, 1fr))`）。
- 悬停：左上出现复选框；右上出现"…"按钮打开和右键一样的菜单。
- 选中：封面描 2px accent 环 + 复选框打勾（和人物页的 tile 一致）。

### 3.4 列表视图

密度高，上百个文件夹时比网格好用。表格列：

| 列 | 内容 | 可排序 |
|---|---|---|
| ☐ | 复选框 | — |
| 封面 | 28 px 缩略图 | — |
| 名称 | 行内可改名 | 是 |
| 张数 | 右对齐 tabular-nums | 是 |
| 拍摄时间 | `2025年3月 – 6月`；单月只写一个；无拍摄时间写"—" | 是 |
| 最近加入 | 相对时间（`3 天前`），悬停看绝对时间 | 是 |
| 创建于 | 日期 | 是 |

点表头排序，等价于工具栏的排序菜单（同一个状态）。列表视图不做拖拽排序。

### 3.5 选择与打开

- 单击选中（替换选区），⌘ / Ctrl 单击加减，Shift 单击范围选，⌘A 全选当前筛选结果，Esc 清空。锚点逻辑照抄 `PeopleView` 的 `selectionAnchorRef`。
- 双击或 Enter 打开文件夹：走现有 `onSelectCollection`，`viewMode` 回到 `assets`。
- 右键菜单（卡片和行相同）：打开、重命名、设为封面…（P2）、AI 标注未标注的、删除。多选时右键只保留能批量的项。

### 3.6 筛选行的 facet

都是 `FilterBar` 的 `Popover` 那种下拉 chip，选了之后 chip 文字变成摘要（"空的""最近 30 天"），和 gallery 一致：

- **状态**：全部 / 空的（`item_count = 0`，最常见的整理动作——建了没放、放了又移走）/ 30 天内有变化（`last_added_at` 在 30 天内）。选项带数量。
- **张数**：最少 / 最多两个数字框，复用 FilterBar 的数值区间控件。
- **拍摄时间**：复用 gallery 的日期 facet（最近 N 天 / 日期范围），按 `captured_from`–`captured_to` 与区间有交集算命中。
- **最近加入**：最近 N 天。

facet 之间是 AND，和搜索可叠加。"＋ 添加筛选"只在有未显示的 facet 时出现；第一版四个 facet 全部常驻，这个按钮可以先不做。

### 3.7 批量操作栏

选中 ≥ 1 个时底部浮出一条（居中、圆角、玻璃底，和编辑器里的浮条同材质）：

```
已选 7 个文件夹（共 1,204 张）     [AI 标注]  [删除]     ✕
```

- **删除**：一个确认框，"删除 7 个文件夹？照片本身不会被删除。" 沿用 `confirm.jsx`。删的里面有当前打开的文件夹时，确认后回"全部素材"。
- **AI 标注**：对每个文件夹调现有的 `runAnnotation({ scope: "collection", onlyMissing: true })`，排进同一个任务队列。

不做"批量重命名"：真实需求是前缀 / 序号那种，一旦做就要做规则编辑器，先不进。

### 3.8 空态

- 一个文件夹都没有：居中 Folder 图标 + "还没有文件夹" + "新建文件夹"按钮 + 一句话说明怎么往里放照片（拖到侧栏，或右键"加入文件夹"）。
- 搜索 / chip 无结果：灰字"没有匹配「xx」的文件夹"，沿用 `noFolderMatches` 的文案。

### 3.9 和侧栏、发现页的关系

- 侧栏列表**不改**行为，只加入口。拖拽排序、封面视图照旧。
- 侧栏封面视图和发现页相册货架改用第 4.2 节的 stats 取封面，删掉两处各自的 `browseCollection(limit 1)` 循环。这是顺手的清理，也让三处封面一致。
- 页面里改名、删除后，`loadCollections()` 刷新，侧栏和发现页自然跟着变——它们都读 `workspace.collections`。

## 4. 数据与后端

### 4.1 文件夹统计

`db/collections.py` 加 `collection_stats(connection) -> dict[collection_id, stats]`，一条 SQL 扫一遍 `collection_items`：

```sql
SELECT ci.collection_id,
       COUNT(*)                                             AS item_count,
       MAX(ci.added_at)                                     AS last_added_at,
       MIN(json_extract(a.metadata_json, '$.capture_time')) AS captured_from,
       MAX(json_extract(a.metadata_json, '$.capture_time')) AS captured_to
FROM collection_items ci JOIN assets a USING (asset_id)
GROUP BY ci.collection_id
```

不做 RAW 角标：应用里现在没有这种标记（发现页的「含 RAW」只是固定货架的筛选口径），第一版原型里画过，用户问起后去掉。

封面另一条，窗口函数（Python 3.12 自带的 SQLite 支持），每个文件夹取最近加入的 4 张给拼图：

```sql
SELECT collection_id, asset_id, rn FROM (
  SELECT ci.collection_id, ci.asset_id,
         ROW_NUMBER() OVER (PARTITION BY ci.collection_id ORDER BY ci.added_at DESC, ci.asset_id) AS rn
  FROM collection_items ci
) WHERE rn <= 4
```

再 join 出 `preview_path`。`list_collections` 加一个 `with_stats` 参数把这些并进每行（`cover_preview_paths`（最多 4 个，第一个就是单封面）、`last_added_at`、`captured_from`、`captured_to`）。30k 张、500 个文件夹是一次索引扫描，几十毫秒，不用缓存。

调用时机：页面打开、`collections` scope 的 catalog-changed 事件。侧栏日常的 `listCollections()` 不带 stats，仍然轻。

### 4.2 封面规则

P1：最近加入的那张。这和现在侧栏"browseCollection 第一行"的取法不同（那个是默认浏览排序的第一张，加照片时封面会跳），统一成"最近加入"后三处一致，而且用户往文件夹里放新照片时封面会换成新的，符合直觉。

P2：`collections` 加 `cover_asset_id TEXT`（schema 12，和 `local-models-lookalikes` 分支的 schema 12 要先对一下号），右键"设为封面…"从文件夹内容里挑；封面照片被移出或删除时字段置空回到默认规则。

### 4.3 传输层

- `api.listCollections({ stats })`；`electron/ipc` 和 `src/api/browser/bridge.js` 的 web 桥接各加一份（web 版用内存数据算 stats）。
- `useWorkspace.js`：批量删除就是循环现有的 `deleteCollection`，最后 `loadCollections()` 一次。

### 4.4 MCP

`manage_collections`：`list` 加 `with_stats`（返回上面那几个字段）。P2 的封面加 `set_cover`。每个新参数写进 `inputSchema`。`docs/agent-native-mcp.md` 顶部的 tool 计数不变（没有新 tool）。

## 5. 实施步骤

**P1 — 页面（约 2.5 天）**

1. sidecar：`collection_stats`、`list_collections(with_stats)`；`tests/test_collections_page.py`。半天。
2. 传输：IPC、web bridge、`api/`。小。
3. `src/components/foldersPage.js`：纯函数 `visibleFolderCards(collections, { sort, query, chip })`、`selectRange`、`formatCaptureSpan`，带单测（照 `folderList.test.js`）。半天。
4. `src/components/FoldersView.jsx`：工具栏、chip、网格 / 列表、选择、右键菜单、批量栏。`App.jsx` 加 `viewMode === "folders"`，`Sidebar.jsx` 加入口和选中态。1 天。
5. 侧栏封面视图和发现页改用 stats 的封面，删两处循环。小。
6. i18n（en / zh-CN）、MCP `with_stats`。小。
7. e2e `e2e/78-folders-page.spec.js`：建 3 个文件夹 → 进页面 → 搜索、排序、切列表 → 多选删除 2 个 → 侧栏数量同步 → 重启后还在。半天。

**P2 — 规模化辅助（约 1.5 天）**

1. `FolderPicker` 弹层：搜索框 + "最近使用"（最近 5 个加过照片的文件夹，localStorage）+ 全量列表，最大高度固定。右键"加入文件夹"在文件夹 > 8 个时改用它。
2. `cover_asset_id` + 右键"设为封面…"。
3. 侧栏排序加"最近使用"（和 picker 共用那份 localStorage 记录）。


## 6. 测试

- 单测：`foldersPage.test.js`（排序、chip、范围选择、时间跨度格式化含跨年 / 单月 / 无日期）；sidecar 的 stats（空文件夹、无拍摄时间、少于 4 张时的封面数）。
- e2e：第 5 节第 7 条；`26-mcp-parity` 补 `list` 的 `with_stats`。
- 手测：500 个文件夹（用 MCP `manage_collections create` 批量造）看页面首帧和滚动；侧栏封面视图切换时网络面板里不再出现 500 个 `browseCollection`。

## 7. 决策记录（2026-10-15 全部已定）

1. **侧栏不截断。** 侧栏继续显示全部文件夹，管理页只是多一个地方。
2. **不做文件夹套文件夹，保持扁平。** `parent_collection_id` 继续空着。
3. **不做合并。** 批量栏只有 AI 标注和删除。
4. ~~封面默认规则改成"最近加入"~~ **已定（2026-10-15）**：用最近加入的那张，侧栏现有封面会换一次，可接受。
5. **"30 天内有变化"的 30 天**要不要可调。建议不可调，chip 文案写死。

## 8. 风险

- `json_extract(metadata_json, '$.capture_time')` 没有索引，500 个文件夹 × 30k 张仍是单次扫描，但 catalog 到 200k 张时 stats 可能到几百毫秒；到时给 `collection_items` 的聚合加物化列（`assets.capture_time`），不是现在的事。
- 批量删除不可逆（照片还在，文件夹和成员关系没了）。确认框要写清个数；不做撤销。
- 页面和侧栏各有一套排序 / 视图偏好，用户可能以为是同一个。工具栏里排序菜单的标题写"此页面的排序"可以缓解。
