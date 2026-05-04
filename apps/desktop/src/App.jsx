import { useEffect, useMemo, useState } from "react";
import { filterTitle } from "./utils/format";
import useWorkspace from "./hooks/useWorkspace";
import usePaneResize from "./hooks/usePaneResize";
import Sidebar from "./components/Sidebar";
import Toolbar from "./components/Toolbar";
import Gallery from "./components/Gallery";
import Inspector from "./components/Inspector";
import ImportOverlay from "./components/ImportOverlay";
import Lightbox from "./components/Lightbox";
import EditorOverlay from "./components/EditorOverlay";
import BeforeAfterCompare from "./components/editor/BeforeAfterCompare";
import CollageOverlay from "./components/CollageOverlay";
import DesignSystemPanel from "./components/DesignSystemPanel";

export default function App() {
  const workspace = useWorkspace();
  const [showSidebar] = useState(true);
  const [showInspector] = useState(true);
  const [displayMode, setDisplayMode] = useState("grid");
  const [thumbSize, setThumbSize] = useState(180);
  const [history, setHistory] = useState(["all"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [editorItem, setEditorItem] = useState(null);
  const [proofMode, setProofMode] = useState(false);
  const [layoutItems, setLayoutItems] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState(null);
  const [compareState, setCompareState] = useState(null);
  const [collageItems, setCollageItems] = useState(null);
  const resizeSidebar = usePaneResize(workspace.setSidebarWidth, 200, 360);
  const resizeInspector = usePaneResize((value) => workspace.setInspectorWidth(-value), -420, -240);
  const currentItems = workspace.filteredItems;
  const orderedIds = useMemo(() => currentItems.map((item) => item.asset_id), [currentItems]);
  const itemById = useMemo(
    () => new Map(currentItems.map((item) => [item.asset_id, item])),
    [currentItems],
  );
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedAssetIds = selectedIds;
  const selectedIndex = useMemo(
    () => currentItems.findIndex((item) => item.asset_id === workspace.selectedAssetId),
    [currentItems, workspace.selectedAssetId],
  );

  const layoutStyle = {
    gridTemplateColumns: [
      showSidebar ? `${workspace.sidebarWidth}px` : "0px",
      "minmax(0, 1fr)",
      showInspector ? `${workspace.inspectorWidth}px` : "0px",
    ].join(" "),
    gridTemplateRows: "minmax(0, 1fr)",
  };

  function commitSelection(nextIds, primaryId, anchorId = primaryId) {
    const deduped = [];
    const seen = new Set();
    for (const id of nextIds) {
      if (!id || seen.has(id) || !itemById.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    const nextPrimary = primaryId && itemById.has(primaryId) ? primaryId : deduped[0] || null;
    setSelectedIds(deduped);
    setSelectionAnchorId(anchorId && itemById.has(anchorId) ? anchorId : nextPrimary);
    workspace.setSelectedAssetId(nextPrimary);
  }

  function selectSingle(id) {
    commitSelection(id ? [id] : [], id, id);
  }

  function toggleSelection(id) {
    if (!id) return;
    if (selectedIdSet.has(id)) {
      const nextIds = selectedIds.filter((existingId) => existingId !== id);
      const nextPrimary =
        workspace.selectedAssetId === id ? nextIds[nextIds.length - 1] || null : workspace.selectedAssetId;
      commitSelection(nextIds, nextPrimary, selectionAnchorId === id ? nextPrimary : selectionAnchorId);
      return;
    }
    commitSelection([...selectedIds, id], id, selectionAnchorId || id);
  }

  function selectRange(id, append = false) {
    if (!id) return;
    const anchor = selectionAnchorId || workspace.selectedAssetId || id;
    const anchorIndex = orderedIds.indexOf(anchor);
    const targetIndex = orderedIds.indexOf(id);
    if (anchorIndex < 0 || targetIndex < 0) {
      selectSingle(id);
      return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangeIds = orderedIds.slice(start, end + 1);
    const nextIds = append ? [...selectedIds, ...rangeIds] : rangeIds;
    commitSelection(nextIds, id, anchor);
  }

  function handleItemSelect(assetId, event) {
    if (!event) {
      selectSingle(assetId);
      return;
    }
    const isToggle = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      selectRange(assetId, isToggle);
      return;
    }
    if (isToggle) {
      toggleSelection(assetId);
      return;
    }
    selectSingle(assetId);
  }

  function openLightboxForItem(assetId) {
    if (!assetId) return;
    selectSingle(assetId);
    setProofMode(false);
    setLightboxOpen(true);
  }

  function handleContextSelect(assetId) {
    if (selectedIdSet.has(assetId)) {
      workspace.setSelectedAssetId(assetId);
      return;
    }
    selectSingle(assetId);
  }

  function handleSelectionGroup(ids, primaryId, anchorId = primaryId) {
    commitSelection(ids, primaryId, anchorId);
  }

  function clearSelection() {
    setSelectedIds([]);
    setSelectionAnchorId(null);
    workspace.setSelectedAssetId(null);
  }

  function applyRating(nextRating) {
    const targetIds = selectedAssetIds.length
      ? selectedAssetIds
      : [workspace.selectedAssetId].filter((id) => id != null);
    if (!targetIds.length) return;
    void workspace.setAssetRating(targetIds, nextRating);
  }

  function prepareDragSelection(assetId) {
    if (selectedIdSet.has(assetId) && selectedAssetIds.length > 1) {
      workspace.setSelectedAssetId(assetId);
      const exportPaths = selectedAssetIds.map((id) => itemById.get(id)?.export_path).filter(Boolean);
      return { assetIds: selectedAssetIds, exportPaths };
    }
    selectSingle(assetId);
    const item = itemById.get(assetId);
    return {
      assetIds: [assetId].filter(Boolean),
      exportPaths: [item?.export_path].filter(Boolean),
    };
  }

  function selectByIndex(index) {
    const next = currentItems[index];
    if (!next) return;
    selectSingle(next.asset_id);
  }

  function moveSelection(offset) {
    if (!currentItems.length) return;
    if (selectedIndex < 0) {
      selectByIndex(offset >= 0 ? 0 : currentItems.length - 1);
      return;
    }
    const nextIndex = selectedIndex + offset;
    if (nextIndex < 0 || nextIndex >= currentItems.length) return;
    selectByIndex(nextIndex);
  }

  function selectByDirection(direction) {
    if (!currentItems.length) return;
    if (!workspace.selectedAssetId) {
      selectByIndex(0);
      return;
    }

    const current = layoutItems.find((item) => item.assetId === workspace.selectedAssetId);
    if (!current) {
      moveSelection(direction === "left" || direction === "up" ? -1 : 1);
      return;
    }

    const isForward = direction === "right" || direction === "down";
    const curCenterX = current.left + current.width / 2;
    const curCenterY = current.top + current.height / 2;

    function groupByPosition(items, getPos, tolerance) {
      const groups = [];
      for (const item of items) {
        const pos = getPos(item);
        const existing = groups.find((g) => Math.abs(g.key - pos) < tolerance);
        if (existing) {
          existing.items.push(item);
        } else {
          groups.push({ key: pos, items: [item] });
        }
      }
      groups.sort((a, b) => a.key - b.key);
      return groups;
    }

    if (displayMode === "grid" || displayMode === "tiles") {
      if (direction === "left" || direction === "right") {
        moveSelection(isForward ? 1 : -1);
      } else {
        const colCount = layoutItems.filter((c) => Math.abs(c.top - current.top) < 2).length || 1;
        moveSelection(isForward ? colCount : -colCount);
      }
      return;
    }

    if (displayMode === "justified") {
      if (direction === "left" || direction === "right") {
        moveSelection(isForward ? 1 : -1);
        return;
      }
      const rows = groupByPosition(layoutItems, (item) => item.top, 8);
      const curRowIdx = rows.findIndex((r) => r.items.some((item) => item.assetId === current.assetId));
      const targetRowIdx = isForward ? curRowIdx + 1 : curRowIdx - 1;
      if (targetRowIdx < 0 || targetRowIdx >= rows.length) return;
      const targetRow = rows[targetRowIdx].items;
      let best = targetRow[0];
      let bestDist = Infinity;
      for (const item of targetRow) {
        const dist = Math.abs(item.left + item.width / 2 - curCenterX);
        if (dist < bestDist) { bestDist = dist; best = item; }
      }
      selectSingle(best.assetId);
      return;
    }

    if (displayMode === "waterfall") {
      const columns = groupByPosition(layoutItems, (item) => item.left, 4);
      for (const col of columns) col.items.sort((a, b) => a.top - b.top);
      const curColIdx = columns.findIndex((c) => c.items.some((item) => item.assetId === current.assetId));
      const curCol = columns[curColIdx];
      const curItemInColIdx = curCol.items.findIndex((item) => item.assetId === current.assetId);

      if (direction === "left" || direction === "right") {
        const targetColIdx = isForward ? curColIdx + 1 : curColIdx - 1;
        if (targetColIdx < 0 || targetColIdx >= columns.length) return;
        const targetCol = columns[targetColIdx].items;
        let best = targetCol[0];
        let bestDist = Infinity;
        for (const item of targetCol) {
          const dist = Math.abs(item.top + item.height / 2 - curCenterY);
          if (dist < bestDist) { bestDist = dist; best = item; }
        }
        selectSingle(best.assetId);
      } else {
        const targetIdx = isForward ? curItemInColIdx + 1 : curItemInColIdx - 1;
        if (targetIdx < 0 || targetIdx >= curCol.items.length) return;
        selectSingle(curCol.items[targetIdx].assetId);
      }
      return;
    }
  }

  function openEditor(target) {
    const nextItem =
      typeof target === "string"
        ? itemById.get(target)
        : target?.asset_id
          ? itemById.get(target.asset_id) || target
          : itemById.get(workspace.selectedAssetId);
    if (!nextItem) return;
    setEditorItem(nextItem);
  }

  function handleCompare(assetIds) {
    if (assetIds?.length !== 2) return;
    const a = itemById.get(assetIds[0]);
    const b = itemById.get(assetIds[1]);
    if (!a?.export_path || !b?.export_path) return;
    setCompareState({ beforePath: a.export_path, afterPath: b.export_path, layout: "side" });
  }

  function handleCollage(assetIds) {
    if (!assetIds?.length || assetIds.length < 2) return;
    const items = assetIds.map((id) => itemById.get(id)).filter(Boolean);
    if (items.length < 2) return;
    setCollageItems(items);
  }

  useEffect(() => {
    if (!workspace.selectedAssetId) {
      setLightboxOpen(false);
      setProofMode(false);
      setEditorItem(null);
    }
  }, [workspace.selectedAssetId]);

  useEffect(() => {
    const validIds = new Set(orderedIds);
    setSelectedIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      const primaryId =
        workspace.selectedAssetId && validIds.has(workspace.selectedAssetId) ? workspace.selectedAssetId : null;
      if (primaryId) {
        if (!next.length) return [primaryId];
        if (!next.includes(primaryId)) return [primaryId];
        return next;
      }
      return next;
    });
    setSelectionAnchorId((current) => {
      if (current && validIds.has(current)) return current;
      if (workspace.selectedAssetId && validIds.has(workspace.selectedAssetId)) {
        return workspace.selectedAssetId;
      }
      return orderedIds[0] || null;
    });
  }, [orderedIds, workspace.selectedAssetId]);

  useEffect(() => {
    function shouldIgnoreKey(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName;
      return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
    }

    function handleKeyDown(event) {
      if (editorItem) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (shouldIgnoreKey(event)) return;

      if (event.code === "Space") {
        if (!workspace.selectedAssetId) return;
        event.preventDefault();
        setLightboxOpen((current) => !current);
        return;
      }

      if (/^[0-5]$/.test(event.key) && (selectedAssetIds.length || workspace.selectedAssetId)) {
        event.preventDefault();
        applyRating(Number(event.key));
        return;
      }

      if (event.key.toLowerCase() === "e" && (lightboxOpen || workspace.selectedAssetId)) {
        event.preventDefault();
        openEditor();
        return;
      }

      if (lightboxOpen && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setProofMode((current) => !current);
        return;
      }

      if (event.key === "Escape") {
        if (!lightboxOpen) return;
        event.preventDefault();
        if (proofMode) {
          setProofMode(false);
        } else {
          setLightboxOpen(false);
        }
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        selectByDirection(event.key === "ArrowLeft" ? "left" : "up");
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        selectByDirection(event.key === "ArrowRight" ? "right" : "down");
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentItems, displayMode, editorItem, layoutItems, lightboxOpen, openEditor, proofMode, selectedIndex, workspace.selectedAssetId, selectedAssetIds]);

  return (
    <div className="noise-overlay h-full overflow-hidden bg-app text-text">
      <div className="relative grid h-full min-w-0 overflow-hidden" style={layoutStyle}>
        {showSidebar ? <Sidebar
          info={workspace.info}
          summary={workspace.summary}
          status={workspace.status}
          setStatus={(next) => {
            const baseHistory = history.slice(0, historyIndex + 1);
            const nextHistory = baseHistory[baseHistory.length - 1] === next ? baseHistory : [...baseHistory, next];
            const nextIndex = nextHistory.length - 1;
            setHistory(nextHistory);
            setHistoryIndex(nextIndex);
            workspace.setStatus(next);
            void workspace.refreshAll({ nextStatus: next, collectionId: null });
          }}
          collections={workspace.collections}
          activeCollectionId={workspace.activeCollectionId}
          onSelectCollection={workspace.selectCollection}
          onClearCollection={workspace.clearCollection}
          onCreateCollection={workspace.createCollection}
          onRenameCollection={workspace.renameCollection}
          onDeleteCollection={workspace.deleteCollection}
          onAddToCollection={workspace.addToCollection}
        /> : <div className="bg-chrome" />}

        <section className="flex min-w-0 min-h-0 flex-col overflow-hidden bg-app">
          <Toolbar
            title={workspace.activeCollectionId
              ? (workspace.collections.find((c) => c.collection_id === workspace.activeCollectionId)?.name || "Folder")
              : filterTitle(workspace.status)}
            query={workspace.query}
            setQuery={workspace.setQuery}
            sort={workspace.sort}
            setSort={workspace.setSort}
            refreshAll={workspace.refreshAll}
            onAddProcessed={workspace.addImages}
            onAddSources={workspace.addSources}
            onRunImport={workspace.runImportPipeline}
            onRunEnrichment={workspace.runEnrichment}
            onRunPreviews={workspace.runPreviewGeneration}
            onBack={() => {
              if (historyIndex <= 0) return;
              const nextIndex = historyIndex - 1;
              const next = history[nextIndex];
              setHistoryIndex(nextIndex);
              workspace.setStatus(next);
              void workspace.refreshAll({ nextStatus: next, collectionId: null });
            }}
            onForward={() => {
              if (historyIndex >= history.length - 1) return;
              const nextIndex = historyIndex + 1;
              const next = history[nextIndex];
              setHistoryIndex(nextIndex);
              workspace.setStatus(next);
              void workspace.refreshAll({ nextStatus: next, collectionId: null });
            }}
            canGoBack={historyIndex > 0}
            canGoForward={historyIndex < history.length - 1}
            displayMode={displayMode}
            setDisplayMode={setDisplayMode}
            thumbSize={thumbSize}
            setThumbSize={setThumbSize}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
              <Gallery
                items={currentItems}
                selectedAssetId={workspace.selectedAssetId}
                selectedAssetIds={selectedAssetIds}
                onSelect={handleItemSelect}
                onOpen={openLightboxForItem}
                onSelectMany={handleSelectionGroup}
                onContextSelect={handleContextSelect}
                onClearSelection={clearSelection}
                onPrepareDragSelection={prepareDragSelection}
                onLayoutItemsChange={setLayoutItems}
                loading={workspace.browserLoading}
                browserReady={workspace.browserReady}
                loadingMore={workspace.browserLoadingMore}
                hasMore={workspace.browserHasMore}
                onLoadMore={workspace.loadMoreBrowser}
                displayMode={displayMode}
                thumbSize={thumbSize}
                totalCount={Number(workspace.summary?.export_assets ?? 0)}
                collections={workspace.collections}
                activeCollectionId={workspace.activeCollectionId}
                onAddToCollection={workspace.addToCollection}
                onRemoveFromCollection={workspace.removeFromCollection}
                onDeleteFromCatalog={workspace.deleteExportAssets}
                onEdit={openEditor}
                onCompare={handleCompare}
                onCollage={handleCollage}
              />
          </div>
        </section>

        {showInspector ? <Inspector detail={workspace.detail} onRatingChange={applyRating} onSelectAsset={selectSingle} /> : <div className="bg-chrome" />}

        {showSidebar ? (
          <div
            data-value={workspace.sidebarWidth}
            onMouseDown={resizeSidebar}
            className="absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-col-resize transition-colors before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent hover:before:bg-border"
            style={{ left: `${workspace.sidebarWidth}px` }}
          />
        ) : null}

        {showInspector ? (
          <div
            data-value={-workspace.inspectorWidth}
            onMouseDown={resizeInspector}
            className="absolute inset-y-0 z-20 w-3 translate-x-1/2 cursor-col-resize transition-colors before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent hover:before:bg-border"
            style={{ right: `${workspace.inspectorWidth}px` }}
          />
        ) : null}
      </div>

      <ImportOverlay overlay={workspace.activeOverlay} />
      <Lightbox
        open={lightboxOpen}
        items={currentItems}
        currentIndex={Math.max(selectedIndex, 0)}
        proofMode={proofMode}
        onToggleProof={() => setProofMode((current) => !current)}
        onEdit={openEditor}
        onClose={() => {
          setProofMode(false);
          setLightboxOpen(false);
        }}
        onIndexChange={selectByIndex}
      />
      <EditorOverlay
        open={!!editorItem}
        item={editorItem}
        onClose={() => setEditorItem(null)}
        onSaveComplete={async () => {
          await workspace.refreshAll?.();
        }}
      />
      {compareState && (
        <BeforeAfterCompare
          beforePath={compareState.beforePath}
          afterPath={compareState.afterPath}
          layout={compareState.layout || "side"}
          onClose={() => setCompareState(null)}
          onLayoutChange={(layout) => setCompareState((s) => s ? { ...s, layout } : s)}
        />
      )}
      <CollageOverlay
        open={!!collageItems}
        items={collageItems}
        collections={workspace.collections}
        summary={workspace.summary}
        onClose={() => setCollageItems(null)}
        onExportComplete={async () => {
          await workspace.refreshAll?.();
        }}
      />
      {!window.mediaWorkspace.isPackaged && <DesignSystemPanel />}
    </div>
  );
}
