# 应用内更新

> **状态（2026-11-27）**：已实现（feat/auto-update）。第一个带更新器的版本发出去之前，按文末「发版前手动验一次」走一遍真替换。

设置 ▸ 关于 ▸ 软件更新：检查、下载、重启以更新。菜单里有「AfterFrame ▸ 检查更新…」。底层是 electron-updater：macOS 上由 Squirrel.Mac 替换 .app，Windows 上静默运行 NSIS 安装包。

## 怎么工作

- **去哪儿找新版本**：`package.json` 的 `build.publish`，generic provider，地址是 `https://github.com/YIWANG3/AfterFrame/releases/latest/download`。这个地址会跳到最新正式版的附件，不走 GitHub API，所以没有限流，也碰不到预发布的 `models` release。electron-builder 把它写进每个 app 的 `Resources/app-update.yml`。
- **每个包一个 channel**：electron-updater 只按 CPU 架构挑文件，不看最低系统版本。如果几个 Mac 包共用 `latest-mac.yml`，macOS 12 的用户可能被更新成要求 14 的包。所以每个包读自己的文件：

  | 包 | 读的文件 | 下载的 zip |
  |---|---|---|
  | Apple 芯片，macOS 14+ | `latest-mac.yml` | `AfterFrame-<版本>-arm64-mac.zip` |
  | Apple 芯片，macOS 12+ | `macos12-arm64-mac.yml` | `AfterFrame-<版本>-macOS12-arm64-mac.zip` |
  | Intel，macOS 12+ | `macos12-intel-mac.yml` | `AfterFrame-<版本>-macOS12-Intel-mac.zip` |
  | Windows | `latest.yml` | `AfterFrame-<版本>-x64-setup.exe` |

  channel 在 `electron-builder.mac.cjs` 里按构建名设，跟着 `app-update.yml` 进 app。
- **什么时候检查**：启动一分钟后一次，之后每天一次。设置里「自动检查更新」可以关（默认开，存在 app 设置的 `updates.autoCheck`）。自己发起的检查失败会显示出来；app 自己做的检查失败（比如没联网）不显示。最新的 release 里还没有这个包的文件（Windows 安装包比 Mac 晚传几十分钟）算作「已是最新」。
- **下载**：要用户点。Apple 芯片的包有 400 MB 左右。下载后 electron-updater 校验 sha512；blockmap 让下一次更新只下变了的部分（第一次总是全量）。
- **安装**：下载完 Squirrel.Mac 马上解包、核对签名，退出时替换；点「重启以更新」就立刻替换并重新打开。有后台任务在跑时这个按钮先不能点，因为任务是独立进程，替换 app 时它们还在用旧包里的文件。
- **装不了的情况**：app 在 DMG 里直接运行，或者在「下载」里被 macOS 隔离运行（App Translocation），所在文件夹不可写，Squirrel 换不了。这时照样检查，但按钮换成「去 GitHub 下载」，并提示移到「应用程序」。
- **隐私**：electron-updater 默认每次请求都带一个存在 userData 里的随机 id（`x-user-staging-id`，给分批推送用，我们不用）。这里换成全零的固定值，请求里没有能识别这台设备的东西。隐私页（`site/privacy*.html` 第 03 节）写了检查更新。

代码：`apps/desktop/electron/updater.js`（状态机、IPC、定时）、`src/components/settings/AboutSettings.jsx`、`src/hooks/useUpdateNotice.js`（app 自己发现新版本时提示一次）。

## 发版

`scripts/release.sh` 除了 3 个 DMG，还上传 3 个 zip、它们的 `.blockmap` 和 3 个 yml，上传前核对：yml 的版本号、yml 里写的 zip 名、zip 里的 app 签名有效、app 读的 channel 对。release 先建成草稿，全部传完再发布，免得已安装的 app 读到 yml 时 zip 还没传完。Windows workflow 把 `latest.yml` 和安装包的 blockmap 一起传，yml 最后传。

**只有带更新器的版本以后才能自动更新**：0.5.28 及更早的用户还得手动下载一次。

## 测试

- 单测：`electron/updater.test.js`（假的 electron-updater，覆盖状态、错误归类、定时、装不了的位置）。
- e2e：`e2e/104-auto-update.spec.js`。测试进程里起一个本地更新源，`AFTERFRAME_UPDATE_FEED` 指过去，开发版 app 走真的 electron-updater：检查、提示条、菜单、失败重试、开关、下载和 sha512 校验。Squirrel.Mac 那一步用桩：它从 electron-updater 的本地代理把 zip 取走、报告就绪、记下安装调用，但不替换 app（要签名的 app，而且会换掉跑测试的 Electron）。Windows 上跳过下载那条：NSIS 在 app 关闭时会运行下载的安装包。
- `AFTERFRAME_UPDATE_FEED`（可选再加 `AFTERFRAME_UPDATE_CHANNEL`）让任何一个 app 改从这个地址检查更新，下载缓存放到 userData 里的 `update-feed/`。`AFTERFRAME_UPDATE_CHECK_DELAY_MS` 改第一次自动检查的等待时间。e2e 下（设了 `AFTERFRAME_USER_DATA`）没有更新源的打包版不会自己去查 GitHub。

### 发版前手动验一次

真替换只能用签名的包验。第一个带更新器的版本，或者改了更新相关的东西以后：

1. 打好要发的版本（`PUBLISH=0 bash scripts/release.sh`），装进 `/Applications`。
2. 本地把版本号临时改高一位（不提交），再打一个签名的包：`npm run dist:mac`。
3. 把 `apps/desktop/release` 当成更新源：

   ```bash
   python3 -m http.server 8765 --directory apps/desktop/release
   ```

4. 指着它打开已安装的 app：

   ```bash
   AFTERFRAME_UPDATE_FEED=http://127.0.0.1:8765/ /Applications/AfterFrame.app/Contents/MacOS/AfterFrame
   ```

5. 设置 ▸ 关于 ▸ 立即检查 → 下载 → 重启以更新。app 应当自己重新打开，关于页显示新版本号。macOS 12 的包要再加 `AFTERFRAME_UPDATE_CHANNEL=macos12-arm64`（或 `macos12-intel`），更新源目录换成 `release/<构建名>`。
