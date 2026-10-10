// LUT tool panel (docs/lut-plan.md §4): the current photo through each LUT
// in the library, grouped by folder; the chosen one's strength; import and
// "add a folder" (read in place, no copy). Presentational: useLutTool owns
// the state, EditorOverlay draws the graded photo.

import { useEffect, useRef, useState } from "react";
import {
  Search, FileInput, FolderPlus, FolderOpen, Eye, X, ChevronDown, ChevronRight,
  Trash2, Tag, Undo2, Redo2, AlertTriangle, Plus, ChevronsDownUp, ChevronsUpDown,
  Star, StarOff, History, Grid2x2, Grid3x3,
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
function LutCell({ entry, groupKey, selected, current, error, thumb, aspect, scrollRoot, onRequest, onCancel, onClick, onContextMenu, t }) {
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

  // The arrow keys move the current cell: keep it in view.
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const broken = error || entry.error;
  return (
    <button
      ref={ref}
      type="button"
      data-lut-cell={entry.id}
      data-lut-name={entry.name}
      data-lut-group-key={groupKey}
      data-selected={selected ? "true" : "false"}
      data-current={current ? "true" : "false"}
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
        {entry.favorite ? (
          <div className="absolute right-1 top-1 rounded bg-black/55 p-[2px]" title={t("lut.favorite")} data-testid="lut-favorite-badge">
            <Star className="h-2.5 w-2.5 fill-amber-300 text-amber-300" />
          </div>
        ) : null}
      </div>
      <span className={["truncate text-[10.5px] leading-tight", selected ? "text-text" : "text-muted"].join(" ")}>
        {entry.name}
      </span>
    </button>
  );
}

// "+ Add LUTs": the two ways in, each saying in one line what it does to the
// user's files — two bare icons left people guessing which was which.
function AddLutsMenu({ t, importing, onImport, onAddFolder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  // What each way does to the files is the hover hint, not text under it.
  const item = (testId, Icon, title, hint, onClick) => (
    <button
      type="button"
      data-testid={testId}
      title={hint}
      className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-hover"
      onClick={() => { setOpen(false); onClick(); }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
      {title}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="lut-add"
        className="flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-text transition-colors hover:bg-hover disabled:opacity-50"
        onClick={() => setOpen((v) => !v)}
        disabled={importing}
        aria-expanded={open}
      >
        {/* Busy in place: text below would change the panel's height. */}
        {importing ? <Spinner className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        {importing ? t("lut.importing") : t("lut.add")}
      </button>
      {open ? (
        <div className="absolute right-0 top-8 z-30 w-max rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" data-testid="lut-add-menu">
          {item("lut-import", FileInput, t("lut.importFiles"), t("lut.importFilesHint"), onImport)}
          {item("lut-add-folder", FolderPlus, t("lut.addFolderShort"), t("lut.addFolderHint"), onAddFolder)}
        </div>
      ) : null}
    </div>
  );
}

const GRID_COLUMNS = { 2: "grid-cols-2", 3: "grid-cols-3" };

// The chosen LUT's particulars: its cube size and where it's kept; the full
// path on hover. (Its whole name is the heading above, wrapped, not cut.)
function LutInfo({ entry, library, t }) {
  const folder = entry.source === "folder"
    ? (library?.folders || []).find((f) => f.path === entry.root)?.name || entry.root?.split(/[\\/]/).pop()
    : null;
  return (
    <div className="mt-1 flex items-center gap-1 text-[10.5px] leading-snug text-muted2" data-testid="lut-info" title={entry.path}>
      <span className="min-w-0 flex-1 truncate">
        {[
          entry.lutSize ? `${entry.lutSize}³` : null,
          folder ? t("lut.infoFolder", { name: folder }) : t("lut.infoLibrary"),
        ].filter(Boolean).join(" · ")}
      </span>
      <button
        type="button"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted2 transition-colors hover:bg-hover hover:text-text"
        onClick={() => api.revealLut(entry.id)}
        title={t("lut.revealInFinder")}
        aria-label={t("lut.revealInFinder")}
        data-testid="lut-info-reveal"
      >
        <FolderOpen className="h-3 w-3" />
      </button>
    </div>
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
    select, browseTo, cursor, toggleFavorite, view, setView,
    setStrength, importPaths, addFolder, relocateFolder, removeFolder, setLogMark, trash,
    grading, setComparing, requestThumb, cancelThumb, thumbFor, thumbAspect,
  } = tool;
  const selectedEntry = lut ? library?.luts?.find((l) => l.id === lut.id) : null;
  // Chosen, then moved or deleted in Finder (the list is rescanned when the
  // window comes back): say so rather than fail at save.
  const selectedMissing = !!(lut && library && !loading && !selectedEntry);
  const selectedError = lut ? errors[lut.id] || selectedEntry?.error || (selectedMissing ? "missing" : null) : null;
  // Once there are LUTs the panel keeps its full height: a filter or search
  // that leaves a few mustn't shrink it and move everything under the pointer.
  const total = library?.luts?.length || 0;
  const strengthPct = Math.round((lut?.strength ?? 1) * 100);
  const unavailableFolders = (library?.folders || []).filter((f) => !f.available);
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));

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

  // ← → step through the LUTs on screen in the order shown, ↑ ↓ to the cell
  // above or below (the last of a shorter row), across group headers;
  // collapsed groups are skipped. From the cell last chosen. Typing in the
  // search box keeps its arrows.
  const columns = view.columns;
  const stepRef = useRef(null);
  stepRef.current = (key) => {
    const rows = [];
    for (const g of groups) {
      if (collapsed.has(g.key)) continue;
      for (let i = 0; i < g.luts.length; i += columns) {
        rows.push(g.luts.slice(i, i + columns).map((entry) => ({ groupKey: g.key, entry })));
      }
    }
    const cells = rows.flat();
    if (!cells.length) return false;
    let at = cursor ? cells.findIndex((c) => c.groupKey === cursor.groupKey && c.entry.id === cursor.id) : -1;
    if (at < 0 && lut) at = cells.findIndex((c) => c.entry.id === lut.id);
    let target = cells[0];
    if (at >= 0 && (key === "ArrowLeft" || key === "ArrowRight")) {
      target = cells[Math.min(cells.length - 1, Math.max(0, at + (key === "ArrowLeft" ? -1 : 1)))];
    } else if (at >= 0) {
      let row = 0;
      let start = 0;
      while (start + rows[row].length <= at) start += rows[row++].length;
      const next = rows[row + (key === "ArrowUp" ? -1 : 1)];
      target = next ? next[Math.min(at - start, next.length - 1)] : cells[at];
    }
    if (target === cells[at]) return true;
    browseTo(target.entry, target.groupKey);
    return true;
  };
  useEffect(() => {
    const onKey = (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (stepRef.current(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const menuItems = menu ? [
    menu.entry.favorite
      ? { key: "unfav", icon: StarOff, label: t("lut.unfavorite"), onClick: () => toggleFavorite(menu.entry) }
      : { key: "fav", icon: Star, label: t("lut.favorite"), onClick: () => toggleFavorite(menu.entry) },
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
      className={["relative flex flex-col", total > 0 ? "h-[calc(100vh-10rem)]" : "max-h-[calc(100vh-10rem)]"].join(" ")}
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
            <AddLutsMenu t={t} importing={importing} onImport={() => importPaths(null)} onAddFolder={addFolder} />
          </div>
        </div>
        {base ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] leading-snug text-muted2" data-testid="lut-base" data-base={base}>
            {base === "rendering" ? <Spinner className="h-3 w-3" /> : null}
            {baseLabel(base, t)}
          </div>
        ) : null}

        {lut ? (
          <div className="mt-3 rounded-lg bg-app px-3 py-2.5" data-testid="lut-selected">
            <div className="flex items-center gap-2">
              <span className="line-clamp-2 min-w-0 flex-1 break-words text-[12px] font-medium leading-snug text-text" title={lut.name} data-testid="lut-selected-name">{lut.name}</span>
              {selectedEntry?.log ? <LogBadge t={t} /> : null}
              {selectedEntry ? (
                <button
                  type="button"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-text"
                  onClick={() => toggleFavorite(selectedEntry)}
                  title={selectedEntry.favorite ? t("lut.unfavorite") : t("lut.favorite")}
                  aria-label={selectedEntry.favorite ? t("lut.unfavorite") : t("lut.favorite")}
                  aria-pressed={!!selectedEntry.favorite}
                  data-testid="lut-favorite-toggle"
                >
                  <Star className={["h-3.5 w-3.5", selectedEntry.favorite ? "fill-amber-300 text-amber-300" : ""].join(" ")} />
                </button>
              ) : null}
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
            {selectedEntry ? <LutInfo entry={selectedEntry} library={library} t={t} /> : null}
            {selectedError ? (
              <div className="mt-1.5 text-[11px] leading-snug text-amber-400" data-testid="lut-selected-error">
                {selectedMissing ? t("lut.selectedMissing") : t(`lut.errors.${selectedError}`, { defaultValue: selectedError })}
              </div>
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

        {/* Added folders that can't be read: moved, renamed, or the drive is
            away. Nothing to show for them in the list, so say it here. */}
        {unavailableFolders.map((folder) => (
          <div key={folder.path} className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2" data-testid="lut-folder-missing">
            <div className="text-[10.5px] leading-snug text-amber-300" title={folder.path}>
              {t("lut.folderMissing", { name: folder.name })}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" className="rounded px-2 py-1 text-[10.5px] text-text hover:bg-hover" onClick={() => relocateFolder(folder.path)}>
                {t("lut.relocate")}
              </button>
              <button type="button" className="rounded px-2 py-1 text-[10.5px] text-muted hover:bg-hover hover:text-text" onClick={() => removeFolder(folder.path)}>
                {t("lut.removeFolder")}
              </button>
            </div>
          </div>
        ))}

        {total > 0 ? (
          <>
            {/* What the list shows: everything or the favourites, Log LUTs or not. */}
            <div className="mt-2 flex items-center gap-1" data-testid="lut-filters">
              {[["all", t("lut.filterAll")], ["favorites", t("lut.filterFavorites")]].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`lut-filter-${key}`}
                  aria-pressed={view.filter === key}
                  className={[
                    "rounded-md px-2 py-1 text-[11px] transition-colors",
                    view.filter === key ? "bg-selected text-text" : "text-muted hover:bg-hover hover:text-text",
                  ].join(" ")}
                  onClick={() => setView({ filter: key })}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                data-testid="lut-hide-log"
                aria-pressed={view.hideLog}
                className={[
                  "ml-auto rounded-md px-2 py-1 text-[11px] transition-colors",
                  view.hideLog ? "bg-selected text-text" : "text-muted hover:bg-hover hover:text-text",
                ].join(" ")}
                onClick={() => setView({ hideLog: !view.hideLog })}
                title={t("lut.hideLogHint")}
              >
                {t("lut.hideLog")}
              </button>
            </div>
            {/* How many, how big, and all groups open or shut. */}
            <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-muted2">
              <span className="min-w-0 flex-1 truncate">
                {t("lut.groupsSummary", {
                  groups: groups.filter((g) => !g.special).length,
                  count: new Set(groups.flatMap((g) => g.luts.map((l) => l.id))).size,
                })}
              </span>
              {[[2, Grid2x2, t("lut.largeThumbs")], [3, Grid3x3, t("lut.smallThumbs")]].map(([cols, Icon, label]) => (
                <button
                  key={cols}
                  type="button"
                  data-testid={`lut-columns-${cols}`}
                  aria-pressed={columns === cols}
                  title={label}
                  aria-label={label}
                  className={[
                    "flex h-6 w-6 items-center justify-center rounded transition-colors",
                    columns === cols ? "bg-selected text-text" : "text-muted hover:bg-hover hover:text-text",
                  ].join(" ")}
                  onClick={() => setView({ columns: cols })}
                >
                  <Icon className="h-3 w-3" />
                </button>
              ))}
              {groups.length > 1 ? (
                <button
                  type="button"
                  data-testid="lut-toggle-all"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-text"
                  onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)))}
                >
                  {allCollapsed ? <ChevronsUpDown className="h-3 w-3" /> : <ChevronsDownUp className="h-3 w-3" />}
                  {allCollapsed ? t("lut.expandAll") : t("lut.collapseAll")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="lut-list">
        {total === 0 ? (
          <div className="flex flex-col items-center gap-3 px-2 py-6 text-center">
            <div className="text-[12px] text-text">{loading ? t("lut.loading") : t("lut.empty")}</div>
            {!loading ? (
              <div className="flex flex-col gap-2 self-stretch">
                {/* accentInk: the accent is white in the dark theme, near-black in the light one. */}
                <button
                  type="button"
                  data-testid="lut-empty-import"
                  title={t("lut.importFilesHint")}
                  className="rounded-md bg-[rgb(var(--accent-color))] px-3 py-2 text-[11.5px] font-medium text-accentInk transition-all hover:brightness-110 disabled:opacity-50"
                  onClick={() => importPaths(null)}
                  disabled={importing}
                >
                  {importing ? t("lut.importing") : t("lut.importFiles")}
                </button>
                <button
                  type="button"
                  data-testid="lut-empty-add-folder"
                  title={t("lut.addFolderHint")}
                  className="rounded-md border border-border/60 px-3 py-2 text-[11.5px] text-text hover:bg-hover"
                  onClick={addFolder}
                >
                  {t("lut.addFolderShort")}
                </button>
              </div>
            ) : null}
            {!loading ? <div className="text-[10.5px] text-muted2">{t("lut.emptyHint")}</div> : null}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted" data-testid="lut-no-match">
            {view.filter === "favorites" && !query.trim() && !(library?.luts || []).some((l) => l.favorite)
              ? t("lut.noFavorites")
              : t("lut.noMatch")}
          </div>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <div key={group.key} className="mb-2" data-lut-group={group.special || group.title || "library"}>
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
                  {group.special === "favorites" ? <Star className="h-3 w-3 shrink-0 fill-amber-300/80 text-amber-300/80" /> : null}
                  {group.special === "recent" ? <History className="h-3 w-3 shrink-0" /> : null}
                  <span className="min-w-0 flex-1 truncate">
                    {group.special ? t(`lut.${group.special}`) : group.title || t("lut.ungrouped")}
                  </span>
                  {group.source === "folder" ? <FolderOpen className="h-3 w-3 shrink-0 opacity-60" /> : null}
                  <span className="tabular-nums opacity-70">{group.luts.length}</span>
                </button>
                {!isCollapsed ? (
                  <div className={["mt-1 grid gap-x-1.5 gap-y-2", GRID_COLUMNS[columns]].join(" ")}>
                    {group.luts.map((entry) => (
                      <LutCell
                        key={`${group.key}:${entry.id}`}
                        entry={entry}
                        groupKey={group.key}
                        selected={lut?.id === entry.id}
                        current={!!cursor && cursor.groupKey === group.key && cursor.id === entry.id}
                        error={errors[entry.id]}
                        thumb={thumbFor(entry.id)}
                        aspect={thumbAspect}
                        scrollRoot={scrollRef}
                        onRequest={requestThumb}
                        onCancel={cancelThumb}
                        onClick={() => select(entry, group.key)}
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
