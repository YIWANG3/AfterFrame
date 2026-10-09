// Where there is no video-tool (Windows), the playback proxy and the hover
// filmstrip come from the sidecar running the same commands with FFmpeg.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { register } = require("./video");

function setup(runVideoTool) {
  const handlers = new Map();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-video-ipc-"));
  const clip = path.join(userData, "clip.mp4");
  fs.writeFileSync(clip, "a clip");
  register({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    app: { getPath: () => userData },
    allowlist: { isAllowedMediaPathLoaded: async () => true, addAllowedMediaDir: () => {} },
    videoToolPath: path.join(userData, "no-video-tool"),
    runVideoTool,
  });
  const ask = (channel, ...args) => handlers.get(channel)(null, ...args);
  return { ask, userData, clip };
}

test("the proxy is the sidecar's transcode, made once", async () => {
  const calls = [];
  const { ask, userData, clip } = setup(async (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    fs.writeFileSync(args[2], "an mp4");
    return { path: args[2] };
  });
  const proxy = await ask("app:video-proxy", clip);
  assert.equal(path.dirname(proxy), path.join(userData, "video-proxies"));
  assert.deepEqual(calls[0].args, ["transcode", path.resolve(clip), proxy]);
  assert.ok(calls[0].timeoutMs >= 10 * 60_000, "minutes, for a long clip on a slow PC");
  assert.equal(await ask("app:video-proxy", clip), proxy);
  assert.equal(calls.length, 1);
});

test("a transcode that fails gives no proxy and leaves nothing behind", async () => {
  const { ask, userData, clip } = setup(async (args) => {
    fs.writeFileSync(args[2], "half an mp4");
    throw new Error("video-tool transcode: this FFmpeg has no H.264 encoder");
  });
  assert.equal(await ask("app:video-proxy", clip), null);
  assert.deepEqual(fs.readdirSync(path.join(userData, "video-proxies")), []);
});

test("the filmstrip is the sidecar's frames, in order", async () => {
  const calls = [];
  const { ask, clip } = setup(async (args) => {
    calls.push(args);
    for (const name of ["frame_10.jpg", "frame_2.jpg", "frame_0.jpg", "manifest.json"]) {
      fs.writeFileSync(path.join(args[2], name), "x");
    }
    return {};
  });
  const frames = await ask("app:video-keyframes", clip, 12);
  assert.deepEqual(frames.map((frame) => path.basename(frame)), ["frame_0.jpg", "frame_2.jpg", "frame_10.jpg"]);
  assert.deepEqual(calls[0].slice(3), ["--count", "12", "--max-edge", "320"]);
});
