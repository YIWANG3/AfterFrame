import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Popover from "./Popover";
import { setOrDelete } from "./filterValues";
import { TextInput } from "../../ui";

// "Contains" on one text field each. The search box matches seven fields at
// once (a camera name hits as readily as a caption); these match exactly one,
// and are saved into a smart collection as such. Typing commits after a pause.
export const TEXT_FACETS = ["caption_contains", "ocr_contains", "path_contains"];

export default function TextContainsPopover({ filters, onChange }) {
  const { t } = useTranslation("nav");
  const [draft, setDraft] = useState(() => Object.fromEntries(TEXT_FACETS.map((key) => [key, filters[key] || ""])));
  const active = TEXT_FACETS.filter((key) => filters[key]);
  // Cleared from outside (Clear, leaving the place): follow it.
  const committed = TEXT_FACETS.map((key) => filters[key] || "").join("\u0000");
  useEffect(() => {
    setDraft((current) => {
      const next = Object.fromEntries(TEXT_FACETS.map((key) => [key, filters[key] || ""]));
      return TEXT_FACETS.every((key) => (current[key] || "").trim() === next[key]) ? current : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed]);
  useEffect(() => {
    const timer = setTimeout(() => {
      let next = filters;
      for (const key of TEXT_FACETS) {
        const text = (draft[key] || "").trim();
        if (text !== (filters[key] || "")) next = setOrDelete(next, key, text || undefined);
      }
      if (next !== filters) onChange(next);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const summary = active.length > 1
    ? t("filter.pickedMore", { first: filters[active[0]], count: active.length - 1 })
    : filters[active[0]];
  return (
    <Popover label={t("filter.textContains")} active={active.length > 0} summary={summary} width={230}>
      {TEXT_FACETS.map((key) => (
        <label key={key} className="mb-1.5 block last:mb-0">
          <span className="mb-0.5 block text-[10px] text-muted2">{t(`filter.contains.${key}`)}</span>
          <TextInput
            data-text-facet={key}
            value={draft[key]}
            onChange={(v) => setDraft((current) => ({ ...current, [key]: v }))}
            placeholder={t("filter.containsPlaceholder")}
            className="w-full"
          />
        </label>
      ))}
    </Popover>
  );
}
