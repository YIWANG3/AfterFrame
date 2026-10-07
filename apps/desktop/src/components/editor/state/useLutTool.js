// The editor's LUT tool (docs/lut-plan.md §4): the library list, the chosen
// LUT and its strength (in the editor history, editorState.lut), the graded
// preview, and the per-LUT thumbnails of the current photo.
//
// The preview is graded once at full strength; the strength slider only
// changes how much of it is drawn over the photo (globalAlpha), the same mix
// the save computes, so dragging it costs nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../../api";
import { confirm } from "../../confirm";
import {
  forgetLut, gradeCanvas, gradePixels, isLutFault, LutError, releaseLutWorkers, thumbnailConcurrency,
} from "../lut/lutPool";

const THUMB_EDGE = 280; // px, long edge: a ~140 px cell (two columns) at 2× density

// One scan shared by every editor session: rescanning on each open is cheap
// (the main process caches headers) but there is no need to.
let cachedLibrary = null;

function errorCode(error) {
  return error instanceof LutError ? error.code : error?.code || "failed";
}

export function useLutTool({
  open, active, previewSource, transformedPreview, editorStateRef, lut,
  apply, record, pushToast, t,
}) {
  const [library, setLibrary] = useState(cachedLibrary);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [errors, setErrors] = useState({}); // id → code
  const [graded, setGraded] = useState(null); // { key, canvas }
  const [grading, setGrading] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [thumbVersion, setThumbVersion] = useState(0);
  const thumbsRef = useRef(new Map()); // id → JPEG data URL (null: the LUT is broken), for thumbBase

  const refreshingRef = useRef(null);
  const refresh = useCallback(() => {
    if (!api.has?.("listLuts")) return Promise.resolve(null);
    if (refreshingRef.current) return refreshingRef.current; // one scan at a time
    setLoading(true);
    refreshingRef.current = (async () => {
      try {
        const next = await api.listLuts();
        // A file replaced in place keeps its id: forget what was made from it.
        const before = new Map((cachedLibrary?.luts || []).map((l) => [l.id, l.bytes]));
        for (const l of next.luts) {
          if (before.has(l.id) && before.get(l.id) !== l.bytes) {
            forgetLut(l.id);
            thumbsRef.current.delete(l.id);
          }
        }
        cachedLibrary = next;
        setLibrary(next);
        return next;
      } catch (error) {
        console.warn("[lut] listing failed:", error?.message || error);
        return null;
      } finally {
        setLoading(false);
        refreshingRef.current = null;
      }
    })();
    return refreshingRef.current;
  }, []);

  // Scan when the tool is first shown in a session, and again whenever the
  // window comes back to the front while it's open: LUTs dropped into (or
  // taken out of) the library folder or an added folder in Finder show up
  // without a button to press. Imports, deletions and folder changes rescan
  // on their own.
  const scannedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      scannedRef.current = false;
      clearTimeout(stepCommitRef.current);
      setCursor(null);
      // Closed: the workers' parsed tables and the text caches go too.
      releaseLutWorkers();
      return;
    }
    if (active && !scannedRef.current) {
      scannedRef.current = true;
      void refresh();
    }
  }, [open, active, refresh]);
  useEffect(() => {
    if (!open || !active) return undefined;
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, active, refresh]);

  // ── selection ───────────────────────────────────────────────────────────
  // A LUT settled on goes first among the recent ones; the list reorders in
  // place from the answer (no rescan). Not while choosing from Recent itself:
  // the cell would jump to the top under the pointer, and the arrow keys
  // would walk back over the same few.
  const noteUsed = useCallback(async (id, groupKey) => {
    if (!api.has?.("noteLutUsed")) return;
    const res = await api.noteLutUsed(id).catch(() => null);
    if (!Array.isArray(res?.recent) || groupKey === "recent") return;
    const rank = new Map(res.recent.map((rid, i) => [rid, i]));
    setLibrary((lib) => {
      if (!lib) return lib;
      const next = { ...lib, luts: lib.luts.map((l) => ({ ...l, recent: rank.has(l.id) ? rank.get(l.id) : -1 })) };
      cachedLibrary = next;
      return next;
    });
  }, []);

  // Which cell the keyboard moves from: a LUT can sit in Favourites or Recent
  // as well as in its own group, so the id alone is not a place.
  const [cursor, setCursor] = useState(null); // { groupKey, id }
  const stepCommitRef = useRef(null);

  const select = useCallback((entry, groupKey = null) => {
    clearTimeout(stepCommitRef.current);
    const s = editorStateRef.current;
    if (!entry || s.lut?.id === entry.id) {
      record({ ...s, lut: null });
      return;
    }
    setCursor({ groupKey, id: entry.id });
    record({ ...s, lut: { id: entry.id, name: entry.name, strength: s.lut?.strength ?? 1 } });
    void noteUsed(entry.id, groupKey);
  }, [editorStateRef, record, noteUsed]);

  // The arrow keys browse: each press shows the next LUT at once, but only
  // the one the user stops on becomes an undo step (and a recent one), so
  // flicking through fifty LUTs isn't fifty undos.
  const browseTo = useCallback((entry, groupKey) => {
    const s = editorStateRef.current;
    setCursor({ groupKey, id: entry.id });
    apply({ ...s, lut: { id: entry.id, name: entry.name, strength: s.lut?.strength ?? 1 } });
    clearTimeout(stepCommitRef.current);
    stepCommitRef.current = setTimeout(() => {
      record(editorStateRef.current);
      void noteUsed(entry.id, groupKey);
    }, 700);
  }, [editorStateRef, apply, record, noteUsed]);
  useEffect(() => () => clearTimeout(stepCommitRef.current), []);

  // Live while dragging (no history entry), recorded once on release.
  const setStrength = useCallback((value, { commit = false } = {}) => {
    const s = editorStateRef.current;
    if (!s.lut) return;
    const next = { ...s, lut: { ...s.lut, strength: Math.min(1, Math.max(0, value)) } };
    if (commit) record(next);
    else apply(next);
  }, [editorStateRef, apply, record]);

  // ── graded preview ──────────────────────────────────────────────────────
  const lutId = lut?.id || null;
  const gradeKey = open && lutId && previewSource ? lutId : null;
  useEffect(() => {
    if (!gradeKey) {
      setGraded(null);
      return undefined;
    }
    let cancelled = false;
    setGrading(true);
    gradeCanvas(previewSource, gradeKey, 1)
      .then((canvas) => {
        if (cancelled) return;
        setGraded({ key: gradeKey, source: previewSource, canvas });
        setErrors((e) => (e[gradeKey] ? { ...e, [gradeKey]: undefined } : e));
      })
      .catch((error) => {
        if (cancelled) return;
        setGraded(null);
        setErrors((e) => ({ ...e, [gradeKey]: errorCode(error) }));
      })
      .finally(() => { if (!cancelled) setGrading(false); });
    return () => { cancelled = true; };
  }, [gradeKey, previewSource]);
  // Switching from one LUT to another keeps showing the previous grade until
  // the new one is ready (~0.1 s), rather than flashing the ungraded photo in
  // between. Only clearing the LUT, a new picture or a LUT that fails drops it.
  const current = gradeKey && graded && graded.source === previewSource ? graded : null;
  const gradedPreview = current?.canvas || null;
  const gradedId = current?.key || null;

  // ── thumbnails ──────────────────────────────────────────────────────────
  // The photo (rotated/flipped, uncropped, ungraded) at THUMB_EDGE; each LUT
  // is applied to a copy of it. Cached per photo state, made only for the
  // cells on screen (the panel asks through requestThumb), a few at a time.
  const thumbBase = useMemo(() => {
    if (!open || !active || !transformedPreview) return null;
    const scale = Math.min(1, THUMB_EDGE / Math.max(transformedPreview.width, transformedPreview.height));
    const width = Math.max(1, Math.round(transformedPreview.width * scale));
    const height = Math.max(1, Math.round(transformedPreview.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(transformedPreview, 0, 0, width, height);
    return { width, height, pixels: ctx.getImageData(0, 0, width, height).data };
  }, [open, active, transformedPreview]);

  const queueRef = useRef([]);
  const inFlightRef = useRef(new Set());
  const retriesRef = useRef(new Map()); // id → transient failures so far
  // Work outlives a render: it reads the current base through the ref, so a
  // thumbnail made for the photo before a rotation is dropped rather than
  // cached for the new one.
  const thumbBaseRef = useRef(thumbBase);
  thumbBaseRef.current = thumbBase;
  useEffect(() => {
    thumbsRef.current = new Map();
    queueRef.current = [];
    retriesRef.current = new Map();
    setThumbVersion((v) => v + 1);
  }, [thumbBase]);

  // Keeps one thumbnail per worker in flight (they're spread by LUT).
  const pumpRef = useRef(null);
  pumpRef.current = () => {
    const limit = thumbnailConcurrency();
    while (inFlightRef.current.size < limit && queueRef.current.length) {
      const id = queueRef.current.shift();
      const base = thumbBaseRef.current;
      if (!base || thumbsRef.current.has(id) || inFlightRef.current.has(id)) continue;
      inFlightRef.current.add(id);
      gradePixels(id, base.pixels.slice(), 1)
        .then((pixels) => {
          if (base !== thumbBaseRef.current) return;
          const canvas = document.createElement("canvas");
          canvas.width = base.width;
          canvas.height = base.height;
          canvas.getContext("2d").putImageData(new ImageData(pixels, base.width, base.height), 0, 0);
          thumbsRef.current.set(id, canvas.toDataURL("image/jpeg", 0.85));
          setErrors((e) => (e[id] ? { ...e, [id]: undefined } : e));
        })
        .catch((error) => {
          if (base !== thumbBaseRef.current) return;
          const tries = (retriesRef.current.get(id) || 0) + 1;
          retriesRef.current.set(id, tries);
          if (isLutFault(error) || tries >= 3) {
            // The file itself is at fault (or it keeps failing): say so.
            thumbsRef.current.set(id, null);
            setErrors((e) => ({ ...e, [id]: errorCode(error) }));
          } else {
            queueRef.current.push(id); // a hiccup: try again
          }
        })
        .finally(() => {
          inFlightRef.current.delete(id);
          setThumbVersion((v) => v + 1);
          pumpRef.current();
        });
    }
  };

  // A LUT can be on screen twice (in Favourites and in its pack): count the
  // cells that want it, and give its place in the queue up only when none do.
  const wantedRef = useRef(new Map()); // id → cells in view
  const requestThumb = useCallback((id) => {
    wantedRef.current.set(id, (wantedRef.current.get(id) || 0) + 1);
    if (!thumbBaseRef.current || thumbsRef.current.has(id) || queueRef.current.includes(id)) return;
    queueRef.current.push(id);
    pumpRef.current();
  }, []);
  const cancelThumb = useCallback((id) => {
    const left = Math.max(0, (wantedRef.current.get(id) || 0) - 1);
    if (left) {
      wantedRef.current.set(id, left);
      return;
    }
    wantedRef.current.delete(id);
    queueRef.current = queueRef.current.filter((x) => x !== id);
  }, []);
  const thumbFor = useCallback((id) => thumbsRef.current.get(id), []);

  // ── library actions ─────────────────────────────────────────────────────
  const afterImport = useCallback(async (res) => {
    if (!res || res.canceled) return;
    const imported = res.imported?.length || 0;
    const duplicates = res.duplicates?.length || 0;
    const failed = res.failed || [];
    const next = await refresh();
    // Select what was just brought in (or the copy already there).
    const firstId = res.imported?.[0] || res.duplicates?.[0];
    const entry = next?.luts?.find((l) => l.id === firstId);
    if (entry && (imported + duplicates) === 1) select(entry);
    const parts = [];
    if (imported) parts.push(t("lut.importedCount", { count: imported }));
    if (duplicates) parts.push(t("lut.duplicateCount", { count: duplicates }));
    if (failed.length) parts.push(t("lut.failedCount", { count: failed.length }));
    pushToast?.({
      title: imported || duplicates ? t("lut.importDone") : t("lut.importNothing"),
      message: [parts.join(" · "), failed.slice(0, 3).map((f) => `${f.name}: ${t(`lut.errors.${f.error}`, { defaultValue: f.error })}`).join("\n")]
        .filter(Boolean).join("\n"),
      tone: failed.length && !imported && !duplicates ? "error" : undefined,
      ttl: failed.length ? 9000 : 4000,
    });
  }, [refresh, select, pushToast, t]);

  const importPaths = useCallback(async (paths) => {
    if (!api.has?.("importLuts")) return;
    setImporting(true);
    try {
      await afterImport(await api.importLuts(paths || null));
    } finally {
      setImporting(false);
    }
  }, [afterImport]);

  const addFolder = useCallback(async () => {
    const res = await api.addLutFolder(null);
    if (res?.error) {
      pushToast?.({ title: t(`lut.errors.${res.error}`, { defaultValue: res.error }), tone: "error", ttl: 6000 });
      return;
    }
    if (!res?.canceled) await refresh();
  }, [refresh, pushToast, t]);

  // An added folder that can't be read (moved, renamed, its drive away):
  // point at where it is now, or stop reading it. Neither touches a file.
  const relocateFolder = useCallback(async (oldPath) => {
    const res = await api.addLutFolder(null);
    if (res?.error) {
      pushToast?.({ title: t(`lut.errors.${res.error}`, { defaultValue: res.error }), tone: "error", ttl: 6000 });
      return;
    }
    if (res?.canceled) return;
    if (res?.folder && res.folder !== oldPath) await api.removeLutFolder(oldPath);
    await refresh();
  }, [refresh, pushToast, t]);

  const removeFolder = useCallback(async (folderPath) => {
    await api.removeLutFolder(folderPath);
    await refresh();
  }, [refresh]);

  const setLogMark = useCallback(async (entry, isLog) => {
    // Back to the guess when the mark would say what the guess says.
    const mark = isLog === !!entry.logGuess ? null : (isLog ? "log" : "normal");
    await api.setLutLogMark(entry.id, mark);
    await refresh();
  }, [refresh]);

  const trash = useCallback(async (entry) => {
    const ok = await confirm({
      title: t("lut.trashTitle"),
      message: t("lut.trashMessage", { name: entry.name }),
      confirmLabel: t("lut.trashConfirm"),
      cancelLabel: t("lut.cancel"),
      danger: true,
    });
    if (!ok) return;
    const res = await api.trashLut(entry.id);
    if (res?.error) {
      pushToast?.({ title: t("lut.trashFailed"), message: res.message || res.error, tone: "error", ttl: 6000 });
      return;
    }
    forgetLut(entry.id);
    if (editorStateRef.current.lut?.id === entry.id) select(null);
    await refresh();
  }, [editorStateRef, refresh, select, pushToast, t]);

  const toggleFavorite = useCallback(async (entry) => {
    const res = await api.setLutFavorite(entry.id, !entry.favorite).catch(() => null);
    if (!res?.ok) return;
    setLibrary((lib) => {
      if (!lib) return lib;
      const next = { ...lib, luts: lib.luts.map((l) => (l.id === entry.id ? { ...l, favorite: res.favorite } : l)) };
      cachedLibrary = next;
      return next;
    });
  }, []);

  // ── view: what the list shows, and how big ──────────────────────────────
  // A per-person convenience, so the browser keeps it (not the history, not
  // the settings file).
  const [view, setViewState] = useState(readView);
  const setView = useCallback((patch) => {
    setViewState((v) => {
      const next = { ...v, ...patch };
      try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* private mode: not remembered */ }
      return next;
    });
  }, []);

  // ── list for the panel ──────────────────────────────────────────────────
  // Favourites and Recent come first (when the filter is All), then each pack
  // and folder. A LUT may therefore show twice: in Favourites and in its pack.
  const groups = useMemo(() => {
    const luts = library?.luts || [];
    const q = query.trim().toLowerCase();
    const shown = luts.filter((l) => (!view.hideLog || !l.log)
      && (view.filter !== "favorites" || l.favorite)
      && (!q || l.name.toLowerCase().includes(q) || l.group.toLowerCase().includes(q)));
    const out = [];
    if (view.filter === "all") {
      const favs = shown.filter((l) => l.favorite);
      if (favs.length) out.push({ key: "favorites", special: "favorites", luts: favs });
      const recent = shown.filter((l) => l.recent >= 0).sort((a, b) => a.recent - b.recent);
      if (recent.length) out.push({ key: "recent", special: "recent", luts: recent });
    }
    let current = null;
    for (const l of shown) {
      const key = `${l.source}|${l.root}|${l.group}`;
      if (!current || current.key !== key) {
        current = { key, title: l.group, source: l.source, root: l.root, luts: [] };
        out.push(current);
      }
      current.luts.push(l);
    }
    return out;
  }, [library, query, view.filter, view.hideLog]);

  return {
    library, loading, importing, query, setQuery, groups, errors,
    refresh, select, browseTo, cursor, setStrength, importPaths, addFolder, relocateFolder, removeFolder,
    setLogMark, toggleFavorite, trash, view, setView,
    gradedPreview, gradedId, grading, comparing, setComparing,
    requestThumb, cancelThumb, thumbFor, thumbVersion, thumbAspect: thumbBase ? thumbBase.width / thumbBase.height : 1,
  };
}

const VIEW_KEY = "afterframe.lut.view";
const VIEW_DEFAULT = { filter: "all", hideLog: false, columns: 3 };
function readView() {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    return {
      filter: stored?.filter === "favorites" ? "favorites" : "all",
      hideLog: stored?.hideLog === true,
      columns: stored?.columns === 2 ? 2 : 3,
    };
  } catch {
    return { ...VIEW_DEFAULT };
  }
}
