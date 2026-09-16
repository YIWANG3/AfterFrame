# 设置导出 / 导入设计方案

> **状态（2026-09-16）**: 设计稿，未实现。

## 需求

换电脑或多台 Mac 同时使用时，用户希望把 AI 重绘、AI 标注的服务商配置和 API 密钥，以及其他全局设置，一次性搬到另一台设备，不用逐个重新填写。

## 现状与难点

- 全局设置在 `userData/afterframe/settings.json`，风格库在同目录 `ai-styles.json`（见 [settings-scope.md](settings-scope.md)）。
- 密钥存在 `settings.aiProviders[<id>].token`，用 Electron `safeStorage` 加密（`main.js` 的 `encryptToken` / `decryptToken`）。解密口令在**本机钥匙串**的 `afterframe Safe Storage` 里，所以直接拷 `settings.json` 到另一台 Mac，密钥解不开，会被当成未配置。
- 密钥命名空间：重绘是 `<providerId>`（如 `p_moorb2p1tzg4`），标注是 `annotation:<providerId>`，旧版遗留过 `annotation:<type>`。

因此导出时必须在本机解密，再用**与机器无关**的方式重新加密。

## 导出范围

白名单导出，不在名单里的字段一律不带，避免把本机路径带过去。

| 分区 | 字段 | 说明 |
| --- | --- | --- |
| 通用 `general` | `locale`、主题（renderer `localStorage` 的 `afterframe-theme`）、`previews` | 主题由 renderer 传给主进程 |
| AI 重绘 `repaint` | `aiPreferences.providers` / `activeProvider` / `selectedModels`，风格库 `ai-styles.json`（兼容旧的 `settings.aiStyles`） | 丢弃 `modelsCache`，可重新拉取且体积大 |
| AI 标注 `annotation` | `aiAnnotation` 全部字段 | 服务商列表 + 行为设置 |
| 密钥 `secrets` | 上面两类服务商对应的 `aiProviders` token | 可选，必须设密码 |

**不导出**：`lastCatalogPath`、`integrations`、`peopleRecognition`（含本机 `modelPath`，模型文件需在新电脑上重新下载）、目录级设置（`.afcatalog/settings.json` 里的监视文件夹，本来就跟着目录走）、各类缓存。

**不导出孤儿密钥**：只导出当前服务商列表引用到的 token（重绘 `id`、标注 `annotation:id`，外加当前激活标注服务商的 `annotation:type` 兜底）。已删除服务商残留的旧 token 不带走。

## 文件格式 `.afsettings`

UTF-8 JSON。非密钥部分是明文，用户可以自己打开看；密钥整体加密成一段。

```json
{
  "format": "afterframe-settings",
  "version": 1,
  "exportedAt": "2026-09-16T10:00:00.000Z",
  "appVersion": "0.5.2",
  "sections": {
    "general": { "locale": "zh-CN", "theme": "dark", "previews": { "generateHd": false } },
    "repaint": { "providers": [], "activeProvider": "p_x", "selectedModels": {}, "styles": [] },
    "annotation": { "providers": [], "activeProviderId": "a_x", "languages": ["zh-CN"] }
  },
  "secrets": {
    "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "<b64 16B>" },
    "cipher": { "name": "AES-256-GCM", "iv": "<b64 12B>", "tag": "<b64 16B>" },
    "count": 5,
    "data": "<b64>"
  }
}
```

- `secrets` 为 `null` 表示没有带密钥。
- 解密后的明文是 `{ "tokens": { "<namespace>": "<token>" } }`。
- GCM 的 AAD 取 `format|version|exportedAt`，防止把别的文件的密钥段拼进来。
- **选 PBKDF2 而不是 scrypt**：Node `crypto` 和浏览器 WebCrypto 都原生支持，Web 版（[web-app-plan.md](web-app-plan.md)）以后可以读写同一种文件。迭代次数写进文件，以后可以调高。
- 密码至少 8 位，导出时输两次。**密码忘了就无法找回**，UI 要明确提示。
- 写文件用 `writeJsonAtomic`，权限 `0600`。

## 安全边界

- 明文 token **不经过 IPC 进 renderer**。导出时主进程自己解密、加密、写文件；导入时主进程自己读文件、解密、用 `safeStorage` 重新加密落盘。renderer 只传密码、只收摘要。
- 导出时某个 token 解不开（钥匙串授权被拒）：跳过这一项，在结果里列出「N 个密钥未能读取」，不中断整个导出。
- 导入时 `safeStorage` 不可用：沿用现有行为（明文存储），但结果里给出警告。
- 密码错误：GCM 校验失败，报「密码不正确」，**任何东西都不写入**。先解密、校验，全部通过后才开始写。
- MCP 不暴露这项能力（与 `add_text` 不暴露的思路一致：涉及密钥，只能由用户在 UI 里操作）。

## 导入语义

P1 只做**合并**，不做「整体替换」，避免误删本机已有的服务商。

1. **检查**：主进程弹出文件选择框，解析并校验 `format` / `version`（更高版本拒绝并提示升级应用），返回摘要：包含哪些分区、各分区的服务商名字、密钥个数、与本机冲突的项（同 id）。
2. **确认**：用户勾选要导入的分区；文件带密钥时显示密码框，并可勾选「导入 API 密钥」。
3. **应用**（主进程，单次 `updateAppSettings` 内完成）：
   - 写入前先备份：`settings.json` 和 `ai-styles.json` 复制为 `settings.backup-<时间戳>.json` / `ai-styles.backup-<时间戳>.json`，只保留最近 3 份。
   - 服务商列表、风格库：按 `id` 合并，同 id 用导入的覆盖，新 id 追加到末尾。
   - `activeProvider` / `activeProviderId`：本机没有或本机的已失效时才采用导入值。
   - 其余标量（语言、标注行为设置、`previews` 等）：该分区被勾选就用导入值覆盖。
   - token：逐个 `setStoredProviderConfig`，但只写入本次被导入的服务商引用到的 token。
4. **生效**：返回 `{ imported, skipped, warnings, theme }`。renderer 写入主题，调用 `api.setLocale` 同步菜单，然后 `window.location.reload()` 让各设置页重新读取。reload 只影响 renderer，主进程里正在跑的任务不受影响。

## UI

设置 → 通用，新增分组「备份与迁移」：

- **导出设置…**：弹窗，勾选分区（默认全选）；开关「包含 API 密钥」（默认开），开启后必须输入并确认密码，下方灰字提示「密钥会用这个密码加密，忘记密码将无法导入密钥」。点导出弹出系统保存框，默认文件名 `AfterFrame 设置 2026-09-16.afsettings`。完成后提示「已导出 3 类设置和 5 个密钥」。
- **导入设置…**：先弹系统打开框，再显示摘要弹窗：分区勾选（每项列出服务商名，冲突项标「将覆盖」）、密码框、「导入」按钮。结果里列出警告，例如「人脸识别模型需在本机重新安装」。

文案遵循 zh 规范：不用 `——`；`.afcatalog` 称「目录」。

## 代码结构

| 文件 | 内容 |
| --- | --- |
| `electron/settingsTransfer.js` | 纯函数，无 Electron 依赖：`collectExport`、`encryptSecrets` / `decryptSecrets`、`parseBundle`、`summarizeBundle(bundle, local)`、`mergeBundle(local, bundle, { sections, tokens })` |
| `electron/settingsTransfer.test.js` | `node:test`：加解密往返、错误密码、AAD 篡改、白名单（不含 `lastCatalogPath` / `modelPath`）、按 id 合并、孤儿 token 过滤、版本过高拒绝 |
| `electron/ipc/settingsTransfer.js` | IPC：`settings:export`、`settings:import-inspect`（返回一次性 `importId`，文件内容缓存在主进程）、`settings:import-apply` |
| `electron/preload.js` / `src/api` | `exportSettings`、`inspectSettingsImport`、`applySettingsImport` |
| `src/api/browser/bridge.js` | P1 返回 unsupported，设置页在 web 壳里隐藏这一组 |
| `src/components/settings/SettingsTransfer.jsx` | 分组 + 两个弹窗，挂在 `GeneralSettings` |
| `src/i18n/*/settings` | en / zh-CN 文案 |
| `e2e/10-settings.spec.js` | 新增用例：配置假服务商和 token，导出（带密码），清空 userData，导入，断言服务商和「已配置」状态恢复；错误密码不写入 |

e2e 里系统保存 / 打开框走现有的 dialog stub 方式，文件放在临时目录。

## 分期

- **P1**（本方案）：桌面端导出 / 导入，合并语义，密钥可选加密。
- **P2**：Web 版读写同一格式（WebCrypto PBKDF2 + AES-GCM）；「整体替换」模式；导入前逐项对比差异。
