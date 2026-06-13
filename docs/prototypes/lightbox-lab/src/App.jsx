import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_IMAGE_PATH = "/Users/yiwang/Desktop/Export/印刷/00029 B0000522-2.jpg";
const MAX_SCALE = 8;
const WHEEL_ZOOM_SENSITIVITY = 0.014;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFsUrl(filePath) {
  if (!filePath) return "";
  return `/@fs${encodeURI(filePath)}`;
}

function formatPercent(scale) {
  return `${Math.round(scale * 100)}%`;
}

function formatPixels(size) {
  if (!size) return "Unknown";
  return `${size.width.toLocaleString()} × ${size.height.toLocaleString()}`;
}

function formatMs(value) {
  if (value == null) return "pending";
  return `${Math.round(value)} ms`;
}

export default function App() {
  const [imagePath, setImagePath] = useState(DEFAULT_IMAGE_PATH);
  const [draftPath, setDraftPath] = useState(DEFAULT_IMAGE_PATH);
  const [naturalSize, setNaturalSize] = useState(null);
  const [fitScale, setFitScale] = useState(1);
  const [view, setView] = useState(null);
  const [loadState, setLoadState] = useState("loading");
  const [loadMs, setLoadMs] = useState(null);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const loadStartRef = useRef(performance.now());

  const src = useMemo(() => toFsUrl(imagePath), [imagePath]);
  const scale = view?.scale ?? fitScale;
  const isZoomed = scale > fitScale + 0.001;

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
    setFitScale(fit.scale);
    setView(fit);
  }

  useEffect(() => {
    setNaturalSize(null);
    setFitScale(1);
    setView(null);
    setLoadState("loading");
    setLoadMs(null);
    loadStartRef.current = performance.now();
  }, [imagePath]);

  useEffect(() => {
    if (!dragging) return undefined;

    function handlePointerMove(event) {
      setView((current) => current ? {
        ...current,
        tx: dragRef.current.tx + (event.clientX - dragRef.current.x),
        ty: dragRef.current.ty + (event.clientY - dragRef.current.y),
      } : current);
    }

    function handlePointerUp() {
      setDragging(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!naturalSize || typeof ResizeObserver === "undefined") return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    let frame = null;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextFit = computeFit(naturalSize.width, naturalSize.height);
        setFitScale(nextFit.scale);
        setView((current) => {
          if (!current || current.scale <= fitScale + 0.001) {
            return nextFit;
          }
          if (current.scale < nextFit.scale) {
            return nextFit;
          }
          return current;
        });
      });
    });

    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [fitScale, naturalSize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    function handleWheel(event) {
      event.preventDefault();
      setView((current) => {
        if (!current || !naturalSize) return current;
        const rect = viewport.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
        const nextScale = clamp(current.scale * factor, fitScale, MAX_SCALE);
        if (Math.abs(nextScale - current.scale) < 0.0001) return current;
        const ratio = nextScale / current.scale;
        return {
          scale: nextScale,
          tx: mx - ratio * (mx - current.tx),
          ty: my - ratio * (my - current.ty),
        };
      });
    }

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [fitScale, naturalSize]);

  function handleImageLoad(event) {
    const width = event.currentTarget.naturalWidth;
    const height = event.currentTarget.naturalHeight;
    const nextNaturalSize = { width, height };
    setNaturalSize(nextNaturalSize);
    setLoadState("ready");
    setLoadMs(performance.now() - loadStartRef.current);
    requestAnimationFrame(() => {
      resetToFit(width, height);
    });
  }

  function handleImageError() {
    setLoadState("error");
    setLoadMs(performance.now() - loadStartRef.current);
  }

  function handlePointerDown(event) {
    if (event.button !== 0 || !isZoomed || !view) return;
    event.preventDefault();
    setDragging(true);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: view.tx,
      ty: view.ty,
    };
  }

  function zoomFromCenter(nextScale) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setView((current) => {
      if (!current) return current;
      const rect = viewport.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const clampedScale = clamp(nextScale, fitScale, MAX_SCALE);
      const ratio = clampedScale / current.scale;
      return {
        scale: clampedScale,
        tx: cx - ratio * (cx - current.tx),
        ty: cy - ratio * (cy - current.ty),
      };
    });
  }

  function handleSliderChange(event) {
    zoomFromCenter(Math.exp(Number(event.target.value)));
  }

  function handleDoubleClick(event) {
    if (!view) return;
    if (isZoomed) {
      resetToFit();
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const nextScale = clamp(Math.max(1, fitScale * 2), fitScale, MAX_SCALE);
    const ratio = nextScale / view.scale;
    setView({
      scale: nextScale,
      tx: mx - ratio * (mx - view.tx),
      ty: my - ratio * (my - view.ty),
    });
  }

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", height: "100%", minHeight: 0 }}>
      <header style={{ padding: "18px 20px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "baseline" }}>
            <div>
              <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.42)" }}>
                Lightbox Lab
              </div>
              <div style={{ marginTop: 6, fontSize: 28, fontWeight: 600 }}>Large Image Viewer</div>
            </div>
            <div style={{ display: "grid", gap: 4, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              <div style={{ color: "rgba(255,255,255,0.72)" }}>Scale: {formatPercent(scale)}</div>
              <div style={{ color: "rgba(255,255,255,0.48)" }}>Fit: {formatPercent(fitScale)}</div>
            </div>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!draftPath.trim()) return;
              setImagePath(draftPath.trim());
            }}
            style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}
          >
            <input
              value={draftPath}
              onChange={(event) => setDraftPath(event.target.value)}
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "white",
                borderRadius: 12,
                padding: "12px 14px",
              }}
            />
            <button
              type="submit"
              style={{
                border: "none",
                borderRadius: 12,
                padding: "0 16px",
                background: "#d2a05a",
                color: "#14110d",
                fontWeight: 600,
              }}
            >
              Load
            </button>
          </form>

          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", color: "rgba(255,255,255,0.62)", fontVariantNumeric: "tabular-nums" }}>
            <span>Image: {formatPixels(naturalSize)}</span>
            <span>Status: {loadState}</span>
            <span>Load: {formatMs(loadMs)}</span>
            <span>Zoom model: relative to original pixels</span>
          </div>
        </div>
      </header>

      <main
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onDoubleClick={handleDoubleClick}
        style={{
          position: "relative",
          overflow: "hidden",
          minHeight: 0,
          cursor: isZoomed ? (dragging ? "grabbing" : "grab") : "zoom-in",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.005)), #050505",
        }}
      >
        {loadState === "error" ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "rgba(255,255,255,0.72)" }}>
            Failed to load image
          </div>
        ) : null}

        <img
          key={src}
          ref={imageRef}
          src={src}
          alt=""
          onLoad={handleImageLoad}
          onError={handleImageError}
          draggable={false}
          decoding="async"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transformOrigin: "0 0",
            transform: view ? `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` : "translate(0, 0) scale(1)",
            maxWidth: "none",
            maxHeight: "none",
            userSelect: "none",
            willChange: "transform",
            visibility: loadState === "ready" ? "visible" : "hidden",
          }}
        />

        {loadState === "loading" ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "rgba(255,255,255,0.7)" }}>
            Decoding large JPEG...
          </div>
        ) : null}
      </main>

      <footer
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: "14px 20px 18px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <button
          type="button"
          onClick={() => zoomFromCenter(scale / 1.35)}
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            border: "none",
            background: "rgba(255,255,255,0.08)",
          }}
        >
          -
        </button>
        <input
          type="range"
          min={Math.log(Math.max(fitScale, 0.02))}
          max={Math.log(MAX_SCALE)}
          step={0.01}
          value={Math.log(Math.max(scale, fitScale, 0.02))}
          onChange={handleSliderChange}
          style={{ width: 220 }}
        />
        <button
          type="button"
          onClick={() => zoomFromCenter(scale * 1.35)}
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            border: "none",
            background: "rgba(255,255,255,0.08)",
          }}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => resetToFit()}
          style={{
            border: "1px solid rgba(255,255,255,0.12)",
            background: "transparent",
            color: "rgba(255,255,255,0.74)",
            borderRadius: 999,
            padding: "6px 12px",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatPercent(scale)}
        </button>
      </footer>
    </div>
  );
}
