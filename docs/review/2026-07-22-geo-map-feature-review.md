# Geo View 功能全景 Review：已完成 / 未完成 / 值得做

> 2026-07-22，基于 `feat/geo-map` 分支（11 提交，已推送 origin，未合 main）。
> 代码级评审记录另见 [Phase 1 简报](2026-07-21-geo-map-phase1.md)（两轮 9 条 findings 全修复）与 [Phase 2 简报](2026-07-22-geo-map-phase2.md)。

## 功能定位回顾

完全离线的地理浏览：EXIF GPS 精确点 + AI 推测地点（离线地名库解析），地图视窗即 Gallery 筛选条件。无 Token、无瓦片服务、无运行时网络请求、照片数据不出本地。

---

## 一、已完成

### 数据与查询层（Sidecar）

- **Schema 8**：`asset_locations`（一资产一有效位置，来源 manual > exif > ai）+ SQLite R*Tree，应用层同事务维护；迁移自动回填存量 EXIF GPS（幂等、拒 (0,0) 垃圾值）。
- **Effective location**：RAW 优先于导出图（与 Inspector 展示语义一致，整行选择不混列）；"RAW 有 GPS、JPEG 被剥离"的常见工作流被覆盖。
- **地理查询**：`filters.geo`（视窗 R*Tree 相交、跨日期变更线拆分、place_id 模式、include_exif/include_ai/min_precision 全参数化）；`browse-map-points` 轻量点接口（复用 gallery scope、刻意忽略 geo、精度下限默认 locality）。
- **离线 AI 地名解析**（Phase 2 核心）：
  - Wikidata 地名库随 sidecar 打包（gz 5.3MB）：202 国家/地区（ISO 3166-1 提取 + 主权归属）、5,351 省州、85,345 城市/街区、100,426 地标，中英双语标签，CC0。
  - 解析器规则全部由真实失败案例驱动：预处理（括号/复合串/描述性后缀/逗号上下文回退）、国家消歧（含港澳类主权归属）、知名度优先与歧义拒绝、landmark→locality→admin1→country 降级链、置信度阈值 60。
  - 触发链路闭环：新标注保存即解析；存量首次开图自动回填；解析失败清理陈旧 ai 行。
- **Annotation schema v2**：结构化 country/admin1/locality/landmark，v1 兼容。

### 地图 UI（Desktop）

- MapDrawer 抽屉（400ms 展开、拖拽分隔线、高度记忆、快捷键 M）；唯一 Gallery 实例不复制（E2E 验证 DOM 存活）。
- 离线底图 22MB 走 Vite 动态 import 分包，主包与启动零影响；深色主题中性灰黑、浅色主题各一套配色，热切换重着色。
- MapLibre 聚类 + 照片叠片 marker（复用池、内层动画防漂移、封面稳定排序、聚类封面竞态防护）；可点击的 世界/地区/城市 层级切换器。
- 视窗筛选：首次主动交互才生效、250ms debounce、FilterBar 可移除 chip、收起地图/进收藏自动清除；`catalogRevision` 全 mutation 覆盖的缓存失效。
- Inspector：GPS 来源行 + AI 推测（locality/admin1/landmark/置信度）；地图不显示误导性精度圆（按设计文档）。

### 质量验证

- 测试：sidecar unittest 40、renderer vitest 24、E2E 115（含 7 个地图专项）全绿；两轮外部代码评审 9 条 findings 全修复，0 REFUTED。
- 真实 catalog（5,418 资产）实测：1,001 张 GPS 直接上图；82 条 AI 标注中置信度达标的 69 条全部解析、0 MISS，64 个可显示点，5 个本质模糊的（线状公路/泛区域）按"宁缺毋滥"隐藏。
- 预研与工程坑全部落盘（`research/gazetteer-lab/FINDINGS.md`、构建脚本可断点续跑）。

---

## 二、未完成

### 设计文档 Phase 3（规划内，未开始）

| 项 | 现状 |
|---|---|
| 手动修正位置 | schema/优先级/测试全预留（manual 永不被覆盖），仅缺 UI |
| 批量指定地点 | 未开始 |
| 地图相机按 catalog 记忆 | center/zoom 仅会话内；高度/开关是全局记忆。**用户决定：不做（无所谓）** |
| >5 万点 sidecar 聚合 | 未触发预算上限，未开始 |

### 后端就绪、缺 UI 的

- **place 筛选**（文档 §3.4 规则 3）：`place_id` 查询已实现有测试；UI 上点击单点只是选中资产，没有 "Paris · city level" 地点 chip。
- **筛选开关**：include_ai / min_precision 用户不可控（后端全支持）；想临时查看被隐藏的州级点无入口。

### 技术债与盲区

- **打包链路未实测**：PyInstaller datas 已配置，但没跑过完整 `dist` 验证打包版 sidecar 装载 gazetteer。**合 main 发版前必须验一次。**
- landmark/locality 层无 Wikidata 别名（只有中英标签）；中文标注的别称（如"帝国大厦"若 zh 标签不同）可能 miss。全量别名需 dump 管线。
- bbox 是固定半径近似（locality ±0.15° 等），非真实行政边界。
- 收藏视图内视窗筛选禁用（browse-collection 不吃 facet filters 的结构性限制）。
- 视频资产无 GPS 通路；`catalogRevision` 长期形态应为主进程统一广播。
- 视觉回归清单（800px 窄窗、隐 Sidebar/Inspector）未系统跑过。

---

## 三、值得做（优先级）

### P0：合并前必做

1. **Phase 2 送代码评审** —— 简报已备好，流程与 Phase 1 相同。零开发成本。
2. **打包验证** —— 跑一次 `npm run dist:mac`（或至少 `build:sidecar`），确认打包版 sidecar 能装载 gazetteer 并解析。半小时量级，不做就是发版盲区。

### P1：性价比最高的收益

3. **对主 catalog 跑 v2 Re-annotate All** —— 当前最大瓶颈不是解析器而是标注覆盖率（82/5,418）。v2 会输出 locality 字段，把"PCH→州级被隐藏"这类照片变成正确的城市级点，同时把 AI 上图数量从 64 提升一个数量级。应用内一键操作 + API 成本，无开发。
4. **手动修正位置（Phase 3 第一项）** —— 唯一能兜底所有残余错误的机制，且后端已全预留，只写 UI（Inspector 入口 + 地图选点 + 批量指定可以同一交互）。估计 1 天量级。**用户决定：暂缓。**

### P2：体验补全（顺手但不急）

5. **place chip**：点击城市级照片组直接按地点筛选（比视窗筛选语义更准，后端现成）。
6. **精度/来源开关**：FilterBar 暴露 include_ai 和"显示低精度点"，给高级用户逃生口。
7. ~~地图相机按 catalog 记忆~~（用户决定不做）。

### 暂缓 / 不建议现在做

- **Wikidata 别名 dump 管线**：等 Re-annotate All 之后看实际 miss 率再决定，别为假设的问题建管线。
- **Sidecar 端聚合 / H3**：5,400 张离 5 万预算很远，设计文档也明确 MVP 不做。
- **真实行政边界 bbox**：固定半径在现有精度语义下够用，边界数据会显著加包体。
- **在线解析兜底开关**：违背零网络定位；目前离线命中率没有暴露出需要它的证据。

---

## 四、结论

功能主干（Phase 1 + 2）已完整、经两轮评审与真实数据验证，质量可合并。合并的两个前置是 P0 的评审与打包验证。合并后第一优先做 Re-annotate All（运营动作）和手动定位 UI（Phase 3 首项），其余按 P2 顺序自然迭代。
