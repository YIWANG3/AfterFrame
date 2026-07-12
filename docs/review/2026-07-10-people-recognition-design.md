# Review：人像识别设计文档（docs/people-recognition-design.md）

- **日期**：2026-07-10
- **分支**：main（文档尚未提交）
- **范围**：docs/people-recognition-design.md 全文，对照 sidecar job runner、
  Electron native helper 先例、catalog schema、research/face-clustering-lab 现状核实
- **流程**：全文通读 → 10 项代码库事实核查 → 逐条验证
- **状态**：设计级 review，无代码改动；条目修复即更新设计文档

## Findings

1. [ ] CONFIRMED · **§3 架构图掩盖了三进程边界，People Worker 的所有权未定义。**
   图中 "Electron main + sidecar job runner" 画成一层，但实际是两个进程：任务持久化
   （jobs 表）在 Python sidecar（`services/sidecar/.../job_runner.py`），而现有 native
   helper 全部由 Electron main spawn（`electron/ipc/depth.js`、`stickers.js`）。
   People Worker 由谁 spawn、生命周期归谁、face records 和进度如何写回 sidecar 的
   jobs 表 / catalog（worker → main → sidecar 三跳还是 sidecar 直接 spawn native
   进程），文档完全没有回答。这是集成层最大的未决问题，应写进 §3 或 §11。

2. [ ] CONFIRMED · **§3.2/§5 把不存在的 job runner 能力描述为现状，基建缺口被低估。**
   现有 jobs 表无 priority 列（`db/jobs.py` 固定 `ORDER BY created_at` FIFO）、无
   pause 状态（状态机只有 queued/running/cancelled/failed/done）、无持久化 cursor
   （`job_runner.py` 的 phase_cursor 仅存活于单次运行）；孤儿 job 由心跳检测直接标
   failed，**不会 resume**。§5.2 还要求闲置调度、低电量降速、编辑器/导出抢占降速，
   这些调度能力全部不存在，且未出现在任何阶段的 deliverable 里（阶段 1 只列了
   "持久化 job、取消/恢复"）。应把 priority / pause / 持久 cursor / 闲置与电量感知
   调度明确列为阶段 1 的新建基建，或裁剪 §5.2 的承诺。

3. [ ] CONFIRMED · **增量聚类（§5.3 第 6 步、§7）的执行位置未指定。**
   worker 返回 face records 后，谁跑候选聚类：Python sidecar（需评估引入 numpy 类
   依赖）还是 native worker 内？§3.1 只禁止依赖 `research/` 的 Python，没说产品侧
   聚类实现形态。complete-link / mutual-neighbor + cannot-link 的增量算法不是小事，
   应在 §3 指定归属进程，并在 §11 补一条实现选型问题。

4. [ ] CONFIRMED · **§9 "清除人物数据" 遗漏 face thumbnail cache。**
   §9 第一条把"裁剪图"列为隐私敏感数据，§3/§5.3 也明确会写 face thumbnail cache，
   但"清除人物数据"的删除清单只有"人脸、embedding、候选和名称"，没有人脸裁剪图
   缓存。清除操作必须一并删除 face crops，否则隐私承诺不成立。

5. [ ] CONFIRMED · **§5.3 跳过键 `asset_content_fingerprint` 与现有字段不对齐，
   且现有指纹是弱指纹。** 实际字段是 `assets.fingerprint`（`schema.py`），由
   `quick_fingerprint` 计算：SHA-1 且默认 head-tail 模式（只读文件头尾）。同一文件
   被编辑软件原地改写中段像素时头尾可能不变，人脸结果会静默陈旧。设计应显式引用
   现有字段名，并确认 head-tail 精度对"跳过已处理资产"是否可接受（或声明升级为
   全文件哈希的条件）。

6. [ ] CONFIRMED · **§4.3 把 ArcFace R50 列为"官方备选"，但 research 从未评估过它。**
   `research/face-clustering-lab` 的三个后端（antelopev2 / AuraFace / arcFaceR100）
   全是 ResNet-100，grep 无任何 R50 痕迹，也无 CoreML 转换记录。按文档自己的规则
   （§4.3 末段：未验收不能假装可用），R50 应标注"待评估"或从表中移除，不能与已研究
   的模型并列成三层级现状。

7. [ ] PLAUSIBLE · **249 MB 体积口径可能过时。** 249 MB 对应 ONNX Model Zoo 的
   FP32 `arcfaceresnet100-8.onnx`；research 的 MODEL_RESEARCH.md 记录 CoreML FP16
   约 130 MB、8-bit 65–75 MB。§10 阶段 0 说生产形态是 Core ML 封装，若最终发布
   FP16 mlpackage，文档中两处 249 MB（§3.1、§4.2）和下载确认页的体积话术都应以
   最终封装为准，建议改为"约 130–250 MB，以发布包为准"。

8. [ ] CONFIRMED · **§6 "遵循 sidecar migration 命名规范" 与实际机制不符。**
   catalog 没有 migration 文件/命名规范：schema 用 `CREATE TABLE IF NOT EXISTS`
   （`schema.py`）+ `SCHEMA_VERSION` 常量 + `_ensure_column` 幂等升级
   （`db/core.py`）。新增 5 张表在此机制下没有障碍，但措辞应改为"遵循 sidecar
   schema.py / SCHEMA_VERSION 幂等升级机制"。

9. [ ] CONFIRMED · **§3.1 未提 Worker 的编译与分发形态。** 现有 helper 中只有
   video-tool 被 `build-native.sh` 预编译，compute-depth/extract-sticker 仍走 swift
   解释器运行——这依赖用户机 toolchain，已知存在 SDK 偏差坑（必须用 Xcode
   toolchain 编译）。People Worker 是长驻进程加载 Core ML 大模型，必须预编译进
   app bundle，这一约束应写进 §3.1。

10. [ ] PLAUSIBLE · **§8.3 "包含人物"标记的语义有歧义。** 标记触发条件是"检测到
    任何脸"（含未确认候选、低质量脸）还是"包含已确认人物"？前者会让扫描期间大量
    缩略图亮标，后者与"人物筛选只列已确认"一致。建议明确为后者，或分别定义。

## REFUTED（保留驳回理由，避免重复怀疑）

- **§7 "初始阈值来自标注测试集" 与 research 现状矛盾** → REFUTED：research 目前
  确实没有正式标注集（0.62 阈值来自 38 图压力测试），但 §11.3 已明确把评估集构成
  与门槛列为实现前待确认项，设计描述的是目标态，自洽。
- **§4.1 下载基建是否重复造轮子** → REFUTED：核实 electron 侧无任何下载 + 哈希
  校验 + 续传基础设施（现有模型随包 bundle 或手填路径），全新建设合理；阶段 1 已
  列入。
- **People Worker 的 NDJSON 协议无先例、风险大** → REFUTED：`electron/sidecar/
  transport.js` 已有成熟的行式 JSON stdin/stdout + 超时/重启实现可直接借鉴，且
  §3.1 留了"或等价的本地 RPC"的余地。

## 参考事实（核实过程中确认，供实现阶段引用）

- 人物筛选接入点：前端 `FilterBar.jsx`（类比 tag popover + `searchFacet`）；后端
  `db/browse.py` `_build_filter_clause` 加 `EXISTS` 子句（类比现有 asset_tags）。
- JobDock（`src/components/JobDock.jsx`）与 ActivityCenter（`ActivityCenter.jsx`，
  含 `JOB_META`）均存在，§5.2 的 UI 落点成立。
- SettingsOverlay 存在，tab 结构（`TABS` 6 项 + `settings/*` 子组件），§8.1 落点成立。
- Inspector.jsx 存在，已有 Section/AnnotationsSection 模式可复用（§8.3 落点成立）。
