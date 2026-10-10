// Inspector block for a photo's description. One field, the user's first:
// what they write is theirs and an AI run never overwrites it; with nothing
// written, the AI's caption shows (badged AI) and is edited like any text —
// saving it makes it the user's. Emptied, it stays empty; "Use the AI's"
// hands it back to the caption.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Section } from "./AnnotationsSection";

export default function DescriptionSection({ assetId, description, source, aiCaption, onSave }) {
  const { t } = useTranslation("annotation");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const areaRef = useRef(null);
  const savingRef = useRef(false);
  // Escape ends editing without saving, even if the box then reports a blur.
  const cancelledRef = useRef(false);

  // Another photo: whatever was being typed belonged to the last one.
  useEffect(() => { setEditing(false); }, [assetId]);

  useEffect(() => {
    if (!editing || !areaRef.current) return;
    const area = areaRef.current;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, [editing]);

  function begin() {
    cancelledRef.current = false;
    setDraft(description || "");
    setEditing(true);
  }

  async function save() {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (savingRef.current) return;
    const next = draft.trim();
    setEditing(false);
    // Unchanged (an AI caption saved as is stays the AI's).
    if (next === (description || "").trim()) return;
    savingRef.current = true;
    try {
      await onSave?.(next);
    } finally {
      savingRef.current = false;
    }
  }

  const ai = source === "ai";
  return (
    <Section title={t("section.description")} badge={ai ? t("badge.ai") : undefined} collapsible>
      <div data-testid="inspector-description" data-source={source || "none"}>
        {editing ? (
          <>
            <textarea
              ref={areaRef}
              value={draft}
              rows={3}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void save()}
              onKeyDown={(event) => {
                // Enter that ends an input method's composition picks characters.
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void save();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelledRef.current = true;
                  setEditing(false);
                }
              }}
              placeholder={t("description.placeholder")}
              data-testid="description-input"
              className="w-full resize-none rounded-md border border-accent/50 bg-app px-2 py-1.5 text-[12px] leading-relaxed text-text outline-none placeholder:text-muted2"
            />
            <div className="mt-1 text-[10px] leading-snug text-muted2">{t("description.keys")}</div>
          </>
        ) : description ? (
          <button
            type="button"
            onClick={begin}
            title={ai ? t("description.aiHint") : t("description.edit")}
            className="block w-full cursor-text whitespace-pre-wrap rounded-md text-left text-[12px] leading-relaxed text-text transition-colors hover:bg-hover/60"
          >
            {description}
          </button>
        ) : (
          <button
            type="button"
            onClick={begin}
            data-testid="description-add"
            className="text-[11px] text-muted2 transition-colors hover:text-text"
          >
            {t("description.add")}
          </button>
        )}
        {!editing && source === "user" && aiCaption && aiCaption !== description ? (
          <button
            type="button"
            onClick={() => void onSave?.(null)}
            title={aiCaption}
            data-testid="description-use-ai"
            className="mt-1 block text-[10px] text-muted2 underline decoration-border underline-offset-2 transition-colors hover:text-text"
          >
            {t("description.useAi")}
          </button>
        ) : null}
      </div>
    </Section>
  );
}
