# Review 简报：离线地图 Phase 1（feat/geo-map）

> 供评审 agent 使用。评审意见请直接追加到本文末尾的「Review Findings」区，按惯例：每条 finding 一个 checkbox 跟踪修复，误报保留并注明 REFUTED 理由。

## 背景与范围

AfterFrame（Electron + React 桌面照片库，Python sidecar 管 SQLite catalog）新增完全离线的地图浏览：按 EXIF GPS 在地图上聚合展示照片，地图视窗作为 Gallery 的地理筛选条件。设计文档：[docs/geo-map-design.md](../geo-map-design.md)（从 research/geo-overview-lab 原型拷入，原型目录整体被 gitignore）。

本期只做 **Phase 1（GPS-only）**：不含 AI 地名解析（Annotation location_json → 坐标的离线 Gazetteer 是 Phase 2），不含手动指定位置（Phase 3）。

分支共 4 个提交：

1. `fix(editor)` — 与地图无关的既有小修复（编辑器保存后 preserveView 刷新），从工作区一并带入，独立成提交。
2. `feat(sidecar)` — Schema 8 + 地理查询 + browse-map-points。
3. `feat(desktop)` — 地图 UI 全部 + E2E fixture 重建。
4. `docs` — 设计文档拷贝 + 本简报。

## 用户拍板的决策（评审时视为既定，不要挑战）

- 只做 Phase 1；约 22 MB 地图数据直接进包，admin1 边界不做量化压缩。
- 展开动画最初按设计文档 820ms，用户试用后改 400ms。
- 与设计文档 §3.4 规则 5 相反：**收起地图自动清除** filters.geo。
- 无离线角标；左下角为可点击的 世界/地区/城市 层级切换器。
- Toolbar 四个排版按钮收进一个下拉；删除了前进/后退按钮（原实现只记录 status 切换且回退不清 activeCollectionId，属半残功能）。
- 深色主题地图配色为中性灰黑（无青蓝色相）。

## 架构与数据流

```
EXIF GPS (metadata_json)
  → db/locations.py: asset_locations + asset_location_rtree（应用层同事务维护，无触发器）
  → browse.py _facet_clauses filters.geo（R*Tree EXISTS；west>east 拆两段）
  → cli.py browse-map-points（复用 gallery scope，刻意忽略 filters.geo）
  → electron commands.js / ipc browse.js / preload → api.browseMapPoints
  → useMapPoints（按 catalog+scope 缓存，仅移动视窗不重取）
  → PhotoMap（MapLibre GeoJSON clustering → DOM marker 复用池）
  → 用户拖动 → useMapViewportFilter（250ms debounce）→ workspace.applyFilters({geo}) → Gallery 刷新
```

关键文件：

- Sidecar：`services/sidecar/src/media_workspace/{schema.py, db/migrations.py, db/locations.py, db/browse.py, db/assets.py, db/maintenance.py, cli.py}`；测试 `services/sidecar/tests/test_locations.py`（unittest，16 例）。
- Desktop：`apps/desktop/src/components/map/*`（PhotoMap/MapDrawer/MapResizeHandle/PhotoClusterMarker/useMapPoints/useMapViewportFilter/antimeridian/mapData/map.css）、`App.jsx`（工作区 grid 分栏 + 快捷键 M + 收起清筛选）、`Toolbar.jsx`（布局下拉 + Map toggle）、`FilterBar.jsx`（geo chip）、`Inspector.jsx`（位置来源行）、`electron/{sidecar/commands.js, ipc/browse.js, preload.js}`、`src/api/index.js`。
- 数据：`apps/desktop/src/data/maps/`（admin1 线 17.5MB topo + admin1 标签 + 城市点，Natural Earth 衍生，Vite 动态 import 分包）；`world-atlas` npm 包提供陆地/国界。许可记录 `apps/desktop/licenses/map-data.txt`。
- E2E：`apps/desktop/e2e/23-map.spec.js`；fixture `test-catalog.afcatalog` 重建为 schema 8（001-red=巴黎、002-orange=东京），`seed-catalog.js` 新增 GPS 注入与确定性导入顺序（视频时间戳回拨，避免"第一张卡是视频"破坏依赖首卡为图片的旧 spec——旧 fixture 靠同秒 stem 排序侥幸通过）。

## 与设计文档的实现偏差（有意为之）

1. 地图数据不放 `public/maps/` 静态目录：生产环境 renderer 走 `file://`，`fetch` 拿不到静态资源；改为 Vite 动态 `import()` 分包（Vite 7 对大 JSON 走 `JSON.parse` 快速路径）。主包体积不受影响（构建产物已核对）。
2. 日期变更线切割保留为运行时模块 `antimeridian.js`（原型验证过性能足够），未做构建期预处理。
3. 未建 `idx_asset_locations_asset` 索引：`asset_id UNIQUE` 已隐含索引，再建纯浪费。
4. 未用 `map.resize()` rAF 循环：MapLibre v5 自带 ResizeObserver，展开动画期间自动跟随。

## 已知的取舍 / 潜在争议点（欢迎审视）

- `window.__afterframeMapTest` 测试后门无条件安装（沿用仓库既有 `__afterframeTest` 模式）；卸载时清理。
- Collection 视图下视窗筛选被禁用（browse-collection 不吃 facet filters，chip 会"看着在筛选实际没有"）；地图点仍按 collection scope 拉取。
- `useMapPoints` 的 refreshToken 用 `summary.image_assets` 计数——删一加一总数不变时缓存可能陈旧（Phase 1 接受）。
- 单点 marker 预览图缺失时 marker 无可见内容（count=1 时角标隐藏）；聚合 marker 无此问题。
- `metadata.py` 的 EXIF 解析未改动（GPS 字段既有）；视频资产无 GPS 通路。
- 精确 GPS 的 `accuracy_m` 恒为 NULL（无可靠误差字段不伪造），UI 不显示误差圆——设计文档明确要求。

## 验证证据

- Sidecar：16/16 unittest 通过（迁移幂等、GPS 增删改同步 R*Tree、跨日期变更线查询、source/precision/place 过滤、map-points 忽略 geo、manual 不被 EXIF 覆盖）。
- Renderer：vitest 24/24（含 antimeridian 切割、封面稳定排序）。
- E2E：全量 **114 通过 0 失败**（8 skipped 为既有跳过），含 23-map 5 例：展开不换 Gallery DOM、视窗筛选收窄（巴黎视窗→仅剩 1 张）、chip 移除恢复、收起清筛选、快捷键 M + 布局下拉可用。
- 截图人工核验：深浅主题底图、marker 缩放不漂移、层级切换器点击跳转（World z1.35 / Region z4 / City z7）、两悬浮控件边距均为 10px。
- lint / `vite build` 干净。

## 建议的 review 重点

1. `db/locations.py` 与 `maintenance.py`：R*Tree 与主表同步的所有路径是否有遗漏（特别是异常回滚路径、`cleanup_orphan_image_assets`）。
2. `_migrate_to_8` 回填 SQL 的类型/边界处理（`json_type` 过滤、CAST 语义）。
3. `_facet_clauses` geo 子句的 SQL 注入面（全部参数化，但请复核字符串拼接的 `extra_conditions`）。
4. PhotoMap 的 marker 生命周期与事件泄漏（单 useEffect 构造/清理、getClusterLeaves 异步竞态、theme MutationObserver）。
5. `useMapViewportFilter` 与 `applyFilters` 的并发：快速连续 moveend 与 browse request-id 丢弃是否配合正确。
6. E2E fixture 变更对未来 spec 的隐含约束（视频时间戳回拨 60s 的注释是否足够醒目）。

---

## Review Findings

### 2026-07-21 Codex Review

- [x] **[P1] 配对 RAW 中的 GPS 不会进入地图或地理筛选**

  `db/locations.py:list_map_points` 只把 `asset_locations` 连接到
  `registry.image_asset_id`；`browse.py:_geo_filter_clause` 同样只检查 Gallery
  image asset 自身的位置。RAW 的位置虽然会在 `upsert_raw_asset` 时写入，
  但没有被这两条读取路径使用。因此常见的“RAW 保留 GPS、导出 JPEG 已剥离
  GPS”照片不会出现在地图，viewport geo filter 也找不到；与此同时
  `Inspector.jsx` 已经采用 `rawMeta.gps_* ?? imageMeta.gps_*`，两处位置语义不一致。

  建议建立统一的 effective-location 查询（image location 不存在时回退
  `registry.raw_asset_id` 的位置），并让 map points 与 geo facet 共用。需要新增
  “RAW 有 GPS、配对 image 无 GPS”的回归测试。

  > **已修复**：`list_map_points` 改为 FROM registry LEFT JOIN 双 asset_locations（image 优先，COALESCE 取 effective location）；`_geo_filter_clause` 重构为 `image 位置匹配 OR (image 无位置 AND raw 位置匹配)` 两段 EXISTS，与 Inspector 回退语义一致。新增测试 `test_raw_gps_falls_back_into_map_points_and_geo_filter`、`test_own_gps_wins_over_raw_gps`。

- [x] **[P1] 地图点查询没有搜索防抖，且地图打开一次后折叠状态仍持续查询**

  `MapDrawer.jsx` 用 `hasOpenedRef.current` 永久启用 `useMapPoints`；
  `useMapPoints.js` 又直接把原始 `search` 放进 cache key/effect。用户每输入一个
  字符都会发起一次最多 100,000 行的地图查询。React cleanup/request id 只能丢弃
  旧响应，不能取消 sidecar 中已经开始的 SQL 与 JSON 序列化；地图折叠后该成本
  仍会持续发生。

  建议复用 Gallery 的 250ms committed/debounced search，并在折叠时暂停地图点
  请求；重新展开时再用最新 cache key 拉取，MapLibre 实例本身仍可保留。

  > **已修复**：`useMapPoints` 网络请求加 250ms debounce（缓存命中仍即时）；`MapDrawer` 的 `enabled` 从 `hasOpened` 改为 `expanded`——折叠时不再发起请求，重新展开按最新 cache key 拉取，MapLibre 实例保留不重建。

- [x] **[P1] Collection 中地图和 Gallery 的数据范围不一致**

  `list_map_points` 进入 collection scope 后仍无条件应用 search 和非 geo facet；
  但 `browse_collection` 不接收 search、sort 或 facet filters。用户带着搜索、日期、
  评分等条件进入 Collection 后，Gallery 展示完整 Collection，地图却只展示旧条件
  匹配的子集，与“地图点按 Gallery scope 拉取”的架构约定不符。

  Phase 1 可在 collection scope 下让 map points 同样忽略 search/facets；另一种方案
  是为 `browse_collection` 补齐相同过滤能力。无论选择哪一种，两条查询必须共享同一
  scope 语义，并增加 collection + existing filters 的测试。

  > **已修复**：采用方案一，`list_map_points` 在 collection scope 下同样忽略 search/facets（与 browse_collection 对齐），`useMapPoints` cache key 同步只含实际生效的维度。新增测试 `test_map_points_collection_scope_ignores_search_and_facets`。

- [x] **[P2] 进入 Collection 时旧 geo filter 没有清理**

  `App.jsx` 只在收起地图时清除 `filters.geo`；`useMapViewportFilter` 在 Collection
  中仅停止生成新 filter，不会移除已有 filter，而 `selectCollection` 也会保留它。
  结果是 Location chip 继续显示但不生效，退出 Collection 后旧地图范围还会静默
  恢复并再次过滤 Gallery。

  建议在 `activeCollectionId` 变为非空时显式删除 `filters.geo`，或在 Collection
  视图隔离/隐藏该 filter，并补充“先移动地图，再进入/退出 Collection”的 E2E。

  > **已修复**：App.jsx 新增 effect，`activeCollectionId` 变为非空时显式移除 `filters.geo`（与收起地图清筛选同构），chip 不再空挂、退出 collection 不会静默恢复旧视窗。

- [x] **[P2] 最大缩放级别的 cluster 无法继续展开**

  `PhotoMap.jsx` 将地图 `maxZoom` 和 GeoJSON source 的 `clusterMaxZoom` 都设为 14；
  点击 cluster 时，`getClusterExpansionZoom` 的结果又被 `Math.min(zoom, 14)` 截断。
  因此 zoom 14 仍存在的 cluster 会成为无效按钮，重复点击不会改变地图或暴露照片。

  至少应把 `clusterMaxZoom` 降到 13；对于相同 GPS 坐标的多张照片，还应定义
  terminal zoom 行为，例如直接将该组作为 Gallery filter/selection，而不是继续缩放。

  > **已修复**：`clusterMaxZoom` 降为 13（maxZoom 14 时全部解散为单点）。同坐标多照片在 z14 为重叠单点 marker，terminal 行为（点组即筛选）留待 Phase 3 手动定位一并设计。

- [x] **[P2] `summary.image_assets` 不能作为地图缓存的完整失效版本**

  当前 `refreshToken` 只取图片总数。metadata 重读后增加/删除 GPS、生成预览、修改
  评分，或“删一张再加一张”都可能保持总数不变，`useMapPoints` 会继续命中旧缓存，
  当前会话中的坐标、marker 封面和代表图排序不会更新。这个影响范围大于简报中仅列出的
  “删一加一”。

  建议提供单调递增的 catalog/map revision，在 import/delete、metadata refresh、
  preview ready、rating/location 更新后推进，并以它作为地图缓存失效 token。

  > **已修复**：`useWorkspace` 新增单调递增 `catalogRevision`，在每次 `refreshAll` 完成与每个 catalog-changed 事件（import/delete/metadata refresh/agent 写入/编辑器保存）时 +1，地图缓存以它为失效 token。评分变更不 bump（只影响封面排序，接受为残留）。

- [x] **[P2] 异步 cluster 封面可能被旧结果覆盖**

  `getClusterLeaves()` 完成时只检查 `markers.has(key)`。调用 `source.setData()` 后，
  `cluster_id` 可能在新聚合索引中被复用；此时旧请求仍会通过检查，并把旧 leaves 的
  预览写回当前 marker。快速切换搜索或 facet 时可能出现封面与当前 cluster 不一致，
  且会保持到下一次 marker update。

  建议为每次 source 数据更新或每个 marker leaves 请求增加 generation token，promise
  完成时同时验证 generation、marker 实例和当前 cluster 数据后再更新 DOM。

  > **已修复**：`setData()` 时递增 `pointsGeneration`，`getClusterLeaves` 回调同时校验 generation、marker 存活后才写 DOM，跨代的旧封面直接丢弃。

### 本次复核记录

- `PYTHONPATH=src python3 -m unittest tests.test_locations`：16/16 通过。
- `npm run test:renderer -- --run src/components/map/antimeridian.test.js`：24/24 通过。
- `git diff --check 751cc35..HEAD`：通过。
- MapLibre 5.24.0 自带并默认启用 container `ResizeObserver`，展开动画不需要手写
  `map.resize()` rAF 循环，简报中的该项说明成立。
- R*Tree 的正常 upsert、metadata GPS 移除、单资产删除和 orphan cleanup 路径均在同一
  事务中显式维护，未发现新的同步遗漏；上述 finding 主要集中在 effective location、
  scope 一致性、缓存失效和前端异步边界。

### 2026-07-21 修复记录（against Codex Review）

- 7/7 findings 全部成立（无 REFUTED），已逐条修复并勾选，修复说明附于各条目下。
- 验证：sidecar unittest 19/19（新增 3 例）；renderer vitest 24/24；lint / build 干净；
  E2E 23-map 5/5，全量回归见下。

### 2026-07-22 第二轮 Review（用户转达）

- [x] **[P1] `catalogRevision` 没覆盖 UI 内的直接写操作**

  Collection 增删成员、删除资产、磁盘删除、评分修改直接改 React 本地状态，
  不推进 revision 也不触发 catalog-changed，地图缓存不失效（marker 残留、
  collection 地图不更新、封面排序陈旧）。

  > **已修复**：`useWorkspace` 抽出 `bumpCatalogRevision()`，在
  > `addToCollection` / `removeFromCollection` / `deleteCollection` /
  > `deleteImageAssets` / `deleteImageAssetsFromDisk` / `setAssetRating`
  > 成功后统一调用（评分现在也 bump，上一轮"评分不失效"的残留一并消除）。
  > 主进程统一广播 catalog-change 是更彻底的方案，留作后续重构方向。

- [x] **[P2] effective location 与 Inspector 优先级相反，且逐列 COALESCE 混合行**

  Inspector 是 rawMeta 优先，sidecar 实现成了 image 优先；且逐列 COALESCE
  可能拼出 image 坐标 + RAW accuracy/place_id 的混合记录。

  > **已修复**：产品优先级定为 **RAW 优先**（RAW 是拍摄元数据权威源，与
  > Inspector 既有展示语义一致）。`list_map_points` 改为整行选择（单一
  > `CASE WHEN loc_raw.location_id IS NOT NULL` 谓词切换所有列，不再混合）；
  > `_geo_filter_clause` 同步为 "配对 RAW 位置匹配 OR（RAW 均无位置 AND
  > image 位置匹配）"。测试改为 `test_raw_gps_wins_over_image_gps`（含
  > 整行 source 断言）并新增 `test_image_gps_used_when_raw_has_none`。
  > 两处代码均注记 Phase 3 manual 来源需覆盖 RAW exif 的优先级前提。

修复验证：sidecar unittest 20/20，renderer 24/24，lint/build 干净，E2E 见下。
