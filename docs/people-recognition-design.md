# 本地人物识别与聚类设计

状态：**产品设计，尚未实现**  
默认模型：**ArcFace R100**  
相关原型：[人物与模型交互 Mock](prototypes/people-arcface-ui.html)  
相关旧调研：[people-faces-plan.md](people-faces-plan.md)（其中 Vision FeaturePrint 路线已不再是实现方案）

## 1. 目标与边界

AfterFrame 为本地照片图库提供类似系统相册的“人物”能力：检测图片中的脸、将同一人的脸聚成候选组、由用户确认或命名，并按人物筛选照片。

这不是名人识别，也不尝试给陌生人推断姓名。模型只回答“这些脸是否可能是同一个人”；人物名称、合并与拆分均由用户掌控。

本期范围：

- 人脸检测、质量评估、五点对齐、身份 embedding 与同一人候选聚类。
- 人物候选页、人物筛选、照片详情中的人物列表。
- macOS 本地模型下载、模型版本管理和兼容模型导入。

不在本期范围：

- 云端识别、上传照片或 embedding。
- 自动识别名人/通讯录联系人。
- 宠物识别。宠物需要独立的检测与 re-identification 模型，后续可复用本设计的任务、数据和 UI 框架。
- 将人物结果作为素材文件元数据回写到原始图片。

## 2. 已确定的产品决策

1. **本地优先。** 原始图片、人脸裁剪、embedding、人物名称和候选关系均留在用户设备与当前 catalog 中。
2. **默认识别器为 ArcFace R100。** 它以独立模型包形式下载，而不进入 App 安装包。每个发布的模型包必须锁定来源、版本、SHA-256 和许可证记录。
3. **模型不能阻塞应用。** 检测、embedding、聚类、模型下载和重建索引都是可暂停/取消/恢复的持久化后台任务；React 渲染线程不参与推理。
4. **首次安装不自动扫全库。** 模型就绪后，用户明确选择“分析整个图库”或“只分析以后导入的照片”。
5. **候选优先于断言。** 自动结果先是“人物候选”；只有用户确认后才成为可命名、可筛选的人物。
6. **模型向量绝不混用。** 不同模型或不同版本拥有独立 embedding 空间和人物索引。切换模型不会重解释旧向量，而是提示用户建立新的索引。

## 3. 系统结构

```text
Electron renderer
  ├─ 人物页 / 图库筛选 / Inspector / Settings
  └─ 通过现有 IPC 提交、观察、取消任务
             │
Electron main
  ├─ 解析已打包的 People Worker 路径与 App Support 模型目录
  └─ 以环境变量传给 sidecar（与现有视频 helper 路径注入相同）
             │
Python sidecar job runner
  ├─ 唯一持有 jobs 表、people schema、下载状态与聚类事务
  ├─ 为一个 people job 启动一个 Worker 子进程并消费 NDJSON
  └─ 直接写回 catalog；没有 Worker → main → sidecar 的三跳
             │
macOS People Worker（预编译的独立原生进程）
  ├─ 人脸检测与五点 landmarks
  ├─ 112×112 对齐与质量评分
  ├─ Core ML ArcFace R100 embedding
  └─ 批量返回每张资产的 face records；不写 SQLite
             │
Catalog SQLite + face thumbnail cache
  ├─ face / group / membership / model version
  └─ 供图库、筛选和 Inspector 查询
```

### 3.1 推理实现与分发

生产代码不能依赖 `research/` 中的 Python、InsightFace 或测试模型。研究环境只用于评估和确定阈值。

- People Worker 是一个**随 App 预编译并打包**的 native binary，位于 app resources 的 `native/bin`。构建必须使用选定的 Xcode toolchain；不得在用户机器上以 `swift` 解释器编译或运行。
- 一个 `people_index` job 只启动一个 Worker 子进程；该 Worker 在整个 batch 内保持模型加载，任务结束即退出。首版不引入跨 job 的常驻 Worker 服务，避免新增第二套守护进程与恢复语义；若 profile 证明模型加载成为主要瓶颈，再单独设计 resident service。
- 人脸检测与五点对齐先走 macOS 原生能力；其人脸框、角度和对齐质量必须通过与研究基线的对比验收。
- 若原生 landmarks 在侧脸、遮挡或小脸上未达到验收线，检测器可替换为另一个已审批、可本地打包的检测组件；身份模型、数据结构和 UI 不受影响。
- Worker 使用基于 stdin/stdout 的版本化 JSON/NDJSON 协议或等价的本地 RPC。输入是资产路径和 job token；输出是按资产粒度的结果与错误，绝不把大图复制进 Electron renderer。

### 3.2 任务所有权

sidecar job runner 是人物任务的唯一状态来源：它创建 `people_model_download` / `people_index` jobs、启动和终止 Worker 子进程、写入 face records 和 job checkpoint，并运行聚类。Electron main 不解析 Worker 输出，也不直接写 catalog；它只复用现有 transport 启动 sidecar job，并将 `PEOPLE_WORKER_PATH`、模型目录等已解析路径注入环境。

人物聚类明确归属 **sidecar**，不在 Worker 内执行。Worker 只做可替换的检测、对齐、质量评分和 embedding；sidecar 在写入 face records 后用产品侧、锁定版本的 NumPy 实现候选查找和 complete-link / cannot-link 约束，并在同一数据库事务中写 membership 审计和 checkpoint。NumPy 是发布 sidecar 的显式依赖，不能借用 `research/` 虚拟环境；阶段 2 要验证其打包体积和大图库性能。

## 4. 模型获取、更新与兼容性

### 4.1 官方模型下载

首次点击“下载并启用”后才创建 `people_model_download` 任务。下载确认页必须说明：

- 模型名称、版本、下载体积、许可证与来源；
- 保存位置：`~/Library/Application Support/AfterFrame/Models/<model-id>/<version>/`；
- 联网仅用于获取模型包，照片、人脸裁剪、embedding 和名称不会上传；
- 可取消，下载完成后校验 SHA-256、清单与 Core ML 可加载性，再标记为可用。

下载失败可重试；具备可信 HTTP Range 支持时可恢复临时下载。未通过哈希或清单验证的临时文件必须删除，不能被 Worker 加载。

下载体积由发布 manifest 中的精确 `download_size` 决定。当前研究 ONNX 文件约 249 MB，但生产 Core ML 包预计约 **130–250 MB**（取决于 FP16 / 量化方案）；产品文案和磁盘预检必须展示最终发布包的真实大小，不能写死 249 MB。

### 4.2 自动下载的定义

应用**不会**在安装后或进入人物页时静默下载人物模型。

用户完成首次下载后，可单独开启“允许下载已批准的模型更新”。它只适用于同一模型、同一许可证语义下的已签名补丁。以下情况永远重新询问：模型切换、许可证变化、体积显著变化、下载源变化或主版本升级。

### 4.3 兼容模型

设置页展示三个层级：

| 层级 | 例子 | 行为 |
|---|---|---|
| 推荐 | ArcFace R100 | 默认高精度模型；官方校验下载。 |
| 待评估候选 | ArcFace R50 | 尚未在本项目完成精度、Core ML 转换和回归验证；不能在发布版中显示为可安装。 |
| 实验性 | AuraFace R100、用户导入包 | 不自动成为默认模型；明确标注实验性，建立独立索引。 |

AuraFace 等备选只有在许可证、Core ML 转换、性能和回归测试全部验收后才能显示为“可安装”。在此之前只能作为研究候选，不能在发布版中假装可用。

### 4.4 用户导入模型

不支持直接加载任意 `.onnx` 文件：输入预处理、运行时、许可证、输出语义和安全性均不可验证。首版只接受以下可验证包：

- `.afpersonmodel` 或 `.mlpackage`；
- `manifest.json` 包含 `id`、`version`、模型类型、许可证、来源、SHA-256、输入/输出规范；
- 识别器输入为 AfterFrame 负责对齐的 112×112 RGB 人脸；输出为可 L2 归一化的 512 维 embedding；
- 包内 Core ML 模型必须能在当前 macOS 上加载和运行最小自检；
- 导入后显示“自定义 / 实验性”，并默认使用独立索引。

导入校验只说明“格式与运行时兼容”，不表示识别质量或许可证的商业适用性由 AfterFrame 担保。

## 5. 后台运行策略

### 5.1 什么时候运行

| 触发条件 | 是否默认运行 | 优先级 | 行为 |
|---|---:|---|---|
| 首次模型安装完成 | 否 | — | 用户选“分析整个图库”或“只分析新照片”。 |
| 用户分析选中照片/文件夹 | 是 | 高 | 立即插队，但仍在后台 Worker 中执行。 |
| 新导入照片 | 仅开启“导入后自动分析”时 | 中 | 等 import 主任务完成，合并为增量 batch。 |
| 监控目录自动导入 | 同上 | 中 | 与普通导入共用去重队列。 |
| 全库扫描 / 模型切换重建 | 否 | 低 | 用户确认后，作为维护任务运行。 |
| 单张“重新分析” | 是 | 高 | 仅替换该资产在当前模型版本下的结果。 |

### 5.2 阶段 1 必须新建的任务能力

现有 jobs 实现是 FIFO、只有 `queued/running/cancelled/failed/succeeded` 语义，且运行中的 job 遇到孤儿心跳会直接标记失败。因此下列能力是阶段 1 的交付物，不是现有基础设施：

- `jobs` 增加 `priority`、`pause_requested`、`resume_cursor_json`（或等价的结构化 payload checkpoint）和可恢复 attempt 信息；状态扩展为 `paused`。
- 调度顺序为 priority 降序、创建时间升序。建议：单张/用户选中分析为 `interactive`，导入增量为 `background`，全库与重建为 `maintenance`。
- People job 每成功提交一个资产事务就更新 cursor。应用重启后，带有效 cursor 的 `running` 人物任务改回 `queued` 并从 cursor 续跑；没有可恢复 checkpoint 的任务才失败。
- Pause / cancel 均在当前资产事务完成后生效；JobDock 和 Activity Center 使用这套真实状态，不能只做 UI 假象。

### 5.3 不影响前台的规则

- 默认只运行一个 People Worker。不要为一组照片同时起多个重模型进程。
- 阶段 1 的 Worker 使用 background / utility QoS；高优先级手动任务只抢占**尚未开始**的 maintenance batch，不中断正在处理的一张资产。
- 编辑器/导出/导入期间的自动限速，macOS 闲置检测和低电量/供电感知是**阶段 3**能力。在实现前，不承诺现有 job runner 已能自动感知这些状态。
- 维护任务由用户明确启动；阶段 3 才允许它在应用闲置后自动继续。手动选中的少量资产可以立即开始。
- 取消与暂停在“当前资产处理完成”后生效，避免半条 face record 或半个 cluster 写入数据库。
- UI 进度事件最多每 250 ms 或每 10 个资产发一次；不要为每张脸触发 React 重渲染。

JobDock 仅显示一张紧凑卡片，例如：`分析人物 · 512 / 4,287 · 发现 34 张脸`，可暂停或取消。Activity Center 展示错误、完成和历史详情。

### 5.4 单个资产的流水线

1. 读取原始图或可用的高质量本地预览，不等待 renderer 加载缩略图，并计算 `people_input_hash`：对 Worker 实际收到的、已应用方向的规范化像素输入做 SHA-256。
2. 检测所有脸并取得 landmarks、边界框、旋转信息。
3. 过滤极小、严重模糊或遮挡的脸；保留记录，但标记为低质量，默认不自动进入已命名人物。
4. 五点对齐到 112×112，生成归一化 ArcFace embedding。
5. 在一个短事务中写入该资产的 face records 和 face thumbnail cache。
6. 增量地寻找候选人物；按批次或任务结束后更新候选组，而不是每处理一张图都重跑全库聚类。

现有 `assets.fingerprint` 是 quick head-tail SHA-1 指纹，只能作为发现“可能变化资产”的快捷信号，**不能**单独用于人物结果跳过。即使编辑软件只改写图片中段、使该指纹未变，`people_input_hash` 仍会在准备推理时发现视觉输入变化。

任务可以中断后续跑。只有相同 `asset_id + people_input_hash + model_id + model_version` 的成功索引记录才可跳过；这也覆盖“已分析但没有检测到脸”的资产。

## 6. 数据模型

下列名称为设计级别，最终遵循现有 sidecar 的 `schema.py`、`SCHEMA_VERSION` 与幂等 `_ensure_column` 升级机制。embedding 存为归一化的 Float32 BLOB，不以 JSON 存储。

| 表 | 关键字段 | 用途 |
|---|---|---|
| `face_models` | `model_id`, `version`, `kind`, `manifest_hash`, `status`, `installed_at` | catalog 使用过的模型及其可复现身份；`model_id + version` 共同确定一个向量空间。 |
| `people_asset_index` | `asset_id`, `model_id`, `model_version`, `people_input_hash`, `status`, `face_count`, `indexed_at` | 每个资产、每个模型版本的索引完成状态；无脸资产也有记录。 |
| `asset_faces` | `face_id`, `asset_id`, `model_id`, `model_version`, `bbox`, `landmarks`, `quality`, `embedding_blob`, `thumbnail_key` | 每张照片中、每个模型版本的一张脸。 |
| `person_groups` | `group_id`, `model_id`, `model_version`, `name`, `state`, `cover_face_id`, `created_at` | 候选、已确认、已忽略的人物组。 |
| `person_group_faces` | `group_id`, `face_id`, `membership_state`, `source`, `reviewed_at` | 脸与人物组的归属、人工确认及审计来源。 |

批量 run 的 `scope`、`processed`、`total`、`resume_cursor` 归入扩展后的 `jobs` 行，而非复制一张平行的 run 表；这样 JobDock、Activity Center 与恢复语义共享同一来源。

`source` 至少区分 `automatic`、`user_confirmed`、`user_split`、`user_merged`。人工结论优先于自动重聚类；模型更新不会静默覆盖它们。

## 7. 聚类与纠错规则

- 以余弦相似度和模型版本专属阈值产生候选，初始阈值来自标注测试集，而非暴露为普通用户滑块。
- 使用 complete-link / mutual-neighbor 等抗链式合并约束，避免“每两张都略像”最终串成一个大组。
- 同一照片中的两张不同检测脸默认加入 cannot-link 约束；只有用户手动合并才能覆盖这一保护。
- 质量较低的人脸可展示在候选详情，但不得自动加入已命名人物。
- 人物页提供确认、命名、拆分、合并、忽略。所有纠错要写入 membership 审计，而不是直接丢弃模型结果。

## 8. UI 行为

### 8.1 设置 → 人物

设置使用现有 `SettingsOverlay` 的 tab、卡片和按钮语言。主要区块：

1. 当前模型：未安装、下载中、已安装、损坏/需要更新；
2. 获取与更新：首次授权、自动下载已批准补丁；
3. 分析行为：导入后自动分析（默认关闭）；
4. 兼容模型与导入自定义模型；
5. 隐私与数据清除。

### 8.2 人物页

- 无模型：解释本地处理和体积，入口为“下载并启用”。
- 有模型但尚未扫描：显示“分析整个图库 / 只分析以后导入”。
- 扫描中：已完成候选可逐步出现，顶部显示任务状态，不占用图库界面。
- 正常状态：默认展示待确认候选，已命名人物单独浏览。

### 8.3 主图库、筛选与 Inspector

- 图库缩略图只显示无文字的“包含人物”标记；**不显示人物姓名或数量**，以支持群像。它表示“该资产至少有一张通过基础质量门槛的已检测脸”，包含未命名候选，但不表示已确认或已命名人物；tooltip / accessibility label 使用“包含检测到的人像”。
- “人物”过滤器只列已确认且已命名的人物。选中后以照片级关系筛选：只要照片包含该人物的一张脸，即命中。
- Inspector 的“人物”区才展示具体脸、姓名、候选/已确认状态和审核入口；一张群像可列出多个项目。
- 没有模型时，图库人物筛选禁用，Inspector 显示“设置人物模型”入口，而不是假装没有人物。

## 9. 隐私、安全与故障处理

- 不把图片、裁剪图、embedding 或人名发送到 AfterFrame 服务或第三方模型服务。
- 模型包下载只允许 HTTPS 和批准的 manifest；校验失败、磁盘空间不足、Core ML 加载失败都必须显示可操作错误。
- Worker 崩溃时，job runner 保留最后完成的持久 cursor；有有效 checkpoint 的人物 job 可重试/恢复，不能损坏已成功写入的 face records。
- “清除人物数据”删除 catalog 中的人脸、embedding、候选、名称、`people_asset_index` 记录，**以及该 catalog 的全部 face thumbnail cache**；不删除原始照片。模型文件另有“移除模型”操作。
- 模型文件通过版本路径与 manifest hash 隔离，不能由任意本地路径覆盖官方模型。

## 10. 验收与阶段

### 阶段 0：推理对齐验证

- 将 ArcFace R100 转为/封装为生产 Core ML 形式。
- 用当前研究集对比生产 detector + alignment 与研究基线的配对排序和错误案例。
- 未达到质量线时先替换 detector/landmarks 方案，不开始 UI 集成。

### 阶段 1：模型与任务基础设施

- 官方模型 manifest、下载、校验、移除、恢复下载。
- 预编译并打包 People Worker；Electron main 传递 `PEOPLE_WORKER_PATH`，sidecar 直接管理其子进程与 NDJSON。
- jobs schema 的 priority、pause、持久 resume cursor、可恢复状态机、按优先级调度和 JobDock/Activity Center 映射。
- 最小 schema（含 `people_asset_index`）与单张手动分析、模型专属缓存键。

### 阶段 2：人物结果与纠错

- `asset_faces` / group schema、增量候选聚类、缩略图缓存。
- sidecar 内锁定的 NumPy 聚类实现、事务性 membership 审计与 cannot-link 规则。
- 人物页、确认/拆分/命名、Inspector 人物区。
- JobDock / Activity Center 状态和失败文案。

### 阶段 3：图库融合与评估

- 人物筛选、缩略图“包含检测到的人像”图标、导入后自动分析开关。
- 编辑器/导出/导入期间的自动限速、应用闲置恢复和低电量/供电感知调度。
- 标注测试集的 pair precision / recall、不同质量和群像场景回归。
- 模型切换、导入自定义模型和全库重建流程。

### 上线验收线

- 人物任务不会冻结图库滚动、编辑、导入或退出；取消与恢复可验证。
- 任何照片中的已确认人物都能在 Inspector 准确呈现；群像缩略图不显示姓名标签，且“包含人物”图标语义为检测到合格脸、非已确认人物。
- 同一模型版本的重复扫描不重复计算；不同模型版本不会混用向量。
- 下载校验、离线、磁盘不足、Worker 崩溃和模型不兼容均有可理解且可恢复的提示。
- 在用户授权前没有模型下载、全库扫描或网络传输。

## 11. 实现前仍需确认的问题

1. macOS 原生 detector/landmarks 与研究基线的最终对齐质量是否足够；如不足，选择哪一个已审批的本地 detector。
2. 官方 ArcFace R100 发布包的最终 Core ML 格式、签名/manifest 托管位置以及升级策略。
3. 标注评估集的构成和最低 pair precision / recall 门槛。
4. 对被用户手动合并的“同一张照片内两张脸”的极少数反射/双重曝光场景，是否需要提供覆盖 cannot-link 的高级操作。
5. 最终 Core ML 包的精确体积、量化方式和 manifest 托管位置；发布文案以该结果为准。
6. NumPy 随 packaged sidecar 的体积、签名和大图库性能是否满足发布要求；若不满足，评估将聚类实现下沉为独立原生库的替代方案。
