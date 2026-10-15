import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ListFilter, Save, SlidersHorizontal } from "lucide-react";
import InlineEdit from "../InlineEdit";
import { ACTION_CHIP } from "./Popover";

// What the bar offers depends on the layer the user is working in
// (hooks/workspaceLogic.js):
//   a status view or folder, refined → "Save as smart collection"
//   inside a smart collection, refined → "Narrow «X» to this" (its rules are
//       rewritten) or "Save as new". An unrefined collection offers nothing:
//       picking a format in there narrows the view, it does not edit the rules.
//   editing a collection's conditions → Save / Cancel
export default function SmartCollectionControls({ smart }) {
  const { t } = useTranslation("nav");
  const [naming, setNaming] = useState(false);
  if (!smart) return null;
  if (smart.editing) {
    return (
      <>
        <span className="flex h-6 items-center gap-1 px-1 text-[11px] text-muted2" data-smart-editing="true">
          <SlidersHorizontal className="h-2.5 w-2.5" />
          <span className="max-w-[140px] truncate">{t("filter.editingSmart", { name: smart.activeName })}</span>
        </span>
        <button type="button" className={ACTION_CHIP} onClick={() => smart.onCancelEdit?.()}>{t("filter.cancelEdit")}</button>
        <button
          type="button"
          className={`${ACTION_CHIP} disabled:cursor-not-allowed disabled:opacity-50`}
          disabled={!smart.dirty || !smart.canSave}
          title={smart.canSave ? undefined : t("filter.needsCondition")}
          onClick={() => smart.onSaveEdit?.()}
        >
          <Save className="h-2.5 w-2.5" />
          {t("filter.saveEdit")}
        </button>
      </>
    );
  }
  if (!smart.canSave) return null;
  if (naming) {
    return (
      <span className="w-40 rounded-md border border-border/70 bg-app" data-smart-name-input="true">
        <InlineEdit
          initial=""
          onConfirm={async (name) => { setNaming(false); await smart.onSave?.(name); }}
          onCancel={() => setNaming(false)}
        />
      </span>
    );
  }
  return (
    <>
      {smart.activeName && (
        <button type="button" className={ACTION_CHIP} onClick={() => smart.onNarrow?.()} title={t("filter.narrowSmartHint", { name: smart.activeName })}>
          <Save className="h-2.5 w-2.5" />
          <span className="max-w-[160px] truncate">{t("filter.narrowSmart", { name: smart.activeName })}</span>
        </button>
      )}
      <button type="button" className={ACTION_CHIP} onClick={() => setNaming(true)}>
        <ListFilter className="h-2.5 w-2.5" />
        {smart.activeName ? t("filter.saveSmartAs") : t("filter.saveSmart")}
      </button>
    </>
  );
}
