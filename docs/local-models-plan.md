# 本地模型与开源库扩展规划：相似图、语义搜索、挑片、OCR、离线标签、视频场景

> **状态（2026-10-14）**：A 的第一步已实现（分支 feat/similar-images）：pHash 和 Mac 的 Vision feature print 随预览生成写入 `asset_visual`，近似重复分组、侧栏「近似重复」、右键「查找相似照片」、Inspector「相似」条、MCP 的 find_similar / list_lookalikes / index_lookalikes 和 search_assets 的 similar_to。与下文设计的出入见 A 节末尾。连拍分组、Windows 的 DINOv2 向量未做。来源是一轮对"开源模型能为 AfterFrame 所用"的梳理，按下面的边界筛过一遍。
> 每项的现状对照代码核实过（只读代码，未运行）。模型体积是按参数量估的 fp16 / int8 值，开工前的 spike 要实测。

## 边界

三条硬规则，来自 2026-10-14 的决定：

1. **不做修图。** 抹除、抠图、超分、降噪、虚化、调色、HDR、全景、透视、镜头校正，全部不在本轮。这些以后单独立项。
2. **不碰 1 GB 以上的模型。** Qwen-Image、Z-Image、Florence-2-large、Qwen3-VL、RAM++ 这类直接排除。
3. **体积决定分发方式。** 100 MB 以下随包分发；100 MB 到 1 GB 之间走下载，而下载在大陆容易失败（人物模型 #127 踩过），所以下载档的功能都要做成"没下载也不报错、下载了才出现"。

现有的两个模型是先例：深度模型 48 MB 随包；人脸模型 125 MB 本来是下载，#127 之后改成随包（`electron/peopleModel.js`）。它是唯一超过 100 MB 还随包的，本轮不再加这种例外。

两条平台原则：

- **Mac 优先用系统自带的 Vision 框架**，零模型、零下载、ANE 加速。相似图、OCR、分类、人脸关键点它都有。调用方式沿用 `native/extract-sticker.swift` 的套路：Swift helper → spawn → JSON。
- **Windows 用 ONNX Runtime**（MIT，CPU 版 wheel 约 15 MB）跑小模型。这正是被搁置的 ONNX 深度/抠图那条线要的运行时，先在这里把它装进 sidecar。

## 总览

| 批次 | 功能 | 模型 / 库 | 许可证 | 体积 | 分发 | 估时 |
|---|---|---|---|---|---|---|
| 1 | A. 相似图、近似重复、连拍分组 | imagehash；Mac Vision feature print；Windows DINOv2-small | BSD / 系统 / Apache-2.0 | 0 / 0 / 约 45 MB | 随包 | 5 到 6 天 |
| 1 | B. 挑片：清晰度、闭眼、美学分 | OpenCV；Mac Vision 人脸关键点 / Windows MediaPipe Face Landmarker；NIMA MobileNet | Apache-2.0 / 系统 / Apache-2.0 | 0 / 0 / 4 MB / 15 MB | 随包 | 4 到 5 天 |
| 2 | C. OCR 与文字搜索 | Mac Vision 文字识别 / Windows RapidOCR | 系统 / Apache-2.0 | 0 / 约 15 MB | 随包 | 3 天 |
| 2 | D. 视频场景切分与抽帧 | PySceneDetect + 现有 ffmpeg | BSD | 0 | 随包 | 3 天 |
| 3 | E. 语义搜索（文字找图） | Chinese-CLIP ViT-B/16 | MIT | fp16 约 375 MB，int8 约 190 MB | 下载 | 6 到 8 天 |
| 3 | F. 离线标签（不配 API key） | 复用 E 的模型做零样本分类；Mac 可先用 Vision 分类 | 同 E / 系统 | 0 增量 | 随 E | 2 到 3 天 |
| 候补 | G. 视频按台词搜索 | whisper.cpp | MIT | tiny 75 MB，base 142 MB | 随包 / 下载 | 待定 |

排序原则：第 1 批全部随包、零下载风险、对"几万张 RAW"用户立刻有用；第 2 批也随包，但受众窄一些；第 3 批是唯一要下载的，先把下载机制做扎实再上。

每个功能一个分支、一个 PR。新增 IPC 照旧登记在 `apps/desktop/shared/ipcChannels.mjs`；新增 MCP tool 的参数都要写进 `inputSchema`。所有分析都走 jobs 表，JobDock 可见、可暂停，优先级沿用人物索引的 interactive / background / maintenance 三档。

---

## 分发机制（E 之前必须有）

随包档没有新机制，照深度模型的做法放 `native/` 或 sidecar 的 data 目录。

下载档需要把人物模型 0.5.5 时的下载逻辑捡回来，补上三件事：

1. **多源。** 按顺序试：自建 OSS / CDN（最稳，成本低）→ GitHub Releases 的模型资产 → hf-mirror.com → huggingface.co。URL 列表随 App 版本固定，SHA-256 照 `peopleModel.js` 的方式钉死。
2. **手动导入。** 设置页给一个"从文件导入模型"按钮，用户自己从任何渠道拿到压缩包后选中即可。校验同一个哈希。这是小红书用户最终能用上的路径，界面上要讲清楚（他们不读文档）。
3. **缺失即隐藏。** 模型不在时相关筛选项、右键菜单项、MCP tool 都不出现，`api.can("semantic")` 守卫，照 `api.can("people")` 的样子。

模型统一放 userData 下的 `models/<name>/`，设置里记路径和哈希，和人物模型共用一张表。

---

## A. 相似图、近似重复、连拍分组

**价值。** 导入几万张 RAW 后最先想要的就是"把重复的和连拍的收起来"。Eagle 和 Lightroom 都没有把连拍做好。

**做法。** 三层，由粗到细，全部在现有 512px 预览上跑，挂在预览生成之后，和色彩分析同一班车：

1. pHash（imagehash，BSD）：每张 64 位，存 `asset_hashes`，汉明距离 ≤ 6 为候选重复。导出图和它的 RAW 配对本来就是同一画面，要排除掉，只在同一类资产内比。
2. 向量：Mac 用 Vision `VNGenerateImageFeaturePrintRequest`（系统自带，零模型），Windows 用 DINOv2-small（Apache-2.0，22M 参数，fp16 约 45 MB，ONNX）。两者的向量不互通，索引按 `embedding_model` 分版本，和人物索引的做法一致。向量存 sqlite-vec（Apache-2.0，扩展几百 KB，sidecar 加载）。
3. 连拍：EXIF 拍摄时间间隔 ≤ 2 秒、同相机、同焦段，且相邻两张向量距离在阈值内，串成一组。阈值用 `data/ground-truth` 那套流程标一批真值来定。

**界面。** 网格上连拍组折叠成一叠，角标显示张数，点开展开；右键"查找相似"；"重复项"作为一个内置智能合集。Inspector 的"相似"区块列前 8 张。

**MCP。** `find_similar(asset_id, limit)`、`list_duplicates(threshold)`、`search_assets` 加 `burst_group_id`。

**已实现的与设计的出入（2026-10-14）。**

- 没有用 sqlite-vec，也没有加 imagehash：pHash 用 numpy 自己算（imagehash 会拖进 scipy 和 PyWavelets，包体翻倍）；向量存 float16 BLOB，查询时 numpy 暴力算距离，几万张在几十毫秒内。
- feature print 对输入尺寸敏感（512px 与原图相差 0.46），所以所有向量都从 512 预览算，只在同一档内比较；在 512 下近似重复 0.2 到 0.3、同场景 0.8、无关 1.1 以上，区分度够。
- 近似重复的判定是两条同时成立：汉明距离 ≤ 8，且两边都有 feature print 时距离 ≤ 0.4。只有哈希（Windows）时只看汉明。
- 哈希和向量和色彩一样挂在预览生成里（新预览自带），visual 任务只做存量补齐，开库时自动跑一次。
- 没有神经引擎的机器（Intel Mac、CI 虚拟机）上 Vision 一张要 70 毫秒以上，导入会被拖慢几倍：sidecar 启动助手时量一次推理，超过 50 毫秒就只用哈希（`visual.SLOW_PRINT_SECONDS`）。助手进程按 sidecar 进程常驻复用，渲染线程借用。
- 助手是 `native/image-features.swift`，sidecar 通过 `IMAGE_FEATURES_PATH` 找到它，和 people-worker 同一种接法；macOS 12/13 用 revision 1（2048 维，模型名 vision-fp-r1），14 起 revision 2（768 维，vision-fp-r2），两者不互通，按 `embedding_model` 分开。

**开放问题。** 同一个库在 Mac 和 Windows 之间搬时两套向量不互通，只能各自重算；先接受，文档里写明。连拍折叠和现有的排序、多选、marquee 怎么共存，开工前画一下。

---

## B. 挑片：清晰度、闭眼、美学分

**价值。** 连拍组里挑最好的一张，是摄影师真正的工作流。有了 A 的分组，这一项才成立。

**做法。** 三个分数，各自一列，都挂在 A 的分析 job 里：

- **清晰度。** OpenCV 拉普拉斯方差。512px 预览分不出轻微失焦，要用 2048px 预览或 RAW 内嵌 JPEG，只算人脸框或中心区域，避免背景虚化拉低分数。
- **闭眼。** Mac 上 Vision `VNDetectFaceLandmarksRequest` 自带眼部关键点，算眼睛纵横比；人物索引已经在跑人脸检测，顺手带出来。Windows 用 MediaPipe Face Landmarker（Apache-2.0，约 4 MB，ONNX 或 tflite）。只对有脸的照片算。
- **美学分。** NIMA（Apache-2.0）的 MobileNet 版约 15 MB。这个分数主观，只做排序参考，界面上不显示具体数字。

**界面。** 连拍组展开时按综合分排序，最佳一张自动加一个"推荐"角标；筛选栏加"失焦"和"闭眼"两个开关，配合现有的 X 旗标批量拒片。

**MCP。** `search_assets` 加 `sharpness_min`、`eyes_closed`；`cull_burst(group_id)` 返回推荐和理由。

**开放问题。** 美学分是否真的有用，先在 review 库上跑一遍人工看，不好就砍掉，只留清晰度和闭眼。

---

## C. OCR 与文字搜索

**价值。** 招牌、菜单、票据、截图、带字幕的视频帧，都能按字搜到。小红书用户的截图和"打卡"照片占比不低。

**做法。** Mac 用 Vision `VNRecognizeTextRequest`，中英文都支持，零模型；Windows 用 RapidOCR（Apache-2.0，检测 + 识别 + 方向三个 ONNX 共约 15 MB，中英文）。结果存 `asset_text`（asset_id, text, lang, boxes_json），搜索走现有的 `search` 字段，`browse.py:165` 那条"以后换 FTS5"的注释到这一步该兑现了。

**界面。** Inspector 加"文字"区块，可复制；搜索框命中文字时在网格卡片上高亮一下。只对导出图和预览跑，RAW 不跑。

**MCP。** `get_asset` 返回 `text`；`search_assets` 的 `search` 自动覆盖。

**开放问题。** 全库跑一遍的耗时。Vision 单张几十毫秒，RapidOCR CPU 单张几百毫秒，三万张在 Windows 上要一两个小时，必须是 maintenance 档、可暂停。

---

## D. 视频场景切分与抽帧

**价值。** 从视频里挑一帧当封面或发图，现在只能去别的软件。视频播放已经在 #204 做到了原生，这一项是它的自然延伸。

**做法。** PySceneDetect（BSD）的内容检测，走现有的 `ffmpeg_video.py`。每个场景出一张缩略图，存成视频的 derived 资源。"抽帧为图片"用 ffmpeg 按时间戳出一张 JPEG，走 `derived.py` 的 `register_export_file` 进版本族，不是修图。

**界面。** 视频的 Inspector 加场景条，点场景跳转；播放器上一个"抽帧"按钮，取当前帧。

**MCP。** `list_video_scenes(asset_id)`、`extract_video_frame(asset_id, timestamp_ms)`。

**开放问题。** 场景检测要解码整段视频，长视频慢；只在用户点开视频时按需跑，不随导入。

---

## E. 语义搜索（文字找图）

**价值。** "海边的日落"、"穿红裙子的人"、"猫"，不靠标签直接搜。这是 Eagle 4.0 的卖点，也是路线图上挂了很久的一项（`agent-native-mcp.md` 的"语义搜索"）。

**模型选择。** 用户群以中文为主，所以选 Chinese-CLIP ViT-B/16（MIT，图像塔 86M + 文本塔 102M 参数，fp16 约 375 MB，int8 约 190 MB）。SigLIP 2 base（Apache-2.0，多语言）是备选，中文检索质量要对比一次再定。两者都超过 100 MB，走下载档。

**做法。** 图像向量在导入后的 background job 里算，存 sqlite-vec，和 A 的向量分表；查询时只跑文本塔。有了这个向量，A 的相似图在模型已下载时也可以改用它，效果比 DINOv2 和 feature print 都好，但不强求。

**界面。** 搜索框加一个"按含义"切换；模型没下载时切换不出现，而是在设置页的"模型"分组里给下载和导入入口，按分发机制那一节做。

**MCP。** `search_assets` 加 `semantic` 参数；server instructions 里说明何时用它。

**开放问题。** int8 量化后的中文检索质量是否可接受，spike 时实测；CPU 上图像塔每张几十到一百毫秒，三万张库要半小时到一小时，Windows 更慢。

---

## F. 离线标签

**价值。** 现在的标注要用户配 API key，而用户不读文档，大多数人到不了这一步。零配置的标签能让搜索和智能合集对所有人生效。

**做法。** 不加新模型。Mac 先用 Vision `VNClassifyImageRequest`（1300 多类，英文标签，映射一份中文表）；E 的模型下载后，用它对一份精选的中文标签词表（约 300 到 500 个：场景、物体、天气、时间、人物状态）做零样本分类，取阈值以上的前几个。描述（caption）继续走 LLM provider，不做离线版。Florence-2-base（MIT，约 460 MB fp16）能一次出描述、标签和 OCR，但输出是英文，和现有中文标注体系不合，列为备选不采用。

**界面。** 自动标签和 LLM 标签分来源显示，用户能一键清除自动标签。标注设置页里"没有 API key"时不再是空白，而是说明自动标签已经在跑。

**开放问题。** 词表谁来定、怎么迭代；阈值在 review 库上标真值调。

---

## G. 候补：视频按台词搜索

whisper.cpp（MIT）的 tiny 模型 75 MB 可随包，但中文效果差；base 142 MB 要下载。用户是否有这个需求不确定，等 D 上线后看视频功能的使用情况再决定。

---

## 不做清单与许可证黑名单

本轮明确不做，留作以后立项：修图全部（LaMa、SAM、Real-ESRGAN、NAFNet、景深虚化、自动裁剪、参考图调色、HDR、全景、透视、lensfun）、1 GB 以上的生成和多模态模型。

即使以后做，也避开这些非商用或学术许可的模型：RMBG-2.0（CC BY-NC）、Depth Anything V2 Base / Large（CC BY-NC，Small 是 Apache-2.0，现在用的就是它，别升级）、InsightFace 原版权重（非商用；现用的 ArcFace CoreML 转换版在 HF 标 Apache-2.0，上游来源待核）、Restormer（学术许可）。

每个新模型都照 `peopleModel.js` 记 `license` 和 `license_url`，About 页加一个"模型与开源库"列表，把这些一起列出来。
