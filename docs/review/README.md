# Code Review 记录

所有 code review 的意见都存放在这个目录，一次 review 一个文件，命名格式：

```
YYYY-MM-DD-<主题>.md
```

约定：

- **verdict 标注**：每条 finding 标注验证结论（CONFIRMED / PLAUSIBLE / REFUTED）。
  REFUTED 的也保留（附驳回理由），避免后续 review 重复怀疑同一处。
- **状态跟踪**：修复后在条目前的 checkbox 打勾，并注明修复方式或提交。
- **file:line 以 review 当时的工作区为准**，行号会漂移，以符号名/函数名定位为主。
