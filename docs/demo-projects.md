# Demo Projects — Agent Benchmark

将 AfterFrame 的功能拆成独立的小项目，用于测试 AI Agent 一次通过率。
每个项目设计为 **可独立运行**，有明确的输入/输出/验收标准。

---

## 设计原则

每个 demo 的 spec 应包含：
1. **技术栈声明** — 框架、依赖、版本
2. **数据模型** — schema 或 type 定义
3. **UI 参考** — 布局描述或 ASCII mockup
4. **交互行为** — 用户操作 → 预期结果
5. **边界条件** — 空状态、错误状态、极端数据
6. **验收标准** — 可机器验证的 checklist

---

## Level 1: 纯前端，无后端依赖

### Demo 1: Image Grid Gallery

**目标**: 响应式图片网格，支持多种布局模式

**技术栈**: React 18, Vite, Tailwind CSS, lucide-react

**数据**: 硬编码 20 张图片对象 `{ id, src, width, height, title }`

**功能**:
- 三种布局切换: grid (等高行) / justified (Flickr 风格自适应宽度) / waterfall (Pinterest 瀑布流)
- 缩略图大小滑块 (120px–360px)
- 单击选中 (高亮边框), Cmd+Click 多选, Shift+Click 范围选
- 键盘方向键导航 (需感知当前布局的行列关系)
- 空状态显示占位文案

**验收标准**:
- [ ] 三种布局均正确渲染，无溢出
- [ ] justified 布局每行宽度填满容器 (误差 <2px)
- [ ] waterfall 布局列高差 <1 个 item 高度
- [ ] 多选状态正确 (Cmd 切换, Shift 范围)
- [ ] 方向键在 waterfall 中按列移动，在 grid 中按行移动

**给 Agent 的 spec 应包含**: justified-layout 算法说明或指定使用 `justified-layout` npm 包；选中态的视觉样式 token；键盘导航在不同布局下的行为矩阵。

---

### Demo 2: Image Crop Tool

**目标**: Canvas 上的图片裁剪工具

**技术栈**: React 18, Vite, Tailwind CSS

**数据**: 一张本地图片 URL

**功能**:
- 加载图片到 canvas，居中显示，fit 到容器
- 裁剪框: 8 个拖拽手柄 (四角 + 四边中点)
- 预设比例: Free / 1:1 / 4:3 / 16:9 / 3:2
- 旋转: ±45° 自由旋转滑块 + 90° 步进按钮
- 翻转: 水平/垂直
- 裁剪区域外半透明遮罩 (scrim)
- Undo/Redo 栈
- 导出: 将裁剪结果绘制到 offscreen canvas 并下载

**验收标准**:
- [ ] 拖拽手柄时裁剪框不超出图片边界
- [ ] 切换比例后裁剪框保持居中且满足比例约束
- [ ] 旋转后裁剪框自动缩小以保持在图片内
- [ ] Undo 恢复上一步完整状态 (角度+裁剪框+翻转)
- [ ] 导出图片尺寸 = 裁剪框像素尺寸

**给 Agent 的 spec 应包含**: scrim 颜色值和透明度；手柄的尺寸/颜色；旋转时裁剪框如何 refit 的算法描述；状态结构体定义。

---

### Demo 3: Text Overlay Editor

**目标**: 在图片上叠加可编辑文本层

**技术栈**: React 18, Vite, Tailwind CSS

**数据**: 一张背景图 + 系统字体列表 (mock 20 个)

**功能**:
- 添加文本层，DOM 渲染 (非 canvas)
- 每层属性: 字体、字号、颜色、对齐、粗细 (100-900)、阴影
- 拖拽移动、角落缩放、旋转手柄
- 双击进入编辑模式 (contentEditable)
- 图层列表面板: 排序、显示/隐藏、删除
- Cmd+C/V 复制粘贴层 (含完整样式)
- 导出: html2canvas 或 DOM → canvas 合成

**验收标准**:
- [ ] 拖拽/缩放/旋转互不干扰
- [ ] 编辑模式下文字可选中、输入
- [ ] 复制粘贴后新层偏移 10px 避免重叠
- [ ] 导出图片包含所有可见层

**给 Agent 的 spec 应包含**: 变换的 CSS 实现方式 (transform-origin 策略)；旋转手柄的位置和交互；图层 z-index 管理规则；文本状态的数据结构。

---

### Demo 4: Color Picker Popover

**目标**: 完整的颜色选择器组件

**技术栈**: React 18, Vite, Tailwind CSS

**功能**:
- 色相/饱和度面板 (HSV 2D 区域)
- 色相条 (水平)
- 透明度条 (棋盘格背景)
- Hex 输入 (含 alpha)
- RGB 数值输入
- 吸管工具 (EyeDropper API, 需 fallback)
- 最近使用颜色 (最多 8 个)
- Popover 定位: 自动避免超出视口

**验收标准**:
- [ ] HSV 面板拖拽流畅，颜色实时更新
- [ ] Hex 输入支持 3/6/8 位格式
- [ ] 透明度 0 时预览显示棋盘格
- [ ] EyeDropper 不可用时按钮 disabled
- [ ] Popover 靠近边缘时翻转方向

**给 Agent 的 spec 应包含**: HSV ↔ RGB 转换公式或指定库；Popover 的触发方式和动画；棋盘格的 CSS 实现；组件 API (props/events)。

---

## Level 2: 前端 + 简单后端 (IPC/API)

### Demo 5: Electron Image Browser

**目标**: Electron 应用，浏览本地文件夹中的图片

**技术栈**: Electron 28+, React 18, Vite, sharp

**功能**:
- 菜单/按钮选择文件夹
- 递归扫描 jpg/png/tiff/heic
- 生成缩略图 (sharp, 300px 长边, 缓存到 .thumbnails/)
- 网格展示缩略图
- 点击查看大图 (Lightbox)
- 文件信息面板: 尺寸、大小、修改时间

**验收标准**:
- [ ] 1000 张图片文件夹打开 <3s (缩略图缓存后)
- [ ] HEIC 格式正确解码
- [ ] 缩略图缓存命中时不重新生成
- [ ] Lightbox 支持左右键切换

**给 Agent 的 spec 应包含**: Electron IPC 通道命名规范；sharp 的具体调用参数；缩略图缓存路径策略；preload script 暴露的 API 接口定义。

---

### Demo 6: SQLite Asset Database

**目标**: Python CLI 管理图片资产数据库

**技术栈**: Python 3.11+, SQLite, argparse

**数据模型**:
```sql
CREATE TABLE export_assets (
  asset_id TEXT PRIMARY KEY,
  stem TEXT NOT NULL,
  export_path TEXT UNIQUE NOT NULL,
  width INTEGER, height INTEGER,
  file_size INTEGER,
  camera_model TEXT,
  rating INTEGER DEFAULT 0,
  imported_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**功能**:
- `scan <dir>` — 扫描目录，upsert 到数据库
- `browse --sort <field> --order asc|desc --limit N --offset M` — 分页查询
- `detail <asset_id>` — 返回单条 JSON
- `rate <asset_id> <0-5>` — 设置评分
- `search <query>` — stem/camera_model 模糊搜索
- `summary` — 统计信息 (总数、按评分分布、按相机分布)

**验收标准**:
- [ ] scan 幂等 (重复扫描不产生重复记录)
- [ ] browse 分页正确 (offset + limit)
- [ ] 所有命令输出合法 JSON
- [ ] 空数据库不崩溃

**给 Agent 的 spec 应包含**: 完整 schema DDL；每个命令的 JSON 输出格式示例；upsert 的冲突策略 (ON CONFLICT 字段)；支持的图片格式列表。

---

### Demo 7: Metadata Extraction Pipeline

**目标**: 从图片文件提取 EXIF/XMP 元数据

**技术栈**: Python 3.11+, Pillow, defusedxml

**功能**:
- 输入: 图片文件路径
- 输出: 标准化 JSON 结构
- 提取: 相机型号、镜头、ISO、快门、光圈、GPS、拍摄时间
- XMP sidecar (.xmp) 读取: rating, label, subject tags
- Lightroom XMP 评分映射到 0-5
- 处理缺失字段 (null, 不报错)

**验收标准**:
- [ ] JPEG EXIF 正确提取所有字段
- [ ] RAW 文件 (CR3/ARW) 的 XMP sidecar 正确读取
- [ ] GPS 坐标转换为十进制度数
- [ ] 无 EXIF 的 PNG 返回全 null 字段，不报错
- [ ] XMP rating="5" 映射为 app_rating=5

**给 Agent 的 spec 应包含**: 输出 JSON 的完整 schema；XMP namespace URI；GPS 度分秒→十进制的公式；各 RAW 格式的 XMP sidecar 命名规则。

---

## Level 3: 全栈集成

### Demo 8: AI Image Repaint (Job Queue)

**目标**: 提交图片到 AI API 进行风格化处理，异步 job 管理

**技术栈**: Python backend (FastAPI or CLI), React frontend, OpenAI/Gemini API

**功能**:
- 前端: 选择图片 → 选择风格 prompt → 提交
- 后端: 创建 job 记录 → 调用 AI API → 轮询/回调 → 保存结果
- Job 状态: pending → running → completed/failed
- 前端轮询 job 状态，完成后显示 before/after 对比
- 支持取消 running job
- 历史记录: 查看某张图片的所有 repaint 结果

**验收标准**:
- [ ] Job 创建后立即返回 job_id
- [ ] 前端轮询间隔 2s，completed 后停止
- [ ] API key 无效时返回明确错误，不崩溃
- [ ] 并发提交 3 个 job 不冲突
- [ ] Before/after 对比支持滑块和并排两种模式

**给 Agent 的 spec 应包含**: Job 状态机图；API 调用的具体参数 (model, size, prompt template)；轮询协议 (HTTP endpoint + response schema)；错误码定义；API key 存储方式。

---

### Demo 9: Collage Builder

**目标**: 多图拼贴编辑器

**技术栈**: React 18, Vite, Tailwind CSS, sharp (导出)

**功能**:
- 拖入 2-9 张图片
- 预设布局模板 (2x1, 1x2, 2x2, 3x1, 网格, 自由)
- 每张图可: 拖拽位置、缩放、裁剪可见区域
- 间距调节 (0-20px)
- 背景色选择
- 圆角调节
- 右键替换单张图片
- 导出为单张图片 (指定分辨率)

**验收标准**:
- [ ] 预设布局切换时图片自动填充对应格子
- [ ] 拖拽图片在格子内平移 (不超出格子边界)
- [ ] 缩放时以格子中心为锚点
- [ ] 导出分辨率 = 用户指定值，非屏幕分辨率
- [ ] 间距变化实时预览

**给 Agent 的 spec 应包含**: 布局模板的数据结构 (每个 cell 的 x/y/w/h 百分比)；图片在 cell 内的 object-fit 策略；导出时的 canvas 合成顺序；拖拽的坐标系转换。

---

### Demo 10: Resizable Panel Layout

**目标**: 三栏可调布局 (Sidebar + Content + Inspector)

**技术栈**: React 18, Vite, Tailwind CSS

**功能**:
- 左侧 Sidebar (200-360px), 中间 Content (flex), 右侧 Inspector (240-420px)
- 拖拽分隔线调整宽度
- 双击分隔线重置默认宽度
- 宽度持久化到 localStorage
- 面板可折叠 (点击按钮或拖到最小值以下)
- 内容区域不被挤压到 <400px

**验收标准**:
- [ ] 拖拽流畅无闪烁 (requestAnimationFrame)
- [ ] 刷新后恢复上次宽度
- [ ] 窗口缩小时面板自动折叠以保护内容区
- [ ] 折叠动画 <200ms

**给 Agent 的 spec 应包含**: CSS Grid vs Flexbox 的选择及原因；拖拽实现方式 (mousedown/move/up vs resize observer)；localStorage key 命名；折叠的触发阈值。

---

## 提高一次通过率的 Spec 写法建议

| 维度 | 低通过率写法 | 高通过率写法 |
|------|-------------|-------------|
| 数据 | "显示一些图片" | 给出完整 mock 数据结构 + 20 条示例 |
| 布局 | "左右分栏" | ASCII mockup + 具体像素值/百分比 |
| 交互 | "可以拖拽" | mousedown→mousemove→mouseup 的完整状态机 |
| 样式 | "暗色主题" | 给出 CSS 变量表 (--bg: #0c1218, --text: #e2e8f0...) |
| 边界 | 不提 | 明确列出: 空数据、超长文本、并发操作 |
| 依赖 | "用合适的库" | 指定包名+版本: `justified-layout@4.1.0` |
| 状态 | "支持 undo" | 给出状态结构体 + 哪些操作入栈 |
| API | "调后端" | 给出完整 request/response JSON schema |

### 关键发现

从我们的开发历史看，Agent 容易出错的地方：

1. **坐标系转换** — 裁剪/旋转/拖拽涉及多层坐标变换，必须在 spec 中画清楚
2. **状态同步** — 面板编辑 ↔ Canvas 渲染的双向绑定，需明确谁是 source of truth
3. **布局算法** — justified/waterfall 不是 CSS 原生支持的，需要指定算法或库
4. **异步竞态** — 分页加载、job 轮询、IPC 调用的 race condition，需要在 spec 中定义取消策略
5. **大文件问题** — 单文件 >500 行时 Agent 容易丢失上下文，spec 应预先规划文件拆分

---

## 执行计划

建议按以下顺序测试：

1. **Demo 10** (Panel Layout) — 最简单，验证 Agent 对 CSS 布局的理解
2. **Demo 4** (Color Picker) — 纯组件，验证交互复杂度处理能力
3. **Demo 1** (Gallery) — 验证布局算法 + 键盘导航
4. **Demo 6** (SQLite CLI) — 验证后端逻辑 + 数据建模
5. **Demo 2** (Crop Tool) — 验证坐标系变换能力
6. **Demo 3** (Text Overlay) — 验证 DOM 变换 + 状态管理
7. **Demo 5** (Electron Browser) — 验证全栈集成
8. **Demo 8** (AI Repaint) — 验证异步 job 管理
9. **Demo 9** (Collage) — 综合验证

每个 demo 跑两轮：
- Round 1: 给出上表"低通过率"级别的 spec
- Round 2: 给出"高通过率"级别的 spec
- 对比结果，量化 spec 质量对成功率的影响
