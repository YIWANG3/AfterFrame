# 标签（tags）重构设计：分组、归并与整条链路

> **状态（2026-11-09）**：已按本稿实现（分支 `feat/tag-groups`）。用户拍板：迁移时词表概念的中英双写法自动合并；多选默认语义保持「任意一个」，「按组」为可选模式；管理面是侧栏「标签」页；内置组 13 个。实现与本稿的差异见各节 **实现备注**。目标版本 0.5.19，catalog schema 13 → 14（「多级文件夹」#270 先合用了 13，本分支随后改成 14）。

## 1. 现状与问题

### 1.1 数据

- 标签只有一张表 `asset_tags(asset_id, tag, source)`，`tag` 是字符串即身份，`source` 是 `ai` / `user`。没有「标签」这个实体：一个标签存在，等于至少有一张照片带着它；没有分组、没有别名、没有置顶。
- 大小写与空白在写入时归一（`annotation.normalize_tag` + `merge_with_existing_tags`），库里已有的拼写胜出；除此之外没有任何同义归并，`sunset` 与 `日落` 是两个标签。
- AI 标注（`annotation.py` + `data/annotation_prompt.json`）让模型输出一个扁平 `tags` 数组（上限 `max_tags`，语言由设置里的「标签语言」决定，可中英同出），再把库里最常用的 200 个标签塞进 prompt 当「优先复用」提示。一次标注替换该照片上一次的 AI 标签，用户手加的保留。
- 老目录里曾经的「手加标签造 stand-in 标注行」问题已由 `_drop_hand_tag_stand_ins` 修掉，这次不用再管。

### 1.2 界面

- **Inspector**（`TagsSection.jsx`）：一排芯片，点芯片按它筛选，悬停出现删除；「添加」是一个带后端联想的输入框。20 个 AI 标签排成一团，天气、地点、情绪混在一起，扫一眼找不到想要的。
- **筛选栏**（`FilterBar.jsx` → `ListPopover`）：「标签」是一个 200px 宽的列表，默认只放用量前 60 的标签 + 搜索。多选语义：默认「任意一个」，可切「同时含全部」或「排除」。几百个标签时就是滚一长条。
- **批量**（`TagBatchDialog.jsx`，T 键 / 右键菜单）：只能加，不能批量删。
- **管理**：没有。重命名、合并、删除一个标签都做不到，错别字标签会一直在。
- **侧栏**：没有标签入口。
- **搜索框**：全文 LIKE 命中标签，但只是「包含这个词的照片」，不能变成一个标签条件。

### 1.3 查询与 MCP

- `db/facets.py` 的 `tag` facet：`tag`（一个或一组）+ `tag_match: any|all` + `exclude`。
- `db/browse.py get_facet_values` 返回前 60 个标签带计数，`search_facet_values(field="tag")` 做服务端搜索。
- 智能合集的规则就是这个 filters 字典（`smart_rules.py` 按 `FACET_KEYS` 校验）。
- MCP：`list_tags`（扁平 + 计数）、`update_assets(add_tags / remove_tags)`、`search_assets(tag, tag_match)`。
- Web 版（`src/api/browser/*`）在内存里镜像了同一套语义，共用同一个 prompt JSON（`@sidecar-data/annotation_prompt.json`）。

### 1.4 用户反馈

「标签太散、没有类别、不好用」。根因是标签没有结构：既没有「这是个什么类型的标签」，也没有「这两个标签是不是一回事」，于是查看、筛选、管理都只能在一个大池子里捞。

## 2. 目标与非目标

**目标**

1. 每个标签属于一个分组（或未分组）。分组有内置的一套，也可以自定义。
2. AI 标注直接按组产出，老标签按内置词表自动归组；归不了的留在「未分组」，用户能一键挪。
3. 中英同义（`sunset` / `日落`）归成一个标签，另一种写法作为别名：写入时自动折叠，搜索照样命中，界面按语言显示。
4. 查看、添加、筛选、管理一条链路都按组来：Inspector 分组显示与快速添加；筛选栏按组折叠展示并计数；批量加 / 删；标签页做重命名、合并、删除、移组、置顶。
5. 智能合集和 MCP 能用「分组」和「标签」两层条件。

**非目标**

- 不做标签层级（组里套组）。一层分组够用，再深就是文件夹的事。
- 不做 embedding / 语义近邻合并。同义只认词表和用户手动合并。
- 不改 `asset_tags` 的主键形状（仍是 `(asset_id, tag)`，字符串即身份）。改成 tag_id 会让 browse / facets / search / MCP 十几处 SQL 全部重写，收益只有「重命名快一点」，不值。
- 不动颜色筛选（按色板算的那个）。「色彩」分组里的是语义标签（暖色调、黑白），两者并存。

## 3. 分组模型

### 3.1 表结构（schema 14）

```sql
CREATE TABLE tag_groups (
    group_id   TEXT PRIMARY KEY,          -- 内置组是固定 id（weather…），自定义组是随机 id
    name       TEXT NOT NULL,             -- 自定义组的名字；内置组存英文名，界面按 id 走 i18n
    kind       TEXT NOT NULL CHECK (kind IN ('builtin', 'custom')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    ai_fill    INTEGER NOT NULL DEFAULT 1,  -- 0 = 只给人用，prompt 不向它要标签
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tags (
    tag        TEXT PRIMARY KEY,          -- 与 asset_tags.tag 同一个字符串
    group_id   TEXT REFERENCES tag_groups(group_id) ON DELETE SET NULL,   -- NULL = 未分组
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tag_aliases (
    alias      TEXT PRIMARY KEY,          -- 归一化后的写法（小写、单空格）
    tag        TEXT NOT NULL REFERENCES tags(tag) ON DELETE CASCADE
);
CREATE INDEX idx_tags_group ON tags(group_id);
```

- `tags` 是标签实体：分组、置顶、时间。一行对应 `asset_tags` 里一个不同的 `tag`，由写入路径（`add_asset_tag(s)`、`save_annotation`）顺手维护，`_apply_latest_schema` 里再放一句 `INSERT OR IGNORE INTO tags SELECT DISTINCT tag FROM asset_tags` 兜底。没有照片用的标签允许存在（用户刚建、还没贴），标签页可见、筛选栏不列。
- `tag_aliases`：别名 → 正名。来源三个：用户合并（被并掉的名字成为别名）、用户重命名（旧名成为别名）、内置词表的另一种语言写法。写入任何标签前先过 `resolve_tag()`：归一化 → 查别名 → 查已有标签（现有的大小写归一逻辑并进来）→ 都没有就是新标签。
- 不加 `tags.color`。颜色给分组会让芯片一排彩色，和现有的克制风格不搭；分组用位置和小标题区分就够了。

### 3.2 内置分组

13 个组，分四类。任务里点名的天气 / 画面元素 / 器材只是例子，这里按摄影师实际会按什么找片来补全：

| id | 中文 | English | 词表里的例子 |
|---|---|---|---|
| `weather` | 天气 | Weather | sunny 晴、cloudy 多云、overcast 阴、rain 雨、snow 雪、fog 雾、storm 暴风雨、rainbow 彩虹 |
| `season` | 季节 | Season | spring 春、summer 夏、autumn 秋、winter 冬、cherry blossom 樱花、autumn leaves 红叶 |
| `time` | 时段 | Time of day | sunrise 日出、golden hour 黄金时刻、blue hour 蓝调时刻、daytime 白天、sunset 日落、dusk 黄昏、night 夜晚 |
| `light` | 光线 | Light | backlight 逆光、side light 侧光、soft light 柔光、hard light 硬光、neon light 霓虹灯、night lights 夜灯、window light 窗光、candlelight 烛光 |
| `subject` | 画面元素 | Subject | people 人物、portrait 人像、street 街头、architecture 建筑、landscape 风景、skyline 天际线、food 美食、animal 动物、plant 植物、vehicle 车辆、water 水面、sky 天空、signage 招牌 |
| `place` | 地点类型 | Place type | city 城市、beach 海滩、mountain 山、forest 森林、lake 湖、river 河、desert 沙漠、indoor 室内、cafe 咖啡馆、temple 寺庙、museum 博物馆、park 公园、bridge 桥、subway 地铁、rooftop 天台 |
| `event` | 场合 | Occasion | travel 旅行、wedding 婚礼、festival 节日、concert 演出、sports 运动、party 聚会、daily 日常、commute 通勤 |
| `gear` | 器材 | Gear | drone 无人机、phone 手机、film 胶片、action camera 运动相机、telephoto 长焦、wide angle 广角、macro 微距、fisheye 鱼眼 |
| `technique` | 构图手法 | Technique | long exposure 长曝光、silhouette 剪影、reflection 倒影、symmetry 对称、leading lines 引导线、top-down 俯拍、low angle 仰拍、close-up 特写、panorama 全景、bokeh 虚化 |
| `style` | 风格 | Style | black and white 黑白、film look 胶片感、minimal 极简、cinematic 电影感、vintage 复古、documentary 纪实、high contrast 高对比、HDR |
| `color` | 色彩 | Color | warm tones 暖色调、cool tones 冷色调、monochrome 单色、pastel 粉彩、neon 霓虹、red 红、blue 蓝、green 绿、golden 金色 |
| `mood` | 情绪 | Mood | calm 宁静、lively 热闹、melancholic 忧郁、dramatic 戏剧性、cozy 温馨、lonely 孤独、romantic 浪漫、mysterious 神秘 |
| `workflow` | 用途 | Workflow | to edit 待修、portfolio 精选、client 客片、published 已发布、stock 素材 |

- 环境（天气 / 季节 / 时段 / 光线）、内容（画面元素 / 地点类型 / 场合）、拍法（器材 / 构图手法 / 风格 / 色彩）、感受与用途（情绪 / 用途）。
- `workflow` 只给人用：`tag_groups.ai_fill = 0`，prompt 不向它要标签，词表映射也不会把 AI 的输出送进去。每个组（含自定义）都有这个开关，在标签页的组菜单里切「让 AI 填这个组」。
- 内置组可以重命名、也可以删除（删了标签回未分组，prompt 也不再向它要标签），只是预先建好、id 固定，词表和 prompt 才认得。
- 筛选弹层和 Inspector 只显示当前有标签的组，组多不会把面板撑长。

完整词表放 `services/sidecar/src/media_workspace/data/tag_vocabulary.json`（约 200 个概念），每条 `{ "en": "sunset", "zh": "日落", "group": "time" }`，Web 版和渲染层通过现有的 `@sidecar-data/*` 别名共用同一个文件。

### 3.3 AI 标注怎么归组

**主路径：prompt 按组输出。** `annotation_prompt.json` 的 `tags` 字段改成一个对象：

```
"tags": {"weather": [...], "time": [...], "subject": [...], ..., "other": [...]}
```

prompt 里列出目录当前 `ai_fill = 1` 的分组（内置 + 自定义，按 id 和名字），每组后面跟这组在库里最常用的标签当复用提示（每组最多 25 个 + 未分组最多 40 个，替代现在不分组的 200 个）。`max_tags` 仍是总上限，`other` 装归不进任何组的。

解析时兼容扁平数组（旧 prompt、模型不听话）：扁平数组里的每个标签走第二条路。

**第二条路：词表映射。** 新标签如果词表里有，归到词表的组。

**保存时的优先级**：库里已有这个标签且已有组 → 保持；库里有但未分组 → 采用模型给的组（须是 `ai_fill = 1` 的组）；库里没有 → 词表认识的词走词表的组（词表是确定的，模型会把 sunset 放进「光线」），词表不认识的走模型给的组（如果这个 group_id 存在且 `ai_fill = 1`），否则未分组。用户的决定永远赢过模型。

> **实现备注**：`db/tags.py TagResolver` / `ensure_tag` 与 `annotation.save_annotation`；词表概念落在 `ai_fill = 0` 的组（如「用途」）时，AI 写入的落为未分组。

### 3.4 中英同义归并

- 词表里的每个概念有 `en` 和 `zh` 两个写法。目录里第一次出现哪种写法，哪种就是正名，另一种登记为别名。以后 AI 或用户再写另一种写法，`resolve_tag()` 折叠到正名。
- 界面显示：词表概念按界面语言显示（zh-CN 界面看到「日落」，英文界面看到 sunset），正名存什么不影响；用户自己合并出来的别名不带语言，一律显示正名。显示映射由渲染层读同一份词表完成，不加字段。
- 搜索框：`_search_clause` 增加一条 `EXISTS (... asset_tags JOIN tag_aliases ...)`，搜「日落」命中标着 sunset 的照片。
- **迁移时对已有数据**：一个词表概念的两种写法都在库里时，把用量少的并进用量多的（改写 `asset_tags` 行，同一照片两行只留一行，`source` 取 user 优先），少的那个成为别名。这是唯一一次自动改数据；非词表标签一律不猜。
  - 备选：迁移不合并，只把两种写法归到同一组，标签页里给「可合并」提示让用户点。更保守，但用户点名要的就是归并，而且这是无损的（别名保留、搜索照旧、显示按语言）。**推荐自动合并。**
- 「标签语言」设置保留现有语义（可中英同出）。同出时词表概念会被折叠成一个，非词表的（埃菲尔铁塔 / Eiffel Tower）仍是两个，保证跨语言搜索不退化。

### 3.5 未分组

- 迁移后归不进词表的老标签全在「未分组」。筛选栏、Inspector 都把它作为最后一节显示，不藏。
- 标签页（见 5.3）有「未分组」一栏，支持多选后「移到分组」，以及一个「按词表再归一次」按钮（新加了词表概念或恢复了删掉的组时用）。
- P2：「用 AI 归组」，把未分组列表发给当前 provider 做一次纯文本调用，拿到建议后用户确认再写。这次不做，接口留着（`suggest-tag-groups` 命令）。

## 4. 浏览与筛选

### 4.1 筛选栏「标签」弹层

`ListPopover` 不动，`tag` facet 换成新的 `TagGroupPopover`（宽 260）：

- 顶部搜索框，输入即跨组过滤（服务端 `search_facet_values(field="tag", group=…)`）。
- 下面按组一节一节：组名 + 该组在当前范围内的标签数；每节默认展开显示用量前 8 个（置顶的永远在前），超出的那部分折成「还有 N 个」，点开后在这一节内列全。有选中项的组始终展开。未分组最后一节。
- 组标题左侧有一个勾：勾上等于「有这组里任意一个标签」（facet `tag_group`），用于「有地点类型标签的」「没有天气标签的（排除）」这类条件。
- 多选语义切换（有两个以上选中时出现）：**任意一个（默认，现状）** / 按组 / 同时含全部 / 排除。用户 2026-11-09 定：默认保持「任意一个」，按组作为可选模式。
  - **按组** = 同组内「或」，跨组「与」：选了「晴」「多云」「街头」，意思是（晴或多云）且街头。未分组标签每个自成一组（都是「与」）。
  - 任意 / 全部 / 排除沿用现有语义，老的智能合集规则（没写 `tag_match` 的）仍读作「任意」，一条不变。
- 芯片摘要：`晴 +2`、`不含标签 …` 沿用现有写法；勾了组时写 `有天气标签`，与标签一起时同样 `+N`。

### 4.2 facet 的变化（`db/facets.py`）

- `tag` facet：`tag_match` 新增 `by_group`。实现：查一次 `tags.group_id`，按组分桶，每桶一个 `EXISTS (… t.tag IN (…))`，桶之间 AND。
- 新 facet `tag_group`：一个或一组 group_id，`EXISTS (SELECT 1 FROM asset_tags t JOIN tags ON tags.tag = t.tag WHERE t.asset_id = assets.asset_id AND tags.group_id IN (…))`；`exclude` 可翻转。`FACET_KEYS` 自动把它带进智能合集校验。
- `get_facet_values`：`tags` 从「前 60」改成「每组前 12 + 置顶 + 当前选中」，每项带 `group_id`、`pinned`；新增 `tag_groups: [{group_id, name, kind, sort_order, tag_count, asset_count}]`。`search_facet_values(field="tag")` 加 `group` 参数。

### 4.3 侧栏「标签」入口

加一个「标签」页（`viewMode = "tags"`，与人物 / 发现 / 文件夹并列），入口在侧栏浏览行下面（图标 lucide `Tags`）。这是管理面（第 5.3 节），也是「看看我有哪些标签」的地方：点任何一个标签就回到图库并以它筛选。

### 4.4 搜索框输入即筛标签

工具栏搜索框输入时，在下拉里给出最多 6 个匹配的标签（带组名小字），点一个就加成 `tag` 筛选并清空搜索框；回车仍是现在的全文搜索。不改搜索语义，只是给一个把「词」变成「条件」的快捷方式。

## 5. 编辑

### 5.1 Inspector

`TagsSection` 按组渲染：每组一行小标题（9px、muted，组名）+ 该组芯片；未分组最后、不写标题。空组不显示。

- 芯片点击仍是「按它筛选」；右键（或悬停出现的 ⋯）给菜单：按它筛选 / 移到分组 ▸ / 置顶 / 重命名… / 从这张照片移除。移组、置顶、重命名是库级操作，走标签 API，不是照片级。
- 「添加」展开输入框、分组选择和输入框上方的滚动弹窗，添加行保持等高，检查器保持原滚动位置。弹窗随检查器宽度和输入行上方的可用空间调整，分组标题独占一行，标签芯片沿用检查器中的样式，从下一行开始自动换行。组内置顶标签优先，空组省略，「未分组」排在最后。输入框为空时显示图库全部标签，输入文字后按标签名、显示名或别名过滤。当前照片上的标签使用 Accent 配色。点击标签即可在当前照片上添加或移除它，弹窗保持打开。输入文字后按回车可添加标签，新标签沿用分组选择与「自动」规则。
- `data-testid` 保持 `inspector-tags`、`tag-add`、`tag-add-input`，新加 `[data-tag-group=<id>]` 节容器。

### 5.2 批量

`TagBatchDialog` 加一个 添加 / 移除 切换：

- 添加：现状不变，联想分组显示，置顶优先。
- 移除：候选是所选照片上标签的并集（带「N 张有」计数，新命令 `list-selection-tags`），勾选后一次写入（新命令 `remove-asset-tags`，与 `add-asset-tags` 对称）。
- 右键菜单的「添加标签…」旁加「移除标签…」；快捷键 T 仍开添加，Shift+T 开移除（走 `shortcuts/store.js` 可改绑）。

### 5.3 标签页（管理面）

布局是 `PeopleView` / `FoldersView` 那套壳：顶部 `LibraryToolbar`（搜索、排序：用量 / 名称 / 最近使用），下面按组一栏一栏（组标题 + 计数 + 组菜单），每组里是标签行（名称、别名小字、照片数、置顶星）。未分组是最后一栏，另有一个「全部」视图是扁平表。

操作：

| 操作 | 怎么做 | sidecar 命令 |
|---|---|---|
| 新建组 / 重命名组 / 删除组 | 组标题菜单；删除时标签回未分组，会确认 | `manage-tag-groups --action create\|rename\|delete` |
| 移到分组 | 多选标签后工具栏「移到…」，或拖到另一组标题上 | `set-tag-group --tag … --group …` |
| 重命名 | 行内编辑（InlineEdit）；旧名成为别名 | `rename-tag --tag old --to new` |
| 合并 | 多选 2 个以上 → 「合并到…」选正名；其余成为别名，照片上的行改写 | `merge-tags --into target --tag a --tag b` |
| 删除标签 | 从所有照片上拿掉并删实体，会确认（显示影响张数） | `delete-tag --tag …` |
| 置顶 / 取消 | 行上的星 | `pin-tag --tag … --pinned 0\|1` |
| 按词表再归一次 | 未分组栏的按钮，只动未分组的 | `regroup-tags --vocabulary` |

全部是一次写入一次 `catalog-changed` 广播（scope `tags`），`tagStore` 收到后清缓存、`loadFacetValues` 重拉。

## 6. 智能合集

规则字典多了 `tag_group` 和 `tag_match: by_group`，`normalize_rules` 靠 `FACET_KEYS` 自动放行，`FilterGroupsDialog` 嵌的是同一个 `FilterBar`，所以「条件分组（或）」里也能用。老规则不受影响。标签被重命名 / 合并后，规则里存的是旧字符串：`merge_tags` / `rename_tag` 顺手改写所有智能合集 `rules_json` 里的 `tag` 值（递归进 `any_of` 和 `base`），别让合集静默变空。

## 7. 数据迁移（13 → 14）

`_migrate_to_14`：

1. 建三张表，`INSERT OR IGNORE` 13 个内置组。
2. `INSERT INTO tags(tag) SELECT DISTINCT tag FROM asset_tags`。
3. 按词表归组：遍历词表，`en` / `zh` 两种写法（归一化比较）在 `tags` 里有的，`group_id` 设为词表的组。
4. 同一概念两种写法都在：按 3.4 合并（用量少的并入多的；`asset_tags` 改写，同照片去重，`source` user 优先；被并的进 `tag_aliases`；智能合集规则里的字符串改写）。
5. 词表里只出现一种写法的，另一种写法直接登记为别名，以后写进来就折叠。

新目录在 `_apply_latest_schema` 里得到同样的内置组和兜底的 `tags` 行。`_backup_before_migration` 照旧先备份 `.schema12.bak`。`tests/test_schema_migrations.py` 加一个 12 的旧目录用例（带中英各一个 sunset / 日落、一个词表外的标签、一条引用 `日落` 的智能合集）。

与「多级文件夹」的协调：两个改动互不依赖，迁移函数各自独立，谁后合谁把编号改成 14、`SCHEMA_VERSION` 改 14 即可，PR 描述写明。

## 8. MCP

| tool | 变化 |
|---|---|
| `list_tags` | 返回 `{ count, groups: [{group_id, name, kind, tags: [{tag, count, pinned, aliases}]}], ungrouped: [...] }`；参数 `group`、`query`、`limit` |
| `search_assets` | `tag_match` 加 `by_group`；新参数 `tag_group`（一个或一组 group_id） |
| `update_assets` | `add_tags` 不变（新标签按自动规则落组）；加 `tag_group` 可选参数：这次加的新标签都放进这个组 |
| `manage_tags`（新） | 一个 tool 多 action，仿 `manage_collections`：`create_group` / `rename_group` / `delete_group` / `move` / `rename` / `merge` / `delete` / `pin` |
| `get_catalog_info` | facets 概览里带上 `tag_groups` |

`initialize` 的领域模型说明加一段 TAG / TAG GROUP。`docs/agent-native-mcp.md` 顶部状态行和 tool 表同步（34 → 35 tools）。`toolSchemas.test.js` 自动覆盖新 tool 的 schema。

## 9. Web 版（`src/api/browser`）

`FilterBar`、`TagsSection`、标签页都是共用组件，Web 版的内存镜像要跟上，否则 Web 构建的筛选栏直接坏：`catalog.js` 的 `getFacetValues` / `searchFacet` 带组、`matchesRules` 实现 `by_group` 与 `tag_group`、`annotation.js` 维护一份内存 `tags` / `aliases` / `groups`、`llm.js` 的 prompt 构造同步读新字段。标签页的管理操作在 Web 版可用（只在内存里）。

## 10. i18n

- `nav.json`：`filter.tagGroup`、`filter.match.byGroup`、`filter.tagMore`、`sidebar.tags`、`tags.*`（标签页文案）、`tagGroups.{weather,time,…}`（9 个内置组名）。
- `annotation.json`：Inspector 芯片菜单、组选择「自动」、批量对话框的 添加 / 移除 切换与移除模式文案。
- 中文文案不用破折号；面板不加说明性文字。

## 11. 测试

**Python（`tests/`）**

- `test_tag_groups.py`：`resolve_tag`（大小写、别名、词表跨语言）；`save_annotation` 按组输出与扁平回退；用户的组赢过模型；`add_asset_tag(s)` 自动落组；`merge_tags` / `rename_tag` / `set_tag_group` / `delete_tag` / `pin_tag`，含智能合集规则改写；`remove_asset_tags`；facets `by_group`、`tag_group`、`exclude`；`get_facet_values` 的分组形状；`search_facet_values(group=…)`；`_search_clause` 命中别名；CLI 命令（经 `cli.main`）。
- `test_schema_migrations.py`：12 → 14 用例（见第 7 节）。
- `test_annotation_prompt.py`：分组 prompt 的形状、每组复用提示上限、自定义组出现在 prompt 里。
- `test_smart_collections*.py`：`tag_group` / `by_group` 通过校验，旧规则不变。

**渲染层（vitest）**

- 纯函数：标签选项分桶（`groupTagOptions`）、按组摘要文案、词表显示名映射；`llm.test.js` 与 Python 侧钉同一组 prompt 用例。

**Electron（node --test）**

- `toolSchemas.test.js` 自动带 `manage_tags`；`commands` 的新 argv 映射。

**E2E（`e2e/80-tag-groups.spec.js`，一个 app 串行）**

1. 启动即走 12 → 14 迁移（fixture 还是 12；它的 `city` 应落到「地点类型」，`seeded-tag` 留在未分组）。
2. Inspector 分组显示；添加一个词表标签（`sunset`）落「时段」，再添 `日落` 折叠成同一个芯片。
3. 筛选栏：弹层按组列出并计数；选同组两个 + 另一组一个，验证按组语义下的张数；切「任意」张数变化；勾组标题 = 有这组标签。
4. T 批量添加两个标签到两张；Shift+T 批量移除其中一个。
5. 标签页：新建自定义组、把一个标签拖 / 移进去、合并两个标签（照片上的芯片随之变化）、重命名、置顶后在筛选栏排第一。
6. 智能合集：保存一个 `tag_group` + `by_group` 的合集，侧栏计数正确。
7. MCP：`list_tags` 分组形状、`manage_tags.move`、`search_assets(tag_group=…)`。
8. `keepCatalog` 重启：分组、别名、置顶、合并结果都还在。

## 12. 实施顺序（一个 PR，按提交拆）

1. sidecar：schema 14 + 迁移 + 词表 + `tags.py` 数据层（resolve / merge / rename / move / delete / pin）+ CLI 命令 + 单测。
2. sidecar：facets（`by_group`、`tag_group`）、`get_facet_values` / `search_facet_values` 分组、搜索命中别名、智能合集规则改写 + 单测。
3. sidecar：分组 prompt、解析回退、保存时的组优先级 + 单测。
4. 渲染层：`tagStore` 扩展（组列表、词表显示名）、`TagsSection` 分组 + 芯片菜单 + 组选择、`TagGroupPopover`、`TagBatchDialog` 移除模式、搜索框标签建议、i18n。
5. 渲染层：标签页 + 侧栏入口 + 快捷键。
6. Electron：IPC / `commands.js` / `ipcChannels.mjs`，MCP 三个 tool 改 + `manage_tags` 新 tool，`docs/agent-native-mcp.md`。
7. Web 版镜像。
8. e2e `80-tag-groups.spec.js`，`npm run check`。

改到 sidecar 和主进程的提交落地后要提醒重启 dev。

## 13. 待确认的决定

1. 迁移时词表概念的中英两种写法自动合并（3.4）：用户定自动合并。
2. 多选默认语义：用户定保持「任意一个」，「按组」为可选模式（4.1）。
3. 内置组 13 个（3.2），用户 2026-11-09 要求在例子之外补全，已按四类扩充。
4. 标签页作为侧栏独立入口（4.3）：用户定独立入口。
5. 工作位置：用户定在独立 worktree 的 `feat/tag-groups` 分支上做（另一个会话正在主工作树改多级文件夹，dev app 也跑在那棵树上）。
