// Getting photos in, extracted from useWorkspace (review S1-c): the import
// entry points (picker, drop, Finder open-with, watched folders), the queue
// of dirs asked for while an import runs, the per-type task cards the dock
// mirrors, and the two import-time effects (live grid refresh, re-import
// reminder). The catalog state stays in useWorkspace and arrives through
// `bridgeRef.current`, reassigned every render:
//   t, pushToast
//   info, summary                  the open catalog; the mode is decided from the summary
//   rawDirs, imageDirs, setRoots   the registered roots
//   pokeJobs(seed), importRunning()  useJobs
//   refreshAll(opts), refreshBrowse(), setSummary(summary)
// `lastFinishedJob` is a hook argument because an effect keys off it.

import { describeSkippedExtensions } from "../utils/skippedFiles";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import api from "../api";
import { collapseRootPaths, determineImportMode, fileName, mergeRoots } from "../utils/format";

const LIVE_IMPORT_REFRESH_MS = 4000;
const NO_QUEUED_IMPORT = { rawDirs: [], imageDirs: [], auto: false };

export default function useImportPipeline(bridgeRef, lastFinishedJob) {
  const [importTask, setImportTask] = useState(null);
  const [previewTask, setPreviewTask] = useState(null);
  const [enrichmentTask, setEnrichmentTask] = useState(null);
  const [pendingImport, setPendingImport] = useState(NO_QUEUED_IMPORT);
  // Dirs asked for while an import runs, replayed when it ends. Requests and
  // the finish handler go through the ref, never a render's copy, so a request
  // lands either before the handler takes the queue or after it, and then finds
  // no import running and starts its own. The state only feeds the dock's
  // "Queued changes" note.
  const pendingImportRef = useRef(NO_QUEUED_IMPORT);
  const setImportQueue = (queue) => {
    pendingImportRef.current = queue;
    setPendingImport(queue);
  };
  const queueImport = ({ rawDirs: raw = [], imageDirs: image = [], auto = false }) => {
    const queue = pendingImportRef.current;
    setImportQueue({ rawDirs: mergeRoots(queue.rawDirs, raw), imageDirs: mergeRoots(queue.imageDirs, image), auto: queue.auto || auto });
  };
  const consumeQueuedImport = () => {
    const queued = pendingImportRef.current;
    setImportQueue(NO_QUEUED_IMPORT);
    return queued;
  };

  // The legacy per-type task states (import card & friends) the job poller
  // and refreshAll mirror into.
  function mirrorTask(type, task) {
    if (type === "import") setImportTask(task);
    else if (type === "preview") setPreviewTask(task);
    else if (type === "enrichment") setEnrichmentTask(task);
  }

  // A catalog switch must not carry tasks or queued dirs across libraries.
  function resetImportPipeline() {
    setImportTask(null);
    setPreviewTask(null);
    setEnrichmentTask(null);
    setImportQueue(NO_QUEUED_IMPORT);
  }

  // Queued-changes note for the import card in the unified JobDock.
  const queuedSources = pendingImport.rawDirs.length;
  const queuedMedia = pendingImport.imageDirs.length;
  const queuedImportNote = queuedSources || queuedMedia
    ? bridgeRef.current.t("queuedChanges", { media: queuedMedia, sources: queuedSources })
    : null;

  async function startIncrementalImport({ rawDirs: nextRawDirs = [], imageDirs: nextImageDirs = [], fullCatalog = false, auto = false }) {
    const bridge = bridgeRef.current;
    let resolvedRawDirs = collapseRootPaths(nextRawDirs);
    let resolvedImageDirs = collapseRootPaths(nextImageDirs);

    if (fullCatalog) {
      resolvedRawDirs = collapseRootPaths(bridge.rawDirs);
      resolvedImageDirs = collapseRootPaths(bridge.imageDirs);
    }
    if (!resolvedRawDirs.length && !resolvedImageDirs.length) return;

    let mode = determineImportMode(bridge.summary, { rawDirs: resolvedRawDirs, imageDirs: resolvedImageDirs });
    if (mode === "source_with_media" && !resolvedImageDirs.length) {
      resolvedImageDirs = collapseRootPaths(bridge.imageDirs);
    }
    if (mode === "processed_with_sources" && resolvedRawDirs.length) {
      resolvedRawDirs = [];
    }
    mode = determineImportMode(bridge.summary, { rawDirs: resolvedRawDirs, imageDirs: resolvedImageDirs });

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
      bridge.pushToast?.({ title: String(error?.message || error), tone: "error", ttl: 6000 });
      return;
    }
    setImportTask(task);
    bridge.pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "import" } : undefined);
    // An import this window hadn't seen yet was running (an agent's, or one
    // started a moment ago): main left these dirs out, so they wait behind it
    // like any request made while an import runs.
    if (task?.busy) queueImport({ rawDirs: resolvedRawDirs, imageDirs: resolvedImageDirs, auto });
  }

  // Importing needs a catalog. In packaged first-run there is none open, so
  // guard every import entry (toolbar, drop, Finder open-with) with a clear
  // toast instead of a silent sidecar failure against a null catalog.
  function requireCatalog() {
    const bridge = bridgeRef.current;
    if (bridge.info?.catalogPath || api.capabilities.web) return true;
    bridge.pushToast?.({ title: bridge.t("noCatalogTitle"), message: bridge.t("noCatalogMsg"), tone: "error", ttl: 5000 });
    return false;
  }

  // pick: "files" | "folders" from Import Files… / Import Folder… (Windows and
  // Linux, whose dialogs can't take both); macOS passes none and gets both.
  async function addImages(pick) {
    if (!requireCatalog()) return;
    const selected = await api.pickDirectories("image", pick);
    await addImagesFromPaths(selected);
  }

  // When a folder is imported, offer to watch it (auto-import future drops).
  // No-ops for file imports and for folders already watched — so it stays quiet
  // for live watched-dir imports and drag-dropped individual files.
  async function maybePromptWatch(selected) {
    if (!api.has?.("statDirs")) return;
    const { t, pushToast } = bridgeRef.current;
    try {
      const dirs = (await api.statDirs(selected)) || [];
      if (!dirs.length) return;
      const watched = (await api.getWatchedDirs?.()) || [];
      const fresh = dirs.filter((d) => !watched.includes(d));
      if (!fresh.length) return;
      pushToast?.({
        title: t("watchPromptTitle"),
        message: fresh.length === 1
          ? t("watchPromptMsg", { dir: fileName(fresh[0]) || fresh[0] })
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
    const bridge = bridgeRef.current;
    const nextRoots = mergeRoots(bridge.imageDirs, selected);
    bridge.setRoots((current) => [...current, ...selected.map((path) => ({ root_type: "image", path }))]);
    // Asked now, not read from this render's importTask: that is from before
    // the awaits (a picker can stay open for as long as the user likes), and
    // queueing behind an import that has ended since would leave these dirs
    // waiting for nothing.
    if (bridge.importRunning()) {
      queueImport({ imageDirs: selected, auto });
      return;
    }
    await startIncrementalImport({ imageDirs: nextRoots.length ? selected : [], auto });
    await bridge.refreshAll();
  }

  async function addSources() {
    if (!requireCatalog()) return;
    const selected = await api.pickDirectories("raw");
    if (!selected.length) return;
    await api.registerRoots("raw", selected);
    const bridge = bridgeRef.current;
    bridge.setRoots((current) => [...current, ...selected.map((path) => ({ root_type: "raw", path }))]);
    // As in addImagesFromPaths: decided after the picker and the awaits.
    if (bridge.importRunning()) {
      queueImport({ rawDirs: selected });
      return;
    }
    await startIncrementalImport({ rawDirs: selected, imageDirs: bridge.imageDirs });
    await bridge.refreshAll();
  }

  async function runImportPipeline() {
    if (!requireCatalog()) return;
    if (importTask?.running) return;
    await startIncrementalImport({ fullCatalog: true });
    await bridgeRef.current.refreshAll();
  }

  async function runEnrichment() {
    if (importTask?.running || enrichmentTask?.running) return;
    const task = await api.startEnrichment();
    setEnrichmentTask(task);
    bridgeRef.current.pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "enrichment" } : undefined);
  }

  async function runPreviewGeneration(kind = "preview") {
    if (importTask?.running || previewTask?.running) return;
    const task = await api.startPreviewGeneration(kind);
    setPreviewTask(task);
    bridgeRef.current.pokeJobs(task?.jobId ? { jobId: task.jobId, jobType: "preview", kind } : undefined);
  }

  // Show what an import has added while it runs. The importer commits each
  // photo as it indexes it, but the grid used to reload only when the whole
  // job ended: on a drive, hours of an empty library while the dock counted
  // thousands of indexed files (#130). A light refresh every few seconds,
  // keeping the scroll position; skipped while the window is hidden or the
  // previous one is still loading.
  const liveImportRefreshRef = useRef(false);
  const refreshDuringImport = useEffectEvent(async () => {
    if (liveImportRefreshRef.current || document.hidden) return;
    liveImportRefreshRef.current = true;
    const bridge = bridgeRef.current;
    try {
      await Promise.all([
        bridge.refreshBrowse(),
        api.getSummary().then(bridge.setSummary).catch(() => {}),
      ]);
    } finally {
      liveImportRefreshRef.current = false;
    }
  });
  useEffect(() => {
    if (!importTask?.running) return undefined;
    const timer = setInterval(() => void refreshDuringImport(), LIVE_IMPORT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [importTask?.running, importTask?.jobId]);

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
    const { t, pushToast } = bridgeRef.current;
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
    // Files the import walked past because the catalog doesn't take their
    // type (a .docx in the folder, a .psb): said once, with what they were,
    // and a way to the list of what does import. Sidecars (.xmp, .thm) are
    // counted apart and not mentioned (docs/format-support-plan.md §4.4).
    const unsupported = resolve?.result?.skipped_unsupported;
    if (unsupported?.count > 0) {
      pushToast?.({
        title: t("importSkippedUnsupported", { count: unsupported.count }),
        message: t("importSkippedUnsupportedMsg", { kinds: describeSkippedExtensions(unsupported.by_extension, t("importSkippedNoExtension")) }),
        ttl: 9000,
        actions: [{
          label: t("importSupportedFormats"),
          primary: true,
          onClick: () => window.dispatchEvent(new CustomEvent("afterframe:open-settings", { detail: { tab: "library" } })),
        }],
      });
    }
    // One toast per finished import; the bridge (a stable ref) only formats it.
  }, [lastFinishedJob, bridgeRef]);

  return {
    importTask,
    previewTask,
    enrichmentTask,
    queuedImportNote,
    mirrorTask,
    consumeQueuedImport,
    resetImportPipeline,
    startIncrementalImport,
    addImages,
    addImagesFromPaths,
    addSources,
    runImportPipeline,
    runEnrichment,
    runPreviewGeneration,
  };
}
