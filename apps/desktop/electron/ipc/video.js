// Video helpers the gallery and lightbox ask for: an on-demand H.264 playback
// proxy for clips Chromium cannot decode (10-bit HEVC; any HEVC on Windows),
// and a keyframe filmstrip for hover-scrub. Both run the bundled video-tool
// once and cache under userData, which is already an allowed media dir.
// Extracted from main.js (review 2026-09-16 §2).
//   allowlist       electron/media/allowlist.js
//   videoToolPath   the native binary (packaged vs dev location is main's call)
//   runVideoTool    where there is no such binary (Windows): (args, timeoutMs)
//                   => Promise, the sidecar running the same commands with
//                   FFmpeg; rejects when they fail
//   timeouts        { transcode, frames } ms overrides (tests: shorter limits)

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { spawnSafely } = require("../spawnSafely");

// A long 4K clip on a slow PC takes minutes to transcode in software.
const TRANSCODE_TIMEOUT_MS = 30 * 60_000;
const FRAMES_TIMEOUT_MS = 3 * 60_000;

function register({ ipcMain, app, allowlist, videoToolPath, runVideoTool = null, timeouts = {} }) {
  const transcodeTimeoutMs = timeouts.transcode ?? TRANSCODE_TIMEOUT_MS;
  const framesTimeoutMs = timeouts.frames ?? FRAMES_TIMEOUT_MS;
  const runTool = runVideoTool
    ? (args, timeoutMs) => runVideoTool(args, timeoutMs).then(() => true, () => false)
    : (args, timeoutMs) => new Promise((resolve) => {
      let child;
      try { child = spawnSafely(spawn, videoToolPath, args); } catch { resolve(false); return; }
      // A video-tool that never finishes (a clip FFmpeg stalls on) must not
      // leave the renderer's request pending forever: kill it, report failure.
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve(false);
      }, timeoutMs);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    });

  // Transcodes via the bundled video-tool, caches under userData, and returns
  // the proxy's absolute path (served by the media HTTP server). Idempotent.
  ipcMain.handle("app:video-proxy", async (_event, originalPath) => {
    try {
      const resolved = path.resolve(String(originalPath || ""));
      if (!(await allowlist.isAllowedMediaPathLoaded(resolved))) return null;
      if (!fs.existsSync(resolved)) return null;
      const stat = fs.statSync(resolved);
      const key = crypto.createHash("sha1").update(`${resolved}:${stat.size}:${stat.mtimeMs}`).digest("hex");
      const dir = path.join(app.getPath("userData"), "video-proxies");
      fs.mkdirSync(dir, { recursive: true });
      allowlist.addAllowedMediaDir(dir);
      const out = path.join(dir, `${key}.mp4`);
      if (!fs.existsSync(out)) {
        const ok = (await runTool(["transcode", resolved, out], transcodeTimeoutMs)) && fs.existsSync(out);
        if (!ok) { try { fs.unlinkSync(out); } catch { /* ignore */ } return null; }
      }
      return out;
    } catch (err) {
      console.error("[video-proxy] failed:", err);
      return null;
    }
  });

  // Small JPEGs (codec-agnostic, no playback), generated once and cached.
  // Returns absolute frame paths (served as images via media://).
  ipcMain.handle("app:video-keyframes", async (_event, originalPath, count) => {
    try {
      const resolved = path.resolve(String(originalPath || ""));
      if (!(await allowlist.isAllowedMediaPathLoaded(resolved))) return [];
      if (!fs.existsSync(resolved)) return [];
      const stat = fs.statSync(resolved);
      const n = Math.max(2, Math.min(24, Number(count) || 12));
      const key = crypto.createHash("sha1").update(`${resolved}:${stat.size}:${stat.mtimeMs}:${n}`).digest("hex");
      const dir = path.join(app.getPath("userData"), "video-keyframes", key);
      if (!fs.existsSync(path.join(dir, "manifest.json"))) {
        fs.mkdirSync(dir, { recursive: true });
        if (!(await runTool(["frames", resolved, dir, "--count", String(n), "--max-edge", "320"], framesTimeoutMs))) return [];
      }
      return fs.readdirSync(dir)
        .filter((f) => /^frame_\d+\.jpg$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
        .map((f) => path.join(dir, f));
    } catch (err) {
      console.error("[video-keyframes] failed:", err);
      return [];
    }
  });
}

module.exports = { register };
