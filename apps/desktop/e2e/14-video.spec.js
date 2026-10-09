// Video-asset tests — the seeded catalog carries one real sample clip
// (test-videos/z-sample-video.mp4, a 2s segment trimmed from real footage).
// Exercises the video surface end-to-end: it indexes as asset_type='video'
// (probe metadata + poster frame), renders a duration badge in the gallery,
// opens the custom VideoPlayer in the Lightbox, and is visible to the agent
// (MCP) surface with its poster + dimensions.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp, mcpCall } = require("./helpers/app");

const VIDEO_FILE = "z-sample-video.mp4";

test.describe("Video assets", () => {
  let app, window, userDataDir, mcpPort;

  test.beforeAll(async () => {
    ({ app, window, userDataDir, mcpPort } = await launchApp({ testName: "video" }));
    // Wait for the initial gallery query to settle.
    await window.waitForFunction(() => !!window.__afterframeTest, null, { timeout: 10_000 });
    await window.locator("[data-gallery-item='true']").first().waitFor({ timeout: 15_000 });
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

  test("double-click opens the Lightbox with a playable video element", async () => {
    const card = window.locator("[data-gallery-item='true'][data-asset-type='video']").first();
    await card.dblclick();

    // The custom VideoPlayer mounts a <video> sourced from the media server,
    // plus an app-styled control bar (the Seek range is a stable anchor).
    const video = window.locator("video");
    await expect(video).toBeVisible({ timeout: 15_000 });
    await expect(video).toHaveAttribute("src", new RegExp(`${VIDEO_FILE.replace(".", "\\.")}`));
    await expect(window.getByLabel("Seek")).toBeVisible();

    // Close the Lightbox so it doesn't bleed into later expectations.
    await window.keyboard.press("Escape");
    await expect(window.locator("video")).toHaveCount(0);
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
    const video = window.locator("video");
    await expect(video).toBeVisible({ timeout: 15_000 });
    const state = () => video.evaluate((v) => ({
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      duration: v.duration,
      time: v.currentTime,
      paused: v.paused,
      ended: v.ended,
      seeking: v.seeking,
      frames: v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
      error: v.error?.code ?? null,
    }));

    // Decoded, at its real size (the proxy's), and playing on its own (autoplay).
    await expect.poll(async () => {
      const now = await state();
      return now.readyState >= 2 && now.width > 0;
    }, { timeout: proxied ? 150_000 : 15_000 }).toBe(true);
    const first = await state();
    expect(first).toMatchObject(proxied ? { width: 1920, height: 1080, error: null } : { width: 3840, height: 2160, error: null });
    expect(first.duration).toBeGreaterThan(2);
    expect(first.duration).toBeLessThan(2.2);
    await expect.poll(async () => (await state()).time, { timeout: 10_000 }).toBeGreaterThan(0.3);
    expect((await state()).frames).toBeGreaterThan(0);

    // Pause with the player's own button: time holds still.
    const playPause = window.locator("video").locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").getByRole("button").first();
    await playPause.click();
    await expect.poll(async () => (await state()).paused).toBe(true);
    const held = (await state()).time;
    await window.waitForTimeout(500);
    expect((await state()).time).toBeCloseTo(held, 2);

    // Seek with the scrubber: the frame there is decoded, and the readout follows.
    await window.getByLabel("Seek").fill("1");
    await expect.poll(async () => {
      const now = await state();
      return !now.seeking && now.readyState >= 2 && Math.abs(now.time - 1) < 0.1;
    }, { timeout: 10_000 }).toBe(true);
    await expect(window.getByText("0:01", { exact: true })).toBeVisible();

    // Play again from there, to the end.
    await playPause.click();
    await expect.poll(async () => (await state()).time, { timeout: 10_000 }).toBeGreaterThan(1.2);
    await expect.poll(async () => (await state()).ended, { timeout: 10_000 }).toBe(true);
    expect((await state()).frames).toBeGreaterThan(first.frames);

    await window.keyboard.press("Escape");
    await expect(window.locator("video")).toHaveCount(0);
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
