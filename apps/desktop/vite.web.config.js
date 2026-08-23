// Static web build (npm run build:web) — same source tree as the desktop
// renderer, web.html entry only. Output is a self-contained static site.
const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const { resolve } = require("path");

module.exports = defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist-web",
    rollupOptions: {
      input: { web: resolve(__dirname, "web.html") },
    },
  },
});
