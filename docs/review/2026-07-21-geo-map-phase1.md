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

（评审 agent 从这里开始追加）
