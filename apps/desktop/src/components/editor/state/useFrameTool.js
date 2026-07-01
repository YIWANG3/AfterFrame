// Frame tool state for the editor. Keeps all the frame logic OUT of
// EditorOverlay (the tool-module pattern): loads logos, holds the selected
// template, renders the framed preview off the current edited photo, and
// exports. EditorOverlay just mounts this + <FramePanel> + <FrameStage>.

import { useEffect, useMemo, useRef, useState } from "react";
import { FRAME_TEMPLATES } from "../frameTemplates";
import { buildLogoRegistry, prepareLogo } from "../render/frameLogos";
import { renderFrame, collectLogoNeeds, geometry, buildFrameLayers } from "../render/frameRender";
import { buildTransformedCanvas, getSourceDimensions } from "../render/canvasHelpers";
import { getAspectRatio } from "../cropMath";

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
// this slices out the cropped region as the base photo the frame wraps.
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

export function useFrameTool({ active, item, transformedPreview, sourceImage, rotationDeg = 0, flipX = false, flipY = false, normalizedCrop, saveBasePath, pushToast, onSaveComplete }) {
  // Start from the browse item, then upgrade to full detail (complete EXIF).
  const [exif, setExif] = useState(() => exifFromItem(item));
  useEffect(() => { setExif(exifFromItem(item)); }, [item]);
  useEffect(() => {
    if (!active || !item?.asset_id) return;
    let alive = true;
    (async () => {
      const detail = await window.mediaWorkspace?.getAssetDetailById?.(item.asset_id);
      if (alive && detail) setExif(exifFromItem(detail));
    })();
    return () => { alive = false; };
  }, [active, item?.asset_id]);

  const [logos, setLogos] = useState(null); // { registry, svgs }
  const [templateId, setTemplateId] = useState(FRAME_TEMPLATES[0].id);
  const [framedCanvas, setFramedCanvas] = useState(null);
  const [thumbs, setThumbs] = useState(new Map()); // templateId -> dataURL
  const [cellAspect, setCellAspect] = useState(0.8); // uniform thumb cell w/h, adapts to the photo
  const [rendering, setRendering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [textScale, setTextScale] = useState(1); // "文字大小" knob
  const [marginScale, setMarginScale] = useState(1); // "留白" knob
  const [logoColor, setLogoColor] = useState(null); // logo tint override; null = 原色 (auto)
  const [frameAspectKey, setFrameAspectKey] = useState("free"); // pad output to a target ratio; "free" = frame's natural size
  const [elementOverrides, setElementOverrides] = useState({}); // element index -> { pos:{x,y} } (dragged position)
  const [frameLayers, setFrameLayers] = useState([]); // editable element layout (final-canvas fractions) for the drag overlay
  const [selectedElement, setSelectedElement] = useState(null); // ei of the selected element, or null
  const frameMapRef = useRef(null); // final<->content mapping for inverse-mapping drags
  const logoCacheRef = useRef(new Map());

  const template = useMemo(() => FRAME_TEMPLATES.find((t) => t.id === templateId), [templateId]);
  // Per-element overrides are template-specific (indices differ) — clear on switch.
  useEffect(() => { setElementOverrides({}); setSelectedElement(null); }, [templateId]);
  const cropKey = normalizedCrop ? JSON.stringify(normalizedCrop) : "full";
  const exifKey = JSON.stringify(exif);

  // Load logos once, on first activation.
  useEffect(() => {
    if (!active || logos) return;
    let alive = true;
    (async () => {
      const res = await window.mediaWorkspace?.getFrameLogos?.();
      if (alive && res) setLogos({ registry: buildLogoRegistry(res.manifest), svgs: res.svgs || {} });
    })();
    return () => { alive = false; };
  }, [active, logos]);

  async function ensureLogos(tpl, geomH, override) {
    if (!logos) return;
    for (const n of collectLogoNeeds(tpl, exif, logos.registry, { outH: geomH }, override)) {
      if (logoCacheRef.current.has(n.key)) continue;
      const svg = logos.svgs[n.file];
      if (svg) logoCacheRef.current.set(n.key, await prepareLogo(svg, { color: n.color, colorLocked: n.colorLocked, heightPx: n.heightPx }));
    }
  }

  const adjust = { text: textScale, margin: marginScale };

  // Render the framed canvas AND compute the editable element layout off the
  // SAME base, so the drag overlay lines up with the baked pixels. Layer
  // positions/boxes are mapped into the FINAL (aspect-padded) canvas fractions;
  // `map` carries the params to invert a drag back to content-space for storage.
  function compose() {
    const base = buildBaseCanvas(transformedPreview, normalizedCrop);
    const frameAspect = getAspectRatio(frameAspectKey, base.width / base.height);
    const canvas = renderFrame({ photo: base, exif, profile: {}, template, registry: logos.registry, logoImages: logoCacheRef.current, adjust, logoColor, frameAspect, overrides: elementOverrides });

    const g = geometry(base, template, adjust);
    const contentLayers = buildFrameLayers(null, {
      template, exif, profile: {}, geom: g, adjust, factor: g.wref / g.outW,
      registry: logos.registry, logoImages: logoCacheRef.current,
      logoColor, isOverlay: template.family === "overlay", overrides: elementOverrides,
    });
    // Aspect padding grows the canvas around the content, centered.
    let finalW = g.outW, finalH = g.outH;
    if (frameAspect) {
      if (g.outW / g.outH < frameAspect) finalW = Math.round(g.outH * frameAspect);
      else finalH = Math.round(g.outW / frameAspect);
    }
    const offX = (finalW - g.outW) / 2, offY = (finalH - g.outH) / 2;
    const layers = contentLayers.map((l) => {
      const cx = l.box?.cx ?? l.x;
      const cy = l.box?.cy ?? l.y;
      return {
        ei: l.ei, type: l.type, rotation: l.rotation || 0,
        // Overlay position is the element's VISUAL center, mapped into the final
        // (aspect-padded) canvas fractions.
        x: (cx * g.outW + offX) / finalW,
        y: (cy * g.outH + offY) / finalH,
        box: l.box ? { w: (l.box.w * g.outW) / finalW, h: (l.box.h * g.outH) / finalH } : { w: 0.1, h: 0.05 },
      };
    });
    return { canvas, layers, map: { outW: g.outW, outH: g.outH, finalW, finalH, offX, offY } };
  }

  // Live preview: re-render when active / photo / crop / template / logos / knobs change.
  useEffect(() => {
    if (!active || !transformedPreview || !logos || !template) return;
    let alive = true;
    setRendering(true);
    (async () => {
      await ensureLogos(template, transformedPreview.height || 1200, logoColor);
      if (!alive) return;
      const r = compose();
      setFramedCanvas(r.canvas);
      setFrameLayers(r.layers);
      frameMapRef.current = r.map;
      setRendering(false);
    })();
    return () => { alive = false; };
  }, [active, transformedPreview, logos, templateId, cropKey, exifKey, textScale, marginScale, logoColor, frameAspectKey, elementOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  // Move an element to an absolute position (final-canvas fractions, from a drag
  // on the overlay) — inverse-map to content space and store as a pos override.
  function moveElement(ei, xFinal, yFinal) {
    const m = frameMapRef.current;
    if (!m) return;
    const x = (xFinal * m.finalW - m.offX) / m.outW;
    const y = (yFinal * m.finalH - m.offY) / m.outH;
    setElementOverrides((prev) => ({ ...prev, [ei]: { ...(prev[ei] || {}), pos: { x, y } } }));
  }

  // Small framed previews of every template, so the panel shows what each looks
  // like (logo included) instead of a bare name list.
  useEffect(() => {
    if (!active || !transformedPreview || !logos) return;
    let alive = true;
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
        await ensureLogos(tpl, small.height);
        if (!alive) return;
        const framed = renderFrame({ photo: small, exif, profile: {}, template: tpl, registry: logos.registry, logoImages: logoCacheRef.current });
        // Size uniform cells to the first (dominant "bar") template's actual
        // output, so cells adapt to the photo orientation and waste little space.
        if (tpl.id === FRAME_TEMPLATES[0].id) repAspect = framed.width / framed.height;
        next.set(tpl.id, framed.toDataURL("image/jpeg", 0.82));
      }
      if (alive) { setThumbs(next); setCellAspect(repAspect); }
    })();
    return () => { alive = false; };
  }, [active, transformedPreview, logos, cropKey, exifKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Full-resolution base for EXPORT: rebuild the transformed + cropped photo from
  // the original `sourceImage` (the live preview uses the 2200px-capped one), so
  // the framed output keeps the photo's native resolution. Falls back to the
  // preview if the full-res source isn't available.
  function buildExportBase() {
    if (!sourceImage) return buildBaseCanvas(transformedPreview, normalizedCrop);
    const { width: sw, height: sh } = getSourceDimensions(sourceImage);
    const fullTransformed = buildTransformedCanvas(sourceImage, sw, sh, rotationDeg, flipX, flipY);
    return buildBaseCanvas(fullTransformed, normalizedCrop);
  }

  // Render the framed image at full resolution and write it to `savePath`.
  // Returns the output dimensions. Shared by the picker flow and the e2e
  // backdoor (which skips the native save dialog).
  async function exportTo(savePath) {
    const base = buildExportBase();
    await ensureLogos(template, base.height || 1200, logoColor);
    const frameAspect = getAspectRatio(frameAspectKey, base.width / base.height);
    const out = renderFrame({ photo: base, exif, profile: {}, template, registry: logos.registry, logoImages: logoCacheRef.current, adjust, logoColor, frameAspect, overrides: elementOverrides });
    const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
    await window.mediaWorkspace?.saveImage?.(savePath, await blob.arrayBuffer(), saveBasePath);
    return { width: out.width, height: out.height };
  }

  async function exportFramed() {
    if (!transformedPreview || !logos || !template || exporting) return;
    setExporting(true);
    try {
      const defaultPath = (saveBasePath || "photo.jpg").replace(/(\.[^.]+)$/, "") + "_framed.jpg";
      const savePath = await window.mediaWorkspace?.pickSavePath?.({
        defaultPath,
        filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }, { name: "PNG", extensions: ["png"] }],
      });
      if (!savePath) return;
      await exportTo(savePath);
      pushToast?.({ title: "已导出加框图片", message: savePath.split("/").pop(), ttl: 4000 });
      await onSaveComplete?.(savePath);
    } catch (e) {
      pushToast?.({ title: "导出失败", message: e?.message || String(e), tone: "error", ttl: 5000 });
    } finally {
      setExporting(false);
    }
  }

  return {
    templates: FRAME_TEMPLATES,
    templateId, setTemplateId,
    framedCanvas, thumbs, cellAspect, rendering, exporting,
    textScale, setTextScale, marginScale, setMarginScale,
    logoColor, setLogoColor,
    frameAspectKey, setFrameAspectKey,
    template, elementOverrides, setElementOverrides,
    frameLayers, selectedElement, setSelectedElement, moveElement,
    resetElement: (ei) => setElementOverrides((prev) => {
      if (!prev[ei]) return prev;
      const next = { ...prev }; delete next[ei]; return next;
    }),
    logosReady: !!logos,
    exportFramed,
    exportTo, // e2e: export to a given path, skipping the native dialog
  };
}
