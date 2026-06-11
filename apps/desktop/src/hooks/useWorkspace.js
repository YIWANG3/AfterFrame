import { useEffect, useMemo, useRef, useState } from "react";
import { collapseRootPaths, mergeRoots, determineImportMode } from "../utils/format";
import { invalidateAnnotations, seedAnnotations } from "../components/annotation/annotationStore";

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
  const [sort, setSort] = useState("imported-desc");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({}); // structured facet filters
  const [facetValues, setFacetValues] = useState(null); // dropdown/slider options
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
  // Unified job polling: one timer for ALL background jobs (import, preview,
  // enrichment, annotation, ai_repaint). Replaces the per-type interval loops.
  const [activeJobs, setActiveJobs] = useState([]);
  const [lastFinishedJob, setLastFinishedJob] = useState(null);
  const jobsTimerRef = useRef(null);
  const lastJobsJsonRef = useRef("");
  const jobsPollingRef = useRef(false);
  const knownActiveRef = useRef(new Map()); // jobId -> { jobId, jobType, kind }
  const pendingImportRef = useRef(null);
  const jobHandlersRef = useRef({});
  const browserRequestIdRef = useRef(0);
  // While an agent-driven reveal resets query/filters/status, the reload
  // effects below must not fire — the reveal does one imperative load itself.
  const suppressAutoReloadUntilRef = useRef(0);

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

  // Backend handles sorting; client only does local text filtering for instant feedback
  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return items;
    return items.filter((item) =>
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
  }, [items, query]);

  // Debounced server-side search: reload browser when query changes
  const searchTimerRef = useRef(null);
  useEffect(() => {
    if (!browserReady) return;
    if (Date.now() < suppressAutoReloadUntilRef.current) return;
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (Date.now() < suppressAutoReloadUntilRef.current) return;
      void loadBrowser({ search: query.trim() || undefined, force: true });
    }, 250);
    return () => clearTimeout(searchTimerRef.current);
  }, [query]);

  // Reload from backend when sort changes
  useEffect(() => {
    if (!browserReady) return;
    if (Date.now() < suppressAutoReloadUntilRef.current) return;
    void loadBrowser({ force: true, sortKey: sort });
  }, [sort]);

  // Reload when structured facet filters change
  useEffect(() => {
    if (!browserReady) return;
    if (Date.now() < suppressAutoReloadUntilRef.current) return;
    void loadBrowser({ force: true, facetFilters: filters });
  }, [filters]);

  // Refresh facet options when the catalog/library changes
  useEffect(() => {
    if (!browserReady) return;
    void window.mediaWorkspace?.getFacetValues?.().then(setFacetValues).catch(() => {});
  }, [browserReady, summary?.export_assets]);

  // Queued-changes note for the import card in the unified JobDock.
  const queuedImportNote = useMemo(() => {
    const queuedRawCount = pendingImport.rawDirs.length;
    const queuedExportCount = pendingImport.exportDirs.length;
    if (!queuedRawCount && !queuedExportCount) return null;
    return `Queued changes: ${queuedExportCount} media · ${queuedRawCount} sources`;
  }, [pendingImport]);

  async function loadDetail(assetId) {
    if (!assetId) {
      setDetail(null);
      return;
    }
    const payload = await window.mediaWorkspace.getAssetDetailById(assetId);
    setDetail(payload);
  }

  async function loadBrowser({ nextStatus = status, append = false, collectionId = activeCollectionId, search = query.trim() || undefined, force = false, sortKey = sort, facetFilters = filters, preserveView = false } = {}) {
    if (!force && (append ? browserLoadingMore || browserLoading || !browserHasMore : browserLoading)) {
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
      // Background refreshes (preserveView) re-fetch everything the user has
      // already paged through, so their scroll position and selection survive
      // instead of being reset to page 1.
      const pageLimit = preserveView ? Math.max(PAGE_SIZE, browserOffset) : PAGE_SIZE;
      let payload;
      if (collectionId) {
        payload = await window.mediaWorkspace.browseCollection(collectionId, {
          limit: pageLimit,
          offset: nextOffset,
        });
      } else {
        payload = await window.mediaWorkspace.browseExports({
          status: nextStatus,
          limit: pageLimit,
          offset: nextOffset,
          search: search || undefined,
          sort: sortKey || undefined,
          filters: facetFilters && Object.keys(facetFilters).length ? facetFilters : undefined,
        });
      }
      if (browserRequestIdRef.current !== requestId) return;
      seedAnnotations(payload);
      setBrowserOffset(nextOffset + payload.length);
      setBrowserHasMore(payload.length === (append ? PAGE_SIZE : pageLimit));
      if (append) {
        setItems((current) => [...current, ...payload]);
      } else {
        setItems(payload);
        const firstId = payload[0]?.asset_id || null;
        const selectionStillValid = selectedAssetId && payload.some((item) => item.asset_id === selectedAssetId);
        // preserveView never steals selection by jumping to the first item;
        // it only clears when the selected asset truly disappeared.
        const nextSelectedId = selectionStillValid ? selectedAssetId : preserveView ? null : firstId;
        if (nextSelectedId !== selectedAssetId) {
          setSelectedAssetId(nextSelectedId);
          await loadDetail(nextSelectedId || null);
        }
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

  // Agent write tools (MCP update_assets / manage_collections) mutated the
  // catalog out-of-band — refresh the affected views. Ref pattern so the IPC
  // listener registers once but always sees fresh closures.
  const [lastAgentChange, setLastAgentChange] = useState(null);
  const catalogChangedRef = useRef(null);
  catalogChangedRef.current = (payload) => {
    const scope = payload?.scope;
    // Surface agent writes as a toast (jobs excluded — JobDock already shows
    // those). App.jsx watches lastAgentChange.
    if (payload?.reason === "agent" && scope !== "jobs") {
      setLastAgentChange({ scope, ids: payload?.ids || null, at: Date.now() });
    }
    if (scope === "jobs") {
      // Agent started/cancelled a background job — wake the polling loop so
      // JobDock picks it up (it self-stops when no jobs are known active).
      // Seeding with the job id guarantees finish side effects (refresh,
      // annotation invalidation, toast) even if the job ends before the
      // first poll.
      pokeJobs(payload?.jobId ? { jobId: payload.jobId, jobType: payload.jobType } : undefined);
      return;
    }
    if (scope === "collections") {
      void loadCollections();
      if (activeCollectionId && Date.now() >= suppressAutoReloadUntilRef.current) {
        void loadBrowser({ force: true, preserveView: true });
      }
      return;
    }
    // During an agent reveal the reveal's own imperative load supersedes this
    // refresh — a forced reload here would bump the request id and cancel the
    // reveal mid-flight ("Selected N photos" toast with nothing selected).
    if (Date.now() < suppressAutoReloadUntilRef.current) return;
    invalidateAnnotations();
    void loadBrowser({ force: true, preserveView: true });
  };
  useEffect(() => {
    window.mediaWorkspace?.onCatalogChanged?.((payload) => catalogChangedRef.current?.(payload));
  }, []);

  // Agent-driven reveal (MCP show_in_app): reset to the unfiltered library,
  // page through until the requested ids are loaded (bounded scan), then
  // select the first one. Returns {found, missing} for the agent's report.
  async function revealAssets(assetIds) {
    const wanted = new Set((assetIds || []).filter(Boolean));
    if (!wanted.size) return { found: [], missing: [] };
    suppressAutoReloadUntilRef.current = Date.now() + 1500;
    setActiveCollectionId(null);
    setQuery("");
    setFilters({});
    setStatus("all");
    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    setBrowserLoading(true);
    try {
      const MAX_PAGES = 12; // bounded: scans at most MAX_PAGES * PAGE_SIZE assets
      const collected = [];
      const found = [];
      let offset = 0;
      let lastPageFull = false;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const payload = await window.mediaWorkspace.browseExports({
          status: "all",
          limit: PAGE_SIZE,
          offset,
          sort: sort || undefined,
        });
        collected.push(...payload);
        offset += payload.length;
        for (const item of payload) {
          if (wanted.has(item.asset_id)) {
            wanted.delete(item.asset_id);
            found.push(item.asset_id);
          }
        }
        lastPageFull = payload.length === PAGE_SIZE;
        if (!wanted.size || !lastPageFull) break;
      }
      if (browserRequestIdRef.current !== requestId) {
        return { found, missing: [...wanted] };
      }
      seedAnnotations(collected);
      setItems(collected);
      setBrowserOffset(offset);
      setBrowserHasMore(lastPageFull);
      setBrowserReady(true);
      const primary = found[0] || null;
      if (primary) {
        setSelectedAssetId(primary);
        await loadDetail(primary);
      }
      return { found, missing: [...wanted] };
    } finally {
      setBrowserLoading(false);
    }
  }

  async function loadMoreBrowser() {
    await loadBrowser({ nextStatus: status, append: true, search: query.trim() || undefined, facetFilters: filters });
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

  // Status filters and collections are mutually exclusive views. This owns
  // that invariant — callers must not have to remember to clear the
  // collection themselves (pagination/reloads would silently mix datasets).
  function setStatusFilter(next) {
    setActiveCollectionId(null);
    setStatus(next);
    void refreshAll({ nextStatus: next, collectionId: null });
  }

  function clearCollection(options = {}) {
    const { reload = true } = options;
    if (!activeCollectionId) return;
    setActiveCollectionId(null);
    if (reload) {
      void loadBrowser({ collectionId: null });
    }
  }

  async function refreshAll({ nextStatus = status, collectionId = activeCollectionId, force = false, preserveView = false } = {}) {
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
    await Promise.all([loadCollections(), loadBrowser({ nextStatus, collectionId, force, preserveView })]);
    // Refresh facet options too (camera/lens/tag lists, ranges) so the filter
    // bar stays in sync after imports/annotation without a full reload.
    void window.mediaWorkspace?.getFacetValues?.().then(setFacetValues).catch(() => {});
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
    pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "import" } : undefined);
  }

  async function addImages() {
    const selected = await window.mediaWorkspace.pickDirectories("export");
    await addImagesFromPaths(selected);
  }

  async function addImagesFromPaths(selected) {
    if (!selected || !selected.length) return;
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
    pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "enrichment" } : undefined);
  }

  async function runPreviewGeneration(kind = "preview") {
    if (importTask?.running || previewTask?.running) return;
    const task = await window.mediaWorkspace.startPreviewGeneration(kind);
    setPreviewTask({ ...task, _kind: kind });
    pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "preview", kind } : undefined);
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
    knownActiveRef.current.clear();
    setActiveJobs([]);
    setLastFinishedJob(null);
    await refreshAll({ nextStatus: "all", force: true });
    pokeJobs();
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
        await addImages();
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

  // ── Unified job polling ─────────────────────────────────────────────────
  // Keep latest mutable state/handlers in refs so the timer chain never works
  // with stale closures (the old per-type intervals re-created themselves on
  // dep changes; the unified loop instead reads through refs).
  pendingImportRef.current = pendingImport;
  jobHandlersRef.current = { refreshAll, startIncrementalImport };

  async function handleJobFinished(meta) {
    const h = jobHandlersRef.current;
    let final = null;
    try {
      if (meta.jobType === "import") final = await window.mediaWorkspace.getImportStatus();
      else if (meta.jobType === "preview") final = await window.mediaWorkspace.getPreviewStatus();
      else if (meta.jobType === "enrichment") final = await window.mediaWorkspace.getEnrichmentStatus();
      else if (meta.jobType === "annotation") final = await window.mediaWorkspace.getAnnotationJobStatus?.();
      else if (meta.jobType === "ai_repaint") final = await window.mediaWorkspace.getAiRepaintStatus?.();
    } catch { /* sidecar hiccup — still emit the finish event below */ }
    const cancelled = final?.status === "cancelled";

    if (meta.jobType === "import") {
      setImportTask(final);
      const queued = pendingImportRef.current || { rawDirs: [], exportDirs: [] };
      setPendingImport({ rawDirs: [], exportDirs: [] });
      await h.refreshAll({ preserveView: true });
      // Continue queued dirs — but not after a user cancel.
      if (!cancelled && (queued.rawDirs.length || queued.exportDirs.length)) {
        await h.startIncrementalImport({ rawDirs: queued.rawDirs, exportDirs: queued.exportDirs });
      }
    } else if (meta.jobType === "preview") {
      // Chain preview-hd only after a SUCCESSFUL small-preview pass — a failed
      // or indeterminate run would just fail again at HD size.
      if ((meta.kind || "preview") === "preview" && final?.status === "succeeded") {
        // Auto-chain preview-hd after the small previews finish.
        const hdTask = await window.mediaWorkspace.startPreviewGeneration("preview-hd");
        setPreviewTask({ ...hdTask, _kind: "preview-hd" });
        pokeJobs(hdTask?.jobId ? { jobId: hdTask.jobId, jobType: "preview", kind: "preview-hd" } : undefined);
      } else {
        setPreviewTask(final);
        await h.refreshAll({ preserveView: true });
      }
    } else if (meta.jobType === "enrichment") {
      setEnrichmentTask(final);
      await h.refreshAll({ preserveView: true });
    } else if (meta.jobType === "ai_repaint") {
      // The job runner registers the repainted file as a new version asset —
      // reload so it appears in the grid without a manual refresh.
      if (!cancelled) await h.refreshAll({ preserveView: true });
    }
    // Generic finish event — App-level consumers (annotation toast/cache,
    // activity center) react to this.
    setLastFinishedJob({ ...(final || {}), jobType: meta.jobType, jobId: meta.jobId, finishedAtMs: Date.now() });
  }

  async function pollActiveJobsOnce() {
    let jobs = [];
    try {
      jobs = (await window.mediaWorkspace.getActiveJobs?.()) || [];
    } catch { jobs = []; }
    // Skip the state churn when nothing actually changed — otherwise every
    // 1.2s tick re-renders the whole tree for the lifetime of a job.
    const jobsJson = JSON.stringify(jobs);
    const changed = jobsJson !== lastJobsJsonRef.current;
    lastJobsJsonRef.current = jobsJson;
    if (changed) setActiveJobs(jobs);

    // Mirror into the legacy per-type task states (ImportOverlay & friends).
    if (changed) {
      const byType = new Map(jobs.map((j) => [j.jobType, j]));
      if (byType.has("import")) setImportTask(byType.get("import"));
      if (byType.has("preview")) {
        const j = byType.get("preview");
        setPreviewTask({ ...j, _kind: j.kind || knownActiveRef.current.get(j.jobId)?.kind || "preview" });
      }
      if (byType.has("enrichment")) setEnrichmentTask(byType.get("enrichment"));
    }

    // Finish detection: anything we knew about that's no longer active.
    const liveIds = new Set(jobs.map((j) => j.jobId));
    for (const [id, meta] of [...knownActiveRef.current]) {
      if (!liveIds.has(id)) {
        knownActiveRef.current.delete(id);
        void handleJobFinished(meta);
      }
    }
    for (const j of jobs) {
      const prev = knownActiveRef.current.get(j.jobId);
      knownActiveRef.current.set(j.jobId, { jobId: j.jobId, jobType: j.jobType, kind: j.kind || prev?.kind });
    }

    if (jobs.length > 0) {
      jobsTimerRef.current = window.setTimeout(pollActiveJobsOnce, 1200);
    } else {
      jobsPollingRef.current = false;
      jobsTimerRef.current = null;
    }
  }

  // Kick (or re-kick) the poll loop. `seed` pre-registers a just-started job
  // so even one that finishes before the first poll still gets its finish
  // side effects dispatched.
  function pokeJobs(seed) {
    if (seed?.jobId) {
      knownActiveRef.current.set(seed.jobId, { jobId: seed.jobId, jobType: seed.jobType, kind: seed.kind });
    }
    if (jobsPollingRef.current) return;
    jobsPollingRef.current = true;
    jobsTimerRef.current = window.setTimeout(pollActiveJobsOnce, 250);
  }

  async function cancelJob(jobId) {
    if (!jobId) return null;
    const res = await window.mediaWorkspace.cancelJob?.(jobId);
    pokeJobs();
    return res;
  }

  // Recover mid-run jobs after a reload/app start, and clean up on unmount.
  useEffect(() => {
    pokeJobs();
    return () => {
      if (jobsTimerRef.current) clearTimeout(jobsTimerRef.current);
      jobsPollingRef.current = false;
    };
  }, []);

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
    filters,
    setFilters,
    facetValues,
    browserLoading,
    browserReady,
    browserLoadingMore,
    browserHasMore,
    browserOffset,
    loadMoreBrowser,
    revealAssets,
    lastAgentChange,
    refreshAll,
    queuedImportNote,
    addImages,
    addImagesFromPaths,
    addSources,
    switchCatalog,
    runImportPipeline,
    runEnrichment,
    runPreviewGeneration,
    importTask,
    jobs: activeJobs,
    lastFinishedJob,
    cancelJob,
    pokeJobs,
    collections,
    activeCollectionId,
    selectCollection,
    clearCollection,
    setStatusFilter,
    createCollection,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    deleteExportAssets,
    setAssetRating,
  };
}
