// Renderer side of the agent render bridge (see electron/agentRender.js).
// Handlers run the SAME rendering code the UI uses — collageRender for
// collages, saveEditedImage for edit recipes, renderFrame for frame presets —
// so agent output is pixel-identical to what the user would export by hand.
//
// Handlers are pure with respect to UI state: they never touch React state
// except through the injected `deps` (used only by open_view).

import { localFileUrl } from "../utils/format";
import TEMPLATES from "../components/collage/collageTemplates";
import { getTemplatesForCount } from "../components/collage/collageTemplates";
import { renderCollagePage } from "../components/collage/collageRender";
import { GROUP_SIZE_OPTIONS, MAX_TEMPLATE_COUNT } from "../components/collage/collageBatch";
import { saveEditedImage } from "../components/editor/render/saveImage";
import { drawLayersOnCanvas } from "../components/editor/render/drawLayers";
import { isTextLayer, isStickerLayer, isOverlayLayer } from "../components/editor/layerStack";
import { createDefaultLayer, createStickerLayer, FONT_OPTIONS } from "../components/editor/textState";
import { FRAME_TEMPLATES } from "../components/editor/frameTemplates";
import { buildLogoRegistry, prepareLogo } from "../components/editor/render/frameLogos";
import { renderFrame, collectLogoNeeds } from "../components/editor/render/frameRender";
import { exifFromItem } from "../components/editor/state/useFrameTool";

function loadImage(filePath) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // media:// is CORS-enabled; without this the canvas is tainted and
    // toBlob throws (Electron 43 gotcha — see project_electron_43 notes).
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load image: ${filePath}`));
    img.src = localFileUrl(filePath);
  });
}

function canvasToJpegBuffer(canvas, quality = 0.92, mime = "image/jpeg") {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error("toBlob failed"))),
      mime,
      quality,
    );
  });
}

function findCollageTemplate(count, templateId) {
  const candidates = getTemplatesForCount(count);
  if (!candidates.length) throw new Error(`no collage template supports ${count} images`);
  if (!templateId) return candidates[0];
  const match = candidates.find((t) => t.id === templateId);
  if (!match) {
    throw new Error(
      `unknown template '${templateId}' for ${count} images — valid: ${candidates.map((t) => t.id).join(", ")}`,
    );
  }
  return match;
}

// ---- Handlers ---------------------------------------------------------------

// One collage page: load sources (HD preview falls back to original), render
// via the shared collageRender module, save + register like CollageOverlay.
async function handleCollage(payload) {
  const { files, templateId, canvasRatio, gap, padding, borderRadius, bgColor, width, savePath, sourceAssetIds } = payload;
  const images = await Promise.all(
    files.map(async (f) => {
      try { return await loadImage(f.imagePath); }
      catch (e) { if (f.previewPath) return loadImage(f.previewPath); throw e; }
    }),
  );
  const template = findCollageTemplate(images.length, templateId);
  const canvas = renderCollagePage({
    images, template,
    canvasRatio: canvasRatio || 1,
    gap: gap ?? 4,
    padding: padding ?? 0,
    borderRadius: borderRadius ?? 0,
    bgColor: bgColor || "#000000",
    width: width || 3000,
  });
  const buffer = await canvasToJpegBuffer(canvas);
  await window.mediaWorkspace.saveImage(savePath, buffer, files[0].imagePath);
  const asset = await window.mediaWorkspace.quickRegister(savePath, files[0].imagePath, sourceAssetIds);
  return { saved_path: savePath, template_id: template.id, width: canvas.width, height: canvas.height, asset };
}

// Recipe-driven edit: geometry + canvas pad/bg/scrim + text/sticker layers,
// composited by the editor's own save pipeline (saveEditedImage).
async function handleEdit(payload) {
  const { imagePath, savePath, geometry = {}, canvas = {}, layers = [], quality } = payload;
  const sourceImage = await loadImage(imagePath);

  const stickerCache = new Map();
  const builtLayers = [];
  for (const spec of layers) {
    if (spec.type === "text") {
      if (!spec.text) throw new Error("text layer requires text");
      const overrides = {
        text: String(spec.text),
        x: spec.x ?? 0.5,
        y: spec.y ?? 0.5,
        // Recipe `size` is a fraction of image width; the editor's fontSize is
        // 1920-ref px (drawLayers scales by canvasWidth/1920).
        fontSize: (spec.size ?? 0.06) * 1920,
        align: spec.align || "center",
        rotation: spec.rotation ?? 0,
        opacity: spec.opacity != null ? Math.round(spec.opacity * 100) : 100,
      };
      if (spec.font) {
        const known = FONT_OPTIONS.find((f) => f.family === spec.font || f.label === spec.font);
        overrides.fontFamily = known ? known.family : String(spec.font);
      }
      if (spec.color) overrides.fillColor = String(spec.color);
      if (spec.bold != null) { overrides.bold = !!spec.bold; overrides.fontWeight = spec.bold ? 700 : 400; }
      if (spec.italic != null) overrides.italic = !!spec.italic;
      if (spec.outline) {
        overrides.strokeEnabled = true;
        overrides.strokeColor = spec.outline.color || "#000000";
        overrides.strokeWidth = spec.outline.width ?? 2;
      }
      if (spec.glow) {
        overrides.glow = true;
        overrides.glowColor = spec.glow.color || "#ffd76a";
        overrides.glowBlur = spec.glow.radius ?? 24;
        overrides.glowOpacity = spec.glow.opacity != null ? Math.round(spec.glow.opacity * 100) : 80;
      }
      if (spec.shadow) {
        overrides.shadow = true;
        overrides.shadowX = spec.shadow.x ?? 0;
        overrides.shadowY = spec.shadow.y ?? 4;
        overrides.shadowBlur = spec.shadow.blur ?? 8;
        overrides.shadowColor = spec.shadow.color || "#000000";
        overrides.shadowOpacity = spec.shadow.opacity != null ? Math.round(spec.shadow.opacity * 100) : 60;
      }
      builtLayers.push(createDefaultLayer(overrides));
    } else if (spec.type === "sticker") {
      const path = spec.path;
      if (!path) throw new Error("sticker layer requires path (absolute file path of a PNG)");
      const img = await loadImage(path);
      const src = img.src;
      stickerCache.set(src, img);
      builtLayers.push(createStickerLayer(
        { stickerPath: src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight },
        {
          x: spec.x ?? 0.5, y: spec.y ?? 0.5,
          scale: spec.scale ?? 0.4,
          rotation: spec.rotation ?? 0,
          opacity: spec.opacity != null ? Math.round(spec.opacity * 100) : 100,
        },
      ));
    } else {
      throw new Error(`unsupported layer type: ${spec.type} (supported: text, sticker)`);
    }
  }

  const quarterTurns = Number(geometry.quarter_turns) || 0;
  const freeAngle = Number(geometry.free_angle) || 0;
  const rect = geometry.crop;
  const pad = canvas.pad
    ? { top: canvas.pad.top || 0, right: canvas.pad.right || 0, bottom: canvas.pad.bottom || 0, left: canvas.pad.left || 0 }
    : { top: 0, right: 0, bottom: 0, left: 0 };

  await saveEditedImage({
    savePath,
    sourcePath: imagePath,
    sourceImage,
    transformedPreview: sourceImage, // truthiness gate only in the canvas path
    rotationDeg: quarterTurns * 90 + freeAngle,
    quarterTurns,
    freeAngle,
    flipX: !!geometry.flip_x,
    flipY: !!geometry.flip_y,
    normalizedCrop: rect
      ? { x: Number(rect.x) || 0, y: Number(rect.y) || 0, width: Number(rect.w), height: Number(rect.h) }
      : null,
    canvasPad: pad,
    canvasBg: canvas.bg ? { mode: "solid", color: String(canvas.bg) } : { mode: "solid", color: "#ffffff" },
    canvasScrim: canvas.scrim || null,
    layers: builtLayers,
    depthFieldCanvas: null,
    depthFeather: 0,
    drawLayersToCtx: (ctx, w, h, ls) => drawLayersOnCanvas(ctx, w, h, ls, stickerCache),
    nativeSaveSourcePath: imagePath,
    isLayerRenderable: (layer) => isTextLayer(layer) || isStickerLayer(layer) || isOverlayLayer(layer),
    quality,
  });
  // saveEditedImage already registered the file; re-register (idempotent
  // upsert) to obtain the asset payload for the agent.
  const asset = await window.mediaWorkspace.quickRegister(savePath, imagePath);
  return { saved_path: savePath, layers: builtLayers.length, asset };
}

// Frame preset render — same flow as frame-lab / the editor's preset preview:
// renderFrame() composes bg + photo + scrim + generated text/logo layers.
async function handleFrame(payload) {
  const { imagePath, templateId, exifItem, savePath } = payload;
  const template = FRAME_TEMPLATES.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(`unknown frame template '${templateId}' — valid: ${FRAME_TEMPLATES.map((t) => t.id).join(", ")}`);
  }
  const photo = await loadImage(imagePath);
  const exif = exifFromItem(exifItem || {});
  const res = await window.mediaWorkspace.getFrameLogos?.();
  const registry = res ? buildLogoRegistry(res.manifest) : { byId: new Map() };
  const svgs = res?.svgs || {};
  const logoImages = new Map();
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* fonts are best-effort */ }
  }
  for (const need of collectLogoNeeds(template, exif, registry, { outH: photo.naturalHeight })) {
    const svg = svgs[need.file];
    if (svg) {
      logoImages.set(need.key, await prepareLogo(svg, {
        color: need.color,
        colorLocked: need.colorLocked,
        tintableColors: need.tintableColors,
        heightPx: need.heightPx,
      }));
    }
  }
  const canvas = renderFrame({ photo, exif, profile: {}, template, registry, logoImages });
  const buffer = await canvasToJpegBuffer(canvas);
  await window.mediaWorkspace.saveImage(savePath, buffer, imagePath);
  const asset = await window.mediaWorkspace.quickRegister(savePath, imagePath);
  return { saved_path: savePath, template_id: template.id, width: canvas.width, height: canvas.height, asset };
}

// What an agent can ask for — enumerations for edit_asset / apply_frame /
// render_collage parameter values.
function handleCapabilities() {
  const collage = {};
  for (const [count, list] of Object.entries(TEMPLATES)) {
    collage[count] = list.map((t) => ({ id: t.id, name: t.name }));
  }
  return {
    frame_templates: FRAME_TEMPLATES.map((t) => ({ id: t.id, name: t.name, family: t.family })),
    fonts: FONT_OPTIONS.map((f) => f.family ?? f),
    collage_templates: collage,
    collage_group_sizes: GROUP_SIZE_OPTIONS,
    collage_max_per_page: MAX_TEMPLATE_COUNT,
    edit_layer_types: ["text", "sticker"],
  };
}

// ---- Registration -----------------------------------------------------------

const HANDLERS = {
  collage: handleCollage,
  edit: handleEdit,
  frame: handleFrame,
  capabilities: handleCapabilities,
  // open_view is injected via deps at registration time
};

/**
 * Register the bridge. `deps.openView({view, assetIds})` is provided by App.jsx
 * (needs access to UI state setters). Returns a dispose function.
 */
export function registerRenderBridge(deps = {}) {
  const unsubscribe = window.mediaWorkspace?.onAgentRender?.(async ({ requestId, kind, payload }) => {
    try {
      let result;
      if (kind === "open_view") {
        if (!deps.openView) throw new Error("open_view is not available");
        result = await deps.openView(payload || {});
      } else {
        const handler = HANDLERS[kind];
        if (!handler) throw new Error(`unknown render kind: ${kind}`);
        result = await handler(payload || {});
      }
      window.mediaWorkspace.sendAgentRenderResult(requestId, result ?? {});
    } catch (error) {
      console.error(`[renderBridge] ${kind} failed:`, error);
      window.mediaWorkspace.sendAgentRenderResult(requestId, { error: error?.message || String(error) });
    }
  });
  return unsubscribe || (() => {});
}
