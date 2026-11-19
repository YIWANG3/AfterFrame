// A sidebar section's "⋯" beside its heading: what the section offers past
// search and new (sort, list or covers, open in the manager, hide), so every
// section's heading carries the same three tools and none crowds its title.
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MoreHorizontal } from "lucide-react";
import useDismiss from "../ui/useDismiss";

// `sort`: { value, options: [{ value, label }], onChange, testId } or null.
// `items`: [{ key, icon, label, onClick, testId? }]; a null entry draws a divider.
export default function SectionMoreMenu({ testId, sort = null, items = [] }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, () => setOpen(false), { enabled: open });
  const run = (onClick) => { setOpen(false); onClick?.(); };
  return (
    <span ref={ref} className="relative flex">
      <button
        type="button"
        data-testid={testId}
        className="rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
        title={t("sidebar.more")}
        aria-label={t("sidebar.more")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[184px] rounded-lg border border-border/60 bg-chrome p-1 shadow-overlay" data-section-more-menu="true">
          {sort && (
            <div data-testid={sort.testId} className="pb-1">
              <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted2">{t("sidebar.sortBy")}</div>
              {sort.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] hover:bg-hover ${sort.value === option.value ? "text-text" : "text-muted"}`}
                  onClick={() => run(() => sort.onChange(option.value))}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {sort.value === option.value && <Check className="h-3 w-3 text-accent" />}
                  </span>
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {items.map((item, index) => (item === null ? (
            <div key={`divider-${index}`} className="my-1 border-t border-border/50" />
          ) : (
            <button
              key={item.key}
              type="button"
              data-menu-item={item.key}
              data-testid={item.testId}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] text-text hover:bg-hover ${index === 0 && sort ? "border-t border-border/50" : ""}`}
              onClick={() => run(item.onClick)}
            >
              <item.icon className="h-3.5 w-3.5 shrink-0 text-muted2" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          )))}
        </div>
      )}
    </span>
  );
}
