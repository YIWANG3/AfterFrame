# 文件格式支持：对照 Eagle 的差距与格式注册表重构

> **状态（2026-11-01）**：P0（纯重构，#242）、P1a（加格式，#243，PSD 走和 HEIF 一样的转码而不是 HD 预览）、P1b（不支持的文件有交代，#244）、P1c（原图统一，#245，见 4.5 节的实际做法）已合并；P2 的格式 facet 按家族聚合是 #246（4.6 节的实际做法，不加列）；`.xmp` 边车评分是 4.7 节（只读星级，边车变了跟着变，直到用户在应用里自己打过分）；JXL、`.mxf` 各自单独评估，未开工。第 6 节的五条都已按建议定下：只报不收、JPEG 95 + ICC、PSD 进 P1a、Dock 表继续用测试守约、HEIF 家族合并显示。P0：`services/sidecar/src/media_workspace/formats.py` 是注册表，`apps/desktop/shared/formats.generated.mjs`（`npm run gen:formats`）+ `shared/formats.mjs` 是 JS 侧，`tests/test_formats.py` 守同步；支持的集合没变。第 1 节是 Eagle 的现状，第 2 节是重构前的现状，第 3 节是差距，第 4 节是方案，第 5 节分期，第 6 节待拍板。

## 0. 结论

1. **Eagle 的策略是"什么都能导入，能预览多少算多少"**：macOS 115 种、Windows 106 种可预览格式，十个类别，其中一半以上是设计资产（3D、字体、Office、源文件）。AfterFrame 是摄影师的选片工作台，不该追这个数字；需要对齐的只有 **图像、RAW、视频** 三类，外加"不支持的文件怎么交代"这一条行为。
2. **在这三类里，我们的 RAW 覆盖比 Eagle 宽（38 种对 19 种），图像和视频比 Eagle 窄，而且窄在摄影师真会碰到的格式上**：相机直出的 `.HIF`（佳能 R 系、索尼、富士的 HEIF 直出）、AVCHD 摄像机的 `.MTS / .M2TS`、Photoshop 的 `.PSD`、还有 `.GIF / .BMP / .JXL`。其中 HIF、GIF、BMP、PSD、JFIF 的解码器**已经在 sidecar 里注册好了**（Pillow 12.3 + pillow-heif 1.8），只是导入白名单没放它们进来。
3. **真正的缺陷不是列表短，是列表有四份、互不一致、谁都不是权威**：sidecar 两份（`config.py` 和 `reverse_lookup.py` 手抄了同一个集合）、Electron 的看门正则、渲染层的"浏览器能直接显示"正则、`package.json` 里 Dock 投递的类型表。`.heif` 能被监听、能被显示，却不能被导入；`.gif / .bmp` 进了监听正则和显示正则，却被 sidecar 静默丢掉；不支持的文件丢进来**没有任何反馈**，连已导入的文件夹根都会被注册一次。
4. **方案：一个格式注册表，sidecar 持有（因为导入的闸门和嗅探都在那里），生成一份 JS 模块给主进程和渲染层，测试守住三者同步**；注册表的每一行同时回答"能不能导入、哪个引擎解码、浏览器能不能直接显示、能不能作为导出源、Dock 收不收"。先做纯重构（集合不变，四份变一份），再按注册表加格式，最后把"不支持"从静默变成可见。这也是 [plugin-architecture-research.md](plugin-architecture-research.md) 里 Eagle Format Extension 那一类扩展点在我们这里的内部形态。

## 1. Eagle 支持什么

来源：[What file formats does Eagle support?](https://en.eagle.cool/support/article/what-file-formats-does-eagle-support)（2026-10-31 抓取，macOS 页 115 种 / Windows 页 106 种）。原文的分组照抄，括号里是我们的评注。

| 类别 | Eagle 的列表 | 与我们的相关度 |
|---|---|---|
| Image | bmp, gif, heic, heif, hif, icns, ico, jpeg, jpg, png, svg, tif, tiff, webp, avif, base64, jfif, insp, jxl, jpe；Windows 多 eps | **高**。hif / heif / gif / bmp / jfif / jpe / insp / jxl 是我们没有的。svg / ico / icns / base64 不是照片，不要 |
| RAW | 3fr, arw, cr2, cr3, crw, dng, erf, mrw, nef, nrw, orf, pef, raf, raw, rw2, sr2, srw, x3f（列表里的 otf 是笔误） | 我们全有，还多 20 种（ari、iiq、fff、gpr、rwl、srf、kdc……） |
| Video | m4v, mp4, webm, mov, mkv, flv, f4v, ts, mts, m2ts, 3gp；注明编码支持 H.264 / HEVC / AV1 / VP9 / VP8 / ProRes，MOV 透明通道 | **中高**。mts / m2ts 是 AVCHD 相机的直出格式，缺它会让索尼、松下摄像机用户导不进去；ts / 3gp / flv / f4v 低 |
| Texture | dds, exr, hdr, tga | 低。exr / hdr 是 HDR 合成和 3D 渲染的中间格式，Pillow 不读 EXR；tga 顺手能加 |
| Source | af / afdesign / afphoto / afpub（Affinity）、ai、c4d、cdr、clip、dwg、graffle、idml / indd / indt、mindnode、psb、psd、psdt、pxd、Principle、sketch、skt、skp、xd、xmind | 只有 **psd（中）** 和 psb（低）与摄影师相关，Pillow 能读 PSD 的合成图层，PSB 不行。其余是设计师的 |
| Audio | aac, flac, m4a, mp3, ogg, wav | 不要 |
| Font | ttf, ttc, otf, woff | 不要 |
| Office | txt, pdf, key, numbers, pages, potx, ppt, pptx, xls, xlsx, doc, docx, eddx, emmx | 不要 |
| Others | html, mhtml, url | 不要 |

Eagle 还有三条**行为**值得对照：

- **任何文件都能导入**。不能预览的照常进库、打标签、搜索，用户可以给它指定一张自定义缩略图。
- **格式扩展插件**（Format Extension）：`manifest.json` 里 `preview.<ext>` 声明扩展名，`thumbnail` 是一个 `({src, dest, item}) => item` 的 JS 模块，`viewer` 是一个带 `id / path / width / height / theme / lang` 参数的 HTML。HEIC、JPEG XL、Windows 的 RAW 都是靠这个机制由社区补的。
- **支持矩阵按平台写明**。页面本身就是 Windows / macOS 两个 tab。

## 2. 我们现在支持什么，以及代码里是怎么决定的

### 2.1 四份列表

| 位置 | 内容 | 作用 |
|---|---|---|
| `services/sidecar/src/media_workspace/config.py:10-45` | `DEFAULT_RAW_EXTENSIONS`（38）、`DEFAULT_IMAGE_EXTENSIONS`（avif heic jpeg jpg png tif tiff webp） | RAW 源扫描、预览分支、监听器 |
| `reverse_lookup.py:55` | `IMAGE_EXTENSIONS`，**手抄**了上面那个集合 | 和 `video.VIDEO_EXTENSIONS`（mp4 mov m4v avi mkv webm）、RAW 并成 `MEDIA_EXTENSIONS`（:578），`iter_image_files` 用它过滤。**这是真正的导入闸门** |
| `apps/desktop/electron/watcher.js:30` `MEDIA_RE` | 比 sidecar **多** gif bmp heif，**少** avi mkv 和 8 个 RAW 扩展名 | 监听文件夹的预过滤 |
| `apps/desktop/package.json:131-205` `CFBundleDocumentTypes` | 第三份照抄 | Dock 投递；`tests/test_file_types.py:82-97` 用一个测试逼它和 `MEDIA_EXTENSIONS` 相等 |
| `apps/desktop/src/components/lightboxView.js:38` `BROWSER_IMAGE` | jpe?g png webp gif avif bmp heic heif | 决定 Lightbox 顶层放原图还是 HD 预览；gif / bmp 在这里，却永远导不进来 |
| `electron/media/protocol.js:15` `HEIC_RE` | heic heif | `media://` 是否把原图转码成 JPEG 再给 Chromium |
| `electron/media/httpServer.js:11-14` | 视频 MIME 表 | 范围请求服务 |
| `derived.py:40-43` | 裁剪 / 文字 / 导出的源格式 jpg jpeg png webp tif tiff，输出 jpeg png webp | 注释说 HEIC 和 RAW 不在范围，但 Pillow + pillow-heif 早就在了，这个理由已经过期 |
| 导出编码器 | `useEditorSave.js:19`、`canvasHelpers.js:357,368`、`useSplitExport.js:33`、`CollageOverlay.jsx:791`（没有 WebP）、`saveFile.js:207`、`imageMetadata.js:45`、`mcp/server.js:131,815,865`、`cli.py:523` | 同一条规则抄了 9 遍 |

### 2.2 "RAW"有三种判法

- 后缀在 `DEFAULT_RAW_EXTENSIONS` 里：`reverse_lookup.is_raw`、`preview_service.generate_for_row` 的分支。
- 后缀 + 文件头嗅探（`ftyp` 的 `crx `、TIFF 的厂商字符串）：`file_types.is_raw_file`，只用在"添加 RAW 源"的扫描里，而且任何 TIFF 头都会被判成 `tiff-raw`。
- `asset_type == "raw"`：渲染层和 MCP 十几处字符串比较。

`file_types.RAW_EXTENSION_FORMATS` 只给了 13 / 38 个扩展名可读的格式名，其余退回扩展名本身。嗅探出来的格式名**不落库**。

### 2.3 解码矩阵（现状）

| 类别 | 缩略图 512 / HD 2000 | 原图显示（Lightbox 顶层、编辑器画布） | 元数据 |
|---|---|---|---|
| JPEG / PNG / WebP / AVIF | Pillow（全平台），Mac 失败退 `sips` | Chromium 直接解码 `media://` | ExifTool，退 Pillow |
| HEIC | Pillow + pillow-heif | `media://` 转码成 JPEG：Mac `sips`，Windows 走 sidecar `transcode-image`；Windows ARM 没有 pillow-heif wheel，静默失败 | ExifTool |
| TIFF | Pillow | **没有**。Chromium 不解 TIFF，`showsOriginal` 把它排除，顶层只有 HD 预览 | ExifTool |
| RAW | 嵌入 JPEG（rawpy）≥ 阈值 → Mac Quick Look / `sips` 全尺寸 → LibRaw 子进程（Windows 唯一路径，HD 上限 8000 px） | 没有原图概念：HD 按需生成，编辑用 `render_raw_full` 的全尺寸 JPEG | ExifTool + LibRaw（尺寸、方向） |
| 视频 | Mac `video-tool`（AVFoundation）海报帧，Windows ffmpeg；只做 512 | Mac 原生 AVPlayer（ProRes 可播），其余 `<video>` + 本地范围服务；解码失败按需转 H.264 代理 | `video-tool probe` / ffprobe |

sidecar 的 Pillow 当前**已注册但白名单没放进来**的扩展名：`.heif .hif .heics .gif .bmp .psd .tga .dds .icns .jfif .jpe .jp2 .avifs .eps`（EPS 需要 Ghostscript，实际读不了）。也就是说 HIF、GIF、BMP、PSD、JFIF 的缩略图和 HD 预览**今天改一行白名单就有**，差的是原图显示、导出源、Dock 类型这几处的配套。

### 2.4 不支持的文件现在怎么样

1. 渲染层不过滤（`App.jsx:925-940`），任何路径都送进 `addImagesFromPaths`。
2. `useWorkspace.js:1178-1195` 先 `registerRoots("image", paths)`：**一个不支持的文件也会被注册成 catalog 的图片根**，并加入 `media://` 白名单。
3. sidecar `iter_image_files` 只产出白名单内的文件；其余不计数、不报告，结果里没有 `skipped_unsupported` 字段。
4. 完成 toast 只在 `already_in_catalog > 0` 时出现。**只丢不支持的文件进来，结果是一个空的、无声的导入任务。**
5. 后缀支持、文件损坏的情况有正确处理：`preview_entries.status = 'failed'`，卡片显示 "No preview"。
6. Web 版有一句 toast（"N 个文件已跳过：视频和 RAW 需要桌面版"），桌面版没有。

Eagle 的做法（什么都收）和我们（白名单 + 静默）是两个极端。考虑到 [users-dont-read-docs]（小红书来的用户不看 README），静默跳过是最差的一种：用户只会觉得"导入坏了"。

## 3. 差距清单

只列图像 / RAW / 视频三类，按对摄影师的价值排序。"解码"一列写的是**今天**在 sidecar 里有没有解码器，不是要不要做。

### 3.1 图像

| 格式 | 谁会碰到 | 解码（现状） | 原图显示 | 导出源 | 建议 |
|---|---|---|---|---|---|
| **.hif / .heif** | 佳能 R5/R6、索尼 α7 IV 以后、富士 X-T5 的 HEIF 直出；`.heif` 已能监听和显示却不能导入 | pillow-heif 已注册 | 和 HEIC 一样走转码 | Pillow 能读 | **P1，必做**。本质是把 HEIC 这一行扩成 heic / heif / hif 三个别名 |
| **.psd** | 修图回流；Eagle 支持 | Pillow 读合成图层（flattened composite） | Chromium 不解，同 TIFF 走 HD | Pillow 能读 | P1。`.psb` Pillow 不读，不做 |
| **.gif / .bmp** | 很少，但 Eagle 有、我们的监听正则也有，不加等于留着一个已知矛盾 | Pillow 已注册 | Chromium 原生 | Pillow 能读 | P1，顺手。GIF 只取第一帧 |
| **.jfif / .jpe / .insp** | JPEG 的别名；`.insp` 是 Insta360 全景照片 | 就是 JPEG | 原生 | 是 | P1，顺手。注册表里是 JPEG 这一行的别名，不是新格式 |
| **.jxl** | 独立 `.jxl` 文件几乎没有相机产出，Eagle 支持它是面向设计素材；摄影师更实际的是 **JXL 压缩的 DNG**（iPhone 15 Pro 以后的 ProRAW），那是 RAW 这一行的事，Intel Mac 的 rawpy 0.25.1 读不了 | **没有**。需要 `pillow-jxl-plugin`（有 Mac / Windows wheel） | Chromium 已移除 JXL | Pillow + 插件 | P2。单独评估 wheel 体积和 PyInstaller 打包 |
| .tga / .dds / .jp2 | 游戏贴图、JPEG 2000 | Pillow 已注册 | 不解 | 能 | 不做，等有人要 |
| .exr / .hdr | HDR 合成中间格式 | Pillow 不读 EXR（需 OpenEXR） | 不解 | 否 | 不做 |
| .svg / .ico / .icns / .base64 / .eps | 不是照片 | — | — | — | 不做。SVG 作为 logo 已经单独处理（`personalLogos.js`） |

### 3.2 RAW

扩展名覆盖我们比 Eagle 宽，差距在**保真和一致性**，不在列表：

- `RAW_EXTENSION_FORMATS` 只认 13 种，Inspector 和筛选栏里其余 25 种只能显示扩展名。
- 三种"是不是 RAW"的判法要收成一种（第 4 节）。
- Windows 只有 LibRaw 一条路，颜色与 Mac 的 Image I/O 不同，这是 windows-support-plan §7 已知的决定，不在本文范围。
- `.braw / .r3d`（视频 RAW）继续不收，注释里已经写明。

### 3.3 视频

| 格式 | 谁会碰到 | 解码（现状） | 建议 |
|---|---|---|---|
| **.mts / .m2ts** | 索尼、松下、佳能 AVCHD 摄像机直出 | Mac AVFoundation 能读 MPEG-TS 容器里的 H.264（2026-10-31 用 ffmpeg 合成的 `.mts` 实测：`video-tool probe` 和 `poster` 都成功）；Windows ffmpeg 能 | **P1，必做** |
| .3gp | 老手机 | 两边都能 | P1 顺手 |
| .ts / .flv / .f4v | 录屏、直播 | ffmpeg 能，AVFoundation 不认 flv | 不做，不是相机格式 |
| .mxf（Eagle 也没有） | 佳能 XF、索尼 XDCAM 专业机 | ffmpeg 能，AVFoundation 部分 | P2 评估 |
| .insv / .lrv / .360（Eagle 也没有） | Insta360、GoPro 的伴生低清文件 | `.lrv` 是 MP4，`.insv` 是定制容器 | `.lrv / .thm` 归入"已知伴生文件，静默忽略"（第 4.4 节），不当资产 |

编码层面：Eagle 写明支持 AV1 / VP9 / VP8。我们 Mac 原生播放靠系统（AV1 需 macOS 14 + M3 以后硬解，VP9 看 Chromium），解码失败有 H.264 代理兜底，所以容器加进来就够，编码不用单列。

### 3.4 行为差距

| | Eagle | 我们 | 要不要对齐 |
|---|---|---|---|
| 不支持的文件 | 照常入库，可配自定义缩略图 | 静默跳过，还会注册一次根 | **部分对齐**：不入库（AfterFrame 不是 DAM，装 zip 和 docx 没意义），但必须**报出来**：跳过几个、哪些扩展名、为什么 |
| 支持矩阵 | 按平台写在帮助页 | 散在 README 的几句话里，和代码不同步 | 对齐，但不写文档：从注册表**生成**到 Settings → Library 的一个"支持的格式"面板，Windows 上标出"只有缩略图"的格式 |
| 新格式的扩展机制 | 社区插件 | 改四处代码 | 内部注册表；第三方插件是 plugin-architecture-research 的 C，不在本文 |

## 4. 重构方案：格式注册表

### 4.1 原则

1. **一份源，sidecar 持有**。导入闸门、文件头嗅探、预览分支、导出源判断都在 Python 侧，权威必须在那里。主进程和渲染层拿**生成的** JS 模块，不手抄。
2. **一行回答所有问题**。每种格式一条记录，字段齐全（见 4.2），任何消费方只按字段取，不再各自写 `/\.(jpe?g|png)$/`。
3. **后缀是入口，不是结论**。分类函数 `classify(path)` 先查后缀，有歧义的（`.tif` 可能是 RAW、`.heic` 可能是伪装的 JPEG、Eagle 的 HEIC 插件 1.0.3 专门处理这种）再嗅探；结果落库。
4. **先不改集合，只改结构**。P0 结束时四份列表合一而支持的格式**一个不多一个不少**，e2e 全绿，这是重构的验收标准；加格式是 P1 的事。
5. **沿用现有的"声明一行、生成绑定、测试守约"模式**（`shared/ipcChannels.mjs` + `ipcChannels.test.js`、`DockDropTypesTest`），不引新机制。

### 4.2 注册表长什么样

`services/sidecar/src/media_workspace/formats.py`：

```python
@dataclass(frozen=True)
class MediaFormat:
    family: str                 # "jpeg" | "heif" | "tiff" | "psd" | "cr3" | "mp4" | …  落库到 assets.format
    kind: str                   # "image" | "raw" | "video"
    extensions: tuple[str, ...] # (".jpg", ".jpeg", ".jfif", ".jpe", ".insp")  别名归到同一行
    label: str                  # Inspector / 筛选栏显示："JPEG"、"Canon CR3"、"AVCHD"
    sniff: str | None           # "tiff-maker" | "isobmff-brand" | None  有歧义时调哪种嗅探
    decode: dict[str, tuple[str, ...]]   # {"darwin": ("embedded", "imageio", "libraw"), "win32": ("embedded", "libraw")}
    browser_native: bool        # Chromium 能否直接显示原图（jpeg/png/webp/avif/gif/bmp 为 True）
    export_source: bool         # Pillow 能否读它作为裁剪 / 文字 / 导出的源
    dock: bool                  # 是否进 CFBundleDocumentTypes（默认 = 可导入）
    platforms: tuple[str, ...]  # 哪些平台能解码；空 = 全部

REGISTRY: tuple[MediaFormat, ...] = (...)

def classify(path: Path, *, sniff_bytes: bytes | None = None) -> Classification | None
    # None = 不支持；Classification(kind, family, extension, via="suffix"|"sniff")
def importable_extensions() -> frozenset[str]
def by_kind(kind) / by_extension(ext) / label_for(ext)
```

现有的 `DEFAULT_RAW_EXTENSIONS`、`DEFAULT_IMAGE_EXTENSIONS`、`IMAGE_EXTENSIONS`、`VIDEO_EXTENSIONS`、`MEDIA_EXTENSIONS`、`RAW_EXTENSION_FORMATS`、`derived.SUPPORTED_IMAGE_EXTS` 全部变成从 `REGISTRY` 推导的只读视图（P0 保留旧名字做兼容导出，P1 删）。`file_types.detect_raw_format / is_raw_file` 的嗅探逻辑搬进 `classify`，`reverse_lookup.is_raw` 和 `preview_service` 的分支改用 `classify(...).kind`。

### 4.3 生成到 JS

`apps/desktop/shared/formats.generated.mjs`，由 `python -m media_workspace.formats --emit-js` 生成并提交。内容：

```js
export const FORMATS = [ { family, kind, extensions, label, browserNative, exportSource, platforms }, … ];
export const IMPORTABLE_EXTENSIONS = new Set([...]);
export const MEDIA_RE = /\.(…)$/i;              // watcher.js 用
export const BROWSER_NATIVE_RE = /\.(…)$/i;     // lightboxView / galleryRepair 用
export const VIDEO_MIME = { ".mp4": "video/mp4", … };
export const EXPORT_FORMATS = { jpeg: ".jpg", png: ".png", webp: ".webp" };
```

守约测试：

- `tests/test_file_types.py` 增加一条：重新生成的内容和已提交的 `formats.generated.mjs` 逐字节相等（CI 里不同步就红）。
- `DockDropTypesTest` 改成：`package.json` 的 `CFBundleDocumentTypes` == `[f for f in REGISTRY if f.dock]`。更进一步可以在 `scripts/` 里用一个 prebuild 步骤**生成**这段 package.json，但 electron-builder 配置被 `e2e`、`mac-builds.cjs` 等多处读，生成会增加一层间接，P0 先只守约、不生成。
- 现有的 `watcher.test.js`、`lightboxView.test.js`、`galleryRepair.test.js` 不动，它们就是消费方的回归测试。

### 4.4 导入闸门和"不支持"的交代

`iter_image_files` 改为产出 `(path, classification)`，并把闸外的文件分三桶计数，写进 `import_directory` 的结果：

```python
"skipped_unsupported": {"count": 12, "by_extension": {".docx": 3, ".zip": 1, ".xmp": 8}},
"skipped_companion":   {"count": 8,  "by_extension": {".xmp": 6, ".thm": 2}},   # 已知伴生文件，不提醒
```

- **伴生文件**（`.xmp .thm .lrv .aae .pp3 .dop .on1 .cos`，Lightroom / 相机 / Capture One 的边车）：知道它是什么，所以不算"不支持"，不打扰用户。边车里的星级 4.7 节读了（嵌在 JPEG 里的 XMP 一直读到），关键词和颜色标签见第 6 节 6、7。
- **不支持**：toast 一句"已跳过 12 个不支持的文件（docx、zip）"，JobDock 里这次导入的详情可以展开看扩展名计数；toast 上一个"查看支持的格式"按钮直达 Settings → Library 的格式面板。
- `addImagesFromPaths` 在渲染层**先**按 `IMPORTABLE_EXTENSIONS` 分流：单个不支持的文件不再被 `registerRoots` 注册成根；文件夹照旧整个注册，由 sidecar 过滤计数。
- Windows 启动参数（`singleInstance.js`）同样过一遍 `classify`。

### 4.5 "原图显示"的统一

重构前有三条互不相干的路：JPEG 之流 Chromium 直接显示；HEIC 由 `protocol.js` 的 `HEIC_RE` 特判转码；RAW 和 TIFF 没有原图、靠 HD 预览。按注册表收成两条（P1c 的实际做法，和最初设想的差别见下）：

- `browser_native = True`：`media://` 原样投递，不变。
- `transcode_for_browser = True`（HEIF 全家、PSD、TIFF）：Lightbox 的细节层、Compare 和编辑器画布都照常请求原图路径，`media://`（`electron/media/protocol.js`）第一次被问到时把原图渲染成**全尺寸 JPEG 95**（macOS 用 `sips`，带 ICC 和 EXIF；其他平台用 sidecar 的 Pillow，`transcode-image --quality 95`，16 位和 CMYK 一并处理），缓存在 `userData/transcode-cache`，按最近使用保留 1 GB，设置 → 图库 → 缓存里可以打开。HEIC 特判、`os.tmpdir()/afterframe-heic-cache` 和 "TIFF 没有原图" 一起清掉：加一种浏览器不认的格式只需在注册表里标 `transcode_for_browser`。
- RAW 不走这条路，仍是按需 HD（相机内嵌 JPEG）+ 编辑时的全尺寸渲染（`rawEditSource.js`）。最初设想把 RAW 也并进"全尺寸渲染"，但 RAW 的全尺寸解码是秒级、内嵌 JPEG 是毫秒级，而且 35-raw-import 守着的那套按需 HD 逻辑本身没有问题；渲染放进 catalog 的预览目录也不如 userData 下带预算的缓存（一张 4800 万像素的 HEIF 渲染出来 25 MB，进 catalog 就不会被清）。

编辑源用 JPEG 95 + 保留 ICC（第 6 节第 2 条，按建议定）。

### 4.6 格式 facet 按家族聚合（实际做法：不加列）

最初设想 schema 加一列 `format TEXT`（迁移时按扩展名回填）。实现时改成**不落库**：家族是扩展名的纯函数，注册表就是那张映射表，加一列只是把它抄进每一行，还要迁移和回填。做法：

- `formats.family_sql(expr)` 生成一段 `CASE … WHEN 'jpg' THEN 'jpeg' … END`，`get_facet_values` 的 `extensions` 用它按家族计数，每项带注册表的 `label`（JPEG、HEIF、Canon CR3）；`.jpg` 和 `.jpeg` 是一项 JPEG，`.heic / .heif / .hif` 是一项 HEIF（第 6 节第 5 条就此了结）。键名仍叫 `extensions`，渲染层、MCP `get_catalog_info`、web bridge 都不用改读法。
- facet 子句 `extension` 的值可以是家族（`jpeg`，筛选栏发的）或单个扩展名（`jpg`，老规则和 agent 发的）：家族展开成它的全部扩展名（`formats.filter_extensions`），单个扩展名仍只匹配它自己。已保存的智能集合规则 `{extension: "JPG"}` 语义不变，不需要迁移。
- 渲染层 `FilterBar` 显示 `label`；`shared/formats.mjs` 的 `formatLabel / filterExtensions / familyOf` 供筛选条和 web bridge（`src/api/browser`）镜像同一套规则。
- MCP `search_assets` 的 `extension` 说明改为"家族或扩展名"，`asset_type` 的 enum 补上 `"raw"`（原来 `db/facets.py` 收、工具 schema 不收，是个 bug）。没有另加 `format` 参数：`extension` 已经接受家族。
- Inspector 没改：它今天不单独显示格式一栏，文件名里有扩展名。
- e2e 47 / 48 / 53 的格式选项从 "JPG" 变成 `jpeg`（显示 JPEG）；51 里 agent 存的老规则 "jpg" 仍显示为 JPG。

### 4.7 `.xmp` 边车评分（实际做法：只读星级，不加列）

**谁写边车**：Lightroom Classic 和 Bridge / Camera Raw 对 RAW 写 `IMG.xmp`（JPEG / TIFF / DNG / PSD 它们直接写进文件，今天已经读到）；darktable 写 `IMG.CR2.xmp`；Capture One 用自己的 `.cos`，DxO 用 `.dop`，RawTherapee 用 `.pp3`，这三个不带 XMP 星级，不读。边车里和选片有关的是 `xmp:Rating`（星级）、`xmp:Label`（颜色标签）、`dc:subject` / `lr:hierarchicalSubject`（关键词）；其余是 Camera Raw 的调色参数（`crs:*`），**不渲染**：复现 Adobe 的处方等于重写一个 Camera Raw，结果必然和 LR 里看到的不一样，比不读更误导。AfterFrame 是选片工具，RAW 预览走内嵌 JPEG，这一点不变。

**读法**（`metadata.sidecar_path / sidecar_rating`）：导入读元数据时在文件旁找两种名字（两种大小写），找到就用 `xml.etree` 取 `xmp:Rating`，不走 ExifTool（边车几 KB，纯 XML，少一次进程往返，没有 ExifTool 的平台也能读）。边车里有 0–5 的星级就以边车为准（它比相机写进 RAW 的星级新）；没有星级、或是 Bridge / darktable 的 `-1`（拒片，不是星数）就退回文件里嵌的。`IMG.xmp` 同时作用于同名的 `IMG.CR2` 和 `IMG.JPG`：LR 把 RAW+JPEG 当一张照片，星级应该两张卡都显示。边车的 mtime 记在 `metadata_json.sidecar_modified_time`。

**什么时候生效**：导入和再导入每次都重读元数据（`resolve_image / index_raw_file` 本来就不跳过已入库的文件），所以再导一次就跟上。写入规则从"只在应用里没有评分时取文件的星级"（`COALESCE`）改成**"应用里的评分还是上次从文件读到的那个，就跟着文件变"**：`app_rating IS metadata_json.rating` 时取新值，否则保留。用户在应用里打过的分、清掉的分（0）都和文件的不同，所以保留；没动过的跟着 LR 走，LR 清掉星级时这里也清掉。不加 `rating_source` 列，`metadata_json.rating` 已经是"上次文件说的"。嵌在 JPEG 里的星级同样受益：在 LR 里改了星再存回 JPEG，这里跟着变。

**监视文件夹**：`electron/watcher.js` 原来只放行媒体文件名，`.xmp` 一律忽略；现在一个 `.xmp` 的变化映射到它的照片（`IMG.CR2.xmp` → `IMG.CR2`；`IMG.xmp` → 同目录下同名的媒体文件，可能两个），走原来的 `changed-media` → 导入路径。`changed_media` 对一个本身没变的照片再比边车的 mtime 和 `metadata_json.sidecar_modified_time`，不同（出现、改写、删掉）就算变了。照片本身没变，所以不重做预览，只更新评分。

**不做**：`xmp:Label`（AfterFrame 没有颜色标签的概念）、`dc:subject` 关键词进标签（和 AI 标签混在一起显示，要先定来源怎么区分）、`-1` 映射成 X 旗标（旗标是用户自己的）。三项写在第 6 节。

### 4.8 不做什么

- 不做 Eagle 的"任意文件入库 + 自定义缩略图"。AfterFrame 的定位是选片，catalog 里只放照片和视频。
- 不做音频、字体、Office、3D、源文件（除 PSD）。
- 不做第三方格式插件；注册表的 `decode` 字段是将来插件声明的接口雏形，但本文到内部注册表为止。
- sidecar 不拆，和 plugin-architecture-research §4.1 的结论一致。

## 5. 分期

| 期 | 内容 | 估时 | 验收 |
|---|---|---|---|
| **P0 纯重构** | `formats.py` + `formats.generated.mjs` + 同步测试；`config.py / reverse_lookup.py / video.py / derived.py / watcher.js / lightboxView.js / protocol.js / httpServer.js / package.json` 的列表改成消费注册表；三种 RAW 判法收成 `classify`；9 处导出编码器表收成一处 | 1.5 天 | 支持的扩展名集合**不变**（测试断言新旧集合相等后再删旧常量）；全部单测 + e2e 绿 |
| **P1a 加格式** | 图像：heif、hif、psd、gif、bmp、jfif、jpe、insp；视频：mts、m2ts、3gp。每个都要：Pillow / ffprobe 冒烟（Mac + Windows 盒子）、Dock 类型、`showsOriginal` 行为、e2e 夹具（37-heic-import 扩成 HEIF 家族；PSD 和 MTS 各一个小夹具，MTS 用 ffmpeg 合成，和 70-native-video 的 ProRes 同法） | 1.5 天 | 一个 PR 一类格式，不叠 PR |
| **P1b 交代不支持** | `skipped_unsupported / skipped_companion` 计数、toast + JobDock 详情、渲染层不再把单文件注册成根、Settings → Library 的"支持的格式"面板（从注册表生成，按当前平台标注） | 1.5 天 | e2e：丢一个 `.docx` 进去有 toast；只丢伴生文件没有 toast |
| **P1c 原图统一** | 4.5 节：`transcode_for_browser` 驱动的 JPEG 95 渲染（TIFF 加入），缓存从临时目录搬到 userData 并限额，删 HEIC 特判 | 2 天 | 37-heic-import、35-raw-import、e2e/11 的 tif 重试不变；79 多出 TIFF 的 Lightbox 用例 |
| **P2** | facet 按家族（4.6 节，不加列）+ MCP `asset_type` enum 修正：#246；`.xmp` 边车评分（4.7 节）：单独 PR；JXL（评估 `pillow-jxl-plugin` 打包）、`.mxf`：各自单独评估、单独 PR | 2 到 3 天，可拆 | 47 / 48 / 53 的格式选项从 "JPG" 变成 jpeg（显示 JPEG）；51 的老规则 "jpg" 仍显示 JPG |
| **文档** | README 的格式段落改为指向 Settings 面板一句话；`docs/README.md` 的状态行 | 0.5 天 | 已做 |

P0 是其余所有期的前提；P1a / P1b / P1c 互不依赖，可以并行；P2 依赖 P0。总计约一周到一周半。

## 6. 待拍板

1. **不支持的文件：只报不收**（本文建议）还是像 Eagle 一样也入库？
2. **非原生格式的编辑源**（4.5）：全尺寸 JPEG 92（和 RAW 今天一致，有一次有损）还是 PNG（无损，HEIC 一张 48 MP 的 PNG 要 100 MB 以上）？建议 JPEG 95 + 保留 ICC，和 RAW 对齐。
3. **PSD 要不要进 P1a**：Pillow 只读合成图层，带图层的 PSD 如果没有保存合成图（Photoshop 的 "Maximize Compatibility" 关掉时）读出来是空白。建议进，失败走现有的 `status='failed'` + "No preview"。
4. **`package.json` 的 Dock 类型表要不要改成生成**，还是继续用测试守约。
5. **`.heif / .hif` 的 facet 标签**：和 `.heic` 合并显示为 "HEIF"——已随 4.6 节落地。
6. **边车里的关键词**（`dc:subject`）要不要进 `asset_tags`：有用，但要先定它和 AI 标签在界面上怎么区分（`source` 列已经有 `ai` / 用户两种）。4.7 节先不读。
7. **边车里的拒片**（`xmp:Rating = -1`，Bridge / darktable）要不要映射成 X 旗标：建议不要，旗标是用户在这里自己做的决定；4.7 节当作没有星级。

## 来源

- Eagle 支持格式：[What file formats does Eagle support?](https://en.eagle.cool/support/article/what-file-formats-does-eagle-support)（macOS 115 / Windows 106，2026-10-31）
- Eagle 格式扩展插件：[Format Extension (preview)](https://developer.eagle.cool/plugin-api/get-started/plugin-types/preview.md)；社区的 [HEIC](https://community-en.eagle.cool/plugin/heic-format-extension)、[RAW（Windows）](https://community-en.eagle.cool/plugin/eagle-extension-raw) 扩展
- Eagle 3.0 关于"导入所有类型 + 自定义缩略图"：[Eagle 3.0 Release Note](https://en.eagle.cool/blog/post/eagle-3.0)
- 仓库内：`config.py`、`reverse_lookup.py`、`video.py`、`file_types.py`、`derived.py`、`preview_service.py`、`watcher.js`、`lightboxView.js`、`media/protocol.js`、`package.json` 的 `CFBundleDocumentTypes`、`tests/test_file_types.py`；[plugin-architecture-research.md](plugin-architecture-research.md) §1、§4；[windows-support-plan.md](windows-support-plan.md) §5、§7；[image-asset-model.md](image-asset-model.md)
