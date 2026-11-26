// Putting things INTO the frame from the Frame panel: my logos, the camera's
// logo, photo info / free text, a logo dropped in from Finder, and saving the
// look as a template. Where each lands and what colour it takes come from
// logoPlacement; this hook reads the editor's current geometry (the turned
// preview, the crop, the canvas margins) through refs and commits the new
// layer into the shared history.

import { useState } from "react";
import api from "../../../api";
import { createDefaultLayer, createStickerLayer, measureTextWidthDOM } from "../textState";
import { FRAME_FONTS } from "../frameTemplates";
import { isFrameLayer } from "../layerStack";
import { outputGeometry } from "../frameUserTemplates";
import {
  backgroundLightness, layerBoxes, placeLogo, placeText, readableLogoColor, readableTextColor, swapLogo,
} from "../logoPlacement";
import { invalidatePersonalLogos, isPersonalLogoRef, preparePersonalLogo } from "../render/personalLogos";
import { photoPalette } from "../render/frameBackdrop";
import { effectiveCanvasPad } from "../imageMath";

// How light the photo is under a spot (output px): the corner a logo is put in
// when there is no bar. 0 is black, 1 white.
function photoLightness(source, geom, spot) {
  const sample = document.createElement("canvas");
  sample.width = 8;
  sample.height = 8;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(
    source,
    spot.cx - spot.width / 2 - geom.left + geom.cropX, spot.cy - spot.height / 2 - geom.top + geom.cropY, spot.width, spot.height,
    0, 0, 8, 8,
  );
  const { data } = ctx.getImageData(0, 0, 8, 8);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  return sum / (data.length / 4);
}

// How light the margin is under a spot (output px of `geom`, the user's
// margins). A flat or gradient background says so itself; one made from the
// photo is read from the photo: its colours by height, or the photo scaled to
// cover the canvas as laid out (`layout`, the margins a ratio widened).
function marginLightness(source, geom, layout, spot, bg) {
  if (bg?.mode === "palette") {
    const p = photoPalette(source, { x: geom.cropX, y: geom.cropY, width: geom.contentW, height: geom.contentH });
    const t = Math.min(1, Math.max(0, (spot.cy - geom.top + layout.top) / layout.outH));
    return (1 - t) * backgroundLightness({ color: p.top }) + t * backgroundLightness({ color: p.bottom });
  }
  if (bg?.mode === "blur") {
    const k = Math.max(layout.outW / geom.contentW, layout.outH / geom.contentH);
    const ox = spot.cx - geom.left + layout.left, oy = spot.cy - geom.top + layout.top;
    const at = {
      cx: geom.left + geom.contentW / 2 + (ox - layout.outW / 2) / k,
      cy: geom.top + geom.contentH / 2 + (oy - layout.outH / 2) / k,
      // Blurred: what's around the spot counts too.
      width: Math.max(8, (spot.width / k) * 3), height: Math.max(8, (spot.height / k) * 3),
    };
    return photoLightness(source, geom, at) * 0.94;
  }
  return backgroundLightness(bg);
}

const isLogoFileDrag = (event) => [...(event.dataTransfer?.items || [])]
  .some((entry) => entry.kind === "file" && (entry.type === "image/svg+xml" || entry.type === "image/png"));

export function useFramePlacement({
  transformedPreview, normalizedCrop, editorStateRef, layersRef, stickerImageCache, frameToolRef,
  commitLayers, setSelectedIds, setTool, pushToast, t,
}) {
  // The turned preview's full size and the output geometry (crop + margins)
  // of `canvas` (the editor's as of now by default), or null without a picture.
  function geometryFor(canvas) {
    const source = transformedPreview;
    if (!source) return null;
    const s = editorStateRef.current;
    const pad = canvas?.pad || {};
    const fullW = source.width || source.naturalWidth;
    const fullH = source.height || source.naturalHeight;
    const geom = outputGeometry({ fullW, fullH, crop: normalizedCrop, pad });
    const layout = outputGeometry({ fullW, fullH, crop: normalizedCrop, pad: effectiveCanvasPad(canvas, source, normalizedCrop) });
    // How light the margin is at a spot (see marginLightness).
    const marginLight = (spot) => marginLightness(source, geom, layout, spot, canvas?.bg);
    return { source, s, pad, fullW, fullH, geom, marginLight };
  }
  const currentGeometry = () => geometryFor(editorStateRef.current.canvas);

  // The frame's text and plain camera logos in the margin, recoloured where
  // they would not read on what will be behind them: a template's dark ink
  // on a dark blurred photo, white on a light one. A change of canvas (the
  // background, a template) passes the canvas it is about to have. Colours
  // that already read are kept. Returns the layers, or null when none changed.
  async function adaptFrameColors(layers, canvas) {
    const g = geometryFor(canvas);
    if (!g) return null;
    const { geom } = g;
    const lightBehind = (layer) => {
      const box = layerBoxes([layer], geom, measureTextWidthDOM)[0];
      if (!box) return null;
      const spot = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, width: Math.max(4, box.w), height: Math.max(4, box.h) };
      const onPhoto = spot.cx >= geom.left && spot.cx <= geom.left + geom.contentW
        && spot.cy >= geom.top && spot.cy <= geom.top + geom.contentH;
      // On the photo the colour was picked for the photo (and its wash) already.
      if (onPhoto) return null;
      return g.marginLight(spot);
    };
    let changed = false;
    const next = [];
    for (const layer of layers) {
      if (!isFrameLayer(layer)) { next.push(layer); continue; }
      if (layer.type === "text") {
        const light = lightBehind(layer);
        const color = light == null ? null : readableTextColor(layer.fillColor, light);
        if (color) {
          const dark = light < 0.55;
          next.push({ ...layer, fillColor: color, ...(layer.shadow ? { shadowColor: dark ? "#000000" : "#ffffff" } : {}) });
          changed = true;
          continue;
        }
      } else if (layer.type === "sticker" && layer.logoRef && !isPersonalLogoRef(layer.logoRef)) {
        const light = lightBehind(layer);
        const color = light == null ? null : readableLogoColor(layer.logoRef.color, light);
        const img = color ? await frameToolRef.current?.brandLogoFor?.({ ...layer.logoRef, color }) : null;
        if (img) {
          stickerImageCache.set(img.src, img);
          next.push({
            ...layer, logoRef: { ...layer.logoRef, color },
            stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
          });
          changed = true;
          continue;
        }
      }
      next.push(layer);
    }
    return changed ? next : null;
  }

  // A spot (output px) as a layer position: full-photo fractions.
  const layerPosition = (spot, { geom, fullW, fullH }) => ({
    x: (spot.cx - geom.left + geom.cropX) / fullW,
    y: (spot.cy - geom.top + geom.cropY) / fullH,
  });

  function addLayer(layer) {
    commitLayers([...layersRef.current, layer]);
    setSelectedIds(new Set([layer.id]));
  }

  // "My logo" into the frame. Where and at what size come from logoPlacement
  // (a bar's right end, or beside what is already there; the photo's corner
  // with no bar); a recolourable logo goes black on a light background and
  // white on a dark one; the others keep their colours.
  async function placePersonalLogo(logo) {
    const g = currentGeometry();
    if (!g || !logo) return;
    const { source, pad, fullW, geom } = g;
    const spot = placeLogo({
      geom, pad, aspect: logo.width / Math.max(1, logo.height),
      occupied: layerBoxes(layersRef.current, geom, measureTextWidthDOM),
    });
    let color = null;
    if (logo.tintable) {
      const light = spot.region === "photo" ? photoLightness(source, geom, spot) : g.marginLight(spot);
      color = light < 0.55 ? "#ffffff" : "#141414";
    }
    const img = await preparePersonalLogo(logo, color);
    stickerImageCache.set(img.src, img);
    addLayer(createStickerLayer(
      { stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, sourceLabel: logo.name },
      {
        ...layerPosition(spot, g),
        scale: spot.width / fullW,
        logoRef: { source: "personal", id: logo.id, color },
        fromPreset: true, // part of the frame
      },
    ));
  }

  // One of the camera's logos into the frame: from the brand row (`level`
  // "brand": Sony's "symbol" α or its "wordmark", or the brand's logo of mine)
  // or the model row (its own logo), placed like my logos and coloured for
  // what is behind it. A template finds it again for the next photo's camera.
  async function placeCameraLogo({ level = "brand", variant } = {}) {
    const g = currentGeometry();
    const tool = frameToolRef.current;
    if (!g || !tool?.cameraLogo) return;
    const { source, pad, fullW, geom } = g;
    const ref = { variant: variant || "wordmark", kind: null, strict: false, color: "#141414", ...(level === "brand" ? { scope: "brand" } : {}) };
    const probe = await tool.brandLogoFor(ref);
    if (!probe) return;
    const spot = placeLogo({
      geom, pad, aspect: probe.naturalWidth / Math.max(1, probe.naturalHeight),
      occupied: layerBoxes(layersRef.current, geom, measureTextWidthDOM),
    });
    const light = spot.region === "photo" ? photoLightness(source, geom, spot) : g.marginLight(spot);
    if (light < 0.55) ref.color = "#ffffff";
    const img = (await tool.brandLogoFor(ref)) || probe;
    stickerImageCache.set(img.src, img);
    addLayer(createStickerLayer(
      { stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, sourceLabel: await tool.cameraLogoLabel(level) },
      {
        ...layerPosition(spot, g),
        scale: spot.width / fullW,
        logoRef: ref,
        fromPreset: true, // part of the frame
      },
    ));
  }

  // Give the camera's brand, or just its model, one of my logos (null: take
  // that choice back). The camera logos already in this frame follow, each
  // keeping its end of the bar and its weight (swapLogo); one with no logo
  // now is taken out. A frame that had none gets the new logo placed.
  async function chooseCameraLogo(logo, scope) {
    const tool = frameToolRef.current;
    if (!tool) return;
    const logoId = logo?.id || null;
    await tool.setCameraLogo(logoId, scope);
    const g = currentGeometry();
    if (!g) return;
    const { geom } = g;
    const isCameraLogo = (layer) => layer.type === "sticker" && layer.logoRef && !isPersonalLogoRef(layer.logoRef);
    const layers = layersRef.current;
    if (!layers.some(isCameraLogo)) {
      if (logoId) await placeCameraLogo({ level: scope === "model" ? "model" : "brand" });
      return;
    }
    const labels = { brand: await frameToolRef.current.cameraLogoLabel("brand"), any: await frameToolRef.current.cameraLogoLabel() };
    const next = [];
    for (const layer of layers) {
      if (!isCameraLogo(layer)) { next.push(layer); continue; }
      const img = await frameToolRef.current.brandLogoFor(layer.logoRef);
      if (!img) continue;
      stickerImageCache.set(img.src, img);
      next.push({
        ...layer,
        ...swapLogo({ layer, geom, aspect: img.naturalWidth / Math.max(1, img.naturalHeight) }),
        stickerPath: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        sourceLabel: layer.logoRef.scope === "brand" ? labels.brand : labels.any,
      });
    }
    commitLayers(next);
    setSelectedIds((ids) => new Set([...ids].filter((id) => next.some((l) => l.id === id))));
  }

  // Photo info or free text into the frame: a bar's left end (then its
  // centre, its right end), dark on a light background and light on a dark
  // one; with no bar, the photo's bottom-left corner. Returns whether there
  // was anything to add (a photo without a lens has no lens line).
  function addFrameText({ text, tokenSource = null, secondary = false }) {
    const g = currentGeometry();
    if (!g || !text) return false;
    const { source, pad, fullW, geom } = g;
    const family = FRAME_FONTS.grotesk;
    const widthAt = (fontPx) => measureTextWidthDOM(text, { fontPx, weight: 400, family });
    const spot = placeText({
      geom, pad, widthAt, scale: secondary ? 0.75 : 1,
      occupied: layerBoxes(layersRef.current, geom, measureTextWidthDOM),
    });
    const onPhoto = spot.region === "photo";
    const light = onPhoto
      ? photoLightness(source, geom, { cx: spot.cx, cy: spot.cy, width: widthAt(spot.fontPx), height: spot.fontPx * 1.2 })
      : g.marginLight({ cx: spot.cx, cy: spot.cy, width: widthAt(spot.fontPx), height: spot.fontPx * 1.2 });
    addLayer(createDefaultLayer({
      text, ...(tokenSource ? { tokenSource } : {}),
      fontFamily: family, fontWeight: 400, fontSize: (spot.fontPx * 1920) / fullW,
      fillColor: light < 0.55 ? "#f4f4f4" : "#1a1a1a",
      shadow: onPhoto, shadowColor: light < 0.55 ? "#000000" : "#ffffff",
      ...layerPosition(spot, g),
      fromPreset: true, // part of the frame
    }));
    return true;
  }

  // An SVG or PNG dragged in from Finder becomes one of my logos, placed at once.
  const [logoDropActive, setLogoDropActive] = useState(false);
  const canImportLogo = api.has("importPersonalLogo");
  async function handleLogoDrop(event) {
    setLogoDropActive(false);
    const files = [...(event.dataTransfer?.files || [])].filter((file) => /\.(svg|png)$/i.test(file.name));
    if (!canImportLogo || !files.length) return;
    event.preventDefault();
    for (const file of files) {
      const filePath = api.getPathForFile(file) || file.path;
      if (!filePath) continue;
      const res = await api.importPersonalLogo(filePath);
      if (res?.error) {
        pushToast?.({
          title: t(`border.logoErrors.${res.error}`, { message: res.message || "", defaultValue: t("border.logoErrors.failed", { message: res.error }) }),
          tone: "error", ttl: 6000,
        });
        continue;
      }
      if (!res?.logo) continue;
      invalidatePersonalLogos();
      setTool("frame");
      await placePersonalLogo(res.logo);
      pushToast?.({ title: t("border.logoImported"), message: res.logo.name, ttl: 3000 });
    }
  }
  function handleLogoDragOver(event) {
    if (!canImportLogo || !isLogoFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!logoDropActive) setLogoDropActive(true);
  }
  function handleLogoDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) setLogoDropActive(false);
  }

  // "Save as template": the look as it stands (margins, background, every
  // layer) becomes one of the user's frame templates.
  async function saveFrameTemplate(name) {
    const s = editorStateRef.current;
    try {
      // Only the frame: what is written on the photo stays with the photo.
      const res = await frameToolRef.current?.saveTemplate?.(name, {
        layers: layersRef.current.filter(isFrameLayer), pad: s.canvas?.pad || {}, bg: s.canvas?.bg || null,
        aspect: s.canvas?.aspect ?? null, photo: s.canvas?.photo ?? null, mockup: s.canvas?.mockup ?? null,
      });
      if (!res) return;
      pushToast?.({
        title: t("border.templateSaved"),
        message: res.skipped ? t("border.templateSkipped", { count: res.skipped }) : name,
        ttl: res.skipped ? 7000 : 4000,
      });
    } catch (error) {
      pushToast?.({ title: t("border.templateFailed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
    }
  }

  return {
    placePersonalLogo, placeCameraLogo, chooseCameraLogo, addFrameText, saveFrameTemplate, adaptFrameColors,
    logoDropActive, handleLogoDrop, handleLogoDragOver, handleLogoDragLeave,
  };
}
