# 通用 UI 开发反馈闭环 — 交接笔记

> 给新会话的自包含笔记。目标:在浏览器里标注 UI → 批量送达 Claude Code 并
> **自动触发它动手改**,无需手动切回聊天窗口打字。适用于任意 UI 项目,不只某个 mockup。

## 要解决的核心问题

做一个**通用**的 UI 开发反馈闭环:浏览器里对 UI 元素打标注 → 批量汇总 →
自动送达 AI 编码 agent(Claude Code)→ **触发它逐条实现**,全程不用回聊天框
说"拉取标注"。适用于 dev server 跑起来的真实 app 和静态页。

## 环境

- Claude Code(Anthropic CLI,跑在桌面 app 里),macOS。
- 当前项目 AfterFrame(Electron 照片管理器),但此反馈闭环需求**通用、可复用**。
- 起因:评审 mockup `docs/prototypes/frame-watermark-ui.html` 时想要更顺的标注回流。

## 已调研的现成工具

- **Vibe Annotations** — 开源,Chrome 插件 + 本地 MCP server;可标 localhost 和
  本地文件;一次 ≤200 条;经 MCP 支持 Claude Code;纯本地无云。
  GitHub: `RaphaelRegnier/vibe-annotations`,官网 vibe-annotations.com
- **Stagewise** — YC S25;浏览器 toolbar,带 DOM + 截图 + 元数据;通常要往 app
  注入 toolbar 包,更适合标**真实运行的 app**;偏 Cursor/Windsurf。
  GitHub: `stagewise-io/stagewise`

## 关键架构洞察(决定方案边界)

MCP 调用**永远由 client(agent)发起**;server / 插件只能更新自身状态,
**无法 push 启动一次 agent turn**。所以要免打字,必须让 **agent 这侧在标注完成时
被唤醒**。三条路:

1. **agent 定时轮询** — 简单;有延迟;周期性耗对话轮次。
2. **事件驱动(推荐)** — 插件 / UI 把标注写到本地文件或打到本地端点 → agent 挂
   一个**后台监听**(Claude Code 的后台任务能在条件满足时自动重新唤醒 agent,
   且续在同一会话)→ 标注 → 发送 → 文件变 → agent 自动醒 → 取批量 → 改 →
   重新挂监听。最接近"插件触发 agent",纯事件驱动,不空转。
3. **往聊天输入框注入 prompt** — 脆、依赖具体集成,想避免。

## 新会话要继续定的设计问题

- 基于 **Vibe Annotations(MCP)** 做,还是 **自建标注层 + 文件监听**(链路全可控、
  无需第三方)?
- 如何做到**跨任意项目 / dev server 通用**,而非只对静态页。
- 通用地抓取元素上下文(CSS selector / 截图 / DOM 片段)。
- 唤醒机制选哪个 Claude Code 原语最稳:后台 Bash watcher / Monitor /
  ScheduleWakeup / cron。
- 延迟、token 成本、会话连续性的权衡。

## 本会话相关产物(AfterFrame 仓库)

- `docs/prototypes/frame-watermark-ui.html` — 在评审的相框/水印 mockup。
- `docs/frame-watermark-plan.md` — 引出此需求的相框/水印功能计划。
