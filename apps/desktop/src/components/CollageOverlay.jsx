import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Loader2, X, ChevronDown, Folder, Images } from "lucide-react";
import { localFileUrl } from "../utils/format";
import CollageCanvas from "./collage/CollageCanvas";
import CollagePanel from "./collage/CollagePanel";
import { getTemplatesForCount } from "./collage/collageTemplates";

const PANEL_WIDTH = 300;
const PAGE_SIZE = 48;
const PICKER_COLUMNS = 4;
const PICKER_GAP = 4;
const PICKER_HORIZONTAL_PADDING = 24;
const PICKER_OVERSCAN_PX = 600;
const PICKER_PRELOAD_PX = 1200;

function builtInSources(summary) {
  const items = [{ id: "all", label: "All" }];
  if (Number(summary?.rated_count ?? 0) > 0) {
    items.push({ id: "rated", label: "Rated" });
  }
  if (Number(summary?.raw_assets ?? 0) > 0) {
    items.push({ id: "matched", label: "With Raw" });
  }
  return items;
}

function ImagePickerModal({ excludeIds, collections, summary, onAdd, onClose }) {
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
    if (built) return built.label;
    const col = manualCollections.find((c) => c.collection_id === source);
    return col?.name || "All";
  }, [source, builtInItems, manualCollections]);

  const sourceTotal = useMemo(() => {
    const totalSummary = summary || {};
    if (source === "all") return Number(totalSummary.export_assets || 0);
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
        : await window.mediaWorkspace?.browseExports?.({
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

  const items = useMemo(() => {
    const used = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
    return sourceItems.filter((item) => !used.has(item.asset_id));
  }, [sourceItems, excludeIds]);

  const selectedItems = useMemo(() => Array.from(selectedItemsById.values()), [selectedItemsById]);
  const selectedIds = useMemo(() => new Set(selectedItemsById.keys()), [selectedItemsById]);

  const toggleSelected = useCallback((item) => {
    setSelectedItemsById((current) => {
      const next = new Map(current);
      if (next.has(item.asset_id)) {
        next.delete(item.asset_id);
      } else {
        next.set(item.asset_id, item);
      }
      return next;
    });
  }, []);

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
              Add Images
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
                  {s.label}
                </button>
              ))}

              {manualCollections.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-border/60" />
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted2">
                    Folders
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
            <div className="py-8 text-center text-[12px] text-muted2">No more images available</div>
          ) : (
            <div className="relative" style={{ height: `${totalHeight}px` }}>
              {visibleItems.map(({ item, left, top }) => {
                const src = item.preview_path || item.export_preview_path || item.raw_preview_path;
                const selected = selectedIds.has(item.asset_id);
                return (
                  <button
                    key={item.asset_id}
                    type="button"
                    className={[
                      "group absolute overflow-hidden rounded-md bg-panel2 transition",
                      selected
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
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-app text-[10px] text-muted2">No preview</div>
                    )}
                    <span
                      className={[
                        "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-black shadow-sm transition",
                        selected
                          ? "border-[rgb(var(--accent-color))] bg-[rgb(var(--accent-color))] opacity-100"
                          : "border-text/55 bg-app/70 opacity-75 group-hover:opacity-100",
                      ].join(" ")}
                    >
                      {selected ? <Check className="h-3.5 w-3.5" /> : null}
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

  // Initialize from items prop
  useEffect(() => {
    if (!open || !items?.length) return;
    setImages(items);
    const templates = getTemplatesForCount(items.length);
    setTemplate(templates[0] || null);
  }, [open, items]);

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
        } else {
          onClose?.();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, showPicker, onClose]);

  async function handleExport() {
    if (!canvasRef.current) return;
    setExporting(true);
    try {
      const blob = await canvasRef.current.exportToBlob(exportWidth);
      if (!blob) return;

      // Derive filename from source images
      const sourceAssetIds = images.map((img) => img.asset_id).filter(Boolean);
      const firstStem = images[0]?.stem || images[0]?.export_path?.split("/").pop()?.replace(/\.[^.]+$/, "") || "collage";
      const allSameSet = images.length > 1 && images.every((img) => img.resource_set_id && img.resource_set_id === images[0].resource_set_id);
      const baseStem = allSameSet ? (images[0].primary_stem || firstStem) : firstStem;
      const defaultName = `${baseStem}_collage.jpg`;

      const savePath = await window.mediaWorkspace?.pickSavePath?.({
        defaultPath: defaultName,
        filters: [{ name: "JPEG", extensions: ["jpg", "jpeg"] }, { name: "PNG", extensions: ["png"] }],
      });
      if (!savePath) return;

      const buffer = await blob.arrayBuffer();
      const firstSrc = images[0]?.export_path || null;
      await window.mediaWorkspace?.saveImage?.(savePath, buffer, firstSrc);
      await window.mediaWorkspace?.quickRegister?.(savePath, firstSrc, sourceAssetIds);
      onExportComplete?.(savePath);
    } catch (err) {
      console.error("[Collage] export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  // Exclude IDs for picker
  const excludeIds = useMemo(() => new Set(images.map((img) => img.asset_id)), [images]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10200] flex flex-col bg-app text-text">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 bg-chrome px-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">Collage</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[rgb(var(--accent-color)/0.12)] px-3 text-[11px] font-medium text-[rgb(var(--accent-color))] transition-colors hover:bg-[rgb(var(--accent-color)/0.18)]"
            onClick={handleExport}
            disabled={exporting || images.length < 2}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting ? "Exporting…" : "Export"}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted2 transition-colors hover:bg-hover hover:text-text"
            onClick={onClose}
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Canvas area */}
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
            />
          </div>
        </div>

        {/* Right panel */}
        <div
          className="shrink-0 overflow-hidden border-l border-border/60 bg-chrome"
          style={{ width: `${PANEL_WIDTH}px` }}
        >
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
          />
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
