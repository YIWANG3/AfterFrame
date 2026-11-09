// "Add Tags…" / "Remove Tags…" for the selection (gallery menu, T / Shift+T):
// adding gathers one or more tags — typed, or picked from the library's own,
// pinned first — then puts them all on every selected photo in one write;
// removing offers the tags the selected photos carry (with how many have
// each) and takes the ticked ones off all of them.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pin, Tag, X } from "lucide-react";
import api from "../api";
import Modal from "../ui/Modal";
import { TOP_LAYER_ATTR } from "../utils/topLayer";
import { groupLabel, tagLabel, useTagGroups } from "./annotation/tagStore";

export default function TagBatchDialog({ assetIds = [], count, mode: initialMode = "add", onApply, onClose }) {
  const { t, i18n } = useTranslation("annotation");
  const { t: tNav } = useTranslation("nav");
  const [mode, setMode] = useState(initialMode);
  const [tags, setTags] = useState([]);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [present, setPresent] = useState(null); // remove mode: [{tag, count, group_id}]
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const groups = useTagGroups();
  const labelOf = (tag) => tagLabel(tag, i18n.language);
  const groupLabelOf = (id) => (id ? groupLabel(groups.find((g) => g.group_id === id), tNav) : null);

  // The library's tags, most used first (pinned on top), narrowed as the user types.
  useEffect(() => {
    if (mode !== "add") return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = (await api.searchFacet({ field: "tag", q: text.trim(), limit: 12 }).catch(() => [])) || [];
      if (cancelled) return;
      const chosen = new Set(tags.map((tag) => tag.toLowerCase()));
      setSuggestions(found.filter((entry) => !chosen.has(String(entry.value).toLowerCase())));
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text, tags, mode]);

  // The tags the selection carries, for removing.
  useEffect(() => {
    if (mode !== "remove") return undefined;
    let cancelled = false;
    setPresent(null);
    void Promise.resolve(api.listSelectionTags(assetIds)).then((rows) => { if (!cancelled) setPresent(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setPresent([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, assetIds.join("|")]);

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setTags([]);
    setText("");
  }

  function addTag(value) {
    const tag = String(value ?? text).trim();
    setText("");
    if (!tag || tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    setTags((current) => [...current, tag]);
    inputRef.current?.focus();
  }

  const toggleRemove = (tag) => setTags((current) => (current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag]));

  async function apply() {
    // A tag still in the box counts: typing one and pressing Add should work.
    const pending = mode === "add" ? text.trim() : "";
    const all = pending && !tags.some((tag) => tag.toLowerCase() === pending.toLowerCase()) ? [...tags, pending] : tags;
    if (!all.length || busy) return;
    setBusy(true);
    try {
      await onApply(all, mode);
    } finally {
      setBusy(false);
    }
  }

  const canApply = (tags.length > 0 || (mode === "add" && text.trim().length > 0)) && !busy;
  const segment = (value, label) => (
    <button
      key={value}
      type="button"
      data-tag-batch-mode={value}
      aria-pressed={mode === value}
      onClick={() => switchMode(value)}
      className={["h-6 rounded px-2.5 text-[11px] transition-colors", mode === value ? "bg-selected text-text" : "text-muted2 hover:text-text"].join(" ")}
    >
      {label}
    </button>
  );

  return (
    <Modal onClose={onClose} z="overlayTop" size="w-full max-w-[400px]">
      <div className="p-4" data-testid="tag-batch-dialog" data-mode={mode} {...{ [TOP_LAYER_ATTR]: "true" }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-text">
            <Tag className="h-4 w-4 text-accent" />
            {mode === "add" ? t("batch.title", { count }) : t("batch.removeTitle", { count })}
          </div>
          <div className="flex gap-0.5 rounded-md bg-app p-0.5">
            {segment("add", t("batch.mode.add"))}
            {segment("remove", t("batch.mode.remove"))}
          </div>
        </div>
        {mode === "add" && <div className="mt-1 text-[11.5px] leading-snug text-muted2">{t("batch.hint")}</div>}

        {mode === "add" ? (
          <>
            <div className="mt-3 flex min-h-[34px] flex-wrap items-center gap-1 rounded-lg border border-border bg-app px-2 py-1 focus-within:border-accent/50">
              {tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-[2px] text-[11px] text-accent" data-batch-tag={tag}>
                  {labelOf(tag)}
                  <button
                    type="button"
                    aria-label={t("batch.removeTag", { tag })}
                    onClick={() => setTags((current) => current.filter((existing) => existing !== tag))}
                    className="text-accent/70 hover:text-accent"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                autoFocus
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    // Enter on an empty box applies; otherwise it adds the tag typed.
                    if (text.trim()) addTag();
                    else void apply();
                  } else if (event.key === "Backspace" && !text && tags.length) {
                    setTags((current) => current.slice(0, -1));
                  } else if (event.key === "," || event.key === "，") {
                    event.preventDefault();
                    addTag();
                  }
                }}
                placeholder={tags.length ? "" : t("batch.placeholder")}
                className="min-w-[120px] flex-1 bg-transparent py-0.5 text-[12px] text-text outline-none placeholder:text-muted2"
                data-testid="tag-batch-input"
              />
            </div>

            {suggestions.length > 0 && (
              <div className="mt-3">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted2">{t("batch.existing")}</div>
                <div className="flex max-h-[96px] flex-wrap gap-1 overflow-y-auto">
                  {suggestions.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      onClick={() => addTag(entry.value)}
                      className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-[2px] text-[11px] text-muted transition-colors hover:border-border hover:text-text"
                      data-tag-suggestion={entry.value}
                    >
                      {entry.pinned && <Pin className="h-2.5 w-2.5 text-muted2" />}
                      {labelOf(entry.value)}
                      {entry.group_id && <span className="text-[9.5px] text-muted2">{groupLabelOf(entry.group_id)}</span>}
                      <span className="text-[9.5px] tabular-nums text-muted2">{entry.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="mt-3 flex max-h-[220px] min-h-[34px] flex-wrap gap-1 overflow-y-auto" data-testid="tag-batch-present">
            {present && !present.length && <span className="text-[11.5px] text-muted2">{t("batch.nothingToRemove")}</span>}
            {(present || []).map((entry) => {
              const on = tags.includes(entry.tag);
              return (
                <button
                  key={entry.tag}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggleRemove(entry.tag)}
                  data-batch-present-tag={entry.tag}
                  className={[
                    "inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[11px] transition-colors",
                    on ? "border-red-400/60 bg-red-400/10 text-text" : "border-border/60 text-muted hover:border-border hover:text-text",
                  ].join(" ")}
                >
                  {on && <Check className="h-2.5 w-2.5 text-red-400" />}
                  {labelOf(entry.tag)}
                  {entry.group_id && <span className="text-[9.5px] text-muted2">{groupLabelOf(entry.group_id)}</span>}
                  <span className="text-[9.5px] tabular-nums text-muted2">{entry.count}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-text transition-colors hover:bg-hover"
          >
            {t("batch.cancel")}
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => void apply()}
            className={[
              "rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:cursor-default disabled:opacity-40",
              mode === "add" ? "bg-accent text-app hover:bg-accent/90" : "bg-red-500/90 text-white hover:bg-red-500",
            ].join(" ")}
            data-testid="tag-batch-apply"
          >
            {mode === "add" ? t("batch.apply", { count }) : t("batch.removeApply", { count: tags.length })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
