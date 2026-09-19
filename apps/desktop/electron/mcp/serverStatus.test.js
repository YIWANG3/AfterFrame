// Settings → Integrations reads getStatus(). start() deliberately swallows a
// failed listen so the app keeps running; the status is the only place that
// failure stays visible, so both outcomes are pinned here.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { createMcpServer } = require("./server");

function listenOnFreePort() {
  return new Promise((resolve) => {
    const blocker = net.createServer();
    blocker.listen(0, "127.0.0.1", () => resolve(blocker));
  });
}

test("reports running with the live url and tool count once listening", async () => {
  const probe = await listenOnFreePort();
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const mcp = createMcpServer({ port });
  assert.equal(mcp.getStatus().status, "starting");
  await mcp.start();
  try {
    const status = mcp.getStatus();
    assert.equal(status.status, "running");
    assert.equal(status.url, `http://127.0.0.1:${port}/mcp`);
    assert.ok(status.toolCount > 0);
    assert.equal(status.error, null);
  } finally {
    await new Promise((resolve) => mcp.server.close(resolve));
  }
});

test("reports port_in_use when another process holds the port", async () => {
  const blocker = await listenOnFreePort();
  try {
    const mcp = createMcpServer({ port: blocker.address().port });
    assert.equal(await mcp.start(), null);
    const status = mcp.getStatus();
    assert.equal(status.status, "port_in_use");
    assert.match(status.error, /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
