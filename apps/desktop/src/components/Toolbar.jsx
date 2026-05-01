import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
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
} from "lucide-react";

const DISPLAY_MODES = [
  { key: "grid", icon: LayoutGrid, tip: "Grid" },
  { key: "tiles", icon: Grid2x2, tip: "Tiles" },
  { key: "justified", icon: LayoutDashboard, tip: "Justified" },
  { key: "waterfall", icon: Columns2, tip: "Waterfall" },
];

const MENU_SECTIONS = [
  {
    label: "Library",
    items: [
      { label: "Import", icon: ImagePlus, action: "processed" },
      { label: "Add Raw Sources", icon: FolderPlus, action: "sources" },
    ],
  },
  {
    label: "Tasks",
    items: [
      { label: "Run Import Pipeline", icon: Play, action: "import" },
      { label: "Run Enrichment", icon: Sparkles, action: "enrichment" },
      { label: "Generate Previews", icon: Images, action: "previews" },
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
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  displayMode,
  setDisplayMode,
  thumbSize,
  setThumbSize,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actionMap = {
    processed: onAddProcessed,
    sources: onAddSources,
    import: onRunImport,
    enrichment: onRunEnrichment,
    previews: onRunPreviews,
  };

  return (
    <div className="relative z-50 flex h-11 items-center gap-1 bg-chrome px-2.5">
      <div className="relative">
        <IconButton onClick={() => setMenuOpen((c) => !c)}>
          <Plus className="h-4 w-4 stroke-[1.8]" />
        </IconButton>
        {menuOpen ? (
          <>
            <div className="fixed inset-0 z-[100]" onClick={() => setMenuOpen(false)} />
            <div className="absolute top-full z-[101] mt-2.5 w-[248px] rounded-lg border border-border/60 bg-chrome p-1.5 shadow-overlay">
              {MENU_SECTIONS.map((section, sectionIndex) => (
                <div key={section.label} className={sectionIndex > 0 ? "mt-1 border-t border-border/80 pt-1.5" : ""}>
                  <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted2">
                    {section.label}
                  </div>
                  {section.items.map(({ label, icon: Icon, action }) => (
                    <button
                      key={label}
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] font-medium text-text transition-colors hover:bg-hover"
                      onClick={async () => {
                        setMenuOpen(false);
                        await actionMap[action]?.();
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <IconButton disabled={!canGoBack} onClick={onBack}>
        <ChevronLeft className="h-4 w-4 stroke-[1.8]" />
      </IconButton>
      <IconButton disabled={!canGoForward} onClick={onForward}>
        <ChevronRight className="h-4 w-4 stroke-[1.8]" />
      </IconButton>

      <div className="ml-2 mr-2 min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text">{title}</div>
      </div>

      <div className="flex h-8 items-center gap-1.5 text-muted2">
        <span className="relative -top-px flex h-8 w-4 items-center justify-center text-[13px] leading-none">−</span>
        <input
          type="range"
          min="120"
          max="300"
          step="4"
          value={thumbSize}
          onChange={(e) => setThumbSize(Number(e.target.value))}
          className="w-16"
          aria-label="Thumbnail size"
        />
        <span className="relative -top-px flex h-8 w-4 items-center justify-center text-[13px] leading-none">+</span>
      </div>

      <div className="flex items-center gap-1">
        {DISPLAY_MODES.map(({ key, icon: Icon, tip }) => (
          <IconButton
            key={key}
            onClick={() => setDisplayMode(key)}
            className={displayMode === key ? "bg-selected text-accent" : ""}
            title={tip}
          >
            <Icon className="h-3.5 w-3.5 stroke-[1.6]" />
          </IconButton>
        ))}
      </div>

      <label className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="h-8 w-44 rounded-md border border-border/70 bg-app py-0 pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
      </label>

      <select
        value={sort}
        onChange={(e) => setSort(e.target.value)}
        className="ml-1 h-8 cursor-pointer rounded-md border border-border/70 bg-app px-2 py-0 text-[12px] text-text outline-none hover:border-border focus:border-accent/50"
      >
        <option value="name-asc">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
        <option value="score-desc">Score</option>
      </select>

      <IconButton onClick={() => void refreshAll()} title="Refresh">
        <RotateCw className="h-3.5 w-3.5 stroke-[1.8]" />
      </IconButton>
    </div>
  );
}
