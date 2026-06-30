// Built-in frame templates. A template = canvas treatment (padding + bg, with an
// optional on-photo scrim) + a list of anchored elements instantiated as layers
// at render time. ONE template renders ANY brand: the logo element resolves to
// the brand matched from EXIF (symbol / wordmark / roundel), so these presets are
// brand-agnostic. Verified against Hasselblad, Leica, Canon, Fujifilm.
//
// Units:
//   text  `size`  = fraction of canvas WIDTH (resolution-independent)
//   logo  `size`  = fraction of canvas WIDTH used as HEIGHT, then × the variant's
//                   `h` multiplier (normalizes tall square symbols vs short wide
//                   wordmarks) — so one size looks right across logo types.
// anchor: { region: top|bottom|full, h: left|center|right,
//           v: top|center|bottom | <number 0..1 within the band>,
//           inset: <frac>, dy: <frac> }.
// exif: set `labeled` for the "Aperture | f/8" style; otherwise pipe-joined values.
// logo: `variant` picks symbol|wordmark; `strict` skips (vs. falls back) when a
//   brand lacks that variant; `color` tints a mono mark; `rotation` for side text.

const INK = "#1a1a1a", SUB = "#9a9a9a", WHITE = "#f4f4f4";

export const FRAME_TEMPLATES = [
  // ───────────────────────── 信息条 Bar ─────────────────────────
  {
    id: "bar-id", name: "信息条 · 机型", family: "bar",
    canvas: { pad: { bottom: 0.122 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05, dy: -0.015 },
        style: { font: "grotesk", weight: 400, size: 0.024, color: INK } },
      { type: "text", content: "{lens_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05, dy: 0.019 },
        style: { font: "grotesk", weight: 400, size: 0.0165, color: SUB } },
      { type: "logo", variant: "symbol",
        anchor: { region: "bottom", h: "right", v: "center", inset: 0.05 },
        style: { size: 0.062 } },
    ],
  },
  {
    id: "bar-dark", name: "信息条 · 黑", family: "bar",
    canvas: { pad: { bottom: 0.122 }, bg: { type: "solid", color: "#0c0c0c" } },
    elements: [
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05, dy: -0.015 },
        style: { font: "grotesk", weight: 400, size: 0.024, color: WHITE } },
      { type: "text", content: "{lens_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05, dy: 0.019 },
        style: { font: "grotesk", weight: 400, size: 0.0165, color: "#8a8a8a" } },
      { type: "logo", variant: "symbol", color: WHITE,
        anchor: { region: "bottom", h: "right", v: "center", inset: 0.05 },
        style: { size: 0.062 } },
    ],
  },
  {
    id: "bar-exif", name: "信息条 · 参数", family: "bar",
    canvas: { pad: { bottom: 0.118 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "symbol",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05 },
        style: { size: 0.055 } },
      { type: "exif", labeled: true, fields: ["aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "right", v: "center", inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.0165, color: "#4a4a4a" } },
    ],
  },
  {
    id: "bar-full", name: "信息条 · 全信息", family: "bar",
    canvas: { pad: { bottom: 0.138 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05, dy: -0.016 },
        style: { font: "grotesk", weight: 400, size: 0.022, color: INK } },
      { type: "text", content: "{lens_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05, dy: 0.018 },
        style: { font: "grotesk", weight: 400, size: 0.0155, color: SUB } },
      { type: "logo", variant: "symbol",
        anchor: { region: "bottom", h: "right", v: "top", inset: 0.05 },
        style: { size: 0.05 } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "right", v: "bottom", inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.0145, color: "#8a8a8a" } },
    ],
  },

  // ───────────────────────── 留白 Margin ─────────────────────────
  {
    id: "margin-logo", name: "留白 · 标志居中", family: "margin",
    canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.15 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "wordmark",
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: -0.012 },
        style: { size: 0.085 } },
      { type: "exif", labeled: true, fields: ["aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: 0.04 },
        style: { font: "grotesk", weight: 400, size: 0.014, color: "#b0b0b0" } },
    ],
  },
  {
    id: "margin-gold", name: "留白 · 金标", family: "margin",
    canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.14 }, bg: { type: "solid", color: "#fbfaf7" } },
    elements: [
      { type: "logo", variant: "wordmark", color: "#b08d4c",
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05 },
        style: { size: 0.085 } },
    ],
  },
  {
    id: "border-stack", name: "白边 · 居中", family: "margin",
    canvas: { pad: { top: 0.045, left: 0.045, right: 0.045, bottom: 0.2 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "symbol",
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: -0.052 },
        style: { size: 0.06 } },
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: 0.012 },
        style: { font: "grotesk", weight: 400, size: 0.022, color: INK } },
      { type: "text", content: "{lens_model}",
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.016, color: "#a0a0a0" } },
    ],
  },
  {
    id: "gallery-split", name: "画廊 · 两端对齐", family: "margin",
    canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.12 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.055, dy: -0.012 },
        style: { font: "grotesk", weight: 400, size: 0.02, color: INK } },
      { type: "text", content: "{lens_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.055, dy: 0.016 },
        style: { font: "grotesk", weight: 400, size: 0.0145, color: SUB } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "right", v: "center", inset: 0.055 },
        style: { font: "grotesk", weight: 400, size: 0.0145, color: "#8a8a8a" } },
    ],
  },
  {
    id: "margin-tb", name: "留白 · 上下分置", family: "margin",
    canvas: { pad: { top: 0.1, left: 0.05, right: 0.05, bottom: 0.1 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "wordmark",
        anchor: { region: "top", h: "center", v: "center", inset: 0.05 },
        style: { size: 0.07 } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.0135, color: "#b0b0b0", tracking: 0.06 } },
    ],
  },
  {
    id: "text-margin", name: "留白 · 仅机型", family: "margin",
    canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.12 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: -0.01 },
        style: { font: "grotesk", weight: 400, size: 0.022, color: INK } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: 0.032 },
        style: { font: "grotesk", weight: 400, size: 0.0135, color: SUB, tracking: 0.05 } },
    ],
  },
  {
    id: "mag-cover", name: "杂志封面", family: "editorial",
    canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.145 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "text", content: "{camera_model}",
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.055, dy: -0.012 },
        style: { font: "grotesk", weight: 300, size: 0.034, color: INK } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.055, dy: 0.034 },
        style: { font: "grotesk", weight: 400, size: 0.0125, color: SUB, tracking: 0.04 } },
      { type: "logo", variant: "symbol",
        anchor: { region: "bottom", h: "right", v: "center", inset: 0.055 },
        style: { size: 0.072 } },
    ],
  },

  // ───────────────────────── 图内叠加 Overlay ─────────────────────────
  {
    id: "overlay-exif", name: "图内叠加 · 居中", family: "overlay",
    canvas: { pad: {}, bg: { type: "solid", color: "#000000" },
      scrim: { from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.5)", height: 0.32 } },
    elements: [
      { type: "logo", variant: "symbol", color: "#ffffff",
        anchor: { region: "full", h: "center", v: 0.86 }, style: { size: 0.05, opacity: 95 } },
      { type: "exif", labeled: true, fields: ["aperture", "shutter", "iso"],
        anchor: { region: "full", h: "center", v: 0.94 },
        style: { font: "grotesk", weight: 400, size: 0.016, color: "#ffffff", tracking: 0.02, opacity: 92 } },
    ],
  },
  {
    id: "overlay-stack", name: "图内叠加 · 左下", family: "overlay",
    canvas: { pad: {}, bg: { type: "solid", color: "#000000" },
      scrim: { from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.55)", height: 0.42 } },
    elements: [
      { type: "logo", variant: "symbol", color: "#ffffff",
        anchor: { region: "full", h: "left", v: 0.78, inset: 0.055 }, style: { size: 0.06, opacity: 95 } },
      { type: "text", content: "{camera_model}",
        anchor: { region: "full", h: "left", v: 0.89, inset: 0.055 },
        style: { font: "grotesk", weight: 400, size: 0.022, color: "#ffffff" } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "full", h: "left", v: 0.95, inset: 0.055 },
        style: { font: "grotesk", weight: 400, size: 0.014, color: "rgba(255,255,255,0.85)" } },
    ],
  },
  {
    id: "overlay-corners", name: "图内叠加 · 四角", family: "overlay",
    canvas: { pad: {}, bg: { type: "solid", color: "#000000" },
      scrim: { from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.45)", height: 0.4 } },
    elements: [
      { type: "text", content: "{date}",
        anchor: { region: "full", h: "left", v: 0.07, inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.014, color: "rgba(255,255,255,0.92)" } },
      { type: "logo", variant: "symbol", color: "#ffffff",
        anchor: { region: "full", h: "right", v: 0.075, inset: 0.05 }, style: { size: 0.045, opacity: 95 } },
      { type: "text", content: "{camera_model}",
        anchor: { region: "full", h: "left", v: 0.93, inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.02, color: "#ffffff" } },
      { type: "exif", fields: ["aperture", "shutter", "iso"],
        anchor: { region: "full", h: "right", v: 0.93, inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.014, color: "rgba(255,255,255,0.85)" } },
    ],
  },
  {
    id: "overlay-top", name: "图内叠加 · 顶标", family: "overlay",
    canvas: { pad: {}, bg: { type: "solid", color: "#000000" },
      scrim: { edge: "top", from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.45)", height: 0.3 } },
    elements: [
      { type: "logo", variant: "wordmark", color: "#ffffff",
        anchor: { region: "full", h: "center", v: 0.08 }, style: { size: 0.05, opacity: 95 } },
    ],
  },
  {
    id: "overlay-min", name: "图内叠加 · 仅参数", family: "overlay",
    canvas: { pad: {}, bg: { type: "solid", color: "#000000" },
      scrim: { from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.5)", height: 0.28 } },
    elements: [
      { type: "exif", labeled: true, fields: ["aperture", "shutter", "iso"],
        anchor: { region: "full", h: "center", v: 0.93 },
        style: { font: "grotesk", weight: 400, size: 0.016, color: "#ffffff", tracking: 0.02, opacity: 92 } },
    ],
  },
  {
    id: "corner-logo", name: "图内叠加 · 角标", family: "overlay",
    canvas: { pad: {}, bg: { type: "solid", color: "#000000" },
      scrim: { from: "rgba(0,0,0,0)", to: "rgba(0,0,0,0.4)", height: 0.24 } },
    elements: [
      { type: "logo", variant: "symbol", color: "#ffffff",
        anchor: { region: "full", h: "right", v: 0.9, inset: 0.05 }, style: { size: 0.07, opacity: 96 } },
    ],
  },

  // ───────────────────────── 双标 Dual ─────────────────────────
  {
    id: "dual-stack", name: "双标 · 居中", family: "dual",
    canvas: { pad: { top: 0.05, left: 0.05, right: 0.05, bottom: 0.16 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "symbol", strict: true,
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: -0.03 },
        style: { size: 0.062 } },
      { type: "logo", variant: "wordmark", strict: true,
        anchor: { region: "bottom", h: "center", v: "center", inset: 0.05, dy: 0.04 },
        style: { size: 0.06 } },
    ],
  },
  {
    id: "dual-bar", name: "双标 · 信息条", family: "dual",
    canvas: { pad: { bottom: 0.122 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "wordmark", strict: true,
        anchor: { region: "bottom", h: "left", v: "center", inset: 0.05 },
        style: { size: 0.05 } },
      { type: "logo", variant: "symbol", strict: true,
        anchor: { region: "bottom", h: "right", v: "top", inset: 0.05 },
        style: { size: 0.05 } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "bottom", h: "right", v: "bottom", inset: 0.05 },
        style: { font: "grotesk", weight: 400, size: 0.0145, color: "#8a8a8a" } },
    ],
  },

  // ───────────────────────── 竖排 Vertical ─────────────────────────
  // A solid strip beside the photo holds the logo + rotated (vertical) text.
  {
    id: "vbar-right", name: "竖排 · 右侧条", family: "vertical",
    canvas: { pad: { right: 0.12 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "symbol",
        anchor: { region: "right", h: "center", v: 0.1 }, style: { size: 0.05 } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "right", h: "center", v: 0.58 },
        style: { font: "grotesk", weight: 400, size: 0.013, color: "#8a8a8a", tracking: 0.08, rotation: 90 } },
    ],
  },
  {
    id: "vbar-left", name: "竖排 · 左侧条", family: "vertical",
    canvas: { pad: { left: 0.11 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "symbol",
        anchor: { region: "left", h: "center", v: 0.1 }, style: { size: 0.05 } },
      { type: "text", content: "{camera_model}",
        anchor: { region: "left", h: "center", v: 0.6 },
        style: { font: "grotesk", weight: 400, size: 0.016, color: "#1a1a1a", rotation: 90 } },
    ],
  },
  {
    id: "corner-vert", name: "大留白 · 角标竖参数", family: "vertical",
    canvas: { pad: { top: 0.07, left: 0.06, right: 0.1, bottom: 0.06 }, bg: { type: "solid", color: "#ffffff" } },
    elements: [
      { type: "logo", variant: "symbol",
        anchor: { region: "top", h: "left", v: "center", inset: 0.05 }, style: { size: 0.05 } },
      { type: "exif", fields: ["focal", "aperture", "shutter", "iso"],
        anchor: { region: "right", h: "center", v: 0.5 },
        style: { font: "grotesk", weight: 400, size: 0.0125, color: "#8a8a8a", tracking: 0.06, rotation: 90 } },
    ],
  },
];

// Logical font name -> a loaded font-family. Outfit (bundled, OFL) is the
// geometric sans Hasselblad & Leica use; see plan "字体".
export const FRAME_FONTS = {
  grotesk: "Outfit",
  mono: "Space Mono",
  serif: "Playfair Display",
  hand: "Caveat",
};
