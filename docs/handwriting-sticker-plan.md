# AI 手写字贴纸(Handwriting Sticker)设计方案

> 2026-08-01 调研与三家 API 实测完成(gpt-image-2 / 即梦 4.6 / Gemini Nano Banana 2 & Pro,汉字准确率均 100%),本文档是集成设计。实测结论摘要见文末附录。

## 目标

用生图 API 生成手写体文字(毛笔、钢笔、签名、粉笔等风格),本地抠图上色后作为贴纸层加入编辑画布,突破内置字体(无中文书法字体,CJK webfont 体积过大)的限制。

## 管线总览

```
用户输入文字 + 选风格预设(参考图 + prompt 模板)
        │
        ▼
sidecar 新命令 run-text-image-job(t2i,可选参考图)
  → provider 生成「黑字白底」PNG → userData/handwriting-cache/
        │
        ▼
renderer 抠图上色(handwritingMatte.js,纯 canvas 像素运算)
  alpha = 255 - luminance(白点自适应)→ bbox 裁边 → source-in 上色
        │
        ▼
createStickerLayer({ stickerPath: dataURL, handwriting: {...} })
  → 免费继承拖拽/缩放/旋转/阴影/深度遮挡/undo/导出双管线
```

### 已锁定的技术决策

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 抠图方案 | 黑字白底 + 亮度反算 alpha | 飞白、枯笔是连续灰度,亮度反算天然变成连续半透明;可任意换色 |
| 绿幕方案 | 否决 | 细笔画抗锯齿边缘溢色,半透明飞白被硬性取舍 |
| 模型原生透明输出 | 不采用 | gpt-image-2 不支持;即使有,颜色被烤死,不如黑白灵活 |
| 抠图位置 | renderer canvas(非 sharp) | 实时预览换色;贴纸素材 1~2.7K 分辨率,canvas 路径无损失 |
| 白点处理 | 阈值 ~30 + 白点拉伸(直方图自适应) | Gemini 输出带实拍纸纹(灰白底),固定低阈值会留噪点 |

## UX 设计

**入口:加字面板(TextPanel)内新增「手写字」按钮**,与现有「贴纸」按钮并列,打开 `HandwritingModal`。选择理由:

- 生成结果是贴纸层,落在 text 工具的 TextCanvas 上操作,用户全程不离开加字上下文;
- 与 `StickerPickerModal` 模式一致(Sticker 工具生产、Text 工具消费的既有分工不被打破);
- 不新增 ToolRail 工具位,不动 `selectTool` 状态机。

**Modal 内部流程**(单屏,自上而下):

1. **文字输入**:单行文本框(Phase 1 限单行;Phase 3 支持两行错落/竖排);
2. **风格预设网格**:内置 6~8 个预设缩略图(狂草泼墨/行草/钢笔手写/签名/粉笔/花体英文等),每个预设 = 参考图 + prompt 模板;
3. **provider/model 行**:复用 `aiPreferences.providers` 列表(仅显示有 `textImage` 能力的),记忆上次选择,默认 Gemini(`gemini-3.1-flash-image`);
4. **生成按钮 + 候选区**:默认串行生成 2 张候选(Gemini 5~8s/张,可接受),网格展示,点选;
5. **颜色行**:纯色 + 渐变(复用 TextPanel 的 fill 控件风格),对选中候选实时预览换色(本地运算,毫秒级);
6. **「添加到画布」**:创建贴纸层并关 Modal;次要按钮「存入贴纸库」(走现有 `stickerSave` IPC)。

比例自动选择:按字数与排布推断,单行 ≤6 字用 3:1 宽幅,两行用 16:9,竖排用 1:3(宽幅笔画分辨率更高且更省 token)。

## 分层设计

### 1. sidecar(services/sidecar)

新命令 `run-text-image-job`,与 `run-ai-repaint-job` 平行(cli.py 注册 + job_runner 新函数)。参数:

```
--job-id --provider --output --prompt --model
--aspect-ratio --image-size          # 沿用 repaint 语义
--ref-image <path>                   # 可选,参考图风格迁移(Phase 2)
--quality <low|medium|high>          # 仅 openai 生效
--api-token / AK/SK 经现有 token 注入通道
```

`ai_repaint.py` 新增 `run_text_to_image()` 按 provider 分发,大量复用现有实现:

- **nanobanana**:现有 `generateContent` 调用,parts 里不放输入图(纯文本),有 `--ref-image` 时插入 `inline_data`。已实测通过。
- **openai**:无参考图走 `/v1/images/generations`(新增,几十行);有参考图走现有 `/v1/images/edits` multipart。`quality` 参数透传。
- **jimeng**:现有 submit+poll 原样,t2i 就是去掉 `binary_data_base64`,有参考图时加回。已实测通过。
- **openai_compatible**:同 openai,走配置的 base_url。
- **mock**:用 PIL `render_text_overlay` 的字体栈在白底上画黑字,供 e2e 与离线开发。

注意:repaint 的 CLI 强制 `--input`,本命令不需要输入图,所以是新命令而非改造旧命令,语义干净且不碰已验证代码。

### 2. Electron main(apps/desktop/electron)

`startTextImageTask(options)` 镜像 `startAiRepaintTask`(main.js:791):同一套 `getStoredProviderConfigWithMigration` token 解密、`createJob`/`latestJobStatus` 生命周期、sidecar spawn。差异:

- 输出不落在照片旁,统一进 `userData/handwriting-cache/<sha1(params)>.png`(同 depth-cache 模式,main.js:1245 处注册目录),`addAllowedMediaDir` 一次即可;
- 同参数重复请求直接命中缓存返回,不再扣费;
- job 类型 `text_image`,与 `ai_repaint` 互不阻塞排队逻辑分开(即梦账号并发为 1,job runner 单任务串行天然规避 50430;候选 N 张就是 N 次串行 job)。

preload.js 桥接:`startTextImage` / `getTextImageStatus` / `listHandwritingHistory`。

### 3. renderer 抠图上色(新模块)

`src/components/editor/render/handwritingMatte.js`:

```js
// 结构模板:canvasHelpers.js buildDepthAlphaMask(逐像素 ImageData)
//           + frameLogos.js prepareLogo(source-in 上色)
matteHandwriting(img)            // → { alphaCanvas, bbox }
//   白点自适应:取亮度直方图 220..255 区间峰值为纸面基准,
//   alpha = clamp((white - lum) / (white - black) * 255),低于阈值截 0
colorizeHandwriting(alphaCanvas, fill)  // fill: 纯色或渐变 → dataURL
```

换色是对缓存的 alphaCanvas 重跑 colorize,不重新抠图,实时预览无压力。

### 4. 图层模型(textState.js)

`createStickerLayer` 不动,新增可选元数据字段(向后兼容,序列化透明):

```js
handwriting: {
  rawPath,        // 黑白原图缓存路径:换色、「写同款」的依据
  text, styleId, provider, model,
  fill,           // 当前上色(与 stickerPath dataURL 对应)
}
```

带此字段的贴纸层,TextPanel 选中时显示「换色」与「写同款」快捷操作(Phase 2)。渲染路径(TextCanvas / drawLayers.js)零改动。

### 5. provider 注册(src/components/ai/providers.jsx)

`PROVIDER_TYPES` 每项加 `capabilities: ["repaint", "textImage"]`(四种类型都双能力);`HandwritingModal` 据此过滤。`nanobanana` 的 `defaultModels` 需补 `gemini-3.1-flash-image` 与 `gemini-3-pro-image` 正式 id。设置页无需新 tab,现有 RepaintSettings 管理的就是同一批实例。

### 6. 风格预设(新资产)

`src/components/editor/handwriting/styles.js` + `assets/handwriting-styles/*.png`:

```js
{ id: "brush-wild",  nameKey: "handwriting.styles.brushWild",
  thumb, refImage,          // 本次实测的优质输出可直接作为内置参考图(AI 生成,无版权问题)
  promptTemplate,           // 含 {text} 占位 + 禁止印章/落款/装饰的固定尾缀
  aspectHint: "wide" }
```

Phase 2 增加两类动态预设:「写同款」(任意已生成手写贴纸 → 用其 rawPath 当参考图)、「我的笔迹」(用户导入手写样例存入贴纸库)。

## 分阶段计划

**Phase 1(MVP,可独立发布)— 2026-08-01 已完成**
- [x] sidecar `run-text-image-job`(nanobanana/openai/jimeng/openai_compatible/mock,纯 t2i;`--ref-image` CLI 已就位供 Phase 2)
- [x] main.js `startTextImageTask` + handwriting-cache + preload 桥接
- [x] `handwritingMatte.js`(自适应白点抠图 + 上色 + 裁边)
- [x] `HandwritingModal`(输入/预设/provider 只选不配 + 未配置提示去 Settings/双候选/颜色/添加)+ TextPanel 入口
- [x] 内置 6 个风格预设(纯 prompt 模板,暂不带参考图)
- [x] i18n(en / zh-CN)+ e2e(24-handwriting.spec.js,mock provider 全链路:生成→抠图→成层)

Phase 1 实现备注:job 类型 `text_image` 需同步加进 cli.py 三处 `--job-type` choices;读生成图像素前必须 `img.crossOrigin = "anonymous"`(Electron 43 canvas 污染);e2e 给 aiPreferences 注入 mock provider 要走 `saveAiPreferences` IPC(直接写 settings.json 会和启动写入竞态)。

**Phase 1.5(2026-08-01 优化轮,已完成)**
- [x] 双语 prompt:按输入文字语言(CJK 检测)选中文/英文模板,绝不翻译用户文字
- [x] 参考图模式:`workspace:pick-handwriting-ref` 文件选择 → `--ref-image` 全链路;设置参考图时忽略风格预设(UI 置灰),用 ref 专用双语模板
- [x] 预设卡片改「缩略图 + 名称」;缩略图为本管线自产的白字透明 PNG,放 `src/assets/handwriting-styles/<id>.png`,直接覆盖文件即可换图
- [x] 单候选生成(重新生成时 seed 自增避开参数缓存)
- [x] 自定义 Prompt(常驻可见,预设/参考图选择会回填模板,`{text}` 占位符联动文字框,原样发送;误删 `{text}` 有琥珀色警告 + 一键补回)
- [x] **预设升级为参考图型**(2026-08-02):自产样张(gpt-image-2 生成,无版权问题)作为内置参考图(`handwriting-presets/`,extraResources,frame-logos 同款 dev/packaged 解析)+ 白字透明缩略图;点预设即走图生图参考路径。实测参考图模式保真度远超纯文字模板(gpt-image-2 > 即梦 4.6 > Gemini flash),且模型模仿自产样张的保真度最高。换预设 = 同时覆盖 `handwriting-presets/<id>.png` 与 `src/assets/handwriting-styles/<id>.png` 并更新 styles.js 的 `desc`。
- [x] **预设定型为「v2 配方」**(2026-08-02):每个预设 = 内置参考图 + 专属风格描述(`desc`,从灵感海报口令提取改写,文字/装饰/黑底要求剥离)。生成时参考图走图输入,`promptForPreset` 把 desc 组装进 prompt 框(可见可改)。对照实验:参考图+口令描述(v2)> 仅参考图(v1)> 仅文字模板。现有 17 个预设(15 中文 + 2 英文);灵感海报在 RESOURCES/Handwriting,仅调研用未入库,自产样张由「海报裁字区做一次参考 + 提取口令」二次生成而来。
- [x] dev 密钥兜底:主进程 dev 模式加载仓库根 `.env`;sidecar job runner 不再硬性要求 api key(provider 层走环境变量回退)

**血泪 gotcha(调试一晚换来的)**:
- `useEffect(() => () => { ref.current = false }, [])` 这种 cleanup-only 守卫会被 **React StrictMode 的 dev 双调用永久锁死**(生产构建无此问题 → e2e 全绿但 dev 必挂),effect 体内必须重新置 true;
- e2e 跑的是生产构建 + mock provider,与 dev 模式 + 真实 provider 是两个正交维度,新功能必须在 dev 下真实过一遍;
- 调试日志别用 `console.debug`(DevTools 默认 Default levels 不显示 Verbose);
- 打包版 safeStorage 的钥匙串条目按签名身份授权,dev 二进制读不了(升级 Electron 后需重新授权),dev 用 `.env` 兜底;
- Gemini imageConfig 不支持 3:1/1:3,需映射到 16:9/9:16(sidecar 已处理)。

**Phase 2(风格能力)**
- [ ] `--ref-image` 参考图迁移(三家已实测)+ 预设带内置参考图
- [ ] 「写同款」/「我的笔迹」/ 换色快捷操作(handwriting 元数据)
- [ ] 存入贴纸库 + 生成历史(沿 RepaintHistory 模式)

**Phase 3(打磨)**
- [ ] 两行错落 / 竖排排布,比例自动化完善
- [ ] 候选数可调 + Gemini 并行生成(job runner 支持并发类型后)
- [ ] 成本提示(openai medium/high 档)与失败重试 UX

**周边功能(2026-08-02)**
- [x] 排版控制:文字中 `/` 强制换行(prompt 指令,不画出符号);无 `/` 时长句按标点自动断两行错落,短句单行(LAYOUT_ZH/EN 组装进所有模板;`/` 存在时 aspect 固定 16:9)。已实测两种模式均生效。
- [x] **填充体系与文字层对齐**:弹窗内填充升级为纯色 + 线性渐变(同款 ColorPickerPopover,双停靠点独立透明度 + 角度);**已放置的手写贴纸可在 Inspector 里继续改填充**(`applyHandwritingFill`:从 handwriting.rawPath 重新抠图上色换 dataURL,alpha 按源路径 memoize);阴影与描边本就与贴纸层共用(描边为纯色 alpha 膨胀)。
- [x] **ark provider(火山方舟 Seedream)**:新 provider 类型,Bearer API Key(与即梦 AK/SK 是两套凭证);`/api/v3/images/generations` JSON 协议,t2i + 参考图/重绘全部实测通过(image 参数接受 base64 dataURL);**模型列表动态化**:GET `/api/v3/models` 可用(过滤 seedream + 非 Shutdown),硬编码表仅作兜底;`size` 必须用 `WIDTHxHEIGHT` 像素或 1k/2k/4k(比例字符串会被拒),且 Seedream 4.5+ 要求 ≥3,686,400 像素(_ark_size 已按比例映射);手写字与 AI 重绘双通道接入;dev 兜底 `ARK_API_KEY`(`SEEDREAM_API_KEY` 自动别名)。**保真度实测:5.0 Pro ≈ gpt-image-2 > 4.5**,手写字在 ark 下默认 5.0 Pro。
- [x] ~~文字工具「蒙层」Section(canvas.scrim fill 型)~~ → **已重构为 overlay 图层**(2026-08-04):蒙层是一等图层(`createOverlayLayer`,kind fill/edge),LAYERS 区 Blend 图标添加、可叠多层、可与文字/贴纸拖序、PaintRow 调填充、**Apply 随层烘焙**(修复「Apply 后切裁剪页蒙层消失」);frame 预设的 edge scrim 同样转为 overlay 图层(fromPreset),`canvas.scrim` 仅存量兼容。
- [x] 手写字弹窗:文字输入框加高(h-11/14px)、预设折叠为单行横滚 + chevron 展开全网格。

## 风险与 gotcha

- **Electron 43 canvas 污染**:抠图走 `getImageData`,素材必须经 `media://` 白名单目录加载(handwriting-cache 已注册),不能直接 `file://`(见 docs/electron-43 相关记录);
- **即梦并发 1**:严格串行,UI 上候选生成显示队列进度,不做并行请求;
- **Gemini 纸纹背景**:必须用自适应白点而非固定阈值,否则贴纸带灰噪;
- **导出分辨率**:贴纸走 canvas 导出路径,上限为 sourceImage 分辨率(saveImage.js:88 fast path 仅限无图层),与现状一致,无回归;
- **prompt 固定尾缀**:「不要印章、不要落款、不要英文、不要任何装饰」必须保留,书法类 prompt 模型有加红章倾向。

## 附录:三家 API 实测摘要(2026-08-01)

| Provider | 模型 | 速度 | 特点 | 注意 |
| --- | --- | --- | --- | --- |
| Gemini(默认) | gemini-3.1-flash-image / gemini-3-pro-image | 5~8s / 15s | 最自然,Pro 签名感最佳,实拍纸面质感 | 纸纹背景需自适应白点 |
| 即梦 | jimeng_seedream46_cvtob | 11~15s | 笔锋锐利,风格词响应强 | API 无 4.7;并发 1(50430) |
| OpenAI | gpt-image-2 | low 13s / medium 40s | 墨溅飞白肌理最佳,风格多样 | 不支持 transparent(无影响);low 档已可用($0.006) |

参考图风格迁移三家均验证通过,对自然度提升决定性。测试脚本与样张:会话 scratchpad(gen_calligraphy.py / gen_jimeng.py / gen_ref.py / gen_gemini.py)。
