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
];

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

async function logosFor(tpl, exif, photo) {
  const logoImages = new Map();
  for (const n of collectLogoNeeds(tpl, exif, registry, { outH: photo.height })) {
    const txt = svgFor(n.file);
    if (txt) logoImages.set(n.key, await prepareLogo(txt, { color: n.color, colorLocked: n.colorLocked, heightPx: n.heightPx }));
  }
  return logoImages;
}

async function run() {
  try {
    await document.fonts.ready;
    const photo = samplePhoto();
    const root = document.getElementById("root");
    for (const brand of BRANDS) {
      const sec = document.createElement("div");
      sec.className = "brand";
      const h2 = document.createElement("h2");
      h2.textContent = brand.label;
      sec.appendChild(h2);
      const grid = document.createElement("div");
      grid.className = "grid";
      for (const tpl of FRAME_TEMPLATES) {
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
