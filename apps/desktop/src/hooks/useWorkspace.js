import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { collapseRootPaths, mergeRoots, determineImportMode } from "../utils/format";
import { invalidateAnnotations, seedAnnotations } from "../components/annotation/annotationStore";
import api from "../api";
import useJobs from "./useJobs";
import {
  DEFAULT_SCOPE, chooseSelectionAfterReload, editScopeFromRules, filterItemsByQuery, facetScopeOf, hasRefinement, rulesDirty,
  rulesFromScope, scopeFromRules, scopeKeyOf, sortOutsideFolder,
  shouldResetScopeForReveal,
} from "./workspaceLogic";

const PAGE_SIZE = 180;
const THEME_STORAGE_KEY = "afterframe-theme";
const SIDEBAR_WIDTH_STORAGE_KEY = "afterframe-sidebar-width";
const INSPECTOR_WIDTH_STORAGE_KEY = "afterframe-inspector-width";

export default function useWorkspace({ pushToast } = {}) {
  const { t } = useTranslation("app");
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
  // The browse destination is ONE value. Every way of changing what the grid
  // shows (sidebar status, a collection, typed search, facet chips, sort, the
  // Discover tiles, a person, an agent reveal) writes this object; one effect
  // below browses it. Nothing reads status/filters/query as separate state
  // across an await any more — that is what let a background refresh, or an
  // older click, land last with a scope the user had already left (#68).
  const [scope, setScopeState] = useState(DEFAULT_SCOPE);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const updateScope = useCallback((patch) => setScopeState((current) => ({ ...current, ...patch })), []);
  const replaceScope = useCallback((next) => setScopeState({ ...DEFAULT_SCOPE, ...next }), []);
  // What the search box holds. It narrows the current page locally at once and
  // becomes scope.query after the debounce.
  const [typedQuery, setTypedQuery] = useState("");
  const [facetValues, setFacetValues] = useState(null); // dropdown/slider options
  const [selectedAssetId, setSelectedAssetIdState] = useState(null);
  const selectedAssetIdRef = useRef(null);
  const relatedNavigationRef = useRef(0);
  const detailRequestRef = useRef(0);
  const [revealAssetRequest, setRevealAssetRequest] = useState(null);
  // Inspector relationships may point outside the active search/filter page.
  // Keep that explicit selection authoritative while background browse
  // requests settle; otherwise a late response replaces it with the first
  // visible gallery item and briefly clears the inspector.
  const relatedSelectionRef = useRef(false);
  const setSelectedAssetId = useCallback((value) => {
    relatedNavigationRef.current += 1;
    relatedSelectionRef.current = false;
    setSelectedAssetIdState((current) => {
      const next = typeof value === "function" ? value(current) : value;
      selectedAssetIdRef.current = next;
      return next;
    });
  }, []);
  const setRelatedAssetId = useCallback((assetId) => {
    relatedSelectionRef.current = Boolean(assetId);
    selectedAssetIdRef.current = assetId || null;
    setSelectedAssetIdState(assetId || null);
  }, []);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [browserLoadingMore, setBrowserLoadingMore] = useState(false);
  const [browserHasMore, setBrowserHasMore] = useState(true);
  const [browserOffset, setBrowserOffset] = useState(0);
  const [importTask, setImportTask] = useState(null);
  const [previewTask, setPreviewTask] = useState(null);
  const [enrichmentTask, setEnrichmentTask] = useState(null);
  const [pendingImport, setPendingImport] = useState({ rawDirs: [], imageDirs: [], auto: false });
  const [collections, setCollections] = useState([]);
  // Monotonic catalog-content revision: bumped on every refreshAll, every
  // catalog-changed event (imports, metadata refresh, agent writes) AND every
  // in-UI mutation below (deletes, collection membership, ratings) — those
  // update local React state directly without a catalog-changed broadcast.
  // Consumers (the map point cache) use it as an invalidation token — asset
  // COUNTS can stay identical across real changes, so counting is not enough.
  const [catalogRevision, setCatalogRevision] = useState(0);
  const bumpCatalogRevision = () => setCatalogRevision((revision) => revision + 1);
  // Supersession: every browse takes the next id; a response whose id is no
  // longer current is dropped. The later request always wins, whoever sent it.
  const browserRequestIdRef = useRef(0);
  // Key of the scope the grid currently shows. The browse effect compares the
  // rendered scope against it; a reveal that loads a scope itself sets it
  // first so the effect does not browse the same destination again.
  const loadedScopeRef = useRef(null);
  // A reveal in flight owns the gallery: background catalog-changed refreshes
  // must not supersede it mid-way ("Selected N photos" with nothing selected).
  // User scope changes still win — they go through the effect, not this gate.
  const revealRef = useRef(null);

  const rawDirs = useMemo(
    () => roots.filter((item) => item.root_type === "raw").map((item) => item.path),
    [roots],
  );
  const imageDirs = useMemo(
    () => roots.filter((item) => item.root_type === "image").map((item) => item.path),
    [roots],
  );

  // Unified job polling lives in useJobs; domain reactions flow through this
  // bridge ref (reassigned every render → the timer never sees stale closures).
  const jobsBridgeRef = useRef({});
  jobsBridgeRef.current = {
    refreshAll: (opts) => refreshAll(opts),
    startIncrementalImport: (opts) => startIncrementalImport(opts),
    consumeQueuedImport: () => {
      const queued = pendingImport;
      setPendingImport({ rawDirs: [], imageDirs: [], auto: false });
      return queued;
    },
    mirrorTask: (type, task) => {
      if (type === "import") setImportTask(task);
      else if (type === "preview") setPreviewTask(task);
      else if (type === "enrichment") setEnrichmentTask(task);
    },
  };
  const { activeJobs, lastFinishedJob, pokeJobs, cancelJob, pauseJob, resumeJob, resetJobs } = useJobs(jobsBridgeRef);

  // Settings starts people indexing outside the import/annotation hooks. Wake
  // the shared job poller so the Activity Center and dock appear immediately.
  useEffect(() => {
    const onPeopleIndexStarted = (event) => {
      const job = event.detail;
      pokeJobs(job?.jobId ? { jobId: job.jobId, jobType: "people_index" } : undefined);
    };
    const onColorsStarted = (event) => {
      const job = event.detail;
      pokeJobs(job?.jobId ? { jobId: job.jobId, jobType: "colors" } : undefined);
    };
    window.addEventListener("people-index:started", onPeopleIndexStarted);
    window.addEventListener("colors:started", onColorsStarted);
    return () => {
      window.removeEventListener("people-index:started", onPeopleIndexStarted);
      window.removeEventListener("colors:started", onColorsStarted);
    };
  }, [pokeJobs]);

  // theme is a *preference*: "dark" | "light" | "system". "system" follows the
  // OS color scheme live; explicit values pin it. The applied value lands on
  // documentElement.dataset.theme (the only thing the CSS keys off).
  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const effective = theme === "system" ? (mql.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = effective;
      // Desktop: keep the native window appearance in step (traffic-light colours).
      api.setTheme?.(theme);
    };
    apply();
    if (theme !== "system") return undefined;
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${inspectorWidth}px`);
    localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

  // Backend handles sorting; the client only narrows the PREVIOUS page locally
  // so typing feels instant during the 250ms search debounce. The server result
  // then replaces `items` wholesale. Field list + the superset invariant live
  // in workspaceLogic.searchableFields.
  const filteredItems = useMemo(() => filterItemsByQuery(items, typedQuery), [items, typedQuery]);

  // Typed search → scope.query after 250ms. Programmatic scope changes set
  // both at once (browseTo, reveals), so this only fires for keystrokes. The
  // timer is kept in a ref so a reveal can cancel it: a click on a related
  // version while the search is still debouncing must not be overridden by
  // that search landing 200 ms later.
  const searchTimerRef = useRef(null);
  useEffect(() => {
    if (typedQuery.trim() === scopeRef.current.query.trim()) return undefined;
    searchTimerRef.current = setTimeout(() => updateScope({ query: typedQuery }), 250);
    return () => clearTimeout(searchTimerRef.current);
  }, [typedQuery, updateScope]);

  // The one place a scope change turns into a browse. Runs after the render
  // that committed the new scope, so it always browses what the user sees in
  // the sidebar/chips/toolbar — never a value captured before an await.
  const scopeKey = useMemo(() => scopeKeyOf(scope), [scope]);
  const browseCurrentScope = useEffectEvent(() => {
    if (scopeKey === loadedScopeRef.current) return;
    void loadBrowser({ scope: scopeRef.current });
  });
  useEffect(() => { browseCurrentScope(); }, [scopeKey]);

  // Refresh facet options when the catalog/library changes, and whenever the
  // view does: every count is "how many photos picking this would show" given
  // the folder, the search text and the other active filters. The request is tagged so a slow answer for the previous folder
  // cannot land on top of the current one.
  const facetRequestRef = useRef(0);
  // Reads only refs, so it is stable and refreshAll (not an effect) can call it too.
  const loadFacetValues = useCallback(() => {
    const request = ++facetRequestRef.current;
    void api.getFacetValues(facetScopeOf(scopeRef.current))
      .then((values) => { if (request === facetRequestRef.current) setFacetValues(values); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!browserReady) return;
    loadFacetValues();
  }, [browserReady, summary?.image_assets, scopeKey, loadFacetValues]);

  // Queued-changes note for the import card in the unified JobDock.
  const queuedImportNote = useMemo(() => {
    const queuedRawCount = pendingImport.rawDirs.length;
    const queuedExportCount = pendingImport.imageDirs.length;
    if (!queuedRawCount && !queuedExportCount) return null;
    return `Queued changes: ${queuedExportCount} media · ${queuedRawCount} sources`;
  }, [pendingImport]);

  async function loadDetail(assetId) {
    const requestId = ++detailRequestRef.current;
    if (!assetId) {
      setDetail(null);
      return;
    }
    const startedAt = Date.now();
    const payload = await api.getAssetDetailById(assetId);
    if (Date.now() - startedAt > 1000) console.warn(`[detail] ${assetId} took ${Date.now() - startedAt}ms`);
    if (requestId === detailRequestRef.current) setDetail(payload);
  }

  // `scope` is always explicit: the caller says what to browse, this function
  // never fills it in from a closure. append continues the current page set;
  // preserveView re-fetches everything already paged through so a background
  // refresh keeps the scroll position and selection.
  async function loadBrowser({ scope: target, append = false, preserveView = false }) {
    if (append && (browserLoadingMore || browserLoading || !browserHasMore)) return;
    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    if (append) {
      setBrowserLoadingMore(true);
    } else {
      setBrowserLoading(true);
      setBrowserLoadingMore(false);
    }
    try {
      const nextOffset = append ? browserOffset : 0;
      const pageLimit = preserveView ? Math.max(PAGE_SIZE, browserOffset) : PAGE_SIZE;
      const search = target.query.trim() || undefined;
      const activeFilters = target.filters && Object.keys(target.filters).length ? target.filters : undefined;
      if (activeFilters?.person_group) {
        console.log("[browse] person filter request", JSON.stringify({ status: target.status, collectionId: target.collectionId, filters: activeFilters }));
      }
      let payload;
      if (target.collectionId) {
        // Same search and filters as the library view: the filter bar is on
        // screen in a folder too, so it has to mean something there.
        payload = await api.browseCollection(target.collectionId, {
          limit: pageLimit,
          offset: nextOffset,
          search,
          filters: activeFilters,
          sort: target.sort || undefined,
        });
      } else {
        payload = await api.browseImages({
          status: target.status,
          limit: pageLimit,
          offset: nextOffset,
          search,
          sort: target.sort || undefined,
          filters: activeFilters,
          // The smart collection being viewed: the set the filters refine.
          base: target.base || undefined,
        });
      }
      if (activeFilters?.person_group) {
        console.log("[browse] person filter result", payload?.length, "items; request", requestId,
          browserRequestIdRef.current === requestId ? "(current)" : "(SUPERSEDED — discarded)");
      }
      if (browserRequestIdRef.current !== requestId) return;
      loadedScopeRef.current = scopeKeyOf(target);
      seedAnnotations(payload);
      setBrowserOffset(nextOffset + payload.length);
      setBrowserHasMore(payload.length === (append ? PAGE_SIZE : pageLimit));
      if (append) {
        setItems((current) => [...current, ...payload]);
      } else {
        setItems(payload);
        const activeSelectedId = selectedAssetIdRef.current;
        // The pin (relatedSelectionRef) is cleared by the next ordinary gallery
        // selection through setSelectedAssetId above.
        const nextSelectedId = chooseSelectionAfterReload({
          payload, activeSelectedId, relatedPinned: relatedSelectionRef.current, preserveView,
        });
        if (nextSelectedId !== activeSelectedId) {
          setSelectedAssetId(nextSelectedId);
          await loadDetail(nextSelectedId || null);
        }
      }
      setBrowserReady(true);
    } catch (error) {
      // A silent failure here leaves the gallery showing stale items while
      // every chip/sort control claims a different view — always say so.
      console.error("[browse] FAILED", error?.message || error);
      pushToast?.({ title: "Browse failed", message: error?.message || String(error), ttl: 6000, tone: "error" });
    } finally {
      if (browserRequestIdRef.current === requestId) {
        if (append) setBrowserLoadingMore(false);
        else setBrowserLoading(false);
      }
    }
  }

  // Re-browse what the grid shows, keeping scroll and selection. Background
  // callers (jobs, catalog-changed, addToCollection) use this.
  const refreshBrowse = () => loadBrowser({ scope: scopeRef.current, preserveView: true });

  // Agent write tools (MCP update_assets / manage_collections) mutated the
  // catalog out-of-band — refresh the affected views. Ref pattern so the IPC
  // listener registers once but always sees fresh closures.
  const [lastAgentChange, setLastAgentChange] = useState(null);
  const catalogChangedRef = useRef(null);
  catalogChangedRef.current = (payload) => {
    const scope_ = payload?.scope;
    setCatalogRevision((revision) => revision + 1);
    // Surface agent writes as a toast (jobs excluded — JobDock already shows
    // those). App.jsx watches lastAgentChange.
    if (payload?.reason === "agent" && scope_ !== "jobs") {
      setLastAgentChange({ scope: scope_, ids: payload?.ids || null, at: Date.now() });
    }
    if (scope_ === "jobs") {
      // Agent started/cancelled a background job — wake the polling loop so
      // JobDock picks it up (it self-stops when no jobs are known active).
      // Seeding with the job id guarantees finish side effects (refresh,
      // annotation invalidation, toast) even if the job ends before the
      // first poll.
      pokeJobs(payload?.jobId ? { jobId: payload.jobId, jobType: payload.jobType } : undefined);
      return;
    }
    if (scope_ === "collections") {
      void loadCollections();
      if (scopeRef.current.collectionId && !revealRef.current) void refreshBrowse();
      return;
    }
    if (revealRef.current) return;
    invalidateAnnotations();
    void refreshBrowse();
    // Smart collection counts are live queries over the assets.
    void loadCollections();
    // Asset writes move the sidebar counts too (delete_assets, crops adding
    // versions); the gallery alone reloading left "All Assets N" stale.
    void api.getSummary().then(setSummary).catch(() => {});
  };
  useEffect(() => {
    return api.onCatalogChanged((payload) => catalogChangedRef.current?.(payload));
  }, []);

  // A reveal loads a destination itself, then installs it as the scope: the
  // loaded key is set first so the browse effect sees "already showing this".
  function installLoadedScope(next) {
    loadedScopeRef.current = scopeKeyOf(next);
    setTypedQuery(next.query);
    replaceScope(next);
  }

  // Related versions are genuine gallery destinations, including later pages.
  // Locate using the same scope/order as browse, then fetch only the missing
  // prefix needed by the virtual layout. Do not scan pages or stat the entire
  // library just to discover the target's position.
  async function revealRelatedAsset(assetId) {
    if (!assetId) return;
    const navigationId = ++relatedNavigationRef.current;
    const startedAt = Date.now();
    const log = (step, extra = "") => console.log(`[reveal] #${navigationId} ${step} +${Date.now() - startedAt}ms ${extra}`);
    log("start", assetId);
    setRelatedAssetId(assetId);
    // Whatever is in the search box is part of the scope the user means, even
    // if its debounce has not landed yet — locate inside it, and stop the
    // debounce from browsing on its own behind this reveal.
    clearTimeout(searchTimerRef.current);
    const requestId = ++browserRequestIdRef.current;
    const startScope = { ...scopeRef.current, query: typedQuery };
    const startKey = scopeKeyOf(scopeRef.current);
    // Superseded by a newer reveal, a newer browse, or a scope the user changed.
    const isCurrent = () => navigationId === relatedNavigationRef.current
      && requestId === browserRequestIdRef.current
      && scopeKeyOf(scopeRef.current) === startKey;
    revealRef.current = navigationId;
    setBrowserLoading(true);
    setBrowserLoadingMore(false);
    try {
      const asQuery = (s) => ({ status: s.status, collectionId: s.collectionId, search: s.query.trim() || undefined, sort: s.sort, filters: s.filters, base: s.base || undefined });
      let target = startScope;
      const sameLoadedScope = loadedScopeRef.current === scopeKeyOf(startScope);
      if (sameLoadedScope && filteredItems.some((item) => item.asset_id === assetId)) {
        log("already loaded");
        setRevealAssetRequest({ assetId, navigationId });
        return;
      }
      let location = await api.locateImageAsset({ assetId, ...asQuery(target) });
      log("located", JSON.stringify(location));
      if (!isCurrent()) { log("superseded after locate"); return; }
      const resetScope = shouldResetScopeForReveal({
        locationIndex: location.index, query: typedQuery, items, filteredItems, assetId,
      });
      if (resetScope) {
        target = { ...DEFAULT_SCOPE, sort: startScope.sort };
        location = await api.locateImageAsset({ assetId, ...asQuery(target) });
        log("located in all", JSON.stringify(location));
        if (!isCurrent()) { log("superseded after relocate"); return; }
      }
      if (location.index == null) throw new Error(t("relatedAsset.missing"));
      const limit = Math.ceil((location.index + 1) / PAGE_SIZE) * PAGE_SIZE;
      const offset = resetScope || !sameLoadedScope ? 0 : browserOffset;
      const count = Math.max(0, limit - offset);
      const payload = count === 0 ? [] : target.collectionId
        ? await api.browseCollection(target.collectionId, { limit: count, offset, search: asQuery(target).search, filters: target.filters, sort: target.sort || undefined })
        : await api.browseImages({ ...asQuery(target), limit: count, offset });
      log("page fetched", `count=${count} offset=${offset} got=${payload.length}`);
      if (!isCurrent()) { log("superseded after page"); return; }
      const nextItems = offset === 0 ? payload : [...items, ...payload];
      if (!nextItems.some((item) => item.asset_id === assetId)) throw new Error(t("relatedAsset.missing"));
      // Either way the scope the grid now shows becomes THE scope — including
      // the absorbed search text, so the box and the grid agree.
      installLoadedScope(target);
      if (resetScope) pushToast?.({ title: t("relatedAsset.showingAll"), ttl: 4000 });
      seedAnnotations(payload);
      setItems(nextItems);
      setRevealAssetRequest({ assetId, navigationId });
      setBrowserOffset(nextItems.length);
      if (count > 0) setBrowserHasMore(payload.length === count);
      setBrowserReady(true);
      log("done", `items=${nextItems.length}`);
    } catch (error) {
      log("failed", error?.message || String(error));
      if (isCurrent()) pushToast?.({ title: t("relatedAsset.failed"), message: error.message, tone: "error", ttl: 6000 });
    } finally {
      if (revealRef.current === navigationId) revealRef.current = null;
      if (requestId === browserRequestIdRef.current) setBrowserLoading(false);
    }
  }

  // Agent-driven reveal (MCP show_in_app): reset to the unfiltered library,
  // page through until the requested ids are loaded (bounded scan), then
  // select the first one. Returns {found, missing} for the agent's report.
  async function revealAssets(assetIds) {
    const wanted = new Set((assetIds || []).filter(Boolean));
    if (!wanted.size) return { found: [], missing: [] };
    const target = { ...DEFAULT_SCOPE, sort: scopeRef.current.sort };
    installLoadedScope(target);
    const requestId = browserRequestIdRef.current + 1;
    browserRequestIdRef.current = requestId;
    revealRef.current = requestId;
    setBrowserLoading(true);
    try {
      const MAX_PAGES = 12; // bounded: scans at most MAX_PAGES * PAGE_SIZE assets
      const collected = [];
      const found = [];
      let offset = 0;
      let lastPageFull = false;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const payload = await api.browseImages({
          status: "all",
          limit: PAGE_SIZE,
          offset,
          sort: target.sort || undefined,
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
      if (revealRef.current === requestId) revealRef.current = null;
      setBrowserLoading(false);
    }
  }

  async function loadMoreBrowser() {
    await loadBrowser({ scope: scopeRef.current, append: true });
  }

  async function loadCollections() {
    try {
      const list = await api.listCollections();
      setCollections(list || []);
      return list || [];
    } catch {
      setCollections([]);
      return [];
    }
  }

  async function createCollection(name) {
    const col = await api.createCollection(name, "manual");
    await loadCollections();
    return col;
  }

  // Save the current view as a smart collection: where the user is plus the
  // refinement (workspaceLogic.rulesFromScope). The new collection then becomes
  // the place, which also empties the filter bar: what was a refinement is now
  // its rules.
  async function saveSmartCollection(name) {
    const rules = rulesFromScope(scopeRef.current);
    if (!rules) return null;
    const col = await api.createCollection(name, "smart", rules);
    const saved = (await loadCollections()).find((c) => c.collection_id === col.collection_id);
    // Never leave a smart collection that lost its conditions on the way in:
    // it would sit in the sidebar at 0 photos, forever, under a "saved" toast.
    // (Seen in dev with a main process older than the renderer, which dropped
    // the rules argument.)
    if (!saved?.rules) {
      await api.deleteCollection(col.collection_id).catch(() => {});
      await loadCollections();
      throw new Error(t("smartCollectionRulesLost"));
    }
    openSmartCollection(saved);
    return col;
  }

  // Rewrite a smart collection's rules from the current view, then show it:
  //   viewing + a refinement → "narrow this collection to what I see" (the
  //                            refinement nests on its old rules)
  //   editing                → the bar's conditions replace its top layer
  async function updateSmartCollectionRules(collectionId) {
    const rules = rulesFromScope(scopeRef.current);
    if (!rules) return;
    await api.updateCollection(collectionId, { rules });
    const saved = (await loadCollections()).find((c) => c.collection_id === collectionId);
    if (saved) openSmartCollection(saved);
  }

  // Freeze what a smart collection shows right now into an ordinary folder.
  async function snapshotSmartCollection(collection, name) {
    const rules = collection?.rules;
    if (!rules) return null;
    const ids = [];
    for (let offset = 0; ; offset += 500) {
      const page = await api.browseImages({ status: "all", base: rules, limit: 500, offset });
      ids.push(...(page || []).map((row) => row.asset_id));
      if (!page || page.length < 500) break;
    }
    const folder = await api.createCollection(name, "manual");
    if (ids.length) await api.collectionAddItems(folder.collection_id, ids);
    await loadCollections();
    return { ...folder, count: ids.length };
  }

  const reorderingCollectionsRef = useRef(false);
  const [reorderingCollections, setReorderingCollections] = useState(false);
  async function reorderCollections(collectionIds) {
    if (reorderingCollectionsRef.current) return;
    reorderingCollectionsRef.current = true;
    setReorderingCollections(true);
    const byId = new Map(collections.map((c) => [c.collection_id, c]));
    setCollections([
      ...collectionIds.map((id, sort_order) => ({ ...byId.get(id), sort_order })),
      ...collections.filter((c) => c.kind !== "manual"),
    ]);
    try {
      await api.reorderCollections(collectionIds);
    } catch (error) {
      pushToast?.({ title: t("folderOrderFailed"), message: String(error?.message || error), tone: "error" });
    } finally {
      await loadCollections();
      reorderingCollectionsRef.current = false;
      setReorderingCollections(false);
    }
  }

  async function renameCollection(collectionId, name) {
    await api.updateCollection(collectionId, { name });
    await loadCollections();
  }

  async function deleteCollection(collectionId) {
    await api.deleteCollection(collectionId);
    bumpCatalogRevision();
    if (scopeRef.current.collectionId === collectionId) updateScope({ collectionId: null });
    if (scopeRef.current.smartCollectionId === collectionId) goTo({});
    await loadCollections();
  }

  async function addToCollection(collectionId, assetIds) {
    await api.collectionAddItems(collectionId, assetIds);
    bumpCatalogRevision();
    await loadCollections();
    if (scopeRef.current.collectionId === collectionId) {
      await refreshBrowse();
    }
  }

  async function removeFromCollection(collectionId, assetIds) {
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;
    await api.collectionRemoveItems(collectionId, targetIds);
    bumpCatalogRevision();
    await loadCollections();
    if (scopeRef.current.collectionId === collectionId) {
      const removedSet = new Set(targetIds);
      setItems((current) => current.filter((item) => !removedSet.has(item.asset_id)));
    }
  }

  async function deleteImageAssets(assetIds) {
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;
    await api.deleteImageAssets(targetIds);
    bumpCatalogRevision();
    const deletedSet = new Set(targetIds);
    setItems((current) => current.filter((item) => !deletedSet.has(item.asset_id)));
    if (selectedAssetId && deletedSet.has(selectedAssetId)) {
      setSelectedAssetId(null);
      setDetail(null);
    }
  }

  // Delete from disk: trash the originals AND drop the catalog records. Main
  // trashes the files first, so no tombstone is written (a trashed file can't
  // reappear in a watched dir). Paths are resolved by the caller (it has them).
  async function deleteImageAssetsFromDisk(assetIds, paths) {
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return null;
    const result = await api.deleteImageAssetsFromDisk(targetIds, paths || []);
    bumpCatalogRevision();
    const deletedSet = new Set(targetIds);
    setItems((current) => current.filter((item) => !deletedSet.has(item.asset_id)));
    if (selectedAssetId && deletedSet.has(selectedAssetId)) {
      setSelectedAssetId(null);
      setDetail(null);
    }
    return result;
  }

  async function setAssetRating(assetIds, rating) {
    const normalized = Number(rating) || 0;
    const nextRating = normalized > 0 ? normalized : null;
    const targetIds = [...new Set((assetIds || []).filter(Boolean))];
    if (!targetIds.length) return;
    const targetSet = new Set(targetIds);

    // Snapshot what each tile showed so a failed write can be undone. Without
    // this the stars stay on the new value while the catalog still holds the
    // old one, until some unrelated browse reload happens to correct it.
    const previousRatings = new Map();
    for (const item of items) {
      if (targetSet.has(item.asset_id)) previousRatings.set(item.asset_id, item.app_rating ?? null);
    }
    if (detail && targetSet.has(detail.asset_id) && !previousRatings.has(detail.asset_id)) {
      previousRatings.set(detail.asset_id, detail.app_rating ?? null);
    }

    const applyRating = (resolve) => {
      setItems((current) =>
        current.map((item) => (targetSet.has(item.asset_id)
          ? { ...item, app_rating: resolve(item.asset_id, item.app_rating) }
          : item)),
      );
      setDetail((current) => (current && targetSet.has(current.asset_id)
        ? { ...current, app_rating: resolve(current.asset_id, current.app_rating) }
        : current));
    };

    applyRating(() => nextRating);

    try {
      await api.setAssetRating(targetIds, normalized);
      // A rating is the most common smart-collection condition.
      if (collections.some((c) => c.kind === "smart")) void loadCollections();
    } catch (error) {
      applyRating((assetId, current) => (previousRatings.has(assetId) ? previousRatings.get(assetId) : current));
      pushToast?.({
        title: t("ratingFailed"),
        message: String(error?.message || error),
        tone: "error",
        ttl: 6000,
      });
      // Handled in full here (rolled back + surfaced); the only caller invokes
      // this as `void setAssetRating(...)`, so rethrowing would just produce an
      // unhandled rejection.
      return;
    }
    // Ratings order cluster covers on the map — invalidate its point cache.
    bumpCatalogRevision();
  }

  // ── scope changes: each one is a write to `scope`; the effect browses ──

  // Going somewhere: a location change is a fresh destination. The refinement
  // (search text + filters) belongs to the place it was made in, so it is
  // dropped — the classic "why is this folder empty?" is a filter carried in
  // from somewhere else. The sort is a preference and stays.
  // When the destination is what the grid already shows (saving a smart
  // collection from the current view, a Discover entry equal to the current
  // scope) the browse effect will not run again, so the grid must not be cleared.
  function goTo(next) {
    const full = { ...DEFAULT_SCOPE, sort: scopeRef.current.sort, ...next };
    if (!full.collectionId) full.sort = sortOutsideFolder(full.sort);
    if (scopeKeyOf(full) !== scopeKeyOf(scopeRef.current)) {
      // Drop the previous gallery right away: the grid must not paint the old
      // result set (and the inspector the old selection) for the frames until
      // the new browse resolves — that flash reads as "wrong photos, then fixed".
      setItems([]);
      setBrowserOffset(0);
      setBrowserHasMore(true);
      setSelectedAssetId(null);
    }
    setTypedQuery(full.query);
    setScopeState(full);
  }

  function selectCollection(collectionId) {
    goTo({ collectionId });
  }

  // A smart collection's rules become the base set; the filter bar starts
  // empty and only narrows inside it (workspaceLogic.scopeFromRules).
  function openSmartCollection(collection) {
    const next = scopeFromRules(collection, scopeRef.current.sort);
    if (next) goTo(next);
  }

  // The filter bar shows the collection's own conditions, to be changed and saved.
  function editSmartCollection(collection) {
    const next = editScopeFromRules(collection, scopeRef.current.sort);
    if (next) goTo(next);
  }

  // Status views, folders and smart collections are mutually exclusive places.
  function setStatusFilter(next) {
    goTo({ status: next });
    // The sidebar counts next to the entry the user just clicked.
    void api.getSummary().then(setSummary).catch(() => {});
  }

  // reload: false leaves the grid as it is (the caller is switching to a view
  // that is not the gallery) — the new scope is marked as already shown.
  function clearCollection({ reload = true } = {}) {
    const current = scopeRef.current;
    if (!current.collectionId) return;
    const next = { ...current, collectionId: null, sort: sortOutsideFolder(current.sort) };
    if (!reload) loadedScopeRef.current = scopeKeyOf(next);
    setScopeState(next);
  }

  // Opening a person is a new browse destination, not an intersection with a
  // stale text query/date/tag/rating filter from the previous gallery.
  function filterByPerson(groupId) {
    if (!groupId) return;
    goTo({ filters: { person_group: groupId } });
  }

  // Open the gallery as a fresh destination: collection, status, query and
  // facets are all replaced, never intersected with whatever the previous
  // gallery had (the Discover page's entries would otherwise inherit a stale
  // person/date/map filter and open "empty").
  function browseTo({ status = "all", filters = {}, collectionId = null, query = "" } = {}) {
    goTo({ status, collectionId, query, filters: filters && typeof filters === "object" ? filters : {} });
  }

  function applyFilters(nextFilters) {
    updateScope({ filters: nextFilters && typeof nextFilters === "object" ? nextFilters : {} });
  }

  // Status/summary/roots/tasks/collections, then the gallery. `scope` is
  // explicit when the caller has just changed it (switchCatalog) — the
  // rendered value would still be the old one. `force` is accepted for the
  // callers that pass it; every browse supersedes the one before it now.
  async function refreshAll({ preserveView = false, browse = true, scope: explicitScope = null } = {}) {
    const target = explicitScope || scopeRef.current;
    // Issue the browse first: it is the answer the user is waiting for, and
    // the sidecar is serial.
    const browsing = browse ? loadBrowser({ scope: target, preserveView }) : Promise.resolve();
    const [nextInfo, nextSummary, nextRoots, nextImportTask, nextPreviewTask, nextEnrichmentTask] = await Promise.all([
      api.getInfo(),
      api.getSummary(),
      api.getCatalogRoots(),
      api.getImportStatus(),
      api.getPreviewStatus(),
      api.getEnrichmentStatus(),
    ]);
    setInfo(nextInfo);
    setSummary(nextSummary);
    setRoots(nextRoots);
    setImportTask(nextImportTask);
    setPreviewTask(nextPreviewTask);
    setEnrichmentTask(nextEnrichmentTask);
    await Promise.all([loadCollections(), browsing]);
    setCatalogRevision((revision) => revision + 1);
    // Refresh facet options too (camera/lens/tag lists, ranges) so the filter
    // bar stays in sync after imports/annotation without a full reload.
    loadFacetValues();
  }

  async function startIncrementalImport({ rawDirs: nextRawDirs = [], imageDirs: nextImageDirs = [], fullCatalog = false, auto = false }) {
    let resolvedRawDirs = collapseRootPaths(nextRawDirs);
    let resolvedImageDirs = collapseRootPaths(nextImageDirs);

    if (fullCatalog) {
      resolvedRawDirs = collapseRootPaths(rawDirs);
      resolvedImageDirs = collapseRootPaths(imageDirs);
    }
    if (!resolvedRawDirs.length && !resolvedImageDirs.length) return;

    let mode = determineImportMode(summary, { rawDirs: resolvedRawDirs, imageDirs: resolvedImageDirs });
    if (mode === "source_with_media" && !resolvedImageDirs.length) {
      resolvedImageDirs = collapseRootPaths(imageDirs);
    }
    if (mode === "processed_with_sources" && resolvedRawDirs.length) {
      resolvedRawDirs = [];
    }
    mode = determineImportMode(summary, { rawDirs: resolvedRawDirs, imageDirs: resolvedImageDirs });

    const modeNeedsSources = mode === "source_only" || mode === "source_with_media" || mode === "combined";
    const modeNeedsProcessed = mode === "processed_only" || mode === "processed_with_sources" || mode === "combined";
    if (modeNeedsSources && !resolvedRawDirs.length) return;
    if (modeNeedsProcessed && !resolvedImageDirs.length) return;

    let task;
    try {
      task = await api.startImport({
        rawDirs: resolvedRawDirs,
        imageDirs: resolvedImageDirs,
        mode,
        auto,
      });
    } catch (error) {
      pushToast?.({ title: String(error?.message || error), tone: "error", ttl: 6000 });
      return;
    }
    setImportTask(task);
    pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "import" } : undefined);
  }

  // Importing needs a catalog. In packaged first-run there is none open, so
  // guard every import entry (toolbar, drop, Finder open-with) with a clear
  // toast instead of a silent sidecar failure against a null catalog.
  function requireCatalog() {
    if (info?.catalogPath || api.capabilities.web) return true;
    pushToast?.({ title: t("noCatalogTitle"), message: t("noCatalogMsg"), tone: "error", ttl: 5000 });
    return false;
  }

  async function addImages() {
    if (!requireCatalog()) return;
    const selected = await api.pickDirectories("image");
    await addImagesFromPaths(selected);
  }

  // When a folder is imported, offer to watch it (auto-import future drops).
  // No-ops for file imports and for folders already watched — so it stays quiet
  // for live watched-dir imports and drag-dropped individual files.
  async function maybePromptWatch(selected) {
    if (!api.has?.("statDirs")) return;
    try {
      const dirs = (await api.statDirs(selected)) || [];
      if (!dirs.length) return;
      const watched = (await api.getWatchedDirs?.()) || [];
      const fresh = dirs.filter((d) => !watched.includes(d));
      if (!fresh.length) return;
      pushToast?.({
        title: t("watchPromptTitle"),
        message: fresh.length === 1
          ? t("watchPromptMsg", { dir: fresh[0].split("/").filter(Boolean).pop() || fresh[0] })
          : t("watchPromptMsgN", { count: fresh.length }),
        ttl: 12000,
        actions: [{ label: t("watchAdd"), primary: true, onClick: () => fresh.forEach((d) => api.addWatchedDir?.(d)) }],
      });
    } catch { /* best-effort */ }
  }

  // `auto` marks background imports (watched dirs live + catch-up). They honor
  // delete-tombstones so a removed-but-on-disk file isn't resurrected; manual
  // imports (default) clear tombstones instead — see startIncrementalImport.
  async function addImagesFromPaths(selected, { auto = false } = {}) {
    if (!selected || !selected.length) return;
    if (!requireCatalog()) return;
    if (!auto) void maybePromptWatch(selected);
    await api.registerRoots("image", selected);
    const nextRoots = mergeRoots(imageDirs, selected);
    setRoots((current) => [...current, ...selected.map((path) => ({ root_type: "image", path }))]);
    if (importTask?.running) {
      setPendingImport((current) => ({ ...current, imageDirs: mergeRoots(current.imageDirs, selected), auto: current.auto || auto }));
      return;
    }
    await startIncrementalImport({ imageDirs: nextRoots.length ? selected : [], auto });
    await refreshAll();
  }

  async function addSources() {
    if (!requireCatalog()) return;
    const selected = await api.pickDirectories("raw");
    if (!selected.length) return;
    await api.registerRoots("raw", selected);
    setRoots((current) => [...current, ...selected.map((path) => ({ root_type: "raw", path }))]);
    if (importTask?.running) {
      setPendingImport((current) => ({ ...current, rawDirs: mergeRoots(current.rawDirs, selected) }));
      return;
    }
    await startIncrementalImport({ rawDirs: selected, imageDirs });
    await refreshAll();
  }

  async function runImportPipeline() {
    if (!requireCatalog()) return;
    if (importTask?.running) return;
    await startIncrementalImport({ fullCatalog: true });
    await refreshAll();
  }

  async function runEnrichment() {
    if (importTask?.running || enrichmentTask?.running) return;
    const task = await api.startEnrichment();
    setEnrichmentTask(task);
    pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "enrichment" } : undefined);
  }

  async function runPreviewGeneration(kind = "preview") {
    if (importTask?.running || previewTask?.running) return;
    const task = await api.startPreviewGeneration(kind);
    setPreviewTask({ ...task, _kind: kind });
    pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "preview", kind } : undefined);
  }

  async function switchCatalog(nextCatalogPath) {
    await api.switchCatalog(nextCatalogPath ?? null);
    // Facet filters reference catalog-local entities (person groups, tags) —
    // carrying them across catalogs yields empty or nonsense views. The sort
    // resets too (app default).
    installLoadedScope(DEFAULT_SCOPE);
    setItems([]);
    setDetail(null);
    setBrowserReady(false);
    setBrowserLoading(false);
    setBrowserOffset(0);
    setBrowserHasMore(true);
    setImportTask(null);
    setPreviewTask(null);
    setEnrichmentTask(null);
    setPendingImport({ rawDirs: [], imageDirs: [], auto: false });
    setCollections([]);
    resetJobs();
    await refreshAll({ scope: DEFAULT_SCOPE });
    pokeJobs();
  }

  // Initial load, once. The browse effect above does the first browse; this
  // fetches everything else.
  useEffect(() => {
    void refreshAll({ browse: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedAssetId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedAssetId);
  }, [selectedAssetId]);

  // Re-import reminder: when an import finishes, tell the user how many of the
  // selected files were already in the catalog (re-importing the same folder).
  const lastImportToastRef = useRef(null);
  useEffect(() => {
    if (!lastFinishedJob || lastFinishedJob.jobType !== "import") return;
    if (lastFinishedJob.status === "cancelled") return;
    if (lastImportToastRef.current === lastFinishedJob.finishedAtMs) return;
    lastImportToastRef.current = lastFinishedJob.finishedAtMs;
    // The resolve phase key varies by mode, so find it by its payload shape.
    const resolve = (lastFinishedJob.phaseResults || []).find(
      (p) => p?.result && typeof p.result.already_in_catalog === "number",
    );
    const already = resolve?.result?.already_in_catalog || 0;
    const added = resolve?.result?.newly_added || 0;
    if (already > 0) {
      pushToast?.({
        title: added > 0
          ? t("importMixed", { added, already })
          : t("importAllExisting", { already }),
        message: added > 0
          ? t("importMixedMsg", { count: already })
          : t("importAllExistingMsg"),
        ttl: 6000,
      });
    }
    // One toast per finished import; pushToast/t only format it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFinishedJob]);

  // Menu actions: registered ONCE, dispatched through a ref so the handler
  // always sees fresh closures. The old deps-array registration both leaked
  // listeners (no cleanup) and ran stale closures when status/collection
  // changed without the listed deps changing.
  const menuActionRef = useRef(null);
  menuActionRef.current = async (action) => {
      if (action === "catalog:new") {
        const created = await api.createCatalog();
        if (created) await switchCatalog(created);
      } else if (action === "catalog:open") {
        const selected = await api.pickCatalog();
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
      } else if (action === "library:verify") {
        const result = await api.verifyAssets();
        if (result) {
          const { missing = 0, checked = 0, recovered = 0 } = result;
          pushToast?.(
            missing > 0
              ? {
                  title: t("verifyMissing", { count: missing }),
                  message: t("verifyMissingMsg", { checked }),
                  ttl: 7000,
                  tone: "error",
                }
              : {
                  title: t("verifyAllPresent"),
                  message: recovered
                    ? t("verifyCheckedRecoveredMsg", { checked, recovered })
                    : t("verifyCheckedMsg", { checked }),
                  ttl: 4000,
                },
          );
        }
        await refreshAll();
      } else if (action === "view:toggle-theme") {
        // Toggle off whatever is *applied* (handles "system" → explicit flip).
        const applied = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        setTheme(applied === "dark" ? "light" : "dark");
      } else if (action === "view:refresh") {
        await refreshAll();
      }
  };
  useEffect(() => {
    if (!api.has("onMenuAction")) return undefined;
    return api.onMenuAction((action) => menuActionRef.current?.(action));
  }, []);

  const activeSmartCollection = scope.smartCollectionId
    ? collections.find((c) => c.collection_id === scope.smartCollectionId) || null
    : null;

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
    reloadDetail: () => loadDetail(selectedAssetId),
    selectedAssetId,
    setSelectedAssetId,
    setRelatedAssetId,
    revealRelatedAsset,
    revealAssetRequest,
    // The scope, exposed field by field for the toolbar/sidebar/filter bar,
    // with setters that each write one field of it.
    status: scope.status,
    setStatus: (status) => updateScope({ status }),
    sort: scope.sort,
    setSort: (sort) => updateScope({ sort }),
    query: typedQuery,
    setQuery: setTypedQuery,
    filters: scope.filters,
    setFilters: applyFilters,
    applyFilters,
    activeCollectionId: scope.collectionId,
    facetScope: facetScopeOf(scope),
    activeSmartCollectionId: scope.smartCollectionId,
    // Filter bar: "Save as smart collection" when there is something to save,
    // "Update" when an open smart collection's conditions were changed.
    // Filter bar: what it offers depends on the layer the user is working in.
    hasRefinement: hasRefinement(scope),
    editingSmartCollection: !!scope.editingRules,
    canSaveSmartCollection: !!rulesFromScope(scope),
    smartCollectionDirty: !!activeSmartCollection && rulesDirty(scope, activeSmartCollection.rules),
    activeBase: scope.collectionId ? null : scope.base,
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
    pauseJob,
    resumeJob,
    pokeJobs,
    collections,
    catalogRevision,
    bumpCatalogRevision,
    selectCollection,
    clearCollection,
    filterByPerson,
    browseTo,
    setStatusFilter,
    createCollection,
    saveSmartCollection,
    updateSmartCollectionRules,
    snapshotSmartCollection,
    openSmartCollection,
    editSmartCollection,
    reorderCollections,
    reorderingCollections,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
    deleteImageAssets,
    deleteImageAssetsFromDisk,
    setAssetRating,
  };
}
