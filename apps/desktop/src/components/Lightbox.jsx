import { ChevronLeft, ChevronRight, Minus, Pencil, Plus, SwatchBook, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileName, localFileUrl } from "../utils/format";

const MAX_SCALE = 8;
const MIN_SCALE = 0.02;
const WHEEL_ZOOM_SENSITIVITY = 0.014;

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
  const viewportRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const activePointerIdRef = useRef(null);
  const viewRef = useRef(null);
  const fitScaleRef = useRef(1);
  const paintFrameRef = useRef(0);
  const loadStartRef = useRef(0);
  const [naturalSize, setNaturalSize] = useState(null);
  const [fitScale, setFitScale] = useState(1);
  const [displayScale, setDisplayScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [loadState, setLoadState] = useState("loading");
  const [showLoadingText, setShowLoadingText] = useState(false);
  const [sourceIndex, setSourceIndex] = useState(0);

  const clampedIndex = Math.max(0, Math.min(currentIndex, Math.max((items?.length || 1) - 1, 0)));
  const currentItem = items?.[clampedIndex] || null;
  const sources = useMemo(
    () => currentItem
      ? [currentItem.export_path, currentItem.export_preview_path, currentItem.raw_preview_path].filter(Boolean)
      : [],
    [currentItem],
  );
  const imagePath = sources[sourceIndex] || null;
  const title = fileName(currentItem?.export_path) || currentItem?.stem || "Selected asset";

  const metaWidth = Number(currentItem?.export_metadata?.width || 0);
  const metaHeight = Number(currentItem?.export_metadata?.height || 0);
  const scale = displayScale;
  const isZoomed = scale > fitScale + 0.001;
  const canGoPrev = clampedIndex > 0;
  const canGoNext = clampedIndex < (items?.length || 0) - 1;

  function schedulePaint() {
    if (paintFrameRef.current) return;
    paintFrameRef.current = requestAnimationFrame(() => {
      paintFrameRef.current = 0;
      const image = imageRef.current;
      const current = viewRef.current;
      if (!image || !current) return;
      image.style.transform = `translate3d(${current.tx}px, ${current.ty}px, 0) scale(${current.scale})`;
      setDisplayScale(current.scale);
    });
  }

  function applyView(nextView) {
    if (!nextView) return;
    viewRef.current = nextView;
    schedulePaint();
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
    setFitScale(fit.scale);
    setDisplayScale(fit.scale);
    applyView(fit);
  }

  function zoomFromCenter(nextScale) {
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
    });
  }

  // Synchronously reset image display state — must be called in the same
  // batch as any state change that swaps the displayed image so the first
  // render after the swap already has loadState="loading" (image hidden).
  function resetImageState() {
    setNaturalSize(null);
    setFitScale(1);
    setDisplayScale(1);
    fitScaleRef.current = 1;
    viewRef.current = null;
    setLoadState("loading");
    setShowLoadingText(false);
    setSourceIndex(0);
    loadStartRef.current = performance.now();
  }

  // Only show "Loading..." text after a delay to avoid flicker on fast loads
  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = setTimeout(() => setShowLoadingText(true), 400);
    return () => clearTimeout(timer);
  }, [loadState]);

  // Reset image load state when current item changes
  useEffect(() => {
    if (!open) return;
    resetImageState();
  }, [open, currentItem?.asset_id, currentItem?.export_path, currentItem?.export_preview_path, currentItem?.raw_preview_path]);

  useEffect(() => () => {
    if (paintFrameRef.current) cancelAnimationFrame(paintFrameRef.current);
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
        fitScaleRef.current = nextFit.scale;
        setFitScale(nextFit.scale);
        const current = viewRef.current;
        if (!current || current.scale <= fitScaleRef.current + 0.001 || current.scale < nextFit.scale) {
          setDisplayScale(nextFit.scale);
          applyView(nextFit);
        }
      });
    });

    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [fitScale, naturalSize, open]);

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
      });
    }

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [naturalSize, open]);

  if (!open || !currentItem) return null;

  function handleImageLoad(event) {
    const width = event.currentTarget.naturalWidth;
    const height = event.currentTarget.naturalHeight;
    if (!width || !height) return;
    setNaturalSize({ width, height });
    const fit = computeFit(width, height);
    fitScaleRef.current = fit.scale;
    setFitScale(fit.scale);
    setDisplayScale(fit.scale);
    viewRef.current = fit;
    if (imageRef.current) {
      imageRef.current.style.transform = `translate3d(${fit.tx}px, ${fit.ty}px, 0) scale(${fit.scale})`;
      imageRef.current.style.visibility = "visible";
    }
    setLoadState("ready");
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
    if (event.button !== 0 || !isZoomed || !current) return;
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
    if (isZoomed) {
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
    zoomFromCenter(Math.exp(Number(event.target.value)));
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
          {onEdit && (
            <ActionPill
              icon={Pencil}
              label="Edit"
              shortcut="E"
              onClick={(event) => {
                event.stopPropagation();
                onEdit(currentItem);
              }}
            />
          )}
          {onToggleProof && (
            <ActionPill
              icon={SwatchBook}
              label="Proof"
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
            Failed to load image
          </div>
        ) : null}

        {imagePath ? (
          <img
            key={localFileUrl(imagePath)}
            src={localFileUrl(imagePath)}
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

        {loadState === "loading" && showLoadingText ? (
          <div className="absolute inset-0 grid place-items-center text-[14px] text-white/70">
            Loading large image...
          </div>
        ) : null}
      </div>

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
            onClick={() => zoomFromCenter(scale / 1.35)}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <input
            type="range"
            min={Math.log(Math.max(fitScale * 0.25, MIN_SCALE))}
            max={Math.log(MAX_SCALE)}
            step={0.01}
            value={Math.log(Math.max(scale, fitScale, MIN_SCALE))}
            onChange={handleSliderChange}
            className="lightbox-slider pointer-events-auto w-32"
            aria-label="Zoom level"
          />
          <button
            type="button"
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            onClick={() => zoomFromCenter(scale * 1.35)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="pointer-events-auto ml-1 rounded-md px-2 py-0.5 text-[11px] tabular-nums text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
            onClick={() => resetToFit()}
            title="Reset to fit"
          >
            {formatPercent(scale)}
          </button>
      </div>
    </div>
  );
}
