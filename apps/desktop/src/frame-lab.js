// Dev harness for the frame engine. Open at /frame-lab.html in the dev server.
// Renders every built-in template over a sample photo for MULTIPLE brands, using
// the real brand logos from /frame-logos — verifies that one template adapts to
// each brand's matched logo. Not shipped (a Vite multi-page dev entry).

import { FRAME_TEMPLATES } from "./components/editor/frameTemplates";
import { buildLogoRegistry, prepareLogo } from "./components/editor/render/frameLogos";
import { renderFrame, collectLogoNeeds } from "./components/editor/render/frameRender";
import manifest from "/frame-logos/logos.json";

const svgs = import.meta.glob("/frame-logos/**/*.svg", { query: "?raw", import: "default", eager: true });
const svgFor = (file) => svgs[`/frame-logos/${file}`];
const registry = buildLogoRegistry(manifest);

const BRANDS = [
  { label: "Hasselblad", exif: { camera_model: "Hasselblad CFV 100C/907X", lens_model: "XCD 3,5-4,5 / 35-75", make: "Hasselblad", focal_length: 73, aperture: 4.5, shutter_speed: 1 / 1399, iso: 80, capture_time: "2024-09-03T17:11:00Z" } },
  { label: "Leica", exif: { camera_model: "Leica M11", lens_model: "Summilux-M 1:1.4/35 ASPH.", make: "Leica Camera AG", focal_length: 35, aperture: 1.4, shutter_speed: 1 / 500, iso: 100, capture_time: "2024-06-02T09:30:00Z" } },
  { label: "Canon", exif: { camera_model: "Canon EOS R5", lens_model: "RF 50mm F1.2 L USM", make: "Canon", focal_length: 50, aperture: 1.2, shutter_speed: 1 / 800, iso: 200, capture_time: "2024-07-15T18:05:00Z" } },
  { label: "Fujifilm", exif: { camera_model: "FUJIFILM X-T5", lens_model: "XF 33mm F1.4 R LM WR", make: "FUJIFILM", focal_length: 33, aperture: 1.4, shutter_speed: 1 / 640, iso: 160, capture_time: "2024-05-20T16:40:00Z" } },
  { label: "Nikon", exif: { camera_model: "NIKON Z f", lens_model: "NIKKOR Z 40mm f/2", make: "NIKON CORPORATION", focal_length: 40, aperture: 2, shutter_speed: 1/250, iso: 320, capture_time: "2024-08-01T10:00:00Z" } },
  { label: "Lumix", exif: { camera_model: "DC-S5M2", lens_model: "LUMIX S 20-60mm F3.5-5.6", make: "Panasonic", focal_length: 35, aperture: 4, shutter_speed: 1/200, iso: 200, capture_time: "2024-09-10T12:00:00Z" } },
  { label: "Ricoh", exif: { camera_model: "RICOH GR III", lens_model: "GR 18.3mm F2.8", make: "RICOH IMAGING COMPANY, LTD.", focal_length: 28, aperture: 2.8, shutter_speed: 1/250, iso: 400, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Sony", exif: { camera_model: "ILCE-7CR", lens_model: "FE 35mm F1.4 GM", make: "Sony", focal_length: 35, aperture: 1.4, shutter_speed: 1/320, iso: 125, capture_time: "2024-08-02T11:00:00Z" } },
  { label: "DJI", exif: { camera_model: "FC8482", lens_model: "", make: "DJI", focal_length: 7, aperture: 2.8, shutter_speed: 1/1000, iso: 100, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Insta360", exif: { camera_model: "Insta360 X5", lens_model: "", make: "Arashi Vision Inc.", focal_length: 6, aperture: 2, shutter_speed: 1/500, iso: 100, capture_time: "2026-07-15T11:00:00Z" } },
  { label: "Luna Ultra", exif: { camera_model: "Insta360 Luna Ultra", lens_model: "Summicron", make: "Arashi Vision Inc.", focal_length: 14, aperture: 2, shutter_speed: 1/250, iso: 100, capture_time: "2026-07-15T11:00:00Z" } },
  { label: "Pentax", exif: { camera_model: "PENTAX K-3 Mark III", lens_model: "HD PENTAX-DA 20-40mm F2.8-4 ED Limited", make: "RICOH IMAGING COMPANY, LTD.", focal_length: 31, aperture: 4, shutter_speed: 1/250, iso: 200, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Sigma", exif: { camera_model: "fp L", lens_model: "45mm F2.8 DG DN | Contemporary 019", make: "SIGMA", focal_length: 45, aperture: 2.8, shutter_speed: 1/200, iso: 100, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Olympus", exif: { camera_model: "E-M1MarkIII", lens_model: "OLYMPUS M.12-40mm F2.8", make: "OLYMPUS CORPORATION", focal_length: 25, aperture: 2.8, shutter_speed: 1/320, iso: 200, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "OM System", exif: { camera_model: "OM-1", lens_model: "M.Zuiko Digital ED 12-40mm F2.8 PRO II", make: "OM Digital Solutions", focal_length: 25, aperture: 2.8, shutter_speed: 1/320, iso: 200, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Phase One", exif: { camera_model: "IQ4 150MP", lens_model: "Schneider Kreuznach LS 80mm f/2.8", make: "Phase One A/S", focal_length: 80, aperture: 8, shutter_speed: 1/125, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "GoPro", exif: { camera_model: "HERO12 Black", lens_model: "", make: "GoPro", focal_length: 3, aperture: 2.5, shutter_speed: 1/1000, iso: 100, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Parrot", exif: { camera_model: "ANAFI Ai", lens_model: "", make: "Parrot", focal_length: 4, aperture: 2.2, shutter_speed: 1/1000, iso: 100, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Autel", exif: { camera_model: "XT705", lens_model: "", make: "Autel Robotics", focal_length: 10, aperture: 2.8, shutter_speed: 1/1000, iso: 100, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Antigravity", exif: { camera_model: "antigravity a1", lens_model: "", make: "Yingling Innovations Pte. Ltd.", focal_length: 2, aperture: 2, shutter_speed: 1/1000, iso: 100, capture_time: "2026-07-15T11:00:00Z" } },
  { label: "Xiaomi", exif: { camera_model: "2211133C", lens_model: "", make: "Xiaomi", focal_length: 6, aperture: 1.8, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Redmi", exif: { camera_model: "Redmi Note 13 Pro+", lens_model: "", make: "Xiaomi", focal_length: 6, aperture: 1.7, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "POCO", exif: { camera_model: "22111317PG", lens_model: "", make: "POCO", focal_length: 6, aperture: 1.8, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Huawei", exif: { camera_model: "ELS-NX9", lens_model: "", make: "HUAWEI", focal_length: 7, aperture: 1.9, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "Honor", exif: { camera_model: "ANY-NX1", lens_model: "", make: "HONOR", focal_length: 6, aperture: 1.8, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "OPPO", exif: { camera_model: "CPH2385", lens_model: "", make: "OPPO", focal_length: 4, aperture: 1.8, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "vivo", exif: { camera_model: "V2309A", lens_model: "", make: "vivo", focal_length: 6, aperture: 1.6, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "iQOO", exif: { camera_model: "I2301", lens_model: "", make: "iQOO", focal_length: 6, aperture: 1.9, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "OnePlus", exif: { camera_model: "CPH2581", lens_model: "", make: "OnePlus", focal_length: 6, aperture: 1.6, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
  { label: "realme", exif: { camera_model: "RMX3241", lens_model: "", make: "realme", focal_length: 4, aperture: 1.8, shutter_speed: 1/500, iso: 50, capture_time: "2024-09-12T15:00:00Z" } },
];

// ?brands=Pentax,OPPO&templates=bar-id,... shows only those (labels / template ids).
const params = new URLSearchParams(location.search);
const onlyBrands = params.get("brands")?.split(",").map((x) => x.trim().toLowerCase());
const onlyTemplates = params.get("templates")?.split(",").map((x) => x.trim());

function samplePhoto(w = 1400) {
  const h = Math.round(w * 0.667); // landscape 3:2 — matches typical camera output
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#8e7fb6"); g.addColorStop(0.46, "#c98f78");
  g.addColorStop(0.6, "#5c6078"); g.addColorStop(1, "#221e2c");
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const sx = w * 0.68, sy = h * 0.3, r = w * 0.1;
  const rg = x.createRadialGradient(sx, sy, 0, sx, sy, r);
  rg.addColorStop(0, "rgba(255,240,210,.95)"); rg.addColorStop(1, "rgba(255,210,150,0)");
  x.fillStyle = rg; x.beginPath(); x.arc(sx, sy, r, 0, 7); x.fill();
  x.fillStyle = "#3a3248"; x.beginPath();
  x.moveTo(0, h * 0.78); x.lineTo(w * 0.5, h * 0.66); x.lineTo(w, h * 0.76); x.lineTo(w, h); x.lineTo(0, h); x.fill();
  x.fillStyle = "#221e2c"; x.beginPath();
  x.moveTo(0, h * 0.9); x.lineTo(w * 0.4, h * 0.84); x.lineTo(w, h * 0.92); x.lineTo(w, h); x.lineTo(0, h); x.fill();
  return c;
}

// ?photo=/sample-photos/sample-03.jpg renders over that image instead.
async function loadPhoto(url, w = 1400) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = w; c.height = Math.round(w * (img.naturalHeight / img.naturalWidth));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// ?compare=1 shows each template's bottom strip before and after a sizing
// change, brand by brand. "Before" is a saved copy of the old logos.json and
// frameTemplates.js in test-results/before/ (git show <rev>:<path> > ...),
// drawn by today's engine; with none there, only the current strip is shown.
// Read fresh each visit: Vite does not watch test-results/, so an import
// would keep the first copy it saw.
async function loadBefore() {
  const t = Date.now();
  try {
    const manifest = await (await fetch(`/test-results/before/logos.json?fresh=${t}`)).json();
    // not ?t=, which Vite strips (its own HMR stamp) and so serves the cached module
    const { FRAME_TEMPLATES: templates } = await import(/* @vite-ignore */ `/test-results/before/frameTemplates.js?fresh=${t}`);
    return { manifest, templates };
  } catch {
    return {};
  }
}

// ?h=hasselblad/symbol:0.6,sony/symbol:0.8 adds a column with those heights
// (h2=, h3= one more column each); xiaomi/as-wordmark:0.5 draws a symbol-only
// brand's symbol at 0.5 in wordmark slots. ?before=0 leaves out "before".
function withHeights(base, spec) {
  const byId = new Map(base.byId);
  for (const part of spec.split(",")) {
    const [key, value] = part.split(":");
    const [id, variantId] = (key || "").trim().split("/");
    const h = Number(value);
    const brand = byId.get(id);
    if (!brand || !Number.isFinite(h)) continue;
    let variants = brand.variants.map((v) => (v.id === variantId ? { ...v, h } : v));
    const symbol = variants.find((v) => v.kind === "symbol");
    if (variantId === "as-wordmark" && symbol) variants = [...variants, { ...symbol, id: "wordmark", kind: "wordmark", h }];
    byId.set(id, { ...brand, variants });
  }
  return { ...base, byId };
}

async function logosFor(tpl, exif, photo, reg = registry) {
  const logoImages = new Map();
  for (const n of collectLogoNeeds(tpl, exif, reg, { outH: photo.height })) {
    const txt = svgFor(n.file);
    if (txt) logoImages.set(n.key, await prepareLogo(txt, {
      color: n.color,
      colorLocked: n.colorLocked,
      tintableColors: n.tintableColors,
      heightPx: n.heightPx,
    }));
  }
  return logoImages;
}

// The frame's bottom strip (padding and what is in it), for side-by-side views.
function bottomStrip(canvas, frac = 0.165) {
  const h = Math.round(canvas.height * frac);
  const out = document.createElement("canvas");
  out.width = canvas.width; out.height = h;
  out.getContext("2d").drawImage(canvas, 0, canvas.height - h, canvas.width, h, 0, 0, canvas.width, h);
  out.className = "strip";
  return out;
}

async function runCompare(photo, root) {
  const before = params.get("before") === "0" ? {} : await loadBefore();
  const columns = [
    ...(before.manifest && before.templates ? [["改前", buildLogoRegistry(before.manifest), before.templates]] : []),
    ["现在", registry, FRAME_TEMPLATES],
    ...["h", "h2", "h3"].filter((k) => params.get(k)).map((k, i) => [`提议 ${i + 1}`, withHeights(registry, params.get(k)), FRAME_TEMPLATES]),
  ];
  const ids = onlyTemplates || ["margin-logo", "margin-gold", "border-stack", "bar-id"];
  root.className = "";
  root.style.setProperty("--cols", columns.length);
  for (const id of ids) {
    const name = FRAME_TEMPLATES.find((t) => t.id === id)?.name ?? id;
    const sec = document.createElement("div");
    sec.className = "brand";
    sec.innerHTML = `<h2>${name} · ${id}</h2><div class="cmp-head"><span></span>${columns.map(([label]) => `<span>${label}</span>`).join("")}</div>`;
    for (const brand of BRANDS.filter((b) => !onlyBrands || onlyBrands.includes(b.label.toLowerCase()))) {
      const row = document.createElement("div");
      row.className = "cmp-row";
      row.innerHTML = `<span class="cmp-label">${brand.label}</span>`;
      for (const [, reg, templates] of columns) {
        const tpl = templates.find((t) => t.id === id);
        if (!tpl) { row.appendChild(document.createElement("span")); continue; }
        const logoImages = await logosFor(tpl, brand.exif, photo, reg);
        const out = renderFrame({ photo, exif: brand.exif, profile: {}, template: tpl, registry: reg, logoImages });
        row.appendChild(params.get("compare") === "full" ? asStrip(out) : bottomStrip(out));
      }
      sec.appendChild(row);
    }
    root.appendChild(sec);
  }
}

const asStrip = (canvas) => { canvas.className = "strip"; return canvas; };

async function run() {
  try {
    // Canvas text does not ask for a font, so load the frame's weights first.
    await Promise.all(["300", "400", "500", "600"].map((w) => document.fonts.load(`${w} 40px Outfit`)));
    await document.fonts.ready;
    const photo = params.get("photo") ? await loadPhoto(params.get("photo")) : samplePhoto();
    const root = document.getElementById("root");
    if (params.get("compare")) { await runCompare(photo, root); return; }
    for (const brand of BRANDS.filter((b) => !onlyBrands || onlyBrands.includes(b.label.toLowerCase()))) {
      const sec = document.createElement("div");
      sec.className = "brand";
      const h2 = document.createElement("h2");
      h2.textContent = brand.label;
      sec.appendChild(h2);
      const grid = document.createElement("div");
      grid.className = "grid";
      for (const tpl of FRAME_TEMPLATES.filter((t) => !onlyTemplates || onlyTemplates.includes(t.id))) {
        const logoImages = await logosFor(tpl, brand.exif, photo);
        const out = renderFrame({ photo, exif: brand.exif, profile: {}, template: tpl, registry, logoImages });
        const cell = document.createElement("div");
        cell.className = "cell";
        const h3 = document.createElement("h3");
        h3.textContent = `${tpl.name} · ${tpl.id}`;
        cell.appendChild(out);
        cell.appendChild(h3);
        grid.appendChild(cell);
      }
      sec.appendChild(grid);
      root.appendChild(sec);
    }
  } catch (e) {
    document.getElementById("err").textContent = `Render error: ${e?.stack || e}`;
  }
}
run();
