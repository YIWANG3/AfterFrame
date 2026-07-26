# Review 简报：离线地图 Phase 2 — AI 地名解析（feat/geo-map）

> 供评审 agent 使用。评审意见追加到文末「Review Findings」区：每条 finding 一个 checkbox 跟踪修复，误报保留并注明 REFUTED 理由。Phase 1 简报与两轮已修复 findings 见 [2026-07-21-geo-map-phase1.md](2026-07-21-geo-map-phase1.md)。

## 范围

把 AI 标注的地点文本（`asset_ai_annotations.location_json`）离线解析成坐标写入 `asset_locations`（`source='ai'`），使无 GPS 的照片也能上图/被地理筛选。运行时零网络、无 Token——地名库在构建期从 Wikidata 提取后随 sidecar 打包。

预研（含真实 catalog 命中率与三个重名错解析实例）：`research/gazetteer-lab/FINDINGS.md`。

## 数据与构建

- **地名库**：`services/sidecar/src/media_workspace/data/gazetteer.json.gz`（gzip ~5MB / raw 19MB，已入 git）。四层：202 国家/地区（ISO 3166-1 存在性提取，覆盖港澳台等非主权地区，含英文别名与主权归属 parent）、5,351 admin1、85,345 localities（11 个 P31 直类分片）、90,539 landmarks（21 类目闭包，sitelinks≥5）。中英双语标签。许可 CC0（licenses/map-data.txt 已记录）。
- **构建脚本**：`research/gazetteer-lab/build_gazetteer.py`（研究目录，gitignored；分段落盘缓存可断点续跑）。WDQS 工程坑已编码进脚本：全量 COUNT/闭包超时须分片、响应可能被截断成半截 JSON（`JSONDecodeError` 计入重试）、标签含裸控制字符（`strict=False`）。
- **PyInstaller**：`media-workspace.spec` datas 已带上 data 目录。

## 解析器（`media_workspace/geo_resolver.py`）

规则全部来自真实失败案例：

1. 预处理：去括号 → 拆 `A / B`、`A, B` → 循环剥描述性后缀（skyline/coastline/waterfront/downtown…）。
2. 国家消歧：标注 country 归一化（别名表：USA/US/…）→ 候选按 `P17 ∈ {地区自身, 主权归属}` 过滤（香港地标的 P17 是中国——不带 parent 就全军覆没）。
3. 无国家上下文时：仅当榜首 sitelinks ≥ 30 且 ≥ 次名 2 倍才解析（文档禁止任选其一）。
4. 层级：landmark（→ exact）→ landmark 回退 localities（模型把 Manhattan/Big Sur 标成 landmark）→ locality → admin1 → v1 `region` 在 locality/admin1 两层**按知名度全局取优**（马里兰小镇 "California" 曾压过加州本尊）→ country 兜底。
5. 置信度 < 60 不落库；数据文件缺失时静默返回 None（不破坏标注写入）。
6. 写入走 `db/locations.py:upsert_ai_asset_location`：manual/exif 永不被覆盖；AI 行带 bbox（locality ±0.15°、admin1 ±1.5°、country ±4°）供视窗相交；`place_id='wd:Q…'`、`resolver_version` 落库。

## 触发链路

- 新标注：`save_annotation` 内联解析（含"解析失败清掉旧 ai 行"）——批量 Job 与单张路径都覆盖。
- 存量：CLI `resolve-ai-locations` 一次性回填；渲染端首次展开地图时按 catalog 自动触发一次（`App.jsx`），有变更则 bump `catalogRevision` 刷新地图缓存。
- Annotation schema v2：提示词输出结构化 `country/admin1/locality/landmark`（一个名字、禁复合串），v1 `region` 兼容读取。

## 验证证据

- 真实 catalog（5,418 资产 / 82 条 AI 地点标注）：**置信度达标的 69/69 全部解析**（22 exact + 35 locality + 8 admin1 + 4 country），13 条 <60 按设计拦截，0 MISS。预研抓到的三个重名陷阱（塔斯马尼亚 Grindelwald、萨省 Montmartre、伦敦 Salesforce Tower）全部解析到正主。
- sidecar unittest 38/38（新增 geo_resolver 13 例 + AI 写入 5 例：消歧/后缀/歧义拒绝/置信度/manual-exif 优先级/rtree bbox/include_ai）。
- E2E fixture 新增 AI 标注资产（004-green → 悉尼，locality），`23-map.spec.js` 新用例验证 AI 点上图 + 视窗筛选命中，6/6 过；全量回归见下。
- 解析器加载 172k 条库 ~0.3s，进程内单例。

## 已知取舍

- 别名只在 country 层（landmark/locality 靠 en+zh 标签）；Wikidata 别名全量收录留待 dump 管线。
- bbox 是固定半径近似，不是真实行政边界。
- landmark 解析的 `precision_level='exact'` 语义是"点位精确"，非 GPS 级；来源 `ai` 已区分。
- 地图 marker 不区分 GPS/AI 来源（设计文档：精度与来源只在筛选和 Inspector 表达）。
- Q486972 闭包超时改 P31 直类分片，理论上有 recall 损失（真实 catalog 未见）。

## 建议 review 重点

1. `geo_resolver._pick` 的消歧规则与 dominance 阈值。
2. `upsert_ai_asset_location` 与 exif/manual 的优先级交互（含 `_sync_ai_location` 的清理分支）。
3. `save_annotation` 内联解析的异常包裹是否真的兜住所有路径。
4. 首次开图自动回填的时序（与 useMapPoints 缓存/revision 的配合）。
5. gazetteer 数据文件入 git 的体积权衡（5MB gz）与再生成可复现性。

## 用户反馈修正（2026-07-22 晚）

用户实测发现粗精度点误导（"Pacific Coast Highway" → 加州州级中心点，marker 看起来像精确位置）。修正：

- **精度下限**：地图与视窗筛选默认只含 `exact`/`locality`（`browse-map-points --min-precision`，`filters.geo.min_precision`）；admin1/country 级 AI 点不再上图（宁缺毋滥），Inspector 仍显示推测文本。真实 catalog：显示 64、隐藏 5（全为线状公路/泛区域这类本质无点位的输入）。
- **解析改进**（真实数据驱动）：逗号后段作为包含地上下文回退（"Scripps Pier, La Jolla" → La Jolla，6 张从州级修正为城市级）；跨层取优改为候选顺序优先、同候选词才比知名度（修 "San Francisco, California" 被加州州级抢走）；类目补 airport 与 island（香港机场、港岛 → exact）。
- 线状地标（公路/海岸线）本质不可点位化，API 亦无解；正确点位依赖 v2 重新标注给出 locality，或 Phase 3 手动指定。

## 打包验证与地名库修正（2026-07-25）

PR 前跑通了打包链路（PyInstaller sidecar + gazetteer datas），冒烟直接抓到一个**严重 recall 盲区**：打包版解析 "Paris" 落到国家级——因为巴黎的 P31 是 "commune of France" 而非 city 直类，P31 直类分片静默漏掉了几乎所有法/德/意/西的城市（真实 catalog 全美国照片所以没暴露）。修正：

- city/town 伞类改跑子类闭包（按 sitelinks 分段拉取——WDQS 会在 ~10MB 处截断大响应，municipality 全闭包连分段都超限，改为列举法 commune/德 Gemeinde/意 comune/西 municipio/瑞士/荷兰/日本市等国家直类）。localities 从 8.5 万增至 16.6 万，包体 gz 7.6MB。
- 顺带修：荷兰问题——ISO "NL" 挂在"荷兰王国"(Q29999) 而阿姆斯特丹 P17 是构成国"荷兰"(Q55)，与港澳方向相反；country 条目新增 P150 构成实体，消歧接受 {自身, 主权归属, 构成国}。
- 新增 `RealGazetteerSanityTestCase`：对真实数据文件验证 10 个世界主要城市（巴黎/柏林/罗马/马德里/东京/北京/首尔/苏黎世/阿姆斯特丹/伦敦）必须解析到 locality 级，数据文件缺失时跳过——此类盲区从此有回归防线。
- 打包冒烟通过：冻结二进制 init-catalog → 注入标注 → resolve → map-points 全链正确（Paris → wd:Q90 locality）。

代码清理：useMapPoints 移除未用的 loading；locations.py 复用 browse 的精度表。

---

## Review Findings

（评审 agent 从这里开始追加）
