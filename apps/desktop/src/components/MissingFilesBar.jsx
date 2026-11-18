import { useTranslation } from "react-i18next";
import { FolderSearch, Trash2 } from "lucide-react";
import Button from "../ui/Button";

/* The Missing Originals view's two batch actions, floating at the bottom of
   the gallery like the sample-catalog pill. `selected`: how many photos a
   multi-selection holds, which they then act on; 0, every photo of the view. */
export default function MissingFilesBar({ selected = 0, busy = false, onRelink, onRemove }) {
  const { t } = useTranslation("nav");

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div data-testid="missing-files-bar" className="floating-status-card pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 p-2">
        {onRelink ? (
          <Button type="button" variant="primary" className="gap-1.5" disabled={busy} onClick={onRelink}>
            <FolderSearch className="h-3.5 w-3.5" />
            {selected ? t("missingView.relinkSome", { count: selected }) : t("missingView.relinkAll")}
          </Button>
        ) : null}
        <Button type="button" variant="soft" className="gap-1.5" disabled={busy} onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
          {selected ? t("missingView.removeSome", { count: selected }) : t("missingView.removeAll")}
        </Button>
      </div>
    </div>
  );
}
