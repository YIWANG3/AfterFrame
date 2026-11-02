# 编辑功能迁成 feature module：实施计划

> **状态（2026-11-02）**：§11 四项已拍板；四个准备 PR 已合入 main（0a #252、0b #255、0c #253、0d #254）；PR 1（LUT）已合入（#257）；PR 2（AI 重绘）已合入（#258）；PR 3（贴纸）做完在 `feat/feature-module-sticker`（#259），落地形状见 §8 末尾。方向和代码地图见 [plugin-architecture-research.md](plugin-architecture-research.md)，本文只讲怎么做：六个 PR，每个零行为变化、可独立合入和回滚。基于 main fa2e8b38（#249）读代码得出，未运行。

## 0. 范围与规矩

**做什么**：把编辑功能迁成按清单装配的 feature module。本轮三个：LUT、AI 重绘、贴纸提取。迁完三个，清单定形，再谈公开 API。

**不做什么**：切图的指针处理（14 处最深的耦合，等它自己轮到）、`App.jsx` / `useWorkspace` 的整理、sidecar 拆分、web bridge、`TextPanel`。文字工具和"贴纸作为图层"留在编辑器核心。

**规矩**：

1. 一个 PR 一件事，从 main 开分支，不叠 PR。
2. 每个 PR 行为零变化。验收是现有测试，不是新功能。
3. 每个 PR 跑全量 e2e（`npm run e2e`），不只跑 CI 子集；用 `npm run e2e:coverage` 看被搬的文件有哪些 spec 碰到。
4. e2e spec 不搬：编号唯一（#226），`testDir` 是 `e2e/`。
5. 新功能（Apple Photos、本地模型）等 PR 1 合入后直接按新形态写。

## 1. 目标形态（PR 3 之后）

```
apps/desktop/
  features/
    manifests.mjs          # 静态数组：所有清单。纯数据 + 懒加载函数，两个进程都能 import
    index.js               # 渲染层注册表：按 id 给出 Panel（lazy）、useTool、SettingsGroup、testApi
    lut/
      manifest.mjs
      electron/            # lutLibrary.js(+test)、luts.js（register(host)）
      renderer/            # LutPanel.jsx、useLutTool.js、lut/{lutKernel,lutPool,lutWorker}.js、LutLibraryGroup.jsx
    repaint/
    sticker/
  electron/
    host.js                # createHost(...)：宿主服务包，24 个 ipc 模块和 features 的 register 都收它
    features.js            # loadFeatures()、capabilitiesFromFeatures()、registerFeatures(host)
  shared/
    ipcChannels.mjs        # CORE_IPC_METHODS + 各清单的 ipc 行 → IPC_METHODS（表的拼接点）
    cubeLut.mjs            # 两进程共用的纯函数留在 shared，不进 feature
```

### 1.1 清单（第一版只有 PR 1 用得到的字段）

```js
// features/lut/manifest.mjs — 纯数据。渲染层代码和主进程代码都不能从这里 import，
// 只能放懒加载函数，这样 shared/ipcChannels.mjs 才能安全地 import 它。
export default {
  id: "lut",
  capability: "lut",            // shared/capabilities.mjs 里的名字
  platforms: ["darwin"],        // 不在列表里的平台：capability 声明 false
  helper: null,                 // 需要的 native/bin 名，缺了就声明 false（贴纸是 "extract-sticker"）
  web: false,                   // 浏览器构建声明 false
  trust: "bundled",             // 随包的第一方；第三方以后是 "sandboxed"
  contributes: {
    editorTool: { key: "lut", labelKey: "overlay.tools.lut", hidden: true },  // hidden：不可用时隐藏；默认是锁住显示
    settingsGroup: { tab: "library" },
    ipc: [
      ["listLuts", "app:luts", 0],
      // …那 11 行，从 shared/ipcChannels.mjs 搬来
    ],
  },
  electron: "./electron/luts.js",                   // 主进程入口，相对清单文件的路径；没有这个字段的清单（沙箱插件）主进程跳过
  renderer: () => import("./renderer/index.js"),
};
```

字段只在有迁移对象用到时才加。`sidebarView`、`mcpTools`、`layerSource`、`jobTypes` 到 PR 2、PR 3 再加。

### 1.2 清单怎么被两个进程读

- **主进程**：`electron/features.js` `require("../features/manifests.mjs")`（`.mjs` 的 require 已有先例：`lutLibrary.js` require `shared/cubeLut.mjs`）。主进程对每个清单 `require(path.resolve(featureDir, manifest.electron))`；清单没有 `electron` 字段就跳过（将来的沙箱插件只有渲染层）。入口路径写在清单里，不另立 `index.js` 之类的文件名约定。
- **渲染层**：`features/index.js` 静态 import 各 feature 的 `renderer/index.js`，内部用 `lazy()` 拆 chunk（先例：`MapDrawer.jsx`）。
- **表的拼接**：`shared/ipcChannels.mjs` 导出 `CORE_IPC_METHODS`，再 `import manifests from "../features/manifests.mjs"`，`IPC_METHODS = [...CORE, ...manifests.flatMap(m => m.contributes.ipc ?? [])]`。`IPC_METHOD_NAMES` 照旧派生。preload、facade、`apiSurface.test.js`、`ipcChannels.test.js` 一行不改就能看到新行。shared → features/manifests 这个方向的依赖是允许的，因为 manifests 是纯数据。

### 1.3 host 对象

主进程所有模块的 `register(host)` 收同一个包：

| 分组 | 成员 | 今天散在哪 |
|---|---|---|
| Electron 原语 | `app, ipcMain, dialog, shell, BrowserWindow, nativeImage, clipboard, sharp` | 各 register 调用各挑 |
| 环境 | `isPackaged, rootDir, resourcesPath, nativeBin, getUserDataPath, t` | 同上 |
| 设置 | `readAppSettings, updateAppSettings, getAppSettingsPath, readCatalogSettings, updateCatalogSettings` | main.js 顶部 |
| catalog | `catalog`（`state / path / hasDb / info / createAt / isSample`） | `catalog.*` |
| sidecar | `commands`（动词层）、`launchSidecarJob` | `sidecarCommands` |
| 任务 | `tasks`：`createTaskStarters` 的整个返回值 | 解构成 14 个名字四处传 |
| 凭据 | `tokens`（`createTokenStore` 的返回值） | 解构成 5 个名字 |
| 媒体 | `media`（白名单，含 `addAllowedMediaDir`）、`mediaHttp` | 同上 |
| 外壳 | `getMainWindow, appShell`（`installMenu / setMenuAccelerators / toggleAppFullscreen / queueExternalImport`）、`locale` | 同上 |
| 对话框 | `dialogs`（`dialogsIpc.createDialogs` 的返回值） | 只有 saveFile 收 |
| 图片 | `writeImageWithSourceMetadata` | saveFile |
| 模块间 | `services`：register 的返回值挂回来：`watcher, annotation, people, saveFile, mcp` | 顶层 `let` 变量和箭头函数包一层 |

落地时平铺了原语和函数（`app, ipcMain, readAppSettings, isPackaged …` 各模块按名解构，和以前一样），只有工厂本来就整体返回的对象保持成组（`catalog, tasks, tokens, media, appShell, locale, agentBridge, dialogs, services`）。权威列表是 `electron/host.js` 的 `HOST_KEYS`，`createHost` 对缺项和多出来的项都抛错。

`services` 解决的是今天 `peopleApi` 要用 `let` 加箭头函数延迟取值的问题：注册顺序不变，每个返回 api 的 register 完成后 `host.services.<name> = api`，后注册的从 `host.services` 取。MCP 最后注册，它要的 `startAnnotationTask`、`processAndSave`、`startPeopleIndex`、`watcher` 都在 services 里。

## 2. PR 0a：host 对象

**分支** `refactor/main-host`。**估时** 1 天。

1. 新建 `electron/host.js`：`createHost({...})` 接收 main.js 顶部那些已经建好的对象，按 §1.3 的分组装成一个冻结的对象；`services` 是其中唯一可写的子对象，带 `set(name, api)`。
2. main.js：所有 `xxxIpc.register({ ... })` 改成 `xxxIpc.register(host)`；返回 api 的四个（watcher、annotation、people、saveFile）接 `host.services.set(...)`；`createMcpServer` 也收 host，`port` 单独传。
3. 各 ipc 模块的 `register` 签名**不改**：它们本来就解构，多出来的字段不碰。只改需要重命名的：`commands` 已统一；`startAiRepaintTask` 这类从 `host.tasks` 解构；`getStoredProviderConfigWithMigration` 等从 `host.tokens` 解构；`getCatalogState` 改成 `host.catalog.state`。每个模块的改动是解构行那几行。
4. `electron/host.test.js`：建一个 host，断言各分组的键齐全、`services.set` 后能读到、顶层冻结。
5. **不改** `tasks.js`、`tokens.js`、`catalog.js`、`media/*` 的内部。

验收：`npm run check`（electron 单测里 `ipcChannels.test.js` 是文本扫 `ipcMain.handle`，不受影响）；全量 e2e；手动开一次 dev 确认菜单、导入、编辑、MCP 状态页正常。

**做完后的记录（2026-11-01，`refactor/main-host`）**，和上面步骤不一样的地方：

- host 的形状按 §1.3 末尾那段：平铺加对象组，不是全分组。模块的解构行写成 `catalog: { state: getCatalogState }`、`tasks: { createJob, latestJobStatus }`、`media: { addAllowedMediaDir }` 这样，函数体一行不动。
- `createMcpServer(host, { port })`。工具文件读的 `ctx.deps` 在 `server.js` 里从 host 拼出来（agentBridge 四个方法、任务启动器、`services.annotation / saveFile / people / watcher`），`mcp/tools/*.js` 不动。PR 2 加 `mcpTools` 贡献时再看要不要把 host 直接放进 ctx。
- main.js 里给单个模块算的几个小值搬成了模块参数的默认值：`dialogs` 的 `defaultCatalogDir`（从 `app, isPackaged, rootDir` 算）、`video` 的 `videoToolPath` / `runVideoTool`（`nativeBin, platform, commands`）、`nativeVideo` 的 `addonPath` / `toggleFullscreen`（`nativeBin, appShell`）、`devStaleness` 的 `enabled` / `roots`（`isPackaged, sidecarSrc`）。单测照旧显式传这些值。
- 9 个单测文件的 register deps 改成 host 形状；`serverStatus.test.js` 用一个最小 host（空 tasks / services / agentBridge）。
- `electron/host.test.js` 进 `test:electron` 列表。main.js 少了 95 行，31 个文件 +186 / −281。

## 3. PR 0b：配置接受 `features/`

**分支** `chore/features-dir`。**估时** 半天。目录可以是空的，只放一个 `features/README.md` 说明约定。

| 配置 | 改法 |
|---|---|
| `package.json` `build.files` | 加 `features/**/*`、`!features/**/*.test.js` |
| `test:electron` | 显式文件列表改成 glob：`node --test "electron/**/*.test.js" "features/**/electron/**/*.test.js"`。CI 是 Node 22，本机 24，都支持 glob 参数。先确认 glob 跑出来的文件集合和今天的列表一致（`vite.config.js`、`playwright.config.js` 不在 electron/ 下，不会被误扫） |
| `test:renderer` | `vitest run src features`；`vite.config.js` 的 `test.include` 加 `features/**/renderer/**/*.{js,jsx}` |
| `lint` | 路径加 `features`；`eslint.config.js` 里 `src/**` 的三个块（react-hooks、禁 `window.mediaWorkspace`、禁 z-index 字面量）扩到 `features/**/renderer/**`；`shared/**/*.mjs` 的块扩到 `features/**/*.mjs`；electron 的块扩到 `features/**/electron/**` |
| `scripts/e2e-coverage.mjs` | main 的 `--include` 加 `features/**/electron/**/*.js`；渲染层按已加载模块算，不用改 |
| `electron/devStaleness.js` 的 roots | 加 `features/` |
| `vite.config.js` | alias `@features` → `./features`（可选，renderer 从 `src/` 引用 `../../features` 时用） |

验收：`npm run check` 通过且文件集合不变；`npm run pack` 产物里有 `features/`（哪怕只有 README）。

## 4. PR 0c：ToolRail 读表

**分支** `refactor/tool-rail-table`。**估时** 半天。

1. 新建 `src/components/editor/editorTools.js`：

   ```js
   export const EDITOR_TOOLS = [
     { key: "crop",    icon: Crop,       labelKey: "overlay.tools.crop" },
     { key: "lut",     icon: LutGlyph,   labelKey: "overlay.tools.lut",     cap: "lut", unavailable: "hidden" },
     { key: "split",   icon: Columns3,   labelKey: "overlay.tools.split" },
     { key: "text",    icon: Type,       labelKey: "overlay.tools.text" },
     { key: "frame",   icon: PhotoFrame, labelKey: "overlay.tools.frame" },
     { key: "sticker", icon: Cannabis,   labelKey: "overlay.tools.sticker", cap: "stickerExtract", unavailable: "locked" },
     { key: "ai",      icon: Sparkles,   labelKey: "overlay.tools.repaint", cap: "aiRepaint",      unavailable: "locked" },
   ];
   ```

2. `ToolRail.jsx` 遍历它：`cap` 不可用时按 `unavailable` 隐藏或渲染锁住的按钮（今天两种写法都有，保留）。`data-testid` 仍从翻译后的 label 派生（`tool-<label>`），e2e 靠它。
3. `capabilities.test.js` 的 `cap:` 正则本来就扫 `src/**`，表里的 `cap: "lut"` 会被它认到，不用改。

验收：`03-editor`、`67-lut`、`04-sticker`、`07-depth` 等编辑器 spec 全绿；截图对比 ToolRail 顺序和图标不变。

## 5. PR 0d：LUT 的推导收进 hook

**分支** `refactor/lut-hook-owns-derivations`。**估时** 1 天。目的是让 PR 1 的搬迁是**搬文件**，不是改逻辑。

今天 `EditorOverlay.jsx` 里属于 LUT 的东西（45 处提及）分四类：

| 类 | 内容 | 去向 |
|---|---|---|
| 中性 RAW 渲染 | `neutralItem`、`neutralWanted`、`useNeutralRawRender`、`neutralPath`、`neutralRendering`、`tool === "lut"` 时 `setNeutralItem` 的 effect | 新 hook `useLutSource({ open, active, item, isRaw, available, sourceBaked })`，返回 `{ sourceOverride, rendering, base }`。EditorOverlay 的 `resolvedSourcePath` 用 `sourceOverride` 替掉 `neutralPath` |
| 预览合成 | `lutGradedTransformed`（`useMemo` + `buildTransformedCanvas`）、`lutStrength`、`lutShown`、`lutBase` | 进 `useLutTool` 的返回值：`{ gradedTransformed, shown, strength, base }`。它需要 `discreteRotationDeg / flipX / flipY`，作为参数传入 |
| 保存 | `saveImage.js` 的 `grade` 参数、`useSplitExport.js` 的 `getGrader` | **已经是钩子**（"The LUT step: async (canvas) => graded canvas, or null"），不动。只把 EditorOverlay 里构造 grader 的那几行搬进 `useLutTool`，返回 `grader` |
| 测试后门 | `editorTestApi.js` 的 `getLutState` / `refreshLuts`，读 `h.lutTool`、`h.lutGradedTransformed`、`h.lutBase` | `useLutTool` 返回 `testApi: { getLutState, refreshLuts }`；`editorTestApi.js` 改成 `...h.lutTool.testApi`，不再知道 LUT 的字段 |

做完后 EditorOverlay 剩下：两个 import、两个 hook 调用、`active: tool === "lut"`、面板渲染、把 `grader` 交给保存、把 `lutTool` 交给 testApi。十处以内。

`editorStateModel.js` 的 `lut` 槽和 `lutEquals` **不动**：它是历史栈的一部分，是核心和处理器之间的契约。要不要泛化成 `processors: {}`，等 PR 2 看 AI 重绘（它不用槽）再定。

验收：`67-lut` 三处 `getLutState` 读到的字段一个不少；`33-split` 里带 LUT 的切图导出；`06-save`。

## 6. PR 1：LUT 迁成第一个 feature module

**分支** `feat/feature-module-lut`。**估时** 2 到 3 天（0a 到 0d 做完的前提下）。

### 6.1 搬文件

| 从 | 到 |
|---|---|
| `electron/lutLibrary.js`、`.test.js` | `features/lut/electron/lutLibrary.js`、`.test.js` |
| `electron/ipc/luts.js` | `features/lut/electron/luts.js`（`register(host)`，内部从 host 解构 `app, ipcMain, dialog, shell, readAppSettings, updateAppSettings, getMainWindow`，和 PR 0a 后一样） |
| `src/components/editor/LutPanel.jsx` | `features/lut/renderer/LutPanel.jsx` |
| `src/components/editor/state/useLutTool.js` | `features/lut/renderer/useLutTool.js` |
| `src/components/editor/lut/*`（含 test） | `features/lut/renderer/lut/*` |
| `src/components/settings/LutLibraryGroup.jsx` | `features/lut/renderer/LutLibraryGroup.jsx` |
| `shared/ipcChannels.mjs` 的 11 行 | `features/lut/manifest.mjs` 的 `contributes.ipc` |

留在原地：`shared/cubeLut.mjs`、`shared/lutLogGuess.mjs`（两进程共用）；`editorStateModel.js` 的 `lut` 槽；`saveImage.js` 的 `grade` 钩子；`e2e/67-lut.spec.js`；i18n 的 `editor.lut` 和 `settings.lutLibrary`（namespace 搬迁另议）；`ipc/appSettings.js` 的 `luts` 缓存目录（它是"缓存目录"表的一行，属于宿主）。

搬进 feature 的文件里相对路径要改：`require("../settingsStore")` → `require("../../../electron/settingsStore")` 之类。用 `git mv` 保留历史。

### 6.2 新建

- `features/manifests.mjs`：`export default [lut]`。
- `features/lut/manifest.mjs`：§1.1 的内容。
- `features/lut/renderer/index.js`：`export const Panel = lazy(() => import("./LutPanel.jsx"))`、`export { useLutTool as useTool }`、`export { default as SettingsGroup } from "./LutLibraryGroup.jsx"`、`export { useLutSource }`。
- `features/index.js`（渲染层注册表）：`export const FEATURES = { lut: lutRenderer }`，再给三个派生表：`editorToolFeatures`（有 `contributes.editorTool` 的）、`settingsGroups(tab)`。
- `electron/features.js`：
  - `loadFeatures()`：读 `manifests.mjs`，对每个有 `electron` 字段的清单 `require` 该路径（LUT 的就是搬过去的 `luts.js`，不改名）。
  - `capabilitiesFromFeatures(platform, { hasHelper })`：清单的 `platforms` 不含当前平台、或 `helper` 缺失 → `{ [capability]: false }`。
  - `registerFeatures(host)`：按 manifests 顺序调 `register(host)`。

### 6.3 改宿主

- `electron/capabilities.js`：`desktopCapabilities` 变成"清单推出的 + 还没迁移的手写项"的合并；`lut: false` 从 Windows 那张手写表删掉。`capabilities.test.js` 的四个断言结果不变，加一条"清单推出的和手写的没有重叠"。
- `electron/main.js`：删 `lutsIpc` 的 require 和 register，加 `registerFeatures(host)`（放在今天 `lutsIpc.register` 的位置，注册顺序不变）。
- `shared/ipcChannels.mjs`：`IPC_METHODS` 改成 `CORE` 加清单行（§1.2）。`ipcChannels.test.js` 的 `walk(__dirname)` 只扫 `electron/`，要加 `features/`，否则 11 个 channel 会被判成"表里有、没人答"。
- `src/components/editor/components/ToolRail.jsx` / `editorTools.js`：LUT 那一行从表里删，改成从 `features/index.js` 的 `editorToolFeatures` 拼进来（位置保持在 crop 之后：清单加 `after: "crop"` 或表按固定顺序合并；选后者，顺序写在 `editorTools.js` 里）。
- `src/components/EditorOverlay.jsx`：`import { useTool, useLutSource, Panel } from "../../features/lut/renderer"`（PR 1 允许直接 import 这一个 feature；通用的"遍历所有 editorTool feature 调 hook"要绕 rules-of-hooks，等 PR 3 有三个样本再决定）。面板处 `tool === "lut" ? <Suspense><Panel …/></Suspense>`。
- `src/components/settings/LibrarySettings.jsx`：`{api.can("lut") ? <LutLibraryGroup/> : null}` 改成渲染 `settingsGroups("library")`，每个 group 按它清单的 capability 门控。
- `src/api/browser/bridge.js` 的 capabilities 块：不动（它是 web 的手写声明）。`capabilities.test.js` 加一条：每个 `web: false` 的清单，这里必须声明 `false`。

### 6.4 不碰

`mcp/`（LUT 没有 tool）、sidecar、e2e、i18n、`editorStateModel.js`。

### 6.5 验收

- `npm run check`：lint（features 目录被三组规则覆盖）、electron 单测（`lutLibrary.test.js` 在新位置被 glob 到，`host.test.js`、`capabilities.test.js`、`ipcChannels.test.js` 绿）、vitest（`lut/*.test.js` 在新位置）、build。
- `apiSurface.test.js`：表的大小不变（183 行，只是来源变了）。
- 全量 e2e；重点 `67-lut`、`10-settings`、`33-split`、`06-save`、`03-editor`。
- `npm run pack` 后在打包版里开 LUT 工具、导入一个 `.cube`、设置页 LUT 库分组可见。
- Windows CI（#235 起 e2e 在 Windows 跑）：LUT 按钮不出现、设置页无 LUT 分组，和今天一样。
- `mac-builds.cjs` 的 macOS 12 构建：LUT 不受影响（它没有 helper）。

**做完后的记录（2026-11-02，`feat/feature-module-lut`）**，和上面不一样的地方：

- 清单没有 `renderer: () => import(...)` 字段：渲染层注册表 `features/index.js` 静态 import 各 feature 的 `renderer/index.js`（面板在那里面 `lazy()`），清单里放一个没人调的懒加载函数只会让 Vite 多切一个 chunk。清单就是纯数据，一行代码都没有。等沙箱插件真要从清单动态加载时再加。
- `editorTool` 贡献写 `unavailable: "hidden"`，和 `editorTools.js` 行里的字段同名，不另起 `hidden: true`。
- `editorTools.js`：`CORE_TOOLS`（六个还在核心里的）加 `editorToolFeatures`，按 `RAIL_ORDER` 排；有工具不在 `RAIL_ORDER` 里就抛错。LUT 的图标 `LutGlyph` 搬到 `features/lut/renderer/LutGlyph.jsx`，经 `renderer/index.js` 的 `icon` 导出。
- `features/index.js` 对每个清单检查注册表里有它的渲染层，没有就抛错。
- `electron/capabilities.js` 导出 `MAC_HELPERS`，`capabilities.test.js` 用它断言"清单推出的和手写的没有重叠"；"`web: false` 的清单必须在 web bridge 里声明 false"放在 `src/api/capabilities.test.js`（它本来就解析 bridge 的 capabilities 块），顺带让它扫 `features/` 目录（`.mjs` 也扫，清单的 `capability: "lut"` 就是被它读到的）。新建 `electron/features.test.js` 五条。
- `electron/ipcChannels.test.js` 扫 `electron/` 加 `features/*/electron/`（feature 的 `renderer/` 里不许有 handler）。
- vitest 的范围从命令行过滤改成 `vite.config.js` 的 `test.include`（`src/**` 和 `features/**/renderer/**` 的测试）：`vitest run src features` 的 `features` 是文件名过滤，会把 `electron/features.test.js` 和 `features/lut/electron/lutLibrary.test.js` 两个 node:test 文件也抓进来。`test:renderer` 变成 `vitest run`。
- eslint 和 istanbul 的 renderer 文件列表加了 `features/index.js`（它不在任何 `renderer/` 下）。
- `IPC_METHODS` 183 行不变，LUT 的 11 行从中段挪到了末尾（清单行接在 `CORE_IPC_METHODS` 后面）；preload 和 facade 按名字取，顺序无关。
- 没做：`npm run pack` 的打包验收和 `e2e:coverage`（67-lut 明显覆盖被搬的文件）。

## 7. PR 2：AI 重绘

**分支** `feat/feature-module-repaint`。**估时** 2 到 3 天。清单新字段：`mcpTools`。

- 搬：`editor/AiRepaintPanel.jsx`、`settings/RepaintSettings.jsx`、`ai/providers.jsx` → `features/repaint/renderer/`；`ipc/ai.js` 里重绘那部分 → `features/repaint/electron/`（text-image 那几条 channel 是手写工具的，留在 `ipc/ai.js` 或另起 `ipc/textImage.js`，PR 里定）；`mcp/tools/assets.js` 的 `repaint_asset` → `features/repaint/electron/mcpTools.js`，`mcp/tools/index.js` 的 `GROUPS` 改成 `[...coreGroups, ...featureGroups]`。
- Settings tab：清单 `settingsTab: { id: "repaint", labelKey, icon }`，`SettingsOverlay.jsx` 的 `TABS` 改成核心行加清单行（位置固定在 `ai` 之后）。
- 面板"常驻挂载"的行为保留：清单 `editorTool.mount: "always"`。
- 供应商 registry：渲染层 `PROVIDER_TYPES` 和 sidecar `ai_repaint.py` 的 if 链**暂不合并**（跨语言，另开 PR），本 PR 只搬。
- web 的 `api/browser/ai.js` 不动。
- `tasks.js` 的 `startAiRepaintTask` 留在宿主：任务系统是宿主的。

验收：`03-editor`、`80-repaint-reference`、`10-settings`、`34-settings-transfer`、`08-mcp-http`、`toolSchemas.test.js`（要让它也扫 `features/**/electron/mcpTools.js`）。

**做完后的记录（2026-11-02，`feat/feature-module-repaint`）**，和上面不一样的地方：

- **`ipc/ai.js` 的拆法**：供应商凭据（get / set / delete token）、偏好（aiPreferences）、模型列表（list-ai-models）**留在宿主**，不只是 text-image：文字工具的手写弹窗（`HandwritingModal`）直接读 `getAiPreferences` 和 `getAiProviderToken`，重绘模块不在时它也得能用。搬进 `features/repaint/electron/repaint.js` 的是重绘自己的：`ai-repaint-status / start`、`list-repaint-history`、`get / save-ai-styles`、`pick-repaint-refs`。清单的 `ipc` 是这 6 行；`ipc/ai.js` 文件名不改（历史），头注释改成"AI providers + text image"。
- **`pick-repaint-refs` 跟着搬了**：`dialogs.js` 里"记住上次文件夹"的 `pickerStart / rememberPicker` 收进 `createDialogs`（多收 `readAppSettings / updateAppSettings`），通过 `host.dialogs` 给所有模块用；`dialogs.js` 的 register 不再收这两个设置函数。相应单测拆开：手写图的留在 `dialogs.test.js`，重绘图的到 `features/repaint/electron/repaint.test.js`（5 条，含"注册的 channel 和清单一致"）。
- **`dedupeModels`** 被核心的 `HandwritingModal` 和重绘的 `RepaintSettings` 共用，搬到 `src/utils/aiModels.js`；`providers.jsx`（`PROVIDER_TYPES`、`ProviderModal`、`getProviderType`）整体进 `features/repaint/renderer/`，文字工具不读它。
- **MCP**：`repaint_asset` 原样进 `features/repaint/electron/mcpTools.js`；`electron/features.js` 加 `loadMcpToolGroups()`（清单 `contributes.mcpTools` 相对路径），`mcp/tools/index.js` 的 `GROUPS` 末尾展开它；`toolSchemas.test.js` 从清单读 feature 的工具文件一起扫。工具数仍是 37，`08-mcp-http` 的名单不变。
- **Settings tab**：清单 `settingsTab: { id: "repaint", key: "repaint" }`（`key` 是 settings 命名空间 `tabs.*` 下的标签键，没另起 labelKey / icon 字段，图标从 `renderer/index.js` 的 `settingsTabIcon` 来）；`features/index.js` 导出 `settingsTabs`；`SettingsOverlay.jsx` 变成 `CORE_TABS` + `settingsTabs` 按 `TAB_ORDER` 排，面板处 `settingsTabs.map(...)`。
- **面板不懒加载**：`renderer/index.js` 的 `Panel` 是普通 import，因为编辑器一开就挂着它（清单 `editorTool.mount: "always"`），切 chunk 没意义。EditorOverlay 仍手写 `tool === "ai" ? "flex …" : "hidden"`，`mount` 字段先是记录，等 PR 3 看要不要表驱动。
- `IPC_METHODS` 仍 183 行；供应商注册表和 sidecar 的 if 链没合并（按计划另开 PR）；`api/browser/ai.js` 没动；`tasks.js` 的 `startAiRepaintTask / activeRepaintProvider` 留在宿主。
- 没做：`e2e:coverage`。

## 8. PR 3：贴纸提取

**分支** `feat/feature-module-sticker`。**估时** 3 天。清单新字段：`sidebarView`、`layerSource`、`helper`。

- 搬：`StickerPanel.jsx`、`state/useStickerTool.js`、`useStickerRegion.js`、`components/StickerRegionOverlay.jsx`、`StickerView.jsx`、`hooks/useStickerViewKeys.js` → `features/sticker/renderer/`；`ipc/stickers.js` → `features/sticker/electron/`。`native/extract-sticker.swift` 不搬（构建脚本和 `mac-builds.cjs` 认它的路径），清单 `helper: "extract-sticker"`。
- 留在核心：`text/StickerLayerInspector.jsx`、`text/StickerPickerModal.jsx`、`useStickerImageCache.js`、`drawLayers.js` 里的图片层绘制、`layerStack.js`、`textState.js`。
- `layerSource`：`StickerPickerModal` 今天直接调 `api.listStickers`；改成从注册表取 `layerSources`，贴纸 feature 提供 `{ list, thumbUrl }`。这是"图层来源"贡献的第一个用例。
- `sidebarView`：`App.jsx` 的 `viewMode` switch 和 `Sidebar.jsx` 的入口改成核心视图加清单视图。agent 的 `show_in_app view: "stickers"` 走同一张表。
- 画布覆盖层：清单 `editorTool.overlay`，EditorOverlay 的 `tool === "sticker" && imageRect && <StickerRegionOverlay/>` 改成通用的 `ActiveOverlay`。这是三个样本里唯一有覆盖层的，也是"画布原语"的第一个数据点。
- 到这里再决定：hook 的通用调用方式（`useFeatureTools` 加一处 eslint 例外，还是继续显式 import）；`editorStateModel` 的槽要不要泛化。

验收：`04-sticker`、`43-sticker-library`、`19-editor-layers`、`02-navigation`、`08-mcp-http`。

**做完后的记录（2026-11-02，`feat/feature-module-sticker`）**，和上面不一样的地方：

- **搬了什么**：`ipc/stickers.js` → `features/sticker/electron/stickers.js`（抽图工具路径改从 `host.nativeBin` 取，不再自己判断 `isPackaged`；加 `stickers.test.js` 5 条：channel 和清单一致、save/list/star/delete 往返、缩略图补生成、detect 的三种拒绝、scratch 清理只删自己的目录）；`StickerPanel.jsx`、`StickerRegionOverlay.jsx`、`StickerView.jsx`、`hooks/useStickerViewKeys.js` → `features/sticker/renderer/`。`state/useStickerRegion.js` 搬过去改名 `useStickerTool.js`（只剩选区状态）；旧的 `state/useStickerTool.js` 删了——它只是把 `useStickerImageCache` 和选区拼在一起，而图片层解码缓存是核心的（图层里有贴纸和这个模块在不在无关），现在 EditorOverlay 直接调 `useStickerImageCache(layers)`。
- **清单新字段**：`helper: "extract-sticker"`（macOS 12 构建缺它就锁，`electron/capabilities.js` 的手写表只剩 depth / people）；`editorTool.overlay: true`；`sidebarView: { id: "stickers", labelKey: "sidebar.stickers", unavailable: "locked" }`（labelKey 在 nav 命名空间）；`layerSource: { id: "stickers", labelKey: "text.addStickerLayer", hideLabelKey: "text.hideStickerPicker" }`（editor 命名空间）。
- **画布覆盖层**：`features/index.js` 的 `editorToolFeatures` 行多一个 `Overlay`（清单 `overlay: true` 时取 `renderer/index.js` 的 `Overlay`）；EditorOverlay 里 `const featureTools = { lut: lutTool, sticker: stickerTool }` 按 rail key 收各模块的 hook 结果，`ActiveOverlay = editorToolFeatures.find(key === tool)?.Overlay`，渲染 `<ActiveOverlay imageRect tool={featureTools[tool]} />`。覆盖层组件的 props 统一成 `{ imageRect, tool }`（`StickerRegionOverlay` 从 `tool` 里解构 region / drag / setDrag / commit）。**面板没有表驱动**：各工具面板的 props 都不一样，仍是 `tool === "sticker" ? <Suspense><StickerPanel …/></Suspense>`；`mount: "always"` 也还是手写。
- **侧栏视图**：`features/index.js` 导出 `sidebarViews`（id、labelKey、icon、cap、unavailable、View、Inspector）。`Sidebar.jsx` 的贴纸按钮变成 `sidebarViews.map(...)`，props 从 `stickerMode / onOpenStickerBrowser` 改成 `activeView / onOpenView(id)`。`App.jsx`：`useView` 的调用仍是显式 import（`useView as useStickerView`），结果放进 `featureViewStates = { stickers: stickerView }`；`featureView = sidebarViews.find(id === viewMode)`，中栏 `<featureView.View view={state}/>`、右栏 `<featureView.Inspector view={state}/>`、Lightbox 的 items / index / onIndexChange / 键盘处理都从 state 取；agent 的 `show_in_app` 的 switch 默认分支查 `sidebarViews`，主进程 `mcp/tools/app.js` 的 `view` 枚举从清单拼（`CORE_VIEWS` + 各清单的 `sidebarView.id`，仍是那 5 个值）。**useView 的约定**（App 的 chrome 需要的）：`refresh`、`selected`、`lightboxItems`、`lightboxIndex`、`onLightboxIndexChange`、`handleKey`；贴纸视图把原来在 App 里的"shape 成 Lightbox items"和 `useStickerViewKeys` 收进了自己的 `useView`。
- **图层来源**：`features/index.js` 导出 `layerSources`（id、labelKey、hideLabelKey、cap + 模块的 `{ icon, list, thumbUrl }`）。`TextPanel.jsx` 的贴纸按钮变成 `layerSources.map(...)`，打开状态从布尔改成"哪个来源的 picker 开着"；`StickerPickerModal` 收 `source`，用 `source.list()` / `source.thumbUrl(s)`，不再直接碰 `api.stickerList`。`StickerPickerModal.jsx`、`StickerLayerInspector.jsx`、`useStickerImageCache.js`、`drawLayers.js`、`layerStack.js`、`textState.js` 按计划留在核心。
- **hook 的通用调用方式——拍板：继续显式 import。** 三个样本（LUT、重绘、贴纸）各一行 import、一处调用，`featureTools` / `featureViewStates` 两张小表把结果接回表驱动的部分；`useFeatureTools` 加 eslint 例外留到清单冻结时再看。`editorStateModel` 不动：贴纸选区不进历史栈，没有槽要泛化。
- **没动**：`native/extract-sticker.swift`（构建脚本认它的路径）；i18n（`stickerView.json` 命名空间、nav 的 `sidebar.stickers`、editor 的 `sticker.*` / `text.*StickerLayer` 都在原处，按 §11 等三个 PR 都合入后统一搬）；Settings ▸ Library 的"贴纸库"打开文件夹一行（它是缓存存储表的一行，`appSettings.js` 的 kind → 路径表是宿主的，Windows 上今天也显示，没改成 settingsGroup）；web 的 `api/browser/editor.js` 的 `stickerList: async () => []`；`IPC_METHODS` 仍 183 行。
- 没做：`e2e:coverage`。

## 9. 时间表

| 顺序 | PR | 估时 | 依赖 |
|---|---|---|---|
| 1 | 0a host 对象 | 1 天 | — |
| 2 | 0b `features/` 配置 | 半天 | — |
| 3 | 0c ToolRail 读表 | 半天 | — |
| 4 | 0d LUT 推导收进 hook | 1 天 | — |
| 5 | 1 LUT | 2 到 3 天（实际半天） | 0a–0d 全部合入 |
| 6 | 2 AI 重绘 | 2 到 3 天（实际半天） | 1 |
| 7 | 3 贴纸 | 3 天（实际半天） | 2 |

0a 到 0d 互不依赖，可以并行开，但每个都从 main 开分支、各自合入 main 后 PR 1 再开。全部约两周到两周半。

## 10. 每个 PR 的检查单

- [ ] 从最新 main 开分支，不基于别的 PR 分支
- [ ] `npm run check`
- [ ] 全量 `npm run e2e`（不是 CI 子集）
- [ ] `npm run e2e:coverage`，确认被搬 / 被改的文件有 spec 覆盖
- [ ] 搬文件用 `git mv`
- [ ] PR 描述写清：搬了什么、改了什么、什么没动、怎么验证的
- [ ] 文档：本文顶部状态行更新；PR 1 起 `docs/README.md` 的"现状权威"表加 `features/README.md`

## 11. 待拍板

1. ~~`host` 是冻结对象加可写的 `services`，还是全部可写。~~ **已定（2026-11-01）：冻结，只有 `services` 可写。** 读 host.js 一眼能看出 feature 拿得到什么，以后公开 API 从这张清单里挑子集；全部可写的话三个 PR 后 host 又变回隐式全局对象。
2. ~~PR 0b 到 0d 三个小 PR 分开合，还是合成一个"准备"PR。~~ **已定（2026-11-01）：分开，各自从 main 开。** 文件集合不相交；0d 是唯一有行为风险的（e2e 67），单独一个好 revert。
3. ~~`features/<id>/electron/index.js` 这个入口约定，还是在清单里写路径。~~ **已定（2026-11-01）：清单里写 `electron: "./electron/xxx.js"`，不立文件名约定。** 清单本来就有 `renderer` 懒加载函数，入口已经在清单里；再规定 `index.js` 是多一条规则而不是少一个字段。第三方插件的三种形态（沙箱 iframe、CLI 可执行文件、无主进程）也都落在显式字段上。
4. ~~LUT 的 i18n 字串留在 `editor.json` / `settings.json`，还是 PR 1 就给 feature 自己的 namespace。~~ **已定（2026-11-01）：留着，PR 3 之后看三个样本一起搬一次。** 三个 feature 的字串分布不同，一个样本定不了格式；`data-testid` 从翻译后的 label 派生，搬 key 连带改 e2e，搬两次不划算。第三方沙箱插件自带字串、走 postMessage 传 locale，不要求核心先拆。
