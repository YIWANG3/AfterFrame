# MCP 测试方法：从协议到真实 agent

> 2026-08-16 建立。对应主流实践的"三层金字塔"（unit → protocol integration → LLM evals；参考 mcp-eval / promptfoo MCP provider / τ-bench 的结果断言方法论）。

## 分层

| 层 | 测什么 | 在哪 | 何时跑 | 确定性 |
|---|---|---|---|---|
| 1. 单元 | sidecar CLI / db 层、纯函数 | `services/sidecar/tests/`、`electron/*.test.js` | 每次（`npm run test:unit`） | 完全 |
| 2. 协议集成 | HTTP → JSON-RPC → tool handler → sidecar → SQLite 全链，**每个 tool ≥1 条真实调用** | `e2e/08-mcp-http.spec.js`（面 + 老 tool）、`e2e/26-mcp-parity.spec.js`（Phase 1 新 tool） | 每次（`npm run e2e`），**合并门槛** | 完全 |
| 3. agent 冒烟 | 真实 LLM 从自然语言出发能否**发现并正确调用** tool——测的是 tool 命名/描述/schema 的"agent 可用性" | `e2e/27-agent-mcp.spec.js` + `e2e/helpers/agent.js` | 手动/发版前：`npm run e2e:agent`（需本机 `claude` 已登录）；默认 skip，**不进 CI 门槛** | 不确定（真模型） |

## 第 3 层的机制（helpers/agent.js）

- 用 **无头 Claude Code**（`claude -p`）作为真实 agent：`--mcp-config` 指到被测 App 实例的 `http://127.0.0.1:<port>/mcp`，`--strict-mcp-config` 屏蔽开发者自己的 MCP，`--allowedTools mcp__afterframe` 只放行我们的 tool，`--output-format stream-json` 解析出每次 tool_use。
- **凭据**：剥掉父进程的会话级 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` 等（嵌套运行时它们无效，会 401），子进程用开发者自己的 `claude` 登录（订阅额度，不需要单独 API key）。模型默认 haiku（`claude-haiku-4-5`），单任务成本约 $0.05 或等值订阅用量。
- **断言只看结果，不看话术**（τ-bench 式"数据库终态比较"）：任务跑完后用直连 `tools/call` 查 catalog——评分变没变、版本栈里有没有新 derived、位置写没写进去；外加"用到了预期 tool 家族"“只用了我们的 tool"两个轨迹断言。绝不对 agent 的文字回答做字符串匹配（除了封闭答案如"库里有几个视频"）。
- App 用 `launchApp` 起在隔离 tmp catalog 上，agent 写坏也不影响真实数据。

## 新增一个 tool 时的清单

1. **必做**：`26-mcp-parity.spec.js`（或 08）加 ≥1 条直连 `tools/call` 用例——正常路径 + 一条参数校验错误路径；`08` 的 tools/list 计数 +1。
2. **旗舰流程才加**：`27-agent-mcp.spec.js` 加一条自然语言任务（模板：准备初态 → `runAgentTask` → `calledTool` 轨迹断言 → 直连查询终态断言）。不是每个 tool 都要——挑用户真会说的话（"给这张打 5 星"），2～5 条控制成本与抖动。
3. **描述改了也要跑第 3 层**：tool rename / description 调整不会 break 第 2 层，但会 break agent 发现率——`npm run e2e:agent` 过一遍。
4. 不确定性的应对：任务措辞要收敛（指名 asset、说清"不要做别的"）；断言容忍合法路径差异（如 agent 可能先 search 再 crop）；抖动>偶发时优先改 tool 描述而不是改测试。

## 已知边界 / 以后可加

- pass^k（同任务跑 k 次全过）衡量可靠性——现在 n=1，够冒烟；发版前可 `--repeat-each=3`。
- 更大任务集 + 评分板（promptfoo/mcp-eval 等框架）在 tool 数继续涨后再考虑；当前规模自写 harness 更薄、零依赖。
- `claude` CLI 未安装或未登录时该层报可读错误并跳过。
