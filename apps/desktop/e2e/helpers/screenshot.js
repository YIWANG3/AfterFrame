const sharp = require("sharp");

// CDP's clipped Page.captureScreenshot temporarily presents the clipped surface
// in our transparent macOS Electron window. Polling locator.screenshot() makes
// the entire app visibly flicker. Capture the existing full surface through
// Electron, then crop the pixels without changing what the window displays.
async function captureElement(app, page, locator) {
  await locator.waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const box = await locator.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0
    || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
    throw new Error("captureElement requires an element fully inside the visible viewport");
  }
  const browserWindow = await app.browserWindow(page);
  let dataUrl;
  try {
    dataUrl = await browserWindow.evaluate(async (win) =>
      (await win.webContents.capturePage()).toDataURL());
  } finally {
    await browserWindow.dispose();
  }
  const pixels = sharp(Buffer.from(dataUrl.split(",")[1], "base64"));
  const { width, height } = await pixels.metadata();
  if (!width || !height) {
    // capturePage() returns an empty image when the window is occluded,
    // minimized or not painted yet; say so instead of failing inside extract().
    throw new Error("captureElement: capturePage() returned an empty image — is the app window visible?");
  }
  const scaleX = width / viewport.width;
  const scaleY = height / viewport.height;
  const left = Math.floor(box.x * scaleX);
  const top = Math.floor(box.y * scaleY);
  return pixels.extract({
    left, top,
    width: Math.min(width, Math.ceil((box.x + box.width) * scaleX)) - left,
    height: Math.min(height, Math.ceil((box.y + box.height) * scaleY)) - top,
  }).png().toBuffer();
}

module.exports = { captureElement };
