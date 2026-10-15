import { useTranslation } from "react-i18next";
import { Check, Split } from "lucide-react";
import api from "../../api";
import Popover from "./Popover";
import { TEXT_FACETS } from "./TextContainsPopover";

// Which facets sit on the bar is the user's choice: every one is listed
// under "Add filter", and the unticked ones are kept out of the way. The
// choice is stored as the HIDDEN set, so a facet added in a later version
// shows up for everyone. A hidden facet that is filtering (a smart
// collection's rule, a person picked from the wall) still shows: what is
// narrowing the grid must always be on the bar.
export const FACET_SLOTS = [
  { id: "camera", keys: ["camera"] },
  { id: "lens", keys: ["lens"] },
  { id: "tag", keys: ["tag", "tag_match"] },
  { id: "extension", keys: ["extension"] },
  { id: "orientation", keys: ["orientation"] },
  { id: "location_source", keys: ["location_source"] },
  { id: "country", keys: ["country"] },
  { id: "city", keys: ["city"] },
  { id: "text", keys: TEXT_FACETS },
  { id: "color", keys: ["color", "color_tolerance"], capability: "colors" },
  { id: "people", keys: ["people"], capability: "people" },
  { id: "annotated", keys: ["annotated"], capability: "annotation" },
  { id: "person_group", keys: ["person_group"], capability: "people" },
  { id: "in_collection", keys: ["in_collection"] },
  { id: "iso", keys: ["iso_min", "iso_max"] },
  { id: "aperture", keys: ["aperture_min", "aperture_max"] },
  { id: "focal", keys: ["focal_min", "focal_max"] },
  { id: "date", keys: ["date_from", "date_to", "date_within_days"] },
  { id: "rating", keys: ["rating_min", "rating_max"] },
  { id: "flag", keys: ["flag"] },
];

export default function FacetChooser({ hidden, onToggle, slotLabel, label, onAddGroups }) {
  const { t } = useTranslation("nav");
  return (
    <Popover label={label || t("filter.addFacet")} width={200}>
      <div className="popover-scroll -mr-2 max-h-[320px] overflow-y-auto pr-1" data-facet-chooser="true">
        {FACET_SLOTS.filter((slot) => !slot.capability || api.can(slot.capability)).map((slot) => {
          const on = !hidden.includes(slot.id);
          return (
            <button
              key={slot.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              data-facet-slot={slot.id}
              onClick={() => onToggle(slot.id)}
              className={[
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
                on ? "text-text" : "text-muted",
              ].join(" ")}
            >
              <span className={[
                "flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border",
                on ? "border-accent/70 bg-accent/15" : "border-border",
              ].join(" ")}
              >
                {on && <Check className="h-2.5 w-2.5 text-accent" />}
              </span>
              <span className="truncate">{slotLabel(slot.id)}</span>
            </button>
          );
        })}
      </div>
      {onAddGroups && (
        <button
          type="button"
          data-filter-groups-entry="true"
          onClick={onAddGroups}
          className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border/60 px-2 pb-1 pt-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
        >
          <Split className="h-3 w-3" />
          {t("filter.groups.entry")}
        </button>
      )}
    </Popover>
  );
}
