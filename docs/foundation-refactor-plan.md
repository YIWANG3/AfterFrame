# 新功能前基础重构计划

状态：**进行中**
建立日期：2026-07-13

## 目标

在开始下一批产品功能前，先降低跨 Renderer、Electron main、Python sidecar
和 Catalog schema 的改动风险。此次重构坚持行为保持，不改变现有产品功能，
每个 Phase 都必须可以独立合入和回滚。

当前基线已经验证：

- Python 单测：68 通过
- Electron Playwright E2E：103 通过，8 个演示场景跳过
- Vite production build：通过
- Swift native tools build：通过

## 原则

1. 每个 Phase 先补保护性测试，再移动边界。
2. 不以行数为目标机械拆文件；只拆有明确所有权的 domain。
3. IPC、设置文件和 Catalog schema 属于稳定边界，优先于 UI 整理。
4. 大型协调层按下一个 feature 的落点选择性拆分，不一次性重写。
5. 每个 Phase 完成后至少运行相关单测、Vite build 和核心 E2E。

## Phase 1 — 设置持久化可靠性

状态：**已完成（2026-07-13）**

问题：

- App/Catalog settings 直接覆盖 JSON，进程中断可能留下半写文件。
- `app:save-preview-settings` 未等待写入完成就重新读取，可能返回旧值。
- 设置写队列、路径和文件写入都住在 `electron/main.js`，难以独立测试。

交付：

- 抽取独立 settings store。
- App 和 Catalog settings 使用临时文件 + rename 原子替换。
- 保留 App 全局串行、Catalog 按路径串行的并发语义。
- 设置 IPC 只有在落盘成功后才返回成功状态。
- 增加并发更新、失败后队列恢复、Catalog 隔离和临时文件清理测试。

验收：

- settings store 单测全绿。
- Settings、Catalog switch、watched directories E2E 全绿。
- Python、Vite build 无回归。

完成记录：

- 新增 `electron/settingsStore.js`，统一 App/Catalog settings 读写与写队列。
- JSON 通过同目录临时文件写入、`fsync` 后 rename，失败时清理临时文件。
- `app:set-locale`、`app:save-preview-settings` 与 Catalog switch 均等待落盘。
- 新增 4 个 Node 单测；Python 63、Electron E2E 103、Vite build 全绿。

## Phase 2 — 统一质量入口与 CI

状态：**已完成（2026-07-13）**

交付：

- 提供仓库级 `check`、Python test、Renderer unit test、E2E 命令。
- 增加 ESLint 与 React Hooks 检查，先记录并清理现有基线问题。
- 为 editor math、format、API facade 等纯模块增加快速单测。
- GitHub Actions 检查 Python、Renderer build、lint；macOS 工作流运行 Electron E2E。

验收：

- 新 clone 不需要猜 `PYTHONPATH` 即可运行测试。
- PR 可以自动阻止 build、lint、unit test 回归。

完成记录：

- 新增根目录 npm scripts；`npm run check` 统一运行 lint、Python/Node/Renderer
  单测和 Vite production build，`npm run test:e2e` 运行完整 Electron E2E。
- 引入 ESLint flat config、React Hooks 规则与 ESLint bulk suppression 基线。
  当前存量 81 项按文件/规则锁定，新增同类问题仍会使 lint 失败；后续可逐步
  清理 `apps/desktop/eslint-suppressions.json`，不必在本 Phase 冒险改 Hooks 行为。
- 新增 format、crop math、selection math 共 12 个快速 Renderer 单测；Vitest
  仅扫描 `src`，不会误执行 Playwright 或 Node test 文件。
- 新增 GitHub Actions：Linux 执行仓库级检查与 production dependency audit，
  macOS 构建 native tools 并执行 Electron E2E。
- 最终验证：`npm run check` 通过；Python 63、Node 4、Renderer 12、Electron E2E
  103 通过（8 个演示场景跳过）；Vite 与 Swift native tools build 通过；
  production dependency audit 为 0 vulnerability。

## Phase 3 — Catalog schema 与 DB 拆包收尾

状态：**已完成（2026-07-13）**

交付：

- 删除 DB domain 模块中复制遗留的 imports、常量和旧 `SCHEMA_VERSION = 5`。
- schema version 只保留一个权威来源。
- 建立显式、顺序执行的 migration 机制。
- 增加旧版 Catalog fixture 升级测试和重复执行幂等测试。

验收：

- 旧 Catalog 可无损升级到当前版本。
- migration 中断不会把 schema version 标成已完成。

完成记录：

- `schema.py` 成为 Catalog `SCHEMA_VERSION` 的唯一权威来源；annotation payload
  的独立版本改名为 `ANNOTATION_SCHEMA_VERSION`，避免概念混淆。
- 新增 `db/migrations.py`，按 v2→v3→v4→v5→v6→v7 顺序迁移，并在一个
  `BEGIN IMMEDIATE` 事务中完成；任何一步失败都会回滚 schema 与版本号。
- 补齐历史上缺失的 v5→v6 数据迁移：`export_lookup_registry`、asset/root
  类型无损转换为 `image_*` 结构，保留现有 asset id 和业务数据。
- 当前版本启动仍会幂等补齐最新表、列和索引；高于应用版本的 Catalog 会被
  明确拒绝，不再被静默降级。
- 清理 7 个 DB domain 模块从旧单文件拆包时复制遗留的 imports、sentinel、
  resolver/schema 常量。
- 新增 5 个 migration 测试，覆盖所有支持的旧版本链、v5 数据保留、重复执行、
  中断回滚和新版本拒绝。
- 最终验证：Python 68、Node 4、Renderer 12、Electron E2E 103 通过
  （8 个演示场景跳过），Vite production build 通过。

## Phase 4 — Renderer / Preload API 边界

状态：**待开始**

交付：

- Renderer 组件不再直接调用 `window.mediaWorkspace`，统一经过 `src/api`。
- API facade 与 preload surface 建立自动一致性测试。
- 开发环境缺少 bridge method 时显式报错，不再静默返回 `undefined`。
- 为主要 payload 增加 JSDoc 类型和最小运行时校验。

验收：

- `window.mediaWorkspace` 只出现在 API client、i18n 启动适配和测试后门中。
- preload 增删方法时 contract test 能立即失败。

## 补充修复 — 编辑器覆盖导出与 Preview 一致性

状态：**已完成（2026-07-14）**

问题：

- watched directory 只处理新文件 `add`，Lightroom 同路径 overwrite 不会重新导入。
- 同路径 asset 虽会更新 metadata，但已有 `ready` preview 会被跳过。
- 大文件分段写入时，等待窗口不足以证明文件完整；macOS 解码器可能把已写入的
  上半段解码成功，并用灰色填充尚未写入的下半段。
- preview 原地更新后 URL 不变，Renderer 可能继续显示 Chromium 缓存里的旧图。

交付：

- watcher 同时处理 `add` / `change`，并把稳定等待从 1.5 秒提高到 3 秒。
- 导入阶段对比同路径 asset 的 fingerprint、大小和 mtime；内容变化时保留 asset ID，
  但强制重建 standard preview，以及已有的 HD preview。
- JPEG 必须出现完整 EOI；渲染前后源文件 size/mtime 必须一致。检查失败视为暂缓，
  overwrite 时保留最后一个可用 preview；首次导出的半写文件暂不进入 Catalog，
  两者都等待后续文件变化事件重试。
- preview 仍通过同目录临时文件 + atomic replace 发布；gallery/lightbox URL 加入
  源文件 revision，重建完成后绕过 Renderer 缓存。
- Gallery 右键菜单新增“从磁盘刷新”：右键未选中素材时处理单张，右键当前多选
  中的素材时处理整批；重新读取 metadata、强制重建 standard preview，并刷新
  已存在的 HD preview。完成、暂缓和失败都通过 Toast 反馈。
- Browse 在原有 missing-file stat 中同时比较源文件 size/mtime 与 Catalog；发现
  历史记录已过期，或图片缺少 width/height/file size 时，Gallery 会静默批量走同一
  `refresh-assets` 路径。因此即使灰底 preview 本身仍是可解码 JPEG、不会触发
  `<img onError>`，重新打开/浏览该页也能自愈 metadata 和 preview。
- 缺失/损坏 preview 的 image error 仍会按需自愈；每张素材允许一次额外重试，
  避免启动阶段的瞬时加载错误永久耗尽自愈机会，同时限制失败循环。
- 修复 `⌘A` 后 selection 被写成 `Set` 的类型漂移；刷新数据时不再因调用
  `.filter()` 崩溃并把 Gallery 变成黑屏。
- 新增单测覆盖 incomplete JPEG、渲染中变化和同路径 asset identity；watched-dir
  E2E 覆盖 overwrite 后 preview hash 改变且 gallery 不产生重复 asset；Gallery E2E
  覆盖单张/多选右键菜单、损坏 preview、有效但过期 preview、缺失 metadata，
  以及刷新后保留 Gallery/selection。

验证：

- `npm run check`：Python 73、Node 4、Renderer 12、lint 和 Vite build 全通过。
- Electron E2E：106 通过、8 个演示场景跳过；watched directories 4/4 通过，
  包括新增 overwrite 场景。

## Phase 5 — 离线字体、包体与故障隔离

状态：**待开始**

交付：

- 去除桌面 App 对 Google Fonts 的运行时依赖，保证中文文字预览/导出离线一致。
- Editor、Settings、Collage、AI 等大型 Overlay 按需加载。
- 开发 DesignSystemPanel 不进入 production bundle。
- 为大型 Overlay 增加 Error Boundary。
- 补 CSP、navigation/new-window 限制和显式 BrowserWindow 安全配置。

验收：

- 断网启动、中文文字预览和导出正常。
- production build 不包含开发设计面板。
- 单个 Overlay 崩溃不会使整个应用白屏。

## Phase 6 — 协调层按领域拆分

状态：**待开始，依赖下一 feature 落点**

候选拆分：

- `electron/main.js` → app settings、catalog session、media/video services。
- `useWorkspace.js` → browser、catalog、collections、imports。
- `job_runner.py` → 各 job runner + 共享 lifecycle。
- `cli.py` → 按 domain 注册 parser 和 handler。
- `EditorOverlay.jsx` → 剩余 viewport/keyboard/apply orchestration。

这一步不全量执行。下一 feature 触碰哪个领域，就先拆对应边界，并以现有 E2E
作为行为保护。
