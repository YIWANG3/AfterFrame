// The user's own logos for frames ("My logos", docs/next-features-plan.md §E
// step 7). Pure processing, no Electron: ipc/frameTemplates.js does the file
// dialog and the storage.
//
// Every logo is stored as a PNG made here. An SVG is rasterized by sharp
// (librsvg: no scripts, and with the file handed over as a buffer, no external
// references either), so no SVG text ever reaches the renderer or media://.
// The transparent margin is trimmed so a logo is sized by its mark. A logo
// whose visible pixels are all one colour, on a transparent background, can be
// recoloured like a brand mark (the renderer tints it); anything else keeps
// its own colours.

const MAX_INPUT_BYTES = { svg: 1024 * 1024, png: 10 * 1024 * 1024 };
const TARGET_HEIGHT = 1200;
const MAX_WIDTH = 4800;
// Channel spread (0-255) still "one colour": anti-aliasing and export noise.
const MONO_SPREAD = 40;

class LogoError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function kindOf(fileName) {
  const ext = String(fileName || "").toLowerCase().split(".").pop();
  return ext === "svg" ? "svg" : ext === "png" ? "png" : null;
}

async function rasterize(sharp, buffer, kind) {
  if (kind === "png") return sharp(buffer, { limitInputPixels: 100e6 });
  // Render at the density that makes the SVG about TARGET_HEIGHT tall.
  const probe = await sharp(buffer, { density: 72, limitInputPixels: 50e6 }).metadata();
  const density = Math.min(2400, Math.max(72, Math.round((72 * TARGET_HEIGHT) / Math.max(1, probe.height || TARGET_HEIGHT))));
  return sharp(buffer, { density, limitInputPixels: 100e6 });
}

// One colour + a transparent background → recolourable, and which colour.
async function inspectColours(sharp, png) {
  const { data, info } = await sharp(png).resize({ height: 256, width: 1024, fit: "inside" }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = false;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  const sum = [0, 0, 0];
  let solid = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const alpha = data[i + 3];
    if (alpha < 250) transparent = true;
    if (alpha < 200) continue;
    solid += 1;
    for (let c = 0; c < 3; c += 1) {
      min[c] = Math.min(min[c], data[i + c]);
      max[c] = Math.max(max[c], data[i + c]);
      sum[c] += data[i + c];
    }
  }
  const spread = solid ? Math.max(...max.map((m, c) => m - min[c])) : 255;
  const hex = solid ? `#${sum.map((s) => Math.round(s / solid).toString(16).padStart(2, "0")).join("")}` : null;
  return { tintable: transparent && solid > 0 && spread <= MONO_SPREAD, color: hex };
}

/**
 * A logo file → the PNG AfterFrame keeps.
 * @param {import('sharp')} sharp
 * @param {Buffer} buffer  the file's bytes
 * @param {string} fileName  used only for its extension (.svg / .png)
 * @returns {Promise<{ png: Buffer, width: number, height: number, tintable: boolean, color: string|null }>}
 * @throws {LogoError} code: unsupported_type | too_large | invalid_image | empty_image
 */
async function processLogo(sharp, buffer, fileName) {
  const kind = kindOf(fileName);
  if (!kind) throw new LogoError("unsupported_type");
  if (!buffer?.length || buffer.length > MAX_INPUT_BYTES[kind]) throw new LogoError(buffer?.length ? "too_large" : "invalid_image");
  let image;
  try {
    image = await rasterize(sharp, buffer, kind);
    const meta = await image.metadata();
    if (meta.format !== kind) throw new LogoError("invalid_image");
  } catch (error) {
    throw error instanceof LogoError ? error : new LogoError("invalid_image");
  }
  const flat = await image.ensureAlpha().png().toBuffer();
  // One flat colour everywhere (all white, all transparent) has no mark.
  const { channels } = await sharp(flat).stats();
  if (channels.every((channel) => channel.min === channel.max)) throw new LogoError("empty_image");
  // Trim the empty margin so the logo is sized by its mark: the transparent
  // one when there is transparency (the top-left pixel may be the mark
  // itself), else the colour of the top-left corner (a mark on white).
  const hasTransparency = channels[3].min < 255;
  let trimmed;
  try {
    trimmed = await sharp(flat)
      .trim(hasTransparency ? { background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 } : { threshold: 1 })
      .png().toBuffer();
  } catch {
    throw new LogoError("empty_image");
  }
  const { data: png, info } = await sharp(trimmed)
    .resize({ height: TARGET_HEIGHT, width: MAX_WIDTH, fit: "inside", withoutEnlargement: kind === "png" })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  const { tintable, color } = await inspectColours(sharp, png);
  if (!color) throw new LogoError("empty_image");
  return { png, width: info.width, height: info.height, tintable, color };
}

module.exports = { processLogo, kindOf, LogoError, MAX_INPUT_BYTES };
