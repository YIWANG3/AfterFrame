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

const THUMB_EDGE = 200; // px, long edge: a ~96 px cell at 2× density

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

  const refresh = useCallback(async () => {
    if (!api.has?.("listLuts")) return null;
    setLoading(true);
    try {
      const next = await api.listLuts();
      cachedLibrary = next;
      setLibrary(next);
      return next;
    } catch (error) {
      console.warn("[lut] listing failed:", error?.message || error);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Scan when the tool is first shown in a session; later scans follow
  // imports, deletions and folder changes.
  const scannedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      scannedRef.current = false;
      // Closed: the workers' parsed tables and the text caches go too.
      releaseLutWorkers();
      return;
    }
    if (active && !scannedRef.current) {
      scannedRef.current = true;
      void refresh();
    }
  }, [open, active, refresh]);

  // ── selection ───────────────────────────────────────────────────────────
  const select = useCallback((entry) => {
    const s = editorStateRef.current;
    if (!entry || s.lut?.id === entry.id) {
      record({ ...s, lut: null });
      return;
    }
    record({ ...s, lut: { id: entry.id, name: entry.name, strength: s.lut?.strength ?? 1 } });
  }, [editorStateRef, record]);

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

  const thumbsRef = useRef(new Map()); // id → JPEG data URL (null: the LUT is broken), for thumbBase
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

  const requestThumb = useCallback((id) => {
    if (!thumbBaseRef.current || thumbsRef.current.has(id) || queueRef.current.includes(id)) return;
    queueRef.current.push(id);
    pumpRef.current();
  }, []);
  // A cell scrolled away gives its place in the queue up.
  const cancelThumb = useCallback((id) => {
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

  // ── list for the panel ──────────────────────────────────────────────────
  const groups = useMemo(() => {
    const luts = library?.luts || [];
    const q = query.trim().toLowerCase();
    const shown = q ? luts.filter((l) => l.name.toLowerCase().includes(q) || l.group.toLowerCase().includes(q)) : luts;
    const out = [];
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
  }, [library, query]);

  return {
    library, loading, importing, query, setQuery, groups, errors,
    refresh, select, setStrength, importPaths, addFolder, setLogMark, trash,
    gradedPreview, gradedId, grading, comparing, setComparing,
    requestThumb, cancelThumb, thumbFor, thumbVersion, thumbAspect: thumbBase ? thumbBase.width / thumbBase.height : 1,
  };
}
