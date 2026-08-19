import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Loader2, X, ChevronDown, Folder, Images, LayoutGrid } from "lucide-react";
import { localFileUrl } from "../utils/format";
import CollageCanvas from "./collage/CollageCanvas";
import CollagePanel from "./collage/CollagePanel";
import BatchPanel from "./collage/BatchPanel";
import { TemplateGrid } from "./collage/PanelControls";
import { getTemplatesForCount } from "./collage/collageTemplates";
import { computeGroups, orderImages, MAX_TEMPLATE_COUNT } from "./collage/collageBatch";

const PANEL_WIDTH = 300;
const PAGE_SIZE = 48;
// Batch page preview width: landscape/square pages are 320px wide; portrait
// pages shrink so their height matches a square page's.
const BATCH_PAGE_WIDTH = (ratio) => (ratio >= 1 ? 320 : Math.round(320 * ratio));
const PICKER_COLUMNS = 4;
const PICKER_GAP = 4;
const PICKER_HORIZONTAL_PADDING = 24;
const PICKER_OVERSCAN_PX = 600;
const PICKER_PRELOAD_PX = 1200;

function builtInSources(summary) {
  const items = [{ id: "all", labelKey: "filterAll" }];
  if (Number(summary?.rated_count ?? 0) > 0) {
    items.push({ id: "rated", labelKey: "filterRated" });
  }
  if (Number(summary?.raw_assets ?? 0) > 0) {
    items.push({ id: "matched", labelKey: "filterMatched" });
  }
  return items;
}

function ImagePickerModal({ excludeIds, collections, summary, onAdd, onClose }) {
  const { t } = useTranslation("collage");
  const scrollRef = useRef(null);
  const requestIdRef = useRef(0);
  const [source, setSource] = useState("all");
  const [sourceItems, setSourceItems] = useState([]);
  const [selectedItemsById, setSelectedItemsById] = useState(() => new Map());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  const manualCollections = useMemo(
    () => (collections || []).filter((c) => c.kind === "manual"),
    [collections],
  );

  const builtInItems = useMemo(() => builtInSources(summary), [summary]);

  const activeLabel = useMemo(() => {
    const built = builtInItems.find((s) => s.id === source);
    if (built) return t(built.labelKey);
    const col = manualCollections.find((c) => c.collection_id === source);
    return col?.name || t("filterAll");
  }, [source, builtInItems, manualCollections, t]);

  const sourceTotal = useMemo(() => {
    const totalSummary = summary || {};
    if (source === "all") return Number(totalSummary.image_assets || 0);
    if (source === "matched") return Number(totalSummary.confirmed_matches || 0);
    if (source === "rated") return Number(totalSummary.rated_count || 0);
    const col = manualCollections.find((c) => c.collection_id === source);
    return Number(col?.item_count || 0);
  }, [source, summary, manualCollections]);

  const loadPage = useCallback(async ({ append = false } = {}) => {
    if (append && (loading || loadingMore || !hasMore)) return;
    const nextOffset = append ? offset : 0;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const isCollection = !builtInItems.some((s) => s.id === source);
      const batch = isCollection
        ? await window.mediaWorkspace?.browseCollection?.(source, {
          limit: PAGE_SIZE,
          offset: nextOffset,
        })
        : await window.mediaWorkspace?.browseImages?.({
          status: source,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
      if (requestIdRef.current !== requestId) return;
      const nextBatch = batch || [];
      setSourceItems((current) => (append ? [...current, ...nextBatch] : nextBatch));
      setOffset(nextOffset + nextBatch.length);
      setHasMore(nextBatch.length === PAGE_SIZE);
    } catch (err) {
      console.error("[Collage] failed to load source items:", err);
      if (requestIdRef.current === requestId) setHasMore(false);
    } finally {
      if (requestIdRef.current === requestId) {
        if (append) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    }
  }, [builtInItems, hasMore, loading, loadingMore, offset, source]);

  useEffect(() => {
    requestIdRef.current += 1;
    setSourceItems([]);
    setSelectedItemsById(new Map());
    setOffset(0);
    setHasMore(true);
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void loadPage({ append: false });
  }, [source]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const update = () => {
      setViewportWidth(Math.max(0, element.clientWidth - PICKER_HORIZONTAL_PADDING));
      setViewportHeight(element.clientHeight);
      setScrollTop(element.scrollTop);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showDropdown]);

  // Items already on the canvas stay VISIBLE but disabled (grayed + check) —
  // hiding them read as "photos missing" rather than "already added".
  const usedIds = useMemo(
    () => (excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])),
    [excludeIds]
  );
  const items = sourceItems;

  const selectedItems = useMemo(() => Array.from(selectedItemsById.values()), [selectedItemsById]);
  const selectedIds = useMemo(() => new Set(selectedItemsById.keys()), [selectedItemsById]);

  const toggleSelected = useCallback((item) => {
    if (usedIds.has(item.asset_id)) return;
    setSelectedItemsById((current) => {
      const next = new Map(current);
      if (next.has(item.asset_id)) {
        next.delete(item.asset_id);
      } else {
        next.set(item.asset_id, item);
      }
      return next;
    });
  }, [usedIds]);

  const addSelected = useCallback(() => {
    if (!selectedItems.length) return;
    onAdd(selectedItems);
  }, [onAdd, selectedItems]);

  const itemSize = useMemo(() => {
    if (!viewportWidth) return 0;
    return Math.max(0, (viewportWidth - PICKER_GAP * (PICKER_COLUMNS - 1)) / PICKER_COLUMNS);
  }, [viewportWidth]);

  const rowStride = itemSize + PICKER_GAP;
  const totalRows = Math.ceil(items.length / PICKER_COLUMNS);
  const totalHeight = itemSize ? Math.max(0, totalRows * itemSize + Math.max(0, totalRows - 1) * PICKER_GAP) : 0;

  const visibleItems = useMemo(() => {
    if (!itemSize || !viewportHeight) return [];
    const startRow = Math.max(0, Math.floor((scrollTop - PICKER_OVERSCAN_PX) / rowStride));
    const endRow = Math.min(
      totalRows,
      Math.ceil((scrollTop + viewportHeight + PICKER_OVERSCAN_PX) / rowStride),
    );
    return items.slice(startRow * PICKER_COLUMNS, endRow * PICKER_COLUMNS).map((item, localIndex) => {
      const index = startRow * PICKER_COLUMNS + localIndex;
      const row = Math.floor(index / PICKER_COLUMNS);
      const col = index % PICKER_COLUMNS;
      return {
        item,
        left: col * rowStride,
        top: row * rowStride,
      };
    });
  }, [itemSize, items, rowStride, scrollTop, totalRows, viewportHeight]);

  const loadMoreIfNeeded = useCallback(() => {
    if (!hasMore || loading || loadingMore || !viewportHeight) return;
    const remaining = totalHeight - (scrollTop + viewportHeight);
    if (remaining <= PICKER_PRELOAD_PX) {
      void loadPage({ append: true });
    }
  }, [hasMore, loadPage, loading, loadingMore, scrollTop, totalHeight, viewportHeight]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportHeight(el.clientHeight);
  }, []);

  useEffect(() => {
    loadMoreIfNeeded();
  }, [items.length, loadMoreIfNeeded]);

  const countLabel = sourceTotal > 0 ? sourceTotal : sourceItems.length;
  const showingTotalLabel = sourceTotal > 0 ? sourceTotal : hasMore ? `${sourceItems.length}+` : sourceItems.length;

  return (
    <div className="fixed inset-0 z-[10210] flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
      <div className="flex h-[70vh] w-full max-w-[500px] flex-col overflow-hidden rounded-xl border border-border/60 bg-panel text-text shadow-overlay">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              {t("addImagesTitle")}
              <span className="ml-2 text-muted2">{loading ? "…" : countLabel}</span>
            </div>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted2 hover:bg-hover hover:text-text"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Source selector */}
        <div className="relative px-3 pb-2" ref={dropdownRef}>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg bg-app px-3 py-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-text"
            onClick={() => setShowDropdown((v) => !v)}
          >
            <Images className="h-3 w-3 text-muted2" />
            {activeLabel}
            <ChevronDown className="ml-0.5 h-3 w-3 text-muted2" />
          </button>

          {showDropdown && (
            <div className="absolute left-3 top-full z-10 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-border/60 bg-chrome py-1 shadow-menu">
              {builtInItems.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={[
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors",
                    source === s.id
                      ? "bg-selected text-text"
                      : "text-muted hover:bg-hover hover:text-text",
                  ].join(" ")}
                  onClick={() => { setSource(s.id); setShowDropdown(false); }}
                >
                  <Images className="h-3.5 w-3.5 shrink-0 text-muted2" />
                  {t(s.labelKey)}
                </button>
              ))}

              {manualCollections.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-border/60" />
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted2">
                    {t("folders")}
                  </div>
                  {manualCollections.map((col) => (
                    <button
                      key={col.collection_id}
                      type="button"
                      className={[
                        "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors",
                        source === col.collection_id
                          ? "bg-selected text-text"
                          : "text-muted hover:bg-hover hover:text-text",
                      ].join(" ")}
                      onClick={() => { setSource(col.collection_id); setShowDropdown(false); }}
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted2" />
                      {col.name}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Image grid */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2" onScroll={handleScroll}>
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted2">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted2">{t("noMore")}</div>
          ) : (
            <div className="relative" style={{ height: `${totalHeight}px` }}>
              {visibleItems.map(({ item, left, top }) => {
                const src = item.preview_path || item.image_preview_path || item.raw_preview_path;
                const selected = selectedIds.has(item.asset_id);
                const used = usedIds.has(item.asset_id);
                return (
                  <button
                    key={item.asset_id}
                    type="button"
                    disabled={used}
                    title={used ? t("alreadyAdded") : undefined}
                    className={[
                      "group absolute overflow-hidden rounded-md bg-panel2 transition",
                      used
                        ? "cursor-default"
                        : selected
                          ? "ring-2 ring-[rgb(var(--accent-color))]"
                          : "hover:ring-2 hover:ring-[rgb(var(--accent-color)/0.6)]",
                    ].join(" ")}
                    style={{
                      left: `${left}px`,
                      top: `${top}px`,
                      width: `${itemSize}px`,
                      height: `${itemSize}px`,
                    }}
                    onClick={() => toggleSelected(item)}
                  >
                    {src ? (
                      <img
                        src={localFileUrl(src)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className={[
                          "absolute inset-0 h-full w-full object-cover",
                          used ? "opacity-40 saturate-50" : "",
                        ].join(" ")}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-app text-[10px] text-muted2">{t("noPreview")}</div>
                    )}
                    <span
                      className={[
                        "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-black shadow-sm transition",
                        used || selected
                          ? "border-[rgb(var(--accent-color))] bg-[rgb(var(--accent-color))] opacity-100"
                          : "border-text/55 bg-app/70 opacity-75 group-hover:opacity-100",
                      ].join(" ")}
                    >
                      {used || selected ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex h-12 shrink-0 items-center justify-between border-t border-border/60 px-3">
          <div className="flex items-center gap-2 text-[11px] text-muted2">
            {loadingMore ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {items.length > 0 ? `${items.length} / ${showingTotalLabel}` : null}
          </div>
          <button
            type="button"
            className={[
              "inline-flex h-8 items-center justify-center rounded-md px-3 text-[12px] font-medium transition-colors",
              selectedItems.length
                ? "bg-[rgb(var(--accent-color))] text-black hover:brightness-110"
                : "cursor-default bg-app text-muted2",
            ].join(" ")}
            disabled={!selectedItems.length}
            onClick={addSelected}
          >
            Add{selectedItems.length ? ` ${selectedItems.length}` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CollageOverlay({ open, items, collections, summary, onClose, onExportComplete }) {
  const { t } = useTranslation("collage");
  const canvasRef = useRef(null);
  const [images, setImages] = useState([]);
  const [template, setTemplate] = useState(null);
  const [canvasRatio, setCanvasRatio] = useState(1);
  const [gap, setGap] = useState(4);
  const [padding, setPadding] = useState(0);
  const [borderRadius, setBorderRadius] = useState(0);
  const [bgColor, setBgColor] = useState("#000000");
  const [exportWidth, setExportWidth] = useState(3000);
  const [exporting, setExporting] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [replaceIndex, setReplaceIndex] = useState(-1);
  const [selectedCellIdx, setSelectedCellIdx] = useState(-1);
  const [selectedCellState, setSelectedCellState] = useState({ pan: { x: 0, y: 0 }, zoom: 1 });

  // Batch mode
  const [mode, setMode] = useState("single");
  const [groupSize, setGroupSize] = useState(4);
  const [orderBy, setOrderBy] = useState("selection");
  const [remainderMode, setRemainderMode] = useState("own");
  const [batchTemplateId, setBatchTemplateId] = useState(null);
  const [pageOverrides, setPageOverrides] = useState({});
  const [layoutPopoverPage, setLayoutPopoverPage] = useState(-1);
  const [namePrefix, setNamePrefix] = useState("collage");
  const [exportProgress, setExportProgress] = useState(null);
  const batchPageRefs = useRef([]);
  // Cross-page drag: { fromPage, fromCell, item, x, y, target: {page, cell} | null }
  const [cellDrag, setCellDrag] = useState(null);
  const cellDragRef = useRef(null);
  // Pan/zoom per image, shared by every batch page canvas (keyed by asset).
  const batchCellStates = useRef(new Map());

  // Assets whose HD preview we already asked for in THIS collage session.
  // Reset on every open: the overlay stays mounted across sessions and the
  // incoming items come from the gallery cache (no HD path even when the file
  // exists), so a stale "attempted" set would leave those cells on the 512px
  // thumbnail forever — the exported collage then has some cells blurry.
  const hdAttemptedRef = useRef(new Set());

  // Initialize from items prop
  useEffect(() => {
    if (!open || !items?.length) return;
    hdAttemptedRef.current = new Set();
    setImages(items);
    const templates = getTemplatesForCount(items.length);
    setTemplate(templates[0] || null);
    // Single mode can only lay out up to MAX_TEMPLATE_COUNT images on one
    // canvas; anything beyond that must be split, so default to batch.
    setMode(items.length > MAX_TEMPLATE_COUNT ? "batch" : "single");
    setPageOverrides({});
    setLayoutPopoverPage(-1);
  }, [open, items]);

  // ── Batch derivations ──
  const orderedImages = useMemo(() => orderImages(images, orderBy), [images, orderBy]);
  const groups = useMemo(
    () => computeGroups(orderedImages, groupSize, remainderMode),
    [orderedImages, groupSize, remainderMode],
  );

  // Keep the global batch template valid for the current group size
  useEffect(() => {
    const pool = getTemplatesForCount(groupSize);
    if (!pool.some((tp) => tp.id === batchTemplateId)) {
      setBatchTemplateId(pool[0]?.id || null);
    }
  }, [groupSize, batchTemplateId]);

  // Per-page layouts are indexed by page; anything that changes the page
  // structure (image count, grouping) invalidates them. Reordering (drag swap,
  // sort) and the HD-preview patch keep the structure, so they don't.
  useEffect(() => {
    setPageOverrides({});
    setLayoutPopoverPage(-1);
  }, [images.length, groupSize, remainderMode]);

  // Shared batch pan/zoom store: drop entries for images no longer in the pool.
  useEffect(() => {
    const live = new Set(images.map((img) => img.asset_id || img.image_path));
    for (const key of batchCellStates.current.keys()) {
      if (!live.has(key)) batchCellStates.current.delete(key);
    }
  }, [images]);

  // Panel layout = every page. Picking it also clears per-page tweaks, so the
  // model stays "panel sets all, card sets one" with no override bookkeeping.
  function applyLayoutToAllPages(tmplId) {
    setBatchTemplateId(tmplId);
    setPageOverrides({});
  }

  function templateForPage(pageIdx, group) {
    const pool = getTemplatesForCount(group.length);
    const overrideId = pageOverrides[pageIdx];
    if (overrideId) {
      const found = pool.find((tp) => tp.id === overrideId);
      if (found) return found;
    }
    return pool.find((tp) => tp.id === batchTemplateId) || pool[0] || null;
  }

  // Lazily generate 2000px HD previews for cells that lack one, so the canvas
  // and export render from HD rather than the 512px thumbnail. HD generation is
  // off by default catalog-wide; here we generate just for the cells in use and
  // patch the HD path back in once ready. Tracked per asset (hdAttemptedRef)
  // so it runs once per session.
  useEffect(() => {
    if (!open || !images.length) return undefined;
    const targets = images.filter(
      (img) => img?.asset_id && img?.image_path
        && !img.image_preview_hd_path && !img.preview_hd_path
        && !hdAttemptedRef.current.has(img.asset_id),
    );
    if (!targets.length) return undefined;
    let cancelled = false;
    (async () => {
      for (const img of targets) hdAttemptedRef.current.add(img.asset_id);
      try {
        await window.mediaWorkspace?.ensureHdPreviews?.(targets.map((t) => t.image_path));
        const details = await Promise.all(
          targets.map((t) => Promise.resolve(window.mediaWorkspace?.getAssetDetailById?.(t.asset_id)).catch(() => null)),
        );
        if (cancelled) return;
        const hdById = new Map();
        for (const d of details) {
          if (d?.asset_id && d.image_preview_hd_path) hdById.set(d.asset_id, d.image_preview_hd_path);
        }
        if (!hdById.size) return;
        setImages((prev) => prev.map((img) =>
          hdById.has(img.asset_id) ? { ...img, image_preview_hd_path: hdById.get(img.asset_id) } : img,
        ));
      } catch (err) {
        console.warn("[Collage] HD preview generation failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [open, images]);

  // Auto-select template when image count changes
  useEffect(() => {
    if (!images.length) return;
    const templates = getTemplatesForCount(images.length);
    // Keep current template if still valid for count
    if (template && templates.some((t) => t.id === template.id)) return;
    setTemplate(templates[0] || null);
  }, [images.length]);

  // Keyboard
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") {
        if (showPicker) {
          setShowPicker(false);
        } else if (mode === "batch" && layoutPopoverPage >= 0) {
          setLayoutPopoverPage(-1);
        } else {
          onClose?.();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, showPicker, onClose, mode, layoutPopoverPage]);

  async function handleExport() {
    if (!canvasRef.current) return;
    setExporting(true);
    try {
      const blob = await canvasRef.current.exportToBlob(exportWidth);
      if (!blob) return;

      // Derive filename from source images
      const sourceAssetIds = images.map((img) => img.asset_id).filter(Boolean);
      const firstStem = images[0]?.stem || images[0]?.image_path?.split("/").pop()?.replace(/\.[^.]+$/, "") || "collage";
      const allSameSet = images.length > 1 && images.every((img) => img.resource_set_id && img.resource_set_id === images[0].resource_set_id);
      const baseStem = allSameSet ? (images[0].primary_stem || firstStem) : firstStem;
      const defaultName = `${baseStem}_collage.jpg`;

      const savePath = await window.mediaWorkspace?.pickSavePath?.({
        defaultPath: defaultName,
        filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }, { name: "PNG", extensions: ["png"] }],
      });
      if (!savePath) return;

      const buffer = await blob.arrayBuffer();
      const firstSrc = images[0]?.image_path || null;
      await window.mediaWorkspace?.saveImage?.(savePath, buffer, firstSrc);
      await window.mediaWorkspace?.quickRegister?.(savePath, firstSrc, sourceAssetIds);
      onExportComplete?.(savePath);
    } catch (err) {
      console.error("[Collage] export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  // Batch cells reference items from the ordered/grouped view — map them back
  // to their position in the flat images pool before mutating it.
  function imageIndexOf(item) {
    if (!item) return -1;
    const byIdentity = images.indexOf(item);
    if (byIdentity >= 0) return byIdentity;
    return images.findIndex((img) => img.asset_id && img.asset_id === item.asset_id);
  }

  function beginReplace(item) {
    const idx = imageIndexOf(item);
    if (idx < 0) return;
    setReplaceIndex(idx);
    setShowPicker(true);
  }

  function removeBatchImage(item) {
    const idx = imageIndexOf(item);
    if (idx < 0) return;
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }

  // ── Cross-page drag & swap ──
  // Same gesture family as single mode: dragging inside a cell pans the photo
  // (the canvas handles that); dragging OUT of the cell becomes a swap —
  // releasing over any cell on any page swaps the two images. Swapping is a
  // reorder of the flat pool, so grouping re-derives and both pages update.
  function swapImages(a, b) {
    if (!a || !b || a === b) return;
    // A custom sort would immediately undo the swap — bake the current order
    // in and switch to manual ordering first.
    const base = orderBy === "selection" ? images : orderedImages;
    const ia = base.indexOf(a);
    const ib = base.indexOf(b);
    if (ia < 0 || ib < 0) return;
    const next = [...base];
    [next[ia], next[ib]] = [next[ib], next[ia]];
    if (orderBy !== "selection") setOrderBy("selection");
    setImages(next);
  }

  function findDropTarget(clientX, clientY) {
    const refs = batchPageRefs.current;
    for (let p = 0; p < groups.length; p++) {
      const cell = refs[p]?.hitTestClient?.(clientX, clientY) ?? -1;
      if (cell >= 0 && cell < groups[p].length) return { page: p, cell };
    }
    return null;
  }

  // Called by a page canvas once a drag leaves its source cell (drags that
  // stay inside the cell are pans, handled by the canvas itself).
  function beginCellDrag(pageIdx, cellIdx, e) {
    const item = groups[pageIdx]?.[cellIdx];
    if (!item) return;
    e.preventDefault();
    const start = { fromPage: pageIdx, fromCell: cellIdx, item, x: e.clientX, y: e.clientY, moved: true, target: findDropTarget(e.clientX, e.clientY) };
    if (start.target && start.target.page === pageIdx && start.target.cell === cellIdx) start.target = null;
    cellDragRef.current = start;
    setCellDrag(start);
    setLayoutPopoverPage(-1);

    const onMove = (ev) => {
      const d = cellDragRef.current;
      if (!d) return;
      const target = findDropTarget(ev.clientX, ev.clientY);
      const sameAsSource = target && target.page === d.fromPage && target.cell === d.fromCell;
      cellDragRef.current = { ...d, x: ev.clientX, y: ev.clientY, target: sameAsSource ? null : target };
      setCellDrag(cellDragRef.current);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const d = cellDragRef.current;
      cellDragRef.current = null;
      setCellDrag(null);
      if (d?.moved && d.target) {
        const other = groups[d.target.page]?.[d.target.cell];
        swapImages(d.item, other);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  async function handleBatchExport() {
    if (!groups.length || exporting) return;
    const dir = await window.mediaWorkspace?.pickDirectory?.();
    if (!dir) return;
    setExporting(true);
    setExportProgress({ done: 0, total: groups.length });
    const prefix = (namePrefix || "collage").replace(/[/\\:]/g, "_").trim() || "collage";
    let exportedAny = false;
    let failed = 0;
    try {
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        try {
          const blob = await batchPageRefs.current[i]?.exportToBlob?.(exportWidth);
          if (!blob) { failed += 1; continue; }
          const name = `${prefix}_${String(i + 1).padStart(2, "0")}.jpg`;
          const savePath = `${dir}/${name}`;
          const buffer = await blob.arrayBuffer();
          const firstSrc = group[0]?.image_path || null;
          const sourceAssetIds = group.map((g) => g.asset_id).filter(Boolean);
          await window.mediaWorkspace?.saveImage?.(savePath, buffer, firstSrc);
          await window.mediaWorkspace?.quickRegister?.(savePath, firstSrc, sourceAssetIds);
          exportedAny = true;
        } catch (err) {
          failed += 1;
          console.error(`[Collage] batch export page ${i + 1} failed:`, err);
        }
        setExportProgress({ done: i + 1, total: groups.length });
      }
      if (failed > 0) console.warn(`[Collage] batch export: ${failed}/${groups.length} pages failed`);
      if (exportedAny) onExportComplete?.(dir);
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }

  // Exclude IDs for picker
  const excludeIds = useMemo(() => new Set(images.map((img) => img.asset_id)), [images]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10200] flex flex-col bg-app text-text">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-chrome px-4">
        <div className="flex items-center gap-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("title")}</div>
          <div className="flex rounded-[7px] bg-app p-0.5">
            {[
              { id: "single", label: t("singleMode") },
              { id: "batch", label: t("batchMode") },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                className={[
                  "rounded-[5px] px-3 py-0.5 text-[11px] transition-colors",
                  mode === m.id ? "bg-panel2 text-text" : "text-muted hover:text-text",
                ].join(" ")}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode === "batch" && (
            <div className="text-[11px] text-muted">
              {t("batchSummary", { images: images.length, size: groupSize, pages: groups.length })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[rgb(var(--accent-color)/0.12)] px-3 text-[11px] font-medium text-[rgb(var(--accent-color))] transition-colors hover:bg-[rgb(var(--accent-color)/0.18)]"
            onClick={mode === "batch" ? handleBatchExport : handleExport}
            disabled={exporting || (mode === "batch" ? groups.length === 0 : images.length < 2)}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting
              ? (exportProgress ? t("exportingProgress", exportProgress) : t("exporting"))
              : (mode === "batch" ? t("exportBatch", { n: groups.length }) : t("image"))}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted2 transition-colors hover:bg-hover hover:text-text"
            onClick={onClose}
            title={t("close")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Canvas area */}
        {mode === "batch" ? (
          <div
            className="min-w-0 flex-1 overflow-y-auto p-6"
            data-testid="batch-pages-area"
            onClick={(e) => {
              // Click on empty space closes any open per-page layout popover.
              if (!(e.target instanceof Element) || !e.target.closest("[data-testid='batch-page-card']")) {
                setLayoutPopoverPage(-1);
              }
            }}
          >
            {/* Grid as a whole is centered in the area; pages fill each row
                left→right so a partial last row stays left-aligned. Fixed
                auto-fit columns give exactly that (flex-wrap can't). */}
            <div
              className="grid content-start gap-5"
              style={{
                gridTemplateColumns: `repeat(auto-fit, ${BATCH_PAGE_WIDTH(canvasRatio)}px)`,
                justifyContent: "center",
              }}
            >
              {groups.map((group, gi) => {
                const tmpl = templateForPage(gi, group);
                const w = BATCH_PAGE_WIDTH(canvasRatio);
                const pool = getTemplatesForCount(group.length);
                const popoverOpen = layoutPopoverPage === gi;
                const dragTarget = cellDrag?.target?.page === gi ? cellDrag.target.cell : -1;
                const dragSource = cellDrag?.moved && cellDrag.fromPage === gi ? cellDrag.fromCell : -1;
                return (
                  <div key={gi} className="group/page relative" data-testid="batch-page-card">
                    <div
                      className={[
                        "relative overflow-hidden rounded-md ring-1 transition-shadow",
                        dragTarget >= 0 ? "ring-[rgb(var(--accent-color))]" : "ring-border/80",
                      ].join(" ")}
                      style={{ width: `${w}px`, aspectRatio: canvasRatio }}
                    >
                      <CollageCanvas
                        ref={(el) => { batchPageRefs.current[gi] = el; }}
                        images={group}
                        template={tmpl}
                        canvasRatio={canvasRatio}
                        gap={gap}
                        padding={padding}
                        borderRadius={borderRadius}
                        bgColor={bgColor}
                        exportWidth={exportWidth}
                        mode="batch"
                        sharedStates={batchCellStates.current}
                        highlightCell={dragTarget}
                        dimCell={dragSource}
                        className="h-full w-full"
                        onCellDragOut={(cellIdx, e) => beginCellDrag(gi, cellIdx, e)}
                        onReplace={(cellIdx) => beginReplace(group[cellIdx])}
                        onRemove={(cellIdx) => removeBatchImage(group[cellIdx])}
                      />
                      {/* Per-page layout: lives on the card, so "only this page"
                          needs no explanation. Shown on hover / while open. */}
                      <button
                        type="button"
                        title={t("pageLayoutBtn")}
                        data-testid="page-layout-btn"
                        className={[
                          "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white/85 backdrop-blur-sm transition-opacity hover:bg-black/75",
                          popoverOpen ? "opacity-100" : "opacity-0 group-hover/page:opacity-100",
                        ].join(" ")}
                        onClick={(e) => { e.stopPropagation(); setLayoutPopoverPage(popoverOpen ? -1 : gi); }}
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {popoverOpen && (
                      <div
                        className="absolute right-0 top-9 z-20 w-[196px] rounded-lg border border-border/60 bg-chrome p-2 shadow-menu"
                        data-testid="page-layout-popover"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">
                          {t("pageTitle", { n: gi + 1, imgs: group.length })}
                        </div>
                        <TemplateGrid
                          templates={pool}
                          activeId={tmpl?.id}
                          ratio={canvasRatio || 1}
                          onSelect={(picked) => setPageOverrides((prev) => ({ ...prev, [gi]: picked.id }))}
                        />
                      </div>
                    )}
                    <div className="mt-1.5 px-0.5 text-[11px] text-muted">
                      {t("pageTitle", { n: gi + 1, imgs: group.length })}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Drag ghost: thumbnail of the picked-up image following the cursor */}
            {cellDrag?.moved && (
              <div
                className="pointer-events-none fixed z-[10250] h-16 w-16 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md shadow-overlay ring-2 ring-[rgb(var(--accent-color))]"
                style={{ left: cellDrag.x, top: cellDrag.y }}
              >
                {(() => {
                  const src = cellDrag.item?.preview_path || cellDrag.item?.image_preview_path || cellDrag.item?.image_path;
                  return src ? <img src={localFileUrl(src)} alt="" className="h-full w-full object-cover" /> : null;
                })()}
              </div>
            )}
          </div>
        ) : (
        <div className="flex min-w-0 flex-1 items-center justify-center p-8">
          <div
            className="relative"
            style={{
              aspectRatio: canvasRatio,
              maxWidth: "100%",
              maxHeight: "100%",
              width: canvasRatio >= 1 ? "100%" : "auto",
              height: canvasRatio < 1 ? "100%" : "auto",
            }}
          >
            <CollageCanvas
              ref={canvasRef}
              images={images}
              template={template}
              canvasRatio={canvasRatio}
              gap={gap}
              padding={padding}
              borderRadius={borderRadius}
              bgColor={bgColor}
              exportWidth={exportWidth}
              className="h-full w-full rounded-md"
              onSwap={(a, b) => {
                setImages((prev) => {
                  const next = [...prev];
                  [next[a], next[b]] = [next[b], next[a]];
                  return next;
                });
              }}
              onReplace={(idx) => {
                setReplaceIndex(idx);
                setShowPicker(true);
              }}
              onSelectionChange={setSelectedCellIdx}
              onSelectedStateChange={setSelectedCellState}
            />
          </div>
        </div>
        )}

        {/* Right panel */}
        <div
          className="shrink-0 overflow-hidden border-l border-border/60 bg-chrome"
          style={{ width: `${PANEL_WIDTH}px` }}
        >
          {mode === "batch" ? (
            <BatchPanel
              imageCount={images.length}
              groups={groups}
              groupSize={groupSize}
              onGroupSizeChange={setGroupSize}
              orderBy={orderBy}
              onOrderByChange={setOrderBy}
              remainderMode={remainderMode}
              onRemainderModeChange={setRemainderMode}
              templateId={batchTemplateId}
              onTemplateIdChange={applyLayoutToAllPages}
              canvasRatio={canvasRatio}
              onCanvasRatioChange={setCanvasRatio}
              gap={gap}
              onGapChange={setGap}
              padding={padding}
              onPaddingChange={setPadding}
              borderRadius={borderRadius}
              onBorderRadiusChange={setBorderRadius}
              bgColor={bgColor}
              onBgColorChange={setBgColor}
              exportWidth={exportWidth}
              onExportWidthChange={setExportWidth}
              namePrefix={namePrefix}
              onNamePrefixChange={setNamePrefix}
              images={orderedImages}
              onRemoveImage={removeBatchImage}
              onAddImages={() => setShowPicker(true)}
            />
          ) : (
          <CollagePanel
            images={images}
            onImagesChange={setImages}
            template={template}
            onTemplateChange={setTemplate}
            canvasRatio={canvasRatio}
            onCanvasRatioChange={setCanvasRatio}
            gap={gap}
            onGapChange={setGap}
            padding={padding}
            onPaddingChange={setPadding}
            borderRadius={borderRadius}
            onBorderRadiusChange={setBorderRadius}
            bgColor={bgColor}
            onBgColorChange={setBgColor}
            exportWidth={exportWidth}
            onExportWidthChange={setExportWidth}
            onAddImages={() => setShowPicker(true)}
            selectedCellIdx={selectedCellIdx}
            selectedCellZoom={selectedCellState.zoom}
            onSelectedZoomChange={(z) => canvasRef.current?.setSelectedZoom(z)}
            onCenterSelected={() => canvasRef.current?.centerSelected()}
            onResetSelected={() => canvasRef.current?.resetSelected()}
            onDeselect={() => canvasRef.current?.deselect()}
          />
          )}
        </div>
      </div>

      {showPicker && (
        <ImagePickerModal
          excludeIds={excludeIds}
          collections={collections}
          summary={summary}
          onAdd={(pickedItems) => {
            if (replaceIndex >= 0 && pickedItems.length > 0) {
              setImages((prev) => {
                const next = [...prev];
                next[replaceIndex] = pickedItems[0];
                return next;
              });
            } else {
              setImages((prev) => [...prev, ...pickedItems]);
            }
            setShowPicker(false);
            setReplaceIndex(-1);
          }}
          onClose={() => { setShowPicker(false); setReplaceIndex(-1); }}
        />
      )}
    </div>
  );
}
