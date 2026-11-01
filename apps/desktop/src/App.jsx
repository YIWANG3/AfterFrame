import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filterTitle, fileName } from "./utils/format";
import { importTargets } from "./utils/importTargets";

// Web save targets are blob URLs — show the human filename (carried in the
// URL fragment) instead of the raw URL in toasts.
const toastPathLabel = (savePath) =>
  (api.capabilities.web ? decodeURIComponent(fileName(savePath)) : savePath);
import useWorkspace, { INSPECTOR_WIDTH_RANGE, SIDEBAR_WIDTH_RANGE } from "./hooks/useWorkspace";
import api from "./api";
import { registerRenderBridge } from "./agent/renderBridge";
import i18n from "./i18n";
import usePaneResize from "./hooks/usePaneResize";
import { usePref } from "./hooks/usePref";
import { intIn, oneOf } from "./utils/prefs";
import useSelection from "./hooks/useSelection";
import useAgentBridge from "./hooks/useAgentBridge";
import useAssetActions from "./hooks/useAssetActions";
import useCatalogCatchUp from "./hooks/useCatalogCatchUp";
import useMapDrawer, { GALLERY_MIN_HEIGHT, MAP_HANDLE_HEIGHT, MAP_MIN_HEIGHT, defaultMapHeight } from "./hooks/useMapDrawer";
import useStickerViewKeys from "./hooks/useStickerViewKeys";
import Sidebar from "./components/Sidebar";
import Toolbar, { DISPLAY_MODE_KEYS } from "./components/Toolbar";
import Gallery from "./components/Gallery";
import Inspector from "./components/Inspector";
import JobDock from "./components/JobDock";
import Lightbox from "./components/Lightbox";
import EditorOverlay from "./components/EditorOverlay";
import SettingsOverlay from "./components/SettingsOverlay";
import WelcomeOverlay from "./components/WelcomeOverlay";
import SampleCatalogBanner from "./components/SampleCatalogBanner";
import GalleryCompare from "./components/GalleryCompare";
import CollageOverlay from "./components/CollageOverlay";
import DiscoverView, { prefetchDiscover } from "./components/DiscoverView";
import FilterBar from "./components/FilterBar";
import FilterGroupsDialog from "./components/FilterGroupsDialog";
import { activeFilterCount } from "./hooks/workspaceLogic";
import MapDrawer from "./components/map/MapDrawer";
import MapResizeHandle from "./components/map/MapResizeHandle";
import { StickerToolbar, StickerGallery, StickerInspector, useStickerView } from "./components/StickerView";
import PeopleView from "./components/PeopleView";
import FoldersView from "./components/FoldersView";
import PeopleInspector from "./components/PeopleInspector";
import usePeopleGroups from "./hooks/usePeopleGroups";
import DesignSystemPanel from "./components/DesignSystemPanel";
import ToastStack, { useToasts } from "./components/Toast";
import DevStaleNotice from "./components/DevStaleNotice";
import { ConfirmHost, confirm, choose } from "./components/confirm";
import TagBatchDialog from "./components/TagBatchDialog";
import { isBinding, loadShortcuts, matchShortcut, shortcutLabel } from "./shortcuts/store";
import useAnnotationJob from "./components/annotation/useAnnotationJob";
import { invalidateAnnotations } from "./components/annotation/annotationStore";
import { invalidateTags } from "./components/annotation/tagStore";
import WindowTitleBar from "./components/WindowTitleBar";
import { shouldIgnoreKey } from "./components/editor/keys";
import { Z } from "./ui";

function hasSelfDragMarkers() {
  return window.__mediaWorkspaceDraggingAssetIds != null
    || window.__mediaWorkspaceDraggingAssetId != null;
}

function clearSelfDragMarkers() {
  window.__mediaWorkspaceDraggingAssetId = null;
  window.__mediaWorkspaceDraggingAssetIds = null;
}

export default function App() {
  // Toasts must exist before useWorkspace so menu actions (e.g. Verify Files)
  // can report their result.
  const { toasts, pushToast, dismissToast } = useToasts();
  const { t } = useTranslation("app");
  const { t: tNav } = useTranslation("nav");
  const { t: tInspector } = useTranslation("inspector");
  const workspace = useWorkspace({ pushToast });
  // Fresh-closure handle for the test backdoor, whose effect must NOT depend on
  // `workspace` (a new object each render) — re-running would clobber the
  // methods EditorOverlay merges into window.__afterframeTest.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  // How the gallery shows photos is remembered (utils/prefs.js); what it
  // shows (the view, the filters) starts fresh.
  const [displayMode, setDisplayMode] = usePref("gallery.displayMode", "grid", oneOf(DISPLAY_MODE_KEYS));
  const [thumbSize, setThumbSize] = usePref("gallery.thumbSize", 180, intIn(120, 300));
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [editorItem, setEditorItem] = useState(null);
  // The folder the editor was opened from (null in any other view): what it
  // saves can join that folder, so it is taken at open time, like the collage's.
  const [editorSourceId, setEditorSourceId] = useState(null);
  const [externalEditors, setExternalEditors] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The tab Settings opens on when something asks for one (⌘/ → shortcuts);
  // null opens the tab it was left on.
  const [settingsTab, setSettingsTab] = useState(null);
  // The photos "Add Tags…" is open for (null when it's closed).
  const [tagDialogIds, setTagDialogIds] = useState(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [proofMode, setProofMode] = useState(false);
  const [layoutItems, setLayoutItems] = useState([]);
  const [compareState, setCompareState] = useState(null);
  const [collageItems, setCollageItems] = useState(null);
  // The folder the collage was opened from (null in any other view): its
  // export can join that folder, so it is taken at open time, not at export.
  const [collageSourceId, setCollageSourceId] = useState(null);
  function openCollage(items) {
    setCollageSourceId(workspace.activeCollectionId || null);
    setCollageItems(items);
  }
  const [viewMode, setViewMode] = useState("assets"); // "assets" | "stickers" | "people" | "discover" | "folders"
  const [peopleGroup, setPeopleGroup] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const workspaceSplitRef = useRef(null);
  const mapDrawer = useMapDrawer({
    workspaceRef,
    filters: workspace.filters,
    activeCollectionId: workspace.activeCollectionId,
    splitRef: workspaceSplitRef,
    pushToast,
  });
  const { mapExpanded } = mapDrawer;

  // Back to the gallery from another view (People, Stickers, Discover): the
  // person a view opened is forgotten with it.
  function goToGallery() {
    setViewMode("assets");
    setPeopleGroup(null);
  }
  // One of the other views: a folder is left behind (useWorkspace browses
  // the library behind the view, so the gallery is right on the way back).
  function openView(mode) {
    setViewMode(mode);
    setPeopleGroup(null);
    workspace.clearCollection();
  }

  const clearPeopleGroupFilter = () => {
    if (!workspace.filters?.person_group) return workspace.filters || {};
    const { person_group, ...remaining } = workspace.filters;
    workspace.setFilters(remaining);
    return remaining;
  };

  // The person chip lives in the filter bar; when the filter goes away by any
  // route (chip ×, clear-all), the remembered group must not linger.
  useEffect(() => {
    if (!workspace.filters?.person_group) setPeopleGroup(null);
  }, [workspace.filters?.person_group]);

  // The map's viewport chip lives in the filter bar too — reveal the bar when
  // the geo filter first engages, or the filter would be active but invisible.
  // Boolean dep: the geo object itself changes on every map move.
  const hasGeoFilter = !!workspace.filters?.geo;
  useEffect(() => {
    if (hasGeoFilter) setShowFilters(true);
  }, [hasGeoFilter]);

  // One-shot per catalog: when the map first opens, resolve any pre-existing
  // AI annotation locations into map points (offline gazetteer backfill).
  // New annotations resolve inline at save time in the sidecar.
  const activeCatalogPath = workspace.info?.catalogPath || null;
  useCatalogCatchUp(mapExpanded ? activeCatalogPath : null, async () => {
    const stats = await api.resolveAiLocations();
    if ((stats?.resolved || 0) + (stats?.cleared_stale || 0) > 0) {
      workspaceRef.current.bumpCatalogRevision?.();
    }
  });

  const peopleGroups = usePeopleGroups({
    pushToast,
    enabled: viewMode === "people" || viewMode === "discover",
    catalogKey: workspace.info?.catalogPath || null,
  });

  // Warm the Discover page in the background: its data depends only on the
  // catalog state, so once the library is ready (and after every revision
  // bump) fetch it during idle time instead of on first click.
  const discoverCatalogKey = workspace.info?.catalogPath || null;
  useEffect(() => {
    if (!discoverCatalogKey || !workspace.browserReady) return undefined;
    const timer = setTimeout(() => {
      void prefetchDiscover({ catalogKey: discoverCatalogKey, catalogRevision: workspace.catalogRevision });
    }, 300);
    return () => clearTimeout(timer);
  }, [discoverCatalogKey, workspace.catalogRevision, workspace.browserReady]);

  // Once per catalog, after the grid is up: a background job the sidecar
  // answers without one when there is nothing to do. The poller follows it.
  const readyCatalogKey = workspace.browserReady ? discoverCatalogKey : null;
  const followJob = (jobType) => (started) => {
    if (started?.jobId && started.running !== false) {
      workspaceRef.current.pokeJobs?.({ jobId: started.jobId, jobType });
    }
  };
  // Photos whose preview predates the colour filter get their dominant
  // colours. New previews bring their colours as they are rendered.
  useCatalogCatchUp(api.can("colors") ? readyCatalogKey : null, async () => {
    followJob("colors")(await api.startColorAnalysis({ auto: true }));
  });
  // Photos whose preview has no look-alike hash yet get one (and, on a Mac,
  // a feature print): after an import, and once for an existing library.
  useCatalogCatchUp(api.has("startVisualAnalysis") ? readyCatalogKey : null, async () => {
    followJob("visual")(await api.startVisualAnalysis({}));
  });
  // Thumbnails made before the photo's shape was recorded get it read
  // (portrait / landscape, for the orientation filter and the layouts).
  useCatalogCatchUp(api.has("startOrientationScan") ? readyCatalogKey : null, async () => {
    followJob("orientation")(await api.startOrientationScan());
  });

  // Discover entries open the gallery as a clean destination: no inherited
  // collection/status/query/facets, filter bar shown when there is something
  // to show, map drawer opened (and flown) only for map-shaped entries.
  const openDiscoverTarget = ({ status = "all", filters = {}, collectionId = null, map = null } = {}) => {
    goToGallery();
    workspace.browseTo({ status, filters, collectionId });
    setShowFilters(Object.keys(filters).length > 0);
    mapDrawer.showMapFor(map);
  };

  const openPersonGroup = (group) => {
    if (!group?.group_id) return;
    setViewMode("assets");
    setPeopleGroup(group);
    workspace.filterByPerson(group.group_id);
    setShowFilters(true);
  };

  async function createAlbumFromPerson(group) {
    const name = group.name?.trim() || tNav("filter.person");
    try {
      const rows = await api.browseImages({
        status: "all",
        limit: 100000,
        filters: { person_group: group.group_id },
      });
      const assetIds = [...new Set((rows || []).map((row) => row.asset_id).filter(Boolean))];
      if (!assetIds.length) throw new Error(tNav("people.searchEmpty"));
      const collection = await workspace.createCollection(name);
      await workspace.addToCollection(collection.collection_id, assetIds);
      pushToast?.({
        title: tInspector("peoplePanel.albumCreated", { name, count: assetIds.length }),
        ttl: 5000,
      });
    } catch (error) {
      pushToast?.({
        title: tInspector("peoplePanel.albumFailed"),
        message: error?.message || String(error),
        ttl: 6000,
        tone: "error",
      });
    }
  }

  // Test backdoor — exposed to Playwright via window.__afterframeTest.
  // Lets E2E specs open the editor with an arbitrary file path without
  // needing a catalog seeded. Namespaced so collision risk is zero, and
  // there's no UI affordance in production to discover/trigger it.
  // Merged, never replaced: EditorOverlay installs its own methods on the
  // same object, and child effects run before this one — assigning a fresh
  // object here on the editorItem change would wipe them.
  useEffect(() => {
    Object.assign((window.__afterframeTest ??= {}), {
      openEditor(pathOrItem) {
        const item = typeof pathOrItem === "string"
          ? { image_path: pathOrItem, stem: fileName(pathOrItem) }
          : pathOrItem;
        setEditorSourceId(workspaceRef.current.activeCollectionId || null);
        setEditorItem(item);
      },
      closeEditor() { setEditorItem(null); },
      getEditorOpen() { return !!editorItem; },
      refresh() { return workspaceRef.current.refreshAll(); },
      async setLocale(lng) { await i18n.changeLanguage(lng); await api.setLocale(lng); },
    });
  }, [editorItem]);
  const stickerView = useStickerView();

  // Sticker items, shaped for Lightbox/Inspector consumers.
  const stickerItemsForLightbox = useMemo(() => {
    const q = (stickerView.query || "").trim().toLowerCase();
    const list = q
      ? stickerView.stickers.filter((s) =>
          (s.name || "").toLowerCase().includes(q) ||
          (s.sourceLabel || "").toLowerCase().includes(q) ||
          (s.sourcePath || "").toLowerCase().includes(q),
        )
      : stickerView.stickers;
    return list.map((s) => ({
      asset_id: s.id,
      image_path: s.path,
      image_preview_path: s.path,
      raw_preview_path: s.path,
      stem: s.name || s.sourceLabel || s.filename,
      image_metadata: { width: s.width, height: s.height },
    }));
  }, [stickerView.stickers, stickerView.query]);

  const stickerLightboxIndex = useMemo(() => {
    if (!stickerView.selected) return 0;
    return Math.max(0, stickerItemsForLightbox.findIndex((it) => it.asset_id === stickerView.selected.id));
  }, [stickerItemsForLightbox, stickerView.selected]);
  const handleStickerKey = useStickerViewKeys({ stickerView, items: stickerItemsForLightbox, lightboxOpen, setLightboxOpen });
  const resizeSidebar = usePaneResize(workspace.setSidebarWidth, ...SIDEBAR_WIDTH_RANGE);
  // Dragged from the right edge, so the value grows leftwards.
  const resizeInspector = usePaneResize((value) => workspace.setInspectorWidth(-value), -INSPECTOR_WIDTH_RANGE[1], -INSPECTOR_WIDTH_RANGE[0]);
  const currentItems = workspace.filteredItems;
  const orderedIds = useMemo(() => currentItems.map((item) => item.asset_id), [currentItems]);
  const itemById = useMemo(
    () => new Map(currentItems.map((item) => [item.asset_id, item])),
    [currentItems],
  );
  const {
    selectedIds, setSelectedIds, setAnchorId: setSelectionAnchorId,
    selectedIndex,
    selectSingle, selectRelatedAsset, handleItemSelect, selectByIndex,
    handleContextSelect, handleSelectionGroup, clearSelection,
    prepareDragSelection, selectByDirection,
  } = useSelection({
    orderedIds,
    itemById,
    currentItems,
    layoutItems,
    displayMode,
    primaryId: workspace.selectedAssetId,
    setPrimaryId: workspace.setSelectedAssetId,
    setRelatedPrimaryId: workspace.revealAsset,
  });
  const selectedAssetIds = selectedIds;

  // Gallery menu "Show in All Assets": just this photo stays selected, so the
  // next action doesn't pick up the rest of what was selected in the search.
  function findSimilar(assetId) {
    goToGallery();
    setSelectedIds([assetId]);
    setSelectionAnchorId(assetId);
    workspace.findSimilarTo(assetId);
  }

  function showInAllAssets(assetId) {
    setSelectedIds([assetId]);
    setSelectionAnchorId(assetId);
    void workspace.revealInAllAssets(assetId);
  }

  const [dropActive, setDropActive] = useState(false);
  const { annotate: runAnnotation } = useAnnotationJob(pushToast, workspace.pokeJobs);
  const { deleteAssets, deleteFromDisk, copyAssetField, ensureThumbnails, refreshAssetsFromDisk } = useAssetActions({ workspaceRef, itemById, pushToast });

  // webContents.startDrag only starts the OS drag; its IPC response is not a
  // drag-finished signal. Keep the self-drag markers alive until an actual
  // end/cancel signal so native file dragovers cannot look like Finder imports.
  useEffect(() => {
    function finishSelfDrag(event) {
      if (event?.type === "keydown" && event.key !== "Escape") return;
      if (!hasSelfDragMarkers()) return;
      clearSelfDragMarkers();
      setDropActive(false);
    }

    window.addEventListener("mousedown", finishSelfDrag, true);
    window.addEventListener("mouseup", finishSelfDrag, true);
    window.addEventListener("blur", finishSelfDrag);
    window.addEventListener("keydown", finishSelfDrag);
    return () => {
      window.removeEventListener("mousedown", finishSelfDrag, true);
      window.removeEventListener("mouseup", finishSelfDrag, true);
      window.removeEventListener("blur", finishSelfDrag);
      window.removeEventListener("keydown", finishSelfDrag);
    };
  }, []);

  // Agent ↔ UI bridges (reveal / agent-change toast / selection mirror) live
  // in one hook so the contract is explicit — see useAgentBridge.
  useAgentBridge({
    revealAssets: workspace.revealAssets,
    lastAgentChange: workspace.lastAgentChange,
    selectedIds,
    setSelectedIds,
    setAnchorId: setSelectionAnchorId,
    primaryId: workspace.selectedAssetId,
    itemById,
    pushToast,
    onBeforeReveal: () => {
      goToGallery();
      setLightboxOpen(false);
    },
  });

  // ── Edit-menu / keyboard asset actions ──────────────────────────────────
  // Shared by the gallery keyboard shortcuts and the native Edit menu (which
  // routes through onMenuAction). The native menu items send IPC actions so
  // ⌘A / Delete / Copy can be resolved against the live React selection.

  // Assets the Edit menu acts on: the multi-selection, else the primary one.
  const targetAssetIds = () => {
    if (selectedIds.length) return selectedIds;
    if (workspace.selectedAssetId) return [workspace.selectedAssetId];
    return [];
  };

  const selectAllAssets = () => {
    if (editorItem || viewMode !== "assets") return false;
    if (!orderedIds.length) return false;
    setSelectedIds(orderedIds);
    return true;
  };

  // What ⌘C / Edit › Copy copies: in the lightbox the photo on screen, else
  // the selection. (A RAW pair is one item; its image_path is the file the
  // user sees.)
  const copyTargetIds = () => (lightboxOpen && workspace.selectedAssetId ? [workspace.selectedAssetId] : targetAssetIds());

  // The photos as files on the clipboard — what Finder's Copy does: ⌘V in
  // Finder makes copies, WeChat / Notes get the file. Files the catalog knows
  // are gone (exists_on_disk false) are left out and said so in the toast.
  const copyAssets = async (ids) => {
    if (!api.can("fileSystem")) return;
    const items = [...new Set((ids || []).filter(Boolean))].map((id) => itemById.get(id)).filter(Boolean);
    if (!items.length) return;
    const gone = items.filter((item) => item.exists_on_disk === false).length;
    const paths = items.filter((item) => item.exists_on_disk !== false).map((item) => item.image_path).filter(Boolean);
    let result = { copied: [], missing: [] };
    try {
      if (paths.length) result = (await api.copyFiles(paths)) || result;
    } catch (error) {
      pushToast?.({ title: t("copyFilesFailed"), message: String(error?.message || error), tone: "error", ttl: 5000 });
      return;
    }
    const copied = result.copied?.length || 0;
    const skipped = gone + (result.missing?.length || 0);
    if (!copied) {
      pushToast?.({ title: t("copyFilesNone", { count: skipped || items.length }), tone: "error", ttl: 4000 });
      return;
    }
    pushToast?.({
      title: t("copiedFiles", { count: copied }),
      message: skipped ? t("copiedFilesMissing", { count: skipped }) : undefined,
      ttl: skipped ? 4000 : 2000,
    });
  };

  // Fresh-closure handle so the menu subscription below can stay a one-time
  // effect (mirrors useWorkspace's menuActionRef pattern).
  const editMenuRef = useRef(null);
  editMenuRef.current = (action) => {
    const el = document.activeElement;
    const editable = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (action === "edit:select-all") {
      // In a text field the menu's ⌘A should select text, like role:selectAll.
      if (editable) {
        if (typeof el.select === "function") el.select();
        else document.execCommand?.("selectAll");
        return;
      }
      selectAllAssets();
    } else if (action === "edit:delete") {
      if (editable || editorItem || viewMode !== "assets") return;
      void deleteAssets(targetAssetIds());
    } else if (action === "edit:delete-rejected") {
      if (editorItem) return;
      void deleteRejected();
    } else if (action === "edit:copy") {
      // Edit › Copy (the menu item, or ⌘C the renderer left to it).
      // Text first, as role:"copy" would: a text field's selection — also
      // inside the editor's panels, whose ⌘C the editor leaves alone — or
      // text selected anywhere on the page. (The field's own ⌘C copy on
      // macOS is the Edit menu's doing, so this stands in for it.)
      const pageSelection = () => String(window.getSelection?.()?.toString() || "");
      if (editable) {
        const text = typeof el.selectionStart === "number" && el.selectionEnd > el.selectionStart
          ? String(el.value).slice(el.selectionStart, el.selectionEnd)
          : el.isContentEditable ? pageSelection() : "";
        if (text) void api.copyText(text);
        return;
      }
      // The editor's own ⌘C (copy layers) never reaches here: its keydown
      // preventDefaults. A mouse click on the menu item while it is open
      // copies nothing rather than the photo behind it.
      if (editorItem) return;
      const text = pageSelection();
      if (text) { void api.copyText(text); return; }
      if (viewMode !== "assets") return;
      void copyAssets(copyTargetIds());
    } else if (action === "edit:copy-path") {
      void copyAssetField(targetAssetIds(), "path");
    } else if (action === "edit:copy-name") {
      void copyAssetField(targetAssetIds(), "name");
    }
  };
  useEffect(() => {
    if (!api.has("onMenuAction")) return undefined;
    return api.onMenuAction((action) => editMenuRef.current?.(action));
  }, []);

  // Unified finish handling: annotation results (toast + cache invalidation)
  // and auto-annotate-on-import both react to the workspace's finish events.
  // Effect event: fires once per finish event, with the current toast/i18n/
  // annotation closures rather than the ones from that render.
  const onJobFinished = useEffectEvent((fin) => {
    if (fin.jobType === "annotation") {
      invalidateAnnotations();
      // The run's tags joined the photos' own, and its captions show where
      // the user wrote no description.
      invalidateTags();
      void workspaceRef.current.reloadDetail?.();
      const r = fin.result || {};
      if (fin.status === "succeeded") {
        const failed = Number(r.failed || 0);
        pushToast?.({
          title: t("annotationComplete"),
          message: failed
            ? t("annotationCompleteWithFailed", { count: Number(r.succeeded || 0), failed })
            : t("annotationCompleteMsg", { count: Number(r.succeeded || 0) }),
          ttl: 5000,
        });
      } else if (fin.status === "cancelled") {
        pushToast?.({ title: t("annotationCancelled"), message: t("annotationKept"), ttl: 4000 });
      } else if (fin.status === "failed") {
        pushToast?.({ title: t("annotationFailed"), message: fin.error || t("jobFailed"), ttl: 7000, tone: "error" });
      }
    } else if (fin.jobType === "import" && fin.status === "succeeded") {
      // Auto-annotate on import (setting-gated; no-ops without provider/targets).
      void (async () => {
        try {
          const s = await api.getAnnotationSettings();
          if (s?.autoOnImport) runAnnotation(null, { scope: "all", onlyMissing: true });
        } catch { /* ignore */ }
      })();
      // Auto-analyze faces on import. Already-indexed photos are skipped by
      // the job, and a running people job is returned instead of doubled up.
      // Without an installed model this stays silent: the toggle is opt-in and
      // an import must never end in an error about a feature the user didn't ask for.
      if (api.can("people")) {
        void (async () => {
          try {
            const p = await api.getPeopleSettings();
            if (!p?.autoIndexOnImport || !p.activeModel?.available) return;
            const started = await api.startPeopleIndex({ priority: 1 });
            window.dispatchEvent(new CustomEvent("people-index:started", { detail: started }));
          } catch { /* ignore */ }
        })();
      }
    } else if (fin.status === "failed" && fin.jobType !== "ai_repaint") {
      // Generic failure surfacing for the other job types (the editor handles
      // ai_repaint errors inline).
      pushToast?.({
        title: t("jobTypeFailed", { job: tNav(`activity.jobs.${fin.jobType}`, fin.jobType) }),
        message: fin.error || t("jobFailed"),
        ttl: 7000,
        tone: "error",
      });
    }
  });
  useEffect(() => {
    if (workspace.lastFinishedJob) onJobFinished(workspace.lastFinishedJob);
  }, [workspace.lastFinishedJob]);

  // Drag-and-drop import: works for files dropped from Finder onto the gallery,
  // and (via main.js `open-file`) for files dropped onto the dock icon, or on
  // Windows the files a launch names. Subscribe once the catalog info has
  // loaded: files that start the app arrive before it, and importing then
  // would report "no catalog". The bridge holds them until we listen.
  const externalImportRef = useRef(null);
  externalImportRef.current = (paths, opts) => {
    if (paths?.length) workspace.addImagesFromPaths(paths, opts);
  };
  const catalogInfoLoaded = Boolean(workspace.info);
  useEffect(() => {
    if (!catalogInfoLoaded || !api.has("onExternalImport")) return undefined;
    // Register once; the old deps re-registered on every render (fresh
    // function identity) which would now accumulate listeners.
    return api.onExternalImport((paths) => externalImportRef.current?.(paths));
  }, [catalogInfoLoaded]);

  // Watched directories: live FSEvents adds/overwrites (main → renderer) reuse the same
  // import path as drag-drop / Finder-open (via externalImportRef). Marked
  // auto so they honor delete-tombstones (won't resurrect removed-on-disk files).
  useEffect(() => {
    if (!api.has("onWatchedImport")) return undefined;
    return api.onWatchedImport((paths) => externalImportRef.current?.(paths, { auto: true }));
  }, []);
  // Catch-up: once per opened catalog, find files that landed in watched dirs
  // while the app was closed. This is a CHEAP CHECK, not a re-import — a silent
  // scan-new-media pass (walk + index lookup, no EXIF/matching) lists only files
  // not yet in the catalog, then we import just those. An unchanged library
  // therefore shows nothing on startup; an import (and its toast) appears only
  // when something genuinely new is found.
  const watchedCatchUpRef = useRef(null);
  const catchUpWatchedDirs = useEffectEvent((cat) => {
    if (watchedCatchUpRef.current === cat) return;
    watchedCatchUpRef.current = cat;
    (async () => {
      const dirs = await api.getWatchedDirs?.();
      if (!dirs?.length) return;
      // Fallback for an older preload without the cheap scan: import dirs as before.
      if (!api.has?.("scanNewMedia")) {
        workspace.addImagesFromPaths(dirs, { auto: true });
        return;
      }
      const res = await api.scanNewMedia(dirs);
      const newFiles = res?.new_files || [];
      if (!newFiles.length) return; // nothing new → stay quiet
      pushToast?.({
        title: t("watchedCatchUpTitle", { count: newFiles.length }),
        message: t("watchedCatchUpMsg"),
        ttl: 5000,
      });
      workspace.addImagesFromPaths(importTargets(newFiles), { auto: true });
    })();
  });
  const catalogPath = workspace.info?.catalogPath;
  useEffect(() => {
    if (catalogPath) catchUpWatchedDirs(catalogPath);
  }, [catalogPath]);

  // Native menu → Settings (⌘,). onMenuAction is a multi-listener ipcRenderer
  // channel, so this coexists with useWorkspace's own menu handler.
  useEffect(() => {
    if (!api.has("onMenuAction")) return undefined;
    return api.onMenuAction((action) => {
      if (action === "app:open-settings") openSettings();
    });
  }, []);
  // A toast's way to a settings tab (the import summary's "Supported formats"
  // → Library), from code with no line to this component.
  useEffect(() => {
    const onOpen = (event) => openSettings(event.detail?.tab || null);
    window.addEventListener("afterframe:open-settings", onOpen);
    return () => window.removeEventListener("afterframe:open-settings", onOpen);
  }, []);

  // The user's rebound keys (Settings → Keyboard Shortcuts), before the
  // first key press if they can be.
  useEffect(() => { void loadShortcuts(); }, []);

  // First-run / no-catalog gate. info loads via refreshAll; until then info is
  // null (don't flash the welcome). In packaged mode a fresh install has no
  // catalog at all (catalogPath null) — show the welcome to create/open one.
  const noCatalog = !!workspace.info && !workspace.info.catalogPath;
  async function handleCreateCatalog() {
    const created = await api.createCatalog();
    if (created) await workspace.switchCatalog(created);
  }
  async function handleOpenCatalog() {
    const selected = await api.pickCatalog();
    if (selected) await workspace.switchCatalog(selected);
  }

  // Sample catalog: main creates/populates it on first use (openSampleCatalog)
  // and makes it the current catalog; switchCatalog then resets renderer state
  // and picks up the running import job. Reset deletes and rebuilds the same
  // catalog.
  const isSampleCatalog = !!workspace.info?.isSampleCatalog;
  async function runSampleCatalogAction(action) {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const res = await action();
      if (res?.path) await workspace.switchCatalog(res.path, { switched: true });
    } catch (err) {
      pushToast({ title: t("sample.failed"), message: String(err?.message || err), tone: "error", ttl: 6000 });
    } finally {
      setSampleBusy(false);
    }
  }
  function handleOpenSampleCatalog() {
    return runSampleCatalogAction(() => api.openSampleCatalog());
  }
  async function handleResetSampleCatalog() {
    const ok = await confirm({
      title: t("sample.resetConfirmTitle"),
      message: t("sample.resetConfirmMsg"),
      confirmLabel: t("sample.resetConfirm"),
      cancelLabel: t("cancel"),
      danger: true,
    });
    if (!ok) return;
    await runSampleCatalogAction(() => api.resetSampleCatalog());
  }

  // Agent render bridge (MCP render_collage / edit_asset / apply_frame /
  // get_editor_capabilities / show_in_app views). Handlers live in
  // src/agent/renderBridge.js; only open_view needs UI state, injected here
  // through a ref so the subscription survives re-renders without re-binding.
  const agentViewRef = useRef(null);
  agentViewRef.current = ({ view, assetIds }) => {
    const ids = (assetIds || []).map(String);
    const items = ids.map((id) => itemById.get(id)).filter(Boolean);
    switch (view) {
      case "editor": {
        if (!items[0]) throw new Error("asset not found in the current gallery view");
        if (items[0].asset_type === "video") throw new Error("cannot edit a video");
        openEditor(items[0]);
        return { opened: "editor", asset_id: items[0].asset_id };
      }
      case "collage": {
        if (items.length < 2) throw new Error("collage view needs at least 2 asset_ids");
        openCollage(items);
        return { opened: "collage", count: items.length };
      }
      case "people":
        setViewMode("people");
        return { opened: "people" };
      case "stickers":
        setViewMode("stickers");
        return { opened: "stickers" };
      default:
        throw new Error(`unknown view: ${view}`);
    }
  };
  useEffect(() => {
    return registerRenderBridge({ openView: (payload) => agentViewRef.current(payload) });
  }, []);

  // External editors for the right-click "Open with" submenu (auto-detected once).
  useEffect(() => {
    Promise.resolve(api.detectEditors?.())
      .then((list) => setExternalEditors(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);
  async function handleOpenWith(assetIds, appPath) {
    const ids = assetIds?.length ? assetIds : selectedAssetIds;
    const paths = (ids || []).map((id) => itemById.get(id)?.image_path).filter(Boolean);
    if (!paths.length || !appPath) return;
    const res = await api.openInEditor(paths, appPath);
    if (res && res.ok === false) {
      pushToast({ title: t("openWithFailed"), message: res.error || "", tone: "error", ttl: 5000 });
    }
  }

  // Block the browser's default behavior on file drops anywhere outside the
  // gallery drop zone — without this, dropping a file on the sidebar/inspector
  // would navigate away from the app and replace the UI with a file preview.
  useEffect(() => {
    function block(e) {
      // The gallery's own handler runs first and sets dropEffect="copy" then
      // calls preventDefault. Only intercept if no descendant claimed it.
      if (e.defaultPrevented) return;
      if (e.dataTransfer?.types?.includes?.("Files")) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      }
    }
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Native drag-out sessions carry real file paths, so a drag that started in
  // our own gallery looks exactly like an external file drag. The in-app drag
  // markers distinguish them — never offer/import our own drag as new files.
  function isSelfDrag() {
    return hasSelfDragMarkers();
  }
  function handleGalleryDragOver(event) {
    if (isSelfDrag()) {
      // A native drag-out can re-enter the gallery after a previous dragover
      // already activated the import affordance. Never leave that stale
      // external-import state visible for a drag that began in this gallery.
      setDropActive(false);
      return;
    }
    if (event.dataTransfer?.types?.includes?.("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!dropActive) setDropActive(true);
    }
  }
  function handleGalleryDragLeave(event) {
    // Only deactivate when the cursor leaves the section entirely.
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDropActive(false);
  }
  function handleGalleryDrop(event) {
    setDropActive(false);
    if (isSelfDrag()) {
      event.preventDefault();
      clearSelfDragMarkers();
      return;
    }
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    const paths = [];
    let unsupported = 0;
    for (const file of event.dataTransfer.files) {
      const p = api.getPathForFile(file) || file.path;
      if (p) paths.push(p);
      else unsupported += 1;
    }
    // Web bridge accepts only images; tell the user instead of silently
    // dropping their videos/RAWs (desktop resolves a path for everything).
    if (unsupported > 0 && !api.can("video")) {
      pushToast({ title: t("webUnsupportedFiles", { count: unsupported }), ttl: 6000 });
    }
    if (paths.length) workspace.addImagesFromPaths(paths);
  }

  const layoutStyle = {
    gridTemplateColumns: [
      `${workspace.sidebarWidth}px`,
      "minmax(0, 1fr)",
      `${workspace.inspectorWidth}px`,
    ].join(" "),
    gridTemplateRows: "minmax(0, 1fr)",
  };

  function openLightboxForItem(assetId) {
    if (!assetId) return;
    selectSingle(assetId);
    setProofMode(false);
    setLightboxOpen(true);
  }

  // What a rating or flag key acts on: the selection, else the photo shown.
  function keyTargets() {
    return selectedAssetIds.length
      ? selectedAssetIds
      : [workspace.selectedAssetId].filter((id) => id != null);
  }

  // Shift held with a rating or flag key: on to the next photo once it's set
  // (Lightroom's "set and advance"). One photo at a time only.
  function advanceAfter(targetIds) {
    if (targetIds.length !== 1) return;
    if (selectedIndex >= 0 && selectedIndex < currentItems.length - 1) selectByIndex(selectedIndex + 1);
  }

  function applyRating(nextRating, { advance = false } = {}) {
    const targetIds = keyTargets();
    if (!targetIds.length) return;
    void workspace.setAssetRating(targetIds, nextRating);
    if (advance) advanceAfter(targetIds);
  }

  // flag: "pick" | "reject" | "none" (P / X / U).
  function applyFlag(flag, { advance = false, ids = null } = {}) {
    const targetIds = ids?.length ? ids : keyTargets();
    if (!targetIds.length) return;
    void workspace.setAssetFlag(targetIds, flag);
    if (advance) advanceAfter(targetIds);
  }

  function openSettings(tab = null) {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  function openTagDialog(ids) {
    const list = (ids?.length ? ids : targetAssetIds()).filter(Boolean);
    if (list.length) setTagDialogIds(list);
  }

  async function applyBatchTags(tags) {
    const ids = tagDialogIds || [];
    try {
      const result = await workspace.addTagsToAssets(ids, tags);
      setTagDialogIds(null);
      pushToast({
        title: t("batchTags.added", { count: result?.asset_ids?.length ?? ids.length }),
        message: tags.join(t("batchTags.separator")),
        ttl: 3500,
      });
    } catch (error) {
      pushToast({ title: t("batchTags.failed"), message: String(error?.message || error), tone: "error", ttl: 6000 });
    }
  }

  // Lightroom's "Delete Rejected Photos…": the rejected photos of the view on
  // screen, out of the library or into the Trash, the user's choice.
  async function deleteRejected() {
    if (viewMode !== "assets" || noCatalog) return;
    let rejected;
    try {
      rejected = await workspaceRef.current.collectRejected();
    } catch (error) {
      pushToast({ title: t("rejected.failed"), message: String(error?.message || error), tone: "error", ttl: 6000 });
      return;
    }
    if (!rejected.length) {
      pushToast({ title: t("rejected.none"), message: t("rejected.noneHint", { key: shortcutLabel("flag.reject") || "X" }), ttl: 4000 });
      return;
    }
    const ids = rejected.map((row) => row.asset_id);
    const canTrash = api.can("fileSystem");
    const choice = await choose({
      title: t("rejected.title"),
      message: t("rejected.msg", { count: ids.length }),
      detail: t(canTrash ? "rejected.detail" : "rejected.detailLibraryOnly"),
      choices: [
        { id: "library", label: t("rejected.removeFromLibrary") },
        ...(canTrash ? [{ id: "trash", label: t("rejected.moveToTrash"), danger: true }] : []),
      ],
      cancelLabel: t("cancel"),
      danger: true,
    });
    if (choice === "library") {
      await workspaceRef.current.deleteImageAssets(ids);
      pushToast({ title: t("rejected.removed", { count: ids.length }), ttl: 4000 });
    } else if (choice === "trash") {
      const paths = rejected.map((row) => row.image_path).filter(Boolean);
      const result = await workspaceRef.current.deleteImageAssetsFromDisk(ids, paths);
      if (result?.failed?.length) {
        pushToast({ title: t("diskDeleteFailed", { count: result.failed.length }), tone: "error", ttl: 5000 });
      } else {
        pushToast({ title: t("rejected.trashed", { count: ids.length }), ttl: 4000 });
      }
    }
  }

  function revealSelected() {
    if (!api.can("fileSystem")) return;
    const path = itemById.get(workspace.selectedAssetId)?.image_path;
    if (path) void api.revealPath(path);
  }

  function compareSelected() {
    const ids = targetAssetIds();
    if (ids.length !== 2) {
      pushToast({ title: t("compareNeedsTwo"), ttl: 3000 });
      return;
    }
    handleCompare(ids);
  }

  function focusSearch() {
    const input = document.querySelector("[data-toolbar-search='true']");
    if (!input) return;
    input.focus();
    input.select?.();
  }


  function openEditor(target) {
    const nextItem =
      typeof target === "string"
        // The gallery context menu passes image_path; the lightbox passes an
        // asset_id. itemById is keyed by asset_id, so fall back to a path match.
        ? itemById.get(target) || [...itemById.values()].find((it) => it.image_path === target)
        // Merged over the catalog's copy, not replaced by it: the lightbox
        // passes the RAW HD preview it made on demand (preview_hd_path).
        : target?.asset_id
          ? { ...itemById.get(target.asset_id), ...target }
          : itemById.get(workspace.selectedAssetId);
    if (!nextItem) return;
    // The image editor (crop/text/stickers/repaint) doesn't apply to video.
    if (nextItem.asset_type === "video") return;
    // Decision (a): no full-quality editing on a missing original — the editor
    // would have only the downscaled preview to work from. Send them to relink.
    if (nextItem.exists_on_disk === false) {
      pushToast?.({
        title: t("missingTitle"),
        message: t("missingMsg"),
        ttl: 6000,
        tone: "error",
      });
      return;
    }
    setEditorSourceId(workspace.activeCollectionId || null);
    setEditorItem(nextItem);
  }

  function handleCompare(assetIds) {
    if (assetIds?.length !== 2) return;
    const a = itemById.get(assetIds[0]);
    const b = itemById.get(assetIds[1]);
    if (!a?.image_path || !b?.image_path) return;
    setCompareState({ items: [a, b] });
  }

  // An active filter must be on screen: a hidden bar that is still filtering is
  // how a folder comes to look empty for no visible reason.
  const filterBarVisible = showFilters || workspace.hasRefinement || workspace.editingSmartCollection;
  const activeSmartCollection = workspace.activeSmartCollectionId
    ? (workspace.collections || []).find((c) => c.collection_id === workspace.activeSmartCollectionId) || null
    : null;
  // The folders a filter can name ("in / not in"), and the dialog that edits
  // the bar's "any of these groups".
  const manualFolders = useMemo(() => (workspace.collections || []).filter((c) => c.kind === "manual"), [workspace.collections]);
  const [filterGroupsOpen, setFilterGroupsOpen] = useState(false);

  async function rewriteSmartCollection() {
    try {
      await workspace.updateSmartCollectionRules(workspace.activeSmartCollectionId);
      pushToast({ title: t("smartCollection.updated"), message: activeSmartCollection?.name, ttl: 4000 });
    } catch (error) {
      pushToast({ title: t("smartCollection.failed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
    }
  }

  function handleCollage(assetIds) {
    if (!assetIds?.length || assetIds.length < 2) return;
    const items = assetIds.map((id) => itemById.get(id)).filter(Boolean);
    if (items.length < 2) return;
    openCollage(items);
  }

  useEffect(() => {
    if (!workspace.selectedAssetId) {
      setLightboxOpen(false);
      setProofMode(false);
      setEditorItem(null);
    }
  }, [workspace.selectedAssetId]);

  // A library shortcut's action (src/shortcuts has the keys, which the user
  // can rebind). Returns false when it had nothing to act on, so the key is
  // left to whatever else wants it.
  function runLibraryShortcut(id, advance) {
    const hasTarget = selectedAssetIds.length > 0 || !!workspace.selectedAssetId;
    if (id.startsWith("rating.")) {
      if (!hasTarget) return false;
      applyRating(Number(id.slice("rating.".length)), { advance });
      return true;
    }
    switch (id) {
      case "flag.pick":
      case "flag.reject":
      case "flag.none":
        if (!hasTarget) return false;
        applyFlag(id.slice("flag.".length), { advance });
        return true;
      case "photo.addTags":
        if (!hasTarget) return false;
        openTagDialog();
        return true;
      case "photo.edit":
        if (!lightboxOpen && !workspace.selectedAssetId) return false;
        openEditor();
        return true;
      case "photo.compare":
        compareSelected();
        return true;
      case "photo.reveal":
        revealSelected();
        return true;
      case "photo.delete": {
        const ids = targetAssetIds();
        if (!ids.length) return false;
        void deleteAssets(ids);
        return true;
      }
      case "photo.deleteRejected":
        void deleteRejected();
        return true;
      case "select.all":
        return selectAllAssets();
      case "select.none":
        clearSelection();
        return true;
      case "lightbox.toggle":
        if (!workspace.selectedAssetId) return false;
        setLightboxOpen((current) => !current);
        return true;
      case "lightbox.proof":
        setProofMode((current) => !current);
        return true;
      case "view.search":
        focusSearch();
        return true;
      case "view.filters":
        setShowFilters((current) => !current);
        return true;
      case "view.map":
        mapDrawer.toggleMap();
        return true;
      case "view.thumbLarger":
      case "view.thumbSmaller": {
        const step = id === "view.thumbLarger" ? 20 : -20;
        setThumbSize((size) => Math.max(120, Math.min(300, size + step)));
        return true;
      }
      default:
        return false;
    }
  }

  // Global shortcuts. An effect event so the handler reads the current
  // selection / view / lightbox state while the listener is bound once.
  const onGlobalKeyDown = useEffectEvent((event) => {
    const typing = shouldIgnoreKey(event);
    // App-wide keys first: they work over the editor and the other views too.
    // In a text field only one with a modifier (⌘,) — a bare key is typing.
    // The native menu answers its own keys (⌘N, ⌘R…) before they get here.
    const global = matchShortcut(event, ["global"]);
    if (global && !(typing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
      if (global.id === "app.settings") {
        event.preventDefault();
        if (settingsOpen) setSettingsOpen(false);
        else openSettings();
        return;
      }
      if (global.id === "app.shortcuts") {
        event.preventDefault();
        openSettings("shortcuts");
        return;
      }
    }
    // The rest belong to the grid and the lightbox: not while the editor,
    // a compare, a collage or a dialog is over them.
    if (editorItem || viewMode === "people" || compareState || collageItems || tagDialogIds) return;
    if (event.defaultPrevented || typing) return;

    if (viewMode === "stickers") {
      if (matchShortcut(event, ["library"])?.id === "lightbox.toggle") {
        if (!stickerView.selected) return;
        event.preventDefault();
        setLightboxOpen((current) => !current);
        return;
      }
      handleStickerKey(event);
      return;
    }

    if (viewMode !== "assets") return;
    const hit = matchShortcut(event, lightboxOpen ? ["library", "lightbox"] : ["library", "gallery"]);
    if (hit) {
      if (runLibraryShortcut(hit.id, hit.advance)) event.preventDefault();
      return;
    }
    // ⌘C with photos selected copies them as files. Handled here, like ⌘A,
    // and prevented so the Edit menu's accelerator (the same action) does not
    // fire a second time; with nothing to copy the key is left to the menu,
    // which copies selected text. The web build has no file clipboard.
    if (isBinding(event, "Mod+KeyC")) {
      const ids = copyTargetIds();
      if (!ids.length || !api.can("fileSystem")) return;
      event.preventDefault();
      void copyAssets(ids);
      return;
    }

    // The fixed keys: Esc leaves proof, then the lightbox; the arrows move.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
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
  });
  useEffect(() => {
    const handleKeyDown = (event) => onGlobalKeyDown(event);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="noise-overlay h-full overflow-hidden bg-app text-text">
      {api.platform === "win32" ? <WindowTitleBar /> : null}
      <div className="relative grid h-full min-w-0 overflow-hidden" style={layoutStyle}>
        <Sidebar
          info={workspace.info}
          summary={workspace.summary}
          status={workspace.status}
          setStatus={(next) => {
            goToGallery();
            workspace.setStatusFilter(next);
          }}
          collections={workspace.collections}
          activeCollectionId={workspace.activeCollectionId}
          activeSmartCollectionId={workspace.activeSmartCollectionId}
          similarTo={workspace.similarTo}
          onOpenSmartCollection={(collection) => {
            goToGallery();
            workspace.openSmartCollection(collection);
          }}
          onEditSmartCollection={(collection) => {
            goToGallery();
            workspace.editSmartCollection(collection);
          }}
          onSnapshotSmartCollection={async (collection) => {
            try {
              const name = t("smartCollection.snapshotName", { name: collection.name });
              const folder = await workspace.snapshotSmartCollection(collection, name);
              if (folder) pushToast({ title: t("smartCollection.snapshotDone", { count: folder.count, name }), ttl: 5000 });
            } catch (error) {
              pushToast({ title: t("smartCollection.failed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
            }
          }}
          onSelectCollection={(id) => {
            goToGallery();
            clearPeopleGroupFilter();
            workspace.selectCollection(id);
          }}
          onCreateCollection={workspace.createCollection}
          onReorderCollections={workspace.reorderCollections}
          reorderingCollections={workspace.reorderingCollections}
          onRenameCollection={workspace.renameCollection}
          onDeleteCollection={workspace.deleteCollection}
          onAnnotateCollection={(collectionId) => runAnnotation(null, { scope: "collection", collectionId, onlyMissing: true })}
          onAddToCollection={workspace.addToCollection}
          stickerMode={viewMode === "stickers"}
          peopleMode={viewMode === "people"}
          discoverMode={viewMode === "discover"}
          foldersMode={viewMode === "folders"}
          onOpenDiscover={() => openView("discover")}
          onOpenStickerBrowser={() => {
            openView("stickers");
            stickerView.refresh();
          }}
          onOpenPeople={() => openView("people")}
          onOpenFolders={() => openView("folders")}
        />

        <section
          data-testid="gallery-drop-zone"
          className="relative flex min-w-0 min-h-0 flex-col overflow-hidden bg-app"
          onDragStart={() => setDropActive(false)}
          onDragOver={viewMode === "assets" ? handleGalleryDragOver : undefined}
          onDragLeave={viewMode === "assets" ? handleGalleryDragLeave : undefined}
          onDrop={viewMode === "assets" ? handleGalleryDrop : undefined}
        >
          {!noCatalog && isSampleCatalog ? (
            <SampleCatalogBanner
              onCreateOwn={handleCreateCatalog}
              onReset={handleResetSampleCatalog}
              busy={sampleBusy}
            />
          ) : null}
          {noCatalog ? (
            <WelcomeOverlay
              web={!!api.capabilities.web}
              onCreate={handleCreateCatalog}
              onOpen={handleOpenCatalog}
              onSample={handleOpenSampleCatalog}
              sampleBusy={sampleBusy}
            />
          ) : viewMode === "stickers" ? (
            <>
              <StickerToolbar
                count={stickerView.stickers.length}
                query={stickerView.query}
                setQuery={stickerView.setQuery}
              />
              <div data-testid="workspace-split" className="min-h-0 flex-1 overflow-hidden">
                <StickerGallery
                  stickers={stickerView.stickers}
                  query={stickerView.query}
                  selectedId={stickerView.selected?.id || null}
                  onSelect={stickerView.setSelected}
                  onDelete={stickerView.handleDelete}
                  loading={stickerView.loading}
                />
              </div>
            </>
          ) : viewMode === "people" ? (
            <PeopleView
              people={peopleGroups}
              onOpenGroup={openPersonGroup}
              onOpenSettings={() => openSettings()}
            />
          ) : viewMode === "discover" ? (
            <>
              <DiscoverView
                collections={workspace.collections}
                people={peopleGroups.groups}
                catalogRevision={workspace.catalogRevision}
                catalogKey={workspace.info?.catalogPath || null}
                onOpen={openDiscoverTarget}
                onOpenPerson={openPersonGroup}
                onOpenFolders={() => openView("folders")}
              />
            </>
          ) : viewMode === "folders" ? (
            <FoldersView
              collections={workspace.collections}
              onOpenFolder={(id) => {
                goToGallery();
                clearPeopleGroupFilter();
                workspace.selectCollection(id);
              }}
              onCreateFolder={workspace.createCollection}
              onRenameFolder={workspace.renameCollection}
              onDeleteFolder={workspace.deleteCollection}
              onAnnotateFolder={(collectionId) => runAnnotation(null, { scope: "collection", collectionId, onlyMissing: true })}
              pushToast={pushToast}
            />
          ) : (
            <>
              <Toolbar
                title={workspace.activeCollectionId
                  ? (workspace.collections.find((c) => c.collection_id === workspace.activeCollectionId)?.name || "Folder")
                  : (activeSmartCollection?.name
                    || (workspace.similarTo ? tNav("browse.similar")
                      : peopleGroup ? (peopleGroup.name?.trim() || tNav("filter.person")) : tNav(`browse.${workspace.status}`, filterTitle(workspace.status))))}
                query={workspace.query}
                setQuery={workspace.setQuery}
                sort={workspace.sort}
                inFolder={!!workspace.activeCollectionId}
                setSort={workspace.setSort}
                refreshAll={() => workspace.refreshAll()}
                onAddProcessed={workspace.addImages}
                onAddSources={workspace.addSources}
                onRunImport={workspace.runImportPipeline}
                onRunEnrichment={workspace.runEnrichment}
                onRunPreviews={workspace.runPreviewGeneration}
                onAnnotateMissing={() => runAnnotation(null, { scope: "all", onlyMissing: true })}
                onAnnotateAll={() => runAnnotation(null, { scope: "all", onlyMissing: false })}
                displayMode={displayMode}
                setDisplayMode={setDisplayMode}
                thumbSize={thumbSize}
                setThumbSize={setThumbSize}
                mapExpanded={mapExpanded}
                onToggleMap={mapDrawer.toggleMap}
                showFilters={filterBarVisible}
                onToggleFilters={() => setShowFilters((v) => !v)}
                filterCount={activeFilterCount(workspace.filters)}
                activityJobs={workspace.jobs}
                lastFinishedJob={workspace.lastFinishedJob}
                onCancelJob={workspace.cancelJob}
                onPauseJob={workspace.pauseJob}
                onResumeJob={workspace.resumeJob}
              />
              {filterBarVisible && (
                <FilterBar
                  facetValues={workspace.facetValues}
                  facetsReady={workspace.facetsReady}
                  filters={workspace.filters}
                  onChange={workspace.setFilters}
                  personGroup={peopleGroup}
                  onPersonGroup={setPeopleGroup}
                  facetScope={workspace.facetScope}
                  folders={manualFolders}
                  onEditGroups={() => setFilterGroupsOpen(true)}
                  smart={{
                    canSave: workspace.canSaveSmartCollection,
                    dirty: workspace.smartCollectionDirty,
                    activeName: activeSmartCollection?.name || null,
                    onSave: async (name) => {
                      try {
                        await workspace.saveSmartCollection(name);
                        pushToast({ title: t("smartCollection.saved"), message: name, ttl: 4000 });
                      } catch (error) {
                        pushToast({ title: t("smartCollection.failed"), message: String(error?.message || error), tone: "error", ttl: 7000 });
                      }
                    },
                    editing: workspace.editingSmartCollection,
                    // Rewrites the open collection from what is showing: while
                    // viewing it narrows it to the refinement, while editing it
                    // saves the bar's conditions.
                    onNarrow: () => rewriteSmartCollection(),
                    onSaveEdit: () => rewriteSmartCollection(),
                    onCancelEdit: () => { if (activeSmartCollection) workspace.openSmartCollection(activeSmartCollection); },
                  }}
                />
              )}
              {filterGroupsOpen && (
                <FilterGroupsDialog
                  groups={workspace.filters?.any_of}
                  folders={manualFolders}
                  onClose={() => setFilterGroupsOpen(false)}
                  onApply={(groups) => {
                    setFilterGroupsOpen(false);
                    const next = { ...(workspace.filters || {}) };
                    if (groups.length) next.any_of = groups;
                    else delete next.any_of;
                    workspace.setFilters(next);
                  }}
                />
              )}
              <div
                ref={workspaceSplitRef}
                className="grid min-h-0 flex-1 overflow-hidden"
                data-testid="workspace-split"
                style={{
                  // min() keeps the gallery visible even if the window shrinks
                  // below the saved drawer height.
                  gridTemplateRows: mapExpanded
                    ? `min(${mapDrawer.mapHeight}px, calc(100% - ${GALLERY_MIN_HEIGHT + MAP_HANDLE_HEIGHT}px)) ${MAP_HANDLE_HEIGHT}px minmax(0, 1fr)`
                    : "0px 0px minmax(0, 1fr)",
                  transition:
                    mapDrawer.mapResizing || window.matchMedia("(prefers-reduced-motion: reduce)").matches
                      ? "none"
                      : "grid-template-rows 400ms cubic-bezier(0.45, 0, 0.55, 1)",
                }}
              >
                <MapDrawer
                  expanded={mapExpanded}
                  status={workspace.status}
                  collectionId={workspace.activeCollectionId}
                  search={workspace.query}
                  filters={workspace.filters}
                  base={workspace.activeBase}
                  catalogKey={workspace.info?.catalogPath || null}
                  refreshToken={workspace.catalogRevision}
                  onViewportChange={mapDrawer.handleViewportChange}
                  onSelectAsset={selectSingle}
                  flyTo={mapDrawer.mapFlyTo}
                  fitBounds={mapDrawer.mapFitBounds}
                />
                {mapExpanded ? (
                  <MapResizeHandle
                    mapHeight={mapDrawer.mapHeight}
                    onHeightChange={mapDrawer.setMapHeight}
                    onResizingChange={mapDrawer.setMapResizing}
                    minHeight={MAP_MIN_HEIGHT}
                    maxHeight={mapDrawer.maxMapHeight()}
                    defaultHeight={defaultMapHeight()}
                    label={tNav("map.resize")}
                  />
                ) : (
                  <div aria-hidden="true" />
                )}
                <div className="min-h-0 overflow-hidden">
                <Gallery
                  items={currentItems}
                  selectedAssetId={workspace.selectedAssetId}
                  revealAssetRequest={workspace.revealAssetRequest}
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
                  collections={workspace.collections}
                  activeCollectionId={workspace.activeCollectionId}
                  onAddToCollection={workspace.addToCollection}
                  onRemoveFromCollection={workspace.removeFromCollection}
                  onDeleteFromCatalog={deleteAssets}
                  onDeleteFromDisk={deleteFromDisk}
                  onCopy={copyAssets}
                  onCopyPath={(ids) => copyAssetField(ids, "path")}
                  onCopyName={(ids) => copyAssetField(ids, "name")}
                  onRefreshFromDisk={refreshAssetsFromDisk}
                  onEnsureThumbnails={ensureThumbnails}
                  importRunning={Boolean(workspace.importTask?.running)}
                  onEdit={openEditor}
                  onOpenWith={handleOpenWith}
                  editors={externalEditors}
                  onCompare={handleCompare}
                  onCollage={handleCollage}
                  onAnnotate={(ids, opts) => runAnnotation(ids, opts)}
                  onFlag={(flag, ids) => applyFlag(flag, { ids })}
                  onAddTags={openTagDialog}
                  onFindSimilar={api.has("findSimilar") ? findSimilar : undefined}
                  onShowInAllAssets={workspace.narrowed ? showInAllAssets : undefined}
                />
                </div>
              </div>
              {dropActive && (
                <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-app/85 backdrop-blur-sm">
                  <div className="rounded-xl border-2 border-dashed border-[rgb(var(--accent-color))] bg-chrome/90 px-8 py-6 text-center shadow-overlay">
                    <div className="text-[15px] font-medium text-text">{t("drop.title")}</div>
                    <div className="mt-1 text-[12px] text-muted2">{t("drop.subtitle")}</div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {viewMode === "stickers" ? (
          <StickerInspector
            sticker={stickerView.selected}
            onStar={stickerView.handleStar}
          />
        ) : viewMode === "people" ? (
          <PeopleInspector
            people={peopleGroups}
            onOpenGroup={openPersonGroup}
            onCreateAlbum={createAlbumFromPerson}
            pushToast={pushToast}
          />
        ) : (
          <Inspector
            // The folder page has no photo selection; the pane shows its empty state.
            detail={viewMode === "folders" ? null : workspace.detail}
            onRatingChange={applyRating}
            onFlagChange={(flag) => applyFlag(flag)}
            onDescriptionChange={(text) => workspace.setAssetDescription([workspace.detail?.asset_id], text)}
            onAnnotated={() => workspace.reloadDetail?.()}
            onSelectAsset={selectRelatedAsset}
            onRelinked={() => workspace.refreshAll()}
            onOpenPersonGroup={openPersonGroup}
            onPeopleChanged={() => workspace.reloadDetail?.()}
            onJumpToLocation={mapDrawer.jumpToAssetLocation}
            onLocationChanged={() => workspace.bumpCatalogRevision()}
            pushToast={pushToast}
            onTagFilter={(tag) => {
              if (!tag) return;
              workspace.setFilters({ ...(workspace.filters || {}), tag });
              setShowFilters(true);
            }}
            onColorFilter={(hex) => {
              if (!hex) return;
              workspace.setFilters({ ...(workspace.filters || {}), color: hex });
              setShowFilters(true);
            }}
          />
        )}

        <div
          data-value={workspace.sidebarWidth}
          onMouseDown={resizeSidebar}
          className="pane-resize-handle absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-col-resize"
          style={{ left: `${workspace.sidebarWidth}px` }}
        />

        <div
          data-value={-workspace.inspectorWidth}
          onMouseDown={resizeInspector}
          className="pane-resize-handle absolute inset-y-0 z-20 w-3 translate-x-1/2 cursor-col-resize"
          style={{ right: `${workspace.inspectorWidth}px` }}
        />
      </div>

      {/* Single bottom-right surface: running-job cards stacked above
          transient toasts — no overlap between the two. */}
      <div className="fixed bottom-4 right-4 flex flex-col items-end gap-2" style={{ zIndex: Z.toast }}>
        <JobDock inline jobs={workspace.jobs} queuedNote={workspace.queuedImportNote} onCancel={workspace.cancelJob} onPause={workspace.pauseJob} onResume={workspace.resumeJob} />
        <ToastStack inline toasts={toasts} onDismiss={dismissToast} />
        {!api.isPackaged && <DevStaleNotice />}
      </div>
      <Lightbox
        open={lightboxOpen}
        items={viewMode === "stickers" ? stickerItemsForLightbox : currentItems}
        currentIndex={viewMode === "stickers" ? stickerLightboxIndex : Math.max(selectedIndex, 0)}
        catalogKey={activeCatalogPath}
        proofMode={viewMode === "stickers" ? false : proofMode}
        onToggleProof={viewMode === "stickers" ? undefined : (() => setProofMode((current) => !current))}
        onEdit={viewMode === "stickers" ? undefined : openEditor}
        onClose={() => {
          setProofMode(false);
          setLightboxOpen(false);
        }}
        onIndexChange={viewMode === "stickers"
          ? (idx) => {
              const item = stickerItemsForLightbox[idx];
              const sticker = stickerView.stickers.find((s) => s.id === item?.asset_id);
              if (sticker) stickerView.setSelected(sticker);
            }
          : selectByIndex
        }
      />
      <SettingsOverlay
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => { setSettingsOpen(false); setSettingsTab(null); }}
        theme={workspace.theme}
        setTheme={workspace.setTheme}
        info={workspace.info}
        summary={workspace.summary}
        onSwitchCatalog={workspace.switchCatalog}
      />
      {tagDialogIds && (
        <TagBatchDialog
          count={tagDialogIds.length}
          onApply={applyBatchTags}
          onClose={() => setTagDialogIds(null)}
        />
      )}
      <ConfirmHost />
      <EditorOverlay
        open={!!editorItem}
        item={editorItem}
        collections={workspace.collections}
        sourceCollectionId={editorSourceId}
        onAddToCollection={workspace.addToCollection}
        catalogKey={activeCatalogPath}
        onClose={() => setEditorItem(null)}
        pushToast={pushToast}
        onSaveComplete={async (savePath) => {
          // preserveView keeps the user's selection and scroll depth; without it
          // the refresh only refetches page 1 and selection jumps to the first asset.
          await workspace.refreshAll?.({ preserveView: true });
          if (savePath) {
            pushToast({
              title: t("saved"),
              message: toastPathLabel(savePath),
              ttl: 20_000,
              actions: api.has("revealPath") ? [{
                label: t("showInFinder"),
                primary: true,
                onClick: () => api.revealPath(savePath),
              }] : [],
            });
          }
        }}
      />
      {compareState && (
        <GalleryCompare
          items={compareState.items}
          catalogKey={activeCatalogPath}
          layout={compareState.layout}
          onClose={() => setCompareState(null)}
          onLayoutChange={(layout) => setCompareState((s) => s ? { ...s, layout } : s)}
        />
      )}
      <CollageOverlay
        open={!!collageItems}
        items={collageItems}
        catalogKey={activeCatalogPath}
        collections={workspace.collections}
        summary={workspace.summary}
        sourceCollectionId={collageSourceId}
        onAddToCollection={workspace.addToCollection}
        onClose={() => setCollageItems(null)}
        pushToast={pushToast}
        onExportComplete={async (savePath) => {
          await workspace.refreshAll?.();
          if (savePath) {
            pushToast({
              title: t("collageExported"),
              message: toastPathLabel(savePath),
              ttl: 20_000,
              actions: api.has("revealPath") ? [{
                label: t("showInFinder"),
                primary: true,
                onClick: () => api.revealPath(savePath),
              }] : [],
            });
          }
        }}
      />
      {!api.isPackaged && <DesignSystemPanel />}
    </div>
  );
}
