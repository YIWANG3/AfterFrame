import { ChevronLeft, ChevronRight, Minus, Pencil, Plus, SwatchBook, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileName, localFileUrl, httpMediaUrl } from "../utils/format";
import { buildLightboxSources, resolveLightboxLogicalSize } from "./lightboxView";
import VideoPlayer from "./VideoPlayer";

const MAX_SCALE = 8;
const MIN_SCALE = 0.02;
const WHEEL_ZOOM_SENSITIVITY = 0.014;
const DETAIL_SETTLE_DELAY_MS = 180;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function OverlayButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={[
        "flex h-10 w-10 items-center justify-center rounded-full bg-black/42 text-white/90 transition-colors hover:bg-black/58 hover:text-white",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}

function ActionPill({ icon: Icon, label, shortcut, active = false, className = "", ...props }) {
  const { onClick, ...restProps } = props;
  return (
    <button
      type="button"
      className={[
        "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-colors",
        active
          ? "border-white/22 bg-white/18 text-white"
          : "border-white/12 bg-black/26 text-white/80 hover:border-white/18 hover:bg-black/36 hover:text-white",
        className,
      ].join(" ")}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      {...restProps}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
      {shortcut ? <span className="text-[11px] text-white/45">{shortcut}</span> : null}
    </button>
  );
}

function formatPercent(scale) {
  return `${Math.round(scale * 100)}%`;
}

export default function Lightbox({
  open,
  items,
  currentIndex,
  proofMode,
  onToggleProof,
  onEdit,
  onClose,
  onIndexChange,
}) {
  const { t } = useTranslation("nav");
  const viewportRef = useRef(null);
  const imageRef = useRef(null);
  const detailImageRef = useRef(null);
  const sliderRef = useRef(null);
  const scaleLabelRef = useRef(null);
  const dragRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const activePointerIdRef = useRef(null);
  const viewRef = useRef(null);
  const fitScaleRef = useRef(1);
  const paintFrameRef = useRef(0);
  const detailReadyRef = useRef(false);
  const detailVisibleRef = useRef(false);
  const detailSettleTimerRef = useRef(null);
  const canUseDetailRef = useRef(false);
  const logicalSizeRef = useRef(null);
  const activeAssetIdRef = useRef(null);
  const detailUrlRef = useRef(null);
  const isZoomedRef = useRef(false);
  const [naturalSize, setNaturalSize] = useState(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [loadState, setLoadState] = useState("loading");
  const [showLoadingText, setShowLoadingText] = useState(false);
  const [sourceIndex, setSourceIndex] = useState(0);
  // H.264 proxy fallback for videos Chromium can't decode (e.g. 10-bit HEVC).
  const [proxySrc, setProxySrc] = useState(null);
  const [proxyPending, setProxyPending] = useState(false);

  const clampedIndex = Math.max(0, Math.min(currentIndex, Math.max((items?.length || 1) - 1, 0)));
  const currentItem = items?.[clampedIndex] || null;
  const { baseSources: sources, detailPath } = useMemo(
    () => buildLightboxSources(currentItem),
    [currentItem],
  );
  const imagePath = sources[sourceIndex] || null;
  const imageRevision = currentItem?.modified_time || currentItem?.image_metadata?.modified_time;
  const imageUrl = imagePath
    ? localFileUrl(imagePath) + (imageRevision ? `?r=${encodeURIComponent(imageRevision)}` : "")
    : null;
  const detailUrl = detailPath
    ? localFileUrl(detailPath) + (imageRevision ? `?r=${encodeURIComponent(imageRevision)}` : "")
    : null;
  const canUseDetail = Boolean(detailPath && detailPath !== imagePath);
  activeAssetIdRef.current = currentItem?.asset_id || null;
  detailUrlRef.current = detailUrl;
  canUseDetailRef.current = canUseDetail;
  // Video: play the original directly (Chromium decodes h264/HEVC on macOS),
  // bypassing the image zoom/pan machinery. Falls back to the poster <img>
  // below when the original is missing.
  const isVideo = currentItem?.asset_type === "video";
  const videoSrc = isVideo && currentItem?.exists_on_disk !== false ? currentItem?.image_path : null;
  const title = fileName(currentItem?.image_path) || currentItem?.stem || "Selected asset";

  // Reset the proxy when switching items.
  useEffect(() => { setProxySrc(null); setProxyPending(false); }, [currentItem?.asset_id]);

  // On native decode failure (Chromium can't play this codec), transcode an
  // H.264 proxy on demand and swap the <video> source to it.
  const requestVideoProxy = () => {
    if (!isVideo || proxySrc || proxyPending) return;
    const orig = currentItem?.image_path;
    if (!orig) return;
    setProxyPending(true);
    Promise.resolve(window.mediaWorkspace?.videoProxy?.(orig))
      .then((url) => { setProxyPending(false); if (url) setProxySrc(url); })
      .catch(() => setProxyPending(false));
  };

  const metaWidth = Number(currentItem?.image_metadata?.width || 0);
  const metaHeight = Number(currentItem?.image_metadata?.height || 0);
  const canGoPrev = clampedIndex > 0;
  const canGoNext = clampedIndex < (items?.length || 0) - 1;

  function syncZoomedState(nextScale) {
    const nextIsZoomed = nextScale > fitScaleRef.current + 0.001;
    if (nextIsZoomed === isZoomedRef.current) return;
    isZoomedRef.current = nextIsZoomed;
    setIsZoomed(nextIsZoomed);
  }

  function paintScaleControls(nextScale) {
    if (sliderRef.current) sliderRef.current.value = String(Math.log(clamp(nextScale, MIN_SCALE, MAX_SCALE)));
    if (scaleLabelRef.current) scaleLabelRef.current.textContent = formatPercent(nextScale);
  }

  function schedulePaint() {
    if (paintFrameRef.current) return;
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = 0;
      const image = imageRef.current;
      const current = viewRef.current;
      if (!image || !current) return;
      const transform = `translate3d(${current.tx}px, ${current.ty}px, 0) scale(${current.scale})`;
      image.style.transform = transform;
      // The detail layer only follows single-shot transforms (resize, reveal).
      // During continuous interaction it is hidden first, so the full-size
      // bitmap never gets resampled per wheel/drag frame.
      if (detailVisibleRef.current && detailImageRef.current) {
        detailImageRef.current.style.transform = transform;
      }
      paintScaleControls(current.scale);
    });
  }

  function applyView(nextView, previewDuringMotion = false) {
    if (!nextView) return;
    if (previewDuringMotion) beginDetailInteraction();
    else preferDetail();
    viewRef.current = nextView;
    syncZoomedState(nextView.scale);
    schedulePaint();
    if (previewDuringMotion) settleDetailInteraction();
  }

  function hideDetail() {
    detailVisibleRef.current = false;
    if (detailImageRef.current) detailImageRef.current.style.visibility = "hidden";
  }

  function revealDetail() {
    const detailImage = detailImageRef.current;
    const current = viewRef.current;
    if (!detailImage || !detailReadyRef.current || !current || !canUseDetailRef.current) return;
    detailImage.style.transform = imageRef.current?.style.transform || "";
    detailImage.style.visibility = "visible";
    detailVisibleRef.current = true;
  }

  function beginDetailInteraction() {
    if (detailSettleTimerRef.current) {
      clearTimeout(detailSettleTimerRef.current);
      detailSettleTimerRef.current = null;
    }
    if (detailVisibleRef.current) hideDetail();
  }

  function preferDetail() {
    if (detailSettleTimerRef.current) {
      clearTimeout(detailSettleTimerRef.current);
      detailSettleTimerRef.current = null;
    }
    if (!detailVisibleRef.current) revealDetail();
  }

  function settleDetailInteraction() {
    if (!canUseDetailRef.current) return;
    if (detailSettleTimerRef.current) clearTimeout(detailSettleTimerRef.current);
    detailSettleTimerRef.current = setTimeout(() => {
      detailSettleTimerRef.current = null;
      revealDetail();
    }, DETAIL_SETTLE_DELAY_MS);
  }

  function computeFit(width, height) {
    const viewport = viewportRef.current;
    if (!viewport || !width || !height) {
      return { scale: 1, tx: 0, ty: 0 };
    }
    const rect = viewport.getBoundingClientRect();
    const nextScale = Math.min(rect.width / width, rect.height / height, 1);
    return {
      scale: nextScale,
      tx: (rect.width - width * nextScale) / 2,
      ty: (rect.height - height * nextScale) / 2,
    };
  }

  function resetToFit(width = naturalSize?.width, height = naturalSize?.height) {
    if (!width || !height) return;
    const fit = computeFit(width, height);
    fitScaleRef.current = fit.scale;
    applyView(fit);
  }

  function zoomFromCenter(nextScale, previewDuringMotion = false) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = viewRef.current;
    if (!current) return;
    const rect = viewport.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const clampedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const ratio = clampedScale / current.scale;
    applyView({
      scale: clampedScale,
      tx: cx - ratio * (cx - current.tx),
      ty: cy - ratio * (cy - current.ty),
    }, previewDuringMotion);
  }

  // Synchronously reset image display state — must be called in the same
  // batch as any state change that swaps the displayed image so the first
  // render after the swap already has loadState="loading" (image hidden).
  function resetImageState() {
    setNaturalSize(null);
    fitScaleRef.current = 1;
    viewRef.current = null;
    detailReadyRef.current = false;
    detailVisibleRef.current = false;
    if (detailSettleTimerRef.current) {
      clearTimeout(detailSettleTimerRef.current);
      detailSettleTimerRef.current = null;
    }
    logicalSizeRef.current = null;
    isZoomedRef.current = false;
    setIsZoomed(false);
    setLoadState("loading");
    setShowLoadingText(false);
    setSourceIndex(0);
    activePointerIdRef.current = null;
    setDragging(false);
  }

  // Only show "Loading..." text after a delay to avoid flicker on fast loads
  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = setTimeout(() => setShowLoadingText(true), 400);
    return () => clearTimeout(timer);
  }, [loadState]);

  // Reset image load state when current item changes
  useEffect(() => {
    if (!open) {
      if (paintFrameRef.current) cancelAnimationFrame(paintFrameRef.current);
      paintFrameRef.current = 0;
      if (detailSettleTimerRef.current) {
        clearTimeout(detailSettleTimerRef.current);
        detailSettleTimerRef.current = null;
      }
      activePointerIdRef.current = null;
      detailReadyRef.current = false;
      detailVisibleRef.current = false;
      return;
    }
    resetImageState();
  }, [open, currentItem?.asset_id, currentItem?.image_path, currentItem?.image_preview_path, currentItem?.raw_preview_path]);

  useEffect(() => () => {
    if (paintFrameRef.current) cancelAnimationFrame(paintFrameRef.current);
    if (detailSettleTimerRef.current) clearTimeout(detailSettleTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open || !naturalSize || typeof ResizeObserver === "undefined") return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    let frame = null;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextFit = computeFit(naturalSize.width, naturalSize.height);
        const current = viewRef.current;
        const wasAtFit = !current || current.scale <= fitScaleRef.current + 0.001;
        fitScaleRef.current = nextFit.scale;
        if (wasAtFit || current.scale < nextFit.scale) {
          applyView(nextFit);
        }
      });
    });

    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [naturalSize, open]);

  useEffect(() => {
    if (!open) return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    function handleWheel(event) {
      event.preventDefault();
      const current = viewRef.current;
      if (!current || !naturalSize) return;
      const rect = viewport.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      if (Math.abs(nextScale - current.scale) < 0.0001) return;
      const ratio = nextScale / current.scale;
      applyView({
        scale: nextScale,
        tx: mx - ratio * (mx - current.tx),
        ty: my - ratio * (my - current.ty),
      }, true);
    }

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [naturalSize, open]);

  if (!open || !currentItem) return null;

  function handleImageLoad(event) {
    const width = event.currentTarget.naturalWidth;
    const height = event.currentTarget.naturalHeight;
    if (!width || !height) return;
    const logicalSize = resolveLightboxLogicalSize(width, height, metaWidth, metaHeight);
    const { width: logicalWidth, height: logicalHeight } = logicalSize;
    logicalSizeRef.current = logicalSize;
    event.currentTarget.style.width = `${logicalWidth}px`;
    event.currentTarget.style.height = `${logicalHeight}px`;
    setNaturalSize(logicalSize);
    applyInitialFit(logicalWidth, logicalHeight);
    if (detailImageRef.current) {
      detailImageRef.current.style.width = `${logicalWidth}px`;
      detailImageRef.current.style.height = `${logicalHeight}px`;
      if (detailReadyRef.current && !detailSettleTimerRef.current) {
        revealDetail();
      }
    }
    setLoadState("ready");
    // Cached images fire onLoad synchronously during render before refs commit,
    // so the first computeFit may see a null viewport and fall back to scale=1
    // (the image then displays at natural size — huge for ultra-wide stickers).
    // Re-fit on the next frame once layout has settled.
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      applyInitialFit(logicalWidth, logicalHeight);
    });
  }

  function applyInitialFit(width, height) {
    const fit = computeFit(width, height);
    const previous = viewRef.current;
    // A reload of the same item (preview repair, source fallback) must not
    // yank an already-zoomed view back to Fit — keep the user's view and only
    // refresh the fit reference.
    const wasAtFit = !previous || previous.scale <= fitScaleRef.current + 0.001;
    fitScaleRef.current = fit.scale;
    const next = wasAtFit ? fit : previous;
    viewRef.current = next;
    syncZoomedState(next.scale);
    paintScaleControls(next.scale);
    if (imageRef.current) {
      imageRef.current.style.transform = `translate3d(${next.tx}px, ${next.ty}px, 0) scale(${next.scale})`;
      imageRef.current.style.visibility = "visible";
    }
  }

  function handleImageError() {
    if (sourceIndex < sources.length - 1) {
      setSourceIndex((current) => current + 1);
      return;
    }
    setLoadState("error");
  }

  function handlePointerDown(event) {
    const current = viewRef.current;
    if (event.button !== 0 || !isZoomedRef.current || !current) return;
    event.preventDefault();
    setDragging(true);
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: current.tx,
      ty: current.ty,
    };
  }

  function handlePointerMove(event) {
    if (!dragging || activePointerIdRef.current !== event.pointerId) return;
    const current = viewRef.current;
    if (!current) return;
    applyView({
      ...current,
      tx: dragRef.current.tx + (event.clientX - dragRef.current.x),
      ty: dragRef.current.ty + (event.clientY - dragRef.current.y),
    });
  }

  function handlePointerUp(event) {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleDoubleClick(event) {
    const current = viewRef.current;
    if (!current) return;
    if (current.scale > fitScaleRef.current + 0.001) {
      resetToFit();
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const nextScale = clamp(Math.max(1, fitScaleRef.current * 2), fitScaleRef.current, MAX_SCALE);
    const ratio = nextScale / current.scale;
    applyView({
      scale: nextScale,
      tx: mx - ratio * (mx - current.tx),
      ty: my - ratio * (my - current.ty),
    });
  }

  function handleSliderChange(event) {
    zoomFromCenter(Math.exp(Number(event.target.value)), true);
  }

  async function handleDetailLoad(event) {
    const image = event.currentTarget;
    const assetId = currentItem.asset_id;
    const loadedUrl = detailUrl;
    try {
      await image.decode();
    } catch {
      // Chromium rejects decode() for very large bitmaps (EncodingError seen
      // with ~100MP JPEGs) even though the image renders fine through the
      // normal raster path. onLoad already proved the data is good — reveal
      // anyway and accept the one-time raster cost.
    }
    if (
      activeAssetIdRef.current !== assetId
      || detailUrlRef.current !== loadedUrl
      || detailImageRef.current !== image
    ) return;
    detailReadyRef.current = true;
    const logicalSize = logicalSizeRef.current;
    if (logicalSize) {
      image.style.width = `${logicalSize.width}px`;
      image.style.height = `${logicalSize.height}px`;
    }
    // A pending settle timer means the user is interacting; its callback
    // reveals once the view stops moving.
    if (!detailSettleTimerRef.current) revealDetail();
  }

  function handleDetailError(event) {
    detailReadyRef.current = false;
    detailVisibleRef.current = false;
    event.currentTarget.style.visibility = "hidden";
  }

  return (
    <div
      className={[
        "fixed inset-0 z-[10050] flex flex-col",
        proofMode ? "bg-white" : "bg-black/90 backdrop-blur-sm",
      ].join(" ")}
      onClick={onClose}
    >
      <div className={[
        "pointer-events-none flex shrink-0 items-start justify-between px-6 py-5",
        proofMode ? "invisible" : "",
      ].join(" ")}>
        <div className="pointer-events-auto min-w-0">
          <div className="truncate text-[15px] font-medium text-white">{title}</div>
          <div className="mt-1 text-[12px] text-white/60">
            {items.length > 0 ? `${clampedIndex + 1} / ${items.length}` : ""}
            {(metaWidth > 0 && metaHeight > 0) ? ` · ${metaWidth} × ${metaHeight}` : ""}
          </div>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {onEdit && !isVideo && (
            <ActionPill
              icon={Pencil}
              label={t("lightbox.edit")}
              shortcut="E"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(currentItem);
              }}
            />
          )}
          {onToggleProof && !isVideo && (
            <ActionPill
              icon={SwatchBook}
              label={t("lightbox.proof")}
              shortcut="P"
              active={proofMode}
              onClick={onToggleProof}
            />
          )}
          <OverlayButton onClick={onClose}>
            <X className="h-4 w-4" />
          </OverlayButton>
        </div>
      </div>

      {!proofMode && canGoPrev ? (

        <OverlayButton
          onClick={(event) => {
            event.stopPropagation();
            onIndexChange(clampedIndex - 1);
          }}
          className="pointer-events-auto absolute left-6 top-1/2 z-10 -translate-y-1/2"
        >
          <ChevronLeft className="h-5 w-5" />
        </OverlayButton>
      ) : null}

      {!proofMode && canGoNext ? (
        <OverlayButton
          onClick={(event) => {
            event.stopPropagation();
            onIndexChange(clampedIndex + 1);
          }}
          className="pointer-events-auto absolute right-6 top-1/2 z-10 -translate-y-1/2"
        >
          <ChevronRight className="h-5 w-5" />
        </OverlayButton>
      ) : null}

      <div
        ref={viewportRef}
        data-lightbox-viewport="true"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={[
          "relative min-h-0 flex-1 overflow-hidden",
          isZoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
        ].join(" ")}
        style={{ touchAction: "none" }}
      >
        {loadState === "error" ? (
          <div className="absolute inset-0 grid place-items-center text-[14px] text-white/70">
            {t("lightbox.failedToLoad")}
          </div>
        ) : null}

        {isVideo && videoSrc ? (
          <>
            <VideoPlayer
              key={httpMediaUrl(proxySrc || videoSrc)}
              src={httpMediaUrl(proxySrc || videoSrc)}
              onError={requestVideoProxy}
            />
            {proxyPending ? (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/50 text-[13px] text-white/85">
                {t("lightbox.preparingVideo")}
              </div>
            ) : null}
          </>
        ) : imagePath ? (
          <img
            key={imageUrl}
            data-lightbox-layer="preview"
            src={imageUrl}
            alt={currentItem.stem || ""}
            onLoad={handleImageLoad}
            onError={handleImageError}
            draggable={false}
            decoding="async"
            className="absolute left-0 top-0 max-w-none select-none"
            style={{
              transformOrigin: "0 0",
              transform: "translate3d(0, 0, 0) scale(1)",
              visibility: "hidden",
              willChange: "transform",
            }}
            ref={imageRef}
          />
        ) : null}

        {!isVideo && canUseDetail ? (
          <img
            key={detailUrl}
            data-lightbox-layer="detail"
            src={detailUrl}
            alt=""
            aria-hidden="true"
            onLoad={handleDetailLoad}
            onError={handleDetailError}
            draggable={false}
            decoding="async"
            className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
            style={{
              width: naturalSize ? `${naturalSize.width}px` : undefined,
              height: naturalSize ? `${naturalSize.height}px` : undefined,
              transformOrigin: "0 0",
              transform: "translate3d(0, 0, 0) scale(1)",
              visibility: "hidden",
              willChange: "transform",
            }}
            ref={detailImageRef}
          />
        ) : null}

        {!isVideo && loadState === "loading" && showLoadingText ? (
          <div className="absolute inset-0 grid place-items-center text-[14px] text-white/70">
            {t("lightbox.loadingLarge")}
          </div>
        ) : null}
      </div>

      {!isVideo && (
        <div
          className={[
            "pointer-events-none flex shrink-0 items-center justify-center gap-3 py-4",
            proofMode ? "invisible" : "",
          ].join(" ")}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            onClick={() => {
              zoomFromCenter((viewRef.current?.scale || 1) / 1.35);
            }}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <input
            type="range"
            min={Math.log(MIN_SCALE)}
            max={Math.log(MAX_SCALE)}
            step={0.01}
            defaultValue={Math.log(1)}
            onChange={handleSliderChange}
            ref={sliderRef}
            className="lightbox-slider pointer-events-auto w-32"
            aria-label={t("lightbox.zoomLevel")}
          />
          <button
            type="button"
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            onClick={() => {
              zoomFromCenter((viewRef.current?.scale || 1) * 1.35);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            ref={scaleLabelRef}
            className="pointer-events-auto ml-1 w-12 shrink-0 rounded-md px-1 py-0.5 text-center text-[11px] tabular-nums text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
            onClick={() => resetToFit()}
            title={t("lightbox.resetToFit")}
          >
            {formatPercent(viewRef.current?.scale || 1)}
          </button>
        </div>
      )}
    </div>
  );
}
