import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import api from "../../api";
import { localFileUrl } from "../../utils/format";
import FaceCrop from "../FaceCrop";
import Popover, { MatchModes } from "./Popover";

// A resident "person" facet: pick any named person straight from the gallery,
// without a detour through the people wall. Options load when the panel opens
// so freshly named people always appear.
export default function PersonFilterPopover({ value, personGroup, onSelect, mode, onMode }) {
  const { t } = useTranslation("nav");
  const [known, setKnown] = useState([]);
  const match = (personGroup?.group_id === value ? personGroup : null)
    || known.find((group) => group.group_id === value);
  const name = match?.name?.trim() || t("filter.person");
  const excluded = !!value && mode === "exclude";
  return (
    <Popover
      label={t("filter.person")}
      active={!!value}
      summary={excluded ? t("filter.excludedPerson", { value: name }) : name}
      width={230}
      excluded={excluded}
    >
      {value && onMode && <MatchModes modes={["include", "exclude"]} mode={mode} onMode={onMode} />}
      <PersonFilterOptions value={value} onSelect={onSelect} onLoaded={setKnown} />
    </Popover>
  );
}

export function PersonFilterOptions({ value, onSelect, onLoaded }) {
  const { t } = useTranslation("nav");
  const [groups, setGroups] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.listPeopleGroups() || [];
        const named = rows.filter((group) => group.name?.trim());
        if (!cancelled) { setGroups(named); onLoaded?.(named); }
      } catch {
        if (!cancelled) setGroups([]);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const label = t("filter.person");
  return (
    <div className="popover-scroll -mr-2 max-h-[280px] overflow-y-auto pr-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
        onClick={() => onSelect(undefined)}
      >
        <span className="flex h-3 w-3 items-center justify-center">{!value && <Check className="h-3 w-3 text-accent" />}</span>
        {t("filter.any", { label })}
      </button>
      {groups === null ? (
        <div className="px-2 py-2 text-[11px] text-muted2">{t("people.loading")}</div>
      ) : groups.length === 0 ? (
        <div className="px-2 py-2 text-[11px] text-muted2">{t("filter.noNamedPeople")}</div>
      ) : groups.map((group) => (
        <button
          key={group.group_id}
          type="button"
          className={[
            "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
            value === group.group_id ? "text-text" : "text-muted",
          ].join(" ")}
          onClick={() => onSelect(value === group.group_id ? undefined : group)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-3 w-3 shrink-0 items-center justify-center">{value === group.group_id && <Check className="h-3 w-3 text-accent" />}</span>
            <FaceCrop
              src={localFileUrl(group.cover_preview_path || group.cover_image_path)}
              bbox={group.cover_bbox}
              size={20}
              className="shrink-0 rounded-full"
            />
            <span className="truncate">{group.name}</span>
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted2">{group.face_count}</span>
        </button>
      ))}
    </div>
  );
}
