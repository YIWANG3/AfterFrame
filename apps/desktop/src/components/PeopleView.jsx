import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, RefreshCw, ScanFace, Search, Settings2, UsersRound } from "lucide-react";
import { localFileUrl } from "../utils/format";
import FaceCrop from "./FaceCrop";
import NamePersonPopover from "./NamePersonPopover";

// Unnamed groups this small sort behind the frequent faces — the two-face
// fragments are reachable by scrolling, but the people worth naming lead.
const MIN_PROMINENT_FACES = 3;
// Tiles are appended in pages as the wall scrolls, like the gallery, instead
// of mounting thousands of face crops at once.
const PAGE_SIZE = 80;

function PersonTile({ group, selected, onSelect, onOpen, onAddName }) {
  const { t } = useTranslation("nav");
  const named = !!group.name?.trim();
  const source = group.cover_preview_path || group.cover_image_path;

  return (
    <div className="group/tile relative flex flex-col items-center">
      <button
        type="button"
        onClick={() => onSelect(group)}
        onDoubleClick={() => onOpen(group)}
        title={t("people.openGroup", { name: group.name || t("people.unnamed") })}
        className={[
          "relative block overflow-hidden rounded-xl transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          selected ? "ring-2 ring-accent/80" : "",
        ].join(" ")}
      >
        <FaceCrop
          src={localFileUrl(source)}
          bbox={group.cover_bbox}
          alt=""
          className={[
            "h-[104px] w-[104px] rounded-xl border shadow-sm transition",
            selected ? "border-accent/60" : "border-border/50 group-hover/tile:border-accent/45",
          ].join(" ")}
        />
      </button>
      {named ? (
        <button
          type="button"
          onClick={(e) => onAddName(group, e.currentTarget.getBoundingClientRect())}
          title={t("people.rename")}
          className="mt-2 max-w-[116px] truncate rounded px-1.5 py-0.5 text-[12px] font-medium text-text transition hover:bg-hover"
        >
          {group.name}
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => onAddName(group, e.currentTarget.getBoundingClientRect())}
          className="mt-2 rounded px-1.5 py-0.5 text-[11px] text-muted2 transition hover:bg-hover hover:text-text"
        >
          {t("people.addName")}
        </button>
      )}
      <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted2">
        <ScanFace className="h-2.5 w-2.5" />
        {t("people.faces", { count: Number(group.face_count) || 0 })}
      </div>
    </div>
  );
}

export default function PeopleView({ people, onOpenGroup, onOpenSettings }) {
  const { t } = useTranslation("nav");
  const { groups, loading, failed, load, selectedId, select, rename, merge, scan, startScan } = people;
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [naming, setNaming] = useState(null); // { group, anchorRect }
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const gridRef = useRef(null);

  const namedGroups = useMemo(() => groups.filter((group) => group.name?.trim()), [groups]);

  const ordered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term) return groups.filter((group) => (group.name || "").toLowerCase().includes(term));
    const isSmall = (group) => !group.name?.trim() && (Number(group.face_count) || 0) < MIN_PROMINENT_FACES;
    return [...groups.filter((group) => !isSmall(group)), ...groups.filter(isSmall)];
  }, [groups, query]);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [query]);

  const visible = ordered.slice(0, visibleCount);
  const hasMore = ordered.length > visibleCount;

  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((count) => count + PAGE_SIZE);
      }
    }, { root: scrollRef.current, rootMargin: "600px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
    // Re-observing after each page append fires the initial-state callback, so
    // a sentinel that never left the viewport still loads the next page.
  }, [hasMore, visibleCount]);

  const scanning = !!scan?.active;
  const scanPercent = Math.round((Number(scan?.progress) || 0) * 100);

  // Keyboard selection over the wall, same feel as the sticker grid: arrows
  // move the ring, Enter opens the person's photos, Escape drops selection.
  useEffect(() => {
    function onKey(event) {
      if (naming) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      if (!visible.length) return;
      const index = visible.findIndex((group) => group.group_id === selectedId);
      if (event.key === "Enter") {
        if (index >= 0) { event.preventDefault(); onOpenGroup(visible[index]); }
        return;
      }
      if (event.key === "Escape") {
        if (index >= 0) select(null);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return;
      }
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      const tiles = gridRef.current ? [...gridRef.current.children] : [];
      let columns = tiles.findIndex((tile) => tile.offsetTop !== tiles[0]?.offsetTop);
      if (columns <= 0) columns = tiles.length || 1;
      let next;
      if (index < 0) {
        next = 0;
      } else if (event.key === "ArrowRight") {
        next = Math.min(visible.length - 1, index + 1);
      } else if (event.key === "ArrowLeft") {
        next = Math.max(0, index - 1);
      } else if (event.key === "ArrowDown") {
        next = Math.min(visible.length - 1, index + columns);
      } else {
        next = Math.max(0, index - columns);
      }
      event.preventDefault();
      select(visible[next].group_id);
      // Keep DOM focus on the selected tile — otherwise the previously
      // clicked tile keeps its :focus-visible ring and two tiles look active.
      tiles[next]?.querySelector("button")?.focus({ preventScroll: true });
      tiles[next]?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selectedId, naming, select, onOpenGroup]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/40 bg-chrome px-3 text-[12px]">
        <div className="flex min-w-0 items-center gap-2 text-muted2">
          <UsersRound className="h-4 w-4" />
          <h1 className="text-[12px] font-normal text-text">{t("people.title")}</h1>
          <span className="text-muted3">· {groups.length}</span>
          {scanning && (
            <span className="ml-2 flex items-center gap-1.5 truncate text-[11px] text-muted">
              <LoaderCircle className="h-3 w-3 animate-spin" />
              {t("people.scanning", { percent: scanPercent })}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void startScan().catch(() => {})}
            disabled={scanning}
            title={t("people.scanHint")}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-2.5 text-[11px] text-muted transition hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-50"
          >
            <ScanFace className="h-3.5 w-3.5" />
            {scanning ? t("people.scanningShort") : t("people.scan")}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title={t("people.refresh")}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted transition hover:bg-hover hover:text-text disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <div className="relative w-[240px]">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("people.searchPlaceholder")}
              className="h-7 w-full rounded-md border border-border/60 bg-app pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted3 focus:border-[rgb(var(--accent-color))]"
            />
          </div>
        </div>
      </div>

      <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-6">
        {loading && !groups.length ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-muted2">
            <LoaderCircle className="h-5 w-5 animate-spin" />
            <span className="text-[12px]">{t("people.loading")}</span>
          </div>
        ) : groups.length ? (
          <>
            <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-x-3 gap-y-6">
              {visible.map((group) => (
                <PersonTile
                  key={group.group_id}
                  group={group}
                  selected={group.group_id === selectedId}
                  onSelect={(target) => select(target.group_id === selectedId ? null : target.group_id)}
                  onOpen={onOpenGroup}
                  onAddName={(target, anchorRect) => setNaming({ group: target, anchorRect })}
                />
              ))}
            </div>
            {hasMore && (
              <div ref={sentinelRef} className="flex h-12 items-center justify-center text-muted2">
                <LoaderCircle className="h-4 w-4 animate-spin" />
              </div>
            )}
            {query.trim() !== "" && visible.length === 0 && (
              <div className="mt-10 text-center text-[12px] text-muted2">{t("people.searchEmpty")}</div>
            )}
          </>
        ) : (
          <div className="flex h-full min-h-64 flex-col items-center justify-center px-5 text-center">
            <div className="mb-4 rounded-2xl border border-border/55 bg-chrome p-4 text-muted2">
              <UsersRound className="h-8 w-8 stroke-[1.25]" />
            </div>
            <h2 className="text-[14px] font-medium text-text">{failed ? t("people.failedTitle") : t("people.emptyTitle")}</h2>
            <p className="mt-2 max-w-sm text-[12px] leading-5 text-muted2">
              {failed ? t("people.failedHint") : t("people.emptyHint")}
            </p>
            {!failed && (
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void startScan().catch(() => {})}
                  disabled={scanning}
                  className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-app transition hover:bg-accent/90 disabled:opacity-55"
                >
                  <ScanFace className="h-3.5 w-3.5" />
                  {scanning ? t("people.scanningShort") : t("people.scan")}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenSettings?.()}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-border/65 px-3 text-[12px] text-muted transition hover:bg-hover hover:text-text"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  {t("people.openSettings")}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {naming && (
        <NamePersonPopover
          anchorRect={naming.anchorRect}
          group={naming.group}
          namedGroups={namedGroups}
          onClose={() => setNaming(null)}
          onRename={(name) => rename(naming.group.group_id, name)}
          onMerge={(target) => merge(naming.group.group_id, target.group_id)}
        />
      )}
    </div>
  );
}
