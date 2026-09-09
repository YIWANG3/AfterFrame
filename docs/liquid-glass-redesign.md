# 视觉重构:调研、原型与定调(Liquid Glass 专题)

日期:2026-08-28 起,持续迭代中;2026-09-06 做了一轮复审优化(见「〇」)。目标:不动功能,把 AfterFrame 的 UI 做一次大的视觉重构。起点是 Apple Liquid Glass(iOS 26 / macOS Tahoe),经过多轮原型与取舍,演化为「以减法为核心的黑白极简 + 内容驱动的玻璃材质」的方案。

## 〇、2026-09-06 复审:优化摘要

复审方法:重读全文 + 盘点真源码(index.css / tailwind.config / Button / Modal / App 布局 / Gallery 虚拟化 / Toolbar 折叠 / FilterBar / useWorkspace 主题)+ 在 web-shell 里实跑定稿 mock(浅深两主题、选中、筛选展开、滚动)。结论:方向不用动,但方案有五处「悬置」和七处「落地会翻车」的点,本轮全部收成可执行的规则。

| # | 优化 | 落点 |
|---|---|---|
| 1 | **材质终局给出推荐**:不再三选一悬置,改成一条规则「玻璃只给有内容从它下面经过的层」;侧栏、检查器实色(P3 交给系统 vibrancy) | 四、五 |
| 2 | **全 App 表面清单**:14 类表面逐一定材质 / 圆角 / 阴影 / 阶段,避免「新 Gallery + 旧编辑器」割裂 | 六 |
| 3 | **token 三层架构**(颜色 / 材质 / 圆角分离)+ 用量数据:P0 只改两个文件即吃掉约七成改动;新增 `--accent-ink` 修掉浅色主题下按钮文字隐形的硬伤 | 七 |
| 4 | **响应式折叠策略**:mock 没有折叠;实测默认 1440 窗口 + 检查器滑入后工具栏已放不下,折叠是必需项不是加分项 | 八 |
| 5 | **对比度整改**:浅色 muted2 实测约 2.2:1 不达标,给出新数值与「玻璃上文字层级」规则 | 九 |
| 6 | **性能与动效定值**:玻璃 blur 默认 30 违反自家 ≤ 20 红线,统一定值;静止时卸载 scrim 的 backdrop;噪点层 P0 撤;检查器滑入改「transform + 单次重排」 | 十 |
| 7 | **滚动条**:原建议「还原系统 overlay 条」经 Electron 实测作废(接鼠标时是常驻粗条),定稿为自定义纤细 hover 显条 | 十.4 |
| 8 | **P3 窗口坑补齐**:`nativeTheme.themeSource` 必须跟随 App 主题、全屏时顶部让位、splash 与透明窗、`system` 主题模式 | 十一 |
| 9 | **mock 缺陷清单**:选中环在检查器滑入后丢失(已修)、筛选行「重置」被裁、底部无渐隐、标题在浅色下无保护 | 十二 |
| 10 | **各阶段验收标准**,拍板项收敛为两条 | 十三、五 |

**2026-09-06 晚 · 用户看过 Electron demo 后的五条追加定调**(已落到 demo):① 侧栏 / 检查器改 Tahoe 系统 App 式**内缩圆角面板**,底色比舞台略亮;② 滚动条**纤细、hover 才现**,自定义而非依赖系统 overlay;③ 玻璃**去投影去高光**,只留 1px 发丝边;④ 检查器按真实字段重做(属性 / AI / 源文件 / 相机 / 曝光 / 日期 / 位置,可折叠);⑤ 设置改整页弹窗,按真实设置页结构。详见四.9、六、十.4、十二。

## 一、当前状态(TL;DR)

- 已产出一个**可交互的最终候选设计**:Gallery 单页、深浅双主题、纯黑白、无投影、无分割线、胶囊工具栏(完整收纳现有全部功能)、检查器点选滑入、滚动驱动的顶部渐进模糊。
- 已产出一个**原生 Electron demo 窗口**(hiddenInset + under-window vibrancy + 透明背景),验证了 P3 窗口级玻璃,并在其中演化出「贴边分栏 + 全窗统一半透底」的结构。
- 设置弹出层内置**「玻璃 / 实色」材质开关**与玻璃调参(模糊 / 乳化 / 饱和),供最终拍板。
- 复审后**推荐方案:实色为主,玻璃只上浮层**(规则见四.6),待用户确认;深浅主题细节按九、十二整改后再终审。

## 二、调研结论(仍然有效)

**设计语言**:Liquid Glass 三层结构(高光 / 阴影 / 光照),核心是 lensing(背景在玻璃边缘透镜式折射),不是老式毛玻璃的单纯模糊。纪律:玻璃只上导航与控件层,内容永远在玻璃下;Clear 变体只用于媒体上的纯控件;忌玻璃叠玻璃;需响应「减少透明度 / 对比度 / 动态」。

**Web 技术路线**:基线 `backdrop-filter: blur+saturate`(九成效果);真折射 = `backdrop-filter: url(#SVG滤镜)` + `feDisplacementMap` + 运行时 canvas 生成 SDF 位移图。折射仅 Chromium 稳定,Electron 天然可用,web 构建降级为基线。

**性能红线**:blur ≤ 20px 常态、同屏大玻璃面 ≤ 4、永不动画化 blur、照片网格本体绝不上玻璃。

**现状代码盘点**(2026-09-06 复核):视觉几乎全部收口于 `apps/desktop/src/index.css`(token,RGB 三元组)+ `tailwind.config.js` + `src/ui/Button.jsx` + `src/ui/Modal.jsx` 四个文件;`editor/components/PanelChrome.jsx`、`ToolRail.jsx` 已是半玻璃(`backdrop-blur-xl`);主题机制是 `data-theme` 属性 + CSS 变量,且已支持 `dark | light | system` 三态(`useWorkspace.js` 用 matchMedia 跟随系统)。BrowserWindow 未开 vibrancy / hiddenInset,主进程也未设 `nativeTheme`(`electron/main.js` createWindow),窗口级玻璃属 P3 主进程改动。Gallery 是自研虚拟化网格(绝对定位 + ResizeObserver 量宽),Toolbar 已有容器查询折叠(`.app-toolbar` 两档)。

## 三、原型演进与每轮定调(重要:这些是走过的弯路和结论)

**R1 · 独立 mock(scratchpad lg-demo/v1.html)**:完整折射引擎(SDF 位移图 + 指针高光 + Regular/Clear + 调参面板)。结论:折射可行、参数顺手(scale 60 / blur 10 / sat 1.35 / bezel 19)。用户反馈:与真实 App 差距太大,要 1:1。

**R2 · 真实 web 版注入(public/lg-inject.js)**:跑起真实 web 构建(web.html + browser bridge),导入真照片,零源码改动注入玻璃皮肤。两个关键发现:
- **纯 CSS 玻璃即九成效果,落地成本极低**(几十行 CSS 命中现有 Tailwind 类);
- **Chromium 合成器 bug:`backdrop-filter: url(#feImage位移滤镜)` 与照片网格同屏会把 img 层画黑**(独立 mock 不触发)。折射由此降级为 P2 风险项,需 Electron 43 复测。

期间被否决的方案:模糊壁纸模拟 vibrancy(「花花绿绿不合理」)、跟随选中照片的 ambient 光晕(「会乱」)。定调:**玻璃必须内容驱动,不引入无来由的装饰背景**。

**R3 · 概念实验室(public/lg-lab/:canvas / studio / cinema)**:抛开现有壳的三个自由方向。用户均不满意,但沉淀出可用元件:Photos 式胶囊岛、单条指挥台、影院模式的渐隐处理。

**R4 · Gallery 定稿页(public/lg-lab/gallery.html)**:聚焦单页 + 深浅双主题,逐轮采纳:
- **纯黑白单色**:弃用黄铜金 accent;深色版 accent = 白,浅色版 = 近黑,颜色只来自照片;
- **浅色主题中性化**:弃用现有 App 的暖米「纸感」,改纯白灰(#f4f4f5 / 玻璃纯白 / 文字 #1d1d1f),正式落地时浅色 token 全套换血;
- **无投影**:Apple 玻璃不打影子,层级靠材质明度差与边缘高光;缩略图也扁平化;仅瞬时浮层保留微影;
- **减线**:缩略图去描边(仅选中留环)、面板内零分割线、输入框无边框纯填充;
- **demo / 设置类控件一律收进左下角设置弹出层**(外观、材质、玻璃调参),不干扰画面;
- **滚动条**:原生条撤掉,换 macOS 式悬浮细指示条(滚动时现,停后隐)。复审两次修正:先想还原系统 overlay 条,实测接鼠标时是常驻粗条,最终定为自定义纤细 hover 显条,见十.4;
- **顶部渐进模糊**(Photos 同款):blur + 渐变 mask;且**滚动驱动**(静止时完全干净,滚动 90px 内淡入),否则静止时有生硬白带;
- **工具栏完整收纳现有功能**:布局四模式分段 / 地图 / 搜索 / 排序下拉 / 筛选(展开完整 chips 行:相机 / 镜头 / 标签 / 格式 / 含人脸 / AI 标注 / 人物 / ISO / 光圈 / 焦距 / 日期 / 星级)/ 后台活动浮层 / 刷新 / 导入;缩略图大小在右下角缩放胶囊;
- **检查器默认隐藏**,点照片滑入(列宽 + 位移 + 透明度 300ms),点空白收回;大图充满顶端、底部 mask 渐隐融入面板(无切线无灰边)。

**R5 · Electron 原生窗口 demo(lg-demo-electron/)**:复用 apps/desktop 的 Electron 43,`titleBarStyle:"hiddenInset"` + `vibrancy:"under-window"` + `visualEffectState:"active"` + 透明背景,加载定稿页。结构三连跳:
- 浮卡 + 12px 衬边 → 用户嫌左右不一致、衬边多余;
- 贴边分栏(Tahoe 访达式)→ 仍有侧栏 / 内容双色块分割;
- 全窗统一半透底(一层材质,分区只靠留白与内容),红绿灯落在材质上,顶部 34px 可拖拽;
- **最终(2026-09-06 用户对照系统设置 / Music 后定):只有侧栏是内缩圆角面板**,底色比舞台略亮(深色 white 5.5%、浅色 white 62%),红绿灯落在面板内;**检查器不套框**,贴边透明,大图顶到窗口角由窗口圆角裁切(与系统设置「只有侧栏是框」一致);内容区顶满。面板圆角 / 内缩已做成 demo 滑杆(`--pane-r` / `--pane-inset`,默认 20 / 8),**具体数值等用户对着窗口拨定后回填**,目标仍是「内层圆角 = 窗口圆角 − 内缩」。
- 同心圆角原则:**内层圆角 = 窗口圆角 − 内缩距离**(Tahoe 窗口约 26px);贴边方案下圆角全部交给窗口,问题消失。

## 四、已冻结的设计定调清单

1. 纯黑白单色,颜色只来自照片;浅色主题中性化(告别暖米)。**功能状态色(成功 / 警告 / 错误)豁免,但去饱和;星级、进度等「强调」一律单色**(见七.3)。
2. 无投影;层级靠材质与明度差;仅瞬时浮层(菜单、Toast、Modal)可留微影。
3. 减线:无分割线、无描边框、输入控件纯填充胶囊。唯一允许的线:侧栏 / 检查器拖拽把手 hover 时的瞬时细线。
4. 圆角体系升级:小控件 10 / 菜单胶囊 14 / 大面板 18;正式落地改 tailwind `borderRadius` 的 md / lg / xl 定义(见七);贴边结构下外层圆角交给窗口。
5. 工具栏 = 裸标题(副标题带计数)+ **三组胶囊 + 一个主操作**(HIG:分组 ≤ 3、一个 prominent 在尾部):[布局分段] [搜索] [地图 · 筛选 · 排序 · 缩放 · 后台活动 · 更多] + 导入;设置在「更多」里(HIG:侧栏底部不放操作);无底栏;检查器按需滑入;顶部渐进模糊滚动驱动,每个滚动视图只一条。**工具栏必须带折叠策略**(见八)。
6. **材质分配规则(复审新增,替代「玻璃 / 实色 / 折中」三选一)**:玻璃只给「有内容从它下面经过」的层,即工具栏胶囊、筛选行、底部胶囊、渐进模糊带、弹出层、Toast;侧栏与检查器下面永远是固定舞台,上玻璃只花性能不换效果,一律实色(P3 由系统 vibrancy 透桌面)。Clear 只给媒体上的控件(Lightbox、地图标记)。设置里保留实色回退,并自动响应 `prefers-reduced-transparency`。
7. demo / 偏好控件全部收进设置弹出层;设置弹出层必须含「系统」主题项(现有 App 已支持三态)。
8. 动效只做交互反馈,无入场编排;时长 ≤ 220ms(见十.3)。
9. **玻璃不做拟物**:无外投影、无顶部高光渐变,只留 1px 发丝边;分段控件的选中块也不打影;唯一的影是瞬时浮层(菜单 / Toast / Modal)的微影。
10. **侧栏 = 内缩圆角面板,检查器 = 贴边不套框**(见三.R5 最终);不是双面板,也不是浮卡加衬边。

## 五、待拍板(收敛为两条)

- **材质:是否接受四.6 的分配规则作为终局。** 推荐接受。理由:① 它同时是「折中」方案的精确定义,Electron demo 里侧栏 / 检查器已经是透明吃 vibrancy,实际就是这个形态;② 玻璃面积从两大块整列缩到几条胶囊,同屏大玻璃面 ≤ 2,性能红线自然满足;③ 深色主题下大面积深玻璃叠深舞台只会发闷,实测 mock 深色侧栏文字明显灰暗。Electron demo 设置里仍可即时 A/B。
- **折射(lensing)**:受 Chromium bug 限制,最多只给小面积浮层(菜单、Toast),P2 在 Electron 43 复测后再定;不阻塞 P0 / P1。

以下不再需要拍板,按本文档执行:深浅主题细节(九、十二)、玻璃参数(十.1)、字体(七.5)。

## 六、全 App 表面清单(材质 / 圆角 / 阴影 / 阶段)

Gallery 之外的表面在原方案里没有定义,直接落地会出现「新 Gallery + 旧编辑器」的割裂。以下逐一定义;「同底」指与舞台同一层材质,不另起色块。

| 表面 | 材质 | 圆角 | 阴影 | 阶段 |
|---|---|---|---|---|
| 舞台(App 底,`--app-bg`) | 实色中性渐变;P3 改系统 vibrancy | 窗口 | 无 | P0 |
| 侧栏 | 内缩 8px 圆角面板,`--pane` 略亮填充;条目 hover / 选中用 alpha 填充 | 18 | 无 | P1 |
| 检查器 / 人物检查器 / 贴纸检查器 | 贴边、同底透明,不套框;hero 大图顶到窗口角、底部 mask 渐隐;分节可折叠 | 0(窗口裁) | 无 | P1 |
| 工具栏三组胶囊(布局 / 搜索 / 图标簇)+ 导入主操作、筛选 chips 行 | Regular 玻璃 | 999 | 无 | P1 |
| 顶部渐进模糊带(每个滚动视图只一条,无底部带;**横跨整个窗口宽、压在浮动侧栏之下**,侧栏与内容的缝里看到的是同一条带,内容区左缘无竖直起点线) | 玻璃 + 渐变 mask,滚动驱动 | 无 | 无 | P1 |
| 菜单、下拉、右键菜单、人物 picker、筛选 popover | Regular 玻璃 | 14 | 微影 | P1 |
| Toast / JobDock / 后台活动浮层 | Regular 玻璃 | 14 | 微影 | P1 |
| Modal(确认、设置、欢迎、provider / style 弹窗) | 实色卡 + 背景压暗(`Modal.jsx` 一处改完) | 18 | 微影 | P0 |
| 缩略图 | 扁平无描边;选中 = 2.5px 单色环 + 角标 | 10 | 无 | P1 |
| 拖放覆盖、框选矩形 | 单色:`text/40` 边 + `text/8` 填 | 18 / 4 | 无 | P0 |
| Lightbox 工具条、导航、slider、proof 切换 | Clear 玻璃(全 App 唯一 Clear) | 999 | 无 | P2 |
| 编辑器 ToolRail / PanelChrome / TextPanel / 贴纸 / 重绘面板 | 实色同底(现有 `backdrop-blur-xl` 半玻璃降为实色,与检查器一致) | 14 | 无 | P1 后半 |
| 拼图叠层、批量面板 | 实色同底 | 18 | 无 | P1 后半 |
| 地图抽屉 / 照片聚合标记 | 抽屉同底;标记 Clear | 999 | 无 | P2 |

编辑器降玻璃的理由:编辑器面板下面是固定画布底色,不是流动内容,与四.6 规则一致;同时避免编辑器成为全 App 唯一「玻璃叠玻璃」的地方(面板上再弹菜单)。

## 七、token 三层架构与迁移策略

### 7.1 用量盘点(src/**/*.jsx,2026-09-06)

| 类 / token | 文件数 | 命中 | 迁移方式 |
|---|---|---|---|
| `rounded-md` | 40 | 192 | tailwind 重定义 md=10,零改动 |
| `rounded-lg` / `rounded-xl` | 24 / 11 | 62 / 17 | 重定义 lg=14、xl=18,零改动 |
| `border-border` | 48 | 223 | P0 把 `--border-color` 改为 `text/8%` 全局淡线;P1 逐组件删 |
| `bg-app` / `bg-chrome` / `bg-panel*` | 38 / 26 / 11 | 118 / 48 / 23 | 换 token 值,零改动;P1 把「色块分区」处改同底 |
| `accent` 系(`text/bg/border-accent`、`--accent-color`) | 50 | 209 | 分三桶处理,见 7.3 |
| `shadow-overlay/menu/lg` | 24 | 35 | token 值改微影;非浮层处 P1 删 |
| `backdrop-blur-*` | 11 | 12 | 换成材质 token 类 `.mat-glass` / `.mat-clear` |
| `noise-overlay` | 1 | 1 | P0 直接删 |

结论:**P0 是一个「只改 index.css + tailwind.config + Button + Modal」的 PR**,不碰任何业务组件,就能拿到圆角、配色、去线、去影的七成效果;P1 再做结构。

### 7.2 三层 token

```css
/* 颜色层:沿用 RGB 三元组,tailwind 的 <alpha-value> 语法不变 */
:root {                       /* dark */
  --app-bg: 14 14 17;   --chrome-bg: 19 19 23;   --panel-bg: 24 24 28;
  --text-color: 242 242 242;
  --muted-text: 242 242 242;  --muted-a: .62;      /* 见九 */
  --muted-text-2: 242 242 242; --muted2-a: .46;
  --accent-color: 245 245 245;  --accent-ink: 20 20 20;    /* 新增:accent 上的文字色 */
  --fill: 255 255 255 / .07;  --fill-hover: 255 255 255 / .11;  /* alpha 填充替代 hover-bg 实色 */
  --border-color: 255 255 255;  --border-a: .08;   /* P0 全局淡线 */
}
:root[data-theme="light"] {
  --app-bg: 244 244 245;  --chrome-bg: 253 253 254;  --panel-bg: 255 255 255;
  --text-color: 29 29 31;  --muted-a: .66;  --muted2-a: .5;
  --accent-color: 29 29 31;  --accent-ink: 255 255 255;
  --fill: 29 29 31 / .06;  --fill-hover: 29 29 31 / .10;
  --border-color: 29 29 31;  --border-a: .08;
}

/* 材质层:与颜色无关,只描述「玻璃怎么做」 */
:root {
  --mat-blur: 20px;  --mat-sat: 1.4;
  --mat-alpha: .6;                       /* light: .66 */
  --mat-glass: rgb(var(--chrome-bg) / var(--mat-alpha));
  --mat-hi: rgba(255,255,255,.09);       /* light: .9 */
  --mat-edge: rgba(255,255,255,.05);     /* light: rgba(0,0,0,.06) */
}
:root[data-material="solid"],
@media (prefers-reduced-transparency: reduce) { :root {
  --mat-blur: 0px;  --mat-sat: 1;  --mat-alpha: 1;
} }
.mat-glass { background: var(--mat-glass); backdrop-filter: blur(var(--mat-blur)) saturate(var(--mat-sat));
  box-shadow: inset 0 1px 0 var(--mat-hi), inset 0 0 0 1px var(--mat-edge); }
.mat-clear { /* 媒体上的控件:更透、无乳化、白字 + 深描边保证可读 */ }

/* 圆角层:tailwind.config borderRadius */
/*   sm: 6, md: 10, lg: 14, xl: 18, app: 10, full: 9999 */
```

`data-material` 由设置写在 `<html>` 上(与 `data-theme` 同机制),web 构建同样生效;Safari 需要 `-webkit-backdrop-filter` 前缀(Safari 18 前)。

### 7.3 accent 的三桶

209 处 accent 用法要分类处理,否则黑白化后会出硬伤:

- **选中 / 激活态**(侧栏选中、chip 激活、开关):直接吃新 accent(白 / 近黑),无需改代码。
- **accent 上的文字**:`Button.jsx` primary 与 `Toolbar.jsx` 筛选计数徽标硬编码 `text-black`;浅色主题 accent 变近黑后文字直接隐形。**改为 `text-[rgb(var(--accent-ink))]`,P0 必修。**
- **功能色伪装成 accent**:`Inspector.jsx` 星级硬编码 `rgb(225,180,105)`、`Gallery.jsx` 缺失原图徽标硬编码棕色、`.ai-generating-btn` 金色 shimmer、`--glow-accent`。规则:星级改单色实心 / 空心;shimmer 改单色明度扫光;缺失徽标用 `warn` 功能色;`glow` token 删除。

### 7.4 P0 迁移顺序

1. 替换 index.css 两套主题 token(含浅色中性化)+ 材质层 + `data-material`;
2. tailwind.config:`borderRadius` 重定义,`colors` 增 `accentInk` / `fill`,`boxShadow` 改微影;
3. Button:primary 文字用 accent-ink,secondary 去 border 改 fill,ghost / icon 改胶囊(`rounded-full`);
4. Modal:卡片去 border,`rounded-xl`(=18),backdrop 压暗 `bg-black/40` 不加 blur;
5. 删 `.noise-overlay`、`.accent-line`;
6. 跑一遍 e2e + 深浅两主题截图对比。

### 7.5 字体(决定)

现状:正文 Plus Jakarta Sans(未见本地 bundle,依赖系统回退)+ 中文 Noto Sans SC(Google Fonts 在线加载)+ Outfit(本地,水印专用)。mock 用的是系统栈(SF Pro + PingFang)。

决定:**UI 统一改系统栈** `-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif`。理由:与 Tahoe 原生一致、零网络加载(离线可用)、PingFang 是中文渲染最好的选择、符合「效率工具、无衬线」的既有偏好。Outfit 仅保留给水印渲染。Splash(`index.html`)里的 Nanum Myeongjo 衬线字一并去掉。

## 八、响应式与折叠策略(mock 缺失,必需项)

**宽度预算**:最小窗口 1080(`main.js minWidth`),侧栏 236 + 检查器 272 = 508,工具栏可用宽仅 572px;默认 1440 窗口检查器打开后也只有 932px。mock 工具栏满配约 940px(标题 120 + 布局分段 180 + 地图 36 + 搜索 216 + 排序 110 + 图标簇 102 + 导入 80 + 间距 84)。**即默认窗口 + 检查器打开就已经放不下**,实测 800px 宽时标题、排序、导入全部折行。

折叠优先级(用现有 `.app-toolbar` 容器查询扩到五档;数值按内容区宽度):

| 内容区宽 | 动作 |
|---|---|
| ≥ 960 | 满配 |
| < 960 | 搜索 216 → 160;标题副标题(张数 / 日期)隐藏 |
| < 860 | 布局四段 → 单按钮下拉(现有 `DisplayModeDropdown` 就是这个形态,直接复用) |
| < 660 | 搜索收成图标,点击后展开覆盖整条工具栏(Photos 式) |
| 永不折 | 标题、导入(主操作)、筛选按钮 |

**筛选 chips 行**:12 个 chip + 星级 + 重置在 ≤ 900px 必溢出,mock 里「重置」被裁掉。规则:chips 区横向滚动 + 两端渐隐 mask;「重置」固定在行尾滚动区外;筛选按钮上常驻激活计数徽标(Toolbar 已有,补 accent-ink),这样 chips 行收起时仍能看到有几个筛选生效。地图移动产生的地理位置 chip 也进这一行。

**侧栏 / 检查器可拖宽**:现有 `sidebarWidth / inspectorWidth` 持久化必须保留;把手不画线,hover 才现细线;检查器宽度记忆但显隐由选择驱动。

**检查器显隐规则**:「有可检查对象即显示」。素材视图:选中 ≥ 1 张显示(多选沿用现有检查器的多选表现),清空选择 / Esc / 点空白收回;贴纸视图:选中贴纸显示;人物视图:现有 PeopleInspector 是人物列表不是检查器,本轮保持常驻,后续可迁入侧栏子树。`App.jsx` 里 `showInspector` 目前硬编码 true,改为派生状态。

## 九、可读性与对比度

mock 文字色用 alpha 叠在玻璃上,实测(按玻璃默认乳化、舞台底色估算):

| 文字 | mock 值 | 估算对比度 | 目标 | 新值 |
|---|---|---|---|---|
| dark muted | .55 | 约 5.6:1 | ≥ 4.5 | .62 |
| dark muted2 | .34 | 约 2.9:1 | ≥ 3(仅 ≥ 11px 辅助文字) | .46 |
| light muted | .58 | 约 4.1:1 | ≥ 4.5 | .66 |
| light muted2 | .36 | **约 2.2:1,不达标** | ≥ 3 | .50 |

规则:
- muted2 只用于 ≥ 11px 的非必要信息(计数、副标题、分组标题),**永远不放在照片上方的玻璃上**;
- 浮在照片上的裸标题(工具栏标题):浅色主题 `--tshadow:none` 导致在亮照片上无保护。改两点:顶部 scrim 的 mask 实心段从 30% 提到 50%(约 60px,盖住整个标题框),浅色标题加白色光晕 `text-shadow: 0 0 12px rgb(var(--app-bg) / .9)`(是可读性光晕不是投影,不违反无影规则);
- 玻璃上的可交互文字(chip、排序、搜索 placeholder)用 muted 不用 muted2;
- 深色主题 `--glass-rgb` 从 19/19/23 提到 22/22/26,避免深玻璃叠深舞台发闷(mock 深色侧栏实测偏灰暗;按四.6 侧栏改实色后此问题自然减轻)。

## 十、性能与动效定值

### 10.1 玻璃参数(定值,不再滑杆拍板)

| 面 | blur | saturate | alpha(dark / light) |
|---|---|---|---|
| 胶囊、chips 行、底部胶囊 | 20 | 1.4 | .60 / .66 |
| 菜单、Toast、弹出层 | 20 | 1.4 | .72 / .78(承载文字,更实) |
| 顶部 / 底部渐进模糊带 | 18 | 1.15 | mask 渐变 |
| Clear(Lightbox 控件) | 12 | 1 | .28,白字 + 1px 深描边 |

mock 默认 blur 30 违反了自家「≤ 20」红线;胶囊面积小,30 与 20 肉眼几乎无差,统一 20。

### 10.2 性能规则

- 渐进模糊带 opacity 为 0 时置 `visibility:hidden`(卸载 backdrop),否则滚动静止时仍常驻一个全宽 backdrop 层;底部带同理,由「距底剩余滚动距离」驱动;
- 玻璃面尺寸不做动画:筛选行展开时 scrim 高度 118 → 160 的 `transition:height` 改为直接切换;
- `.noise-overlay`(全窗 fixed 伪元素 + feTurbulence)是常驻合成层,P0 删;
- 缩略图 hover 的 `filter:brightness` 改为叠一层 `opacity` 白 / 黑 overlay,避免 img 重栅格化;
- 主题切换后 Chromium 缓存 backdrop 不重绘:把 demo 的 `repaintGlass`(backdropFilter 置 none 再还原,双 rAF)封装进 `useWorkspace` 的主题 effect,对 `.mat-glass` 统一执行;
- 同屏玻璃:胶囊不限量,高度 > 200px 的玻璃面 ≤ 2。

### 10.3 动效(符合「只做反馈、不做入场」)

| 交互 | 时长 | 曲线 |
|---|---|---|
| hover / press | 120ms | ease-out |
| 弹出层、菜单 | 140 至 180ms | cubic-bezier(.3,1,.35,1) |
| 检查器滑入 | 220ms,只动 transform + opacity | 同上 |
| 筛选行展开 | 200ms transform | 同上 |
| 渐进模糊 | 无动画,随 scrollTop 线性 | 无 |

检查器滑入的实现要点:mock 是「动画列宽 + setTimeout 后重排」,真 App 的网格靠 ResizeObserver 量宽,列宽动画会让虚拟化网格在 220ms 内连续重排数百张图。改为:检查器以 transform 滑入(期间覆盖网格右缘),`transitionend` 后网格容器一次性改宽、单次重排。`prefers-reduced-motion` 下全部 0ms(App 已有该查询)。

### 10.4 滚动条(2026-09-06 修正)

原打算删掉 `::-webkit-scrollbar` 覆盖还原系统 overlay 条,Electron demo 实测**不成立**:macOS 接了鼠标时系统条是常驻粗条(「显示滚动条:自动」按外设决定),用户明确嫌粗。定稿:**自定义纤细条**,7px 槽、3px 拇指(2px 透明边 + `background-clip:padding-box`),拇指默认透明,**滚动容器 hover 时才显**,拇指 hover 再加深;可拖拽。选择器只挂具体滚动容器(网格、检查器正文、设置页),不用 `*:hover`。不自造 JS 指示条(没有拖拽、键盘、无障碍)。

## 十一、P3 窗口层:补齐的坑

- **vibrancy 跟主题走**:`vibrancy:"under-window"` 的明暗取自 `nativeTheme`;App 主题为 dark 而系统为 light 时会出现浅色 vibrancy 垫深色 UI。主进程必须在主题变化时设 `nativeTheme.themeSource = theme`(`system` 直接透传),渲染层通过 IPC 同步。
- **hiddenInset 让位**:红绿灯占左上约 78×34,侧栏头部下移(demo 用 padding-top 44);macOS 原生处理拖拽区双击缩放,无需自写。
- **拖拽区不能盖住任何控件**:Electron 已知问题,`-webkit-app-region:drag` 区域与其中 `no-drag` 按钮重叠时,系统拖拽层和网页光标轮流接管,光标在 pointer / 箭头之间闪。定稿:拖拽区只盖没有控件的地方,即侧栏头部(目录名区域,44px 高)+ 内容区顶部 12px 细条;检查器打开时细条在检查器前停下(demo `#dragzone` / `#dragzone2`)。
- **全屏**:进入全屏红绿灯消失,48px 顶部让位变成空白;监听 `enter-full-screen / leave-full-screen` 广播给渲染层收起让位。
- **splash**:现有 `backgroundColor:"#000000"` 的首帧黑底与透明窗冲突;改为 `#00000000` 后首帧是 vibrancy,splash 文案直接画在其上即可(顺带去衬线字)。
- **透明窗副作用**:`backgroundColor:"#00000000"` + vibrancy 不需要 `transparent:true`(后者会失去窗口阴影与部分原生行为),demo 已按此配置,沿用。
- **同心圆角**:贴边结构下不再有内层圆角,唯一要保证的是内容不裁进窗口 26px 圆角内(底部胶囊已有 14px 内缩,足够)。

## 十二、mock 缺陷清单(复审实测)

| 缺陷 | 影响 | 状态 |
|---|---|---|
| `select()` 后 `setTimeout(render)` 重建全部 tile,`.sel` 类丢失,选中环 / 角标在检查器滑入后消失 | A/B 评审时看不到选中态,误导判断 | **已修**(记录选中索引,render 后回填;gallery.html 与 lg-demo-electron/index.html 同步) |
| 工具栏无折叠,≤ 960px 内容宽时标题 / 排序 / 导入折行 | 默认窗口 + 检查器即触发 | 按八实现,mock 不再补 |
| 筛选行「重置」`margin-left:auto` 在 overflow 滚动区内被裁 | 窄屏无法重置 | 按八实现 |
| 底部状态 / 缩放胶囊直接压在照片上,无底部渐隐,与顶部不对称 | 末行照片被胶囊硬切 | 按六加底部渐进模糊带 |
| 浅色主题标题无保护 | 亮照片滚到顶部时标题可读性差 | 按九整改 |
| 深色玻璃 alpha .52 叠深舞台,侧栏文字发闷 | 深色终审印象差 | 按四.6 侧栏实色 + 九提亮 |
| 设置弹出层只有深 / 浅,缺「系统」 | 与现有 App 三态不一致 | **已修**:设置改整页弹窗(通用 / AI 标注 / AI 重绘 / 人物 / 图库 / 集成 / 关于 / 演示参数),外观三态在通用页;demo 调参收进「演示参数」 |
| 检查器只有 8 个字段 | 评审时看不出信息密度 | **已修**:按真实 Inspector 分节(属性含评分 / AI 标注按钮 + 标签 / 源文件 / 相机 / 曝光四项 / 日期三项 / 位置),分节可折叠 |
| 玻璃带投影 + 顶部高光,偏拟物 | 用户反馈「投影有点多」 | **已修**:见四.9 |
| 侧栏 / 检查器贴边色块 | 用户对照系统设置 / Music 要内缩面板 | **已修**:见三.R5 最终 |
| 原生滚动条粗 | 接鼠标时系统条常驻 | **已修**:见十.4 |
| 检查器关闭按钮上光标闪烁 | 按钮落在 34px 拖拽区内 | **已修**:拖拽区拆两块避开控件,见十一 |
| 检查器也套了一层圆角框 | 用户:只有侧栏是框 | **已修**:检查器贴边透明 |
| 侧栏文件夹太少看不到滚动 | 评审滚动条需要 | **已修**:15 个文件夹 |
| 侧栏面板圆角与窗口圆角不一致 | Electron 无 NSToolbar,窗口是 16 不是 26 | **已修**:`--pane-r = --win-r − --pane-inset`,默认 16 − 8 = 8;演示参数里可改窗口圆角 |
| 侧栏边 / 舞台缝 / 顶带起点线 / 照片四种质感并排,凌乱 | 顶带只覆盖内容区,左缘有硬线 | **已修**:顶带改 fixed 横跨全窗、在侧栏之下 |

## 十三、阶段计划与验收标准(修订)

1. **P0 · token 层(单 PR,不碰业务组件)**:七.4 的六步。验收:深浅两主题各 6 张关键截图(网格、检查器、筛选、菜单、设置、Lightbox)无残留暖米色、无 ≥ 1px 实线、无投影(浮层微影除外);Button primary 在浅色主题文字可见;e2e 全绿。
2. **P1 · chrome 层**:Toolbar 胶囊岛 + 五档折叠 + 筛选行;侧栏 / 检查器同底 + 显隐派生 + transform 滑入;菜单 / Toast / JobDock 玻璃;顶底渐进模糊;滚动条还原;编辑器与拼图面板降实色。验收:1080 最小窗口 + 检查器打开工具栏不折行;检查器滑入期间网格重排 ≤ 1 次(Performance 面板);滚动静止时无 backdrop 层(Layers 面板);对比度按九抽检。
3. **P2 · 玻璃增强**:Lightbox 控件 Clear;地图标记 Clear;折射引擎在 Electron 43 复测,通过则只给菜单 / Toast;`prefers-reduced-transparency` 与设置项联动验证。
4. **P3 · 窗口层**:hiddenInset + under-window vibrancy + 透明背景 + `nativeTheme` 联动 + 全屏让位 + splash。验收:系统浅 / App 深等四种组合下 vibrancy 明暗正确;全屏无空白顶带;红绿灯不压任何控件。

## 十四、技术资产与运行方式

| 资产 | 位置(均未 commit) | 运行 |
|---|---|---|
| 最终候选 Gallery(双主题) | `apps/desktop/public/lg-lab/gallery.html` | web-shell(:5187)开 `/lg-lab/gallery.html` |
| Electron 原生窗口 demo(main.js + preload.js:nativeTheme 联动、全屏让位) | `apps/desktop/lg-demo-electron/` | `cd apps/desktop && npx electron lg-demo-electron/main.js`;改 index.html 后重启进程(菜单 Reload 不可靠) |
| 真实 web 版玻璃注入 | `apps/desktop/public/lg-inject.js` + `web.html` 尾部一行 script | web-shell 开 `/web.html`,G 键 A/B |
| 概念实验室 A/B/C | `apps/desktop/public/lg-lab/` | `/lg-lab/` 入口页 |
| 折射引擎完整版 mock | 会话 scratchpad `lg-demo/v1.html`(会话级,易失) | launch.json `lg-demo`(:5189) |
| 演示照片(12 张,已导出小图) | `apps/desktop/public/lg-photos/` | 供以上所有 demo 复用 |

## 十五、已知坑(踩过并已解决 / 记录)

- Chromium:`backdrop-filter: url(#feImage…)` 与照片网格同屏 → img 层画黑(真实 App 触发,mock 不触发)。
- Chromium 会缓存 backdrop 合成层:改主题 / 改 CSS 变量后玻璃不重绘,需强制重绘(backdropFilter 置 none 再还原,双 rAF)。正式落地封装进主题 effect(十.2)。
- `web.html` 的 html 元素自带背景色 → body 背景不上提为画布,想在 App 底下垫层需连 body 一起透明。
- web bridge 导入:合成拖放事件进不了 React 处理器;正确路径是 `api.getPathForFile(File)` staging + `api.startImport({imageDirs})`。
- vite dev server 启动时 public/ 不存在则不会伺服,需重启;`vite`(默认配置)服务的是 Electron 渲染层入口,web 版入口是 `/web.html`。
- 同心圆角:内层 = 外层 − 内缩,否则窗口角与卡片角打架。
- 渐进模糊顶带若静止常驻会产生生硬白带,必须滚动驱动;且 opacity 0 时要卸载 backdrop(十.2)。
- macOS 接鼠标时系统滚动条常驻且粗,「还原 overlay 条」不可靠,需自定义纤细 hover 显条(十.4)。
- Electron demo 改了 index.html 后菜单 View → Reload 不生效,重启进程才刷新。
- `vibrancy` 明暗跟 `nativeTheme` 不跟 `data-theme`(十一)。
- mock 里 `render()` 重建 DOM 会丢掉选中态类(十二)。

## 十六、Apple 官方规范对照(2026-09-06 查证)

来源:HIG(Materials / Sidebars / Toolbars / Windows / Scroll views)、WWDC25 310「Build an AppKit app with the new design」、WWDC25 356「Get to know the new design system」。HIG 页面是前端渲染,抓的是其 JSON 数据接口。

### 16.1 官方原文与我们的对照

| 主题 | Apple 口径(原文摘译) | 我们的现状 / 结论 |
|---|---|---|
| 侧栏 vs 检查器 | 「侧栏是一块**浮在内容之上**的玻璃;检查器用**贴边**玻璃,与内容并排」(310) | 与追加定调一致:侧栏浮框、检查器贴边不套框。差异:Apple 侧栏是玻璃且**内容从它下面流过**(滚动视图默认延伸到侧栏底下,或用「背景延伸效果」镜像 + 模糊相邻内容);我们是实色面板。见 16.2 决策项 A |
| 同心圆角 | 「同心形状的圆角 = 父容器圆角 − 内边距;胶囊 = 高度一半;固定圆角为常量」(356) | 公式一致。demo 已改成 `--pane-r: calc(--win-r − --pane-inset)` |
| 窗口圆角 | 「窗口圆角更大更柔和,**随窗口样式变化**:**带工具栏的窗口用更大的圆角**,同心包裹玻璃工具栏并随工具栏尺寸缩放;**仅标题栏的窗口保留较小圆角**」(310)。官方无数值;社区从 WWDC 视频量得:**工具栏窗口 26pt,仅标题栏窗口 16pt**(Zed 讨论);Electron 用户在 Tahoe 上量得约 14px(electron#47833)。另有 2026-07 评论称下一代 macOS 约 20pt,数值在变 | **我们的 Electron 窗口没有 NSToolbar,属于「仅标题栏」,圆角 16 而非 26**。这是「面板圆角与窗口不一致」的根因(面板 18 > 窗口 16)。demo 默认改 16 − 8 = 8。P3 要拿到 Apple 应用那种 26 圆角,见 16.2 决策项 B |
| 材质:Regular / Clear | 「Regular 模糊并调整背景明度保证可读,多数系统组件用它,用于可能有可读性问题或文字多的组件(警告、侧栏、弹出层)」;「Clear 高度透明,用于浮在媒体(照片 / 视频)上的组件;**只在视觉丰富的背景上用 Clear**;背景亮时加 **35% 黑色压暗层**」 | 一致。补一条数值:Lightbox 的 Clear 控件在亮照片上加 35% 压暗层 |
| 玻璃用在哪 | 「**不要在内容层用 Liquid Glass**,内容层用标准材质;例外是内容层里的瞬时交互控件(滑杆、开关)激活时」;「**节制使用**,只给最重要的功能元素」 | 一致(四.6);照片网格永不上玻璃 |
| 滚动边缘效果 | 「用**软**(渐进模糊淡出)和**硬**(更不透明的背衬)两种;**macOS 多用硬边**,适合玻璃外的文字、无背景控件、钉住的表头」;「优先自动样式」;「**不是装饰**,只在浮动元素后面有滚动内容时用;不像遮罩那样压暗;**每个视图一个**」(356 + HIG Scroll views) | 顶部渐进模糊 = 软边,滚动驱动符合「只在有浮动元素时」。我们的裸标题是「玻璃外的文字」,Apple 建议硬边 / 自动;可考虑把顶带的实心段再做实一点。底部胶囊下的底带是合规的第二个「视图」?不是,同一滚动视图只能一个 → 见 16.2 决策项 C |
| 侧栏内容 | 「把视觉丰富的内容延伸到侧栏下面」;「最多两级层级」;「**不要把关键信息或操作放在侧栏底部**,人们常把窗口挪到底边看不见」 | 我们的「设置」在侧栏底部,违反建议。⌘, 和菜单栏仍可达,属非关键入口,可保留;或挪到工具栏尾部。见 16.2 决策项 D |
| 工具栏 | 「前端:返回 / 显隐侧栏 + 标题;中间:常用控件;尾部:需常驻的项、打开检查器的按钮、可选搜索框、More 菜单」;「按功能与频率分组,**分组最多三个**」;「只指定**一个主操作**,放尾部,用 prominent 样式」;「减少工具栏背景与着色控件」;「每个工具栏项都要在菜单栏有对应命令」 | 我们目前 6 个玻璃组(布局分段 / 地图 / 搜索 / 排序 / 图标簇 / 导入),超过「最多三组」。见 16.2 决策项 E |
| 窗口底部 | 「避免把关键信息或操作放在底栏;Finder 用底栏显示项目数、选中数、剩余空间」 | 我们底部只有计数胶囊和缩放,与 Finder 用法一致,合规 |
| 滚动条 | 「面板空间紧时可用 small / mini 滚动条,同一面板内尺寸一致」 | 纤细条合规 |
| 减少透明度 | HIG:玻璃需响应「减少透明度」 | 已列(`prefers-reduced-transparency` → 实色) |

### 16.2 决策项(2026-09-07 用户已拍板:A 否,B 可,C / D / E 修,均已落 demo)

- **A · 侧栏材质:否**。用户:「侧栏底下不会有内容」,玻璃没有意义。维持实色略亮面板,四.6 规则不变。
- **B · 窗口圆角 26 怎么拿**:Electron 没有 NSToolbar,系统只给 16。三条路:① 接受 16,面板圆角 = 16 − 内缩(demo 现状);② 透明窗 + 自绘 26 圆角与阴影(失去原生窗口阴影 / 边缘处理,resize 时可能有瑕疵);③ 用原生小模块给窗口挂一个空 NSToolbar 或直接设圆角(社区有 super-browser-window-kit 之类;需自维护 native 代码,项目已有 Swift 工具链先例)。**拍板:P3 先试 ③,不成回落 ①**。数值本身在变(下一代 macOS 传约 20),所以做成 `--win-r` token,不写死。
- **C · 底部渐进模糊带**:Apple「每个视图一个滚动边缘效果」。我们同一网格上下各一条。底部两个胶囊是浮动元素,按「只在浮动元素后面用」的精神仍成立,但严格按「一个」应去掉底带、把计数并入侧栏底部、缩放并入工具栏。**拍板:修**。去掉底部两个胶囊和底部渐进模糊带;计数并入标题副标题(「1,247 张照片 · 96.2 GB」),缩略图大小进图标簇的「缩放」弹出滑杆。网格底部只剩 20px 内边距,直接到窗口边。
- **D · 设置入口**:保留侧栏底部(非关键、⌘, 可达)还是挪到工具栏尾部 More 菜单。**拍板:修**。侧栏底部的「设置」删除,进工具栏尾部图标簇的「更多」菜单(刷新 ⌘R、设置 ⌘,)。
- **E · 工具栏分组收敛到三组 + 一个主操作**:建议 [布局分段] [搜索] [地图 · 筛选 · 排序 · 后台活动 · 刷新 图标簇] + 导入(prominent,尾部)。排序从文本胶囊改为图标簇里的下拉,地图并入图标簇。这同时缓解八的折叠压力。**拍板:修,已落**:最终三组 = [布局分段] [搜索] [地图 · 筛选 · 排序(下拉)· 缩放(弹出滑杆)· 后台活动 · 更多] + 导入(prominent)。折叠档去掉「排序文本→图标」那一档(排序已是图标)。

### 16.3 图标(2026-09-07 决定)

Apple 官方图标库是 **SF Symbols**,但许可证只允许用于 Apple 平台 App,web 版不能用;网页里也没有直接渲染 SF Symbols 的可靠途径,只能逐个导出 SVG 自维护。**决定:全线沿用 lucide**(真 App 已在用,ISC 许可,web / 桌面同一套,风格本就是 SF 一路的细描边圆头)。规格:尺寸 16、`strokeWidth` 1.75、圆头圆角。demo 里的手画 SVG 已换成从 `node_modules/lucide-react` 抽出的真实路径,与真 App 一一对应(侧栏 Images / Clock / Star / UsersRound / Map / Sticker / Folder;工具栏 LayoutGrid / Grid2x2 / LayoutDashboard / Columns2 / Search / Map / SlidersHorizontal / ArrowUpDown / ZoomIn / Activity / Ellipsis / RotateCw / Settings / Plus;设置导航 Languages / Brain / WandSparkles / UsersRound / FolderOpen / Plug / Info)。若 P3 走原生窗口后想让 macOS 版更 Apple,可再评估 SF Symbols 仅桌面版替换,web 版保持 lucide。

**没有文字冒充的图标**:下拉箭头、菜单勾、折叠箭头、星级、加减号一律用 lucide(ChevronDown / Check / Star / Plus / Minus),不用 ∨ ✓ ★ ☆ ＋ 这类字符;CSS 伪元素里的图标用 mask + data-URI 承接 currentColor,主题相关的(缩略图选中角标的勾)按主题各给一份。真 App 里排序标签自带的「↓ ↑」是 i18n 文案的一部分,保留。

### 16.3.1 更新到定调的条目

- 四.4 圆角体系:大面板 18 改为「面板圆角 = 窗口圆角 − 内缩」,窗口圆角为 token(`--win-r`,Electron 仅标题栏窗口 = 16)。
- 六 表面清单:Lightbox Clear 控件在亮内容上加 35% 压暗层。

## 十七、外部参考集(Dribbble,2026-09-07 抓取筛选)

方法:Dribbble 五组搜索 / 标签页(photo library、photo gallery desktop、media library、lightroom、mac app design、photo editor desktop)约 180 条,按标题初筛 25 条,逐张看原图后留下 14 条。Behance 搜索在内置浏览器里只返回热门推荐(搜索结果需登录渲染),本轮无产出。总体判断:Dribbble 上桌面照片库类概念稿数量少、质量一般,**真正值得对标的仍是真实产品**(Apple Photos on Tahoe、Eagle、Lightroom、Capture One、Darkroom for Mac、Photomator、Mylio),后续可用 Mobbin / screensdesign.com 抓真实 App 截图。

### A · 桌面照片库(结构直接可借鉴)

| 作品 | 链接 | 可借鉴点 |
|---|---|---|
| Frames for Mac | dribbble.com/shots/27179776 | 与我们最接近:深色 macOS 照片网格 + 右侧检查器,缩略图扁平无描边、检查器字段密度合适 |
| Adobe Lightroom Redesign(Lisheng Chang) | dribbble.com/shots/2592814 | 经典 Library 结构:左栏 导航器 / 目录 / 收藏集分组,网格每格带元数据角标;模块切换放顶部 |
| Quik for Desktop(GoPro) | dribbble.com/shots/2566794 | 深色媒体库按日期分组,左侧来源列表极简,顶部只有排序 / 视图两个控件 |
| Photo Gallery: Grid View | dribbble.com/shots/19758867 | 深色网格 + 右侧协作面板,面板与网格同底不另起色块 |
| Desktop App for Media Management | dribbble.com/shots/26751003 | 深色三栏(列表 / 画布 / 属性),右栏属性分节方式 |
| Unsplash Minimal Mac App Concept | dribbble.com/shots/14661803 | 浅色版参考:侧栏纯文字导航、顶部 tab 行 + 瀑布流 |
| Photographers Admin Panel · Media library | dribbble.com/shots/14973889 | 深色卡片带标题 / 日期的排版 |

### B · 编辑器、浮层、设置(局部参考)

| 作品 | 链接 | 可借鉴点 |
|---|---|---|
| Photo Editor Adjustments · Controller Panel | dribbble.com/shots/22834375 | 照片上的浮动玻璃调整面板,即我们 Lightbox / 编辑器的 Clear 玻璃用法 |
| Photty · Online photo editor(Dark) | dribbble.com/shots/19375613 | 预设侧栏 + 底部胶片条的编辑器布局 |
| Light & Color Controls · Minimal Photo Editing UI | dribbble.com/shots/27304058 | 浅色极简调整面板,滑杆纯填充无边框,分节只靠留白 |
| Image Export Settings · Clean Modal | dribbble.com/shots/27307572 | 无线条 Modal 的范本:分组用留白与浅底,选项卡片化 |
| Collaborative Photo Editing Software UI | dribbble.com/shots/20268513 | 浅色编辑器的左侧工具轨 + 右侧属性栏 |
| Native · macOS Screens / macOS Settings Screens | dribbble.com/shots/23877453、/shots/23970985 | 原生 macOS 设置页 / sheet 的结构与间距 |
| Riveria · Photo Editing Dashboard | dribbble.com/shots/20569930 | 高密度深色编辑器,反面参考:信息过密 |

淘汰:移动端概念(pixxl Photo Management App、Tundrea 概念、Loci、Cleaner Pro)、web 端 DAM 仪表盘(Marc Sanders、Mulleboy)、影片收藏、Creativit。

## 十八、方向 B · 音乐 App 风格 demo(2026-09-07)

用户在 Dribbble / Behance 没看到满意的参考,提出用音乐 App(Tahoe Apple Music / Spotify)的骨架重做一版。独立 demo:`lg-demo-electron/music.html`(web 副本 `public/lg-lab/music.html`),运行 `cd apps/desktop && npx electron lg-demo-electron/main.js music.html`。复用同一套 token、材质规则、lucide 图标与 Electron 壳(main.js 现在接受页面参数)。

映射关系:

| 音乐 App | AfterFrame | demo 实现 |
|---|---|---|
| 首页编辑式货架 | **「发现」,侧栏第二项,不是开屏** | 大图 hero(本周新增)+ 横向货架:最近添加(大卡)、文件夹(方形封面)、人物(圆头像)、地点(宽卡带地名)、按月回顾(竖卡)。用户:开屏必须是全部素材网格,货架首页降低效率 |
| 曲库 | **全部素材(开屏)** | 两端对齐网格 / 列表切换,筛选整套(按钮 + 计数徽标 + chips 行 + 星级 + 重置)与 gallery demo 同一套 |
| 专辑页 | 文件夹页 | 左大封面 + 标题 / 元信息 / 描述 + 平级动作(导出、拼图、AI 标注、更多)+ 网格 / **曲目表式列表**切换;封面模糊氛围底(可在更多里关)。**幻灯片只在「更多」里** |
| 曲目表 | 列表视图 | 列:# / 缩略图 + 名称 + 尺寸曝光 / 相机 / 镜头 / 拍摄时间 / 评分 / 大小;行 hover 填充、选中 accent 淡填充,无分割线 |
| 播放条 | **当前选中动作条** | 底部浮动玻璃条:缩略图、名称、机身曝光时间、可点的星级、「打开 ⏎」主操作、编辑 / 标签 / 导出 / 取消。**不做播放器式控件**:用户「播放按钮没有意义」,上一张下一张交给 ← →,双击 / ⏎ 打开灯箱 |
| 播放 | 幻灯片 | **降为微小功能,不喧宾夺主**:只在灯箱底部条上有一个自动播放开关(2.5s),入口在文件夹「更多」 |
| 侧栏搜索 | 搜索 | 搜索框进侧栏顶部,工具栏只剩 [网格 / 列表] [排序 · 更多] + 导入 |
| 侧栏播放列表带封面 | 文件夹带封面 | 文件夹条目前置 26px 封面缩略图 |

与既有定调的关系:侧栏仍是内缩面板、检查器被播放条取代(信息密度低于检查器,完整字段在列表视图里)、玻璃只在播放条与弹出层、顶带全宽滚动驱动、无投影无描边。**已知偏离**:底部在有选中时多一条渐进模糊带(播放条是浮动元素,合规);专辑页氛围底属于「内容驱动的环境色」,与 R2 被否的「跟随选中照片的 ambient」不同,但同一家族,默认开、可关,待用户定。

待用户看后拍板:方向 A(gallery demo)还是方向 B(music demo),或 B 的货架首页 + A 的检查器混合。

## 十九、方向 C · 抛开 Liquid Glass 的音乐 App 骨架(2026-09-07)

用户:「抛开 Liquid Glass 的风格,更大胆一点偏向音乐 App」。独立 demo `lg-demo-electron/music2.html`(web 副本 `public/lg-lab/music2.html`),运行 `npx electron lg-demo-electron/main.js music2.html`。按 Spotify 桌面版 2023 之后的骨架,**无玻璃、无投影、深色专用**,保留已定的效率约束(开屏 = 全部素材网格、筛选整套、幻灯片微小)。

| Spotify | AfterFrame(方向 C) |
|---|---|
| 纯黑底 + 三块圆角面板(侧栏 / 主区 / 正在播放)+ 底部通栏 | 同构:#000 底、#121212 面板、8px 缝、r10;底部通栏 80px |
| 侧栏「你的图库」:粗体导航、过滤 chip、库内搜索、带封面两行条目 | 顶部 4 个粗体导航(全部素材 / 发现 / 最近添加 / 已评分);「你的图库」chip:全部 / 文件夹 / 人物 / 地点;48px 封面 + 名称 + 「文件夹 · 64 张 · 2025 年 12 月」 |
| 专辑页:封面主色渐变头、超大标题、动作行 | 文件夹 / 人物 / 地点页同一模板:主色由 PIL 从封面预算(饱和像素圆均值,V 固定 .42)→ 渐变头,56px 粗标题,元信息行带 catalog 头像;动作平级:导出 / 拼图 / AI 标注 / 更多(幻灯片在更多里) |
| 曲目表 | 列表视图:sticky 表头,# / 缩略图 + 名称 + 尺寸曝光 / 相机 / 镜头 / 拍摄时间 / 评分 / 大小,行 hover / 选中填充 |
| 正在播放面板(Now Playing View) | **检查器回来了**:大图、标题、可点星级,然后是卡片:相机(credits 位)、属性、位置(占位地图)、人物、标签 + AI 标注、接下来(队列,点击切换);⌥I 或底栏按钮收起;未选中时空状态 |
| 播放栏 | **删除**(用户:没有用)。理由:有右侧面板后,底栏的名称 / 星级 / 打开 / 编辑全是重复,刮擦条不如 ← → 与滚动。改为:缩略图大小进图标簇弹出滑杆;面板开关放导入之后(HIG 检查器开关在尾部);**只在选中 ≥ 2 张时浮出批量操作条**(已选 N 张 · 批量评分 · 标签 / 导出 / 拼图 / AI 标注 / 更多 / 取消),⌘ 点增减、⇧ 点范围 |
| 顶栏 | 返回 / 前进圆钮 + 标题(滚过专辑头后渐显)+ [网格 / 列表] [筛选 · 排序 · 更多] + 导入;滚动后顶栏着色 |
| 发现页 | hero + 五排货架(最近添加 / 文件夹 / 人物圆卡 / 地点 / 按月),卡片 hover 填充 |

与 A / B 的关系:C 放弃了 Liquid Glass 的材质与浅色主题(可后补),换来更强的层级和信息密度;A 的定调里「无投影、无描边、单色、玻璃只给浮层」在 C 里只保留前三条(C 没有玻璃)。待用户在 A / B / C 之间拍板,或指出 C 里要收敛的地方。

### 19.0 五套风格皮肤(2026-09-07,同一骨架,更多菜单或 1-5 键即时切换)

风格差异全部抽成 token(`data-style` 覆盖):颜色 9 个、圆角 3 个、缝宽、边线 2 个、字体 / 字号、导航字重、专辑标题字号 / 字重 / 字距、列表行高、缩略图圆角、主色混合比、顶栏着色、弹层底 / 模糊 / 影 / 边、封面影、`color-scheme`。

| # | 风格 | 对标 | 关键 token |
|---|---|---|---|
| 1 | Spotify 黑 | Spotify 桌面 | #000 底 / #121212 面板、白强调、r10、无边线、标题 56/800、行高 56 |
| 2 | Tahoe 玻璃(2026-09-08 补:工具栏各组改玻璃胶囊浮在滚动内容上、顶栏改软边渐进模糊伪元素而非实色带,用户问「玻璃是不是太少」;侧栏仍实色,除非采用 Apple 的背景延伸镜像) | 方向 A 的材质 | **2026-09-08 用户要更深的黑**:#0b0b0d 舞台 / #131316 面板、玻璃胶囊 rgba(16,16,20,.6)、弹层 rgba(18,18,22,.76)(原 #1a1a1d / #212124)、alpha 填充、r18、弹层与批量条玻璃(blur 20)、标题 40/700、行高 52、主色混合 55% |
| 3 | 专业灰 | Lightroom / Capture One | #1c1c1c / #262626、浅灰强调、r4、面板 1px 边线 + 表头分割线、12px、标题 28/600、行高 42、专辑头不着色 |
| 4 | 纸白 | Things / Craft | #ececee / #fff、近黑强调白勾、r12、缝 10、13px、标题 44/750、行高 54、主色混合 22%,`color-scheme:light` |
| 5 | Carbon | Linear / Raycast | #0b0b0c / #141416、r8、缝 6、面板 1px 边、12.5px、标题 32/700、行高 46、快捷键提示常显 |
| ~~6~~ | ~~印刷 · 衬线纯白~~(2026-09-08 已撤:留白多的纸质版式适合杂志,不适合高密度图库;回无衬线) | 精致画册内页 | #fff 纯白、#111 文字、面板之间发丝规线而非缝、全部直角、正文 New York / Iowan Old Style / Songti SC 13.5px、标题 Didot 400 斜体 52px、标签小型大写字母 + .12em 字距、chip / 分段描边、列表行底规线、副文斜体。**这是对「不用衬线」旧偏好的一次有意例外**,仅此风格 |

启动时可用 hash 预设风格与密度:`npx electron lg-demo-electron/main.js "music2.html#tahoe,compact"`。

### 19.0.1 密度三档(2026-09-08,与风格正交,7 / 8 / 9 键或更多菜单)

用户要看「元素之间疏密安排有多少差异」。密度抽成独立 token 组,任一风格都能配任一密度:

| token | 紧凑 | 标准 | 宽松 | 管什么 |
|---|---|---|---|---|
| --gap | 4 | 8(随风格) | 12 | 面板间缝 |
| --pad | 12 | 20 | 36 | 内容区左右边距、顶栏边距 |
| --grid-gap / --tile-h | 3 / 164 | 8 / 220 | 16 / 280 | 网格缝、行高(缩放滑杆起点跟随) |
| --lrow-py / --lrow-img | 3 / 36 | 6 / 48 | 10 / 56 | 侧栏库条目内边距、封面尺寸 |
| --nav-py | 5 | 8 | 11 | 侧栏导航项 |
| --top-h / --ctl-h / --ib | 50 / 28 / 26 | 64 / 34 / 30 | 76 / 38 / 34 | 顶栏高、控件高、图标钮 |
| --cardx-px / --cardx-py / --kv-py | 12 / 9 / 2 | 16 / 14 / 5 | 20 / 18 / 8 | 右侧面板卡片内边距、键值行距 |
| --rowh | 40 | 随风格 | 66 | 列表行高 |
| --cover / --shelf-mt / --card-pad | 160 / 16 / 8 | 232 / 28 / 12 | 280 / 44 / 16 | 专辑封面、货架间距、卡片内边距 |
| --fs / --h1 | 12 / 36 | 随风格 | 13.5 / 随风格 | 字号、专辑标题 |

列表视图列宽随主区宽度响应(容器查询):名称列最小 200px 永不塌缩;≤ 1000px 收起镜头列,≤ 820px 再收起相机列;紧凑档隐藏名称下的副行、缩略图 28px。此前紧凑 + 右侧面板打开时名称列被固定列挤到几十像素、文字溢到相机列,已修。

修复:列表 sticky 表头 `top` 由 64 改 0(滚动容器自带 64 padding,Chromium 会叠加,之前停在 128)。

### 19.1 值得对标的真实桌面 App(2026-09-07 整理)

Dribbble 类概念稿不够用,以下按「借什么」分组,均为真实产品:

| 借什么 | App | 具体看哪里 |
|---|---|---|
| 同类直接对标 | Apple Photos(Tahoe) | 侧栏 / 网格 / 检查器三段;工具栏只留视图切换 + 缩放 + 搜索;多选后的批量操作;信息面板的分节与地图 |
| | Eagle | 效率派 DAM:左筛选面板、瀑布流、右检查器的标签编辑、缩略图密度、拖放;用户已在参考 |
| | Lightroom(新版) | 极简三栏、右侧面板折叠、胶片条;网格的星级 / 旗标角标 |
| | Lightroom Classic / Capture One | 高密度专业面板:分节折叠、数值输入、可自定义工具面板;C1 的深灰材质与工具栏分组 |
| | Mylio Photos | 时间轴 / 日历 / 地图 / 人物视图切换,同一网格多种「镜头」 |
| | Photo Mechanic | 速度优先的选片流:键盘打分、色标、大预览,效率的天花板 |
| | Adobe Bridge / ACDSee | 老牌资产浏览器:筛选面板、元数据面板、多窗口布局 |
| 原生 Mac 克制感 | Things 3 | 留白、字号阶梯、无线条分区,Mac App 克制的标杆 |
| | Pixelmator Pro / Photomator | Apple 设计语言下的专业工具:侧栏工具面板、深色画布、检查器 |
| | Darkroom for Mac | 编辑器的深色极简与浮动控件 |
| | Craft / Bear | 侧栏层级、编辑区排版、玻璃与实色的克制使用 |
| 密度与键盘 | Linear | 键盘优先、命令面板、列表行密度与 hover 动作,适合列表视图 |
| | Raycast | 列表行 + 右侧详情的经典布局,快捷键标注方式 |
| 面板 / 检查器范式 | Figma | 属性面板的分节、输入控件、图标按钮组;画布 + 面板的比例 |
| | Final Cut Pro / DaVinci Resolve | 媒体浏览器 + 检查器 + 时间线;FCP 检查器的分节与折叠是照片元数据面板的好模板 |
| 音乐 App 骨架 | Spotify / Apple Music | 三面板、库列表、专辑页、Now Playing 面板(方向 C 已借) |

抓真实截图流:Mobbin(移动为主,桌面也有)、screensdesign.com、以及各家官网的功能页。

## 二十、方向 D · Photos 式(2026-09-08)

`lg-demo-electron/photos.html`(web 副本 `public/lg-lab/photos.html`),`npx electron lg-demo-electron/main.js photos.html`。来源换成 Tahoe 上的 Apple Photos 解剖,与 A / B / C 都不同的机制:

| Photos | demo |
|---|---|
| 按日期分组、粘性日期标题 | 「2025 年 12 月 19 日 · 台北 · 9 项」+ 该组「选择」;标题 sticky 在顶栏下(top:0,滚动容器 padding 会被叠加) |
| 方形缩略图、缩放滑杆改列数、方形 / 原比例切换 | `--cell` 96 至 320,`body.fit` 切 object-fit contain;星级角标 hover 或 ≥4 星常显 |
| 信息 = ⌘I 浮动 HUD 窗 | 300px 玻璃 HUD,可拖,内容:缩略图、名称、日期地点、可点星级、相机 + 曝光 chips、文件、位置(占位图)、人物、关键词;全 App 唯一玻璃 |
| 双击进单张视图,顶部缩略图带 | `#single` 页:顶部 50px 缩略图带(当前带环、自动居中)+ 大图,标题变文件名 + 「n / N」,Esc 返回 |
| 侧栏三组树 | 图库 / 相簿(带封面)/ 项目(拼图),分组可折叠;搜索回工具栏尾部 |
| 工具栏 | [缩放 + 比例] [搜索] [筛选 · 排序 · 更多] + 导入 + ⓘ;筛选 chips 行同前;多选 ⌘ / ⇧ / ⌘A,批量条 |

现在四个方向 + C 的六套皮肤都能一条命令起,等用户拍板。

## 二十一、拍板:Tahoe 深黑,先做真实 App 的 1:1 样式还原(2026-09-08)

用户拍板走 Tahoe 深黑皮肤,但要求**先在真实 App 上做 1:1 还原、确认后再改源码;本轮只改样式,不做大的组件改动**。确认后的两个功能项另排:① 发现页作为新功能保留;② 图库(侧栏)提供「纯文字分组 / 缩略图」两种视图切换。

做法:复用 R2 的零源码注入路线。`apps/desktop/public/lg-tahoe.js`(未 commit)注入一份样式,挂在 `index.html`(Electron dev)和 `web.html` 尾部各一行 script(均未 commit,删掉即恢复原版);T 键在皮肤 / 原版间切换。运行 `cd apps/desktop && npm run dev` 即在真实 catalog 上看效果。这份文件按段落对应 P0 要改的源码:

| 段 | 对应源码 | 内容 |
|---|---|---|
| 1 token | index.css `:root` | 舞台 11 11 13 / chrome 19 19 22 / panel 23 23 26 / hover 30 30 34 / selected 40 40 44 / border 36 36 40(过渡:线先几乎不可见)/ muted 178 / muted2 122 / accent 245 白 / 功能色去饱和 / 影改微影 |
| 2 | index.css | 噪点层删;纤细 hover 显滚动条 |
| 3 | tailwind.config | rounded-md 10 / lg 14 / xl 18 |
| 4 | App.jsx 三栏 | 侧栏 = 内缩 8px 圆角 8 面板(white 5.5%);内容区与检查器透明贴边;侧栏内零分割线 |
| 5 | Toolbar.jsx | 工具栏透明;各组控件成玻璃胶囊(rgba(16,16,20,.6) + blur 20);搜索框无边框 |
| 6 | FilterBar.jsx | 行透明无底线;chip 胶囊无描边,激活白底黑字 |
| 7 | Gallery.jsx | 缩略图去描边;选中 2.5px 白环,无 glow;框选单色 |
| 8 | Inspector.jsx | 贴边透明;节标题无分割线;星级单色 |
| 9 | 菜单 / JobDock / Toast | 玻璃 rgba(18,18,22,.78)、无边框、r14、微影 |
| 10 | Modal.jsx / SettingsOverlay | 实色 19 19 22 卡 r18,无边框无分割线,遮罩 black/45 |
| 11 | Button.jsx | primary 白底黑字胶囊;secondary 无边框 alpha 填充胶囊 |
| 12 | Lightbox | 控件 Clear |

**2026-09-08 晚,用户再定:去掉皮肤开关、直接落到源码、开分支保存全部改动、深浅两套。** 已在分支 `feat/tahoe-skin` 上完成 P0 落地(只改样式与 token,不动组件结构):

- `src/index.css`:深浅两套 token 全换(浅色中性化、accent 单色、新增 `--accent-ink`、材质层 `--pane / --glass / --pop / --edge / --fill*` / `--blur`)、系统字体栈、噪点层与 accent-line 删、纤细 hover 显滚动条、AI 扫光单色化、末尾追加「Tahoe 皮肤 · 组件层」(注入版逐段搬入,含工具栏与筛选行浮到内容之上 + 顶部软边渐进模糊)。
- `tailwind.config.js`:圆角 md 10 / lg 14 / xl 18 / 2xl 22;`accentInk` 颜色;`shadow-glow` 改单色环;`card-hover` 无影。
- accent 上的 `text-black` 全部改 `text-accentInk`(Button / Toolbar / ActivityCenter / CollageOverlay / AiRepaintPanel / CropPanel / HandwritingModal),浅色主题下按钮文字才可见。
- `src/main.jsx`:一行按 UA 给 `<html>` 加 `electron` 类,hiddenInset 让位与拖拽区只在桌面版生效。
- `electron/main.js`:`titleBarStyle:"hiddenInset"` + `trafficLightPosition`。
- demo 资产从 `public/` 移到 `lg-demo-electron/`(photos / lab),避免打进安装包;注入脚本删除。
- 验证:vite build 通过;真 App 深 / 浅两套截图确认;滚动时照片从工具栏胶囊底下穿过并被顶部渐进模糊压暗。

随后三处修正(同分支第二次提交):① 分组胶囊(布局 / 地图)里的高亮改 28 高全圆角,与 32 高外壳同心,之前 rounded-md 的高亮矩形和胶囊边不重合;② 菜单 / 弹层底从 78% 提到 94%(浅色 95%),用户:「透明的话可读性太差」,Apple 的 Regular 菜单玻璃本来也接近实色;③ **红绿灯安全区**:hiddenInset 后灯箱 / 编辑器 / 拼图这些盖住侧栏区域的全屏层左上角会撞灯,统一让出 88px(灯占 18 至 70),规则挂在 `html.electron` 下按各层的 z-index 选择器定位,web 版不受影响。

用户追加:「header 要改掉,三个圆要融合进来」→ `electron/main.js` createWindow 加 `titleBarStyle:"hiddenInset"` + `trafficLightPosition:{x:18,y:16}`(两行,未 commit,可回退;这是 P3 唯一先做的一项),皮肤里侧栏面板 padding-top 44 让位、拖拽区 = 侧栏头 44px + 内容区顶部 8px 细条(避开控件防光标闪)。

未做(结构相关,留待确认后):工具栏浮到内容之上的滚动边缘效果、图标簇合并为三组、检查器点选滑入、vibrancy / 透明窗(P3 其余)。

## 附:参考

- Apple WWDC25: Meet Liquid Glass — developer.apple.com/videos/play/wwdc2025/219/
- CSS-Tricks: Getting Clarity on Apple's Liquid Glass
- kube.io: Liquid Glass in the Browser: Refraction with CSS and SVG(位移图物理推导)
- LogRocket: How to create Liquid Glass effects with CSS and SVG
- WWDC25 310: Build an AppKit app with the new design — developer.apple.com/videos/play/wwdc2025/310/
- WWDC25 356: Get to know the new design system — developer.apple.com/videos/play/wwdc2025/356/
- HIG: Materials / Sidebars / Toolbars / Windows / Scroll views — developer.apple.com/design/human-interface-guidelines/
- Zed 讨论 #38233(Tahoe 26pt / 16pt 圆角来源)— github.com/zed-industries/zed/discussions/38233
- electron/electron#47833(Electron 窗口在 Tahoe 上约 14px 圆角、无法自定义)
- lapcatsoftware.com/articles/2026/3/1.html(带工具栏窗口圆角更大)
