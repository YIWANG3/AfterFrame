// One card in the gallery: the thumbnail (or what stands in for it), the
// badges (missing, person, flag, video length), the caption, and the drag
// out — native on the desktop, an HTML5 drag with a drawn preview on the web.

import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Unlink, ScanFace, Flag, FlagOff, Play, Layers } from "lucide-react";
import api from "../api";
import { fileName, galleryInfoLabel, localFileUrl } from "../utils/format";
import PreviewImage from "./PreviewImage";
import { awaitingThumbnail } from "./galleryRepair";
import { CAPTION_HEIGHT } from "./galleryLayout";

// mm:ss (or h:mm:ss) for the video duration badge.
function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return "0:00";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

function clearAssetDragMarkers() {
  window.__mediaWorkspaceDraggingAssetId = null;
  window.__mediaWorkspaceDraggingAssetIds = null;
}

function createDragPreview(sourceElement, count) {
  const rect = sourceElement.getBoundingClientRect();
  const previewWidth = Math.min(180, Math.max(120, rect.width));
  const imageNode = sourceElement.querySelector("img");
  const imageHeight = Math.max(72, Math.round(previewWidth * 0.75));

  const preview = document.createElement("div");
  preview.style.position = "fixed";
  preview.style.left = "-10000px";
  preview.style.top = "-10000px";
  preview.style.width = `${previewWidth}px`;
  preview.style.pointerEvents = "none";
  preview.style.zIndex = "9999";
  preview.style.overflow = "hidden";
  preview.style.borderRadius = "12px";
  preview.style.background = "rgba(17, 17, 17, 0.97)";
  preview.style.border = "1px solid rgba(212, 167, 85, 0.78)";
  preview.style.boxShadow = "0 18px 44px rgba(0, 0, 0, 0.28)";
  preview.style.boxSizing = "border-box";

  const imageWrap = document.createElement("div");
  imageWrap.style.height = `${imageHeight}px`;
  imageWrap.style.overflow = "hidden";
  imageWrap.style.background = "#111";

  if (imageNode?.getAttribute("src")) {
    const previewImage = document.createElement("img");
    previewImage.src = imageNode.getAttribute("src");
    previewImage.alt = "";
    previewImage.draggable = false;
    previewImage.style.display = "block";
    previewImage.style.width = "100%";
    previewImage.style.height = "100%";
    previewImage.style.objectFit = "cover";
    imageWrap.appendChild(previewImage);
  }

  preview.appendChild(imageWrap);

  if (count > 1) {
    const badge = document.createElement("div");
    badge.textContent = String(count);
    badge.style.position = "absolute";
    badge.style.top = "8px";
    badge.style.right = "8px";
    badge.style.minWidth = "20px";
    badge.style.height = "20px";
    badge.style.padding = "0 6px";
    badge.style.borderRadius = "999px";
    badge.style.background = "rgba(16, 16, 16, 0.88)";
    badge.style.color = "#fff";
    badge.style.fontSize = "11px";
    badge.style.fontWeight = "600";
    badge.style.lineHeight = "20px";
    badge.style.textAlign = "center";
    badge.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.28)";
    preview.appendChild(badge);
  }

  document.body.appendChild(preview);
  return {
    element: preview,
    offsetX: Math.min(72, previewWidth / 2),
    offsetY: Math.min(72, Math.max(44, imageHeight * 0.4)),
  };
}

const GalleryCard = memo(function GalleryCard({
  item,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  onPrepareDragSelection,
  width,
  height,
  fit,
  containerRef,
  captionHeight = CAPTION_HEIGHT,
  compact = false,
  bustToken,
  importRunning = false,
  onPreviewError,
  onPreviewLoaded,
  onToggleBurst,
}) {
  const { t } = useTranslation("nav");
  const title = fileName(item.image_path) || item.stem;
  // Nothing to show until the thumbnail is made. While an import runs, it is
  // on its way: the import makes thumbnails in batches behind its reading.
  const awaiting = awaitingThumbnail(item);
  const totalHeight = height + captionHeight;
  const previewSrc = item.preview_path || item.image_path
    ? localFileUrl(item.preview_path || item.image_path) + (bustToken || item.modified_time ? `?r=${encodeURIComponent(bustToken || item.modified_time)}` : "")
    : null;

  // Video hover-scrub: lazily fetch a keyframe filmstrip on first hover, then
  // map cursor-x → frame so dragging across the card scrubs the clip.
  const isVideo = item.asset_type === "video";
  const [hoverFrames, setHoverFrames] = useState(null);
  // Natural aspect of the loaded preview: in contain mode (justified) the
  // drawn photo can be smaller than the cell, and the selection frame must
  // hug the photo, not the cell.
  const [naturalAr, setNaturalAr] = useState(null);
  const onNaturalSize = useCallback((w, h) => { if (w > 0 && h > 0) setNaturalAr(w / h); }, []);
  const frameAr = fit === "contain" && naturalAr ? naturalAr : width / height;
  const [hoverIdx, setHoverIdx] = useState(-1);
  const onVideoEnter = useCallback(() => {
    if (!isVideo || hoverFrames) return;
    Promise.resolve(api.videoKeyframes(item.image_path, 12))
      .then((frames) => { if (Array.isArray(frames) && frames.length) setHoverFrames(frames); })
      .catch(() => {});
  }, [isVideo, hoverFrames, item.image_path]);
  const onVideoMove = useCallback((event) => {
    if (!isVideo || !hoverFrames?.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(0.999, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHoverIdx(Math.floor(ratio * hoverFrames.length));
  }, [isVideo, hoverFrames]);
  const onVideoLeave = useCallback(() => setHoverIdx(-1), []);
  const hoverFrameSrc = isVideo && hoverIdx >= 0 && hoverFrames ? localFileUrl(hoverFrames[hoverIdx]) : null;

  return (
    <button
      type="button"
      onClick={(event) => onSelect(item.asset_id, event)}
      onDoubleClick={() => onOpen?.(item.asset_id)}
      onContextMenu={(event) => onContextMenu(event, item)}
      onDragStart={(event) => {
        const payload = onPrepareDragSelection?.(item.asset_id) || {
          assetIds: [item.asset_id],
          imagePaths: [item.image_path],
        };
        const firstAssetId = payload.assetIds?.[0] ?? item.asset_id;
        window.__mediaWorkspaceDraggingAssetId = firstAssetId;
        window.__mediaWorkspaceDraggingAssetIds = payload.assetIds || [firstAssetId];

        // Native OS drag-out: replace the HTML5 drag with a real OS drag
        // session carrying file paths — dropping on Finder copies the files,
        // dropping on a browser/chat uploads them. In-app drop targets
        // (sidebar collections) keep working: they fall back to the globals
        // above when the custom dataTransfer type is absent. startDrag
        // only acknowledges that the native session was started; it is not a
        // drag-finished signal (HTML5 dragend never fires once dragstart is
        // preventDefault()ed). App owns cleanup via mouseup/blur/Escape/drop.
        if (api.has("startNativeDrag")) {
          event.preventDefault();
          Promise.resolve(api.startNativeDrag({
            files: payload.imagePaths || [item.image_path],
            iconPath: item.preview_path || item.image_path,
          })).then((result) => {
            if (result?.ok === false) clearAssetDragMarkers();
          }).catch(clearAssetDragMarkers);
          return;
        }

        // Browser/dev fallback — in-app HTML5 drag only.
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-media-workspace-asset", JSON.stringify({
          assetId: firstAssetId,
          assetIds: payload.assetIds || [firstAssetId],
          imagePath: item.image_path,
          imagePaths: payload.imagePaths || [item.image_path],
        }));
        event.dataTransfer.setData("text/plain", JSON.stringify({
          assetId: firstAssetId,
          assetIds: payload.assetIds || [firstAssetId],
          imagePath: item.image_path,
          imagePaths: payload.imagePaths || [item.image_path],
        }));
        const preview = createDragPreview(event.currentTarget, (payload.assetIds || [firstAssetId]).length);
        window.__mediaWorkspaceDragPreviewEl = preview.element;
        event.dataTransfer.setDragImage(preview.element, preview.offsetX, preview.offsetY);
      }}
      onDragEnd={() => {
        clearAssetDragMarkers();
        if (window.__mediaWorkspaceDragPreviewEl instanceof HTMLElement) {
          window.__mediaWorkspaceDragPreviewEl.remove();
          window.__mediaWorkspaceDragPreviewEl = null;
        }
      }}
      data-gallery-item="true"
      data-selected={selected ? "true" : "false"}
      data-asset-id={item.asset_id}
      data-asset-type={item.asset_type}
      data-image-path={item.image_path}
      data-flag={item.app_flag === 1 ? "pick" : item.app_flag === -1 ? "reject" : "none"}
      data-burst-group={item.burst_group || undefined}
      data-burst={item.burst ? (item.burst.collapsed ? "collapsed" : "expanded") : undefined}
      draggable
      className="group absolute text-left focus:outline-none"
      style={{
        width: `${width}px`,
        height: `${totalHeight}px`,
        minWidth: 0,
        // Selection ring (index.css) is sized from --img-w/--img-h/--ar so it
        // follows the drawn photo even when contain-fit leaves a gap.
        "--img-w": `${width}px`,
        "--img-h": `${height}px`,
        "--ar": String(frameAr),
      }}
    >
      <div
        className={[
          "relative overflow-hidden transition-all duration-200",
          compact ? "rounded-none" : "rounded-md",
          selected
            ? "ring-2 ring-accent shadow-glow"
            : "ring-1 ring-border/40 group-hover:ring-accent/40 group-hover:shadow-card-hover",
        ].join(" ")}
        style={{ height: `${height}px` }}
        onMouseEnter={isVideo ? onVideoEnter : undefined}
        onMouseMove={isVideo ? onVideoMove : undefined}
        onMouseLeave={isVideo ? onVideoLeave : undefined}
      >
        {awaiting ? (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-muted" data-preview-pending={importRunning ? "true" : undefined}>
            {importRunning ? t("gallery.previewPending") : t("gallery.noPreview")}
          </div>
        ) : item.preview_path || item.image_path ? (
          <PreviewImage
            src={previewSrc}
            alt={item.stem}
            scrollRootRef={containerRef}
            fit={fit}
            className={[
              item.exists_on_disk === false ? "saturate-[.55] brightness-[.78]" : "",
              // Rejected photos fade back, as Lightroom's do while culling. A
              // filter, not opacity: the image's own fade-in owns that.
              item.app_flag === -1 ? "brightness-[.4] saturate-[.7]" : "",
            ].join(" ")}
            onLoadError={item.exists_on_disk === false ? undefined : () => onPreviewError?.(item)}
            onLoadSuccess={() => onPreviewLoaded?.(item)}
            onNaturalSize={onNaturalSize}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-muted">{t("gallery.noPreview")}</div>
        )}
        {hoverFrameSrc ? (
          <img
            src={hoverFrameSrc}
            alt=""
            draggable={false}
            className={`pointer-events-none absolute inset-0 h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
          />
        ) : null}
        {item.exists_on_disk === false ? (
          <div
            className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-[rgba(120,70,8,0.94)] px-1.5 py-0.5 text-[10px] font-medium text-[#FAEEDA]"
            title={t("gallery.missingTip")}
          >
            <Unlink className="h-2.5 w-2.5" />
            {t("gallery.missing")}
          </div>
        ) : null}
        {item.burst ? (
          // The stack: the frames shot with this one. Below the Missing
          // badge when both show; a click opens or folds the stack, nothing
          // else (the card's own click would select it).
          <button
            type="button"
            className={[
              "absolute left-1.5 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium shadow-sm transition-colors",
              item.exists_on_disk === false ? "top-8" : "top-1.5",
              item.burst.collapsed ? "bg-black/70 text-white hover:bg-black/85" : "bg-accent/90 text-white hover:bg-accent",
            ].join(" ")}
            title={t(item.burst.collapsed ? "gallery.burstOpen" : "gallery.burstClose", { count: item.burst.count })}
            data-burst-badge={item.burst.collapsed ? "collapsed" : "expanded"}
            onClick={(event) => { event.stopPropagation(); event.preventDefault(); onToggleBurst?.(item.burst.group); }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Layers className="h-2.5 w-2.5" />
            {item.burst.count}
          </button>
        ) : null}
        {item.has_face ? (
          <div
            className="pointer-events-none absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white/90 shadow-sm"
            title={t("gallery.hasPerson")}
          >
            <ScanFace className="h-3 w-3" />
          </div>
        ) : null}
        {item.app_flag === 1 || item.app_flag === -1 ? (
          <div
            className={[
              "pointer-events-none absolute bottom-1.5 left-1.5 rounded-full p-1 shadow-sm",
              item.app_flag === 1 ? "bg-white/90 text-black/80" : "bg-black/75 text-[#ff8a80]",
            ].join(" ")}
            title={t(item.app_flag === 1 ? "flag.pick" : "flag.reject")}
            data-flag-badge={item.app_flag === 1 ? "pick" : "reject"}
          >
            {item.app_flag === 1 ? <Flag className="h-3 w-3 fill-current" /> : <FlagOff className="h-3 w-3" />}
          </div>
        ) : null}
        {item.asset_type === "video" ? (
          <div className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
            <Play className="h-2.5 w-2.5 fill-current" />
            {formatDuration(item.image_metadata?.duration)}
          </div>
        ) : null}
      </div>
      {captionHeight > 0 ? (
        <div className="px-0.5 pt-1.5">
          <div
            className={[
              "truncate",
              "min-w-0 text-[11px] leading-[1.3]",
              selected ? "text-text" : "text-text/92",
            ].join(" ")}
          >
            {title}
          </div>
          <div className={`mt-0.5 truncate text-[10px] leading-[1.3] ${selected ? "text-muted" : "text-muted2"}`}>
            {galleryInfoLabel(item)}
          </div>
        </div>
      ) : null}
    </button>
  );
});

export default GalleryCard;
