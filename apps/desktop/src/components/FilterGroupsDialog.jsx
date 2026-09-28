import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus, Split, X } from "lucide-react";
import api from "../api";
import FilterBar from "./FilterBar";
import { activeFilterCount } from "../hooks/workspaceLogic";

// "Any of these groups" (filters.any_of, sidecar db/facets.py). Each group is
// an ordinary filter dict, edited with an embedded filter bar; a photo shows
// when it matches the main bar AND at least one group. The options come from
// the whole library, not the current view: a group is an alternative to what
// is showing, so what is showing must not limit what it can pick.
//
// Sits under the facet popovers (z 12000) so their lists open above it.
export default function FilterGroupsDialog({ groups, folders, onApply, onClose }) {
  const { t } = useTranslation("nav");
  const [draft, setDraft] = useState(() => (groups?.length ? groups : [{}, {}])
    .map((filters, index) => ({ key: index, filters: { ...filters } })));
  const nextKey = useRef(draft.length);
  const [facetValues, setFacetValues] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getFacetValues({})
      .then((values) => { if (!cancelled) setFacetValues(values || {}); })
      .catch(() => { if (!cancelled) setFacetValues({}); });
    return () => { cancelled = true; };
  }, []);

  // Escape closes an open facet list first; only with none open does it
  // close the dialog (and drop the draft).
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape" && !document.querySelector("[data-popover-panel]")) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = (key, filters) => setDraft((current) => current.map((group) => (group.key === key ? { ...group, filters } : group)));
  const remove = (key) => setDraft((current) => current.filter((group) => group.key !== key));
  const add = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    setDraft((current) => [...current, { key, filters: {} }]);
  };
  // A group with no condition would match every photo; like the sidecar, it
  // is left out rather than making the whole "or" true.
  const apply = () => onApply(draft.map((group) => group.filters).filter((filters) => activeFilterCount(filters) > 0));

  return createPortal(
    <div
      className="fixed inset-0 z-[11500] flex items-center justify-center bg-app/70 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-label={t("filter.groups.title")}
        data-filter-groups-dialog="true"
        className="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-border bg-chrome shadow-overlay"
      >
        <div className="border-b border-border/60 px-4 py-3">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-text">
            <Split className="h-3.5 w-3.5 text-muted" />
            {t("filter.groups.title")}
          </h2>
          <p className="mt-1 text-[11.5px] leading-snug text-muted">{t("filter.groups.hint")}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {draft.map((group, index) => (
            <div key={group.key}>
              {index > 0 && (
                <div className="my-2 flex items-center gap-2 text-[10.5px] text-muted2">
                  <span className="h-px flex-1 bg-border/60" />
                  {t("filter.groups.or")}
                  <span className="h-px flex-1 bg-border/60" />
                </div>
              )}
              <section data-filter-group-index={index} className="rounded-lg border border-border/60 bg-app/40 p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted">{t("filter.groups.group", { n: index + 1 })}</span>
                  <button
                    type="button"
                    title={t("filter.groups.removeGroup")}
                    aria-label={t("filter.groups.removeGroup")}
                    onClick={() => remove(group.key)}
                    className="rounded p-0.5 text-muted2 transition-colors hover:bg-hover hover:text-text"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <FilterBar
                  embedded
                  facetValues={facetValues}
                  facetsReady={facetValues != null}
                  filters={group.filters}
                  onChange={(filters) => update(group.key, filters)}
                  folders={folders}
                />
                {activeFilterCount(group.filters) === 0 && (
                  <p className="mt-1.5 text-[10.5px] text-muted2">{t("filter.groups.needsCondition")}</p>
                )}
              </section>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
          <button
            type="button"
            onClick={add}
            data-filter-groups-add="true"
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("filter.groups.addGroup")}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-hover"
            >
              {t("filter.groups.cancel")}
            </button>
            <button
              type="button"
              data-filter-groups-apply="true"
              onClick={apply}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accentInk transition-opacity hover:opacity-90"
            >
              {t("filter.groups.apply")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
