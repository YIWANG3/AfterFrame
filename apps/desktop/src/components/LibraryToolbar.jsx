import { Search } from "lucide-react";

// Compact library views (Stickers and People) use the same floating toolbar
// shell as the asset gallery, while supplying only the actions they need.
export default function LibraryToolbar({
  icon: Icon,
  title,
  count,
  meta,
  actions,
  query,
  onQueryChange,
  searchPlaceholder,
}) {
  return (
    <div className="app-toolbar library-toolbar relative z-50 flex h-11 items-center gap-1 bg-chrome px-2.5">
      <div className="ml-2 mr-2 flex min-w-0 flex-1 items-center gap-2 text-muted2">
        {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
        <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-text">{title}</h1>
        <span className="shrink-0 text-[12px] text-muted3">· {count}</span>
        {meta}
      </div>

      {actions}

      <label className="relative block min-w-[96px] max-w-[176px] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="h-8 w-full rounded-md border border-border/70 bg-app py-0 pl-7 pr-2 text-[12px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
      </label>
    </div>
  );
}
