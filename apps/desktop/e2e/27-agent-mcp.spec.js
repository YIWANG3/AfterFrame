// Agent-in-the-loop MCP smoke — a real LLM (headless Claude Code, haiku)
// gets a natural-language task and must find and call our tools. Verifies the
// layer 26-mcp-parity.spec.js can't: tool names/descriptions/schemas actually
// work for an agent.
//
// OPT-IN: costs real tokens (~$0.05/task) and is non-deterministic, so it is
// skipped unless AGENT_E2E=1 (run: npm run e2e:agent). Not a merge gate —
// run it after adding/renaming tools or editing tool descriptions.
//
// Assertion style: check the CATALOG (via direct tools/call) for the outcome
// the task demanded, plus that the expected tool family was used. Never
// assert on the agent's prose.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");
const { runAgentTask, calledTool, claudeAvailable } = require("./helpers/agent");

const ENABLED = process.env.AGENT_E2E === "1";

async function callTool(port, name, args) {
  const result = await mcpCall(port, "tools/call", { name, arguments: args || {} });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return JSON.parse(result.content.find((c) => c.type === "text").text);
}

test.describe("Agent → MCP smoke (opt-in: AGENT_E2E=1)", () => {
  test.skip(!ENABLED, "set AGENT_E2E=1 to run the agent-in-the-loop suite");
  test.skip(ENABLED && !claudeAvailable(), "claude CLI not installed");

  let ctx;
  test.beforeAll(async () => {
    ctx = await launchApp({ testName: "agent-mcp" });
    // Wait for MCP to accept requests before handing the port to an agent.
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        await mcpCall(ctx.mcpPort, "ping");
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });
  test.afterAll(async () => {
    if (ctx) await closeApp(ctx.app, ctx.userDataDir);
  });

  test("rating task → agent finds the photo and writes the rating", async () => {
    test.setTimeout(240_000);
    const before = await callTool(ctx.mcpPort, "search_assets", { query: "001-red", limit: 1 });
    expect(before.count).toBe(1);
    expect(before.assets[0].rating).not.toBe(5);

    const run = await runAgentTask({
      port: ctx.mcpPort,
      task: "In my AfterFrame library there is a photo whose filename contains '001-red'. Give it a 5-star rating. Use the afterframe tools.",
    });
    expect(calledTool(run.toolCalls, "update_assets"), JSON.stringify(run.toolCalls)).toBe(true);

    const after = await callTool(ctx.mcpPort, "search_assets", { query: "001-red", limit: 1 });
    expect(after.assets[0].rating).toBe(5);
  });

  test("crop task → agent produces a 1:1 derived version in the stack", async () => {
    test.setTimeout(240_000);
    const before = await callTool(ctx.mcpPort, "search_assets", { query: "002", limit: 1 });
    expect(before.count).toBe(1);
    const src = before.assets[0];

    const run = await runAgentTask({
      port: ctx.mcpPort,
      task: `Crop the photo with asset id ${src.asset_id} to a square (1:1) using the afterframe tools. Do not do anything else.`,
    });
    expect(calledTool(run.toolCalls, "crop_assets"), JSON.stringify(run.toolCalls)).toBe(true);

    // Outcome: a derived sibling now lives in the source's version stack
    // (same resource_set_id, version_kind "derived", square dimensions).
    const after = await callTool(ctx.mcpPort, "search_assets", { limit: 100 });
    const derived = after.assets.filter(
      (a) => a.resource_set_id === src.resource_set_id && a.version_kind === "derived",
    );
    expect(derived.length, JSON.stringify(run.toolCalls)).toBeGreaterThan(0);
    expect(derived.some((a) => a.width === a.height)).toBe(true);
  });

  test("discovery task → agent answers from search without hallucinating tools", async () => {
    test.setTimeout(240_000);
    const run = await runAgentTask({
      port: ctx.mcpPort,
      task: "How many videos (not photos) are in my AfterFrame library? Answer with just the number.",
    });
    // Any of these is a legitimate route; what matters is it used OUR tools.
    const usedOurs = run.toolCalls.every((c) => c.name.startsWith("mcp__afterframe__"));
    expect(run.toolCalls.length).toBeGreaterThan(0);
    expect(usedOurs, JSON.stringify(run.toolCalls)).toBe(true);
    expect(run.resultText.trim()).toMatch(/\b1\b/); // seeded catalog ships exactly one video
  });
});
