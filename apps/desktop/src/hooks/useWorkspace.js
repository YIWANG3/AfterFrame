import { useEffect, useMemo, useRef, useState } from "react";
import { collapseRootPaths, mergeRoots, determineImportMode, formatPercent, progressNote } from "../utils/format";

const PAGE_SIZE = 180;
const THEME_STORAGE_KEY = "afterframe-theme";
const SIDEBAR_WIDTH_STORAGE_KEY = "afterframe-sidebar-width";
const INSPECTOR_WIDTH_STORAGE_KEY = "afterframe-inspector-width";

export default function useWorkspace() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_STORAGE_KEY) || "dark");
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) || 240));
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    Number(localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY) || 300),
  );
  const [info, setInfo] = useState(null);
  const [summary, setSummary] = useState(null);
  const [roots, setRoots] = useState([]);
  const [items, setItems] = useState([]);
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("name-asc");
  const [query, setQuery] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [browserLoadingMore, setBrowserLoadingMore] = useState(false);
  const [browserHasMore, setBrowserHasMore] = useState(true);
  const [browserOffset, setBrowserOffset] = useState(0);
  const [importTask, setImportTask] = useState(null);
  const [previewTask, setPreviewTask] = useState(null);
  const [enrichmentTask, setEnrichmentTask] = useState(null);
  const [pendingImport, setPendingImport] = useState({ rawDirs: [], exportDirs: [] });
  const [collections, setCollections] = useState([]);
  const [activeCollectionId, setActiveCollectionId] = useState(null);
  const importPollRef = useRef(null);
  const enrichmentPollRef = useRef(null);
  const previewPollRef = useRef(null);
  const browserRequestIdRef = useRef(0);

  const rawDirs = useMemo(
    () => roots.filter((item) => item.root_type === "raw").map((item) => item.path),
    [roots],
  );
  const exportDirs = useMemo(
    () => roots.filter((item) => item.root_type === "export").map((item) => item.path),
    [roots],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${inspectorWidth}px`);
    localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

  const filteredItems = useMemo(() => {
    const roleRank = (item) => {
      if (!item?.resource_set_id) return 0;
      if (item.resource_role === "raw") return 0;
      if (item.resource_role === "primary") return 1;
      return 2;
    };
    const compareWithinSet = (left, right) =>
      roleRank(left) - roleRank(right) ||
      Number(left?.resource_sort_order ?? 0) - Number(right?.resource_sort_order ?? 0) ||
      left.stem.localeCompare(right.stem);
    let nextItems = [...items];
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery) {
      nextItems = nextItems.filter((item) =>
        [
          item.stem,
          item.primary_stem,
          item.export_path,
          item.raw_path,
          item.version_kind,
          item.export_metadata?.camera_model,
          item.raw_metadata?.camera_model,
        ]
          .some((field) => String(field ?? "").toLowerCase().includes(normalizedQuery)),
      );
    }
    if (sort === "name-desc") {
      nextItems.sort((a, b) => {
        const leftName = a.primary_stem || a.stem;
        const rightName = b.primary_stem || b.stem;
        return rightName.localeCompare(leftName) || compareWithinSet(a, b);
      });
    } else if (sort === "score-desc") {
      nextItems.sort((a, b) => {
        const scoreDelta = Number(b.score ?? 0) - Number(a.score ?? 0);
        const leftName = a.primary_stem || a.stem;
        const rightName = b.primary_stem || b.stem;
        return scoreDelta || leftName.localeCompare(rightName) || compareWithinSet(a, b);
      });
    } else {
      nextItems.sort((a, b) => {
        const leftName = a.primary_stem || a.stem;
        const rightName = b.primary_stem || b.stem;
        return leftName.localeCompare(rightName) || compareWithinSet(a, b);
      });
    }
    return nextItems;
  }, [items, query, sort]);

  // Debounced server-side search: reload browser when query changes
  const searchTimerRef = useRef(null);
  useEffect(() => {
    if (!browserReady) return;
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void loadBrowser({ search: query.trim() || undefined, force: true });
    }, 250);
    return () => clearTimeout(searchTimerRef.current);
  }, [query]);

  const activeOverlay = useMemo(() => {
    const queuedRawCount = pendingImport.rawDirs.length;
    const queuedExportCount = pendingImport.exportDirs.length;
    if (importTask?.running || enrichmentTask?.running || previewTask?.running || importTask?.error || previewTask?.error || enrichmentTask?.error || queuedRawCount || queuedExportCount) {
      return {
        visible: true,
        title: importTask?.running
          ? `Import running: ${importTask.phaseLabel || importTask.phase || "Starting"} (${importTask.phaseIndex}/${importTask.phaseCount || 1}, ${formatPercent(importTask.progress)})`
          : enrichmentTask?.running
            ? "Enrichment running"
            : previewTask?.running
              ? previewTask._kind === "preview-hd" ? "Generating HD previews" : "Generating previews"
              : "Import attention needed",
        status: importTask?.running
          ? "Import in progress"
          : enrichmentTask?.running
            ? "Enrichment in progress"
            : previewTask?.running
              ? "Preview generation in progress"
              : "Pending changes",
        percent: importTask?.running
          ? formatPercent(importTask.progress)
          : previewTask?.running
            ? formatPercent(previewTask.progress)
            : enrichmentTask?.running
              ? formatPercent(enrichmentTask.progress)
              : "",
        notes: [
          progressNote(importTask),
          progressNote(previewTask),
          progressNote(enrichmentTask),
          queuedRawCount || queuedExportCount
            ? `Queued changes: ${queuedExportCount} media · ${queuedRawCount} sources`
            : "",
          importTask?.error || previewTask?.error || enrichmentTask?.error || "",
        ].filter(Boolean),
        phases: Array.isArray(importTask?.phaseResults) ? importTask.phaseResults.map((phase) => phase.label) : [],
      };
    }
    return { visible: false, title: "", status: "", percent: "", notes: [], phases: [] };
  }, [importTask, enrichmentTask, previewTask, pendingImport]);

  async function loadDetail(assetId) {
    if (!assetId) {
      setDetail(null);
      return;
    }
    const payload = await window.mediaWorkspace.getAssetDetailById(assetId);
    setDetail(payload);
  }

  async function loadBrowser({ nextStatus = status, append = false, collectionId = activeCollectionId, search = query.trim() || undefined, force = false } = {}) {
    console.log("[loadBrowser] called, browserLoading:", browserLoading, "force:", force, "append:", append, "browserHasMore:", browserHasMore);
    if (!force && (append ? browserLoadingMore || browserLoading || !browserHasMore : browserLoading)) {
      console.log("[loadBrowser] SKIPPED — guard triggered");
      return;
    }
    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    if (append) {
      setBrowserLoadingMore(true);
    } else {
      setBrowserLoading(true);
    }
    try {
      const nextOffset = append ? browserOffset : 0;
      let payload;
      if (collectionId) {
        payload = await window.mediaWorkspace.browseCollection(collectionId, {
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
      } else {
        payload = await window.mediaWorkspace.browseExports({
          status: nextStatus,
          limit: PAGE_SIZE,
          offset: nextOffset,
          search: search || undefined,
        });
      }
      if (browserRequestIdRef.current !== requestId) return;
      setBrowserOffset(nextOffset + payload.length);
      setBrowserHasMore(payload.length === PAGE_SIZE);
      if (append) {
        setItems((current) => [...current, ...payload]);
      } else {
        setItems(payload);
        const firstId = payload[0]?.asset_id || null;
        const nextSelectedId =
          selectedAssetId && payload.some((item) => item.asset_id === selectedAssetId)
            ? selectedAssetId
            : firstId;
        setSelectedAssetId(nextSelectedId);
        await loadDetail(nextSelectedId || null);
      }
      setBrowserReady(true);
    } finally {
      if (append) {
        setBrowserLoadingMore(false);
      } else {
        setBrowserLoading(false);
      }
    }
  }

  async function loadMoreBrowser() {
    await loadBrowser({ nextStatus: status, append: true, search: query.trim() || undefined });
  }

  async function loadCollections() {
    try {
      const list = await window.mediaWorkspace.listCollections();
      setCollections(list || []);
    } catch {
      setCollections([]);
    }
  }

  async function createCollection(name) {
    const col = await window.mediaWorkspace.createCollection(name, "manual");
    await loadCollections();
    return col;
  }

  async function renameCollection(collectionId, name) {
    await window.mediaWorkspace.updateCollection(collectionId, { name });
    await loadCollections();
  }

  async function deleteCollection(collectionId) {
    await window.mediaWorkspace.deleteCollection(collectionId);
    if (activeCollectionId === collectionId) {
      setActiveCollectionId(null);
    }
    await loadCollections();
  }

  async function addToCollection(collectionId, assetIds) {
    await window.mediaWorkspace.collectionAddItems(collectionId, assetIds);
    await loadCollections();
    if (activeCollectionId === collectionId) {
      await loadBrowser({ collectionId });
    }
  }

  async function removeFromCollection(collectionId, assetIds) {
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;
    await window.mediaWorkspace.collectionRemoveItems(collectionId, targetIds);
    await loadCollections();
    if (activeCollectionId === collectionId) {
      const removedSet = new Set(targetIds);
      setItems((current) => current.filter((item) => !removedSet.has(item.asset_id)));
    }
  }

  async function deleteExportAssets(assetIds) {
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;
    await window.mediaWorkspace.deleteExportAssets(targetIds);
    const deletedSet = new Set(targetIds);
    setItems((current) => current.filter((item) => !deletedSet.has(item.asset_id)));
    if (selectedAssetId && deletedSet.has(selectedAssetId)) {
      setSelectedAssetId(null);
      setDetail(null);
    }
  }

  async function setAssetRating(assetIds, rating) {
    const normalized = Number(rating) || 0;
    const nextRating = normalized > 0 ? normalized : null;
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;

    setItems((current) =>
      current.map((item) =>
        targetIds.includes(item.asset_id)
          ? { ...item, app_rating: nextRating }
          : item,
      ),
    );
    setDetail((current) =>
      current && targetIds.includes(current.asset_id)
        ? { ...current, app_rating: nextRating }
        : current,
    );

    await window.mediaWorkspace.setAssetRating(targetIds, normalized);
  }

  function selectCollection(collectionId) {
    setActiveCollectionId(collectionId);
    void loadBrowser({ collectionId });
  }

  function clearCollection(options = {}) {
    const { reload = true } = options;
    if (!activeCollectionId) return;
    setActiveCollectionId(null);
    if (reload) {
      void loadBrowser({ collectionId: null });
    }
  }

  async function refreshAll({ nextStatus = status, collectionId = activeCollectionId, force = false } = {}) {
    const [nextInfo, nextSummary, nextRoots, nextImportTask, nextPreviewTask, nextEnrichmentTask] = await Promise.all([
      window.mediaWorkspace.getInfo(),
      window.mediaWorkspace.getSummary(),
      window.mediaWorkspace.getCatalogRoots(),
      window.mediaWorkspace.getImportStatus(),
      window.mediaWorkspace.getPreviewStatus(),
      window.mediaWorkspace.getEnrichmentStatus(),
    ]);
    setInfo(nextInfo);
    setSummary(nextSummary);
    setRoots(nextRoots);
    setImportTask(nextImportTask);
    setPreviewTask(nextPreviewTask);
    setEnrichmentTask(nextEnrichmentTask);
    await Promise.all([loadCollections(), loadBrowser({ nextStatus, collectionId, force })]);
  }

  async function startIncrementalImport({ rawDirs: nextRawDirs = [], exportDirs: nextExportDirs = [], fullCatalog = false }) {
    let resolvedRawDirs = collapseRootPaths(nextRawDirs);
    let resolvedExportDirs = collapseRootPaths(nextExportDirs);

    if (fullCatalog) {
      resolvedRawDirs = collapseRootPaths(rawDirs);
      resolvedExportDirs = collapseRootPaths(exportDirs);
    }
    if (!resolvedRawDirs.length && !resolvedExportDirs.length) return;

    let mode = determineImportMode(summary, { rawDirs: resolvedRawDirs, exportDirs: resolvedExportDirs });
    if (mode === "source_with_media" && !resolvedExportDirs.length) {
      resolvedExportDirs = collapseRootPaths(exportDirs);
    }
    if (mode === "processed_with_sources" && resolvedRawDirs.length) {
      resolvedRawDirs = [];
    }
    mode = determineImportMode(summary, { rawDirs: resolvedRawDirs, exportDirs: resolvedExportDirs });

    const modeNeedsSources = mode === "source_only" || mode === "source_with_media" || mode === "combined";
    const modeNeedsProcessed = mode === "processed_only" || mode === "processed_with_sources" || mode === "combined";
    if (modeNeedsSources && !resolvedRawDirs.length) return;
    if (modeNeedsProcessed && !resolvedExportDirs.length) return;

    const task = await window.mediaWorkspace.startImport({
      rawDirs: resolvedRawDirs,
      exportDirs: resolvedExportDirs,
      mode,
    });
    setImportTask(task);
  }

  async function addProcessedMedia() {
    const selected = await window.mediaWorkspace.pickDirectories("export");
    if (!selected.length) return;
    await window.mediaWorkspace.registerRoots("export", selected);
    const nextRoots = mergeRoots(exportDirs, selected);
    setRoots((current) => [...current, ...selected.map((path) => ({ root_type: "export", path }))]);
    if (importTask?.running) {
      setPendingImport((current) => ({ ...current, exportDirs: mergeRoots(current.exportDirs, selected) }));
      return;
    }
    await startIncrementalImport({ exportDirs: nextRoots.length ? selected : [] });
    await refreshAll();
  }

  async function addSources() {
    const selected = await window.mediaWorkspace.pickDirectories("raw");
    if (!selected.length) return;
    await window.mediaWorkspace.registerRoots("raw", selected);
    setRoots((current) => [...current, ...selected.map((path) => ({ root_type: "raw", path }))]);
    if (importTask?.running) {
      setPendingImport((current) => ({ ...current, rawDirs: mergeRoots(current.rawDirs, selected) }));
      return;
    }
    await startIncrementalImport({ rawDirs: selected, exportDirs });
    await refreshAll();
  }

  async function runImportPipeline() {
    if (importTask?.running) return;
    await startIncrementalImport({ fullCatalog: true });
    await refreshAll();
  }

  async function runEnrichment() {
    if (importTask?.running || enrichmentTask?.running) return;
    const task = await window.mediaWorkspace.startEnrichment();
    setEnrichmentTask(task);
  }

  async function runPreviewGeneration(kind = "preview") {
    if (importTask?.running || previewTask?.running) return;
    const task = await window.mediaWorkspace.startPreviewGeneration(kind);
    setPreviewTask({ ...task, _kind: kind });
  }

  async function switchCatalog(nextCatalogPath) {
    await window.mediaWorkspace.switchCatalog(nextCatalogPath ?? null);
    setStatus("all");
    setSort("name-asc");
    setQuery("");
    setItems([]);
    setDetail(null);
    setBrowserReady(false);
    setBrowserLoading(false);
    setBrowserOffset(0);
    setBrowserHasMore(true);
    setImportTask(null);
    setPreviewTask(null);
    setEnrichmentTask(null);
    setPendingImport({ rawDirs: [], exportDirs: [] });
    setCollections([]);
    setActiveCollectionId(null);
    await refreshAll({ nextStatus: "all", force: true });
  }

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!selectedAssetId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedAssetId);
  }, [selectedAssetId]);

  useEffect(() => {
    if (!window.mediaWorkspace.onMenuAction) return undefined;
    window.mediaWorkspace.onMenuAction(async (action) => {
      if (action === "catalog:new") {
        const created = await window.mediaWorkspace.createCatalog();
        if (created) await switchCatalog(created);
      } else if (action === "catalog:open") {
        const selected = await window.mediaWorkspace.pickCatalog();
        if (selected) await switchCatalog(selected);
      } else if (action === "catalog:scratch") {
        await switchCatalog(null);
      } else if (action === "import:pick-export") {
        await addProcessedMedia();
      } else if (action === "import:pick-source") {
        await addSources();
      } else if (action === "import:start") {
        await runImportPipeline();
      } else if (action === "import:enrich") {
        await runEnrichment();
      } else if (action === "import:previews") {
        await runPreviewGeneration();
      } else if (action === "view:toggle-theme") {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
      } else if (action === "view:refresh") {
        await refreshAll();
      }
    });
    return undefined;
  }, [importTask, exportDirs, rawDirs, summary, previewTask, enrichmentTask]);

  useEffect(() => {
    if (!importTask?.running) {
      if (importPollRef.current) {
        clearInterval(importPollRef.current);
        importPollRef.current = null;
      }
      return undefined;
    }
    importPollRef.current = window.setInterval(async () => {
      const task = await window.mediaWorkspace.getImportStatus();
      setImportTask(task);
      if (!task?.running) {
        clearInterval(importPollRef.current);
        importPollRef.current = null;
        const queuedRawDirs = pendingImport.rawDirs;
        const queuedExportDirs = pendingImport.exportDirs;
        setPendingImport({ rawDirs: [], exportDirs: [] });
        await refreshAll();
        if (queuedRawDirs.length || queuedExportDirs.length) {
          await startIncrementalImport({ rawDirs: queuedRawDirs, exportDirs: queuedExportDirs });
        }
      }
    }, 1200);
    return () => {
      if (importPollRef.current) {
        clearInterval(importPollRef.current);
        importPollRef.current = null;
      }
    };
  }, [importTask?.running, pendingImport.rawDirs, pendingImport.exportDirs]);

  useEffect(() => {
    if (!previewTask?.running) {
      if (previewPollRef.current) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
      }
      return undefined;
    }
    const currentKind = previewTask._kind || "preview";
    previewPollRef.current = window.setInterval(async () => {
      const task = await window.mediaWorkspace.getPreviewStatus();
      if (!task?.running) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
        if (currentKind === "preview") {
          // Auto-start preview-hd after preview completes
          const hdTask = await window.mediaWorkspace.startPreviewGeneration("preview-hd");
          setPreviewTask({ ...hdTask, _kind: "preview-hd" });
        } else {
          setPreviewTask(task);
          await refreshAll();
        }
      } else {
        setPreviewTask({ ...task, _kind: currentKind });
      }
    }, 1500);
    return () => {
      if (previewPollRef.current) {
        clearInterval(previewPollRef.current);
        previewPollRef.current = null;
      }
    };
  }, [previewTask?.running, previewTask?._kind]);

  useEffect(() => {
    if (!enrichmentTask?.running) {
      if (enrichmentPollRef.current) {
        clearInterval(enrichmentPollRef.current);
        enrichmentPollRef.current = null;
      }
      return undefined;
    }
    enrichmentPollRef.current = window.setInterval(async () => {
      const task = await window.mediaWorkspace.getEnrichmentStatus();
      setEnrichmentTask(task);
      if (!task?.running) {
        clearInterval(enrichmentPollRef.current);
        enrichmentPollRef.current = null;
        await refreshAll();
      }
    }, 1500);
    return () => {
      if (enrichmentPollRef.current) {
        clearInterval(enrichmentPollRef.current);
        enrichmentPollRef.current = null;
      }
    };
  }, [enrichmentTask?.running]);

  return {
    theme,
    setTheme,
    sidebarWidth,
    setSidebarWidth,
    inspectorWidth,
    setInspectorWidth,
    info,
    summary,
    items,
    filteredItems,
    detail,
    selectedAssetId,
    setSelectedAssetId,
    status,
    setStatus,
    sort,
    setSort,
    query,
    setQuery,
    browserLoading,
    browserReady,
    browserLoadingMore,
    browserHasMore,
    browserOffset,
    loadMoreBrowser,
    refreshAll,
    activeOverlay,
    addProcessedMedia,
    addSources,
    switchCatalog,
    runImportPipeline,
    runEnrichment,
    runPreviewGeneration,
    collections,
    activeCollectionId,
    selectCollection,
    clearCollection,
    createCollection,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    deleteExportAssets,
    setAssetRating,
  };
}
