// Layer renderer — turns layer state (text + sticker) into pixels on a canvas
// context. Pure: takes everything it needs as args, no React, no globals.
// Used by both the inline-apply path and the export-to-disk path.

import { drawScrim, hexToRgba } from "./canvasHelpers";
import { getBgPadding, applyTextCase } from "../textState";

/**
 * Draw a list of text + sticker layers onto a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} canvasWidth - in destination pixels
 * @param {number} canvasHeight - in destination pixels
 * @param {Array} layersToRender
 * @param {Map<string, HTMLImageElement>} stickerImageCache - pre-loaded sticker images keyed by path
 */
export function drawLayersOnCanvas(ctx, canvasWidth, canvasHeight, layersToRender, stickerImageCache) {
  const scale = canvasWidth / 1920;
  for (const layer of layersToRender) {
    if (layer.type === "overlay") {
      const r = layer.overlayRect || { x: 0, y: 0, width: 1, height: 1 };
      drawScrim(ctx, layer, {
        x: r.x * canvasWidth,
        y: r.y * canvasHeight,
        width: r.width * canvasWidth,
        height: r.height * canvasHeight,
      });
      continue;
    }
    const px = layer.x * canvasWidth;
    const py = layer.y * canvasHeight;

    if (layer.type === "sticker") {
      drawStickerLayer(ctx, scale, px, py, canvasWidth, layer, stickerImageCache);
      continue;
    }

    drawTextLayer(ctx, scale, px, py, layer);
  }
}

function drawStickerLayer(ctx, scale, px, py, canvasWidth, layer, stickerImageCache) {
  const img = stickerImageCache?.get(layer.stickerPath);
  if (!img || !img.complete || img.naturalWidth === 0) return;

  const widthPx = (layer.scale ?? 0.4) * canvasWidth;
  const aspect = img.naturalHeight / img.naturalWidth;
  const heightPx = widthPx * aspect;
  const outlineW = (layer.outlineWidth || 0);
  // outlineWidth is "px at sticker natural resolution"; scale to display.
  const outlinePx = outlineW > 0 ? outlineW * (widthPx / img.naturalWidth) : 0;

  ctx.save();
  ctx.translate(px, py);
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.globalAlpha = (layer.opacity ?? 100) / 100;
  if (layer.shadow) {
    ctx.shadowColor = hexToRgba(layer.shadowColor, (layer.shadowOpacity ?? 60) / 100);
    ctx.shadowBlur = (layer.shadowBlur || 0) * scale;
    ctx.shadowOffsetX = (layer.shadowX || 0) * scale;
    ctx.shadowOffsetY = (layer.shadowY || 0) * scale;
  }

  // Composite outline + sticker onto an offscreen canvas first, so the canvas-
  // level shadow is applied to the COMBINED silhouette (not separate halos).
  const pad = Math.ceil(outlinePx) + 4;
  const offW = Math.ceil(widthPx + pad * 2);
  const offH = Math.ceil(heightPx + pad * 2);
  const off = document.createElement("canvas");
  off.width = offW;
  off.height = offH;
  const offCtx = off.getContext("2d");

  if (outlinePx > 0) {
    // Stamp source img at offsets along a circle to dilate alpha, then tint
    // to outline color via source-in compositing.
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = offW;
    maskCanvas.height = offH;
    const mCtx = maskCanvas.getContext("2d");
    const stamps = 24;
    for (let i = 0; i < stamps; i++) {
      const ang = (i / stamps) * Math.PI * 2;
      mCtx.drawImage(
        img,
        pad + Math.cos(ang) * outlinePx,
        pad + Math.sin(ang) * outlinePx,
        widthPx,
        heightPx,
      );
    }
    mCtx.globalCompositeOperation = "source-in";
    mCtx.fillStyle = hexToRgba(layer.outlineColor || "#ffffff", (layer.outlineOpacity ?? 100) / 100);
    mCtx.fillRect(0, 0, offW, offH);
    offCtx.drawImage(maskCanvas, 0, 0);
  }
  offCtx.drawImage(img, pad, pad, widthPx, heightPx);

  // Outer glow — draw far off-canvas with the shadow offset pulling the halo
  // back into place, so only the glow lands (no double-stamping the sticker).
  // ctx.shadowOffset* is DEVICE-space while our draw offset is in the rotated
  // local frame, hence the cos/sin correction.
  if (layer.glow) {
    const rad = (((layer.rotation || 0) % 360) * Math.PI) / 180;
    const L = 100000;
    ctx.save();
    ctx.shadowColor = hexToRgba(layer.glowColor || "#ffd76a", (layer.glowOpacity ?? 80) / 100);
    ctx.shadowBlur = (layer.glowBlur ?? 24) * scale;
    ctx.shadowOffsetX = Math.cos(rad) * L;
    ctx.shadowOffsetY = Math.sin(rad) * L;
    for (let i = 0; i < (layer.glowIntensity ?? 2); i++) {
      ctx.drawImage(off, -widthPx / 2 - pad - L, -heightPx / 2 - pad);
    }
    ctx.restore();
  }

  ctx.drawImage(off, -widthPx / 2 - pad, -heightPx / 2 - pad);
  ctx.restore();
}

function drawTextLayer(ctx, scale, px, py, layer) {
  ctx.save();
  ctx.translate(px, py);
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180);

  const fontStyle = layer.italic ? "italic" : "normal";
  const fontWeight = layer.fontWeight ?? (layer.bold ? 700 : 400);
  const fontSize = layer.fontSize * scale;
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px "${layer.fontFamily}", sans-serif`;
  ctx.textAlign = layer.align;
  ctx.textBaseline = "middle";
  // Optional tracking (em fraction). Chromium canvas supports letterSpacing;
  // measureText accounts for it, so width math below stays correct.
  const letterSpacing = (layer.tracking ?? 0) * fontSize;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${letterSpacing}px`;

  // Multi-line: the layer's box is its widest line × (lineHeight × line count),
  // mirroring the DOM preview (white-space: pre, textAlign per line).
  const displayText = applyTextCase(layer.text, layer.textCase) || " ";
  const lines = displayText.split("\n");
  const lineH = fontSize * (layer.lineHeight ?? 1.2);
  const lineWidths = lines.map((ln) => (ln ? ctx.measureText(ln).width : 0));
  const tw = Math.max(...lineWidths);
  const th = lineH * lines.length;
  let alignOffsetX = 0;
  if (layer.align === "left") alignOffsetX = tw / 2;
  else if (layer.align === "right") alignOffsetX = -tw / 2;

  // Background
  if (layer.bgMode === "solid" || layer.bgMode === "gradient") {
    const pad = getBgPadding(layer);
    const padT = (fontSize * pad.top) / 100;
    const padR = (fontSize * pad.right) / 100;
    const padB = (fontSize * pad.bottom) / 100;
    const padL = (fontSize * pad.left) / 100;
    const bgOp = (layer.bgOpacity ?? 100) / 100;
    if (layer.bgMode === "gradient") {
      // CSS linear-gradient angle convention: 0deg = up, 90deg = right.
      // Direction vector for CSS angle θ is (sin θ, -cos θ).
      const angleRad = ((layer.bgGradAngle ?? 90) * Math.PI) / 180;
      const dx = Math.sin(angleRad);
      const dy = -Math.cos(angleRad);
      const halfDiag = (Math.abs(dx) * (tw + padL + padR) + Math.abs(dy) * (th + padT + padB)) / 2;
      const gx = dx * halfDiag;
      const gy = dy * halfDiag;
      const grad = ctx.createLinearGradient(-gx, -gy, gx, gy);
      grad.addColorStop(0, hexToRgba(layer.bgGradFrom ?? layer.bgColor ?? "#000", ((layer.bgGradFromOpacity ?? 100) / 100) * bgOp));
      grad.addColorStop(1, hexToRgba(layer.bgGradTo ?? "#fff", ((layer.bgGradToOpacity ?? 100) / 100) * bgOp));
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = hexToRgba(layer.bgColor, bgOp);
    }
    ctx.fillRect(-tw / 2 - padL, -th / 2 - padT, tw + padL + padR, th + padT + padB);
  }

  // Stroke + fill on an offscreen canvas (no shadow), then blit to main with
  // shadow enabled. Makes the shadow source = merged glyph silhouette
  // (matches CSS text-shadow + paint-order). Otherwise the canvas-level shadow
  // would only fall under the stroke ring (a hollow shape).
  const strokeLW = (layer.strokeEnabled && layer.strokeWidth > 0) ? layer.strokeWidth * scale * 2 : 0;
  const padX = Math.ceil(strokeLW + 4);
  // Each line's glyphs can extend ~0.6em above/below the line's vertical
  // center (ascent 0.85 / descent 0.35 around the middle baseline), which can
  // overflow the line box when lineHeight < 1.2 — pad by glyph extent, not
  // line box. For one line at lineHeight 1.2 this matches the old constant.
  const padY = Math.ceil(strokeLW + 4 + fontSize * 0.6);
  const offW = Math.ceil(tw + padX * 2);
  const offH = Math.ceil((lines.length - 1) * lineH + padY * 2);

  const off = document.createElement("canvas");
  off.width = offW;
  off.height = offH;
  const offCtx = off.getContext("2d");
  offCtx.font = ctx.font;
  offCtx.textAlign = layer.align;
  offCtx.textBaseline = "middle";
  offCtx.imageSmoothingQuality = "high";
  if ("letterSpacing" in offCtx) offCtx.letterSpacing = `${letterSpacing}px`;

  let offX;
  if (layer.align === "left") offX = padX;
  else if (layer.align === "right") offX = offW - padX;
  else offX = offW / 2;
  const offY = offH / 2;
  const lineY = (i) => offY + (i - (lines.length - 1) / 2) * lineH;

  if (strokeLW > 0) {
    if (layer.strokeMode === "gradient") {
      const angleRad = ((layer.strokeGradAngle ?? 90) * Math.PI) / 180;
      const dx = Math.sin(angleRad);
      const dy = -Math.cos(angleRad);
      const halfDiag = (Math.abs(dx) * tw + Math.abs(dy) * th) / 2;
      const gx = dx * halfDiag;
      const gy = dy * halfDiag;
      const grad = offCtx.createLinearGradient(offX - gx, offY - gy, offX + gx, offY + gy);
      grad.addColorStop(0, hexToRgba(layer.strokeGradFrom ?? layer.strokeColor, (layer.strokeGradFromOpacity ?? 100) / 100));
      grad.addColorStop(1, hexToRgba(layer.strokeGradTo ?? "#000", (layer.strokeGradToOpacity ?? 100) / 100));
      offCtx.strokeStyle = grad;
    } else {
      offCtx.strokeStyle = layer.strokeColor;
    }
    offCtx.lineWidth = strokeLW;
    offCtx.lineJoin = "round";
    lines.forEach((ln, i) => { if (ln) offCtx.strokeText(ln, offX, lineY(i)); });
  }

  if (layer.fillMode === "gradient") {
    const angleRad = (layer.gradientAngle * Math.PI) / 180;
    const dx = Math.sin(angleRad);
    const dy = -Math.cos(angleRad);
    const halfDiag = (Math.abs(dx) * tw + Math.abs(dy) * th) / 2;
    const gx = dx * halfDiag;
    const gy = dy * halfDiag;
    const grad = offCtx.createLinearGradient(offX - gx, offY - gy, offX + gx, offY + gy);
    grad.addColorStop(0, hexToRgba(layer.gradientFrom, (layer.gradientFromOpacity ?? 100) / 100));
    grad.addColorStop(1, hexToRgba(layer.gradientTo, (layer.gradientToOpacity ?? 100) / 100));
    offCtx.fillStyle = grad;
  } else {
    offCtx.fillStyle = hexToRgba(layer.fillColor, (layer.fillOpacity ?? 100) / 100);
  }
  lines.forEach((ln, i) => { if (ln) offCtx.fillText(ln, offX, lineY(i)); });

  // Underline / strikethrough — canvas has no text-decoration, so draw the
  // rules by hand with the same fillStyle (solid or gradient) as the glyphs.
  // Offsets mirror the CSS the preview uses: middle baseline sits ~0.25em
  // below the line's vertical center; underline hangs 0.06em below the
  // baseline, line-through crosses ~0.3em above it.
  if (layer.underline || layer.strikethrough) {
    const thick = Math.max(2, fontSize * 0.04);
    lines.forEach((ln, i) => {
      const w = lineWidths[i];
      if (!w) return;
      const yi = lineY(i);
      const xs = layer.align === "left" ? offX : layer.align === "right" ? offX - w : offX - w / 2;
      if (layer.underline) offCtx.fillRect(xs, yi + fontSize * 0.25 + Math.max(2, fontSize * 0.06), w, thick);
      if (layer.strikethrough) offCtx.fillRect(xs, yi - fontSize * 0.05 - thick / 2, w, thick);
    });
  }

  // Paint onto the main canvas with shadow enabled.
  ctx.globalAlpha = layer.opacity / 100;
  if (layer.shadow) {
    ctx.shadowColor = hexToRgba(layer.shadowColor, layer.shadowOpacity / 100);
    ctx.shadowBlur = layer.shadowBlur * scale;
    ctx.shadowOffsetX = layer.shadowX * scale;
    ctx.shadowOffsetY = layer.shadowY * scale;
  }
  ctx.drawImage(off, alignOffsetX - offX, -offY);
  if (layer.shadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  ctx.restore();
}
