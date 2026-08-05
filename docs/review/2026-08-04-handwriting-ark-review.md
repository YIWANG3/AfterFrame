# Review：AI 手写贴纸 + Ark provider（0d42853 / af79e3d）

Reviewer: Claude（三路并行审查：sidecar Python / Electron 主进程 / 渲染层，逐条对照当前工作区核实）
范围：`feat(desktop): AI handwriting stickers, overlay layers, Ark provider` 与 `feat(sidecar): text-to-image jobs + Ark (Seedream) provider` 两个提交。

行号以 review 当时工作区为准，定位以函数名为主。

---

## P1（真实 bug）

- [x] **P1 CONFIRMED — Gemini 空 candidates 触发 IndexError**（已修：新增 `_gemini_response_parts()` 安全提取，repaint 与 t2i 两处共用，空 candidates 落入既有 "no image output" 诊断路径）
  `services/sidecar/src/media_workspace/ai_repaint.py:749`（`run_gemini_text_image`），同款老问题在 `run_gemini_repaint` :260。
  `response_payload.get("candidates", [{}])[0]` 只防了 key 缺失；Gemini 因安全策略拦截时返回 `{"candidates": []}`（用户任意手写文本下现实可遇），`[][0]` 抛 IndexError，job 的 error_text 变成 "list index out of range"，而不是走 :764 的 "Gemini returned no image output" 诊断路径。修复应同时覆盖 repaint 处。

- [x] **P1 CONFIRMED — OpenAI 带参考图时竖版 1:3 被映射成横版 16:9**（已修：`1:3` 显式映射 `9:16`，其余不认识的宽横比仍回退 `16:9`）
  `ai_repaint.py:798`（`run_openai_text_image` 带 ref 时委托 repaint）。
  `aspect_ratio if aspect_ratio in ("1:1","16:9","9:16","4:3","3:4") else "16:9"`：`"1:3"`（竖长条贴纸）落到 else 得 `"16:9"`，请求竖版拿到 1536×1024 横图。`"1:3"` 应映射 `"9:16"`（`"3:1"`→`"16:9"` 是对的）。

- [x] **P1 CONFIRMED — 已放置手写贴纸改色时两处缓存无界增长 + 每次拖动全尺寸 PNG 编码**（已修，三件套：`applyHandwritingFill` 按 layer 串行 + latest-wins 合并，编码频率降为编码耗时决定；`useStickerImageCache` 淘汰无图层引用的 data: URL 条目；undo 历史加 80 条上限。注：history 本就有 350ms 同签名合并，每手势一条而非每帧，原 review 表述偏重）
  `apps/desktop/src/components/editor/TextPanel.jsx:1387`（`applyHandwritingFill`）+ `state/useStickerImageCache.js:12`。
  PaintRow/取色器拖动的每个事件都跑一次 `canvas.toDataURL("image/png")` 生成新的数 MB data: URL；`useStickerImageCache` 按 `stickerPath` 缓存解码后的 Image 且永不淘汰，中间态 URL 的 base64 串和位图全部滞留。一次渐变拖动可滞留几十个全分辨率条目（轻松 100MB+），且逐事件 PNG 编码造成卡顿。修复方向：拖动中只走 canvas 预览，手势结束才编码；data: URL 缓存条目在无图层引用时淘汰。加重因素见 P3 的 history 无上限项。

## P2（应修）

- [x] **P2 CONFIRMED — Apply 与导出对 overlay 层的 crop 映射不一致**（已修：`handleTextApply` 烘焙前对 overlay 补 `overlayRect: normalizedCrop`，与 saveImage 语义一致；e2e 19-editor-layers 的 Apply 烘焙用例通过）
  `apps/desktop/src/components/EditorOverlay.jsx:456`（`handleTextApply`）对比 `render/saveImage.js:164`（`mapLayer`）。
  Apply 把图层原样交给 drawLayers，overlay 缺省 `{0,0,1,1}` = 整张未裁剪原图；导出和实时预览都映射到 `contentRect`。有裁剪时，渐变/边缘暗带在 "Apply 后再导出" 与 "直接导出" 得到不同的渐变切片。修复：`handleTextApply` 里对 overlay 补 `overlayRect` 映射（复用 `mapLayer` 逻辑）。纯色 fill 因均匀无可见差异，故日常不易发现。

- [x] **P2 CONFIRMED — handwriting-cache 无任何淘汰机制，单调增长**（已修：`trimHandwritingCache()` 按 mtime LRU 裁剪到 200MB，每次生成后 fire-and-forget；缓存命中时 utimes 提升 recency）
  `apps/desktop/electron/main.js:900`（cache 目录）+ `HandwritingModal.jsx:86`（`seedRef`）。
  每次 Regenerate 换 seed → 新 SHA1 键 → 新 0.3–2MB PNG；贴纸落地后烘成 data: URL，缓存文件从此无人引用。与 depth-cache 不同（按资产键控、有命中），seed-bump 条目几乎必成永久孤儿。建议：按 mtime 的 LRU 清理（启动时或写入时裁剪到 N MB）。

- [x] **P2 CONFIRMED — sidecar 新 t2i provider 与既有 repaint 大段复制粘贴**（已重构：`_gemini_generate()` 统一 Gemini 两径；`_post_image_api()` + `_extract_data_image()` 统一 OpenAI/Ark 三处 POST+提取；`_jimeng_client()` + `_jimeng_submit_poll_extract()` 统一 jimeng 两径（顺带加了连续 10 次轮询异常提前失败）；main.js 抽 `resolveProviderCredentials()`。ai_repaint.py 净减 ~140 行）
  `ai_repaint.py`：`b64_json`/url 提取+下载+mime 嗅探三处逐字重复（:406 / :839 / :924）；`run_gemini_text_image`（:693）与 `run_gemini_repaint`（:197）重复约 70 行（key 解析、payload、HTTP、错误处理、parts 循环）；`run_jimeng_text_image`（:986）复制了 repaint 的整套 submit/poll/extract（含 50430 重试）。任何 poll 修复现在要落两处。P1 第一条就是复制把老 bug 带进新代码的实例。桌面端同样有一处小重复：`main.js` `startTextImageTask`（:941）与 `startAiRepaintTask`（:828）的 provider 凭据解包，值得抽 `resolveProviderCredentials()`。

- [x] **P2 CONFIRMED — 模型列表 fallback 只捕获 (HTTPError, URLError)**（已修：三处改为 `(OSError, ValueError)`，覆盖 HTTPError/URLError/TimeoutError 与 JSONDecodeError/解码错误）
  `ai_repaint.py:44,:97,:120`。200 + 非法 JSON（`json.loads` 抛 JSONDecodeError）或 `response.read()` 中途超时（抛 `TimeoutError` 而非 URLError）会直接炸掉 `list-ai-models`，静态 fallback 表形同虚设。

- [x] **P2 CONFIRMED — dev 模式下模型列表不认环境变量 key**（已修：`_cmd_list_ai_models` 增加与生成链路一致的 env fallback 表；jimeng 列表本为静态，不再强制要求 key）
  `services/sidecar/src/media_workspace/cli.py:831`（`_cmd_list_ai_models`）。生成链路本次特意加了 env fallback（GEMINI_API_KEY 等），但列模型仍硬性要求存储 token，dev 下下拉框拉不到模型而生成却能跑，不一致。

- [x] **P2 PLAUSIBLE — Ark repaint 无 aspect_ratio 时回退小写 "2k"，疑似 400**（已修并实测：`_ark_size(aspect_ratio, image_size)` 现在在无 aspect 时把 size 档位透传为官方预设（"1K"/"2K"/"4K"），有 aspect 时像素 band 优先；`image_size` 不再被静默丢弃——repaint 常见路径（保持输入比例 + 用户选档位）从此生效。2026-08-04 用 SEEDREAM_API_KEY 实测 `"2K"` 预设：API 接受，返回 2048×2048 PNG）
  `ai_repaint.py:876`（`_ark_size`）。Ark 文档预设为 `"1K"/"2K"/"4K"`；若 API 大小写敏感，repaint 常见路径（保持输入比例、不传 aspect）全部 400。提交信息只声称验证过 WIDTHxHEIGHT 形式，需实测一次。顺带：`run_ark_repaint`（:970）接受 `image_size` 却静默丢弃（PLAUSIBLE→设计问题：要么支持要么别收这参数）。

- [x] **P2 CONFIRMED — apps/desktop 下未跟踪的 pnpm 残留**（已修：删除 `pnpm-lock.yaml` / `pnpm-workspace.yaml`；`package.json` 的 `pnpm.onlyBuiltDependencies` 保留）
  `apps/desktop/pnpm-lock.yaml`（5979 行）+ `pnpm-workspace.yaml`。后者还留着 pnpm 生成的占位符（`electron-winstaller: set this to true or false`），CI 用 `npm ci`，`package-lock.json` 才是权威。这是本地跑了一次 pnpm 的残留：要么删掉 + `.gitignore`，要么认真完成 pnpm 迁移（当前状态两头不靠）。`package.json` 的 `pnpm.onlyBuiltDependencies` 段无害可留。

## P3（可选优化 / 清理）

- [x] **P3 — 手写预设参考图 5.8MB 全部进仓库和安装包**（已修：pngquant `--quality=85-98` + oxipng `-o4`，5.8MB → 2.0MB（-66%），肉眼抽查 airyThin/brushScript 笔画与干刷纹理无损）
- [x] **P3 — 模态框关闭后轮询不停**（已修：`waitForTextImageJob` 接收 `isAlive` 回调、关闭即返回 null；matte 前也检查 aliveRef）
- [x] **P3 — 同类型双 provider 切换时 model 不重置**（已修：model 重置 effect 依赖加入 `providerId`）
- [x] **P3 — undo 历史无上限**（已修：`MAX_HISTORY = 80`，超限丢最旧条目；`baseSnapshotRef` 独立于 history，Reset 不受影响。逐层 stringify 比较保留，仅在 commit 时运行，成本可接受）
- [ ] **P3 — job 在 sidecar 启动即死时静默卡 queued**（`main.js:972` + `transport.js:252`）：spawn 无 exit 监听，argparse 拒绝（t2i 新增三个 enum 参数 + 独有的 3:1/1:3）或 python 起不来时 job 停在 queued，模态框永远转圈直到 10 分钟心跳收割（且收割仅在有人调 list-active-jobs 时跑）。repaint/import 同款旧模式，但 t2i 参数面更大，值得加 exit 处理或 main 侧参数校验。
- [x] **P3 — jimeng 轮询吞掉一切异常磨 180 次**（已修：`_jimeng_submit_poll_extract` 连续 10 次异常（~20s）即抛出，成功一次归零计数）
- [ ] **P3 — 死代码/小杂项（sidecar）**：~~`TEXT_IMAGE_ASPECTS` 定义后无引用~~（已删）；~~`jimeng_image2image_dream_inpaint` 分支 unused import + 重读字节~~（已清理，该分支保留）；`_openai_size_from_resolution` 的 `resolution` 形参从未使用；`_write_output_bytes`（:173）可能把 JPEG 写进 .png 扩展名；`run_text_image_job` 的 `catalog_path` 未用、无 cancel 检查（cancel 后仍被覆写为 succeeded，repaint 同款）；`quality` 参数除 OpenAI 外全部静默忽略；~~`volcengine` 未声明为依赖~~（已声明为 optional-dependency `[jimeng]`——注意当前 .venv 里并未安装，dev 下 jimeng 生成本就会 ModuleNotFoundError，要用需 `pip install -e .[jimeng]` 并纳入打包）。
- [x] **P3 — 渲染层清理**（已修：`canvas.scrim` 保留但加了 LEGACY 注释说明其定位；`mediaUrlFor` 两处副本删除，复用 `utils/format` 的 `localFileUrl`（本就是逐字相同）；matte 裁剪改用 `putImageData` dirty rect，省一张全尺寸中间 canvas；`alphaCache` 加 8 条 FIFO 上限；模态框预览直接画 canvas，PNG 编码推迟到 addToCanvas 一次）
- [ ] **P3 — HandwritingModal 两处值得抽取**（548 行整体尚可，不必仪式性拆分）：(1) 生成流程（generate + waitForTextImageJob + aliveRef/seedRef）抽 `useHandwritingGeneration` hook，顺手修上面的轮询取消；(2) provider/model 选择块（:129-174，与 AiRepaintPanel 的 prefs/modelsCache 处理近重复）抽共享 hook。合计约 -150 行。
- [ ] **P3 — 其余低风险备忘**：缓存键哈希 refImagePath 路径而非内容（用户原地改参考图会命中陈旧缓存，Regenerate 可绕过）；`.env` 解析正则 `^([A-Z_]+)=` 不认带数字的 key、不剥引号（当前 5 个 key 均安全，属潜伏）；`text-image-start` 的 running 检查与 createJob 之间存在 TOCTOU（UI 单按钮门控下难触发，双开会重复扣一次付费调用）；Ark 模型名清洗对无 name 字段/大写 Doubao- 前缀处理粗糙（仅外观）。

## 已核查无问题（含被驳回的怀疑，避免复查重复怀疑）

- **REFUTED：「alive guard 是被禁的 cleanup-only ref 守卫」** — `HandwritingModal.jsx:90` 在 effect 体内重新置 true，StrictMode mount→cleanup→mount 后仍为 true，是真取消守卫（只是覆盖面窄，见 P3）。
- **REFUTED：「memoized alpha 是虚的」** — 模态框内 `candidate.alphaCanvas` 驻留 state、改色只跑 colorize；落地后 `handwritingAlphaFromUrl` 按原始 URL 记忆化，拖动只 matte 一次。两处均属实。
- **REFUTED：「.env fallback 泄漏到渲染进程 / 打包版会触发」** — key 只进主进程 `process.env`；preload 仅暴露 invoke 包装，Electron 43 默认 contextIsolation/sandbox；`app.isPackaged` 门控正确且打包版路径落在 asar 内不存在。
- **REFUTED：「API key 出现在 ps 里」** — `transport.js:17` 把 `--api-key` 剥进 `MEDIA_WORKSPACE_API_KEY` 环境变量再 spawn，sidecar `cli.py:655` 还原。（sidecar 代理最初报 P3，经桌面端代理核实为已处理。）
- **REFUTED：「失败 job 污染 handwriting-cache」** — 各 provider 全量缓冲后仅在成功时一次性写盘，失败不落文件。
- **REFUTED：「poll_resp 可能未绑定」「json.loads(None) 崩溃」** — 均有赋值前 break 保护 / TypeError 在 except 元组内。
- Ark 像素映射数学全对：2560×1440 恰在 ≥3,686,400 下限，12 组尺寸均 16 的倍数、比例精确。
- key 不入日志：仅走 header（Gemini 用 `x-goog-api-key` 而非 query）；job payload 只记 `api_key_supplied` 布尔。
- `handwriting-preset-ref` IPC：`/^[a-zA-Z]+$/` 挡住路径穿越；dev/打包解析与 extraResources 一致。
- overlay 层排除逻辑（snap/对齐/basis 换算全部跳过 overlay）与 `overlayLayers.test.js` 覆盖一致；scrim 无双重应用；预览↔导出（未裁剪路径）参数逐项一致。
- i18n en/zh 扁平 diff 零缺失（含 19 个 handwriting.* key + 17 个风格名），zh 无 `——`。
- 新文件无 console.log/debugger/注释块，eslint 干净，无 ImageBitmap 泄漏（Apply 路径有 releaseCanvasImage）。
- e2e `24-handwriting.spec.js` 覆盖 mock provider 全链路（modal→sidecar job→matte→贴纸层），state dump 用 `stickerPathKind` 避免倾倒 data: URL，写法正确。

## 建议的修复顺序

1. 三个 P1（sidecar 两处各 ~3 行；改色缓存问题动 `applyHandwritingFill` 的节流 + 缓存淘汰，稍大）。
2. P2 里的 Apply/导出 overlay 映射、handwriting-cache 清理、pnpm 残留（前两个是用户可感知 bug，后一个 30 秒）。
3. sidecar 去重（修 P1 时顺手把 Gemini/下载提取块合并，jimeng poll 合并可单独一次）。
4. P3 按顺手程度捡。
