# 人物识别 · 复核意见与修复跟踪

复核对象：[2026-07-11-people-recognition-summary.md](2026-07-11-people-recognition-summary.md)
结论：3 × P2，无 P0/P1 阻断项。

- [x] **P2 · 批量纠错不保证事务原子性**（people.py `remove_faces_from_group` / `assign_faces_to_group`）
  循环中后续 face 失败不回滚已执行更新，"单事务"契约不成立。
  **修复**：新增 `_run_batch_correction` 包裹整个批次（BEGIN/SAVEPOINT + 失败回滚，与 merge/rebuild 同模式）；新增测试 `test_batch_removal_is_atomic_when_one_face_fails`（第二个 face 无效 → 第一个保持 automatic）。

- [x] **P2 · 人物详情纠错只覆盖置信度最高的 40 张脸**（`get_person_group_detail` face_limit=40 无分页）
  **修复**：接口增加 `face_offset` 分页（CLI `--face-offset`、IPC `faceOffset`），返回值带 `face_offset`，`face_count` 作为总数判断是否取完；PeopleInspector 网格底部新增「加载更多（还有 N 张脸）」按钮追加分页，大组全部成员可检查/批量纠错。新增测试 `test_group_detail_faces_paginate`（分页不重叠、总数正确）。

- [x] **P2 · 命名/合并失败产生未处理的 Promise rejection**（NamePersonPopover `void run(...)` 丢弃 rejected Promise，调用方 toast 后 rethrow）
  **修复**：`run()` 内部 catch 吞掉（调用方已 toast），弹窗保持打开可重试，不再泄漏 unhandled rejection。

验证：后端 14 tests 通过（含 2 个新回归）、`vite build` 通过、e2e 18-people-flows 5/5 通过。
