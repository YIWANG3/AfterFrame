// Editor top bar: source label + edited badge + dimensions readout on the left,
// Export and Close buttons on the right, with the "add to <folder>" box before
// them when the editor was opened from a folder. Purely presentational — the
// parent computes `dimsLabel` and passes flags. Extracted from EditorOverlay
// (Phase 4).

import { Download, Loader2, X } from "lucide-react";
import { Checkbox } from "../../../ui";

export default function EditorHeader({
  sourceLabel, edited, dimsLabel, saving, exportDisabled, onExport, onClose, t,
  folder, addToFolder, onAddToFolderChange,
}) {
  return (
    <div className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/60 bg-chrome px-4">
      <div className="absolute left-3 flex items-center gap-2 text-[12px]">
        <span className="max-w-[40vw] truncate text-muted2">{sourceLabel}</span>
        {edited ? <span className="text-[11px] text-muted2/60">{t("overlay.edited")}</span> : null}
        {dimsLabel ? <span className="text-[11px] text-muted2/60">{dimsLabel}</span> : null}
      </div>
      <div className="absolute right-3 flex items-center gap-1">
        {folder ? (
          <Checkbox
            className="mr-2 max-w-[240px]"
            label={t("overlay.addToFolder", { name: folder.name })}
            checked={addToFolder}
            onChange={onAddToFolderChange}
            testId="editor-add-to-folder"
          />
        ) : null}
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[rgba(var(--accent-color),0.10)] px-3 text-[11px] font-medium text-[rgb(var(--accent-color))] transition-colors hover:bg-[rgba(var(--accent-color),0.18)] disabled:opacity-60"
          onClick={() => void onExport()}
          disabled={exportDisabled}
          title={t("overlay.save")}
        >
          {/* A full-size save of a 100 MP photo takes seconds: show it working. */}
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {saving ? t("overlay.saving") : t("overlay.saveButton")}
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted2 transition-colors hover:bg-hover hover:text-text"
          onClick={onClose}
          title={t("overlay.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
