import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";

// Shared people state for the wall (PeopleView) and the right-hand
// PeopleInspector. Corrections patch the list in place — resorting only
// happens on load(), so naming a person never makes their tile jump away
// under the cursor.
export default function usePeopleGroups({ pushToast, enabled, catalogKey }) {
  const { t } = useTranslation("nav");
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [scan, setScan] = useState({ active: false, progress: 0, result: null });
  const scanWasActive = useRef(false);

  // People are per-catalog state. Switching catalogs must drop everything —
  // group ids, names and cover paths from the old library are meaningless
  // (and their previews unreadable) in the new one.
  useEffect(() => {
    setGroups([]);
    setLoaded(false);
    setFailed(false);
    setSelectedId(null);
    setScan({ active: false, progress: 0, result: null });
    scanWasActive.current = false;
  }, [catalogKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const rows = await api.listPeopleGroups();
      setGroups(Array.isArray(rows) ? rows : []);
    } catch (error) {
      console.warn("[usePeopleGroups] list failed", error);
      setGroups([]);
      setFailed(true);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (enabled && !loaded && !loading) void load();
  }, [enabled, loaded, loading, load]);

  // One poll loop owns scan state: while the people view is open we check the
  // background job, and the moment an active run finishes the wall reloads.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let ticks = 0;
    async function poll() {
      try {
        const status = await api.getPeopleIndexStatus();
        if (cancelled || !status) return;
        const active = !!status.active;
        setScan({ active, progress: Number(status.progress) || 0, result: status.result || null });
        // The job re-clusters periodically mid-scan; refresh the wall every
        // few ticks so newly found people appear while it runs.
        ticks += 1;
        if (active && ticks % 5 === 0) void load();
        if (scanWasActive.current && !active) {
          // A silent failure looks identical to "scan changed nothing" — say why.
          if (status.status === "failed") {
            pushToast?.({
              title: t("people.scanFailed"),
              message: status.error || "",
              ttl: 8000,
              tone: "error",
            });
          }
          void load();
        }
        scanWasActive.current = active;
      } catch { /* job status is advisory */ }
    }
    void poll();
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, load, pushToast, t]);

  const patch = useCallback((groupId, changes) => {
    setGroups((current) => current.map((group) => (
      group.group_id === groupId ? { ...group, ...changes } : group
    )));
  }, []);

  const remove = useCallback((groupId) => {
    setGroups((current) => current.filter((group) => group.group_id !== groupId));
    setSelectedId((current) => (current === groupId ? null : current));
  }, []);

  async function run(action, failTitle) {
    try {
      return await action();
    } catch (error) {
      pushToast?.({ title: failTitle, message: error?.message || String(error), ttl: 6000, tone: "error" });
      throw error;
    }
  }

  const rename = useCallback((groupId, name) => run(async () => {
    const updated = await api.renamePeopleGroup({ groupId, name });
    patch(groupId, { name: updated?.name ?? name, state: updated?.state ?? "confirmed" });
  }, t("people.renameFailed")), [patch, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const merge = useCallback((sourceGroupId, targetGroupId) => run(async () => {
    const target = await api.mergePeopleGroups({ sourceGroupId, targetGroupId });
    remove(sourceGroupId);
    if (target?.group_id) patch(target.group_id, { face_count: target.face_count, name: target.name, state: target.state });
  }, t("people.mergeFailed")), [patch, remove, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const startScan = useCallback(() => run(async () => {
    const status = await api.startPeopleIndex();
    if (status) {
      scanWasActive.current = !!status.active;
      setScan({ active: !!status.active, progress: Number(status.progress) || 0, result: status.result || null });
    }
  }, t("people.scanFailed")), [t]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedGroup = groups.find((group) => group.group_id === selectedId) || null;

  return {
    groups,
    loading,
    failed,
    load,
    selectedGroup,
    selectedId,
    select: setSelectedId,
    rename,
    merge,
    scan,
    startScan,
  };
}
