# Windows 支持：现状评估与方案

> **状态（2026-10-03）**：开始实施。Windows 开发机已就绪（第 9 节），真机基线见第 10 节，按第 11 节的小分支方式推进。阶段 1 的第一项已随 0.5.6 发布（#114）。
> 起因（2026-10-02）：社媒上要 Windows 版的反馈很多。
> 依据：对 `439f397`（0.5.5）做了三路代码审计（Electron 主进程、Python sidecar、前端/打包/CI），关键结论都抽查核实过，性能数据是在本机实测的；第 10 节是在 Windows 真机上跑出来的结果。
> 文中行号以 `439f397` 为准，0.5.6（#113、#114）改过的文件里行号有偏移。路径如果不以 `services/`、`tests/`、`docs/`、`scripts/` 开头，就是相对 `apps/desktop/` 而言。

## 0. 结论

- **能做，但现在直接打包是用不了的**：图片显示不出来，中文环境下 sidecar 会崩，窗口没有关闭按钮。详见第 2 节。
- **核心卖点基本都是跨平台的**：图库、筛选、编辑、相框、拼图、切图、AI 重绘/标注、MCP 都写在 JS、Node、Python 里。绑死在苹果框架上的只有 4 个功能：深度感知文字、主体抠图、人物识别、视频。
- **平台专属代码占比很小**：前端、Electron、sidecar 合计约 6.3 万行。涉及平台的文件约 1.8k 行（按整个文件算），加上 Swift 1.3k 行，不到 5%。
- **方向是"调用约定统一，各平台用各自的引擎"**：Mac 继续用 CoreML、Vision、AVFoundation，不降级；Windows 换成自己的引擎。不要走"两边都用同一套"的路子（理由见 5.1）。
- **先做对 Mac 也有好处的准备工作**（第 6 节阶段 1），再做 Windows 专属的部分。这样即使最后不做 Windows，前面的投入也不浪费。

## 1. 各功能在 Windows 上的现状

| 功能 | 修完阻断项后 | 原因 |
|---|---|---|
| 图库、筛选、搜索、智能合集、评分 | ✅ | 纯 JS + SQLite |
| 编辑：裁剪、文字、相框、拼图、切图、导出 | ✅ | canvas + sharp（sharp 有 Windows 预编译包） |
| AI 重绘、AI 标注、AI 手写字（BYOK） | ✅ | 直接 HTTP 调用 |
| MCP server | ✅ | 监听 `127.0.0.1` 的 TCP 端口，没有 POSIX 专属代码 |
| 缩略图、预览、主色 | ❌ 现在完全不可用 | 全部依赖 `sips` / `qlmanage`，见 2.1 |
| HEIC 显示 | ❌ | 主进程同样用 `sips` 转码（`electron/media/protocol.js:27`） |
| 深度感知文字 | ❌ | CoreML（`native/compute-depth.swift`，0.5.6 起打包时预编译） |
| 贴纸主体抠图 | ❌（贴纸库本身能用） | Vision（`native/extract-sticker.swift`） |
| 人物识别 | ❌ | Vision + CoreML 版 ArcFace（`native/people-worker.swift`） |
| 视频封面、预览条、HEVC 播放代理 | ❌ | AVFoundation（`native/video-tool.swift`） |
| 用外部编辑器打开 | ❌ | 只扫描 `/Applications`（`electron/ipc/editors.js:49`） |

浏览器版（官网 `try/web.html`）现在就能在 Windows 上用，相框、拼图、裁剪、AI 都可以。它的能力开关在 `src/api/browser/bridge.js:768-783`。

## 2. 阻断项：不修就无法使用

### 2.1 预览全靠 macOS 自带的命令行工具

`services/sidecar/src/media_workspace/preview_service.py:257-292` 的 `_render_with_sips` 调用 `sips`，失败时退到 `qlmanage`，没有其他兜底。普通图片（:133）、RAW（:118-131）、视频（:111 的兜底）全都走这里。

在 Windows 上会连锁出问题：
- 每张图都会被标记成 `status='failed'`（:225-236）；
- 主色是从预览图提取的，所以主色也没有（:218-219）；
- RAW 的 AI 标注会退回读原文件，而 Pillow 读不了 RAW（`annotation.py:501-515`）；
- RAW 尺寸用 `sips` 读（`reverse_lookup.py:451-472`），在 Windows 上会返回预览图的尺寸，而不是传感器尺寸。

**真机已确认**（第 10 节）：Python 测试日志里有多处 `preview generation failed: [WinError 2] The system cannot find the file specified`，就是找不到 `sips`。

### 2.2 sidecar 的 stdio 编码

Electron 启动 sidecar 时没有设置 `PYTHONUTF8` 或 `PYTHONIOENCODING`（`electron/sidecar/transport.js:299,318`），sidecar 也没有调用 `reconfigure`。它用 `for line in sys.stdin` 读请求（`cli.py:151`），用 `json.dumps(..., ensure_ascii=False)` 写响应（`cli.py:175`）。

Windows 下的管道默认使用系统的 ANSI 代码页：中文系统是 GBK，西文系统是 cp1252。结果：
- 中文路径、中文标签、中文地名、中文描述会乱码；
- 遇到无法编码的字符（cp1252 遇到任何中文，GBK 遇到 emoji）会抛 `UnicodeEncodeError`，直接中断常驻进程；
- 波及的不只是文件路径，所有中文内容都会受影响。**这一项对国内用户是第一优先级。**

### 2.3 窗口外壳按 macOS 写死

`electron/appShell.js:47-55` 设置了 `titleBarStyle: "hiddenInset"`、`trafficLightPosition` 和 `transparent: true`。

- Windows 上会没有最小化、最大化、关闭按钮，也没有系统阴影；透明窗口在 Windows 上还有缩放和贴靠的已知限制。
- 前端把自己裁成 26px 圆角（`src/index.css:412-414`），并给红绿灯预留了位置（`:403`、`:448`）。
- 菜单栏大概率不显示，有 5 个只在菜单里出现的操作会没有入口（`appShell.js:139,157,160-163`）：临时 catalog、添加 RAW 源、运行补全、生成预览、校验文件。
- 有几个菜单 role 只在 macOS 上有意义：services、hide、hideOthers、unhide、zoom、front（`appShell.js:141-145,210-212`）。
- 液态玻璃效果是纯 CSS 的 `backdrop-filter`，没用 `vibrancy`，这部分可以直接用。

### 2.4 sidecar 无法打包

- `build:sidecar` 需要 `services/sidecar/media-workspace.spec`，但这个文件被 `.gitignore:53` 忽略了，仓库里没有。**Mac 发版目前也依赖这个只在本地存在的文件。**
- PyInstaller 不能交叉编译，Windows 版必须在 Windows 机器上构建。
- sharp 同理：在 Mac 上执行 `npm ci` 不会装 `@img/sharp-win32-x64`，而 `electron/main.js:21` 启动时就会加载 sharp。lockfile 里有 win32 的条目（`package-lock.json:2102`），所以在 Windows 上 `npm ci` 没问题。
- 打包后的 sidecar 路径没有 `.exe` 后缀（`transport.js:273`）。spawn 大概率仍能找到，但 `existsSync` 的日志会显示 false。
- 新写的 spec 要把 `data/*.json.gz` 打包进去（`geo_resolver.py`、`country_shapes.py` 会用到），还要带上 pillow_heif。

### 2.5 开发环境跑不起来

- `predev` 会执行 `bash scripts/build-native.sh`，里面用到 `xcrun swiftc`；`pack` 和 `dist` 也会调用它。`dist:win` 已经正确地跳过了这一步。
- 开发模式下 Python 写死为 `python3`（`transport.js:316`），而 Windows 上通常没有这个命令，或者只是 Microsoft Store 的占位程序。**真机已确认**：装好 Python 3.12 之后，`python3` 解析到的仍是 `WindowsApps\python3.exe`（商店占位程序），`tests/test_serve.py` 因此失败。真正的 Python 是 `python` 和 `py`。
- 根目录的 `npm test` 用的是 Unix shell 写法（`PYTHONPATH=services/sidecar/src python3 -m unittest …`，见根目录 `package.json`），在 Windows 的 cmd 和 PowerShell 里都跑不了。第 9 节列出了在 Windows 上分开运行各组测试的命令。
- 在 Windows 上 `npm ci` 之后，`node_modules/electron/dist` 不存在。手动运行一次 `node node_modules/electron/install.js` 就好了（6 秒），原因待查。

### 2.6 前端没有按平台关掉功能

`api.can()` 只有在 bridge 明确声明 `false` 时才隐藏功能（`src/api/index.js:20`），而桌面端什么都没声明。
- 贴纸、人物、主色已经接入了 `can()`，只要桌面端上报能力就能生效。
- **深度**只检查了 `api.has("computeDepth")`，桌面端永远为真（`TextPanel.jsx:329,336`、`useSceneDepth.js:48`、`EditorOverlay.jsx:578`）。
- **视频**只在一处检查（`App.jsx:840`）。
- 被关掉时的提示文案是"请使用桌面版"（`i18n/locales/en/common.json:12`），放在桌面版里显然不对。
- 后端对深度、抠图、人物会抛出"requires macOS"（`ipc/stickers.js:101`、`ipc/depth.js:48`、`ipc/people.js:398,417`），视频则是静默失败（`ipc/video.js:16-18`、`video.py`）。

## 3. Windows 上的坑：修完阻断项后会陆续碰到

### 3.1 路径

- 前端有多处用 `split("/")` 取文件名：
  - "复制文件名"会复制成完整路径（`App.jsx:485`）；
  - 显示文件名的地方：`useWorkspace.js:931`、`LibrarySettings.jsx:47,52`（局部的 `baseName` 遮住了 `format.js:43` 里能处理反斜杠的那个）、`AiRepaintPanel.jsx:886,946`、`CollageOverlay.jsx:698`；
  - `escapePathLabel` 从来不会缩短 Windows 路径（`format.js:74-79`）。
- `normalizePath` 会把反斜杠换成 `/` 再交给 `startImport`，而 `registerRoots` 拿到的是原始 Windows 路径（`useWorkspace.js:863-893,946,961`），于是 `C:/x` 和 `C:\x` 会同时被存进库里。
- 区分大小写的路径比较（NTFS 不区分大小写），会导致误报 403、去重失效、删除记录匹配不上：
  - `electron/media/allowlist.js:25-32,82-85`；
  - `mcp/server.js:809-811`、`watcher.js:104`、`catalog.js:31`；
  - sidecar 的 SQL：`db/assets.py:356`、`reverse_lookup.py:55,340-352,395-397`。
- 带 `LIKE` 前缀的范围查询没有转义 `_` 和 `%`（`db/assets.py:482-484,505-506,550-552`）。
- `Path.resolve()` 会改变路径的写法，而路径又被哈希成资产 ID（`metadata.py:103-107`、`db/core.py:195-197`），这些变化都会让 ID 对不上：
  - 映射盘 `Z:\` 会变成 UNC 路径 `\\nas\share`；
  - `subst` 盘会变成它指向的目标；
  - 超长路径会带上 `\\?\` 前缀。
- 没有开启长路径支持时，超过 260 字符的文件会被静默跳过（`reverse_lookup.py:577-579`）。层级很深的中文目录最容易触发。
- `media://` 协议在 URL 和路径之间转换（`format.js:10` ↔ `protocol.js:46-48`），理论上 `C:\` 路径能正确往返，但盘符和 UNC 路径都没有测试。
- Mac 和 Windows 之间不能互相挪用 catalog：`relative_path` 用的是系统原生的分隔符，资产 ID 也哈希了绝对路径。

### 3.2 文件系统和进程

- 预览写入用 `os.replace`（`preview_service.py:59-66`）。如果目标文件被占用（另一个进程正在渲染同一张图、主色提取正在读、Defender 或索引服务正在扫描），就会报 WinError 5 或 32，失败处理还会把原本正常的数据库记录改成 `failed`。
- 删除资产时，预览文件删不掉的错误被忽略了（`db/maintenance.py:336-340`），被占用的文件会永久残留。
- 导入整张 SD 卡（比如 `E:\`）时会扫进 `$RECYCLE.BIN` 和 `System Volume Information`，已删除的照片会被导回来。目前只过滤了 macOS 的 `._` 文件（`file_types.py:27-28`）。
- 所有 spawn 都没设 `windowsHide`（`transport.js:105,237,325`），每个后台任务都会闪一下命令行窗口。sidecar 内部调用子进程时同样需要加 `CREATE_NO_WINDOW`。
- 取消任务时：
  - Windows 上没有进程组，取消只会杀掉任务进程本身，它启动的子进程会变成孤儿并继续占用文件（`transport.js:37-46`）；
  - 所以 PyInstaller 必须打成文件夹形式，单文件形式会多一层 bootloader 子进程，问题一样；
  - 写临时文件再改名的保存方式（`settingsStore.js:29`、`ipc/frameTemplates.js:94-96`）会因此报 EBUSY 或 EPERM。
- 没有单实例锁（`requestSingleInstanceLock`）。用户双击两次会启动两个进程，同时写同一个 SQLite，MCP 端口也会冲突。
- `open-file` 事件只在 macOS 上触发（`main.js:702`），Windows 的"打开方式"需要从 argv 和 `second-instance` 事件里拿文件。
- 文件选择框：Windows 不支持同时选文件和文件夹，"导入"会退化成只能选文件夹（`main.js:378`；同样的问题还在 `depth.js:112-116`、`people.js:400-407`）。
- 默认 catalog 放在"文档"目录（`main.js:404-418`），而 Windows 上这个目录经常被 OneDrive 同步，SQLite 放在同步目录里有风险。
- 浏览时，常驻进程会在单线程里逐行 stat（`cli.py:1509-1557`）。如果 NAS 断开，每次 stat 都要等到超时，界面就卡住了。
- 端口：Hyper-V 有时会保留端口段，绑定 41706 可能遇到 EACCES，而这个错误目前只会显示成一个笼统的 "error"（`mcp/server.js:1726`）。

### 3.3 界面与文案

- 弹层的标题栏把操作按钮和关闭按钮放在右上角，正好和 Windows 窗口按钮的位置重叠。
- 文案：
  - "Finder"/"访达"每种语言各出现 8 处（`app.json`、`stickerView.json`、`inspector.json`、`settings.json`、`editor.json`、`nav.json`）；
  - "this Mac" 出现在 `settings.json:158,186` 和 `nav.json:136`；
  - ⌘ 符号写死在 `nav.json:75` 和 `Gallery.jsx:270`。
- 快捷键不用改：16 处 `metaKey` 判断都同时接受 `ctrlKey`。
- 拖拽图标是按 macOS 的叠放方式预先调淡的（`ipc/nativeDrag.js:18-28,50`）。Windows 只画一张图，拖 68 个文件时图标只剩约 4% 的不透明度。

### 3.4 中文用户特有的问题

- 正文字体栈是 `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans SC", system-ui`（`src/index.css:102`），没有 `Microsoft YaHei`。
- Noto Sans SC 是从 Google Fonts 加载的（`index.html:15`），国内访问不了。这是有意为之的，`src/fonts.js:4` 的注释写明了中文不打包进应用。Mac 上有苹方兜底所以看不出问题，Windows 上会落到 `system-ui`。编辑器里的 "Noto Sans SC" 字体选项（`components/editor/textState.js:49`）和 3 个文字预设（同文件 `:96,113,148`）也依赖它，在 Windows 上会显示成别的字体。
- `index.html:2` 写死了 `lang="en"`，只有浏览器版会同步更新（`web-main.jsx:19`）。中文可能被按日文字形渲染。
- 第 2.2 节的编码问题。

### 3.5 打包与发布

- 没有 Windows 代码签名，SmartScreen 会拦截"已保护你的电脑"，对普通用户非常劝退。`scripts/release.sh` 只适用于 macOS。
- 没有自动更新：没用 `electron-updater`，也没有 `publish` 配置。Mac 版其实也缺这个。
- `extraResources` 会把整个 `native/` 打进 Windows 安装包，里面有 48MB 的 `.mlpackage` 和 `.swift` 源码，需要按平台过滤。
- 图标可以直接用：`build/icon.png` 是 1024×1024，electron-builder 会自动转成 `.ico`。
- nsis 没有指定架构，打出来的是构建机的架构。建议先只做 x64。pillow-heif 目前只有 `win_amd64` 的 wheel，ARM 版的 HEIC 会静默失败（`annotation.py:43-48` 吞掉了 ImportError）。
- `uv.lock` 里没有可选依赖（volcengine 和开发工具），需要重新生成。

### 3.6 测试与 CI

- 目前没有 Windows CI，只有 `ubuntu-latest` 和 `macos-15` 两个 job（`.github/workflows/quality.yml:13,38`，`e2e-nightly.yml:30`）。
- 61 个 e2e 里有 60 个依赖预置 catalog，而 `relocateFixturePaths`（`e2e/helpers/app.js:143-160`）用 `path.sep` 去匹配库里存的 POSIX 路径，在 Windows 上永远匹配不上。它和另外 7 个 spec 还会调用 `sqlite3` 命令行工具，Windows 默认没有这个工具。
- 约 6 个 spec 直接依赖 macOS 工具（04、07、43 会在非 macOS 上自动跳过；14、35、37 没有），另外约 17 个会导入图片，预览都要走 `sips`。
- 单测里写死了 POSIX 路径：`allowlist.test.js`（17 处）、`lightboxView.test.js`（9）、`format.test.js`（6）、`settingsTransfer.test.js`（5）、`catalog.test.js`（3）。
- 真机上的实际失败情况见第 10 节：前端单测和 sidecar 单测已经全部通过，问题集中在 Electron 主进程的少数测试和仓库根目录的 Python 集成测试。

## 4. 功能降级（Windows 首版先不做的功能）

深度、抠图、人物、视频这 4 个功能，在 Windows 首版里通过能力开关隐藏，并标注"仅 macOS"，不要让用户点了才报错。要把它们补回来，需要第 5.5 节的 Windows 引擎。

## 5. 架构方案：哪些共享，哪些分平台

### 5.1 兼容方案一定更复杂、更慢吗？

有两种做法：

- **两边统一用一套方案**（ONNX Runtime、ffmpeg、Pillow 全平台通用）。主要代价其实不是速度，因为 ONNX Runtime 在 Mac 上也能通过 CoreML 执行器用上 Neural Engine。真正的代价是：
  - Mac 安装包要额外带上模型和 ffmpeg，会变大；
  - 效果会变：Vision 的抠图和人脸检测是系统级能力，换成开源模型后效果不同；
  - 要把已经稳定的代码重写一遍。

  **不推荐。**
- **调用约定统一，各平台用各自的引擎。** Mac 保持现状，Windows 换成自己的引擎。代价是这几个模块要维护两份实现，只限于下面 5.2 的中间那一层。**推荐。**

也有统一之后反而更简单、而且不变慢的地方。下面是用一张 2400 万像素的图生成 512px 预览的实测耗时（本机单次测量，只看量级；`sips` 每张图都要启动一个进程）：

| 格式 | `sips`（现在用的） | Pillow | sharp（libvips） |
|---|---|---|---|
| JPEG | 96ms | 74–84ms | 70ms |
| HEIC | 309ms | 311ms（pillow-heif） | 不支持（预编译包不带 HEVC 解码） |

所以预览可以全平台统一用 Pillow 加 pillow-heif，Mac 上只把 **RAW** 留给苹果的引擎。RAW 换成 LibRaw（rawpy）后颜色会和现在不一样，是否接受需要单独决定，见第 7 节。

### 5.2 三层划分

| 层 | 内容 | 代码量 |
|---|---|---|
| **共享** | 全部 React 界面；编辑、相框、拼图、导出（canvas + sharp）；catalog、SQLite、搜索筛选；AI；MCP；sidecar 的业务逻辑 | 95% 以上 |
| **平台引擎**（调用约定统一，实现各一份） | RAW 解码、视频、深度、主体抠图、人脸 | Mac 端是现有的 1.3k 行 Swift；Windows 端要新写 |
| **平台外壳** | 窗口和标题栏、菜单、"访达"或"资源管理器"文案、外部编辑器的查找方式、打包签名和更新 | 很薄 |

### 5.3 目录结构建议

```
apps/desktop/electron/platform/
  index.js         按 process.platform 选择实现；全仓唯一允许判断平台的地方
  darwin.js        红绿灯窗口、macOS 菜单、/Applications 编辑器查找、Swift 工具路径
  win32.js         titleBarOverlay 标题栏、Windows 菜单、编辑器查找、Windows 引擎路径
  capabilities.js  启动时检测平台、系统版本和工具是否存在 → {depth, stickerExtract, people, video}
apps/desktop/native/
  contracts/       每个工具的命令行参数和 JSON 输出约定 + 契约测试用例
  darwin/          现有 4 个 .swift，全部预编译
services/sidecar/src/media_workspace/
  imaging.py       预览解码：默认 Pillow + pillow-heif（全平台）；Mac 上 RAW 交给 sips
  engines/         Windows 版引擎（实现同一套调用约定）：
                     video   → ffmpeg / ffprobe
                     depth   → ONNX Runtime
                     subject → ONNX Runtime
                     face    → ONNX Runtime
```

前端不需要按平台分目录。它只认能力（`api.can()`），文案按平台分 key，例如 `revealInFileManager` 在 Mac 上是"在访达中显示"，在 Windows 上是"在资源管理器中显示"。

### 5.4 控制复杂度的三条规则

1. **平台判断只能写在 `platform/` 目录里。**
   - 用 ESLint 的 `no-restricted-properties` 禁止在其他地方使用 `process.platform`，`platform/` 目录豁免；Python 那边同理（ruff 的 banned-api）。
   - 目前全仓只有 11 处平台判断，分布在 6 个文件里（main、appShell、stickers、people、depth、transport），收拢起来成本很小。
2. **原生能力以调用约定为边界。**
   - 现有工具已经是这种形态：`video-tool probe|poster|frames`、`people-worker --serve`（逐行收发 JSON）、`extract-sticker <in> <outdir>`（输出 `manifest.json`）、`compute-depth <src> <out> <model>`。
   - 调用方（`video.py`、`job_runner.py`、`ipc/*.js`）不需要知道背后是 Swift 还是 ONNX。
   - Windows 版按同样的参数和输出再实现一份，两份实现跑同一套契约测试：Mac CI 测 Swift 版，Windows CI 测 Windows 版。
3. **前端只问"能不能用"，不问"是什么系统"。**
   - 主进程启动时上报能力，前端用现成的 `api.can()`。这套机制浏览器版已经在用。
   - 再把深度、视频这两处漏掉的检查补上（2.6）。

### 5.5 Windows 引擎选型

| 能力 | Mac（现状） | Windows 候选 | 许可证注意 |
|---|---|---|---|
| HEIC | `sips` | pillow-heif | LGPL 动态库，可以接受 |
| RAW | `sips`（苹果 RAW 引擎） | rawpy（LibRaw），或先只读内嵌的 JPEG 预览 | 颜色和苹果引擎不一致 |
| 视频 | AVFoundation | ffmpeg / ffprobe（LGPL 构建），可用 D3D11VA 硬件解码 | 只能用 LGPL 构建，不能用 GPL 构建；安装包会增加几十 MB |
| 深度 | CoreML Depth Anything V2 Small | 同一个模型的 ONNX 版 + ONNX Runtime（DirectML 走显卡） | V2 **Small** 是 Apache-2.0，Base 和 Large 是非商用许可（需复核） |
| 主体抠图 | Vision `VNGenerateForegroundInstanceMaskRequest` | BiRefNet（MIT）或 U²-Net（Apache-2.0） | **避开 RMBG-1.4/2.0**（非商用）；效果和 Vision 会不同 |
| 人脸 | Vision 检测 + CoreML ArcFace R100 | YuNet（MIT）检测 + ONNX 版 ArcFace | InsightFace 官方预训练权重是**非商用研究**许可。Mac 现在用的 ArcFace 包是第三方转换的，标注为 Apache-2.0（`ipc/people.js:20-26`），**建议同时复核它的上游权重来源** |

**Windows 引擎放在哪里**：建议写在 Python sidecar 里，作为 sidecar 的子命令，实现和现有工具一样的调用约定。理由：
- 少引入一门语言；
- 和 sidecar 打进同一个 PyInstaller 包；
- 可以直接用 sidecar 现成的任务、进度、取消机制。

备选方案是单独写 Rust 或 C# 程序，性能更好，但要多维护一门语言和一条构建链。

## 6. 路线与估时

估时按一人全职计算。

### 阶段 0：现在就做，零开发量

- 社媒上统一把 Windows 用户引到浏览器版。
- 收集一份 Windows 候补名单，把需求量化出来，作为第 7 节第一个问题的依据。
- 小改动：浏览器版里"仅桌面版"的提示点进去是 Mac 下载页（`DesktopOnly.jsx`），对 Windows 用户的文案要调整。

### 阶段 1：Mac 也受益的准备工作（约 1.5–2 周，不需要 Windows 机器）

| 项 | 估时 | 对 Mac 的好处 |
|---|---|---|
| ~~深度和抠图改为预编译~~ 已随 0.5.6 发布（#114），见第 8 节 | — | 不再依赖 Xcode；深度每张新照片从约 16 秒降到约 0.2 秒 |
| PyInstaller spec 放进仓库 | 0.5 天 | 发版不再依赖本地文件 |
| 预览改走 Pillow，Mac 上 RAW 保留 `sips` | 3–4 天 | 不变慢；Linux CI 也能测预览 |
| sidecar 的 stdio 强制 UTF-8（环境变量 `PYTHONUTF8=1` 加上 `reconfigure`） | 0.5 天 | 消除隐患 |
| 平台判断收拢到 `electron/platform/` + 能力上报 + 补齐深度/视频的检查 + lint 规则 | 2–3 天 | 结构更清晰 |

### 阶段 2：Windows 核心版公测（约 2–3 周，在第 9 节的 Windows 开发机上做）

| 项 | 估时 |
|---|---|
| 窗口外壳：`titleBarOverlay`、不透明窗口（Win11 可以用 `backgroundMaterial: "mica"`）、菜单操作的入口、右上角避让 | 3–4 天 |
| 打包和进程：Windows 版 sidecar 构建、`extraResources` 按平台过滤、`windowsHide`、单实例锁、文件选择框 | 2–3 天 |
| 路径和文件系统：3.1、3.2 中对用户影响最大的那些 | 3–4 天 |
| 中文字体：`Microsoft YaHei` 兜底，Noto Sans SC 改为本地子集 | 0.5–1 天 |
| Windows CI：e2e 路径重定位改写、去掉对 `sqlite3` 命令行的依赖、单测里的路径 | 2–3 天 |
| 签名和安装包 | 1–2 天，另加证书申请周期 |

### 阶段 3：补回苹果专属功能（每个约 1–2 周）

视频（ffmpeg）约 1 周 → 深度约 1 周 → 抠图约 1–1.5 周 → 人脸约 2 周。顺序可以按候补名单里用户最想要的功能来调整。

**前置条件**：Windows 开发机已经就绪（第 9 节）。还需要代码签名证书和 GitHub Actions 的 Windows runner；公测前还要在一台家用 Windows 11 上做一次验收（见第 9 节"系统版本"）。

## 7. 待决问题

1. ~~**做不做、什么时候做**~~：已决定做（2026-10-03），开发机见第 9 节。候补名单仍然有用，可以用来排阶段 3 的顺序。
2. **架构**：只做 x64 吗？（建议先只做 x64。）最低支持哪个 Windows 版本？（建议 Win10 22H2 及以上，Mica 效果只在 Win11 上有。）
3. **代码签名**：选 OV 证书，还是 Azure Trusted Signing？后者对个人开发者开放的地区有限，需要确认。签名之后 SmartScreen 的信誉也需要时间积累。
4. **自动更新**：要不要同时给 Mac 加上 `electron-updater`？
5. **RAW 一致性**：Windows 上的 RAW 预览颜色和 Mac 不同，能不能接受？还是首版只显示内嵌的 JPEG 预览？
6. **安装包体积**：ffmpeg 和 ONNX 模型加起来可能让 Windows 安装包比 Mac 大不少，体积上限定多少？
7. **视觉**：Windows 上保留多少液态玻璃效果？透明窗口在 Windows 上有限制，建议改用不透明窗口加 Mica。

## 8. 附：审计中顺带发现的 Mac 问题

- **正式版导出编辑后的图会丢 EXIF**：相框、文字、拼图、切图导出时用 `python3 -c` 读取原图元数据，但正式包里没有 sidecar 源码。已修复（#113，改为通过常驻 sidecar 的 `read-image-metadata` 读取），随 0.5.6 发布。
- **深度感知文字和贴纸抠图在正式版里依赖 Xcode**：这两个功能以前在运行时用 `swift` 解释 `.swift` 源文件（`ipc/swiftRuntime.js`）。0.5.6（#114）改为打包时预编译，`swiftRuntime.js` 已删除。实测解释执行只比预编译慢约 0.5 秒，所以这一项修的是"没装开发工具就用不了"，速度不是重点。
- **深度推理每张新照片要约 16 秒**：`compute-depth` 每次运行都把模型编译到新的临时目录，而 Core ML 对 Neural Engine 的编译缓存是按模型位置来的，所以缓存从来用不上。0.5.6 把编译结果固定存到 `userData/depth-models`，之后每张照片约 0.22 秒，输出和之前逐字节相同。`people-worker` 也是每次任务编译一遍模型，但每个任务只编译一次，影响小，尚未处理。
- **0.5.5 的 `video-tool` 和 `people-worker` 要求 macOS 26**：`swiftc` 没有指定最低版本，默认按构建机的系统版本编译，所以视频和人物识别在 macOS 26 以下大概率启动不了。0.5.6 给每个程序指定了它能支持的最低版本：`video-tool` 13，`people-worker` 12，`compute-depth` 12，`extract-sticker` 14。Windows 版的原生引擎同样要注意这个问题。
- **PyInstaller spec 不在仓库里**：见 2.4。
- **现有 e2e 失败**：`25-collage-batch` 里"把格子拖到另一页交换两张图"那条，在 `main` 上也会失败（2026-10-02）。

## 9. Windows 开发机

### 9.1 选型（2026-10-03）

| 方案 | 结论 | 原因 |
|---|---|---|
| Mac 上的本地虚拟机（Windows 11 ARM） | 不用 | Mac 磁盘只剩约 39GB；ARM 版要靠模拟运行 x64 程序；准备工作多 |
| Shadow（云游戏电脑） | 不用 | 官方《Rules and Restrictions》禁止把它当服务器用、禁止绕过自动关机、禁止安装虚拟化软件；而且关掉画面或长时间没有操作就会自动关机，不适合通过 SSH 远程开发。以后测显卡和 DirectML 时可以租一个月，人坐在画面前用 |
| Windows 365 Business | 备选 | 真正的 Windows 11，一直开着；但默认不是管理员，没有公网入站（要配 Tailscale），也没有显卡 |
| Vultr、AWS Lightsail | 不用 | Windows 授权费贵（Vultr 4 核 / 8GB 要 $40 再加 $64 授权费） |
| Azure、AWS EC2 | 不用 | 按小时计费便宜，但网络、授权、开关机都要自己配 |
| **Kamatera** | **选用** | 按小时或按月计费；Windows 授权含在价格里（计算器上写明 "Includes cost of licenses"）；本身是服务器产品，开 SSH 是正常用法；有公网 IP；美西有机房；有 30 天免费试用 |

### 9.2 当前这台

- Kamatera 圣克拉拉机房，4 vCPU（Type A）/ 8GB / 100GB NVMe，按月计费（计算器报价约 $54/月，以账单为准）。
- 系统是 **Windows Server 2025 Standard**（内部版本 26100，和 Windows 11 24H2 同一个内核），系统区域 en-US（代码页 1252）。创建时系统选成了 Server 2025。这对开发和第 2、3 节的问题没有影响；SmartScreen、安装体验这类家用版才有的行为，要在公测前另找一台 Windows 11 验收。要复现 GBK 编码问题，把系统区域改成中文（需要重启）。
- IP 和账号不写进仓库。

### 9.3 怎么配置

在一台新机器上，用管理员 PowerShell 运行 `scripts/windows/setup-dev.ps1`（文件开头写了一行命令的用法）。它会：
- 用 winget 装 Git、Node 22、Python 3.12 和 uv；
- 开启长路径支持，git 保持 LF 换行；
- 开启 OpenSSH，只允许密钥登录，授权 `github.com/<用户名>.keys` 上公开的公钥；
- 把 SSH 和远程桌面限制为只允许运行脚本时远程桌面所用的 IP；
- 把仓库克隆到 `C:\dev\AfterFrame`。

踩过的坑：Windows 10/11 安装 OpenSSH 时自动建的防火墙规则只覆盖"专用网络"，而云服务器的网卡是"公用网络"，所以 sshd 在监听、规则也放行了，外面还是连不上。脚本已经把这条规则改成对所有网络生效（`-Profile Any`）。

### 9.4 工作方式

- 代码只在 Mac 上修改、从 Mac 推送。开发机上不放 GitHub 凭据（从公开仓库用 HTTPS 克隆），只能拉不能推。
- 在开发机上验证一个分支（Python 环境第一次要先运行 `uv venv C:\dev\venv --python 3.12`）：

```powershell
cd C:\dev\AfterFrame; git fetch; git switch <branch>; git pull
cd apps\desktop; npm ci; node node_modules\electron\install.js
npm run lint; npm run build; npm run test:renderer; npm run test:electron
cd C:\dev\AfterFrame
uv pip install --python C:\dev\venv\Scripts\python.exe -e "services/sidecar[dev]"
$env:PYTHONPATH = "services\sidecar\src"
C:\dev\venv\Scripts\python.exe -m unittest discover -s services\sidecar\tests
C:\dev\venv\Scripts\python.exe -m unittest discover -s tests
```

## 10. 真机基线（2026-10-03）

在第 9 节的开发机上，对 main 的 `606d261`（0.5.6）跑了现有的检查，没有改任何代码：

| 项目 | 结果 |
|---|---|
| ESLint | ✅ 通过 |
| 前端构建（Vite） | ✅ 通过（33 秒） |
| 前端单测（vitest） | ✅ 230/230 |
| sidecar 单测（`services/sidecar/tests`） | ✅ 59/59 |
| Electron 主进程单测 | ❌ 115 个里 4 个失败 |
| 仓库根目录的 Python 测试（`tests/`） | ❌ 177 个里 34 个（2 个失败、32 个报错） |

Electron 的 4 个：
- `catalog.test.js` 两个：断言里写的是 `/repo/data/...`，Windows 上 `path.resolve` 得到的是 `C:\repo\data\...`。测试本身的问题。
- `media/allowlist.test.js` 的"通过符号链接的写法也能访问 catalog 目录"：要查，可能和 3.1 的路径比较有关。
- `sidecar/transport.test.js` 的"重置要等后台任务真正退出"：Windows 上没有 Unix 信号和进程组（3.2）。真问题。

Python 的 34 个：
- **32 个报错**，全部卡在测试结束时 `TemporaryDirectory` 删不掉临时目录（`PermissionError: [WinError 32]`）：SQLite 数据库还开着，而 Windows 不允许删除正在被占用的文件。涉及 11 个测试文件，主要是测试没有关闭连接；产品代码里同类的"文件还开着就删除或改名"见 3.2。
  - 其中 `test_people_job` 的 3 个，在这之前还先碰到了 `OSError: [WinError 193] %1 is not a valid Win32 application`：测试直接执行模拟的人脸识别辅助脚本，Windows 不能这样运行脚本文件。也是测试本身的问题。
- **2 个失败**，都是 `test_serve`：用 `python3` 启动 sidecar，碰上商店占位程序（2.5），读不到启动信号。真问题。
- 另外，测试过程中日志里有 5 处 `preview generation failed`，原因是找不到 `sips`（2.1）。真问题。

结论：前端和 sidecar 的核心逻辑在 Windows 上已经能跑，失败都集中在第 2、3 节预判过的地方。

## 11. 分支与协作方式

不开长期的 Windows 大分支。每项工作单独开一个短分支，几天内合回 main：
- **命名**：`win/<主题>`，比如 `win/utf8-stdio`、`win/preview-pillow`、`win/window-chrome`。
- **为什么不开大分支**：main 上每天都有更新，两边又都会改 `main.js`、`appShell.js`、`transport.js`，长期分支的冲突会越积越多。而且很多 Windows 修复对 Mac 也有好处（编码、路径、预览），应该早点进 main。
- **不影响 Mac 发版**：
  - 每个 `win/*` PR 都要通过现有的 Mac CI 和 e2e，并在开发机上跑过相关测试；
  - 只在 Windows 上生效的代码放进 `platform/win32.js` 这类模块（5.4），Mac 的代码路径不变；
  - 阶段 2 完成前不发布 Windows 安装包，用户感知不到变化。
- **Windows CI**：先加成"失败不阻塞合并"的提醒；等第 10 节的失败都修完，再改成必须通过，防止日常改动又把 Windows 弄坏。
- **顺序**：按第 6 节阶段 1、阶段 2 的列表，一项一个 PR。
