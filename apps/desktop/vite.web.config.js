// Static web build (npm run build:web) — same source tree as the desktop
// renderer, web.html entry only. Output is a self-contained static site.
const { defineConfig, searchForWorkspaceRoot } = require("vite");
const react = require("@vitejs/plugin-react");
const { resolve } = require("path");

// The annotation system prompt is the sidecar's file, read by src/api/browser/
// llm.js as @sidecar-data/annotation_prompt.json (one text, both sides).
const SIDECAR_DATA = resolve(__dirname, "../../services/sidecar/src/media_workspace/data");

module.exports = defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@sidecar-data": SIDECAR_DATA } },
  server: { fs: { allow: [searchForWorkspaceRoot(__dirname), SIDECAR_DATA] } },
  build: {
    outDir: "dist-web",
    rollupOptions: {
      input: { web: resolve(__dirname, "web.html") },
    },
  },
});
