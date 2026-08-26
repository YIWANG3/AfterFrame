// Agent-in-the-loop harness: drive a REAL LLM agent (headless Claude Code,
// `claude -p`) against the app's embedded MCP server and report which tools it
// called plus its final answer. This tests the layer the direct tools/call
// specs can't: whether an agent, given a natural-language task, discovers and
// uses our tools correctly (names, descriptions, schemas).
//
// Non-deterministic and token-metered by design — specs built on this are
// gated behind AGENT_E2E=1 and assert on CATALOG OUTCOMES (did the rating
// change, did a version appear), never on the agent's wording.

const { execFile } = require("node:child_process");

// The nested `claude` must authenticate with the developer's own credentials,
// not whatever session-scoped tokens the parent environment carries.
const STRIPPED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
];

function agentEnv() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  return env;
}

function claudeAvailable() {
  try {
    require("node:child_process").execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one natural-language task through headless Claude Code against the
 * app's MCP server.
 * @returns {Promise<{toolCalls: {name, input}[], resultText: string, events: object[]}>}
 */
function runAgentTask({ port, task, maxTurns = 12, model = "haiku", timeoutMs = 150_000 }) {
  const mcpConfig = JSON.stringify({
    mcpServers: { afterframe: { type: "http", url: `http://127.0.0.1:${port}/mcp` } },
  });
  const args = [
    "-p", task,
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",              // ignore the developer's own MCP servers
    "--allowedTools", "mcp__afterframe", // auto-approve our tools, nothing else
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(maxTurns),
    "--model", model,
  ];
  return new Promise((resolve, reject) => {
    execFile("claude", args, { env: agentEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const events = String(stdout)
        .split("\n")
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      if (!events.length) {
        return reject(new Error(`claude produced no output: ${err?.message || ""}\n${String(stderr).slice(-2000)}`));
      }
      const toolCalls = [];
      let resultText = "";
      let isError = false;
      for (const event of events) {
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
          }
        }
        if (event.type === "result") {
          resultText = event.result || "";
          isError = event.subtype !== "success";
        }
      }
      if (isError && /authenticat|401/i.test(resultText)) {
        return reject(new Error(`claude could not authenticate — run \`claude\` interactively once to log in. (${resultText})`));
      }
      resolve({ toolCalls, resultText, events });
    });
  });
}

function calledTool(toolCalls, shortName) {
  return toolCalls.some((c) => c.name === `mcp__afterframe__${shortName}`);
}

module.exports = { runAgentTask, calledTool, claudeAvailable };
