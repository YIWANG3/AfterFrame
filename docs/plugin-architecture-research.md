# AfterFrame 插件化：调研与计划

> **状态（2026-11-01）**：方向已定（第 0 节），代码梳理完成（第 1、5 节，基于 main fa2e8b38 / #249），未动代码。
> 实施计划在 [feature-modules-plan.md](feature-modules-plan.md)（四个准备 PR + PR 1 到 PR 3）。第 8 节是还没拍板的事。
>
> 2026-10-31 的调研稿是本文的前身：三种"插件化"的含义、同类软件对照保留在第 2、3 节。

## 0. 定下的方向

**App 本体做资源管理，编辑功能是插件，我们自己的编辑功能也迁成插件。** 这和 Eagle 的格局一致，也和"AfterFrame 只做选片、不做发布"是同一条线。

落到机制上：

1. **一份清单，两个信任等级。** 每个功能一个 `manifest.mjs`，声明类型、能力名、平台、贡献点。随包的第一方功能是**特权**等级（可以用 Swift helper、sharp、Node）；第三方是**沙箱**等级。VS Code 和 Eagle 都这样分，诚实地分级比假装同一条路好。
2. **公开 API 第一版只做处理器型工具。** 拿像素进去、吐像素或参数出来、右侧一个面板。LUT、AI 重绘、深度、抠图、滤镜都是这种，也是第三方真正会写的那种。画布交互型（裁剪、切图、文字、相框、贴纸摆放）第一版不公开。
3. **契约用编辑配方，不用内部状态。** `mcp-parity-plan.md` 第 3 节的 Edit Recipe 是 agent 和 UI 的共同语言，插件产出的也是它。UI、agent、插件三个客户端共用一份 schema。
4. **用两个第一方工具逼真这套 API。** LUT 和 AI 重绘按"零特权调用"的标准迁到公开 API 上；迁不过去的地方就是 API 缺的东西。
5. **文字工具留在本体。** 它是编辑器本身的一部分（图层栈、字体、深度、手写、吸附全缠在一起），强行走插件 API 只会让 API 膨胀或让它满身特权调用。
6. **默认安装不能是空编辑器。** 本体加随包插件，装完和今天一模一样，只是设置里多一页。
7. **不做进程内、能 `require` Node 的第三方插件。** 安全之外还有一条：Mac 包开着 hardened runtime 并公证，插件带原生代码进来会撞签名。

顺序：先内部模块化（第一方功能迁成 feature module，这是一切的前提），再抽处理器契约、开公开 API，再看画布原语。

## 1. 现状（2026-11-01，#249）

### 1.1 规模

| 层 | 行数 | 备注 |
|---|---|---|
| 渲染层 `src/` | 49.2k | |
| 主进程 `electron/` | 15.0k | `main.js` 594 行，只剩装配；24 个 `ipc/*.js` |
| 共享 `shared/` | 1.3k | 7 张表，见 1.2 |
| sidecar | 18.9k | `cli.py` 1954 行 |
| Swift / ObjC | 1.7k | 4 个 helper + 视频播放器 |
| e2e | 15.3k / 84 个 spec | 编号唯一（#226） |

还大的文件：`App.jsx` 1640、`EditorOverlay.jsx` 1383、`useWorkspace.js` 991。`TextPanel.jsx` 已拆到 697 行加 `editor/text/` 目录，`mcp/server.js` 331 行只剩传输层。10 月中那轮结构整理（#217、#225、#229）把调研稿里抱怨的几个 god file 已经削掉大半。

### 1.2 这个仓库的房风：表驱动，测试守约

插件清单不是外来物，它是第八张表：

| 表 | 位置 | 守约的测试 |
|---|---|---|
| IPC 方法 | `shared/ipcChannels.mjs`，183 行 `[method, channel, arity]`，preload 和 facade 都从它生成 | `ipcChannels.test.js`（一 channel 一 handler）、`apiSurface.test.js`（facade / preload / web bridge 对齐） |
| 能力 | `shared/capabilities.mjs` 14 个 flag；`electron/capabilities.js` 按 helper 是否存在推 Mac 12 构建的值，Windows 一张手写表，web 在 `browser/bridge.js:40` | `capabilities.test.js`（被检查的都在表里，表里的都被检查） |
| 格式 | `formats.py` 是唯一来源，生成到 `shared/formats.generated.mjs`（#242） | `formats.test.mjs` |
| 快捷键 | `shared/shortcuts.mjs` 的 `SHORTCUT_ACTIONS` | `shortcuts.test.js` |
| MCP tool | `electron/mcp/tools/*.js`，8 个文件各导出 `(ctx) => tools[]`，`index.js` 的 `GROUPS` 拼起来并查重名，共 37 个 | `toolSchemas.test.js` 按文本扫 |
| Settings tab | `SettingsOverlay.jsx` 的 `TABS`，9 行带 `cap:` | — |
| 编辑器工具 | **没有表**，见 1.3 | — |

MCP 那个 `GROUPS` 数组尤其值得注意：一个 feature 的 `mcpTools` 贡献就是往里加一个 `(ctx) => tools[]`，形状不用改。

### 1.3 编辑器：五件套齐全，接线写死

每个工具都是同一套：`editor/state/use<X>Tool.js` + `<X>Panel.jsx` + 画布覆盖层 + `editor/render/*` 纯函数 + e2e。但接线全在 `EditorOverlay.jsx`：

| 工具 | `tool ===` 分支数 | 缠在哪 |
|---|---|---|
| split | 14 | 指针事件、光标、缩放原点、保存快捷键、导出 |
| lut | 4 | RAW 中性渲染、预览变换、`lutBase` / `lutShown` 推导（45 处提及） |
| frame | 3 | 图层锁定 |
| crop | 2 | |
| sticker | 2 | |
| ai | 1 | 面板常驻挂载（隐藏时也在，为了提前加载） |

ToolRail 手写 7 个按钮，其中 3 个按 `api.can()` 门控。`editorStateModel.js` 的 `BASE_STATE` 里，crop / split / lut 各占一个槽位进历史栈。

### 1.4 已经是"插件"的东西

- **原生引擎**按命令行约定隔离（`video-tool`、`people-worker --serve`、`extract-sticker`、`compute-depth`），windows-support-plan §5.4 已把"以调用约定为边界"定成规则。
- **能力按 helper 是否存在推出**：Mac 12 构建剔掉 helper，功能就锁了。语义上这就是"可能缺席的插件"。
- **LUT 库**是内容包的样板：`userData/afterframe/luts/` 复制进来，用户文件夹原地读，索引按 size + mtime 缓存，窗口回前台重扫。
- **懒加载**有先例：`MapDrawer.jsx` 用 `lazy()` 拆出地图。

## 2. 同类软件（摘自 2026-10-31 调研）

| 产品 | 插件跑在哪 | 隔离 | 对我们的启发 |
|---|---|---|---|
| Eagle | 进程内 WebView；Window / Background Service / Format Extension / Inspector 四种 | 无（`os` 模块类 Node） | 四种类型划分准；本地 HTTP API 和官方 MCP 插件并存 |
| Obsidian | 进程内 `main.js`，`require('obsidian')` | 无 | 生态靠"信任作者"，论坛自己承认沙箱做不了 |
| Figma | 主线程 QuickJS 沙箱 + iframe UI，`postMessage` | 严格 | 进程内但安全的标准答案，代价是 API 面全靠自己造 |
| VS Code | Extension Host 进程，`package.json` 声明 contribution points | 进程级 | **声明式清单**是要抄的 |
| Lightroom / darktable | 进程内 Lua | 受限 | 摄影软件里插件最成功的是导出目的地和发布，不是编辑工具 |
| Raycast | 独立 Node 进程 | 进程级 | 商店做进 App |

两条共识：进程内加完整 Node 权限等于信任作者；第三方真正写得动的是处理器型和导出型。

## 3. 本体和插件的边界

**本体（宿主）**：catalog、导入、预览、格式注册表、搜索筛选、图库、Lightbox、任务系统、设置存储、IPC 表、MCP 骨架、人物、地点、合集、文件夹页。

**编辑器核心（也是宿主的一部分）**：画布、视口、历史栈、图层模型（文字层、图片层、叠加层、相框层）、裁剪几何、保存和烘焙、`processAndSave` 入版本族。**文字工具**和**图片层**（贴纸作为图层摆放）属于这里。

**第一方特权 feature module**（第一批）：LUT、AI 重绘、贴纸提取（含贴纸库视图）、深度、切图、相框。

**公开给第三方的**（处理器型 API 第一版）：LUT 和 AI 重绘能走的那部分契约。

**内容包**：LUT 包、logo 包、手写预设、拼图模板、相框模板、相机名规则、模型。

## 4. 插件方式

### 4.1 清单

```
apps/desktop/features/<id>/
  manifest.mjs    # id、capability、platforms、web、trust: "bundled"
                  # contributes: { editorTool, settingsTab | settingsGroup,
                  #   sidebarView, contextMenu, filterFacets, shortcuts,
                  #   mcpTools, jobTypes, ipc }
  electron/       # 今天的 ipc/<x>.js 和它的库搬进来；register({deps}) 不变
  renderer/       # 面板、覆盖层、state hook，默认 lazy import
```

e2e **不搬**：spec 编号唯一、Playwright 的 `testDir` 是 `e2e/`，搬了只会多一处配置。

宿主三件事：主进程遍历清单，按 `platforms` + helper 是否存在推 capabilities（替掉 `capabilities.js` 的手写表），依次 `register`，`mcpTools` 并进 `GROUPS`，`ipc` 行并进 `IPC_METHODS`；渲染层从 contributions 生成 ToolRail、Settings tab、侧栏项、右键菜单追加项、facet；三个守约测试改成遍历清单。

### 4.2 处理器型工具的契约

LUT 和 AI 重绘已经暴露出处理器有**两种模式**，契约必须同时覆盖：

| | LUT | AI 重绘 |
|---|---|---|
| 结果形态 | 历史栈里的一个状态槽 `{id, name, strength}`，保存时最后套用 | 一个 job → 新版本入版本族 |
| 实时预览 | Web Worker 里算，强度混合，按住看原图 | 无（异步） |
| 面板和宿主的接口 | `tool`、`lut`、`base`、undo / redo | `sourcePath`、`outputBasePath`、compare 状态、`onRepaintComplete`、入文件夹 |
| 对宿主服务的依赖 | RAW 中性渲染（`useNeutralRawRender`）、预览变换 | 任务系统、供应商凭据、参考图选择对话框 |

所以公开 API 至少要有：`preview`（实时、带强度、可对比）和 `produce`（异步 job，产物入版本族）两条路；一个可进历史栈的参数槽；`/assets/{id}` 再加 `original`；主题变量、locale、参数记忆。

### 4.3 运行位置

- 特权等级：今天的形态，不变。
- 沙箱等级：UI 在 `sandbox` iframe，`postMessage` 调宿主；计算在 iframe 里的 Web Worker，或按平台声明一个可执行文件，走和 helper 一样的命令行约定，由主进程 `spawnSafely` 起。
- 画布原语（第二版）：受约束的可拖矩形、几个控制点、一条路径，宿主负责画和拖，插件只收坐标。裁剪、切图、贴纸区域今天用的都是矩形，原语不是凭空设计。插件自己往画布画像素永远不开放。

### 4.4 内容包与 agent 技能

内容包照 LUT 库抄：`userData/afterframe/<kind>/`，可选 `pack.json`（名字、作者、版本、许可证），索引缓存，Settings 一页"资源包"。先做拼图模板 JSON 化、手写预设、品牌 logo 包。

`skills/` 目录发布 agent 工作流（提示词 + MCP tool 组合），零代码，随时可以开始。

## 5. 三个迁移对象的代码地图

### 5.1 LUT（PR 1）

22 个文件提及，边界干净：

| 层 | 文件 | 备注 |
|---|---|---|
| 主进程 | `electron/lutLibrary.js`（+ test）、`electron/ipc/luts.js` | 11 个 channel：`app:luts`、`read-lut`、`import-luts`、`add/remove-lut-folder`、`set-lut-favorite`、`set-lut-log-mark`、`note-lut-used`、`reveal-lut`、`trash-lut`、`clear-lut-library`。register 依赖：`app, ipcMain, dialog, shell, readAppSettings, updateAppSettings, getMainWindow` |
| 共享 | `shared/cubeLut.mjs`、`shared/lutLogGuess.mjs` | 两进程共用的纯函数，**留在 shared**，不进 feature |
| 渲染层 | `editor/LutPanel.jsx`、`editor/state/useLutTool.js`、`editor/lut/{lutKernel,lutPool,lutWorker}.js`、`settings/LutLibraryGroup.jsx` | 全部搬进 `features/lut/renderer/` |
| 宿主里的钩子 | `editorStateModel.js` 的 `lut` 槽和 `lutEquals`、`EditorOverlay.jsx` 45 处、`render/saveImage.js` 3 处、`useSplitExport.js` 4 处、`editorTestApi.js` 的 `getLutState`、`ToolRail.jsx` | **这些是契约**：状态槽进历史、保存时套用、切图导出时套用、测试后门读状态 |
| 其它 | `ipc/appSettings.js` 的 `luts` 路径、i18n `editor.lut` + `settings.lutLibrary`、`e2e/67-lut.spec.js`、能力名 `lut` | |

关键观察：LUT 不是"面板 + 处理"就完了，它的状态**进历史栈**、在**保存管线**和**切图导出**里被套用。所以处理器契约里必须有"参数槽 + 保存时套用"这一条，而不是只有像素进出。

### 5.2 AI 重绘（PR 2）

| 层 | 文件 | 备注 |
|---|---|---|
| 渲染层 | `editor/AiRepaintPanel.jsx`（88 处）、`settings/RepaintSettings.jsx`、`ai/providers.jsx`（`PROVIDER_TYPES`，5 家） | 面板只调 12 个 api 方法：供应商凭据 / 偏好 / 风格 / 模型、`startAiRepaint`、状态、历史、`pickRepaintRefs` |
| 主进程 | `ipc/ai.js`（17 个 channel，含 text-image）、`tasks.js` 的 `startAiRepaintTask`、`ipc/dialogs.js`（参考图）、`settingsTransfer.js`（凭据导出）、`mcp/tools/assets.js` 的 `repaint_asset` | register 依赖 13 个 |
| sidecar | `ai_repaint.py`（供应商 if 链）、`job_runner.py`、`cli.py`、`db/*` | 不拆，按命令是否存在上报能力 |
| web | `api/browser/ai.js`、`llm.js` | web 版在浏览器里直连 Gemini，是**同一个功能的第二份实现** |
| 其它 | e2e 03、80；能力 `aiRepaint`、`aiRepaintMultiProvider` | |

关键观察：面板和宿主的接口最窄（传路径、收完成回调），结果是 job → 新版本，面板常驻挂载。它是"produce 模式"的样板。顺手把渲染层和 sidecar 各一份的供应商表收成一个 registry。

### 5.3 贴纸（PR 3）

80 个文件提及"sticker"，但是**两件事**：

1. **贴纸提取工具和贴纸库**：`editor/StickerPanel.jsx`、`state/useStickerTool.js`、`useStickerRegion.js`、`components/StickerRegionOverlay.jsx`、`StickerView.jsx`（侧栏视图）、`hooks/useStickerViewKeys.js`、`ipc/stickers.js`（6 个 channel，`userData/stickers/` 加 `library.json`）、`native/extract-sticker.swift`、e2e 04、43。**这是 feature module。**
2. **贴纸作为图层**：`TextPanel`、`text/StickerLayerInspector.jsx`、`text/StickerPickerModal.jsx`、`render/drawLayers.js`、`frameRender.js`、`useStickerImageCache.js`、`layerStack.js`、`textState.js`。**这是编辑器核心的图片层类型，留在本体。**

贴纸 feature 贡献的是：一个编辑器工具、一个侧栏视图、一个图片层的来源（picker 的数据源）。这个划分决定了 feature 清单里要有"图层来源"这一类贡献。它三种贡献都碰到，迁完它清单的形状就定了。

## 6. 准备工作与 PR 1

逐 PR 的详细计划在 [feature-modules-plan.md](feature-modules-plan.md)：四个准备 PR（host 对象、`features/` 目录配置、ToolRail 读表、LUT 推导收进 hook，共约三天，全部零行为变化），然后 PR 1 LUT、PR 2 AI 重绘、PR 3 贴纸提取。迁完三个清单定形，再写示例插件验证公开 API。

贯穿全程：一个 feature 一个 PR，不叠 PR；每个 PR 行为保持，跑全量 e2e 不只跑 CI 子集；sidecar 不拆；Apple Photos、本地模型这类新功能直接按新形态写。

## 7. 风险

- **单人项目的过度抽象。** 清单字段只写第一个迁移用得到的，迁了三个再定形。
- **web 构建。** 清单带 `web`，browser bridge 的 capabilities 从清单推，`apiSurface.test.js` 继续守。AI 重绘的 web 实现是第二份代码，迁移时别弄断。
- **E2E 是安全网也是阻力。** 迁移 PR 跑全量，用 `e2e:coverage` 看哪些 spec 碰到了被搬的文件。
- **公开即承诺。** 第一版只公开处理器型，面窄。`toolSchemas.test.js` 之外再加"已发布 schema 只增不改"的快照测试。
- **许可证。** `pack.json` 带 license 字段，品牌 logo 的 `TRADEMARKS.md` 规矩延续。

## 8. 待拍板

1. 目录名 `features/` 和清单名 `manifest.mjs`。
2. ~~6.1 的三个准备 PR 是分开合还是并进 PR 1。~~ 已定：分开，见 feature-modules-plan.md §11。
3. 贴纸作为图层留在核心、提取工具进 feature，这个划分认不认。
4. 资源包的设置页独立还是并进 Library。

## 来源

- Eagle：[plugin types](https://developer.eagle.cool/plugin-api/get-started/plugin-types/service.md)、[manifest](https://developer.eagle.cool/plugin-api/tutorial/manifest.md)、[API 索引](https://developer.eagle.cool/plugin-api/api)、[Inspector](https://developer.eagle.cool/plugin-api/get-started/plugin-types/inspector)
- Obsidian：[提交插件](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[API 镜像](https://github.com/admariner/obsidian-api)、[插件安全讨论](https://forum.obsidian.md/t/security-of-the-plugins/7544?page=3)
- Electron：[electron/electron#32909](https://github.com/electron/electron/issues/32909)、[Verql utilityProcess 隔离](https://verql.pages.dev/plugins/security/)、[Cultiva iframe 沙箱](https://github.com/krwg/cultiva/wiki/Architecture)
- 仓库内：`docs/agent-native-mcp.md`、`docs/mcp-parity-plan.md` §3（Edit Recipe）、`docs/windows-support-plan.md` §5、`docs/format-support-plan.md` §4（注册表先例）、`docs/lut-plan.md`、`docs/local-models-plan.md`（模型分发）
