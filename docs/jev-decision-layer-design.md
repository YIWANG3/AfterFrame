# Jev 决策层设计：自然语言搜索、标签管理、描述管理

> 状态：**2026-09-18 搁置**，未实现。依据当天的实测（500 张真实 caption，6 个查询，脚本未入库）。
> 搁置原因：推给普通用户的门槛太高。用户要先配标注 key 并标注全库，再注册 OpenRouter 拿第二个 key；端点还在 alpha，中国大陆可达性未验证。
> 重启时先回答三个问题：(1) 决策层是否改成多后端，默认复用用户已配的标注 provider，Jev 只作可选加速（该后端未实测）；(2) 应用内语义搜索是否改走本地 embedding；(3) 是否有了账号体系、可以由我们托管代理。
> 不依赖 Jev、可以单独做的部分：标签别名表与合并/改名（3.2）、描述可编辑与保护、标注时带上已知事实（4.2）。
> 涉及的外部事实（端点、价格、限制）都来自发布三天内的 beta 产品，实现前需要重新核对。

## 0. 背景与边界

**Jev 是什么。** TypeSafe 的「System One」模型，2026-09-15 发布。输入一段文本状态加一组类型化问题，返回带校准概率的判定，不生成任何文字。

| 项 | 值 |
|---|---|
| 接入 | OpenRouter `POST https://openrouter.ai/api/alpha/decisions`，模型 `typesafe/jev-1.13`。不支持 `chat/completions` |
| 请求 | `{ model, state, questions }`；`state` 可为字符串、对象、数组 |
| 题型 | `noul`（是/否概率）、`choice`（选项上限 255）、`score`（分级量表） |
| 响应 | 每题带 `probabilities` 与 `confidence`，外加 `usage.cost` |
| 价格 | 输入 $0.042/M token，输出免费。题目 schema 也计入输入 |
| 上下文 | 32K |
| 限制 | 只收文本，看不了图；端点在 `alpha` 路径下；准确率无独立复现 |

**它在本项目里的定位。** 不替换任何现有 AI 管线（标注要看图、重绘要出图，它都做不了）。它是新增的一层：读库里已有的文本（caption、tags、OCR、地点、人名、EXIF），在有限选项里做判断。

**实测结论**（500 张，每请求打包 25 张，16 并发）：

- 每个查询 0.8 到 1.5 秒，约 $0.0036。中文查询对英文 caption 直接可用。
- 抽象查询（「孤独感」）命中合理；库里没有的内容（「下雨天的日本街头」）最高分只有 0.27，分数会如实偏低。
- **打包有邻居干扰**：同一张图换一批邻居重跑，平均分差 0.10，最大 0.50；与单张请求相比，0.5 阈值判定翻转 4/40。高分段排序稳定，边界段会抖。
- token 成本：打包每张约 170，单张请求每张约 420。

由此得到贯穿全文的两条规则：

1. **排序可以打包，硬判定必须单张请求。**
2. **所有判定按 `(问题, asset, annotation.updated_at)` 缓存**，同一个问题对同一张图只付一次钱。

---

## 1. 公共基础：决策层

### 1.1 sidecar 模块 `decisions.py`

沿用项目手写 `urllib` 的风格，不引 SDK。

```python
ask(state, questions) -> {answers, usage}          # 单次请求，429/529/502/503 指数退避
ask_many(requests, workers=16) -> Iterator[...]    # 线程池并发，按完成顺序产出
```

- 端点 URL 与模型 id 是模块常量，alpha 路径变动时只改一处。
- 每次调用累计 `usage.input_tokens` 与 `usage.cost`，长任务结束时写进 job 结果，UI 能显示「本次花费」。
- 预留第二个 transport：TypeSafe 直连 `POST https://api.typesafe.ai/v1/systemone`，请求体完全相同，只是 URL 和 key 不同。第一版只实现 OpenRouter。

### 1.2 配置与密钥

- 设置里新增一个独立分区「智能判定」，和「标注」「重绘」并列。它的 provider 形态和那两套都不同，不要塞进现有的 provider 列表。
- key 走现有的 `electron/tokens.js`，命名空间 `decisions:openrouter`。dev 下回退到 `.env` 的 `OPENROUTER_API_KEY`。
- 传给 sidecar 的方式沿用 `jobArgv.js` 的做法：argv 里的 key 在 spawn 前挪进环境变量。
- **默认关闭**。开启时明示：会把照片的描述、标签、地点名、人名和你的搜索词发给 OpenRouter 与 TypeSafe，**不发送图片**。

### 1.3 缓存表

```sql
CREATE TABLE decision_cache (
  question_key TEXT NOT NULL,      -- sha1(kind + 规范化后的问题文本 + model)
  asset_id     TEXT NOT NULL,
  anno_version TEXT NOT NULL,      -- asset_ai_annotations.updated_at
  answer_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (question_key, asset_id)
);
```

标注更新后 `anno_version` 对不上，该行视为失效。表可以整张清空，不是权威数据。

### 1.4 降级

没有 key、离线、端点报错时，所有功能静默退回现状（搜索退回 `LIKE`），只给一条不打断的提示。任何功能都不能因为决策层不可用而坏掉。

---

## 2. 自然语言搜索

### 2.1 交互

- 打字时保持现在的 `LIKE` 即时搜索，不调用 Jev。全库跑一次约 $0.04，不能每次按键都触发。
- **回车**触发语义搜索。搜索框右侧一个小的语义开关，记住上次状态。
- 结果流式出现：哪个请求先回来，哪批图先按分数插入网格。用户在 1 秒内看到第一批结果。
- 结果分档，不显示数字：
  - ≥ 0.8：正常显示
  - 0.5 到 0.8：分隔线下方，标题「可能相关」
  - < 0.5：不显示
  - 如果没有任何 ≥ 0.5 的结果：显示「没有很匹配的照片」，下面列出最高的 12 张作为弱结果
- 未标注的照片无法参与，结果区底部显示「N 张未标注，未参与搜索」，带一个去标注的入口。

### 2.2 管线

```
查询文本
  │
  ├─① 查询理解（1 个请求，约 300ms）
  │     → 结构化筛选条件（只在置信度 ≥ 0.8 时采用）
  │
  ├─② SQL 取候选：现有 scope + 现有筛选 + ①的筛选，且已标注
  │
  ├─③ 粗排：打包请求，对所有候选打分（流式返回）
  │
  └─④ 精排：对前 60 名和 0.35 到 0.65 的边界段，单张请求重新打分
```

**① 查询理解。** 一个请求问一组 `choice` 题，选项来自 `get_catalog_info` 同源的 facets：

| 题 | 选项 |
|---|---|
| 相机 | 库里的相机型号 + `none` |
| 镜头 | 库里的镜头型号 + `none` |
| 年份 | `capture_time` 跨度内的每一年 + `none` |
| 季节 | 春、夏、秋、冬 + `none` |
| 方向 | 横、竖、方 + `none` |
| 类型 | 照片、视频 + `none` |
| 最低评分 | 1 到 5 + `none` |

采用的筛选条件以可移除的 chip 形式出现在 FilterBar 里。用户能看到系统替他加了什么，点一下就能去掉。Jev 提取不了自由文本，所以这里不处理地名和人名，它们留给 ③ 在内容层面匹配。

**③ 粗排。** 每个请求打包 40 张（32K 上下文下留足余量，实现时用实际 token 数校准）。每张图的 state：

```json
{ "caption": "...", "tags": [...], "text": "OCR 截断到 200 字",
  "place": "San Francisco, United States", "when": "2024-11", "people": ["已命名的人物"] }
```

题目：

```
instructions: Would photo pN be a good result for the photo-library search query "<查询>"?
              Judge only on what the photo shows, its place, people and mood.
              Ignore parts of the query about camera gear, dates or file properties;
              those are filtered separately.
criteria:     true  = the photo's content or mood clearly fits the query
              false = the photo does not fit the query
```

请求的发送顺序：`LIKE` 或 tag 能命中任一查询词的图排在前面，这样最可能相关的图最先出结果。

**④ 精排。** 单张请求，结果覆盖粗排分数并写入缓存。粗排分数不进缓存（受邻居影响，不够稳定）。

### 2.3 成本与延迟（5600 张全库，推算值）

| 阶段 | 请求数 | token | 成本 |
|---|---|---|---|
| 查询理解 | 1 | 约 1.5K | 可忽略 |
| 粗排（40 张/请求） | 140 | 约 95 万 | 约 $0.04 |
| 精排（约 120 张） | 120 | 约 5 万 | 约 $0.002 |

延迟取决于并发上限。TypeSafe 直连的公开限额是 1200 请求/分钟，OpenRouter 侧的限额未知，需要实测。按 16 并发、每请求 0.4 秒估算，粗排约 4 秒跑完，第一批结果在 1 秒内出现。查询理解如果缩小了候选，时间和成本按比例下降。

同一个查询第二次执行：精排过的图直接读缓存；只有新标注的图需要补打分。

### 2.4 MCP

`search_assets` 增加 `semantic_query` 参数，可以和所有现有筛选参数组合。返回的每条记录多一个 `score` 字段，并按分数排序。工具描述里写明：找「某种内容或氛围的照片」时优先用它，能省掉反复换关键词和 `view_assets` 确认的开销。

这一步不需要任何 UI，建议最先做，用 agent 先把质量跑顺。

### 2.5 代码落点

- sidecar：新增 `semantic_search.py`；CLI 命令 `semantic-search`，输出 NDJSON 流（每完成一个请求输出一批 `{asset_id, score, stage}`）。
- electron：IPC 加一个流式通道。桥接表（`0dafb30` 引入的单表声明）里登记。
- renderer：浏览目的地已经收敛成单一 scope 值（`9367be8`），新增一种 `semantic` scope，携带查询文本和按分数排好的 id 列表。网格、灯箱、多选都复用现有逻辑。
- web 版：暂不支持。浏览器直连 OpenRouter decisions 端点的 CORS 情况未验证。

---

## 3. 标签管理

### 3.1 现状问题

- 标签只是 `asset_tags.tag` 字符串，没有实体表，没有全库级的改名、合并、删除。
- 标注时的去重只有大小写精确匹配（`merge_with_existing_tags`），代码注释里明确写了模糊匹配「有意不做」，理由是怕出现意外改写。
- 结果是词表分裂：`dusk / twilight`、`coast / coastal`、`city / urban / cityscape`、`night / nightscape`。
- 高频标签信息量很低：`urban` 1703 张、`scenic` 1642 张、`outdoor` 1376 张，占库的四分之一以上，筛选时没有区分度。

### 3.2 基础设施（不依赖 Jev，先做）

```sql
CREATE TABLE tag_aliases (alias TEXT PRIMARY KEY, canonical TEXT NOT NULL);
CREATE TABLE tag_meta    (tag TEXT PRIMARY KEY, category TEXT, hidden INTEGER NOT NULL DEFAULT 0);
```

- sidecar 操作：`rename_tag`、`merge_tags(sources, target)`、`delete_tag`。合并时 `INSERT OR IGNORE` 目标行再删源行，同步改写 `asset_ai_annotations.tags_json`，并把每个源写进 `tag_aliases`。
- `merge_with_existing_tags` 查表时把别名也算进去。这样合并一次之后，将来标注再产出 `twilight`，会自动落到 `dusk` 上，**合并不会被新标注冲掉**。
- 搜索的 tag 子句同时匹配别名，搜 `twilight` 也能找到合并后的图。
- UI：一个标签管理面板。列表带数量、可排序，支持多选合并、改名、删除、隐藏。
- MCP：`list_tags` 已有，补一个 `manage_tags`（rename、merge、delete、hide）。

### 3.3 Jev 驱动的功能

**(a) 同义合并建议。** 不做两两配对（N² 太浪费），利用 `choice` 的 255 选项上限：

1. 对每个标签发一个请求：「库里哪个已有标签和 `X` 是同一个意思？」选项是数量最多的 254 个标签加 `none`。N 个标签只要 N 个请求。
2. 对第 1 步里非 `none` 且概率 ≥ 0.5 的配对，再发一个单独的 `noul` 复核，criteria 明确区分三种关系：
   - 同义（`dusk` 与 `twilight`）：true
   - 上下位（`san francisco` 与 `california`）：false
   - 只是相关（`beach` 与 `coast`）：false
3. 输出建议清单，按概率排序，≥ 0.85 的默认勾选。保留哪个由数量决定，数量多的为目标。用户确认后调用 `merge_tags`。

几百个标签，整轮成本不到一美分。这是一次性任务，结果落在本地，之后离线的 `LIKE` 搜索和筛选也跟着变好。

**(b) 标签分类。** 每个标签问一道 `choice`：`地点 / 主体 / 场景 / 光线与时间 / 天气 / 氛围 / 风格与技法 / 其他`，写入 `tag_meta.category`。

- FilterBar 的标签 facet 按类别分组，几百个标签不再是一个长列表。
- 「地点」类标签和已有的地点数据重复（`california`、`san francisco`、`japan`），可以提供一个选项把它们从标签 facet 里隐藏，地点筛选交给地图。

**(c) 中英配对。** 标注设置允许同时产出中英标签。用 (a) 的同一套机制，把 `日落` 和 `sunset` 配成别名，搜任意一个都能命中。

**(d) 低信息量标签。** 纯计数，不需要 Jev：覆盖率超过 25% 的标签标记为「过于宽泛」，建议隐藏，并从标注 prompt 的复用提示里剔除（否则模型会继续大量使用它们）。

**(e) 标注时的归一化。** 视觉 LLM 返回了词表里没有的新标签时，先问 Jev 一道 `choice`（现有词表 + `new`）。概率 ≥ 0.9 才映射到已有标签，否则保留新标签。每次标注多花的钱可以忽略。这补上了「模糊匹配有意不做」留下的空缺，而且 0.9 的阈值保留了原来「不要意外改写」的意图。

**(f) 标签回填。** 「给所有符合的照片打上标签 X」本质上是一次语义搜索加批量打标。直接复用第 2 节的管线，但必须用单张请求模式（这是硬判定），结果分两档给用户确认：高置信度的默认勾选，边界段的逐张看。打上的标签 `source` 记为 `ai`。

---

## 4. 描述管理与优化

### 4.1 Jev 在这里能做什么

Jev 写不了描述。它的角色是**质检和分诊**：找出哪些描述有问题、为什么有问题，把它们送回视觉 LLM 重写，并且带上更多上下文。

### 4.2 基础设施（不依赖 Jev，先做）

- **描述可编辑。** inspector 里 caption 改成可原地编辑。
- **保护用户的修改。** `asset_ai_annotations` 加两列：`caption_source`（`ai` 或 `user`）和 `previous_caption`。重新标注时，`caption_source = 'user'` 的描述不被覆盖（标签和地点照常更新）；任何覆盖都把旧值存进 `previous_caption`，可以一键恢复。
- **标注时带上已知事实。** 目前只有 EXIF GPS 会覆盖地点猜测。把解析好的地名、已命名的人物、拍摄月份一并写进视觉 LLM 的 prompt。这一条不花 Jev 的钱，却是描述质量提升最大的一项：模型不用再猜这是哪、这是谁。

### 4.3 描述体检（后台 job，`caption-audit`）

每张图一个单张请求，一个 state 上问多道题（多题共用 state，比分开问便宜得多）：

| 题 | 类型 | 查什么 |
|---|---|---|
| 具体程度 | `score` 0 到 3 | 从「一条城市街道」这种泛泛的描述，到写明主体、光线、地点的描述 |
| 与标签一致 | `noul` | 描述和标签有没有互相矛盾 |
| 与地点一致 | `noul` | 描述里提到的地方，和 GPS 或手动地点解析出的地名是否矛盾。GPS 是事实，矛盾就是描述错了 |
| 与拍摄时间一致 | `noul` | 描述写夜景，EXIF 却是 13:00。这道题的结果按行程汇总后，同时是「相机时区没改」的检测信号 |
| 与人脸数一致 | `noul` | 检测到 3 张脸，描述里却完全没提到人 |

不需要 Jev 的检查放在同一个 job 里，用代码做：连拍组里几乎相同的描述、描述语言和设置不符、描述为空或被截断。

结果写入：

```sql
CREATE TABLE annotation_health (
  asset_id TEXT PRIMARY KEY,
  specificity INTEGER,
  issues_json TEXT NOT NULL DEFAULT '[]',   -- [{kind, probability}]
  anno_version TEXT NOT NULL,
  audited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

全库跑一遍的推算成本：5600 × 约 450 token ≈ 250 万 token ≈ $0.11。新标注的图增量体检。

### 4.4 优化闭环

1. FilterBar 增加「标注需复查」筛选，可以按问题类型细分。
2. 选中这批图，一键「重新标注」。走现有的 `run_annotation_job`，传 asset 列表，并且：
   - 自动带上 4.2 里的已知事实；
   - 把体检发现的问题写进 prompt，例如「上一版描述把地点写成了洛杉矶，GPS 显示是圣迭戈」；
   - 允许在这一步换一个更强的模型，只对有问题的这一小部分图付高价。
3. 新描述写入后重新体检。问题消失则关闭；仍然存在则留在复查列表里，交给用户手动改。
4. `caption_source = 'user'` 的描述只体检、不自动重写。

这也是官方推荐的 confidence-routing 用法：便宜的模型筛一遍，只把有问题的部分升级给贵的模型。

### 4.5 做不到的

Jev 看不到图，所以它判断不了「描述是否忠实于画面」。它只能发现描述和其他已知事实之间的矛盾，以及描述本身是否空泛。描述质量的上限仍然由视觉 LLM 决定。

---

## 5. 分期

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | `decisions.py`、设置分区、key 存储、缓存表、降级 | 0.5 天 |
| P1 | `semantic_search.py` + CLI + MCP `semantic_query`（无 UI，先用 agent 验证质量） | 1 天 |
| P2 | 搜索 UI：回车触发、流式结果、分档、筛选 chip | 1.5 天 |
| P3 | 标签基础设施（别名表、合并/改名、管理面板）+ 同义合并建议 | 2 天 |
| P4 | 标签分类、低信息量标签、标注时归一化、标签回填 | 1.5 天 |
| P5 | 描述可编辑与保护 + 标注带已知事实 | 1 天 |
| P6 | 描述体检 job + 复查筛选 + 重新标注闭环 | 2 天 |

P3 的基础设施和 P5 完全不依赖 Jev，即使 Jev 这条路走不通也值得做。

## 6. 风险

- **端点不稳定。** `alpha` 路径、beta 状态。所有调用集中在 `decisions.py` 一处，功能全部可降级。
- **准确率。** 官方自测 67.8%，无独立复现。对策是永远分档展示，边界段交给用户，不做无确认的批量写入。
- **打包干扰。** 已实测。对策见第 0 节的两条规则。
- **隐私。** 默认关闭，开启时明示发送内容。人名是否发送单独给一个开关。
- **定价可能变。** 官方承认无法证明当前价格不含补贴。缓存表让已经判过的结果不受影响。
- **可达性。** OpenRouter 在中国大陆的可达性未验证。

## 7. 待定问题

1. 语义搜索用回车触发，还是一个独立的开关按钮？（设计稿取回车加开关。）
2. 第一版要不要同时支持 TypeSafe 直连？（设计稿取否，但 transport 预留。）
3. 人名默认发不发？（设计稿取默认不发，单独开关。）
