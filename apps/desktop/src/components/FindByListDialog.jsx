// "Find by List…" (the list button in the toolbar's search box): paste what a
// client sent — "1723, 1746 1754", in whatever shape — and see the photos
// those numbers name, in the place on screen.
//
// The text is read by utils/pickList.js (no separator is assumed) into a list
// of keywords, and every keyword is looked up on its own, so each chip says
// what it found: nothing (a typo), one photo, several, or far too many to be
// a pick. A click takes a keyword out. What is left is the list, and it does
// one of two things:
//   Filter   the grid shows those photos (filters.name_contains; the filter
//            bar keeps the list as a chip, which opens this dialog again with
//            the list as plain "1723, 1746, 1754")
//   Add      they go into a folder, a new one or one that exists

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListChecks } from "lucide-react";
import api from "../api";
import { Button, Modal, Select, Spinner, TextArea, TextInput, cx } from "../ui";
import { TOP_LAYER_ATTR } from "../utils/topLayer";
import { parsePickList, pickStatus, pickedAssetIds } from "../utils/pickList";

const NEW_FOLDER = "__new__";
const LOOKUP_DELAY_MS = 200;

const CHIP_LOOK = {
  pending: "border-border/60 text-muted2",
  one: "border-border/70 text-text hover:border-border",
  many: "border-amber-400/50 bg-amber-400/10 text-text hover:border-amber-400/70",
  none: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  broad: "border-border/40 text-muted2 line-through",
  off: "border-border/40 text-muted2 line-through opacity-60 hover:opacity-100",
};

export default function FindByListDialog({
  // Where to look: the place on screen ({status, collectionId,
  // includeDescendants, base}) and its name.
  place,
  placeName,
  // The list filtering the grid right now, when the filter bar's chip opened this.
  initialKeywords = [],
  // The folders a batch can go into, depth-first with `depth`.
  folders = [],
  // (keywords) → the grid shows the photos they name.
  onFilter,
  // ({ assetIds, folderId | null, newFolderName }) → adds, and may throw.
  onApply,
  onClose,
}) {
  const { t } = useTranslation("nav");
  const [text, setText] = useState(() => initialKeywords.join(", "));
  const [found, setFound] = useState(new Map()); // keyword (lower-case) → entry
  const [limit, setLimit] = useState(50);
  const [excluded, setExcluded] = useState(new Set());
  const [looking, setLooking] = useState(false);
  const [folderId, setFolderId] = useState(NEW_FOLDER);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);

  const keywords = useMemo(() => parsePickList(text), [text]);
  const keywordsKey = keywords.join("\n");
  const placeKey = JSON.stringify(place || {});

  useEffect(() => {
    const request = ++requestRef.current;
    if (!keywords.length) {
      setLooking(false);
      return undefined;
    }
    setLooking(true);
    const timer = setTimeout(async () => {
      const result = await Promise.resolve(api.findByKeywords({ keywords, ...(place || {}) })).catch(() => null);
      if (request !== requestRef.current) return;
      setFound(new Map((result?.keywords || []).map((entry) => [entry.keyword.toLowerCase(), entry])));
      if (result?.limit) setLimit(result.limit);
      setLooking(false);
    }, LOOKUP_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywordsKey, placeKey]);

  // In the list's order; a keyword typed a moment ago has no answer yet.
  const chips = keywords.map((keyword) => {
    const entry = found.get(keyword.toLowerCase()) || null;
    return { keyword, entry, status: entry ? pickStatus(entry, limit) : "pending" };
  });
  const entries = chips.map((chip) => chip.entry).filter(Boolean);
  const assetIds = pickedAssetIds(entries, limit, excluded);
  // The list itself: the keywords that name photos and were left in.
  const listed = chips
    .filter((chip) => (chip.status === "one" || chip.status === "many") && !excluded.has(chip.keyword.toLowerCase()))
    .map((chip) => chip.keyword);
  const missing = chips.filter((chip) => chip.status === "none").length;
  const broad = chips.filter((chip) => chip.status === "broad").length;
  const settled = !looking && chips.every((chip) => chip.entry);

  const toggle = (keyword) => setExcluded((current) => {
    const next = new Set(current);
    const key = keyword.toLowerCase();
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const newFolder = folderId === NEW_FOLDER;
  const name = folderName.trim() || t("findList.defaultFolder");
  const canApply = settled && assetIds.length > 0 && !busy;

  function filter() {
    if (canApply) onFilter?.(listed);
  }

  async function apply() {
    if (!canApply) return;
    setBusy(true);
    try {
      await onApply?.({ assetIds, folderId: newFolder ? null : folderId, newFolderName: name });
    } finally {
      setBusy(false);
    }
  }

  const chipTitle = (chip) => {
    if (chip.status === "none") return t("findList.none");
    if (chip.status === "broad") return t("findList.broad", { count: chip.entry.count });
    return (chip.entry?.matches || []).slice(0, 12).map((match) => match.file_name).join("\n");
  };

  return (
    <Modal onClose={onClose} z="overlayTop" size="w-full max-w-[440px]">
      <div className="p-4" data-testid="find-list-dialog" {...{ [TOP_LAYER_ATTR]: "true" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-text">
            <ListChecks className="h-4 w-4 text-accent" />
            {t("findList.title")}
          </div>
          <span className="min-w-0 truncate text-[11px] text-muted2" data-testid="find-list-place" title={placeName}>{placeName}</span>
        </div>

        <TextArea
          autoFocus
          rows={4}
          value={text}
          onChange={setText}
          placeholder={t("findList.placeholder")}
          className="mt-3 max-h-[180px] min-h-[76px]"
          data-testid="find-list-input"
          spellCheck={false}
        />

        {chips.length > 0 && (
          <>
            <div className="mt-3 flex max-h-[148px] flex-wrap gap-1 overflow-y-auto" data-testid="find-list-keywords">
              {chips.map((chip) => {
                const off = excluded.has(chip.keyword.toLowerCase());
                const fixed = chip.status === "none" || chip.status === "broad" || chip.status === "pending";
                const count = chip.entry?.count ?? null;
                return (
                  <button
                    key={chip.keyword}
                    type="button"
                    aria-pressed={fixed ? undefined : !off}
                    disabled={fixed}
                    onClick={() => toggle(chip.keyword)}
                    title={chipTitle(chip)}
                    data-find-keyword={chip.keyword}
                    data-status={off ? "off" : chip.status}
                    className={cx(
                      "inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] tabular-nums transition-colors disabled:cursor-default",
                      CHIP_LOOK[off ? "off" : chip.status],
                    )}
                  >
                    {chip.keyword}
                    {count != null && count !== 1 && (
                      <span className="text-[9.5px] opacity-80">{count > limit ? `${limit}+` : count}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex min-h-[16px] items-center gap-2 text-[11px] text-muted2" data-testid="find-list-summary">
              {settled ? (
                <>
                  <span className="text-text">{t("findList.found", { count: assetIds.length })}</span>
                  {missing > 0 && <span className="text-rose-300">{t("findList.missing", { count: missing })}</span>}
                  {broad > 0 && <span>{t("findList.tooBroad", { count: broad })}</span>}
                </>
              ) : (
                <Spinner className="h-3 w-3" />
              )}
            </div>
          </>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Select
            size="lg"
            value={folderId}
            onChange={setFolderId}
            className={newFolder ? "w-[132px] shrink-0" : "min-w-0 flex-1"}
            aria-label={t("findList.destination")}
            data-testid="find-list-folder"
          >
            <option value={NEW_FOLDER}>{t("findList.newFolder")}</option>
            {folders.map((folder) => (
              <option key={folder.collection_id} value={folder.collection_id}>
                {`${"  ".repeat(folder.depth || 0)}${folder.name}`}
              </option>
            ))}
          </Select>
          {newFolder && (
            <TextInput
              size="lg"
              value={folderName}
              onChange={setFolderName}
              placeholder={t("findList.defaultFolder")}
              className="min-w-0 flex-1"
              data-testid="find-list-folder-name"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void apply();
              }}
            />
          )}
          <Button disabled={!canApply} onClick={() => void apply()} className="shrink-0 disabled:cursor-default disabled:opacity-40" data-testid="find-list-apply">
            {t("findList.apply", { count: assetIds.length })}
          </Button>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t("findList.cancel")}</Button>
          <Button variant="primary" disabled={!canApply} onClick={filter} className="disabled:cursor-default disabled:opacity-40" data-testid="find-list-filter">
            {t("findList.filter")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
