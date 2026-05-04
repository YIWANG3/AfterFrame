let nextId = 1;

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

export const PRESETS = [
  { name: "Bold White", style: { bold: true, fillColor: "#ffffff", shadow: true, shadowBlur: 8, shadowY: 4, shadowColor: "#000000", shadowOpacity: 50 } },
  { name: "Outline", style: { bold: false, fillColor: "transparent", strokeEnabled: true, strokeColor: "#ffffff", strokeWidth: 2 } },
  { name: "Tag", style: { bold: true, fillColor: "#111111", bgMode: "solid", bgColor: "#ffffff", bgOpacity: 85, fontSize: 72 } },
  { name: "Gold", style: { bold: true, fillColor: "#d2a05a", shadow: true, shadowBlur: 6, shadowY: 1, shadowColor: "#d2a05a", shadowOpacity: 40 } },
  { name: "Handwrite", style: { fontFamily: "Caveat", bold: true, fillColor: "#ffffff" } },
  { name: "Terminal", style: { fontFamily: "Space Mono", bold: true, fillColor: "#00ff00", shadow: true, shadowBlur: 8, shadowColor: "#00ff00", shadowOpacity: 30 } },
  { name: "Glitch", style: { bold: true, fillColor: "#ffffff", shadow: true, shadowX: 2, shadowY: 2, shadowBlur: 0, shadowColor: "#f55b5b", shadowOpacity: 100 } },
  { name: "Subtle", style: { bold: false, fillColor: "#ffffff", opacity: 50 } },
];

export function createDefaultLayer(overrides = {}) {
  return {
    id: `text-${nextId++}`,
    text: "New Text",
    fontFamily: "Plus Jakarta Sans",
    fontSize: 120,
    bold: false,
    fontWeight: 400,
    italic: false,
    underline: false,
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
    bgPadH: 25,
    bgPadV: 15,
    shadow: false,
    shadowX: 0,
    shadowY: 4,
    shadowBlur: 8,
    shadowSpread: 0,
    shadowColor: "#000000",
    shadowOpacity: 60,
    x: 0.5,
    y: 0.5,
    rotation: 0,
    preset: null,
    ...overrides,
  };
}

export function applyPreset(layer, preset) {
  return { ...layer, ...preset.style, preset: preset.name };
}

export function cloneLayers(layers) {
  return layers.map((l) => ({ ...l }));
}
