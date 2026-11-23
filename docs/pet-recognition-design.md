# 宠物识别与分组设计

> **状态（2026-11-23）**：阶段 1、2 已在分支 `feat/pet-recognition` 实现（worker、模型、schema 16、人物任务带宠物、界面、MCP、e2e 97），见第 12 节；宠物模型已传到 `models` release，打包时由 `fetch-models.mjs` 和人脸、深度模型一起下载（5.5）。实现和原设计的出入：宠物不另开任务，并进人物任务同一轮跑（5.2）。可行性原型已做完：脚本和测试集在 `research/pet-recognition-lab/`（`research/` 不进 git），本文第 3 节抄了全部结论数字，不依赖那个目录。已定：人和宠物放同一面墙、导航名改成“人物与宠物”、宠物识别默认关（模型照样随包，设置里打开）、用 DINOv2-S 随包、所有模型统一放 AfterFrame 自己的 GitHub Release（5.5）、模型可由用户替换、标定照片由用户准备、只被姿态检测找到的动物用分类器定猫狗。第 13 节还有 1 项待定。

相关：[people-recognition-design.md](people-recognition-design.md)（人物识别，本文大量复用它的任务、数据和界面）、[local-models-plan.md](local-models-plan.md)（模型体积和分发规则）。

## 1. 目标与边界

像 Apple 相册的“人物与宠物”和 Google 相册的宠物分组：认出图库里同一只猫或狗，自动归成候选组，用户确认、命名后可以按它筛选照片。

范围：

- 只做猫和狗。Vision 的动物检测只认这两种，Apple、Google 也只做这两种。
- 只做 Mac，macOS 14 起，和内置人脸模型的要求一样。macOS 12 的两个包和 Windows 没有这个功能（Windows 没有 Vision 的动物检测）。
- 全程本地，不联网，不上传图片和向量。

不做：

- 品种识别、猫狗以外的动物。
- 给宠物推断名字。模型只回答“这些是不是同一只”，名字、合并、拆分都由用户决定。
- 改人物识别的模型、阈值和已有数据。

## 2. 方向（原型已验证）

1. **检测用 Vision 自带的接口**：`VNRecognizeAnimalsRequest` 找猫狗，它漏掉的用 `VNDetectAnimalBodyPoseRequest` 的关键点兜底。不需要额外模型。
2. **身份向量用 DINOv2-S**（Meta，Apache-2.0），转成 Core ML 随 App 内置，输入是动物的身体框，取 CLS 向量。Vision 自带的特征向量认不出个体，不能用。
3. **复用人物识别的整套框架**：宠物组就是“另一个模型下的人物组”。数据表、任务、聚类、人物页、Inspector、筛选、MCP 都按模型隔离，加一列物种就能装下宠物。
4. **候选优先，靠用户纠错**：聚类阈值偏保守（宁可分成两组，不把两只并成一组），同品种的几只会混，靠已有的拆分、合并操作修。

## 3. 原型结论

测试集：Wikimedia Commons 上按单只动物归类的照片，12 只（5 猫 7 狗）共 201 张，故意放了同品种的难分组合：Bo 和 Sunny 都是黑色葡萄牙水犬，Champ、Major、Commander 都是德牧。同一次拍摄的照片（Vision 整图距离 < 0.5）不计分，否则任何方法都会显得准。这套照片来自不同年份和摄影师，比家庭图库难。

### 3.1 检测

| | 张数 | 占比 |
| --- | --- | --- |
| `VNRecognizeAnimalsRequest` 找到 | 128 / 201 | 64% |
| 加上姿态关键点兜底 | 162 / 201 | 81% |
| 猫狗分对 | 134 / 138 个框 | 97% |
| 检测到的动物里能用关键点裁出头部 | 157 / 179 | 88% |

漏掉的大多是远处很小的动物、画、表情包，这些本来也认不出个体。但也有近景大猫被识别器漏掉、被姿态检测找到，所以兜底有必要。

### 3.2 身份向量

同一批 153 张、身体框、AUC 指“同一只的两张比不同只的两张更近”的概率（0.5 等于瞎猜），F1 是猫狗分开做平均链接聚类、扫阈值取最好的一档：

| 向量 | AUC | 最近邻是同一只 | 最佳 F1（精确率 / 召回率） | Bo / Sunny | 德牧之间 | 虎斑白猫 / 黑猫 |
| --- | --- | --- | --- | --- | --- | --- |
| Vision 特征向量 | 0.71 | 69% | 0.43（0.42 / 0.44） | 0.53 | 0.50 | 0.72 |
| DINOv2-S | 0.92 | 90% | 0.81（0.97 / 0.70） | 0.51 | 0.74 | 1.00 |
| DINOv2-B | 0.95 | 94% | 0.85（0.95 / 0.76） | 0.58 | 0.72 | 1.00 |

- Vision 特征向量按姿势、构图和品种分组，连黑猫和虎斑白猫都分不清。
- DINOv2 外观不同的基本全分开；只有同品种还会混。DINOv2-B 分出 27 组，只有 4 组混了别的个体，每组只混 1 到 2 张，全是同品种。
- 试过的变体：CLS 比 CLS 加 patch 均值好；身体框比整张照片、去背景、头部好或持平；按 Apple 人物那样把头部距离加权进来没有提升。

### 3.3 Core ML

Meta 官方 PyTorch 权重转成 mlprogram，fp16，最低 macOS 14。ImageNet 归一化做在模型里（Core ML 的图像输入不能按通道分别除标准差）；DINOv2 每次推理都会把位置编码插值到输入尺寸，输入固定 224，所以把插值结果烤成常量。

| | S | B |
| --- | --- | --- |
| 体积 | 41 MB | 164 MB |
| 和 ONNX 版向量的余弦（最低 / 中位） | 0.997 / 0.9995 | 0.990 / 0.999 |
| 测试集 AUC（神经网络引擎跑） | 0.920 | 0.953 |
| M3 Pro，神经网络引擎，每张 | 2.9 ms | 9.5 ms |
| M3 Pro，只用 CPU，每张 | 7.9 ms | 21.5 ms |
| 神经网络引擎首次加载 | 约 2 s | 约 4 到 5 s |

速度不是问题：一万张照片全过一遍 S 也不到半分钟，实际只有检测到动物的才算。Intel Mac 不在发布范围（不发 Intel 的 macOS 14 包）。

## 4. 别人怎么做

- **Apple**：宠物分组的做法没公开，开发者也拿不到身份向量。人物分组公开过（[Apple ML Research](https://machinelearning.apple.com/research/recognizing-people-photos)）：人脸向量和上半身向量都算；第一轮只在同一个时刻里合并，用两种距离的加权和；第二轮只用人脸向量跨时刻做层次聚类；在夜里充电时跑。
- **Google 相册**：2017 年起把猫狗放进人脸分组，要拍到清楚的正脸，官方承认同品种会混，靠用户移出纠错。
- **Immich**：官方没做；社区插件 immich-animals 用“检测 + DINOv2-B 向量 + 按物种分别设阈值”，作者说照片少于约 15 张的狗分不进组，长得像的会混。
- **学术**：标准做法是检测头部、按关键点对齐、用 ArcFace 损失在大量个体身份数据上训练。最大的 PetFace（ECCV 2024，25.7 万只）只能非商用，所以本设计不走自己训练这条路。

## 5. 系统结构

和人物完全同构，只是换了 worker 的模式和模型：

```text
renderer：人物页（加宠物）/ Inspector / 筛选 / 设置
   │ 现有 IPC
Electron main：解析 People Worker 和两个模型的路径，启动 people_index 任务（带上宠物模型）
   │ 环境变量 + CLI 参数
sidecar job runner：同一个任务里写人脸和猫狗的 asset_faces、各自聚类
   │ NDJSON（stdin / stdout）
People Worker --model … --pet-model …：人脸 + 动物检测、裁框、Core ML 向量
```

### 5.1 Worker（已实现）

不新建二进制，`people-worker.swift` 多收一个 `--pet-model`：`people-worker --model FaceEmbedding.mlpackage --pet-model PetEmbedding.mlpackage --serve`。每张照片只解码一次，人脸和猫狗在同一轮里出结果；`--pet-model X --self-test` 单独验一个宠物模型（设置里选模型时用）。读图、方向处理、`input_hash`、NDJSON 协议、stdout 只走协议都沿用。

每张照片的流程（原型 `pet-probe.swift` 的做法）：

1. 用人脸那条路解码（按方向，长边最多 4096）。
2. 同一个 handler 上跑 `VNRecognizeAnimalsRequest` 和 `VNDetectAnimalBodyPoseRequest`（后者要 macOS 14，代码里有可用性判断，macOS 12 的包照样能编）。
3. 识别器的框外扩 5%。姿态检测找到、但头部（或关键点中心）不在任何识别器框里的，用全部关键点（置信度 > 0.2，至少 5 个）的范围外扩 15% 再加 8 像素当身体框。短边小于 64 像素的丢掉，小于 128 像素或只靠姿态找到的标 `low`。
4. 只靠姿态找到的，接口不说是猫是狗：在身体框上跑 `VNClassifyImageRequest`，取 cat / adult_cat / kitten / feline 和 dog / canine / bulldog / sheepdog 两边的最高分，都不到 0.1 就丢掉。Commons 测试集上实测：阈值 0.1 留下 36 只、错 1 只；0.3 留下 27 只、错 1 只；不设阈值 42 只、错 3 只。
5. 头部框：耳、眼、鼻关键点（置信度 > 0.3，至少 3 个且含眼或鼻）的范围，取正方形边长 1.6 倍，向下偏 8%。只用来做封面，不参与向量。
6. 身体框用灰色（128）补成正方形，缩到模型的输入尺寸，进 Core ML，L2 归一化。
7. 返回在原来的 `faces` 旁边多 `animals`（每只：`subject` cat / dog、`bounding_box` 身体框、`landmarks` 头部框或空、`confidence`、`quality`、`source` recognizer / pose、`embedding`）和 `animals_skipped`。请求带 `known_pet_input_hash`，和人脸各自按哈希跳过。宠物这半出错时 `animals` 为 null、写进 `animals_error`，人脸照常返回。

### 5.2 sidecar（已实现，和原设计不同：不另开任务）

原设计是单独的 `pet_index` 任务。实现时发现每个任务都是一个立即启动的独立进程，两个任务会同时跑、同时开两个 worker，违反人物设计稿“只跑一个 worker”的规矩，排队又要另做。所以宠物并进 `people_index`：

- `run_people_index_job` 多收 `--pet-model-id / -version / -path / --pet-manifest-hash / --pet-threshold`，同一个 worker 进程同时加载两个模型。
- 人脸和宠物各有自己的 `people_asset_index` 记录（按各自的 model_id），各自按 stat 和像素哈希跳过：两半都没变才整张跳过；老图库只缺宠物时，worker 拿到人脸的哈希会跳过人脸、只算宠物。宠物出错只给宠物记失败，下次重试。
- 任务结果多一个 `pets`（找到几只）和 `pet_groups`；阶段名是 `people_pets_index` / `people_pets_cluster`（界面显示“分析人物与宠物”）。中途每 300 张重新聚类时宠物也一起聚。
- 代价：不能只暂停宠物；设置里可以整个关掉。
- `upsert_face_model` 写 `kind = 'pet'`。聚类见第 7 节。

### 5.3 模型分发（已定：DINOv2-S 随包）

- DINOv2-S 只有 41 MB，按 local-models-plan 的规则（100 MB 以下随包）直接打进 App，放 `Contents/Resources/native/PetEmbedding.mlpackage`。**用户什么都不用下载**，国内外一样，装好就能用，也不联网。人脸模型 0.5.5 时是首次使用再下载，国内下不下来（#127），后来改成随包，宠物模型一开始就随包。
- 来源、版本、SHA-256、许可证写在 `apps/desktop/electron/petModel.js`（仿 `peopleModel.js`）。
- 只有**打包的机器**要拿到这个文件：放在 AfterFrame 自己仓库的 GitHub Release，构建时由统一的 `apps/desktop/scripts/fetch-models.mjs` 下载锁定版本并校验 SHA-256，再跑一次 worker 自检；`apps/desktop/scripts/release.sh` 检查包里有它。见 5.5。
- 转换脚本从 `research/` 搬进仓库（例如 `scripts/models/convert-pet-model.py`，写明 torch 2.7.0、transformers 4.53.3、coremltools 9.0），保证任何时候都能从 Meta 的官方权重重新生成同一个包。
- DINOv2 是 Apache-2.0，要进 App 的第三方许可证清单。
- `capabilities.js` 把宠物识别归入需要 macOS 14 的能力，和人物一起。

### 5.4 用户替换模型（已定：可以替换）

复用人物已经实现的“选择其他模型”（`electron/ipc/people.js` 的 `installModel`）：用户选一个 `.mlpackage`，或带 `manifest.json` 的文件夹；本机跑一次 worker 自检；复制进 Application Support；按 `id@version@哈希` 记下，建自己的一套索引。宠物加三条：

- **接口约定**：输入名 `image`，224×224 RGB 图像（补正方形、缩放由 worker 做）；输出名 `embedding`，一维浮点向量，维度不限。自检时检查这两项，不符合就拒绝并说明原因。
- **阈值跟着模型走**：不同模型的相似度尺度不一样，人脸那样所有模型共用一个阈值行不通。`manifest.json` 可以带 `kind: "pet"` 和 `cluster_threshold`；没带阈值的模型标“实验性”，先用 DINOv2-S 的阈值，结果可能偏松或偏紧。
- **向量不混用**：换模型就是新建一套宠物索引，已命名的宠物组不会自动搬过去（和人物第 2 节第 6 条一样）。设置里提示这一点；内置的 DINOv2-S 不能删，随时可以切回去。

这样想要更准的用户可以自己换 DINOv2-B（AUC 0.95 对 0.92），我们不用把 164 MB 塞进安装包，也不用在 App 里做下载。B 包放在 `models` release 上供手动下载，见 5.6。

宠物模型的下载包是一个 `.afpetmodel` 文件夹（`manifest.json` 加 `.mlpackage`），和人物的 `.afpersonmodel` 同一个形状。

### 5.5 模型统一托管（已定：都放自己仓库的 Release）

打包时用到的模型都从 AfterFrame 自己的 GitHub Release 下载，不再分散在别人的仓库和 git 里。默认模型都随包，用户不用下载；这一节只关系到打包的机器和 CI 能不能稳定拿到文件。同一个 release 也放给用户手动下载的可选模型，见 5.6。

现状（2026-11-23）：

| 模型 | 大小 | 现在从哪来 | 许可证 |
| --- | --- | --- | --- |
| 人脸 ArcFace R100（`FaceEmbedding.mlpackage`） | 压缩包 110 MB，解开 125 MB | 构建时从别人的 Hugging Face 仓库（RuiSumida/ArcFace-R100-CoreML）下载 | 按 `peopleModel.js` 的记录是 Apache-2.0 |
| 深度 Depth Anything V2 Small（`DepthAnythingV2SmallF16.mlpackage`） | 48 MB | 直接提交在 git 里（`apps/desktop/native/`） | Apache-2.0（Small 版） |
| 宠物 DINOv2-S（`PetEmbedding.mlpackage`） | 压缩包 40 MB，解开 43 MB | 新的，`scripts/models/convert-pet-model.py` 转换 | Apache-2.0 |

做法：

- **一个专门的 release**：tag 固定叫 `models`，标题写明“模型文件，打包用，不是 App 版本”。必须建成**预发布、不设为 latest**：官网的下载按钮都指向 `releases/latest`（`site/index.html` 等），模型 release 一旦成了 latest，官网就会把用户带到模型文件上。
- **文件只增不改**：文件名带版本和哈希（例如 `FaceEmbedding-arcface-r100-b51b655.mlpackage.tar.gz`），上传后不删也不覆盖，换模型就传一个新文件。这样代码里锁的 SHA-256 永远有效，旧版本的 tag 也一直能重新打包。release 说明里列出每个文件的来源、许可证和 SHA-256。
- **人脸模型**：上传和 Hugging Face 上一模一样的压缩包，`archive_sha256` 和 `manifest_hash` 都不变，所以已经建好的人物索引继续有效，`peopleModel.js` 只改下载地址。Hugging Face 的原地址留作备用：自己的 release 下不到时再试它，哈希一样，不影响校验。
- **深度模型**：从 git 里移出来，打包时下载。git 历史里已有的那 48 MB 不会因此变小，好处是三个模型走同一套流程，以后换模型不再往仓库里加大文件。
- **一个脚本**：`fetch-people-model.mjs` 改成 `fetch-models.mjs`，用一张表列出每个模型的文件名、地址、SHA-256、大小、许可证和自检方式；`package.json` 里原来跑 `fetch:people-model` 的地方（`predev`、`dist:mac` 等）、`.github/workflows/e2e-nightly.yml` 和 `apps/desktop/scripts/release.sh` 的检查都换成它。
- **不动的**：exiftool、ffmpeg、Electron 是工具不是模型，各自有官方的版本化发布渠道，也锁了 SHA-256，这次不搬。
- **进度（2026-11-23）**：已发布 <https://github.com/YIWANG3/AfterFrame/releases/tag/models>（预发布，非 latest；tag `models` 指向 main 的 `fe1ce36`；latest 仍是 v0.5.27，官网的 `releases/latest` 仍跳到 v0.5.27）。三个文件不登录也能下载，下载下来的 SHA-256 和大小核对过（宠物模型用 `fetch-models.mjs` 下载并自检过）：
  - `FaceEmbedding-arcface-r100-b51b655.mlpackage.tar.gz`，110,376,172 字节，`3644ff110ba03a082515d3a9fa22dbc8c1eb66054bb6bbbc0e84eb62b4771f2b`。和 Hugging Face 上的逐字节相同；来源是 ONNX Model Zoo 的 `arcfaceresnet100-8.onnx`，Apache-2.0。
  - `DepthAnythingV2SmallF16-c0c84db5.mlpackage.tar.gz`，45,821,437 字节，`c0c84db536218b3103c9dafdec4bf0e8d26da86cc758bb85bc2b96056035aea8`。Apple 的 `apple/coreml-depth-anything-v2-small` 原样打包，可复现（条目排序、时间清零、不记属主），解开和仓库里的逐文件相同。
  - `PetEmbedding-dinov2-small-846f00a0.mlpackage.tar.gz`，40,076,226 字节，`846f00a00b5f5ca5ffe8a01886bb37a9732d23b8d836842953cb4a04b19a73cd`。从 Meta 的 `facebook/dinov2-small`（版本 `ed25f3a`）用 `scripts/models/convert-pet-model.py` 转换，Apache-2.0；只在这个 release 上，没有备用地址。
  - 代码：`fetch-models.mjs`、深度模型移出 git、`peopleModel.js` 换地址在 #324（已合并）；宠物模型的那一行在 `feat/pet-recognition`，锁定值在 `petModel.js`。下载地址是 `https://github.com/YIWANG3/AfterFrame/releases/download/models/<文件名>`。
- **顺序**：这是一个独立的 PR（从 main 开分支），在宠物识别阶段 1 之前做；宠物模型的文件等阶段 1 转换脚本进仓库后再传。落地时同步改 [people-recognition-design.md](people-recognition-design.md) 4.1 节里模型来源的描述，以及 `peopleModel.js` 顶部的注释。

### 5.6 给用户手动下载的模型（已定：可以下载替换）

`models` release 同时是给用户的模型库：内置模型之外的可选模型放在这里，用户手动下载，再用 App 里的“选择其他模型”导入。App 里不做下载（人脸模型在 App 里下载踩过 #127 的坑）。

三个功能现在都能换模型，但程度不一样：

| 功能 | 能不能换 | 现状 |
| --- | --- | --- |
| 人物 | 能 | 选 `.afpersonmodel` 文件夹或 `.mlpackage`，本机自检后复制进 Application Support，按模型分索引（`ipc/people.js`）。 |
| 宠物 | 能（本设计） | 同人物，`.afpetmodel` 文件夹，见 5.4。 |
| 深度 | 能，但不稳 | 选 `.mlpackage`，只记路径、不复制也不自检（`ipc/depth.js` 的 `pick-depth-model`）。用户删了下载的文件，就悄悄退回内置模型。要改成和人物一样：自检、复制进 Application Support。 |

放进 release 给用户下载的模型，必须同时满足：

1. **许可证允许再分发和商用**（Apache-2.0、MIT 这一类）。AfterFrame 是 MIT，用户不会去分辨哪个模型只能非商用，所以 Depth Anything V2 的 Base、Large（CC-BY-NC-4.0）、InsightFace 官方权重（仅限非商用研究）这类不放。
2. **我们自己转换、验证过**：用仓库里的转换脚本从官方权重生成，过了自检，有测试集上的数字。没测过的不放，和人物设计稿 4.3 的规矩一样。
3. **是 App 能直接导入的形状**：`.afpersonmodel` / `.afpetmodel` 文件夹，或深度用的 `.mlpackage`，打成 `.zip`（访达双击就能解开）。`manifest.json` 里写清来源、版本、许可证、输入输出、宠物模型的 `cluster_threshold`。
4. **release 说明里每个文件一段**：适合谁、比内置的好在哪、体积、要求的 macOS 版本、测试集上的数字、SHA-256。

内置模型删不掉，随时可以切回去，所以不放“和内置一样、用于恢复”的副本。按这个规矩，第一个给用户下载的模型是**宠物 DINOv2-B**（`.afpetmodel` zip，158 MB）：更准（AUC 0.95 对 0.92，F1 0.85 对 0.81），同品种也稍好一点。它跟宠物识别阶段 1 一起上传；在那之前 App 还不能导入它，提前放出来没有意义。

人脸的其他候选（ArcFace R50、AuraFace），以及 Apple 发布的其他深度模型变体（F32、INT8、6 位和 8 位调色板量化，许可证都是 Apache-2.0），要等我们验证过才能放。“把模型都给全”是这套规矩下逐步加，不是一次放一堆没测过的。

**国内用户下载**：GitHub release 的文件在国内经常很慢甚至下不动，可选模型主要就是给愿意折腾的用户的，这个问题绕不开。可选的做法是在魔搭（ModelScope，阿里的模型托管，国内能直接访问）放一份同样的文件，设置里的“获取更多模型”同时给 GitHub 和魔搭两个链接，文件哈希一样，App 的自检不区分来源。要不要做见第 13 节。

## 6. 数据模型

复用人物的表，不新建平行的一套。人物的表都按 `(model_id, model_version)` 隔离，宠物模型是另一个 `model_id`，向量空间天然分开。

| 表 | 改动 |
| --- | --- |
| `face_models` | 不改；宠物模型一行，`kind = 'pet-dinov2-s'`。 |
| `people_asset_index` | 不改；每张照片在宠物模型下另有一行，没检测到动物的照片也记一行，下次跳过。 |
| `asset_faces` | 加 `subject TEXT NOT NULL DEFAULT 'person'`，取值 `person` / `cat` / `dog`。宠物行：`bbox_json` 是身体框，`landmarks_json` 存头部框和关键点，`embedding_blob` 是 384 维。 |
| `person_groups` | 加 `subject`（同上），聚类时按成员的物种写入，人物页和 MCP 靠它分人和宠物，不用每次连表。 |
| `person_group_faces` | 不改。 |

- `db/people.py` 里写死的 `EMBEDDING_DIMENSIONS = 512` 改成按模型取维度（人脸 512，DINOv2-S 384）。
- 升 `SCHEMA_VERSION`，新列走现有的幂等 `_ensure_column`。catalog schema 是 CONTRIBUTING 里“容易弄坏”的一项，旧库升级和 e2e 的固定库都要覆盖。
- 表名里的 face、person 不改名：改名是有风险的迁移，换来的只是名字好看。代码里在表定义处注明“一行是一个被识别的主体，人或宠物”。
- 否决的方案：另建 `pet_*` 五张表。要把约 1100 行的分组增删改、人物页、Inspector、筛选、MCP 全复制一遍，以后两边还会分叉。

## 7. 聚类

沿用 `rebuild_candidate_groups`：贪心平均链接，平均相似度和最弱一对都要过线（防止链式合并），同一张照片里的两个主体不合并，已确认、已忽略、用户拒绝过的不动。宠物额外加两条：

- **按物种分开**：猫和狗之间不合并（检测已经分好了物种，97% 准）。
- **阈值按模型取**：人脸 0.48 不变。原型里 DINOv2-S 最佳切点是单位向量距离 0.92，换成余弦相似度约 0.58；起步用 0.58、`chain_slack` 0.10，第 3 阶段用家庭图库照片重新标定。原型用的是完整的平均链接，和产品的贪心实现不完全一样，数字以标定为准。第一次家庭照片核对（2026-11-23，见第 12 节阶段 3）后保持 0.58。

以后可以加（第 3 阶段）：借 Apple 的两轮做法，同一次拍摄内先按更宽的阈值合并（原型里同一次拍摄的照片整图距离都 < 0.5，很好认），再跨拍摄合并。

## 8. 界面

- **人物页（已定：同一面墙）**：宠物和人放在同一面墙上，宠物卡片加一个小爪印标记；工具栏加“全部 / 人物 / 宠物”筛选。Apple 和 Google 都是这么放的。
- **改名（已定）**：“人物”改成“人物与宠物”，英文 People 改成 People & Pets，和 Apple 一样。要改的文案（`src/i18n/locales/` 的 en 和 zh-CN 各一份）：`nav.json` 的 `sidebar.people`（侧栏）、`people.title`（页标题）、`discover.peopleTitle`（发现页那一栏）、`people.openSettings`（“人物设置”）、`filter.person`（筛选里的人物条件）；`inspector.json` 的 `sections.people`；`settings.json` 的 `tabs.people`。“含人脸”（`filter.people`）不改，旁边另加“含猫”“含狗”。代码里的 key、路由、MCP 工具名（`list_people` 等）都不改名，只改显示的文字和工具说明：改工具名会让已经配好的 agent 失效。这改变了现有界面文案，PR 里要写明。
- **卡片封面**：有头部框就裁头部，没有就裁身体框。宠物没有正脸时整只也认得出来。
- **命名、合并、拆分、忽略、移出**：沿用人物的操作。同品种混在一起时，用户靠拆分、移出修正；不同物种的组之间不允许合并。
- **Inspector**：“人物”区同时列出照片里的人和宠物。
- **图库筛选**：已命名的宠物出现在人物筛选里（同一个 `person_group` facet，不用改）。“含人脸”旁边加“含猫”“含狗”，只看检测结果，不需要先命名。
- **设置 → 人物与宠物**：加“同时识别宠物”开关，默认关（已定，2026-11-23 从默认开改过来）；宠物模型一栏显示当前模型，可“选择其他模型”或切回内置（5.4）。
- **JobDock**：一张卡片，“分析宠物 · 512 / 4,287 · 发现 34 只”，可暂停、取消。
- 所有新文案进 `src/i18n/locales/en/` 和 `zh-CN/`。

## 9. MCP

扩展现有工具，不加新工具：

- `list_people`、`get_person` 的结果加 `subject`；`list_people` 加 `subject` 筛选（`person` / `pet` / `cat` / `dog`）。
- `update_person` 不用改。宠物组的 `group_id` 和人物组同一种。
- `index_people` 加一个参数，选择只分析人、只分析宠物，或两者都分析。
- `search_assets` 的 `people` 条件加 `with_cats` / `with_dogs`（或单独的 `animals` 条件），`person_id` 对宠物组直接可用。
- 同步更新 `docs/agent-native-mcp.md`。

## 10. 什么时候跑（已实现）

“同时识别宠物”默认关（已定）：宠物模型照样随包，用户在设置里打开后才跑。打开以后和人物一样，不经用户同意不扫全库：

- 用户点“扫描”、“分析整个图库”或开了“导入后自动分析”时，开着宠物识别就带上宠物模型，在同一个任务里跑；单张“重新分析”也一样。
- **打开宠物识别之后**：如果最近一次人物分析的结果里没有 `pets`（宠物出现之前跑的，或当时关着），“人物与宠物”页顶部提示一次“分析宠物”，点了才跑（人脸按哈希跳过，只算宠物），点“以后再说”就不再出现（按图库记在本机）。
- 关掉开关：之后的任务不带宠物；已有的宠物组保留，打开后接着用。

## 11. 测试

- **单测**（已有）：`tests/test_pets.py`（存储、物种分区聚类、按模型取维度、封面裁头、筛选、更正不跨物种）、`tests/test_people_job.py`（宠物随人物任务一起跑、各自跳过、老图库只补宠物、宠物出错不影响人脸）、v15 → v16 升级、`electron/petModel.test.js`、`jobArgv` 的宠物参数。worker 的 `--pet-model X --self-test` 用空白图自检。
- **e2e**：新 spec（编号接在现有的 96 之后），用预先算好向量的固定库（仿 `e2e/fixtures/people-catalog.afcatalog`，由种子脚本生成，需要本机有模型和 worker；`.gitignore` 里要像人物固定库那样放行它的 `catalog.sqlite3`）。覆盖：宠物出现在人物页且有标记，“宠物”筛选，命名后在图库按它筛选，Inspector 列出宠物，猫狗之间不能合并。
- **评估**：`research/pet-recognition-lab` 的 Commons 测试集做回归（换模型、改阈值时对比 AUC 和 F1）；家庭图库照片用来定阈值。
- **家庭图库照片（已定：由你准备）**：一个文件夹，每只宠物一个子文件夹，原型的 `analyze.py` 直接能用（第一层文件夹就是哪一只）。最好覆盖：只有一只的家、同品种两只的家、猫狗都有的家，每只几十到几百张，混进一些没有宠物和有别人家宠物的照片。照片只留在本机，不进仓库。

## 12. 阶段

### 阶段 0：原型（已完成，2026-11-22）

结论见第 3 节。

### 阶段 0.5：模型统一托管（已合并，#324）

见 5.5：建 `models` release，上传人脸和深度模型，`fetch-models.mjs` 替换 `fetch-people-model.mjs`，深度模型移出 git，CI 和打包检查跟着改。深度模型的“选择其他模型”补上自检和复制进 Application Support。

### 阶段 1：worker、模型、任务、数据（已实现，`feat/pet-recognition`）

- worker 的 `--pet-model` 和自检；只靠姿态找到的动物用分类器定猫狗（5.1）。
- `scripts/models/convert-pet-model.py`（从 Meta 官方权重、锁定版本转换，转完和 PyTorch 对一遍）、`electron/petModel.js`。
- schema 16（`subject` 两列、迁移和升级测试）、按模型取向量维度、物种分区聚类、宠物阈值、`pets` 筛选；人物任务带宠物（5.2）。
- 用户替换宠物模型：自检要求图像输入、向量输出，`manifest.json` 的 `cluster_threshold` 传到聚类。
- 验收（真实 worker、两个真模型、Commons 201 张）：17.5 秒跑完，认出 172 只动物、62 张人脸；宠物 22 组，猫的组全部干净，混了别的个体的 8 组全是同品种的狗（德牧之间、Bo 和 Sunny 之间）。产品 worker 单独评估：有动物的照片 78%，身体框向量 AUC 0.923（原型 0.920）。
- 宠物模型 `PetEmbedding-dinov2-small-846f00a0.mlpackage.tar.gz` 已传到 `models` release，`bundled-models.mjs` 里是 `pet` 那一行：`npm run fetch:models` 下载、校验、用 `people-worker --pet-model … --self-test` 自检；`release.sh` 的 `fetch-models.mjs --verify` 检查它在 arm64 macOS 14 包里且没被改过。

### 阶段 2：界面和 MCP（已实现，`feat/pet-recognition`）

- 改名“人物与宠物”；同一面墙、爪印、“全部 / 人物 / 宠物”切换、封面裁头；命名和更正只在同物种里选；Inspector 列出宠物和物种；“含宠物”筛选（宠物 / 猫 / 狗）；设置里的开关和宠物模型；“分析宠物”提示。
- MCP：`list_people` 的 `subject`、`index_people` 的 `include_pets`、`search_assets` 的 `pets`；`docs/agent-native-mcp.md` 已加状态行。
- e2e：新 spec 97-pets；`launchApp` 多了 `petModel`（和 `peopleModel` 一样三种）；改名涉及的 02 / 10 / 31 / 44 / 62 / 71 / 72 / 84 已更新。

### 阶段 3：标定和改进

- 用家庭图库照片定阈值（一两只宠物、同一个家、几百张）。
- 第一次核对（2026-11-23）：维护者家的一只布偶猫，13 张，姿势和距离差别很大。用产品 worker 认出 11 张，全判成猫；漏的两张是整张都是脸的大特写和门后只露半身。这只猫自己的照片两两余弦中位 0.70（Commons 同一只动物是 0.62）；和 Commons 里最像的猫（Grumpy Cat，同样是重点色）平均只有 0.50。和 Commons 201 张一起用产品聚类：0.58 下这只猫 10 张一组、1 张单着（地板上伸直躺着那张），没混进任何别的猫；0.56 能把这一张也拉进来，但 Commons 里的猫开始混（Gladstone 和 Palmerston）。所以阈值保持 0.58。
- 还没核对：同一个家里两只长得像的宠物（Commons 里混得最多的正是同品种的狗），以及没有宠物的照片会不会被误认出动物。
- 同一次拍摄内先合并的两轮聚类。
- 需要的话，在发布页提供转好的 DINOv2-B 包，用户按 5.4 自己换。

## 13. 决定

已定（2026-11-23）：

- 人和宠物放同一面墙，加“全部 / 人物 / 宠物”筛选（第 8 节）。
- 导航名“人物”改成“人物与宠物”（People & Pets），涉及的文案见第 8 节。
- 所有模型统一放 AfterFrame 自己仓库的 GitHub Release，人脸和深度模型也搬过去（5.5）。
- 只被姿态检测找到的动物：在身体框上跑 `VNClassifyImageRequest` 定猫狗，两边都不到 0.1 就丢掉（实测 36 只错 1 只，5.1）。
- 同一个 release 也给用户手动下载可选模型，用“选择其他模型”导入；只放许可证允许商用、我们验证过的；第一个可选模型是 DINOv2-B，跟宠物阶段 1 一起上（5.6）。深度模型的“选择其他模型”要补上自检和复制。
- 宠物识别默认关，宠物模型照样随包；设置里打开后，跟着人物分析一起跑（第 10 节）。默认关就不改变现有分析的耗时；打开后“分析整个图库”和“导入后自动分析”会多算宠物、多花一点时间。
- 用 DINOv2-S，随 App 内置，用户不用下载（5.3）。
- 用户可以替换宠物模型，复用人物的“选择其他模型”（5.4）。
- 定阈值用的家庭图库照片由你准备（第 11 节）。

待定：

1. **可选模型要不要在魔搭放一份国内镜像**：GitHub release 在国内常常下不动。推荐放：只多一个上传步骤，文件和哈希一样；不放的话，国内用户基本只能用内置模型。
