// The MCP tool set, by domain. Each file exports (ctx) => tools[], a tool
// being { name, description, inputSchema, async handler(args, { content }) }:
// the handler returns the JSON result (null when it filled `content` itself,
// as view_assets does with images). toolSchemas.test.js scans these files
// as text — keep the shape: `name:` on its own line, `inputSchema:` with a
// `properties: {` block, then `async handler(`.
//
// ctx (built in server.js):
//   deps                 what main.js passed createMcpServer: the agent bridge
//                        (revealAssetsInApp, askRenderer, getCurrentSelection,
//                        broadcastCatalogChanged), task starters, watcher…
//   commands             sidecar verb layer
//   getCatalogState      catalog.state
//   port                 the server's port, for thumbnail URLs
//   sharp                image library (view_assets)
//   startImportTask, formatJobStatus, registerRoots
//   requireCatalog()     the open catalog's path, or throws
//   derivedOutputDir()   <catalog>/derived, created — where derived versions go
//   rememberPreview / forgetPreview / resolvePreviewPaths / withRawHdPreviews
//                        the preview-path cache behind /assets/{id}

const GROUPS = [
  require("./browse"),
  require("./app"),
  require("./assets"),
  require("./library"),
  require("./jobs"),
  require("./people"),
  require("./visual"),
  require("./render"),
];

function createTools(ctx) {
  const tools = GROUPS.flatMap((group) => group(ctx));
  const names = new Set();
  for (const { name } of tools) {
    if (names.has(name)) throw new Error(`MCP tool defined twice: ${name}`);
    names.add(name);
  }
  return tools;
}

module.exports = { createTools };
