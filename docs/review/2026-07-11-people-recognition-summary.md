# 人物识别功能 · 变更总结（供复核）

分支 `codex/people-recognition`，工作树相对 HEAD 约 47 文件 / +2093 −322。
本文覆盖本轮（2026-07-10 ~ 07-11）在 Codex 原有基础上的全部改动；`marketing/` 目录（演示素材 pipeline）已 gitignore，不在 diff 内。

## A. 功能层变更

### A1. 识别质量：两个根因修复
1. **People Worker 像素缓冲翻转 bug**（[apps/desktop/native/people-worker.swift](../../apps/desktop/native/people-worker.swift)）：`makeBuffer` 里多余的 CGContext 垂直翻转导致 ArcFace 收到的是"人脸位置垂直镜像处"的图块，embedding 全部无效（与正确输出 cos≈0，与翻转采样 cos≈0.95-0.99，已实证）。删除翻转后 worker 输出与 coremltools 参考实现一致（cos≈0.96-0.98）。修复改变 `people_input_hash`，自动触发全量重算。
2. **聚类从单链接改为抗链式**（[db/people.py](../../services/sidecar/src/media_workspace/db/people.py) `rebuild_candidate_groups`）：原 union-find 单链接把 363 张脸串成一个组。重写为贪心 average-link：合并需「平均跨组相似度 ≥ threshold(0.48)」且「最弱一对 ≥ threshold − chain_slack(0.10)」；同照片两张脸 cannot-link；每脸候选边 top-64 上限；分块矩阵乘保内存。

### A2. 人物页（PeopleView 重写）
- 脸部头像墙：方形小圆角 FaceCrop 封面（bbox CSS 裁剪，无新缩略图管线），已命名在前、脸数排序，<3 张脸的未命名小组沉底
- 贴纸页同款顶栏：标题 + 计数、扫描按钮（触发 people_index 任务、轮询进度、完成自动刷新、失败 toast）、刷新、人物搜索
- 无限滚动（IntersectionObserver 每页 80，替代「显示全部」按钮）
- 方向键移动选框（按实际网格列数）、Enter 打开、Esc 取消；焦点随选中移动（修复双高亮）
- 空状态含「扫描人脸」「人物设置」入口
- 「忽略」功能按用户决定移除（数据层 ignored 状态与 CLI 保留，无 UI 入口）

### A3. 命名 / 合并 / 建议
- Apple 式「命名即确认」：NamePersonPopover 统一交互；输入已有名字 → 合并确认；候选组无「待确认」标签
- 命名弹窗默认展示**按质心余弦相似度排序的 TOP10 合并建议**（新接口 `similar-people-groups`），打字则按名字过滤
- merge 保留目标组身份，成员迁移记 `source='user_merged'`；跨模型空间禁止合并

### A4. 人物详情面板（新组件 PeopleInspector）
- 大封面、点击改名、脸数/照片数、「查看照片」「创建相册」（取该人全部照片建 manual collection）
- 「组内人脸」网格（新接口 `people-group-detail`，含 photo_count 与脸样本）
- **纠错**：点击多选 + 底部批量操作栏 + 右键菜单——「更正为其他人物…」（PersonPickerPopover）/「移出」；批量单事务

### A5. 图库集成
- FilterBar 常驻「人物」下拉（PersonFilterPopover：头像+名字+脸数，打开时现拉数据）；person_group 筛选激活时触发按钮显示人名
- Toolbar 标题显示人物名；「含人物」文案改「含人脸 / Has faces」
- 照片 Inspector 人物区：脸 chip（FaceCrop）、hover ↔ 预览 bbox 高亮、未命名点击即命名、已命名点击跳转、右键纠错菜单、未匹配脸弱化显示（文案「未匹配到人物」）

### A6. 稳健性
- 重聚类排除 confirmed **和 ignored** 组的脸（修复 UNIQUE(face_id) 崩溃导致扫描静默失败）
- 用户纠错（rejected）跨重建持久：候选组删除保留 rejected 行为隐藏墓碑；列表 HAVING 过滤空未命名组
- 封面照片被删：`list_person_groups` 读取时 COALESCE 回退到组内最高置信度脸，无空白 tile
- 扫描失败 toast + 浏览失败 toast（此前均静默）；`[browse]`/`[filters-effect]` 诊断日志
- per-catalog 状态隔离：`usePeopleGroups` 以 catalogPath 为 key 重置；`switchCatalog` 清空 facet filters

## B. 代码改动清单

### Sidecar（Python）
| 文件 | 改动 |
|---|---|
| `db/people.py` | `rebuild_candidate_groups` 重写（A1.2/A6）；`list_person_groups`（cover_bbox、COALESCE 封面回退、HAVING、命名优先排序）；`get_asset_people`（返回 bbox、过滤 rejected）；新增 `set_person_group_name`（命名即 confirmed）、`set_person_group_state`、`merge_person_groups`、`get_person_group_detail`、`list_similar_person_groups`（质心相似度）、`remove_face_from_group` / `assign_face_to_group`（+批量版，审计 `user_split`/`user_confirmed`）、`_cleanup_group_after_departure`（空组清理，保墓碑） |
| `cli.py` | 新子命令：`rename-people-group`、`set-people-group-state`、`merge-people-groups`、`people-group-detail`、`similar-people-groups`、`remove-face-from-person`、`assign-face-to-person`（face-id 可重复） |
| `db/__init__.py` | 导出新函数 |

### Electron 主进程
| 文件 | 改动 |
|---|---|
| `electron/sidecar/commands.js` | 7 个新命令包装（含批量 faceIds） |
| `electron/ipc/browse.js` | 7 个新 IPC handler（读操作静默降级，写操作抛错给渲染层） |
| `electron/preload.js` | 对应桥接方法 |

### 渲染层（React）
| 文件 | 改动 |
|---|---|
| `src/components/FaceCrop.jsx` | 新增：bbox → CSS 百分比裁剪的方形头像组件（全功能复用） |
| `src/components/NamePersonPopover.jsx` | 新增：命名/合并统一弹窗 + 相似度 TOP10 建议 |
| `src/components/FaceMenu.jsx` / `PersonPickerPopover.jsx` | 新增：纠错右键菜单、人物选择器（Inspector 与 PeopleInspector 共用） |
| `src/components/PeopleInspector.jsx` | 新增：人物详情面板（A4 全部） |
| `src/hooks/usePeopleGroups.js` | 新增：人物组共享状态（本地补丁不重排、扫描轮询、catalogKey 重置） |
| `src/components/PeopleView.jsx` | 重写（A2） |
| `src/components/Inspector.jsx` | 人物区脸 chips、bbox 高亮、命名/纠错入口 |
| `src/components/FilterBar.jsx` | PersonFilterPopover 常驻人物筛选 |
| `src/App.jsx` | openPersonGroup/createAlbumFromPerson、PeopleInspector 接线、peopleGroup 状态与 filters 联动清理 |
| `src/hooks/useWorkspace.js` | `filterByPerson`（另一 agent 并行添加，已确认兼容）、loadBrowser catch+toast+诊断日志、switchCatalog 清 filters、`reloadDetail` 导出 |
| `src/api/index.js` | 新 api 方法 |
| `src/i18n/locales/{zh-CN,en}/{nav,inspector}.json` | 人物相关文案全量更新 |

### 测试
- `tests/test_people.py`：12 个测试。聚类（防链式桥接、同照片 cannot-link、确定性、ignored 不崩溃不回流、封面回退与修复）、写接口（命名/合并审计、忽略、纠错 reject/reassign 审计与跨重建持久、相似度排序不按大小）
- `apps/desktop/e2e/12-people-view.spec.js`：文案与标题更新（空状态）
- **`apps/desktop/e2e/18-people-flows.spec.js`（新增，5 测试）**：头像墙渲染（命名+候选、封面为真实脸裁剪非占位图）、命名流程（相似建议出现 → 输入命名 → 原位更新）、查看照片筛选（5/8 张 → 清除恢复）、图库常驻人物下拉筛选、批量移出（多选 2 → 批量栏 → 计数 4→2）
- **新 fixture `e2e/fixtures/people-catalog.afcatalog`**（提交入库，2.9MB + 528KB 图）：8 张 AI 生成虚构人像（无肖像权风险），由 `seed-people-catalog.js` 离线用真实 worker+ArcFace 预扫描——DB 内含真实 embedding 与人物组，**CI 无需 Core ML 模型**。布局：Lin Xi 已命名 ×5 脸、未命名候选 ×4 脸、1 张三人合照含一个无组单例脸。`launchApp` 新增 `catalogFixture: "people"` 选项

## C. 验证情况

- 后端 18 tests 通过（people 12 + people_job 2 + jobs 4）；`vite build` 通过；e2e 12 spec 通过
- 真实数据实证：翻转 bug 用「stored vs 翻转采样 cos 0.95-0.99」证明；聚类修复在 507 脸 live 副本上演练（无崩溃、68 组、封面 0 空缺、7 命名人物无损）
- Playwright 全流程复现（catalog 副本 + 真实 app）：人物筛选、清除、二次筛选、下拉选人均正确
- 相似建议在 live 数据上验证（正确目标 0.858 断层第一）

## D. 建议复核重点

1. `rebuild_candidate_groups` 的 savepoint/嵌套事务路径与大库（>10k 脸）内存/性能假设
2. 墓碑语义：候选组仅剩 rejected 行时对 `person_groups` 级联、`HAVING` 过滤和后续 assign 的边界
3. ~~批量纠错的事务性~~（已按复核意见修复：`_run_batch_correction` 全批次回滚 + 原子性测试，见 [review 跟踪](2026-07-11-people-recognition-review.md)）
4. `usePeopleGroups` 本地补丁与后端真实状态的漂移窗口（rename/merge 后不重拉列表）
5. FilterBar/Inspector 中直接使用 `window.mediaWorkspace` 与 api facade 混用的一致性
6. e2e 覆盖：命名/筛选/批量纠错已有 e2e（18-people-flows）；仍缺 e2e 的交互——合并确认流、右键菜单路径、Inspector bbox 高亮
