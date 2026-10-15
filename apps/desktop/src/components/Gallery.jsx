import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import api from "../api";
import { LoaderCircle, Images } from "lucide-react";
import { useTranslation } from "react-i18next";
import { staleSourceRepairs, thumbnailNeeds } from "./galleryRepair";
import GalleryCard from "./GalleryCard";
import ContextMenu from "./GalleryContextMenu";
import { CAPTION_HEIGHT, buildGalleryGridLayout, buildJustifiedGalleryLayout, buildTileLayout, buildWaterfallLayout } from "./galleryLayout";

const OVERSCAN_PX = 800;

export default function Gallery({
  items,
  selectedAssetId,
  revealAssetRequest,
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
  collections,
  activeCollectionId,
  onAddToCollection,
  onRemoveFromCollection,
  onDeleteFromCatalog,
  onDeleteFromDisk,
  onCopy,
  onCopyPath,
  onCopyName,
  onRefreshFromDisk,
  onEnsureThumbnails,
  importRunning = false,
  onEdit,
  onOpenWith,
  editors,
  onCompare,
  onCollage,
  onAnnotate,
  onFlag,
  onAddTags,
  // Only passed when the grid shows less than the whole library.
  onShowInAllAssets,
}) {
  const { t } = useTranslation("nav");
  const containerRef = useRef(null);
  const scrollRafRef = useRef(0);
  const [contextMenu, setContextMenu] = useState(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // CardContent is memoized; parent callbacks change identity every render
  // (inline closures in App), so route them through a ref behind stable
  // wrappers — otherwise the memo never bails and every poll tick re-renders
  // every visible card.
  const cardHandlersRef = useRef({});
  cardHandlersRef.current = { onSelect, onOpen, onPrepareDragSelection, openContextMenu };
  const stableOnSelect = useCallback((id, event) => cardHandlersRef.current.onSelect?.(id, event), []);
  const stableOnOpen = useCallback((id) => cardHandlersRef.current.onOpen?.(id), []);
  const stableOnPrepareDrag = useCallback((id) => cardHandlersRef.current.onPrepareDragSelection?.(id), []);
  const stableOnContextMenu = useCallback((event, item) => cardHandlersRef.current.openContextMenu?.(event, item), []);

  // On-demand repair: when a preview <img> fails, re-read the source metadata
  // and regenerate its preview, then cache-bust the src. This uses the same
  // full refresh path as the context menu so an early 0-byte import also heals
  // its missing dimensions. Two attempts per asset tolerate one transient
  // startup/protocol error while still preventing an endless repair loop.
  // The budget is per REASON: the stale-metadata pass below re-queues the same
  // assets on every `items` change until its refresh lands, and when it shared
  // one counter with <img> errors it spent that budget during startup — a
  // thumbnail that broke afterwards could then never heal.
  const [previewBust, setPreviewBust] = useState({}); // asset_id -> cache-bust token
  const previewRegenRef = useRef({ attempts: new Map(), pending: new Map(), timer: null });
  // Vite Fast Refresh preserves useRef values. Migrate the pre-refactor shape
  // (`attempted: Set`) in place so a Gallery HMR does not require restarting
  // Electron and cannot crash on `attempts.get(...)`.
  if (!(previewRegenRef.current?.attempts instanceof Map)) {
    const previous = previewRegenRef.current || {};
    const attempts = new Map(
      previous.attempted instanceof Set
        ? [...previous.attempted].map((assetId) => [assetId, 1])
        : [],
    );
    previewRegenRef.current = {
      attempts,
      pending: previous.pending instanceof Map ? previous.pending : new Map(),
      timer: previous.timer || null,
    };
  }
  const flushPreviewRegen = useCallback(async () => {
    const st = previewRegenRef.current;
    st.timer = null;
    if (!st.pending.size) return;
    const batch = new Map(st.pending); // asset_id -> source path
    st.pending.clear();
    const repaired = await onRefreshFromDisk?.([...batch.keys()], { silent: true });
    if (!repaired) return;
    setPreviewBust((cur) => {
      const next = { ...cur };
      const token = Date.now();
      for (const id of batch.keys()) next[id] = token;
      return next;
    });
  }, [onRefreshFromDisk]);
  const queueAssetRepair = useCallback((item, reason = "preview-error") => {
    const st = previewRegenRef.current;
    const id = item?.asset_id;
    const src = item?.image_path || item?.preview_path;
    if (!id || !src) return;
    const budgetKey = `${reason}:${id}`;
    const attempts = st.attempts.get(budgetKey) || 0;
    if (attempts >= 2) return;
    st.attempts.set(budgetKey, attempts + 1);
    st.pending.set(id, src);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(flushPreviewRegen, 400); // batch a page's failures
  }, [flushPreviewRegen]);
  const stableOnPreviewError = queueAssetRepair;
  // The thumbnail loaded: hand the asset its repair budget back, so a preview
  // that breaks later in the session is treated as a new failure.
  const stableOnPreviewLoaded = useCallback((item) => {
    if (item?.asset_id) previewRegenRef.current.attempts.delete(`preview-error:${item.asset_id}`);
  }, []);

  // A partial Lightroom overwrite can still produce a valid JPEG preview, so
  // the browser never emits an image error. The browse response compares the
  // live source stat with the catalog; missing metadata is another legacy
  // signal. Repair either case as soon as the card enters the loaded page.
  useEffect(() => {
    const st = previewRegenRef.current;
    const { stale, healthyIds } = staleSourceRepairs(items);
    for (const item of stale) queueAssetRepair(item, "stale-source");
    // Healthy again: return the budget, or a second bout of staleness later
    // in the session (an external edit, a partial re-export) is refused.
    for (const id of healthyIds) st.attempts.delete(`stale-source:${id}`);
  }, [items, queueAssetRepair]);

  // Thumbnails that are missing, not broken (an import cancelled before its
  // thumbnail pass, a thumbnail that failed): made where missing, in the
  // background. Not while an import runs: its own pass is on the way. This
  // runs when a browse lands, never when the import ends, so it sees what the
  // import made. Two passes an asset, as for the repairs above.
  const thumbnailsRef = useRef({ attempts: new Map(), inFlight: new Set() });
  const importRunningRef = useRef(importRunning);
  importRunningRef.current = importRunning;
  const ensureThumbnailsRef = useRef(onEnsureThumbnails);
  ensureThumbnailsRef.current = onEnsureThumbnails;
  useEffect(() => {
    const { attempts, inFlight } = thumbnailsRef.current;
    const { awaitingIds, settledIds } = thumbnailNeeds(items);
    for (const id of settledIds) attempts.delete(id);
    if (importRunningRef.current) return;
    const ids = awaitingIds.filter((id) => !inFlight.has(id) && (attempts.get(id) || 0) < 2);
    if (!ids.length) return;
    for (const id of ids) {
      attempts.set(id, (attempts.get(id) || 0) + 1);
      inFlight.add(id);
    }
    void Promise.resolve(ensureThumbnailsRef.current?.(ids))
      .finally(() => { for (const id of ids) inFlight.delete(id); });
  }, [items]);

  const refreshFromDisk = useCallback(async (assetIds) => {
    const result = await onRefreshFromDisk?.(assetIds);
    if (!result) return;
    const token = Date.now();
    setPreviewBust((current) => {
      const next = { ...current };
      for (const assetId of assetIds || []) next[assetId] = token;
      return next;
    });
  }, [onRefreshFromDisk]);

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

  const gridLayout = useMemo(() => buildGalleryGridLayout(items, containerWidth, thumbSize), [containerWidth, items, thumbSize]);
  const tileLayout = useMemo(() => buildTileLayout(items, containerWidth, thumbSize), [containerWidth, items, thumbSize]);
  const justifiedLayoutData = useMemo(() => buildJustifiedGalleryLayout(items, containerWidth, thumbSize), [containerWidth, items, thumbSize]);
  const waterfallLayout = useMemo(() => buildWaterfallLayout(items, containerWidth, thumbSize), [containerWidth, items, thumbSize]);

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
      imagePath: entry.item.image_path,
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

  const prevSelectedRef = useRef(null);
  const handledRevealRef = useRef(null);
  useEffect(() => {
    const explicitReveal = revealAssetRequest?.assetId === selectedAssetId
      && handledRevealRef.current !== revealAssetRequest;
    if (prevSelectedRef.current === selectedAssetId && !explicitReveal) {
      if (layoutItems.some((item) => item.assetId === selectedAssetId)) return;
      prevSelectedRef.current = null;
    }
    if (!selectedAssetId) { prevSelectedRef.current = null; return; }
    if (!containerRef.current) return;
    // "Show in All Assets" centres the photo even when it is already in view:
    // the point is to see what comes before and after it.
    const center = explicitReveal && !!revealAssetRequest.center;
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(selectedAssetId) : selectedAssetId;
    const element = containerRef.current.querySelector(`[data-asset-id="${escaped}"]`);
    if (element instanceof HTMLElement && !center) {
      prevSelectedRef.current = selectedAssetId;
      handledRevealRef.current = revealAssetRequest;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    const target = layoutItems.find((item) => item.assetId === selectedAssetId);
    if (!target) return;
    // Mark handled only once the target exists. Selecting an unloaded version
    // comes before its page/layout; retry when that layout arrives.
    prevSelectedRef.current = selectedAssetId;
    handledRevealRef.current = revealAssetRequest;

    const viewportTop = containerRef.current.scrollTop;
    const viewportBottom = viewportTop + containerRef.current.clientHeight;
    const targetTop = target.top;
    const targetBottom = target.top + target.height;
    if (!center && targetTop >= viewportTop && targetBottom <= viewportBottom) return;

    const nextScrollTop = Math.max(0, targetTop - Math.max(24, (containerRef.current.clientHeight - target.height) / 2));
    // A jump into a different grid has nothing to animate from, and a smooth
    // scroll across thousands of rows would load every thumbnail on the way.
    containerRef.current.scrollTo({ top: nextScrollTop, behavior: center ? "auto" : "smooth" });
  }, [selectedAssetId, layoutItems, revealAssetRequest]);

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

  // Show spinner only when there's truly nothing to render. If `items` already
  // has cached data (e.g. switching back to a previously-loaded status), keep
  // showing it and let the new data swap in seamlessly — avoids the
  // grid → spinner → grid double-flicker when navigating between views.
  if (!items.length && (loading || !browserReady)) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-[13px]">{t("gallery.loading")}</span>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-border bg-chrome/50">
          <Images className="h-6 w-6 text-muted2" />
        </div>
        <div className="text-[13px] text-muted">{t("gallery.noAssets")}</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // React portals (the context menu) bubble events through the React tree,
        // not the DOM tree — so a click inside the portaled menu would otherwise
        // reach here and start a marquee that clears the selection on pointerup.
        // Ignore any pointerdown whose real DOM target is outside this container.
        if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
          return;
        }
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
      data-testid="gallery-scroll"
      className={`h-full select-none overflow-x-hidden overflow-y-auto bg-app ${isTileMode ? "px-0 py-0" : "px-2 py-2"}`}
      style={{ scrollbarGutter: "stable" }}
    >
      <div className="relative" style={{ height: `${totalHeight}px` }}>
        {visibleItems.map((entry) => {
          const item = entry.item;
          const imgHeight = entry.height ?? entry.imgHeight;
          return (
            <div key={item.asset_id} className="absolute" style={{ left: `${entry.left}px`, top: `${entry.top}px` }}>
              <GalleryCard
                item={item}
                selected={selectedIdSet.has(item.asset_id)}
                onSelect={stableOnSelect}
                onOpen={stableOnOpen}
                onContextMenu={stableOnContextMenu}
                onPrepareDragSelection={stableOnPrepareDrag}
                width={entry.width}
                height={imgHeight}
                fit={fit}
                containerRef={containerRef}
                captionHeight={entry.captionHeight ?? CAPTION_HEIGHT}
                compact={isTileMode}
                bustToken={previewBust[item.asset_id]}
                importRunning={importRunning}
                onPreviewError={stableOnPreviewError}
                onPreviewLoaded={stableOnPreviewLoaded}
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
          onDeleteFromDisk={() => onDeleteFromDisk?.(contextMenu.assetIds || [contextMenu.item.asset_id])}
          onCopy={() => onCopy?.(contextMenu.assetIds || [contextMenu.item.asset_id])}
          onCopyPath={() => onCopyPath?.(contextMenu.assetIds || [contextMenu.item.asset_id])}
          onCopyName={() => onCopyName?.(contextMenu.assetIds || [contextMenu.item.asset_id])}
          onRefreshFromDisk={refreshFromDisk}
          onReveal={(path) => api.revealPath(path)}
          onShowInAllAssets={onShowInAllAssets}
          editors={editors}
          onOpenWith={(appPath) => onOpenWith?.(contextMenu.assetIds || [contextMenu.item.asset_id], appPath)}
          onEdit={onEdit}
          onCompare={onCompare}
          onCollage={onCollage}
          onAnnotate={(ids, opts) => onAnnotate?.(ids, opts)}
          onFlag={onFlag ? (flag) => onFlag(flag, contextMenu.assetIds || [contextMenu.item.asset_id]) : undefined}
          onAddTags={onAddTags ? () => onAddTags(contextMenu.assetIds || [contextMenu.item.asset_id]) : undefined}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
