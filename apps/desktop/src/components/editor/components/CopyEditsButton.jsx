// "Copy edits" in the editor header: lists the edits this photo actually has,
// lets the user tick which ones travel, and puts them on the app-wide edit
// clipboard for the gallery's "Paste edits".
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { availableKinds, buildClipboard } from "../pasteEdits";
import { setEditClipboard } from "../../../utils/editClipboard";

// The straighten angle is tuned to one photo's horizon; it is offered, not assumed.
const DEFAULT_PICKED = { rotate: true, flip: true, crop: true, angle: false };

export default function CopyEditsButton({ edits, t }) {
  const kinds = availableKinds(edits);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(DEFAULT_PICKED);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef(null);
  const copiedTimer = useRef(null);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const clipboard = buildClipboard(edits, picked);

  function copy() {
    if (!clipboard) return;
    setEditClipboard(clipboard);
    setOpen(false);
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-copy-edits="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
        onClick={() => setOpen((value) => !value)}
        disabled={kinds.length === 0}
        title={kinds.length === 0 ? t("copyEdits.nothing") : t("copyEdits.button")}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? t("copyEdits.copied") : t("copyEdits.button")}
      </button>
      {open && (
        <div
          data-copy-edits="panel"
          className="absolute right-0 top-9 z-50 w-56 rounded-lg border border-border bg-chrome p-2 shadow-overlay"
        >
          <div className="px-1.5 pb-1.5 pt-1 text-[11px] leading-snug text-muted2">{t("copyEdits.hint")}</div>
          {kinds.map((kind) => (
            <label key={kind} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[12px] text-text hover:bg-hover">
              <input
                type="checkbox"
                className="accent-[rgb(var(--accent-color))]"
                checked={!!picked[kind]}
                onChange={(event) => setPicked((value) => ({ ...value, [kind]: event.target.checked }))}
              />
              {t(`copyEdits.kinds.${kind}`)}
            </label>
          ))}
          <button
            type="button"
            className="mt-1.5 inline-flex h-7 w-full items-center justify-center rounded-md bg-[rgba(var(--accent-color),0.10)] text-[11px] font-medium text-[rgb(var(--accent-color))] transition-colors hover:bg-[rgba(var(--accent-color),0.18)] disabled:opacity-50"
            onClick={copy}
            disabled={!clipboard}
          >
            {t("copyEdits.confirm")}
          </button>
        </div>
      )}
    </div>
  );
}
