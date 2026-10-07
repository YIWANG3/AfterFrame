// LUT tool panel (docs/lut-plan.md §4): the current photo through each LUT
// in the library, grouped by folder; the chosen one's strength; import and
// "add a folder" (read in place, no copy). Presentational: useLutTool owns
// the state, EditorOverlay draws the graded photo.

import { useEffect, useRef, useState } from "react";
import {
  Search, FileInput, FolderPlus, FolderOpen, Eye, X, ChevronDown, ChevronRight,
  Trash2, Tag, Undo2, Redo2, AlertTriangle,
} from "lucide-react";
import api from "../../api";
import { Spinner } from "../../ui";
import FaceMenu from "../FaceMenu";
import { formatBytes } from "../../utils/format";

function LogBadge({ t }) {
  return (
    <span
      className="pointer-events-none rounded bg-black/65 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300"
      title={t("lut.logHint")}
      data-testid="lut-log-badge"
    >
      Log
    </span>
  );
}

// One LUT: the photo graded by it, made when the cell scrolls into view.
function LutCell({ entry, selected, error, thumb, aspect, scrollRoot, onRequest, onCancel, onClick, onContextMenu, t }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || thumb !== undefined) return undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onRequest(entry.id);
        else onCancel(entry.id);
      }
    }, { root: scrollRoot?.current || null, rootMargin: "200px 0px" });
    observer.observe(el);
    return () => {
      observer.disconnect();
      onCancel(entry.id);
    };
  }, [entry.id, thumb, scrollRoot, onRequest, onCancel]);

  const broken = error || entry.error;
  return (
    <button
      ref={ref}
      type="button"
      data-lut-cell={entry.id}
      data-lut-name={entry.name}
      data-selected={selected ? "true" : "false"}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={broken ? `${entry.name} · ${t(`lut.errors.${broken}`, { defaultValue: broken })}` : entry.name}
      className="group flex min-w-0 flex-col gap-1 text-left"
    >
      <div
        className={[
          "relative w-full overflow-hidden rounded-md bg-app transition",
          selected ? "ring-2 ring-[rgb(var(--accent-color))]" : "ring-1 ring-border/50 group-hover:ring-border",
        ].join(" ")}
        style={{ aspectRatio: String(Math.min(1.5, Math.max(0.75, aspect))) }}
      >
        {broken ? (
          <div className="absolute inset-0 flex items-center justify-center text-amber-400/80">
            <AlertTriangle className="h-4 w-4" />
          </div>
        ) : thumb ? (
          <img src={thumb} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 animate-pulse bg-hover/60" />
        )}
        {entry.log ? <div className="absolute left-1 top-1"><LogBadge t={t} /></div> : null}
      </div>
      <span className={["truncate text-[10.5px] leading-tight", selected ? "text-text" : "text-muted"].join(" ")}>
        {entry.name}
      </span>
    </button>
  );
}

function baseLabel(base, t) {
  if (!base) return null;
  return t(`lut.base.${base}`);
}

export default function LutPanel({
  t, tool, lut, base, onUndo, onRedo, canUndo, canRedo,
}) {
  const scrollRef = useRef(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [dropActive, setDropActive] = useState(false);
  const {
    library, loading, importing, query, setQuery, groups, errors,
    select, setStrength, importPaths, addFolder, setLogMark, trash,
    grading, setComparing, requestThumb, cancelThumb, thumbFor, thumbAspect,
  } = tool;
  const selectedEntry = lut ? library?.luts?.find((l) => l.id === lut.id) : null;
  const selectedError = lut ? errors[lut.id] || selectedEntry?.error : null;
  const total = library?.luts?.length || 0;
  const strengthPct = Math.round((lut?.strength ?? 1) * 100);

  const isFileDrag = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  async function handleDrop(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const paths = [...(event.dataTransfer?.files || [])]
      .map((file) => api.getPathForFile(file) || file.path)
      .filter(Boolean);
    if (paths.length) await importPaths(paths);
  }

  const menuItems = menu ? [
    { key: "reveal", icon: FolderOpen, label: t("lut.revealInFinder"), onClick: () => api.revealLut(menu.entry.id) },
    menu.entry.log
      ? { key: "unmark", icon: Tag, label: t("lut.unmarkLog"), onClick: () => setLogMark(menu.entry, false) }
      : { key: "mark", icon: Tag, label: t("lut.markLog"), onClick: () => setLogMark(menu.entry, true) },
    ...(menu.entry.source === "library"
      ? [{ key: "trash", icon: Trash2, label: t("lut.moveToTrash"), danger: true, onClick: () => trash(menu.entry) }]
      : []),
  ] : [];

  return (
    <div
      className="relative flex max-h-[calc(100vh-10rem)] flex-col"
      data-testid="lut-panel"
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDropActive(false); }}
      onDrop={handleDrop}
    >
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">{t("lut.title")}</div>
          <div className="flex items-center gap-1">
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-35" onClick={onUndo} disabled={!canUndo} title={t("lut.undo")} aria-label={t("lut.undo")}>
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-35" onClick={onRedo} disabled={!canRedo} title={t("lut.redo")} aria-label={t("lut.redo")}>
              <Redo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="lut-import"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-35"
              onClick={() => importPaths(null)}
              disabled={importing}
              title={t("lut.import")}
              aria-label={t("lut.import")}
            >
              <FileInput className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              data-testid="lut-add-folder"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
              onClick={addFolder}
              title={t("lut.addFolder")}
              aria-label={t("lut.addFolder")}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {base ? (
          <div className="mt-1.5 text-[10.5px] leading-snug text-muted2" data-testid="lut-base" data-base={base}>
            {baseLabel(base, t)}
          </div>
        ) : null}
        {importing && total > 0 ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-muted" data-testid="lut-importing">
            <Spinner className="h-3 w-3" />
            {t("lut.importingHint")}
          </div>
        ) : null}

        {lut ? (
          <div className="mt-3 rounded-lg bg-app px-3 py-2.5" data-testid="lut-selected">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text" title={lut.name}>{lut.name}</span>
              {selectedEntry?.log ? <LogBadge t={t} /> : null}
              <button
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-text"
                onClick={() => select(null)}
                title={t("lut.remove")}
                aria-label={t("lut.remove")}
                data-testid="lut-clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {selectedError ? (
              <div className="mt-1.5 text-[11px] text-amber-400">{t(`lut.errors.${selectedError}`, { defaultValue: selectedError })}</div>
            ) : selectedEntry?.log ? (
              <div className="mt-1.5 text-[10.5px] leading-snug text-amber-300/80">{t("lut.logHint")}</div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <label className="min-w-[36px] text-[10px] text-muted2" htmlFor="lut-strength">{t("lut.strength")}</label>
              <input
                id="lut-strength"
                data-testid="lut-strength"
                type="range"
                min="0"
                max="100"
                step="1"
                value={strengthPct}
                onChange={(e) => setStrength(Number(e.target.value) / 100)}
                onPointerUp={(e) => setStrength(Number(e.currentTarget.value) / 100, { commit: true })}
                onKeyUp={(e) => setStrength(Number(e.currentTarget.value) / 100, { commit: true })}
                onDoubleClick={() => setStrength(1, { commit: true })}
                className="slider flex-1"
              />
              <span className="w-9 text-right text-[11px] tabular-nums text-text">{strengthPct}%</span>
            </div>
            <button
              type="button"
              data-testid="lut-compare"
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border/60 py-1.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text active:bg-selected"
              onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setComparing(true); }}
              onPointerUp={() => setComparing(false)}
              onPointerCancel={() => setComparing(false)}
              onLostPointerCapture={() => setComparing(false)}
            >
              <Eye className="h-3.5 w-3.5" />
              {grading ? t("lut.applying") : t("lut.holdToCompare")}
            </button>
          </div>
        ) : null}

        {total > 0 ? (
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("lut.search")}
              data-testid="lut-search"
              className="w-full rounded-md bg-app py-1.5 pl-7 pr-2 text-[11.5px] text-text outline-none placeholder:text-muted2 focus:ring-1 focus:ring-[rgb(var(--accent-color))]"
            />
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="lut-list">
        {total === 0 ? (
          <div className="flex flex-col items-center gap-3 px-2 py-6 text-center">
            <div className="text-[12px] text-text">{loading ? t("lut.loading") : t("lut.empty")}</div>
            {!loading ? <div className="text-[11px] leading-relaxed text-muted">{t("lut.emptyHint")}</div> : null}
            {!loading ? (
              <div className="flex flex-col gap-1.5 self-stretch">
                <button type="button" className="rounded-md bg-[rgb(var(--accent-color))] py-1.5 text-[11.5px] font-medium text-white disabled:opacity-50" onClick={() => importPaths(null)} disabled={importing}>
                  {importing ? t("lut.importing") : t("lut.import")}
                </button>
                <button type="button" className="rounded-md border border-border/60 py-1.5 text-[11.5px] text-muted hover:bg-hover hover:text-text" onClick={addFolder}>
                  {t("lut.addFolder")}
                </button>
              </div>
            ) : null}
          </div>
        ) : groups.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-muted">{t("lut.noMatch")}</div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const unavailable = group.source === "folder" && library?.folders?.find((f) => f.path === group.root)?.available === false;
            return (
              <div key={group.key} className="mb-2" data-lut-group={group.title || "library"}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[10.5px] font-medium text-muted2 hover:text-text"
                  onClick={() => setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })}
                  title={group.source === "folder" ? group.root : undefined}
                >
                  {isCollapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{group.title || t("lut.ungrouped")}</span>
                  {group.source === "folder" ? <FolderOpen className="h-3 w-3 shrink-0 opacity-60" /> : null}
                  <span className="tabular-nums opacity-70">{group.luts.length}</span>
                </button>
                {unavailable ? <div className="px-1 text-[10.5px] text-amber-400/80">{t("lut.folderUnavailable")}</div> : null}
                {!isCollapsed ? (
                  <div className="mt-1 grid grid-cols-3 gap-x-1.5 gap-y-2">
                    {group.luts.map((entry) => (
                      <LutCell
                        key={entry.id}
                        entry={entry}
                        selected={lut?.id === entry.id}
                        error={errors[entry.id]}
                        thumb={thumbFor(entry.id)}
                        aspect={thumbAspect}
                        scrollRoot={scrollRef}
                        onRequest={requestThumb}
                        onCancel={cancelThumb}
                        onClick={() => select(entry)}
                        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry }); }}
                        t={t}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {library ? (
        <button
          type="button"
          className="flex items-center gap-1.5 border-t border-border/60 px-4 py-2 text-left text-[10.5px] text-muted2 transition-colors hover:text-text"
          onClick={() => api.openCacheDir?.("luts")}
          title={library.library?.dir}
          data-testid="lut-library-footer"
        >
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {t("lut.libraryFooter", { count: library.library?.count || 0, size: formatBytes(library.library?.bytes) || "0 MB" })}
          </span>
        </button>
      ) : null}

      {dropActive ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-app/70" data-testid="lut-drop-hint">
          <div className="rounded-lg border border-dashed border-border bg-chrome px-4 py-3 text-[12px] text-text">{t("lut.dropHint")}</div>
        </div>
      ) : null}

      {menu ? <FaceMenu position={{ x: menu.x, y: menu.y }} items={menuItems} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
