// Video-asset tests — the seeded catalog carries one real sample clip
// (test-videos/z-sample-video.mp4, a 2s segment trimmed from real footage).
// Exercises the video surface end-to-end: it indexes as asset_type='video'
// (probe metadata + poster frame), renders a duration badge in the gallery,
// opens the custom VideoPlayer in the Lightbox, and is visible to the agent
// (MCP) surface with its poster + dimensions.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall, galleryCards } = require("./helpers/app");

const VIDEO_FILE = "z-sample-video.mp4";
const NATIVE = process.platform === "darwin";

test.describe("Video assets", () => {
  let app, window, userDataDir, mcpPort;

  test.beforeAll(async () => {
    ({ app, window, userDataDir, mcpPort } = await launchApp({ testName: "video" }));
    // Wait for the initial gallery query to settle.
    await galleryCards(window).first().waitFor({ timeout: 15_000 });
  });
  test.afterAll(async () => {
    await closeApp(app, userDataDir);
  });

  test("the sample clip indexes as a single video asset", async () => {
    const videoCards = window.locator("[data-gallery-item='true'][data-asset-type='video']");
    await expect(videoCards).toHaveCount(1);
    // The remaining 13 are images (10 gradients + 3 photos) — sanity-check the
    // type split so a regression that mis-types images as video is caught.
    await expect(
      window.locator("[data-gallery-item='true'][data-asset-type='image']"),
    ).toHaveCount(13);
    await expect(videoCards.first()).toHaveAttribute(
      "data-image-path",
      new RegExp(`${VIDEO_FILE}$`),
    );
  });

  test("the video card shows a duration badge", async () => {
    const card = window.locator("[data-gallery-item='true'][data-asset-type='video']").first();
    // formatDuration(2.167) → "0:02". The badge lives inside the card overlay.
    await expect(card.getByText("0:02")).toBeVisible();
  });

  test("double-click opens the Lightbox with a video playback surface", async () => {
    const card = window.locator("[data-gallery-item='true'][data-asset-type='video']").first();
    await card.dblclick();

    // macOS mounts an AVPlayer surface; other platforms mount <video>.
    // Both share the same app controls (the Seek range is a stable anchor).
    const video = window.locator("[data-video-engine]");
    await expect(video).toBeVisible({ timeout: 15_000 });
    // The engine reads "avplayer" from the first render, and a native failure
    // falls back to <video> quietly: only a first frame proves AVPlayer opened.
    if (NATIVE) await expect(video).toHaveAttribute("data-video-ready", "true", { timeout: 15_000 });
    await expect(video).toHaveAttribute("data-video-engine", NATIVE ? "avplayer" : "html");
    if (!NATIVE) await expect(window.locator("video")).toHaveAttribute("src", new RegExp(`${VIDEO_FILE.replace(".", "\\.")}`));
    await expect(window.getByLabel("Seek")).toBeVisible();

    // Close the Lightbox so it doesn't bleed into later expectations.
    await window.keyboard.press("Escape");
    await expect(window.locator("[data-video-engine]")).toHaveCount(0);
  });

  // The 0.5.8 report's gap: the test above passes for a <video> that is
  // mounted but never decodes a frame. The sample is 4K HEVC, like the
  // phone and camera clips the report played.
  test("the clip really plays: frames decode, time runs, seeking and pausing take effect", async () => {
    // Chromium decodes HEVC with the system's decoder. Windows has none unless
    // the HEVC Video Extensions are installed: there the clip "plays" without
    // a picture, and the lightbox swaps in an H.264 proxy (1080p) that the
    // sidecar makes with FFmpeg, in software, so it takes a while.
    const proxied = process.platform === "win32";
    test.setTimeout(proxied ? 180_000 : 30_000);
    const card = window.locator("[data-gallery-item='true'][data-asset-type='video']").first();
    await card.dblclick();
    const video = window.locator("[data-video-engine]");
    await expect(video).toBeVisible({ timeout: 15_000 });
    const state = () => window.evaluate(async () => {
      const surface = document.querySelector("[data-video-engine]");
      if (surface.dataset.videoEngine === "avplayer") {
        const native = await window.mediaWorkspace.nativeVideoState(surface.dataset.videoSession);
        return native ? { ...native, paused: !native.playing, error: native.failed ? "AVPlayer failed" : null } : { ready: false };
      }
      const v = surface.querySelector("video");
      return {
        ready: v.readyState >= 2, width: v.videoWidth, height: v.videoHeight,
        duration: v.duration, time: v.currentTime, paused: v.paused, ended: v.ended,
        seeking: v.seeking, frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
        error: v.error?.code ?? null,
      };
    });

    if (proxied) {
      // While the proxy is made, the original (no picture) stays still and
      // silent: no sound, no scrubber running toward its end.
      await expect(window.getByText("Preparing video…", { exact: true })).toBeVisible({ timeout: 15_000 });
      await window.waitForTimeout(2_000);
      const waiting = await window.evaluate(() => {
        const v = document.querySelector("[data-video-engine] video");
        return { paused: v.paused, muted: v.muted, time: v.currentTime, width: v.videoWidth };
      });
      if (waiting.width === 0) expect(waiting).toMatchObject({ paused: true, muted: true, time: 0 });
    }

    // Decoded, at its real size (the proxy's), and playing on its own (autoplay).
    await expect.poll(async () => {
      const now = await state();
      return now.ready && now.width > 0;
    }, { timeout: proxied ? 150_000 : 15_000 }).toBe(true);
    const first = await state();
    // Still the engine it started on: a native player that failed would have
    // handed over to <video>, whose state reads the same.
    await expect(video).toHaveAttribute("data-video-engine", NATIVE ? "avplayer" : "html");
    expect(first).toMatchObject(proxied ? { width: 1920, height: 1080, error: null } : { width: 3840, height: 2160, error: null });
    expect(first.duration).toBeGreaterThan(2);
    expect(first.duration).toBeLessThan(2.2);
    await expect.poll(async () => (await state()).time, { timeout: 10_000 }).toBeGreaterThan(0.3);
    if (!NATIVE) expect((await state()).frames).toBeGreaterThan(0);

    // Pause with the player's own button: time holds still.
    const playPause = video.locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").getByRole("button").first();
    await playPause.click();
    await expect.poll(async () => (await state()).paused).toBe(true);
    const held = (await state()).time;
    await window.waitForTimeout(500); // a fixed window: time must NOT move during it
    expect((await state()).time).toBeCloseTo(held, 2);

    // Seek with the scrubber: the frame there is decoded, and the readout follows.
    await window.getByLabel("Seek").fill("1");
    await expect.poll(async () => {
      const now = await state();
      return !now.seeking && now.ready && Math.abs(now.time - 1) < 0.1;
    }, { timeout: 10_000 }).toBe(true);
    await expect(window.getByText("0:01", { exact: true })).toBeVisible();

    // Play again from there, to the end.
    await playPause.click();
    await expect.poll(async () => (await state()).time, { timeout: 10_000 }).toBeGreaterThan(1.2);
    await expect.poll(async () => (await state()).ended, { timeout: 10_000 }).toBe(true);
    if (!NATIVE) expect((await state()).frames).toBeGreaterThan(first.frames);

    await window.keyboard.press("Escape");
    await expect(window.locator("[data-video-engine]")).toHaveCount(0);
  });

  test("the video is visible on the MCP agent surface with a poster", async () => {
    const result = await mcpCall(mcpPort, "tools/call", {
      name: "search_assets",
      arguments: { limit: 50 },
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    // Video asset ids carry a "video_" prefix (image_/raw_ for the rest).
    const video = payload.assets.find((a) => a.asset_id.startsWith("video_"));
    expect(video).toBeTruthy();
    expect(video.stem).toBe("z-sample-video");
    // Probe-derived dimensions (4K source) and a generated poster come through.
    expect(video.width).toBe(3840);
    expect(video.height).toBe(2160);
    expect(video.thumbnail_url).toContain(`http://127.0.0.1:${mcpPort}/assets/`);
  });
});
