# docs/ 索引

这个目录混放了两类文档：**描述现状的权威文档**（改了代码要同步改它）和**功能计划**（写在动手之前，落地后就成了历史）。
文件不搬动——README、memory 和代码注释里都有直链——用这份索引说明每一篇的角色。新加计划文档时，
请在文件顶部维护一行 `> **状态（日期）**：…`，并把它加进下面对应的表。

## 现状权威（读它来理解系统；改代码要同步）

| 文档 | 说明 |
|---|---|
| [developer-setup.md](developer-setup.md) | 开发环境、命令、质量门（lint / 单测 / E2E / Python ruff+mypy） |
| [agent-native-mcp.md](agent-native-mcp.md) | 内嵌 MCP server 设计与 34 个 tool 的现状（顶部状态行持续更新） |
| [settings-scope.md](settings-scope.md) | 哪些设置属于 app、哪些属于 catalog |
| [naming.md](naming.md) | 产品为什么有四个名字（AfterFrame / media-workspace / …） |
| [mcp-testing.md](mcp-testing.md) | MCP 从协议到真实 agent 的测试方法 |
| [camera-name-rules.md](camera-name-rules.md) | 相机品牌名、机型名的决定顺序（用户改名 → 手工表 → 规则） |
| [brand-logo-census.md](brand-logo-census.md) | 内置品牌 logo 的 EXIF 标识、来源、许可与商标风险（2026-10-01 调研） |
| [dji-camera-models.md](dji-camera-models.md) | 大疆各机型在 EXIF 里写的型号代码（2026-09-30 调研） |
| [review/](review/) | 所有 code review 记录（一次 review 一个文件，含 CONFIRMED / REFUTED 判定） |

## 进行中 / 部分完成（顶部有状态行，看它）

| 文档 | 状态 |
|---|---|
| [geo-map-design.md](geo-map-design.md) | Phase 1（GPS）+ Phase 2（AI 地名离线解析）已实现；Phase 3 未开始 |
| [mcp-parity-plan.md](mcp-parity-plan.md) | Phase 1–2 已实现（17→34 tools）；Phase 3–4 未开始 |
| [web-app-plan.md](web-app-plan.md) | Phase 0 + Phase 1 骨架已实现 |
| [liquid-glass-redesign.md](liquid-glass-redesign.md) | 视觉重构的调研、原型与定调；材质规则是现行约束 |
| [local-models-plan.md](local-models-plan.md) | 本地小模型与开源库的扩展规划（不做修图、不碰 1 GB 以上）：A 近似重复/相似照片第一步已实现（feat/similar-images），挑片、OCR、视频场景、语义搜索、离线标签待做 |
| [lut-plan.md](lut-plan.md) | 套 LUT 的编辑器工具：P1（只做 Mac）已随 0.5.11 发布（#190）；P2 未开始 |
| [windows-support-plan.md](windows-support-plan.md) | Windows 现状审计、共享/分平台架构与路线；开发机见 `scripts/windows/setup-dev.ps1`。阶段 1、2 已合并，0.5.10 起发布 Windows 安装包（未签名）；签名、真机验收和阶段 3 未做 |
| [foundation-refactor-plan.md](foundation-refactor-plan.md) | Phase 1–3 与补充修复已完成（2026-07-13/14）；Phase 4 的验收条件其实已满足（`window.mediaWorkspace` 只剩 `src/api` 和 `web-main.jsx`），文内没回填；Phase 5–6 未开始 |
| [lens-logos-plan.md](lens-logos-plan.md) | 镜头厂商 logo：暂缓（2026-10-01），只做了导入时读 `lens_make` |
| [folders-page-plan.md](folders-page-plan.md) | 文件夹数量上百后的独立管理页（统计、筛选、多选、批量删除 / 标注）；P1 已实现（2026-10-15，`FoldersView.jsx`、e2e 78）；P2（带搜索的"加入文件夹"选择器、设封面）未开始 |
| [format-support-plan.md](format-support-plan.md) | 进行中（2026-11-01）：对照 Eagle 的文件格式差距与四份扩展名列表互不一致的盘点；P0 格式注册表（#242）、P1 加格式 / 交代不支持 / 原图统一（#243–#245）已合并，P2 的格式 facet 按家族聚合是 #246；JXL、`.xmp` 边车评分、`.mxf` 未开工 |

## 已完成的计划（历史记录；实现以代码为准）

| 文档 | 落地 |
|---|---|
| [next-features-plan.md](next-features-plan.md) | A MCP 接入配置、B 导入后分析人脸、D 智能合集（#91/#102）、E 相框模板与水印档案（#103/#107）已落地；C 手动地点搁置，F 拷贝/粘贴编辑暂停（草稿 PR #89 已关闭） |
| [people-recognition-design.md](people-recognition-design.md) | 本地人物识别，已实现（`ipc/people.js`、`db/people.py`、`native/people-worker.swift`）；0.5.7 起 ArcFace 模型随 app 内置 |
| [integration-plan.md](integration-plan.md) | 「打开方式」和监听文件夹，两项都已落地（`IntegrationsSettings.jsx`、`electron/watcher.js`，e2e 16 / 17）；文中「灯箱懒切换」一条已撤回 |
| [ui-feedback-loop-notes.md](ui-feedback-loop-notes.md) | vibepin 标注 → 修改闭环的交接笔记；vibepin 已作为依赖接入 `src/main.jsx` |
| [editoroverlay-refactor-plan.md](editoroverlay-refactor-plan.md) | 只做了 Phase 0（`editor/state/*` 的 hook 拆分模式即其产物），后续阶段没有推进 |
| [unified-canvas-plan.md](unified-canvas-plan.md) | 统一画布 / 图层模型，已落地（`editorStateModel.js`） |
| [text-tool-plan.md](text-tool-plan.md) | 文字工具，已落地（`TextPanel` / `TextCanvas`） |
| [frame-watermark-plan.md](frame-watermark-plan.md) | 相框 / EXIF 水印，已落地（`useFrameTool`、`frameRender.js`，e2e 20） |
| [handwriting-sticker-plan.md](handwriting-sticker-plan.md) | Phase 1 / 1.5 已完成（2026-08-01） |
| [batch-collage-plan.md](batch-collage-plan.md) | P1 已实现（e2e 25） |
| [split-carousel-plan.md](split-carousel-plan.md) | P1 已实现（e2e 33） |
| [settings-transfer-plan.md](settings-transfer-plan.md) | P1 已实现（e2e 34） |
| [mcp-coverage-audit.md](mcp-coverage-audit.md) | 2026-08-16 的一次性盘点，是 mcp-parity-plan 的前置 |
| [review-2026-06.md](review-2026-06.md) | 2026-06 综合 review 与清理计划（`db.py` 拆包、`main.js` 抽 transport 都源于此；后续 review 记录改放 `review/`） |
| [cover-editor.md](cover-editor.md) / [editor-ui-requirement.md](editor-ui-requirement.md) | 2026-04 的编辑器设计与需求稿 |
| [sticker-board-spec.md](sticker-board-spec.md) | 贴纸功能规格（2026-05） |
| [people-faces-plan.md](people-faces-plan.md) | 人脸分组可行性研究，被 people-recognition-design 取代 |

## 已撤回 / 已过期

| 文档 | 说明 |
|---|---|
| [current-plan.md](current-plan.md) | 2026-05-01 的「当前计划」，早已不是当前；保留仅作时间线参考 |
| [image-asset-model.md](image-asset-model.md) | 2026-04 的资产模型设想（`raw_source` / `export_variant` …），代码里没有采用；实际模型是 `resource_sets` + `asset_links`，见 `db/resource_sets.py` |
| [demo-projects.md](demo-projects.md) | 2026-05 的 agent 基准任务集设想，没有落地 |

计划文档的目录名保持 `docs/` 而不是移进 `docs/archive/`，是因为代码注释会直接引用它们
（例如 `sidecar/commands.js` 引用 `docs/review-2026-06.md P3-3`）。
