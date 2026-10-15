import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invalidateAnnotations, seedAnnotations } from "../components/annotation/annotationStore";
import { invalidateTags, seedTags } from "../components/annotation/tagStore";
import api from "../api";
import useJobs from "./useJobs";
import useCollections from "./useCollections";
import useAssetMutations from "./useAssetMutations";
import useImportPipeline from "./useImportPipeline";
import { usePref } from "./usePref";
import { adoptLegacyPref, intIn, oneOf, readPref, writePref } from "../utils/prefs";
import { isEmptyValue,
  DEFAULT_SCOPE, LIBRARY_SORTS, appendPage, chooseSelectionAfterReload, detailIsStale, editScopeFromRules, filterItemsByQuery, foldBursts, facetScopeOf, hasRefinement, isNarrowedScope, rulesDirty,
  rulesFromScope, scopeFromRules, scopeKeyOf, rejectedFilters, sortOutsideFolder,
  shouldResetScopeForReveal,
} from "./workspaceLogic";

const PAGE_SIZE = 180;

// The library sort is remembered (utils/prefs.js): the app opens, and a
// catalog switch lands, on All Assets in the order last picked.
const SORT_PREF = "gallery.sort";
const startScope = () => ({ ...DEFAULT_SCOPE, sort: readPref(SORT_PREF, DEFAULT_SCOPE.sort, oneOf(LIBRARY_SORTS)) });

// The theme and the pane widths are remembered too. Earlier versions kept
// them under bare localStorage keys; those move under the pref keys once.
export const THEMES = ["dark", "light", "system"];
// The ranges usePaneResize drags within (App.jsx).
export const SIDEBAR_WIDTH_RANGE = [200, 360];
export const INSPECTOR_WIDTH_RANGE = [240, 420];
adoptLegacyPref("afterframe-theme", "theme");
adoptLegacyPref("afterframe-sidebar-width", "sidebarWidth", Number);
adoptLegacyPref("afterframe-inspector-width", "inspectorWidth", Number);

export default function useWorkspace({ pushToast } = {}) {
  const { t } = useTranslation("app");
  const [theme, setTheme] = usePref("theme", "dark", oneOf(THEMES));
  const [sidebarWidth, setSidebarWidth] = usePref("sidebarWidth", 240, intIn(...SIDEBAR_WIDTH_RANGE));
  const [inspectorWidth, setInspectorWidth] = usePref("inspectorWidth", 300, intIn(...INSPECTOR_WIDTH_RANGE));
  const [info, setInfo] = useState(null);
  const [summary, setSummary] = useState(null);
  const [roots, setRoots] = useState([]);
  const [items, setItems] = useState([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [detail, setDetail] = useState(null);
  // What the Inspector shows right now, for code that runs after an await.
  const detailRef = useRef(null);
  detailRef.current = detail;
  // The browse destination is ONE value. Every way of changing what the grid
  // shows (sidebar status, a collection, typed search, facet chips, sort, the
  // Discover tiles, a person, an agent reveal) writes this object; one effect
  // below browses it. Nothing reads status/filters/query as separate state
  // across an await any more — that is what let a background refresh, or an
  // older click, land last with a scope the user had already left (#68).
  const [scope, setScopeState] = useState(startScope);
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
  // The revealed photo may sit inside a folded burst: open its stack as soon
  // as its row is loaded (expandBurstOf is defined with the stacks below).
  const expandBurstRef = useRef(null);
  useEffect(() => {
    if (revealAssetRequest?.assetId) expandBurstRef.current?.(revealAssetRequest.assetId);
  }, [revealAssetRequest, items]);
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
  const { activeJobs, lastFinishedJob, pokeJobs, importRunning, cancelJob, pauseJob, resumeJob, resetJobs } = useJobs(jobsBridgeRef);

  // The three domain hooks below read this hook's state through the same
  // kind of ref: assigned after the state they need exists, before anything
  // can call them (the first calls come from effects and events).
  const importBridgeRef = useRef({});
  const importPipeline = useImportPipeline(importBridgeRef, lastFinishedJob);
  const { importTask, mirrorTask, startIncrementalImport } = importPipeline;
  const collectionsBridgeRef = useRef({});
  const collectionsApi = useCollections(collectionsBridgeRef);
  const { collections, setCollections, hasSmartCollections, loadCollections } = collectionsApi;
  const mutationsBridgeRef = useRef({});
  const assetMutations = useAssetMutations(mutationsBridgeRef);
  const { dropLoadedItems } = assetMutations;

  jobsBridgeRef.current = {
    refreshAll: (opts) => refreshAll(opts),
    startIncrementalImport,
    consumeQueuedImport: importPipeline.consumeQueuedImport,
    mirrorTask,
    // Colours changed nothing about which photos are in the grid or their
    // order: only the Colour chip (options exist now) and the open photo's
    // palette. A full refresh would re-browse and lose a scrolled position.
    // The look-alike index grew: the open photo's similar strip and the
    // sidebar's count; a grid showing look-alikes gets its new members.
    visualReady: () => {
      refreshShownDetail();
      void api.getSummary().then((next) => next && setSummary(next)).catch(() => {});
      // The rows carry their burst (and a Look-alikes grid its members):
      // re-read the loaded pages in place, as a background refresh does.
      void loadBrowser({ scope: scopeRef.current, preserveView: true });
    },
    colorsReady: () => {
      loadFacetValues();
      refreshShownDetail();
      // A grid narrowed by colour was answered from the colours the catalog
      // had at the time; new ones can change its membership.
      if (!isEmptyValue(scopeRef.current.filters?.color)) {
        void loadBrowser({ scope: scopeRef.current, preserveView: true });
      }
    },
  };
  importBridgeRef.current = {
    t, pushToast, info, summary, rawDirs, imageDirs, setRoots, pokeJobs, importRunning,
    refreshAll: (opts) => refreshAll(opts),
    refreshBrowse: () => refreshBrowse(),
    setSummary,
  };
  collectionsBridgeRef.current = {
    t, pushToast, scopeRef, updateScope,
    goTo: (next) => goTo(next),
    openSmartCollection: (collection) => openSmartCollection(collection),
    bumpCatalogRevision,
    refreshBrowse: () => refreshBrowse(),
    dropLoadedItems,
  };
  mutationsBridgeRef.current = {
    t, pushToast, itemsRef, detailRef, setItems, setDetail, scopeRef, revealRef,
    refreshBrowse: () => refreshBrowse(),
    loadCollections, hasSmartCollections,
    loadFacetValues: () => loadFacetValues(),
    bumpCatalogRevision, selectedAssetIdRef, setSelectedAssetId, setBrowserOffset,
  };

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
  }, [sidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${inspectorWidth}px`);
  }, [inspectorWidth]);

  // Backend handles sorting; the client only narrows the PREVIOUS page locally
  // so typing feels instant during the 250ms search debounce. The server result
  // then replaces `items` wholesale. Field list + the superset invariant live
  // in workspaceLogic.searchableFields.
  const filteredItems = useMemo(() => filterItemsByQuery(items, typedQuery), [items, typedQuery]);
  // Burst stacks the user has opened (burst_group ids); a new place starts
  // with them all folded. What the grid shows is filteredItems with the
  // closed stacks folded to their first frame (workspaceLogic.foldBursts).
  const [expandedBursts, setExpandedBursts] = useState(() => new Set());
  // The views that list related photos (Look-alikes, "photos like this one")
  // show every frame: folding there would hide the very photos asked for.
  const foldsBursts = scope.status !== "lookalikes" && !scope.similarTo;
  const visibleItems = useMemo(
    () => (foldsBursts ? foldBursts(filteredItems, expandedBursts) : filteredItems),
    [filteredItems, expandedBursts, foldsBursts],
  );
  const toggleBurst = useCallback((group) => {
    if (!group) return;
    setExpandedBursts((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group); else next.add(group);
      return next;
    });
  }, []);
  // A photo asked for (a reveal, a related-asset click) must be on screen,
  // so its stack opens.
  const expandBurstOf = useCallback((assetId) => {
    const group = itemsRef.current.find((item) => item.asset_id === assetId)?.burst_group;
    if (group) setExpandedBursts((current) => (current.has(group) ? current : new Set([...current, group])));
  }, []);
  expandBurstRef.current = expandBurstOf;

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
  // `navigation` counts the times goTo cleared the grid: a cleared grid is
  // always browsed again, even when the scope it ends on is the one it started
  // from (away and back within one batch of updates).
  const [navigation, setNavigation] = useState(0);
  useEffect(() => { browseCurrentScope(); }, [scopeKey, navigation]);

  // Refresh facet options when the catalog/library changes, and whenever the
  // view does: every count is "how many photos picking this would show" given
  // the folder, the search text and the other active filters. The request is tagged so a slow answer for the previous folder
  // cannot land on top of the current one.
  const facetRequestRef = useRef(0);
  // Which view the loaded options belong to: the bar says so (data-facets-ready),
  // so a count is never read for a view whose options are still on their way.
  const [facetsFor, setFacetsFor] = useState(null);
  // Reads only refs, so it is stable and refreshAll (not an effect) can call it too.
  const loadFacetValues = useCallback(() => {
    const request = ++facetRequestRef.current;
    const key = scopeKeyOf(scopeRef.current);
    void api.getFacetValues(facetScopeOf(scopeRef.current))
      .then((values) => {
        if (request !== facetRequestRef.current) return;
        setFacetValues(values);
        setFacetsFor(key);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!browserReady) return;
    loadFacetValues();
  }, [browserReady, summary?.browse_assets, summary?.image_assets, scopeKey, loadFacetValues]);

  // Re-read the photo the Inspector shows (which need not be the selected
  // card: a version sibling opened there is shown without being in the grid)
  // without competing with navigation: the result is applied only if that
  // photo is still the one shown, and a loadDetail issued meanwhile is not
  // outranked, since this never bumps the request counter.
  function refreshShownDetail() {
    const assetId = detailRef.current?.asset_id;
    if (!assetId) return;
    void api.getAssetDetailById(assetId)
      .then((payload) => {
        if (!payload) return;
        setDetail((current) => (current?.asset_id === payload.asset_id ? payload : current));
      })
      .catch(() => {});
  }

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
      // Going somewhere else: until this answer lands, the place shown before
      // is no longer surely loaded. Otherwise, going straight back to it while
      // this is out skips the browse ("already showing this"), and this
      // answer, for the place left, lands last and wins. A refresh of the
      // same place keeps the mark, which reveals rely on.
      if (scopeKeyOf(target) !== loadedScopeRef.current) loadedScopeRef.current = null;
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
          similarTo: target.similarTo || undefined,
        });
      }
      if (activeFilters?.person_group) {
        console.log("[browse] person filter result", payload?.length, "items; request", requestId,
          browserRequestIdRef.current === requestId ? "(current)" : "(SUPERSEDED — discarded)");
      }
      if (browserRequestIdRef.current !== requestId) return;
      loadedScopeRef.current = scopeKeyOf(target);
      seedAnnotations(payload);
      seedTags(payload);
      setBrowserOffset(nextOffset + payload.length);
      setBrowserHasMore(payload.length === (append ? PAGE_SIZE : pageLimit));
      if (append) {
        setItems((current) => appendPage(current, payload));
      } else {
        setItems(appendPage([], payload));
        const activeSelectedId = selectedAssetIdRef.current;
        // The pin (relatedSelectionRef) is cleared by the next ordinary gallery
        // selection through setSelectedAssetId above.
        const nextSelectedId = chooseSelectionAfterReload({
          payload, activeSelectedId, relatedPinned: relatedSelectionRef.current, preserveView,
        });
        if (nextSelectedId !== activeSelectedId) {
          setSelectedAssetId(nextSelectedId);
          await loadDetail(nextSelectedId || null);
        } else if (!preserveView || detailIsStale(detailRef.current, payload)) {
          // Same photo still selected, so nothing above reloads its detail:
          // after Refresh, a relink or a file coming back, the card changed
          // and the Inspector kept the old path and missing state.
          refreshShownDetail();
        }
      }
      setBrowserReady(true);
    } catch (error) {
      // A silent failure here leaves the gallery showing stale items while
      // every chip/sort control claims a different view — always say so.
      console.error("[browse] FAILED", error?.message || error);
      pushToast?.({ title: t("browseFailed"), message: error?.message || String(error), ttl: 6000, tone: "error" });
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
    invalidateTags();
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

  // A watched folder reported photos the catalog holds as they are on disk, so
  // nothing was imported. One a card or the Inspector shows missing was moved
  // out and put back (Put Back from the Trash): browsing stats it again. A
  // Finder tag or AirDrop on a photo shown present changes nothing here.
  const watchedPresentRef = useRef(null);
  watchedPresentRef.current = (assetIds) => {
    if (revealRef.current) return;
    const ids = new Set(assetIds || []);
    const shownMissing = (item) => ids.has(item?.asset_id) && item.exists_on_disk === false;
    if (itemsRef.current.some(shownMissing)) void refreshBrowse();
    else if (shownMissing(detailRef.current)) refreshShownDetail();
  };
  useEffect(() => {
    if (!api.has("onWatchedPresent")) return undefined;
    return api.onWatchedPresent((assetIds) => watchedPresentRef.current?.(assetIds));
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

  // "Show in All Assets": a photo found by a search, a filter, a folder or
  // another view, shown among its neighbours in the whole library — in the
  // order the toolbar has now, so sorted by capture time, the photos around it
  // are the ones taken around it.
  function revealInAllAssets(assetId) {
    return revealAsset(assetId, { inAllAssets: true });
  }

  async function revealAsset(assetId, { inAllAssets = false } = {}) {
    if (!assetId) return;
    const navigationId = ++relatedNavigationRef.current;
    const startedAt = Date.now();
    const log = (step, extra = "") => console.log(`[reveal] #${navigationId} ${step} +${Date.now() - startedAt}ms ${extra}`);
    log("start", `${assetId}${inAllAssets ? " in all" : ""}`);
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
      // The whole library, in the current order ("added to folder" has no
      // meaning outside a folder).
      const allAssets = { ...DEFAULT_SCOPE, sort: sortOutsideFolder(startScope.sort) };
      let target = inAllAssets ? allAssets : startScope;
      // Centred, so the photos before it are on screen as well as after it.
      const request = { assetId, navigationId, center: inAllAssets };
      const sameLoadedScope = loadedScopeRef.current === scopeKeyOf(target);
      // Going to All Assets, a search still in its debounce only narrows the
      // loaded page locally: the photo is loaded, and the box must clear.
      const shown = inAllAssets ? items : filteredItems;
      if (sameLoadedScope && shown.some((item) => item.asset_id === assetId)) {
        log("already loaded");
        if (inAllAssets) installLoadedScope(target);
        setRevealAssetRequest(request);
        return;
      }
      let location = await api.locateImageAsset({ assetId, ...asQuery(target) });
      log("located", JSON.stringify(location));
      if (!isCurrent()) { log("superseded after locate"); return; }
      const resetScope = !inAllAssets && shouldResetScopeForReveal({
        locationIndex: location.index, query: typedQuery, items, filteredItems, assetId,
      });
      if (resetScope) {
        target = allAssets;
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
      const nextItems = appendPage(offset === 0 ? [] : items, payload);
      if (!nextItems.some((item) => item.asset_id === assetId)) throw new Error(t("relatedAsset.missing"));
      // Either way the scope the grid now shows becomes THE scope — including
      // the absorbed search text, so the box and the grid agree.
      installLoadedScope(target);
      if (resetScope) pushToast?.({ title: t("relatedAsset.showingAll"), ttl: 4000 });
      seedAnnotations(payload);
      seedTags(payload);
      setItems(nextItems);
      setRevealAssetRequest(request);
      setBrowserOffset(offset + payload.length);
      if (count > 0) setBrowserHasMore(payload.length === count);
      setBrowserReady(true);
      log("done", `items=${nextItems.length}`);
    } catch (error) {
      log("failed", error?.message || String(error));
      const title = t(inAllAssets ? "showInAllAssets.failed" : "relatedAsset.failed");
      if (isCurrent()) pushToast?.({ title, message: error.message, tone: "error", ttl: 6000 });
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
      seedTags(collected);
      setItems(appendPage([], collected));
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

  // The rejected photos of the view on screen (its folder, search and
  // filters; the flag condition becomes "rejected"), every page of them —
  // what "Delete Rejected Photos…" acts on. Only ids and paths.
  async function collectRejected() {
    const scope = scopeRef.current;
    const filters = rejectedFilters(scope.filters);
    const search = scope.query.trim() || undefined;
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = scope.collectionId
        ? await api.browseCollection(scope.collectionId, { limit: 500, offset, search, filters, sort: scope.sort || undefined })
        : await api.browseImages({ status: scope.status, limit: 500, offset, search, filters, base: scope.base || undefined, sort: scope.sort || undefined, similarTo: scope.similarTo || undefined });
      for (const row of page || []) rows.push({ asset_id: row.asset_id, image_path: row.image_path });
      if (!page || page.length < 500) break;
    }
    return rows;
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
      // The grid no longer shows what was loaded: whatever place this ends on,
      // including the one just left, has to be browsed.
      loadedScopeRef.current = null;
      setNavigation((count) => count + 1);
      setExpandedBursts(new Set());
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

  // Leaving a folder for a view that is not the gallery (People, Discover,
  // Stickers): the library becomes the place, and the browse effect fetches it
  // behind that view, so the gallery is right the moment the user is back.
  // This used to mark the library as already shown instead of browsing it,
  // while the grid still held the folder — so a status click that then
  // cleared the grid for its destination found nothing left to browse and
  // All Assets opened empty, and coming back any other way showed the
  // folder's photos under the All Assets title.
  function clearCollection() {
    if (scopeRef.current.collectionId) goTo({});
  }

  // Opening a person is a new browse destination, not an intersection with a
  // stale text query/date/tag/rating filter from the previous gallery.
  function filterByPerson(groupId) {
    if (!groupId) return;
    goTo({ filters: { person_group: groupId } });
  }

  // "Find similar": the photos that look like this one, as a view of their own.
  function findSimilarTo(assetId) {
    if (!assetId) return;
    goTo({ similarTo: assetId });
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
  // rendered value would still be the old one. Every browse supersedes the
  // one before it, so there is no "force": a refresh always refetches.
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
    mirrorTask("import", nextImportTask);
    mirrorTask("preview", nextPreviewTask);
    mirrorTask("enrichment", nextEnrichmentTask);
    await Promise.all([loadCollections(), browsing]);
    setCatalogRevision((revision) => revision + 1);
    // Refresh facet options too (camera/lens/tag lists, ranges) so the filter
    // bar stays in sync after imports/annotation without a full reload.
    loadFacetValues();
  }

  // `switched`: main already made it the current catalog (the sample library
  // does, to import into it). Switching main again would restart the
  // resident sidecar it has just started: seconds on a slow PC.
  async function switchCatalog(nextCatalogPath, { switched = false } = {}) {
    if (!switched) await api.switchCatalog(nextCatalogPath ?? null);
    // Facet filters reference catalog-local entities (person groups, tags) —
    // carrying them across catalogs yields empty or nonsense views. The sort
    // goes back to the remembered one.
    const fresh = startScope();
    installLoadedScope(fresh);
    setItems([]);
    setDetail(null);
    setBrowserReady(false);
    setBrowserLoading(false);
    setBrowserOffset(0);
    setBrowserHasMore(true);
    importPipeline.resetImportPipeline();
    setCollections([]);
    resetJobs();
    await refreshAll({ scope: fresh });
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
        await importPipeline.addImages();
      } else if (action === "import:pick-export-files") {
        await importPipeline.addImages("files");
      } else if (action === "import:pick-export-folders") {
        await importPipeline.addImages("folders");
      } else if (action === "import:pick-source") {
        await importPipeline.addSources();
      } else if (action === "import:start") {
        await importPipeline.runImportPipeline();
      } else if (action === "import:enrich") {
        await importPipeline.runEnrichment();
      } else if (action === "import:previews") {
        await importPipeline.runPreviewGeneration();
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
    filteredItems,
    visibleItems,
    toggleBurst,
    detail,
    reloadDetail: () => loadDetail(selectedAssetId),
    selectedAssetId,
    setSelectedAssetId,
    revealAsset,
    revealInAllAssets,
    revealAssetRequest,
    // The scope, exposed field by field for the toolbar/sidebar/filter bar,
    // with setters that each write one field of it.
    status: scope.status,
    similarTo: scope.similarTo,
    findSimilarTo,
    sort: scope.sort,
    setSort: (sort) => {
      updateScope({ sort });
      // A folder-only sort ("added") is that folder's, not the library's.
      if (LIBRARY_SORTS.includes(sort)) writePref(SORT_PREF, sort);
    },
    query: typedQuery,
    setQuery: setTypedQuery,
    filters: scope.filters,
    setFilters: applyFilters,
    activeCollectionId: scope.collectionId,
    facetScope: facetScopeOf(scope),
    activeSmartCollectionId: scope.smartCollectionId,
    // Filter bar: "Save as smart collection" when there is something to save,
    // "Update" when an open smart collection's conditions were changed.
    // Filter bar: what it offers depends on the layer the user is working in.
    hasRefinement: hasRefinement(scope),
    // Less than the whole library on screen, counting what is typed in the
    // search box before its debounce lands.
    narrowed: isNarrowedScope({ ...scope, query: typedQuery }),
    editingSmartCollection: !!scope.editingRules,
    canSaveSmartCollection: !!rulesFromScope(scope),
    smartCollectionDirty: !!activeSmartCollection && rulesDirty(scope, activeSmartCollection.rules),
    activeBase: scope.collectionId ? null : scope.base,
    facetValues,
    facetsReady: facetsFor === scopeKey,
    browserLoading,
    browserReady,
    browserLoadingMore,
    browserHasMore,
    loadMoreBrowser,
    revealAssets,
    lastAgentChange,
    refreshAll,
    queuedImportNote: importPipeline.queuedImportNote,
    addImages: importPipeline.addImages,
    addImagesFromPaths: importPipeline.addImagesFromPaths,
    addSources: importPipeline.addSources,
    switchCatalog,
    runImportPipeline: importPipeline.runImportPipeline,
    runEnrichment: importPipeline.runEnrichment,
    runPreviewGeneration: importPipeline.runPreviewGeneration,
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
    createCollection: collectionsApi.createCollection,
    saveSmartCollection: collectionsApi.saveSmartCollection,
    updateSmartCollectionRules: collectionsApi.updateSmartCollectionRules,
    snapshotSmartCollection: collectionsApi.snapshotSmartCollection,
    openSmartCollection,
    editSmartCollection,
    reorderCollections: collectionsApi.reorderCollections,
    reorderingCollections: collectionsApi.reorderingCollections,
    renameCollection: collectionsApi.renameCollection,
    deleteCollection: collectionsApi.deleteCollection,
    addToCollection: collectionsApi.addToCollection,
    removeFromCollection: collectionsApi.removeFromCollection,
    deleteImageAssets: assetMutations.deleteImageAssets,
    deleteImageAssetsFromDisk: assetMutations.deleteImageAssetsFromDisk,
    setAssetRating: assetMutations.setAssetRating,
    setAssetFlag: assetMutations.setAssetFlag,
    setAssetDescription: assetMutations.setAssetDescription,
    addTagsToAssets: assetMutations.addTagsToAssets,
    collectRejected,
  };
}
