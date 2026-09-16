# docs/ 索引

这个目录混放了两类文档：**描述现状的权威文档**（改了代码要同步改它）和**功能计划**（写在动手之前，落地后就成了历史）。
文件不搬动——README、memory 和代码注释里都有直链——用这份索引说明每一篇的角色。新加计划文档时，
请在文件顶部维护一行 `> **状态（日期）**：…`，并把它加进下面对应的表。

## 现状权威（读它来理解系统；改代码要同步）

| 文档 | 说明 |
|---|---|
| [developer-setup.md](developer-setup.md) | 开发环境、命令、质量门（lint / 单测 / E2E / Python ruff+mypy） |
| [agent-native-mcp.md](agent-native-mcp.md) | 内嵌 MCP server 设计与 34 个 tool 的现状（顶部状态行持续更新） |
| [image-asset-model.md](image-asset-model.md) | 资产 / 版本族 / 注册表数据模型 |
| [settings-scope.md](settings-scope.md) | 哪些设置属于 app、哪些属于 catalog |
| [naming.md](naming.md) | 产品为什么有四个名字（AfterFrame / media-workspace / …） |
| [mcp-testing.md](mcp-testing.md) | MCP 从协议到真实 agent 的测试方法 |
| [ground-truth-workflow.md](ground-truth-workflow.md) | RAW 配对基准数据的标注流程 |
| [demo-projects.md](demo-projects.md) | agent 基准任务集 |
| [ui-feedback-loop-notes.md](ui-feedback-loop-notes.md) | vibepin 标注 → 修改闭环的交接笔记 |
| [review/](review/) | 所有 code review 记录（一次 review 一个文件，含 CONFIRMED / REFUTED 判定） |

## 进行中 / 部分完成（顶部有状态行，看它）

| 文档 | 状态 |
|---|---|
| [geo-map-design.md](geo-map-design.md) | Phase 1（GPS）+ Phase 2（AI 地名离线解析）已实现；Phase 3 未开始 |
| [mcp-parity-plan.md](mcp-parity-plan.md) | Phase 1–2 已实现（17→34 tools）；Phase 3–4 未开始 |
| [web-app-plan.md](web-app-plan.md) | Phase 0 + Phase 1 骨架已实现 |
| [liquid-glass-redesign.md](liquid-glass-redesign.md) | 视觉重构的调研、原型与定调；材质规则是现行约束 |
| [people-recognition-design.md](people-recognition-design.md) | 本地人物识别设计。**注意**：文内状态行仍写「尚未实现」，实际已落地（`ipc/people.js`、`db/people.py`、`native/people-worker.swift`），状态行待回填 |

## 已完成的计划（历史记录；实现以代码为准）

| 文档 | 落地 |
|---|---|
| [foundation-refactor-plan.md](foundation-refactor-plan.md) | 已完成（2026-07-13） |
| [editoroverlay-refactor-plan.md](editoroverlay-refactor-plan.md) | Phase 0 完成；`editor/state/*` 的 hook 拆分模式即此计划的产物 |
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
| [integration-plan.md](integration-plan.md) | 与外部修图软件（Canva 等）的集成，2026-08-16 已全部撤回 |
| [current-plan.md](current-plan.md) | 2026-05-01 的「当前计划」，早已不是当前；保留仅作时间线参考 |

计划文档的目录名保持 `docs/` 而不是移进 `docs/archive/`，是因为代码注释会直接引用它们
（例如 `sidecar/commands.js` 引用 `docs/review-2026-06.md P3-3`）。
