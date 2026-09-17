const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const esbuild = require("esbuild");

// AFTERFRAME_COVERAGE=1 (npm run e2e:coverage) builds an istanbul-instrumented
// renderer: every src/ module reports hit counts into window.__coverage__,
// which e2e/helpers/app.js harvests before each app closes. Never on for a
// normal build — the instrumented bundle is slower and much larger. The
// plugin is ESM-only, hence the dynamic import inside an async config.
const coverageBuild = process.env.AFTERFRAME_COVERAGE === "1";
async function coveragePlugins() {
  if (!coverageBuild) return [];
  const { default: istanbul } = await import("vite-plugin-istanbul");
  return [istanbul({
    include: "src/**/*.{js,jsx}",
    exclude: ["node_modules", "**/*.test.{js,jsx}"],
    extension: [".js", ".jsx"],
    requireEnv: false,
    forceBuildInstrument: true,
  })];
}

// MapLibre 6 ships an ES-module worker. Passing Vite's `?worker&url` result
// through MapLibre loses Vite's worker-constructor metadata in development,
// so Chromium starts that URL as a classic worker and rejects its first
// `import` statement. Serve one explicitly classic, self-contained worker in
// development and emit the same file for packaged builds.
function maplibreClassicWorker() {
  let bundlePromise = null;
  const buildWorker = () => {
    if (!bundlePromise) {
      bundlePromise = esbuild.build({
        entryPoints: [require.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "chrome120",
        minify: true,
        write: false,
      }).then((result) => result.outputFiles[0].text);
    }
    return bundlePromise;
  };

  return {
    name: "afterframe-maplibre-classic-worker",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/maplibre-worker.cjs") return next();
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(await buildWorker());
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "maplibre-worker.cjs",
        source: await buildWorker(),
      });
    },
  };
}

module.exports = defineConfig(async () => ({
  base: "./",
  plugins: [react(), maplibreClassicWorker(), ...(await coveragePlugins())],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
}));
