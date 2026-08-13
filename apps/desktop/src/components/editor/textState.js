let nextId = 1;

// Measure a text run's width the SAME WAY the editor renders it — via a hidden
// DOM element — instead of canvas `measureText`. Canvas measureText silently
// falls back to a system font until a web font (@font-face, font-display:swap)
// has loaded, and that fallback can be markedly wider/narrower than the real
// font; a hidden DOM node uses the exact same layout engine + font-load state as
// the on-canvas <div> text, so measurement can never diverge from what's drawn.
// This keeps alignment snapping and preset placement correct regardless of when
// the font finishes loading. Mirror TextLayerEl's text styles (whiteSpace:pre;
// line-height doesn't affect width) so the measured box matches the rendered one.
let _measureEl = null;
export function measureTextWidthDOM(text, { fontPx, weight = 400, italic = false, family = "sans-serif", tracking = 0 } = {}) {
  if (typeof document === "undefined" || !document.body) return 0;
  if (!_measureEl) {
    _measureEl = document.createElement("div");
    _measureEl.setAttribute("aria-hidden", "true");
    // white-space:pre — preserve \n so a multi-line layer measures as its
    // widest line (the block width), matching the rendered <div>.
    _measureEl.style.cssText =
      "position:absolute;left:-99999px;top:-99999px;visibility:hidden;pointer-events:none;white-space:pre;line-height:1.2;margin:0;padding:0;";
    document.body.appendChild(_measureEl);
  }
  _measureEl.style.font = `${italic ? "italic " : ""}${weight} ${fontPx}px "${family}", sans-serif`;
  _measureEl.style.letterSpacing = `${(tracking || 0) * fontPx}px`;
  _measureEl.textContent = text || " ";
  return _measureEl.getBoundingClientRect().width;
}

// Apply a layer's text-case transform. Done in JS (not CSS text-transform) so
// the DOM preview and the canvas export path share the exact same string.
export function applyTextCase(text, textCase) {
  const s = text || "";
  if (textCase === "upper") return s.toUpperCase();
  if (textCase === "lower") return s.toLowerCase();
  if (textCase === "title") return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  return s;
}

export function getDisplayText(layer) {
  return applyTextCase(layer.text, layer.textCase);
}

export const FONT_OPTIONS = [
  { family: "Plus Jakarta Sans", label: "Plus Jakarta Sans" },
  { family: "Inter", label: "Inter" },
  { family: "Noto Sans SC", label: "Noto Sans SC" },
  { family: "Playfair Display", label: "Playfair Display" },
  { family: "Space Mono", label: "Space Mono" },
  { family: "Caveat", label: "Caveat" },
];

export const COLOR_SWATCHES = [
  "#ffffff", "#111111", "#f55b5b", "#f5d45b",
  "#d2a05a", "#5bf59c", "#f55bb8", "#f5a05b",
];

// Every preset spreads PRESET_BASE so switching presets fully resets the
// previous one's look (no leftover bg blocks / strokes / shadows). Field
// semantics match createDefaultLayer. Designed from a movie-poster /
// photo-typography survey — see docs history: DUNE, Blade Runner 2049,
// 花样年华 (vertical + red), international one-sheets, billing blocks, noir.
const PRESET_BASE = {
  fontFamily: "Plus Jakarta Sans",
  fontWeight: 400,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  textCase: "none",
  tracking: 0,
  lineHeight: 1.2,
  fillMode: "solid",
  fillColor: "#ffffff",
  fillOpacity: 100,
  opacity: 100,
  strokeEnabled: false,
  bgMode: "none",
  shadow: false,
};
const preset = (name, style) => ({ name, style: { ...PRESET_BASE, ...style } });

export const PRESETS = [
  // ── 电影海报 ──────────────────────────────────────────────
  preset("Dune", {
    fontWeight: 300, fontSize: 200, textCase: "upper", tracking: 0.55, opacity: 96,
  }),
  preset("2049", {
    fontWeight: 800, bold: true, fontSize: 130, textCase: "upper", tracking: 0.02,
    fillMode: "gradient", gradientFrom: "#ffa24d", gradientTo: "#d43f24", gradientAngle: 175,
    shadow: true, shadowX: 0, shadowY: 4, shadowBlur: 0, shadowColor: "#1a0a06", shadowOpacity: 80,
  }),
  preset("Vertical", {
    fontFamily: "Noto Sans SC", fontWeight: 700, bold: true, fontSize: 96, lineHeight: 1.12,
    fillColor: "#e3b96f",
  }),
  preset("Stacked", {
    fontFamily: "Playfair Display", fontWeight: 700, bold: true, fontSize: 120,
    textCase: "upper", lineHeight: 1.02, tracking: 0.05, fillColor: "#f0e3c8",
  }),
  preset("Billing", {
    fontWeight: 500, fontSize: 34, textCase: "upper", tracking: 0.18, lineHeight: 2.0, opacity: 80,
  }),
  preset("Noir", {
    fontFamily: "Playfair Display", fontWeight: 600, bold: true, italic: true, fontSize: 130,
    tracking: 0.02, fillColor: "#efe8da",
    shadow: true, shadowY: 3, shadowBlur: 10, shadowColor: "#000000", shadowOpacity: 60,
  }),
  // ── 标题 ──────────────────────────────────────────────────
  preset("Cinema", {
    fontFamily: "Noto Sans SC", fontWeight: 500, fontSize: 66, tracking: 0.12, lineHeight: 1.75,
    shadow: true, shadowX: 0, shadowY: 2, shadowBlur: 14, shadowColor: "#000000", shadowOpacity: 55,
  }),
  preset("Ghost", {
    fontWeight: 800, bold: true, fontSize: 170, textCase: "upper", tracking: 0.18,
    fillColor: "transparent", strokeEnabled: true, strokeColor: "#ffffff", strokeWidth: 2,
  }),
  preset("Gold Foil", {
    fontFamily: "Playfair Display", fontWeight: 700, bold: true, fontSize: 150, tracking: 0.04,
    fillMode: "gradient", gradientFrom: "#f6e3a8", gradientTo: "#b97f2e", gradientAngle: 170,
    shadow: true, shadowY: 2, shadowBlur: 18, shadowColor: "#d8a648", shadowOpacity: 35,
  }),
  preset("Neon", {
    fontWeight: 800, bold: true, italic: true, fontSize: 150, tracking: 0.03,
    fillMode: "gradient", gradientFrom: "#7de3ff", gradientTo: "#ff5ad0", gradientAngle: 100,
    shadow: true, shadowBlur: 30, shadowColor: "#8f5aff", shadowOpacity: 65,
  }),
  // ── 小字排版 ──────────────────────────────────────────────
  preset("Editorial", {
    fontSize: 52, textCase: "upper", tracking: 0.42, opacity: 92,
  }),
  preset("Whisper", {
    fontWeight: 300, fontSize: 46, textCase: "lower", tracking: 0.6, opacity: 45,
  }),
  preset("Typewriter", {
    fontFamily: "Space Mono", fontSize: 48, textCase: "lower", tracking: 0.02, lineHeight: 1.7,
    fillColor: "#f5efe4", opacity: 88, align: "left",
  }),
  // ── 色块 ──────────────────────────────────────────────────
  preset("Label", {
    fontWeight: 700, bold: true, fontSize: 54, textCase: "upper", tracking: 0.28,
    fillColor: "#111111", bgMode: "solid", bgColor: "#f2efe8", bgOpacity: 95,
    bgPadTop: 22, bgPadBottom: 22, bgPadLeft: 45, bgPadRight: 45,
  }),
  preset("Red Seal", {
    fontFamily: "Noto Sans SC", fontWeight: 900, bold: true, fontSize: 72, tracking: 0.14,
    bgMode: "solid", bgColor: "#c8102e", bgOpacity: 96,
    bgPadTop: 22, bgPadBottom: 22, bgPadLeft: 40, bgPadRight: 40,
  }),
  // ── 装饰 ──────────────────────────────────────────────────
  preset("Riso", {
    fontWeight: 800, bold: true, fontSize: 130, textCase: "upper", tracking: 0.06,
    fillColor: "#fffdf5",
    shadow: true, shadowX: 5, shadowY: 5, shadowBlur: 0, shadowColor: "#e03616", shadowOpacity: 90,
  }),
  preset("Scribble", {
    fontFamily: "Caveat", fontWeight: 700, bold: true, fontSize: 150, rotation: -4,
    shadow: true, shadowY: 4, shadowBlur: 12, shadowColor: "#000000", shadowOpacity: 40,
  }),
];

export function createDefaultLayer(overrides = {}) {
  return {
    id: `text-${nextId++}`,
    type: "text",
    text: "New Text",
    fontFamily: "Plus Jakarta Sans",
    fontSize: 120,
    bold: false,
    fontWeight: 400,
    italic: false,
    underline: false,
    strikethrough: false,
    // Tracking is an em fraction (0.05 = 5% of font size); lineHeight is a
    // multiplier. Both match what drawLayers/frameRender already consume.
    tracking: 0,
    lineHeight: 1.2,
    textCase: "none",
    align: "center",
    fillMode: "solid",
    fillColor: "#ffffff",
    fillOpacity: 100,
    gradientFrom: "#ffffff",
    gradientFromOpacity: 100,
    gradientTo: "#d2a05a",
    gradientToOpacity: 100,
    gradientAngle: 90,
    opacity: 100,
    strokeEnabled: false,
    strokeColor: "#000000",
    strokeWidth: 0,
    bgMode: "none",
    bgColor: "#000000",
    bgOpacity: 80,
    bgPadTop: 15,
    bgPadRight: 25,
    bgPadBottom: 15,
    bgPadLeft: 25,
    shadow: false,
    shadowX: 0,
    shadowY: 4,
    shadowBlur: 8,
    shadowColor: "#000000",
    shadowOpacity: 60,
    // Outer glow — zero-offset colored blur stacked `glowIntensity` times.
    glow: false,
    glowColor: "#ffd76a",
    glowBlur: 24,
    glowOpacity: 80,
    glowIntensity: 2,
    x: 0.5,
    y: 0.5,
    rotation: 0,
    preset: null,
    // Depth occlusion: 1.0 = always in front (no occlusion); lower = sits deeper
    // in the scene. Pixels with depth > zPosition occlude the text.
    zPosition: 1.0,
    ...overrides,
  };
}

// Sticker layer — image overlay sourced from the sticker library. Shares
// position / rotation / opacity / shadow / depth with text layers; everything
// font-related is N/A.
export function createStickerLayer({ stickerPath, naturalWidth, naturalHeight, sourceLabel }, overrides = {}) {
  return {
    id: `sticker-${nextId++}`,
    type: "sticker",
    stickerPath,
    naturalWidth: naturalWidth || 0,
    naturalHeight: naturalHeight || 0,
    sourceLabel: sourceLabel || null,
    x: 0.5,
    y: 0.5,
    // `scale` here is "size relative to image width" — 0..1 — so a sticker added
    // to a 4000px image starts at 4000 * scale wide. Lets stickers feel similar
    // sized regardless of source image dimensions.
    scale: 0.4,
    rotation: 0,
    opacity: 100,
    shadow: false,
    shadowX: 0,
    shadowY: 8,
    shadowBlur: 20,
    shadowColor: "#000000",
    shadowOpacity: 60,
    // Runtime outline — stacks on top of whatever was baked into the PNG.
    // 0 = no extra outline.
    outlineWidth: 0,
    outlineColor: "#ffffff",
    outlineOpacity: 100,
    // Outer glow — zero-offset colored blur stacked `glowIntensity` times.
    glow: false,
    glowColor: "#ffd76a",
    glowBlur: 24,
    glowOpacity: 80,
    glowIntensity: 2,
    zPosition: 1.0,
    ...overrides,
  };
}

// Full-photo color wash. It deliberately has no x/y/size transform: the photo
// content rect is resolved by the preview/export pipeline, so crop and canvas
// margins cannot make the overlay drift. Because it is a normal stack item,
// users can add several and interleave them with text/sticker layers.
export function createOverlayLayer(overrides = {}) {
  return {
    id: `overlay-${nextId++}`,
    type: "overlay",
    sourceLabel: "Overlay",
    kind: "fill",
    mode: "gradient",
    color: "#000000",
    opacity: 100,
    gradient: {
      from: "#000000",
      fromOpacity: 0,
      to: "#000000",
      toOpacity: 0.7,
      angle: 180,
    },
    ...overrides,
  };
}

export function isStickerLayer(layer) {
  return layer && layer.type === "sticker";
}

export function getBgPadding(layer) {
  const top = layer.bgPadTop ?? layer.bgPadV ?? 15;
  const bottom = layer.bgPadBottom ?? layer.bgPadV ?? 15;
  const left = layer.bgPadLeft ?? layer.bgPadH ?? 25;
  const right = layer.bgPadRight ?? layer.bgPadH ?? 25;
  return { top, right, bottom, left };
}

export function applyPreset(layer, preset) {
  return { ...layer, ...preset.style, preset: preset.name };
}

export function cloneLayers(layers) {
  return layers.map((l) => ({ ...l }));
}
