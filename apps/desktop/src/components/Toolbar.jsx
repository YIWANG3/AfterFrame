import { useState, useRef, useEffect } from "react";
import api from "../api";
import { useTranslation } from "react-i18next";
import ActivityCenter from "./ActivityCenter";
import {
  ChevronDown,
  Plus,
  RotateCw,
  Search,
  LayoutGrid,
  Grid2x2,
  LayoutDashboard,
  Columns2,
  FolderPlus,
  ImagePlus,
  Play,
  Sparkles,
  Images,
  ArrowUpDown,
  Check,
  Tags,
  SlidersHorizontal,
  Map as MapIcon,
} from "lucide-react";

// Labels resolved at render via t(`toolbar.*`); these consts carry i18n keys.
const DISPLAY_MODES = [
  { key: "grid", icon: LayoutGrid },
  { key: "tiles", icon: Grid2x2 },
  { key: "justified", icon: LayoutDashboard },
  { key: "waterfall", icon: Columns2 },
];

const SORT_OPTIONS = ["imported-desc", "imported-asc", "captured-desc", "captured-asc", "rating-desc", "name-asc", "name-desc"];

// `cap` marks entries a bridge may declare unavailable (api.can) — the web
// bridge hides RAW sources, sidecar tasks and AI annotation.
const MENU_SECTIONS = [
  {
    key: "library",
    items: [
      { key: "import", icon: ImagePlus, action: "processed" },
      { key: "addRawSources", icon: FolderPlus, action: "sources", cap: "rawSources" },
    ],
  },
  {
    key: "tasks",
    cap: "sidecarJobs",
    items: [
      { key: "runImport", icon: Play, action: "import" },
      { key: "runEnrichment", icon: Sparkles, action: "enrichment" },
      { key: "generatePreviews", icon: Images, action: "previews" },
    ],
  },
  {
    key: "ai",
    cap: "annotation",
    items: [
      { key: "annotateMissing", icon: Tags, action: "annotateMissing" },
      { key: "reannotateAll", icon: Tags, action: "annotateAll" },
    ],
  },
];

function IconButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={[
        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}

// The four layout modes live in one compact dropdown (trigger shows the
// current mode's icon) instead of four toolbar buttons.
function DisplayModeDropdown({ displayMode, setDisplayMode }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = DISPLAY_MODES.find((mode) => mode.key === displayMode) || DISPLAY_MODES[0];
  const CurrentIcon = current.icon;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="display-mode-trigger"
        className="flex h-8 cursor-pointer items-center gap-1 rounded-md px-1.5 text-muted transition-colors hover:bg-hover hover:text-text"
        title={t("toolbar.displayMode")}
        onClick={() => setOpen((c) => !c)}
      >
        <CurrentIcon className="h-3.5 w-3.5 stroke-[1.6]" />
        <ChevronDown className="h-2.5 w-2.5 text-muted2" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-[101] mt-1.5 min-w-[150px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay">
          {DISPLAY_MODES.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              data-testid={`display-mode-${key}`}
              className={[
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover",
                displayMode === key ? "text-text" : "text-muted",
              ].join(" ")}
              onClick={() => { setDisplayMode(key); setOpen(false); }}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">{t(`toolbar.display.${key}`)}</span>
              {displayMode === key && <Check className="h-3 w-3 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SortDropdown({ sort, setSort }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = SORT_OPTIONS.includes(sort) ? sort : null;

  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        className="flex h-8 w-[100px] cursor-pointer items-center justify-center rounded-md border border-border/70 bg-app px-2 text-[12px] text-text outline-none transition-colors hover:border-border focus:border-accent/50"
        onClick={() => setOpen((c) => !c)}
      >
        <span>{current ? t(`toolbar.sort.${current}`) : t("toolbar.sortFallback")}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-[101] mt-1.5 min-w-[160px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay">
          {SORT_OPTIONS.map((value) => (
            <button
              key={value}
              type="button"
              className={[
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover",
                sort === value ? "text-text" : "text-muted",
              ].join(" ")}
              onClick={() => { setSort(value); setOpen(false); }}
            >
              <span className="flex h-3.5 w-3.5 items-center justify-center">
                {sort === value && <Check className="h-3 w-3 text-accent" />}
              </span>
              {t(`toolbar.sort.${value}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Toolbar({
  title,
  query,
  setQuery,
  sort,
  setSort,
  refreshAll,
  onAddProcessed,
  onAddSources,
  onRunImport,
  onRunEnrichment,
  onRunPreviews,
  onAnnotateMissing,
  onAnnotateAll,
  displayMode,
  setDisplayMode,
  thumbSize,
  setThumbSize,
  mapExpanded,
  onToggleMap,
  showFilters,
  onToggleFilters,
  filterCount = 0,
  activityJobs,
  lastFinishedJob,
  onCancelJob,
  onPauseJob,
  onResumeJob,
}) {
  const { t } = useTranslation("nav");
  const { t: tc } = useTranslation("common");
  const [menuOpen, setMenuOpen] = useState(false);
  const actionMap = {
    processed: onAddProcessed,
    sources: onAddSources,
    import: onRunImport,
    enrichment: onRunEnrichment,
    previews: onRunPreviews,
    annotateMissing: onAnnotateMissing,
    annotateAll: onAnnotateAll,
  };

  return (
    <div className="app-toolbar relative z-50 flex h-11 items-center gap-1 bg-chrome px-2.5">
      <div className="relative">
        <IconButton onClick={() => setMenuOpen((c) => !c)}>
          <Plus className="h-4 w-4 stroke-[1.8]" />
        </IconButton>
        {menuOpen ? (
          <>
            <div className="fixed inset-0 z-[100]" onClick={() => setMenuOpen(false)} />
            <div className="absolute top-full z-[101] mt-2.5 w-[248px] rounded-lg border border-border/60 bg-chrome p-1.5 shadow-overlay">
              {MENU_SECTIONS.map((section, sectionIndex) => (
                <div key={section.key} className={sectionIndex > 0 ? "mt-1 border-t border-border/80 pt-1.5" : ""}>
                  <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted2">
                    {t(`toolbar.menu.${section.key}`)}
                  </div>
                  {section.items.map(({ key, icon: Icon, action, cap }) => {
                    const locked = !api.can(section.cap) || !api.can(cap);
                    return (
                      <button
                        key={key}
                        type="button"
                        className={[
                          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] font-medium transition-colors",
                          locked ? "cursor-default text-muted2" : "cursor-pointer text-text hover:bg-hover",
                        ].join(" ")}
                        title={locked ? tc("desktop.hint") : undefined}
                        onClick={async () => {
                          if (locked) return;
                          setMenuOpen(false);
                          await actionMap[action]?.();
                        }}
                      >
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${locked ? "text-muted2/70" : "text-muted"}`} />
                        <span className="min-w-0 flex-1 truncate">{t(`toolbar.menu.${key}`)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="ml-2 mr-2 min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text">{title}</div>
      </div>

      <div className="toolbar-thumbsize flex h-8 items-center gap-1.5 text-muted2">
        <span className="relative -top-px flex h-8 w-4 items-center justify-center text-[13px] leading-none">−</span>
        <input
          type="range"
          min="120"
          max="300"
          step="4"
          value={thumbSize}
          onChange={(e) => setThumbSize(Number(e.target.value))}
          className="w-16"
          aria-label={t("toolbar.thumbnailSize")}
        />
        <span className="relative -top-px flex h-8 w-4 items-center justify-center text-[13px] leading-none">+</span>
      </div>

      <div className="toolbar-modes flex items-center gap-1">
        <DisplayModeDropdown displayMode={displayMode} setDisplayMode={setDisplayMode} />
        {onToggleMap ? (
          <IconButton
            onClick={onToggleMap}
            className={mapExpanded ? "bg-selected text-accent" : ""}
            title={mapExpanded ? t("toolbar.map.hide") : t("toolbar.map.show")}
            data-testid="map-toggle"
          >
            <MapIcon className="h-3.5 w-3.5 stroke-[1.6]" />
          </IconButton>
        ) : null}
      </div>

      {/* Flexible: shrinks before anything gets clipped, but never below usable */}
      <label className="relative block min-w-[96px] max-w-[176px] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("toolbar.search")}
          className="h-8 w-full rounded-md border border-border/70 bg-app py-0 pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
      </label>

      <SortDropdown sort={sort} setSort={setSort} />

      <div className="relative">
        <IconButton
          onClick={onToggleFilters}
          className={showFilters || filterCount > 0 ? "bg-selected text-accent" : ""}
          title={t("toolbar.filters")}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 stroke-[1.8]" />
        </IconButton>
        {filterCount > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-black">
            {filterCount}
          </span>
        )}
      </div>

      <ActivityCenter jobs={activityJobs} lastFinishedJob={lastFinishedJob} onCancel={onCancelJob} onPause={onPauseJob} onResume={onResumeJob} />

      <IconButton onClick={() => void refreshAll()} title={t("toolbar.refresh")}>
        <RotateCw className="h-3.5 w-3.5 stroke-[1.8]" />
      </IconButton>
    </div>
  );
}
