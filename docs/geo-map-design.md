# AfterFrame 离线地图功能实施方案

> **状态（2026-07-21）**：Phase 1（GPS-only MVP）已实现。Schema 8（`asset_locations` + R*Tree）、`browse-map-points`、MapDrawer/PhotoMap/视窗筛选、单测与 E2E（`apps/desktop/e2e/23-map.spec.js`）均已合入工作区。与本方案的偏差：地图数据不放 `public/maps/` 而是走 Vite 动态 `import()` 分包（生产环境 `file://` 下 `fetch` 拿不到静态资源）；日期变更线切割保留为运行时模块（`src/components/map/antimeridian.js`），`world-atlas` 作为 npm 依赖。产品调整（用户拍板）：收起地图会**自动清除**视窗筛选（与 §3.4 规则 5 相反）；不显示离线角标，左下角改为 世界/地区/城市 层级指示器；Toolbar 四个排版按钮收进一个下拉。Phase 2（AI 地名解析）与 Phase 3 未开始。

## 1. 目标与非目标

### 1.1 目标

在现有桌面端 Gallery 中增加一个可折叠的本地地图，用于：

1. 按照片的地理位置浏览与筛选当前 Gallery。
2. 优先使用 EXIF GPS；没有 GPS 时，可以使用已经存在的 AI `location_json` 做较粗粒度的位置解析。
3. 在世界、国家、州/省和城市层级显示照片聚合，不向地图一次性添加成千上万个 DOM Marker。
4. 完全离线运行，不需要用户提供地图 Key，不产生瓦片费用，也不存在客户端 Token 泄露问题。
5. 复用现有 Toolbar、FilterBar、Gallery、选择状态、缩略图和分页逻辑，不维护第二套照片浏览器。

### 1.2 非目标

- 不提供道路、门牌、建筑物、POI 搜索或导航。
- 不做在线地理编码或反向地理编码。
- 不承诺 AI 推断具有街道级精度。
- 第一版不做轨迹、旅行路线或时间轴动画。
- 第一版不提供手动拖动照片修正坐标；可以在后续版本增加。

## 2. 已验证的基础

研究原型已经验证：

- MapLibre 可以使用本地 GeoJSON/TopoJSON 渲染完整离线地图。
- 本地地图数据约 18.62 MB：
  - `admin1-lines-10m.topo.json`：17,535,726 bytes
  - `admin1-labels-10m.json`：833,508 bytes
  - `cities-50m.json`：249,423 bytes
- 当前生产构建若把地图 JSON 直接 import 进 JS，会得到约 23.35 MB 的 JS（约 8.02 MB gzip）。正式集成应把地图数据作为独立静态资源懒加载，避免影响应用首次启动和主 Bundle 解析。
- 国际日期变更线预处理已经消除了世界地图跨边界的异常填充。
- 照片叠片 Marker 在缩放动画中的投影中心误差保持在约 0–0.5 px。
- 地图展开/收起可以通过 Gallery 顶边的高度动画完成，不需要切换到另一套页面。

现有产品代码也已经具备关键数据：

- `services/sidecar/src/media_workspace/metadata.py` 已读取 `gps_latitude` 和 `gps_longitude`。
- GPS 已进入 `assets.metadata_json`，Gallery Browse 返回的 `image_metadata` / `raw_metadata` 中能够访问。
- `asset_ai_annotations.location_json` 已保存 AI 推断的 `country`、`region`、`landmark` 和 `confidence`。
- `useWorkspace` 已把结构化 `filters` 传给 Sidecar。
- `Gallery.jsx` 已实现大图库虚拟布局、分页、四种排版、选择和键盘操作。

## 3. 最终用户体验

### 3.1 Toolbar

保留现有 Toolbar 的所有控件和四个排版按钮，仅在排版按钮后增加 `Map` 图标按钮：

- 图标使用 Lucide `Map`，不用定位 Pin。
- 开启状态使用现有 `bg-selected text-accent` 样式。
- Tooltip：`Show map` / `Hide map`。
- 快捷键建议为 `M`，但输入框聚焦时不得触发。

### 3.2 展开与收起

Gallery 是唯一的照片工作区。结构应当是：

```text
Toolbar
FilterBar
Workspace
├── MapDrawer        高度 0 或用户保存的高度
├── ResizeHandle
└── Gallery          现有 Gallery 实例
Inspector
```

不能在地图下方复制一份 Gallery DOM。Map toggle 只改变 `MapDrawer` 高度：

- 关闭：`mapHeight = 0`，Gallery 占满 Workspace。
- 打开：恢复上次保存的 `mapHeight`。
- 默认地图高度：`min(42vh, 420px)`。
- 最小地图高度：220 px。
- Gallery 至少保留 200 px。
- 动画：820 ms，`cubic-bezier(0.45, 0, 0.55, 1)`。
- 拖动分隔线时关闭 transition，保证跟手。
- 动画和拖动过程中使用 `ResizeObserver` 或短时 `requestAnimationFrame` 调用 `map.resize()`。

建议使用 CSS Grid：

```jsx
<div
  className="grid min-h-0 flex-1 overflow-hidden"
  style={{
    gridTemplateRows: mapExpanded
      ? `${mapHeight}px 10px minmax(0, 1fr)`
      : "0px 0px minmax(0, 1fr)",
    transition: resizing ? "none" : "grid-template-rows 820ms cubic-bezier(0.45, 0, 0.55, 1)",
  }}
>
  <MapDrawer />
  <MapResizeHandle />
  <Gallery {...existingGalleryProps} />
</div>
```

### 3.3 Gallery

- 必须继续使用现有 `Gallery.jsx` 实例。
- 地图开关不得改变 `displayMode`、`thumbSize`、滚动位置或当前选择。
- 地图移动只更新 `workspace.filters.geo`，由现有 Browse 流程刷新 Gallery。
- 地图展开状态下仍允许 Grid / Tiles / Justified / Waterfall 切换。
- 地图区域不额外显示 `Open Gallery`、结果标题或照片地点说明。

### 3.4 地理筛选

FilterBar 增加一个可移除的 Location Chip：

- 视窗筛选：`Visible map area`。
- 地点筛选：`Paris · city level`。
- GPS 单点筛选不显示人为的误差圆。
- AI 推断位置可以在 Inspector 显示来源、置信度和精度级别，但地图上不画虚线范围圆。

交互规则：

1. 用户平移或缩放地图，在 `moveend` 后 250 ms 更新视窗筛选。
2. 点击聚合叠片：放大并 `fitBounds` 到该聚合范围；移动结束后使用新的视窗筛选。
3. 点击城市级照片组：设置 `place_id` / locality 筛选，并更新 Inspector。
4. 删除 Location Chip：清除地理筛选，但不关闭地图。
5. 关闭地图：保留现有地理筛选，避免 Gallery 结果突然变化。

## 4. 位置数据模型

### 4.1 位置优先级

同一照片可能存在多种位置，最终有效位置按以下优先级选择：

1. 用户手动确认的位置（未来功能）。
2. EXIF GPS。
3. AI 推断并由离线地名库解析的位置。
4. 无可用位置。

不要用 AI 位置覆盖真实 GPS。

### 4.2 新增规范化表

GPS 当前位于 `metadata_json`，但地图视窗查询不应在每次 Browse 时扫描 JSON。Schema 从 7 升到 8，新增规范化位置表和 SQLite R*Tree：

```sql
CREATE TABLE asset_locations (
    location_id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL UNIQUE,
    latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
    min_latitude REAL NOT NULL,
    max_latitude REAL NOT NULL,
    min_longitude REAL NOT NULL,
    max_longitude REAL NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('manual', 'exif', 'ai')),
    accuracy_m REAL,
    precision_level TEXT CHECK(precision_level IN ('exact', 'locality', 'admin1', 'country')),
    confidence REAL,
    place_id TEXT,
    country_code TEXT,
    admin1 TEXT,
    locality TEXT,
    landmark TEXT,
    resolver_version TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
);

CREATE INDEX idx_asset_locations_asset ON asset_locations(asset_id);
CREATE INDEX idx_asset_locations_place ON asset_locations(place_id);
CREATE INDEX idx_asset_locations_source ON asset_locations(source);

CREATE VIRTUAL TABLE asset_location_rtree USING rtree(
    location_id,
    min_longitude,
    max_longitude,
    min_latitude,
    max_latitude
);
```

精确 GPS 点的 min/max 经纬度相同。AI 城市或行政区位置保存用于相交查询的包围盒；`latitude/longitude` 是 Marker 中心点。

通过应用层统一维护 `asset_locations` 和 R*Tree，避免复杂触发器。所有 Upsert/Delete 必须在同一事务中完成。

### 4.3 GPS 精度

EXIF 坐标的小数位数不等于真实精度：

- 普通手机室外通常约 3–10 m。
- 高楼、树林和室内可能为 10–50 m 或更差。
- 如果文件没有水平误差字段，`accuracy_m` 保持 `NULL`，不能伪造固定精度。
- UI 可以显示 `GPS`，但只有存在可靠误差字段时才显示 `±N m`。

第一版不需要修改 EXIF 解析器的经纬度读取；需要在导入、重新读取元数据和迁移回填时调用 `upsert_asset_location_from_metadata()`。

### 4.4 AI 位置解析

当前 AI schema 只返回 `country`、`region`、`landmark`。建议把 Annotation schema 升到 v2：

```json
{
  "country": "France",
  "admin1": "Île-de-France",
  "locality": "Paris",
  "landmark": null,
  "confidence": 86
}
```

解析原则：

- 只做离线解析，不调用 Google、Mapbox 或公共 Nominatim。
- `country + admin1 + locality` 作为联合键，不能只按城市名匹配。
- 多个候选且无法消歧时降级到 admin1 或 country，不能任意选一个城市。
- 低于置信度阈值（建议 60）的结果不进入地图。
- 保存 `resolver_version`，以后升级地名库时可以有选择地重新解析。

MVP 可以先支持当前内置城市/行政区数据；更完整的城市覆盖应单独评估 GeoNames 或其他离线 Gazetteer 的许可、包体和别名覆盖。

## 5. Sidecar API 与查询

### 5.1 Gallery 地理过滤

在 `_facet_clauses()` 增加 `filters.geo`：

```json
{
  "geo": {
    "mode": "bounds",
    "west": -5.2,
    "south": 41.1,
    "east": 9.8,
    "north": 52.4,
    "include_exif": true,
    "include_ai": true,
    "min_precision": "locality"
  }
}
```

普通视窗查询：

```sql
EXISTS (
  SELECT 1
  FROM asset_locations loc
  JOIN asset_location_rtree geo ON geo.location_id = loc.location_id
  WHERE loc.asset_id = assets.asset_id
    AND geo.max_longitude >= :west
    AND geo.min_longitude <= :east
    AND geo.max_latitude >= :south
    AND geo.min_latitude <= :north
)
```

跨国际日期变更线时（`west > east`），经度条件必须拆成：

```sql
(longitude >= :west OR longitude <= :east)
```

地点模式使用 `place_id`；来源和精度级别继续添加 AND 条件。

### 5.2 地图点数据接口

新增 Sidecar 命令 `browse-map-points`，返回当前非地理筛选范围内的轻量点数据。不要复用完整 `browse-images` 行，因为地图不需要完整 EXIF、Annotation 文本和资源集信息。

请求：

```json
{
  "status": "rated",
  "collection_id": null,
  "search": null,
  "filters": { "camera": "X100VI" },
  "bounds": { "west": -180, "south": -85, "east": 180, "north": 85 },
  "limit": 100000
}
```

返回：

```json
[
  {
    "asset_id": "...",
    "longitude": 2.3522,
    "latitude": 48.8566,
    "source": "exif",
    "accuracy_m": null,
    "precision_level": "exact",
    "place_id": null,
    "preview_path": "..."
  }
]
```

地图点接口应复用 status、collection、search 和普通 facets，但忽略当前 `filters.geo`，否则地图移动后会丢失视窗外的聚合点，用户无法继续导航。

### 5.3 Electron Bridge

新增调用链：

```text
React
→ apps/desktop/src/api/index.js
→ electron/preload.js
→ electron/ipc/browse.js
→ electron/sidecar/commands.js
→ sidecar CLI browse-map-points
```

建议 API：

```js
api.browseMapPoints(options)
```

结果只包含本地文件路径和位置数据，不经过远程服务。

## 6. 地图聚合与 Marker

### 6.1 MapLibre Source

第一版使用 MapLibre 内置 GeoJSON clustering：

```js
map.addSource("photo-locations", {
  type: "geojson",
  data: featureCollection,
  cluster: true,
  clusterRadius: 52,
  clusterMaxZoom: 14,
});
```

这样 1 万张或更多照片不会产生 1 万个 DOM Marker。每次地图稳定后，只为当前可见的 cluster / unclustered feature 建立 Marker。

### 6.2 代表缩略图

- Cluster 数量来自 `point_count`。
- 使用 `getClusterLeaves(clusterId, 3, 0)` 获取最多三张代表照片。
- 只加载现有 Preview，不读取原图。
- 代表照片排序必须稳定，例如评分优先、拍摄时间倒序、最后用 `asset_id` 排序，避免缩放时封面随机变化。
- Cluster Marker 始终显示三图叠片和数量角标：
  - 世界层级缩放约 0.72。
  - 区域层级约 0.86。
  - 城市层级为 1.0。

### 6.3 防止 Marker 漂移

MapLibre 写入外层元素的 `transform`，产品代码不得覆盖或给它添加 transform transition：

```css
.photo-map-marker {
  opacity: 1;
  transition: opacity 180ms ease;
}

.photo-map-marker__visual {
  transform: scale(var(--marker-scale));
  transition: transform 220ms ease;
}
```

Hover、选中、叠片展开全部作用于内部 `__visual`，不作用于外层 Marker。

### 6.4 Marker 生命周期

- Key 使用 `cluster:${clusterId}` 或 `asset:${assetId}`。
- 维护 `Map<key, Marker>`，复用可见 Marker，移除离开视窗的 Marker。
- 图片解码使用 `loading="lazy"` / `decoding="async"`。
- `move` 期间只更新坐标；`moveend` 后再做聚合 Marker 的增删和 Gallery Filter 更新。

## 7. 地图数据与打包

### 7.1 文件位置

不要把 18.62 MB JSON import 进 `App.jsx`。建议放入：

```text
apps/desktop/public/maps/
├── admin1-lines-10m.topo.json
├── admin1-labels-10m.json
├── cities-50m.json
└── manifest.json
```

Map 第一次打开时再动态加载 MapLibre 和地图数据：

```js
const [{ default: maplibregl }, mapData] = await Promise.all([
  import("maplibre-gl"),
  loadLocalMapData(),
]);
```

这样主 Gallery 首屏不解析地图数据。关闭地图后保留 Map 实例，避免每次重新解析 18 MB 文件；切换 Catalog 时只替换照片点 Source。

### 7.2 许可

合入前需要在应用的第三方许可清单中记录：

- MapLibre GL JS 许可。
- Natural Earth / world-atlas 数据来源和许可说明。
- 如果未来增加 Gazetteer，必须单独确认其再分发许可。

### 7.3 无 Token 架构

地图背景、位置索引和图片都在本地：

- 无 Google/Mapbox Key。
- 无 Cloudflare Manager。
- 无全球后端部署。
- 无地图调用次数或用户数费用。
- 无 Token 被破解后盗刷的风险。

## 8. React 组件改造

建议新增：

```text
apps/desktop/src/components/map/
├── MapDrawer.jsx
├── PhotoMap.jsx
├── PhotoClusterMarker.js
├── MapResizeHandle.jsx
├── useMapPoints.js
├── useMapViewportFilter.js
└── mapData.js
```

现有文件的改动：

### `Toolbar.jsx`

- Import Lucide `Map`。
- 新增 props：`mapExpanded`、`onToggleMap`。
- 在 `DISPLAY_MODES` 之后添加独立 Map IconButton。
- 不改变现有四种排版、缩略图 Slider、Search、Sort 和 Filter 按钮。

### `App.jsx`

- 新增 `mapExpanded` 和 `mapHeight` 状态。
- 使用一个 Workspace Split 容器包住 `MapDrawer` 和现有 `Gallery`。
- 把当前 status、collection、query、普通 filters 传给 `useMapPoints`。
- 地图更新通过 `workspace.setFilters()` 写入 `filters.geo`。
- 保留当前选择和 Inspector，不因 Map toggle 清空。

### `Gallery.jsx`

- 不复制组件。
- 如布局容器需要，增加可选的 `className` 或 `scrollRef`，其他虚拟布局逻辑不改。
- 地图展开时必须保持 Gallery ScrollTop；如果容器宽度改变，沿用现有 ResizeObserver 重新布局。

### `FilterBar.jsx`

- 增加 Location Chip 渲染和清除操作。
- 地理筛选参与 `filterCount`。
- Location Chip 的文案从 Filter 对象派生，不在 Map 组件中维护第二份状态。

### `Inspector.jsx`

- 继续显示现有 GPS。
- 增加 Location source、AI precision 和 confidence。
- 不增加绿色虚线圆图例。

### i18n

更新：

```text
apps/desktop/src/i18n/locales/en/nav.json
apps/desktop/src/i18n/locales/zh-CN/nav.json
apps/desktop/src/i18n/locales/en/inspector.json
apps/desktop/src/i18n/locales/zh-CN/inspector.json
```

## 9. 状态、缓存与并发

- `mapExpanded` 与 `mapHeight` 存入 localStorage；建议键：
  - `afterframe-map-expanded`
  - `afterframe-map-height`
- 地图中心、Zoom 可以按 Catalog 保存，也可以第一版只保存在当前会话。
- `browseMapPoints` 请求使用递增 request id 或 AbortController，丢弃过期响应，模式与 `useWorkspace.loadBrowser()` 一致。
- 地图移动产生的 Gallery Browse 只在 `moveend + 250 ms` 执行。
- Map Point 数据按 `catalogId + status + collection + search + nonGeoFilters` 缓存；仅视窗移动不重新读取全部点。
- Catalog、普通 Filter 或 Collection 改变时失效缓存并重新聚合。

## 10. 性能预算

建议验收预算：

| 项目 | 目标 |
|---|---:|
| 未打开地图时的首屏性能 | 与当前版本基本一致 |
| 第一次打开地图 | 2 s 内可交互（常规桌面 SSD） |
| 再次打开地图 | 300 ms 内开始动画 |
| 地图库规模 | 10,000 点流畅；50,000 点可用 |
| 同时存在的 DOM Marker | 通常 < 150，硬上限 300 |
| 地图移动后的 Gallery 查询 | moveend 后 250 ms debounce |
| Marker 投影误差 | < 1 px |
| Toggle 动画 | 820 ms，无明显掉帧 |

如果 50,000 点的 GeoJSON 构建或聚类成为瓶颈，再把聚合移到 Sidecar；MVP 不需要提前引入 H3。

## 11. 测试计划

### 11.1 Sidecar 单元测试

- Schema 7 → 8 迁移和重复执行安全性。
- EXIF GPS 回填到 `asset_locations`。
- GPS 优先于 AI；AI 不覆盖 GPS。
- 普通视窗包围盒查询。
- 跨日期变更线查询。
- `place_id`、source、precision 组合过滤。
- 删除 Asset 时 Location 与 R*Tree 清理。
- 低置信度或歧义 AI 地点不落库。

### 11.2 React 测试

- Map toggle 不改变 Display Mode、Thumb Size 和 Selection。
- Location Chip 清除后只移除 `filters.geo`。
- 快速连续移动地图只提交最后一次 Filter。
- Map 动画过程中持续调用 Resize，但卸载后不再调用。
- 分隔线最小/最大高度和键盘可访问性。

### 11.3 Electron E2E

新增 `apps/desktop/e2e/map.spec.js`：

1. 导入带 GPS 的 Fixture。
2. 点击 Map 按钮，验证地图高度从 0 连续增加。
3. 验证原 Gallery DOM 没有被替换，Selection 与 Scroll 保留。
4. 平移地图，验证 Location Chip 和 Gallery 结果改变。
5. 点击照片组，验证 Inspector 和 Gallery Filter。
6. 关闭地图，验证 Filter 保留且 Gallery 回到全高。
7. 切换四种排版并重复展开/收起。

### 11.4 视觉回归

- 世界层级的 Marker 重叠与标签遮挡。
- 城市层级三图叠片可辨认。
- 深色/浅色主题。
- 800 px 宽度、隐藏 Sidebar、隐藏 Inspector。
- Reduced Motion 下关闭或缩短展开动画。

## 12. 分阶段交付

### Phase 1：GPS-only MVP

- Map toggle、MapDrawer、拖动分隔线。
- 本地行政区地图懒加载。
- Schema 8 + GPS Location 回填。
- `browse-map-points`。
- MapLibre 聚合与照片叠片。
- 视窗地理筛选与 Filter Chip。
- 完整测试。

这一阶段不依赖 AI 地名解析，风险最低，也已经能覆盖手机和带 GPS 相机照片。

### Phase 2：AI locality

- Annotation schema v2。
- 离线 Gazetteer 和消歧。
- AI Location 回填 Job。
- 精度级别、来源和置信度 UI。
- 城市/行政区筛选。

### Phase 3：产品完善

- 手动修正位置。
- 为没有 GPS 的一组照片批量指定地点。
- 地图状态按 Catalog 记忆。
- 大于 50,000 点时评估 Sidecar 聚合。

## 13. 完成定义

功能可以合入生产的最低条件：

- 无任何运行时地图网络请求或 Token。
- 未打开地图时不加载 MapLibre 和 18.62 MB 地图数据。
- Map toggle 只展开/收起地图，不改变 Toolbar 其他行为。
- 使用唯一 Gallery 实例，没有 Filmstrip 或重复照片网格。
- GPS 照片可通过当前地图视窗筛选。
- 1 万位置点下平移、缩放和 Gallery 浏览保持流畅。
- Marker 缩放时无可见漂移。
- 不显示误导性的 AI 精度范围圆。
- Schema Migration、Sidecar、React 和 Electron E2E 测试全部通过。
