import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Images, FolderPlus, FolderMinus, Folder, ChevronRight, Columns2, LayoutGrid, Eye, Pencil, Trash2 } from "lucide-react";
import { fileName, galleryInfoLabel, buildJustifiedLayout, localFileUrl } from "../utils/format";
import PreviewImage from "./PreviewImage";

const GAP = 12;
const TILE_GAP = 2;
const CAPTION_HEIGHT = 42;
const GRID_ASPECT_RATIO = 4 / 3;
const TILE_ASPECT_RATIO = 3 / 4;
const OVERSCAN_PX = 800;
const VIEW_PADDING = 8;

function buildGridLayout(items, containerWidth, thumbSize, gap, aspectRatio, captionHeight, horizontalPadding) {
  if (!containerWidth) return null;
  const availableWidth = Math.max(containerWidth - horizontalPadding * 2, thumbSize);
  const columnCount = Math.max(1, Math.floor((availableWidth + gap) / (thumbSize + gap)));
  const cellWidth = (availableWidth - gap * (columnCount - 1)) / columnCount;
  const imgHeight = cellWidth / aspectRatio;
  const cardHeight = imgHeight + captionHeight;
  const rowStride = cardHeight + gap;
  const totalRows = Math.ceil(items.length / columnCount);
  const positions = [];
  for (let idx = 0; idx < items.length; idx += 1) {
    const row = Math.floor(idx / columnCount);
    const col = idx % columnCount;
    positions.push({
      item: items[idx],
      left: col * (cellWidth + gap),
      top: row * rowStride,
      width: cellWidth,
      imgHeight,
      captionHeight,
    });
  }
  return {
    totalHeight: Math.max(0, totalRows * rowStride - gap),
    positions,
  };
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

function MenuItem({ icon: Icon, label, shortcut, onClick, children }) {
  const [subOpen, setSubOpen] = useState(false);
  const timerRef = useRef(null);
  const hasSub = !!children;

  function enterItem() {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (hasSub) setSubOpen(true);
  }
  function leaveItem() {
    timerRef.current = setTimeout(() => setSubOpen(false), 200);
  }

  if (hasSub) {
    return (
      <div className="relative" onMouseEnter={enterItem} onMouseLeave={leaveItem}>
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-[12px] text-muted hover:bg-hover hover:text-text"
          onClick={onClick}
        >
          <span className="flex items-center gap-2.5">
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {label}
          </span>
          <ChevronRight className="h-3 w-3 text-muted2" />
        </button>
        {subOpen && (
          <div className="absolute left-full top-0 z-50 ml-1 min-w-[160px] rounded-md border border-border/60 bg-chrome py-1 shadow-menu">
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
      onClick={onClick}
    >
      <span className="flex items-center gap-2.5">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </span>
      {shortcut && <span className="ml-4 text-[10px] text-muted2">{shortcut}</span>}
    </button>
  );
}

function ContextMenu({ x, y, item, assetIds, collections, activeCollectionId, onAddTo, onRemoveFrom, onReveal, onEdit, onDeleteFromCatalog, onCompare, onCollage, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    function handlePointerDown(e) {
      if (e.button !== 0) return;
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleContextMenu(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Clamp menu position to viewport
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let nx = x, ny = y;
    if (x + rect.width > window.innerWidth - 8) nx = x - rect.width;
    if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, y - rect.height);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  const manualFolders = (collections || []).filter((c) => c.kind === "manual");
  const inActiveFolder = !!activeCollectionId;

  return createPortal(
    <div
      ref={(el) => { ref.current = el; menuRef.current = el; }}
      className="fixed z-[12000] min-w-[200px] rounded-md border border-border/60 bg-chrome py-1 shadow-menu"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
    >
      <MenuItem icon={Pencil} label="Edit…" shortcut="E" onClick={() => { onEdit?.(item.export_path); onClose(); }} />
      {assetIds?.length === 2 && (
        <MenuItem icon={Columns2} label="Compare" onClick={() => { onCompare?.(assetIds); onClose(); }} />
      )}
      {assetIds?.length >= 2 && (
        <MenuItem icon={LayoutGrid} label="Collage" onClick={() => { onCollage?.(assetIds); onClose(); }} />
      )}
      <MenuItem icon={Eye} label="Reveal in Finder" shortcut="⌘↵" onClick={() => { onReveal?.(item.export_path); onClose(); }} />
      <MenuItem icon={Trash2} label="Delete from Catalog" onClick={() => { onDeleteFromCatalog?.(); onClose(); }} />

      {(manualFolders.length > 0 || inActiveFolder) && (
        <div className="my-1 border-t border-border/40" />
      )}

      {manualFolders.length > 0 && (
        <MenuItem icon={FolderPlus} label="Add to Folder">
          {manualFolders.map((col) => (
            <button
              key={col.collection_id}
              type="button"
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-muted hover:bg-hover hover:text-text"
              onClick={() => { onAddTo(col.collection_id); onClose(); }}
            >
              <Folder className="h-3.5 w-3.5" />
              {col.name}
            </button>
          ))}
        </MenuItem>
      )}

      {inActiveFolder && (
        <MenuItem icon={FolderMinus} label="Remove from Folder" onClick={() => { onRemoveFrom(); onClose(); }} />
      )}
    </div>,
    document.body,
  );
}

function CardContent({
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
  showVersionBadge = false, // deprecated — kept for compat
}) {
  const title = fileName(item.export_path) || item.stem;
  const totalHeight = height + captionHeight;

  return (
    <button
      type="button"
      onClick={(event) => onSelect(item.asset_id, event)}
      onDoubleClick={() => onOpen?.(item.asset_id)}
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        const payload = onPrepareDragSelection?.(item.asset_id) || {
          assetIds: [item.asset_id],
          exportPaths: [item.export_path],
        };
        const firstAssetId = payload.assetIds?.[0] ?? item.asset_id;
        window.__mediaWorkspaceDraggingAssetId = firstAssetId;
        window.__mediaWorkspaceDraggingAssetIds = payload.assetIds || [firstAssetId];
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-media-workspace-asset", JSON.stringify({
          assetId: firstAssetId,
          assetIds: payload.assetIds || [firstAssetId],
          exportPath: item.export_path,
          exportPaths: payload.exportPaths || [item.export_path],
        }));
        event.dataTransfer.setData("text/plain", JSON.stringify({
          assetId: firstAssetId,
          assetIds: payload.assetIds || [firstAssetId],
          exportPath: item.export_path,
          exportPaths: payload.exportPaths || [item.export_path],
        }));
        const preview = createDragPreview(event.currentTarget, (payload.assetIds || [firstAssetId]).length);
        window.__mediaWorkspaceDragPreviewEl = preview.element;
        event.dataTransfer.setDragImage(preview.element, preview.offsetX, preview.offsetY);
      }}
      onDragEnd={() => {
        window.__mediaWorkspaceDraggingAssetId = null;
        window.__mediaWorkspaceDraggingAssetIds = null;
        if (window.__mediaWorkspaceDragPreviewEl instanceof HTMLElement) {
          window.__mediaWorkspaceDragPreviewEl.remove();
          window.__mediaWorkspaceDragPreviewEl = null;
        }
      }}
      data-gallery-item="true"
      data-asset-id={item.asset_id}
      data-export-path={item.export_path}
      draggable
      className="group absolute text-left focus:outline-none"
      style={{
        width: `${width}px`,
        height: `${totalHeight}px`,
        minWidth: 0,
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
      >
        {item.preview_path || item.export_path ? (
          <PreviewImage
            src={localFileUrl(item.preview_path || item.export_path)}
            alt={item.stem}
            scrollRootRef={containerRef}
            fit={fit}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-muted">No preview</div>
        )}
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
}

export default function Gallery({
  items,
  selectedAssetId,
  selectedAssetIds,
  onSelect,
  onOpen,
  onSelectMany,
  onContextSelect,
  onClearSelection,
  onPrepareDragSelection,
  onLayoutItemsChange,
  loading,
  browserReady,
  loadingMore,
  hasMore,
  onLoadMore,
  displayMode,
  thumbSize,
  totalCount,
  collections,
  activeCollectionId,
  onAddToCollection,
  onRemoveFromCollection,
  onDeleteFromCatalog,
  onEdit,
  onCompare,
  onCollage,
}) {
  const containerRef = useRef(null);
  const scrollRafRef = useRef(0);
  const [contextMenu, setContextMenu] = useState(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [marquee, setMarquee] = useState(null);
  const selectionBaseRef = useRef([]);
  const selectedIdSet = useMemo(() => new Set(selectedAssetIds || []), [selectedAssetIds]);
  const isTileMode = displayMode === "tiles";

  function openContextMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    const contextAssetIds = selectedIdSet.has(item.asset_id)
      ? selectedAssetIds
      : [item.asset_id];
    onContextSelect?.(item.asset_id);
    setContextMenu({ x: event.clientX, y: event.clientY, item, assetIds: contextAssetIds });
  }

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const element = containerRef.current;
    const update = () => {
      setContainerWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
      setScrollTop(element.scrollTop);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayMode, loading, items.length]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !hasMore || loading || loadingMore) return;
    const preloadThreshold = Math.max(element.clientHeight * 5, 4000);
    const remaining = element.scrollHeight - (element.scrollTop + element.clientHeight);
    if (remaining <= preloadThreshold) {
      void onLoadMore?.();
    }
  }, [items.length, hasMore, loading, loadingMore, onLoadMore, scrollTop]);

  useEffect(
    () => () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  function handleScroll(event) {
    const element = event.currentTarget;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      setScrollTop(element.scrollTop);
      setViewportHeight(element.clientHeight);
    });
    if (!hasMore || loading || loadingMore) return;
    const preloadThreshold = Math.max(element.clientHeight * 5, 4000);
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - preloadThreshold) {
      void onLoadMore?.();
    }
  }

  const gridLayout = useMemo(() => {
    return buildGridLayout(items, containerWidth, thumbSize, GAP, GRID_ASPECT_RATIO, CAPTION_HEIGHT, VIEW_PADDING);
  }, [containerWidth, items, thumbSize]);

  const tileLayout = useMemo(() => {
    return buildGridLayout(items, containerWidth, thumbSize, TILE_GAP, TILE_ASPECT_RATIO, 0, 0);
  }, [containerWidth, items, thumbSize]);

  const justifiedLayoutData = useMemo(() => {
    if (!containerWidth) return null;
    const rowHeight = Math.round(thumbSize * 0.66);
    const layout = buildJustifiedLayout(items, Math.max(containerWidth - VIEW_PADDING * 2, 0), rowHeight, GAP, CAPTION_HEIGHT);
    if (!layout.rows.length) return null;
    const positions = layout.rows.flat();
    const rowTops = layout.rows.map((row) => row[0]?.top ?? 0);
    const rowBottoms = layout.rows.map((row) => {
      const maxH = Math.max(...row.map((b) => b.height));
      return (row[0]?.top ?? 0) + maxH + CAPTION_HEIGHT;
    });
    return {
      containerHeight: layout.containerHeight,
      positions,
      rowTops,
      rowBottoms,
    };
  }, [containerWidth, items, thumbSize]);

  const waterfallLayout = useMemo(() => {
    if (!containerWidth) return null;
    const availableWidth = Math.max(containerWidth - VIEW_PADDING * 2, thumbSize);
    const columnCount = Math.max(1, Math.floor((availableWidth + GAP) / (thumbSize + GAP)));
    const colWidth = (availableWidth - GAP * (columnCount - 1)) / columnCount;
    const colHeights = new Array(columnCount).fill(0);
    const positions = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const exportMeta = item.export_metadata || {};
      const w = Number(exportMeta.width || 0);
      const h = Number(exportMeta.height || 0);
      const aspect = w > 0 && h > 0 ? w / h : 1;
      const imgHeight = colWidth / aspect;
      // Pick shortest column
      let minCol = 0;
      for (let c = 1; c < columnCount; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c;
      }
      const top = colHeights[minCol];
      const left = minCol * (colWidth + GAP);
      positions.push({ item, left, top, width: colWidth, imgHeight });
      colHeights[minCol] = top + imgHeight + CAPTION_HEIGHT + GAP;
    }
    const totalHeight = Math.max(0, Math.max(...colHeights) - GAP);
    return { totalHeight, positions };
  }, [containerWidth, items, thumbSize]);

  const layoutItems = useMemo(() => {
    const source = displayMode === "justified"
      ? justifiedLayoutData?.positions
      : displayMode === "tiles"
        ? tileLayout?.positions
      : displayMode === "waterfall"
        ? waterfallLayout?.positions
        : gridLayout?.positions;
    return (source || []).map((entry, index) => ({
      assetId: entry.item.asset_id,
      exportPath: entry.item.export_path,
      index,
      left: entry.left,
      top: entry.top,
      width: entry.width,
      height: (entry.height ?? entry.imgHeight) + (entry.captionHeight ?? CAPTION_HEIGHT),
    }));
  }, [displayMode, gridLayout, justifiedLayoutData, tileLayout, waterfallLayout]);

  useEffect(() => {
    onLayoutItemsChange?.(layoutItems);
  }, [layoutItems, onLayoutItemsChange]);

  const prevSelectedRef = useRef(selectedAssetId);
  useEffect(() => {
    if (prevSelectedRef.current === selectedAssetId) return;
    prevSelectedRef.current = selectedAssetId;
    if (!selectedAssetId || !containerRef.current) return;
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(selectedAssetId) : selectedAssetId;
    const element = containerRef.current.querySelector(`[data-asset-id="${escaped}"]`);
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    const target = layoutItems.find((item) => item.assetId === selectedAssetId);
    if (!target) return;

    const viewportTop = containerRef.current.scrollTop;
    const viewportBottom = viewportTop + containerRef.current.clientHeight;
    const targetTop = target.top;
    const targetBottom = target.top + target.height;
    if (targetTop >= viewportTop && targetBottom <= viewportBottom) return;

    const nextScrollTop = Math.max(0, targetTop - Math.max(24, (containerRef.current.clientHeight - target.height) / 2));
    containerRef.current.scrollTo({ top: nextScrollTop, behavior: "smooth" });
  }, [selectedAssetId, layoutItems]);

  const gridMetrics = useMemo(() => {
    if (displayMode !== "grid" || !gridLayout) return null;
    const visTop = scrollTop - OVERSCAN_PX;
    const visBottom = scrollTop + viewportHeight + OVERSCAN_PX;
    const visibleItems = gridLayout.positions.filter(
      (entry) => entry.top + entry.imgHeight + CAPTION_HEIGHT >= visTop && entry.top <= visBottom,
    );
    return { totalHeight: gridLayout.totalHeight, visibleItems };
  }, [displayMode, gridLayout, scrollTop, viewportHeight]);

  const tileMetrics = useMemo(() => {
    if (displayMode !== "tiles" || !tileLayout) return null;
    const visTop = scrollTop - OVERSCAN_PX;
    const visBottom = scrollTop + viewportHeight + OVERSCAN_PX;
    const visibleItems = tileLayout.positions.filter(
      (entry) => entry.top + entry.imgHeight >= visTop && entry.top <= visBottom,
    );
    return { totalHeight: tileLayout.totalHeight, visibleItems };
  }, [displayMode, tileLayout, scrollTop, viewportHeight]);

  const justifiedMetrics = useMemo(() => {
    if (displayMode !== "justified" || !justifiedLayoutData) return null;
    const visTop = scrollTop - OVERSCAN_PX;
    const visBottom = scrollTop + viewportHeight + OVERSCAN_PX;
    const visibleBoxes = justifiedLayoutData.positions.filter(
      (box) => box.top + box.height + CAPTION_HEIGHT >= visTop && box.top <= visBottom,
    );
    return { containerHeight: justifiedLayoutData.containerHeight, visibleBoxes };
  }, [displayMode, justifiedLayoutData, scrollTop, viewportHeight]);

  const waterfallMetrics = useMemo(() => {
    if (displayMode !== "waterfall" || !waterfallLayout) return null;
    const visTop = scrollTop - OVERSCAN_PX;
    const visBottom = scrollTop + viewportHeight + OVERSCAN_PX;
    const visibleItems = waterfallLayout.positions.filter(
      (p) => p.top + p.imgHeight + CAPTION_HEIGHT >= visTop && p.top <= visBottom,
    );
    return { totalHeight: waterfallLayout.totalHeight, visibleItems };
  }, [displayMode, waterfallLayout, scrollTop, viewportHeight]);

  const metrics = displayMode === "justified" ? justifiedMetrics
    : displayMode === "tiles" ? tileMetrics
      : displayMode === "waterfall" ? waterfallMetrics
        : gridMetrics;

  const totalHeight = metrics
    ? displayMode === "justified" ? Math.ceil(metrics.containerHeight) : metrics.totalHeight
    : 0;

  const visibleItems = metrics
    ? displayMode === "justified" ? metrics.visibleBoxes : metrics.visibleItems
      : [];

  const fit = displayMode === "justified" ? "contain" : "cover";

  function getContentPoint(clientX, clientY) {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return {
      x: clientX - rect.left + container.scrollLeft,
      y: clientY - rect.top + container.scrollTop,
    };
  }

  useEffect(() => {
    if (!marquee) return undefined;

    function updateSelection(nextMarquee) {
      const left = Math.min(nextMarquee.originX, nextMarquee.currentX);
      const top = Math.min(nextMarquee.originY, nextMarquee.currentY);
      const right = Math.max(nextMarquee.originX, nextMarquee.currentX);
      const bottom = Math.max(nextMarquee.originY, nextMarquee.currentY);
      const intersected = layoutItems
        .filter((item) => item.left < right && item.left + item.width > left && item.top < bottom && item.top + item.height > top)
        .sort((a, b) => a.index - b.index)
        .map((item) => item.assetId);
      const nextIds = nextMarquee.additive
        ? Array.from(new Set([...selectionBaseRef.current, ...intersected]))
        : intersected;
      const primaryId = intersected[intersected.length - 1] || (nextMarquee.additive ? selectedAssetId : null);
      onSelectMany?.(nextIds, primaryId, nextMarquee.anchorId || primaryId);
    }

    function handlePointerMove(event) {
      if (!marquee) return;
      const point = getContentPoint(event.clientX, event.clientY);
      const moved =
        marquee.moved ||
        Math.abs(point.x - marquee.originX) > 4 ||
        Math.abs(point.y - marquee.originY) > 4;
      const nextMarquee = { ...marquee, currentX: point.x, currentY: point.y, moved };
      setMarquee(nextMarquee);
      updateSelection(nextMarquee);
    }

    function handlePointerUp() {
      if (!marquee) return;
      if (!marquee.moved && !marquee.additive) {
        onClearSelection?.();
      }
      setMarquee(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [layoutItems, marquee, onClearSelection, onSelectMany, selectedAssetId]);

  if (loading || (!browserReady && !items.length) || (!items.length && totalCount > 0)) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-[13px]">Loading…</span>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-border bg-chrome/50">
          <Images className="h-6 w-6 text-muted2" />
        </div>
        <div className="text-[13px] text-muted">No assets in this view</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest("[data-gallery-item='true']")) {
          return;
        }
        const point = getContentPoint(event.clientX, event.clientY);
        const additive = event.metaKey || event.ctrlKey;
        selectionBaseRef.current = additive ? selectedAssetIds || [] : [];
        setMarquee({
          originX: point.x,
          originY: point.y,
          currentX: point.x,
          currentY: point.y,
          moved: false,
          additive,
          anchorId: selectedAssetId || selectedAssetIds?.[0] || null,
        });
      }}
      className={`h-full select-none overflow-auto bg-app ${isTileMode ? "px-0 py-0" : "px-2 py-2"}`}
    >
      <div className="relative" style={{ height: `${totalHeight}px` }}>
        {visibleItems.map((entry) => {
          const item = entry.item;
          const imgHeight = entry.height ?? entry.imgHeight;
          return (
            <div key={item.asset_id} className="absolute" style={{ left: `${entry.left}px`, top: `${entry.top}px` }}>
              <CardContent
                item={item}
                selected={selectedIdSet.has(item.asset_id)}
                onSelect={onSelect}
                onOpen={onOpen}
                onContextMenu={(event) => openContextMenu(event, item)}
                onPrepareDragSelection={onPrepareDragSelection}
                width={entry.width}
                height={imgHeight}
                fit={fit}
                containerRef={containerRef}
                captionHeight={entry.captionHeight ?? CAPTION_HEIGHT}
                compact={isTileMode}
              />
            </div>
          );
        })}
        {marquee && marquee.moved && (
          <div
            className="pointer-events-none absolute z-30 rounded-sm border border-accent/60 bg-accent/10"
            style={{
              left: `${Math.min(marquee.originX, marquee.currentX)}px`,
              top: `${Math.min(marquee.originY, marquee.currentY)}px`,
              width: `${Math.abs(marquee.currentX - marquee.originX)}px`,
              height: `${Math.abs(marquee.currentY - marquee.originY)}px`,
            }}
          />
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          assetIds={contextMenu.assetIds}
          collections={collections}
          activeCollectionId={activeCollectionId}
          onAddTo={(collectionId) => onAddToCollection?.(collectionId, contextMenu.assetIds || [contextMenu.item.asset_id])}
          onRemoveFrom={() => onRemoveFromCollection?.(activeCollectionId, contextMenu.assetIds || [contextMenu.item.asset_id])}
          onDeleteFromCatalog={() => onDeleteFromCatalog?.(contextMenu.assetIds || [contextMenu.item.asset_id])}
          onReveal={(path) => window.mediaWorkspace?.revealPath?.(path)}
          onEdit={onEdit}
          onCompare={onCompare}
          onCollage={onCollage}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
