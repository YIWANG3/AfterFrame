// Frame-preset state for the editor's Text tool (the unified canvas model —
// docs/unified-canvas-plan.md). Loads the logo registry, keeps per-template
// preview thumbs, and turns a template into editable LAYERS + canvas margins
// via generatePresetLayers. The old baked-frame pipeline (FrameStage /
// FramePanel) is gone; rendering and export go through TextCanvas + saveImage.

import { useEffect, useMemo, useRef, useState } from "react";
import { FRAME_TEMPLATES } from "../frameTemplates";
import { buildLogoRegistry, prepareLogo } from "../render/frameLogos";
import { renderFrame, collectLogoNeeds, geometry, buildFrameLayers } from "../render/frameRender";
import { layersFromDisplay } from "../imageMath";
import { drawScrim } from "../render/canvasHelpers";
import { createDefaultLayer, createStickerLayer } from "../textState";

// Presets always generate at neutral knob settings (the old FramePanel's
// text/margin/logo-color knobs retired with the baked pipeline).
const ADJUST = { text: 1, margin: 1 };

// EXIF lives in nested image_metadata / raw_metadata (same shape the Inspector
// reads), NOT flat fields. Prefer RAW metadata when it carries the capture.
export function exifFromItem(src) {
  const imageMeta = src?.image_metadata || {};
  const rawMeta = src?.raw_metadata || {};
  const exp = rawMeta.capture_time ? rawMeta : imageMeta;
  const camera_model = rawMeta.camera_model || imageMeta.camera_model || "";
  return {
    camera_model,
    lens_model: rawMeta.lens_model || imageMeta.lens_model || "",
    // Real EXIF Make ("Hasselblad"), separate from Model ("CFV 100C/907X") —
    // brand auto-match needs this (some models omit the brand name).
    make: rawMeta.camera_make || imageMeta.camera_make || camera_model,
    focal_length: exp.focal_length,
    aperture: exp.aperture,
    shutter_speed: exp.shutter_speed,
    iso: exp.iso,
    capture_time: exp.capture_time,
  };
}

// Crop (fractions) + rotate/flip are already baked into `transformedPreview`;
// this slices out the cropped region as the base photo the frame wraps — the
// SAME content basis the composed preview (getOutputView) and the save path
// use, so preset pad/layer fractions line up with both.
function buildBaseCanvas(transformedPreview, crop) {
  const fullW = transformedPreview.width || transformedPreview.naturalWidth;
  const fullH = transformedPreview.height || transformedPreview.naturalHeight;
  const r = crop
    ? {
        x: Math.round(crop.x * fullW), y: Math.round(crop.y * fullH),
        w: Math.max(1, Math.round(crop.width * fullW)), h: Math.max(1, Math.round(crop.height * fullH)),
      }
    : { x: 0, y: 0, w: fullW, h: fullH };
  const c = document.createElement("canvas");
  c.width = r.w; c.height = r.h;
  c.getContext("2d").drawImage(transformedPreview, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}

export function useFrameTool({ active, item, transformedPreview, normalizedCrop }) {
  // Start from the browse item, then upgrade to full detail (complete EXIF) —
  // once per asset, not per tool activation.
  const [exif, setExif] = useState(() => exifFromItem(item));
  useEffect(() => { setExif(exifFromItem(item)); }, [item]);
  useEffect(() => {
    if (!item?.asset_id) return;
    let alive = true;
    (async () => {
      const detail = await window.mediaWorkspace?.getAssetDetailById?.(item.asset_id);
      if (alive && detail) setExif(exifFromItem(detail));
    })();
    return () => { alive = false; };
  }, [item?.asset_id]);

  const [logos, setLogos] = useState(null); // { registry, svgs }
  const [thumbs, setThumbs] = useState(new Map()); // templateId -> dataURL
  const [cellAspect, setCellAspect] = useState(0.8); // uniform thumb cell w/h, adapts to the photo
  const logosPromiseRef = useRef(null);
  const logoCacheRef = useRef(new Map());
  const thumbsKeyRef = useRef(null);

  // Quantize the crop so sub-pixel zoom/pan jitter (ULP drift on every wheel
  // tick) doesn't invalidate the thumbnail cache and trigger a full-res rebuild
  // (review F9). Only a meaningful crop change (~1e-4) rotates the key.
  const cropKey = normalizedCrop
    ? [normalizedCrop.x, normalizedCrop.y, normalizedCrop.width, normalizedCrop.height]
        .map((v) => v.toFixed(4)).join(",")
    : "full";
  const exifKey = JSON.stringify(exif);

  // Load the logo registry once; generatePresetLayers awaits this same promise
  // so a preset clicked before the IPC resolves still gets its logo layers.
  function loadLogos() {
    if (!logosPromiseRef.current) {
      logosPromiseRef.current = (async () => {
        const res = await window.mediaWorkspace?.getFrameLogos?.();
        const next = res
          ? { registry: buildLogoRegistry(res.manifest), svgs: res.svgs || {} }
          : { registry: { byId: new Map() }, svgs: {} };
        setLogos(next);
        return next;
      })();
    }
    return logosPromiseRef.current;
  }
  useEffect(() => { if (active) loadLogos(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ensureLogos(lg, tpl, geomH, override) {
    for (const n of collectLogoNeeds(tpl, exif, lg.registry, { outH: geomH }, override)) {
      if (logoCacheRef.current.has(n.key)) continue;
      const svg = lg.svgs[n.file];
      if (svg) logoCacheRef.current.set(n.key, await prepareLogo(svg, { color: n.color, colorLocked: n.colorLocked, heightPx: n.heightPx }));
    }
  }

  // Small framed previews of every template, so the panel shows what each looks
  // like (logo included) instead of a bare name list. Cached by content — a
  // tool re-entry with the same photo/crop/EXIF reuses the existing map.
  useEffect(() => {
    if (!active || !transformedPreview || !logos) return;
    const key = `${cropKey}|${exifKey}`;
    const prev = thumbsKeyRef.current;
    if (prev && prev.tp === transformedPreview && prev.key === key && prev.logos === logos) return;
    let alive = true;
    // Debounce: during a wheel pan/zoom the crop changes every tick; without
    // this the full-res buildBaseCanvas + per-template renderFrame + JPEG encode
    // ran on each one. Coalesce to the last settled crop (review F9).
    const timer = setTimeout(() => {
    (async () => {
      const base = buildBaseCanvas(transformedPreview, normalizedCrop);
      const tw = 260;
      const small = document.createElement("canvas");
      small.width = tw;
      small.height = Math.max(1, Math.round((base.height * tw) / base.width));
      small.getContext("2d").drawImage(base, 0, 0, small.width, small.height);
      const next = new Map();
      let repAspect = small.width / small.height;
      for (const tpl of FRAME_TEMPLATES) {
        await ensureLogos(logos, tpl, small.height);
        if (!alive) return;
        const framed = renderFrame({ photo: small, exif, profile: {}, template: tpl, registry: logos.registry, logoImages: logoCacheRef.current });
        // Size uniform cells to the first (dominant "bar") template's actual
        // output, so cells adapt to the photo orientation and waste little space.
        if (tpl.id === FRAME_TEMPLATES[0].id) repAspect = framed.width / framed.height;
        next.set(tpl.id, framed.toDataURL("image/jpeg", 0.82));
      }
      if (alive) {
        thumbsKeyRef.current = { tp: transformedPreview, key, logos };
        setThumbs(next);
        setCellAspect(repAspect);
      }
    })();
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [active, transformedPreview, logos, cropKey, exifKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A frame preset becomes editable LAYERS + canvas margins/background/scrim.
  // Everything is computed on the CROPPED base, matching the composed output
  // basis (content + margins) that TextCanvas positions against and saveImage
  // renders.
  async function generatePresetLayers(tpl) {
    if (!transformedPreview) return null;
    const lg = await loadLogos(); // waits out the registry IPC — no dropped logos
    const base = buildBaseCanvas(transformedPreview, normalizedCrop);
    await ensureLogos(lg, tpl, base.height || 1200);
    const g = geometry(base, tpl, ADJUST);
    const isOverlay = tpl.family === "overlay";

    // Overlay presets pick text color by the luminance behind it — draw the
    // composed background (bg + photo + scrim) once so buildFrameLayers can
    // sample it, restoring the baked pipeline's adaptive contrast.
    let sampleCtx = null;
    if (isOverlay) {
      const sample = document.createElement("canvas");
      sample.width = g.outW;
      sample.height = g.outH;
      sampleCtx = sample.getContext("2d", { willReadFrequently: true });
      sampleCtx.fillStyle = tpl.canvas?.bg?.color || "#ffffff";
      sampleCtx.fillRect(0, 0, g.outW, g.outH);
      sampleCtx.drawImage(base, g.padPx.left, g.padPx.top);
      drawScrim(sampleCtx, tpl.canvas?.scrim, { x: g.padPx.left, y: g.padPx.top, width: g.wref, height: g.href });
    }

    const built = buildFrameLayers(sampleCtx, {
      template: tpl, exif, profile: {}, geom: g, adjust: ADJUST, factor: g.wref / g.outW,
      registry: lg.registry, logoImages: logoCacheRef.current,
      logoColor: null, isOverlay,
    });
    // Convert width-based template pad → short-edge basis so the same pixel
    // margin lands whatever the editor uses.
    const tp = tpl.canvas?.pad || {};
    const short = Math.min(base.width, base.height);
    const k = base.width / short;
    const pad = {
      top: (tp.top || 0) * k, right: (tp.right || 0) * k,
      bottom: (tp.bottom || 0) * k, left: (tp.left || 0) * k,
    };
    const bg = { color: tpl.canvas?.bg?.color || "#ffffff" };
    const scrim = tpl.canvas?.scrim ? { ...tpl.canvas.scrim } : null;
    // Convert generated elements to real editable layers. TextCanvas centers
    // layers at x/y (ignores align), so anchor everything at the element's
    // VISUAL center (box.cx/cy). Logos become sticker layers whose stickerPath
    // is the tinted logo's data URL (prepareLogo returns an Image already backed
    // by a data URL) so they load in TextCanvas + the save path.
    const stickerImages = new Map();
    const layers = built.map((l) => {
      const { ei, box, ...rest } = l;
      const cx = box?.cx ?? l.x;
      const cy = box?.cy ?? l.y;
      if (l.type === "text") {
        return { ...createDefaultLayer({}), ...rest, x: cx, y: cy, align: "center", fromPreset: true };
      }
      if (l.type === "sticker") {
        const img = logoCacheRef.current.get(l.stickerPath);
        if (!img?.src) return null;
        stickerImages.set(img.src, img);
        return createStickerLayer(
          { stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight },
          { x: cx, y: cy, scale: l.scale, rotation: l.rotation ?? 0, opacity: l.opacity ?? 100, fromPreset: true },
        );
      }
      return null;
    }).filter(Boolean);

    // Layers are STORED in full-photo coords. The elements above were computed on
    // the cropped base:
    //  • pad=0 → they're in CONTENT (crop) fractions; map content → full photo.
    //  • pad>0 → they're in composed-output fractions; layersFromDisplay converts
    //    those → full photo (and is an identity no-op for pad=0).
    const padZero = !(pad.top || pad.right || pad.bottom || pad.left);
    const c = normalizedCrop;
    if (padZero && c && (c.x || c.y || c.width !== 1 || c.height !== 1)) {
      for (const l of layers) {
        l.x = c.x + l.x * c.width;
        l.y = c.y + l.y * c.height;
        // Width-fraction / 1920-ref props: content basis → full-photo basis.
        if (l.type === "sticker") l.scale = (l.scale ?? 0.4) * c.width;
        else {
          l.fontSize = (l.fontSize ?? 0) * c.width;
          l.shadowBlur = (l.shadowBlur ?? 0) * c.width;
          l.shadowX = (l.shadowX ?? 0) * c.width;
          l.shadowY = (l.shadowY ?? 0) * c.width;
          l.strokeWidth = (l.strokeWidth ?? 0) * c.width;
        }
      }
    }
    return {
      pad, bg, scrim, stickerImages,
      layers: layersFromDisplay(layers, transformedPreview, normalizedCrop, pad),
    };
  }

  const templates = useMemo(() => FRAME_TEMPLATES, []);

  return {
    templates,
    thumbs, cellAspect,
    generatePresetLayers,
    logosReady: !!logos,
  };
}
