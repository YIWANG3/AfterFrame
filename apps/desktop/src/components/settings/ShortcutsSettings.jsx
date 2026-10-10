// Settings → Keyboard Shortcuts: every key the app answers to, by task. The
// app's own can be changed (click a key, press the new one), given a second
// key, cleared, or put back; the system's and the fixed navigation keys are
// listed so the page is the whole map, but locked.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Plus, RotateCcw, X } from "lucide-react";
import api from "../../api";
import { confirm } from "../confirm";
import { Group, SecondaryButton } from "./SettingsPrimitives";
import {
  SHORTCUT_GROUPS,
  SHORTCUT_ACTIONS,
  bindingProblem,
  eventBinding,
  findConflicts,
  fixedShortcuts,
} from "../../../shared/shortcuts.mjs";
import {
  bindingsFor,
  formatKeys,
  isDefault,
  resetAllBindings,
  resetBindings,
  setBindings,
  shortcutOverrides,
  shortcutPlatform,
  useShortcuts,
} from "../../shortcuts/store";

const MAX_KEYS = 3;

function KeyCap({ children, muted = false, className = "" }) {
  return (
    <span className={[
      "inline-flex h-6 min-w-[24px] items-center justify-center rounded border px-1.5 font-mono text-[11px] leading-none",
      muted ? "border-border/50 bg-transparent text-muted2" : "border-border bg-app text-text",
      className,
    ].join(" ")}>
      {children}
    </span>
  );
}

// Listens for the next key combination while focused. Modifiers held alone
// show as they are pressed; Escape alone cancels; anything else is the answer.
function KeyRecorder({ onRecord, onCancel }) {
  const { t } = useTranslation("settings");
  const ref = useRef(null);
  const [held, setHeld] = useState("");
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <button
      ref={ref}
      type="button"
      data-shortcut-recorder="true"
      className="inline-flex h-6 min-w-[96px] items-center justify-center rounded border border-accent bg-accent/10 px-2 text-[11px] text-accent outline-none"
      onBlur={onCancel}
      onKeyDown={(event) => {
        // Every key is the recorder's: Settings must not close on Escape or
        // its own key, and Space/Enter must not click this button.
        event.preventDefault();
        const native = event.nativeEvent;
        if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          onCancel();
          return;
        }
        const binding = eventBinding(native, shortcutPlatform(), { partial: true });
        if (!binding) return;
        if (binding.endsWith("+")) {
          setHeld(binding);
          return;
        }
        onRecord(binding);
      }}
      onKeyUp={(event) => {
        event.preventDefault();
        const binding = eventBinding(event.nativeEvent, shortcutPlatform(), { partial: true });
        setHeld(binding?.endsWith("+") ? binding : "");
      }}
    >
      {held ? formatKeys(held) : t("shortcuts.pressKeys")}
    </button>
  );
}

function ActionRow({ action, recording, onStartRecording, onRecorded, onCancelRecording, notice, onResolve, onDismiss }) {
  const { t } = useTranslation("settings");
  const keys = bindingsFor(action.id);
  const label = t(`shortcuts.actions.${action.id}`);
  const recordingIndex = recording?.id === action.id ? recording.index : undefined;
  return (
    <div className="border-b border-border/50 py-2 last:border-b-0" data-shortcut-row={action.id}>
      <div className="flex min-h-[28px] items-center justify-between gap-4">
        <div className="min-w-0 flex-1 text-[12px] text-text">{label}</div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {keys.map((binding, index) => (recordingIndex === index ? (
            <KeyRecorder key={`rec-${index}`} onRecord={(next) => onRecorded(action.id, index, next)} onCancel={onCancelRecording} />
          ) : (
            <span key={binding} className="group relative inline-flex">
              <button
                type="button"
                onClick={() => onStartRecording(action.id, index)}
                title={t("shortcuts.change")}
                data-shortcut-key={binding}
                className="rounded transition-shadow hover:ring-1 hover:ring-accent/60"
              >
                <KeyCap>{formatKeys(binding)}</KeyCap>
              </button>
              <button
                type="button"
                onClick={() => void setBindings(action.id, keys.filter((_, i) => i !== index))}
                aria-label={t("shortcuts.removeKey", { keys: formatKeys(binding) })}
                className="absolute -right-1.5 -top-1.5 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-muted2 text-app group-hover:flex"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          )))}
          {recordingIndex === null ? (
            <KeyRecorder onRecord={(next) => onRecorded(action.id, null, next)} onCancel={onCancelRecording} />
          ) : keys.length === 0 ? (
            <span className="text-[11px] text-muted2">{t("shortcuts.none")}</span>
          ) : null}
          {keys.length < MAX_KEYS && recordingIndex !== null && (
            <button
              type="button"
              onClick={() => onStartRecording(action.id, null)}
              title={t("shortcuts.addKey")}
              data-shortcut-add={action.id}
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-dashed border-border/70 text-muted2 transition-colors hover:border-border hover:text-text"
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void resetBindings(action.id)}
            title={t("shortcuts.resetOne")}
            data-shortcut-reset={action.id}
            className={[
              "inline-flex h-6 w-6 items-center justify-center rounded text-muted2 transition-colors hover:bg-hover hover:text-text",
              isDefault(action.id) ? "invisible" : "",
            ].join(" ")}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </div>
      {notice?.id === action.id && (
        <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px]" data-shortcut-notice={notice.kind}>
          <span className={notice.kind === "conflict" ? "text-text" : "text-[#EF9F27]"}>
            {notice.kind === "conflict"
              ? t("shortcuts.conflict", {
                keys: formatKeys(notice.binding),
                actions: notice.conflicts.map((id) => t(`shortcuts.actions.${id}`)).join(t("shortcuts.listSeparator")),
              })
              : t(`shortcuts.problem.${notice.kind}`, { keys: formatKeys(notice.binding) })}
          </span>
          {notice.kind === "conflict" ? (
            <>
              <button type="button" onClick={onResolve} data-shortcut-take-over="true" className="rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-app hover:bg-accent/90">
                {t("shortcuts.takeOver")}
              </button>
              <button type="button" onClick={onDismiss} className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-text">
                {t("shortcuts.keepOld")}
              </button>
            </>
          ) : (
            <button type="button" onClick={onDismiss} aria-label={t("close")} className="text-muted2 hover:text-text">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FixedRow({ entry }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex min-h-[28px] items-center justify-between gap-4 border-b border-border/50 py-2 last:border-b-0" data-shortcut-fixed={entry.id}>
      <div className="min-w-0 flex-1 text-[12px] text-muted">{t(`shortcuts.fixed.${entry.id.slice("fixed.".length)}`)}</div>
      <div className="flex shrink-0 items-center gap-1.5" title={t("shortcuts.locked")}>
        {entry.keys.map((binding) => <KeyCap key={binding} muted>{formatKeys(binding)}</KeyCap>)}
        <span className="inline-flex h-6 w-6 items-center justify-center text-muted2/70"><Lock className="h-3 w-3" /></span>
      </div>
    </div>
  );
}

export default function ShortcutsSettings() {
  const { t } = useTranslation("settings");
  useShortcuts();
  const platform = shortcutPlatform();
  // { id, index } — index null adds a key.
  const [recording, setRecording] = useState(null);
  // { id, kind: "conflict" | "reserved" | "needsModifier", binding, next?, conflicts? }
  const [notice, setNotice] = useState(null);

  // The menu would take ⌘N and friends before the recorder could see them.
  useEffect(() => {
    if (!recording) return undefined;
    void api.setMenuAccelerators?.(false);
    return () => { void api.setMenuAccelerators?.(true); };
  }, [recording]);

  const web = !!api.capabilities.web;
  const fixed = fixedShortcuts(platform);

  function record(id, index, binding) {
    setRecording(null);
    const problem = bindingProblem(binding, id, platform);
    if (problem) {
      setNotice({ id, kind: problem, binding });
      return;
    }
    const current = bindingsFor(id);
    const next = [...current];
    if (index == null) next.push(binding);
    else next[index] = binding;
    const unique = next.filter((key, i) => next.indexOf(key) === i);
    const conflicts = findConflicts(binding, id, shortcutOverrides(), platform);
    if (conflicts.length) {
      setNotice({ id, kind: "conflict", binding, next: unique, conflicts });
      return;
    }
    setNotice(null);
    void setBindings(id, unique);
  }

  async function resetAll() {
    const ok = await confirm({
      title: t("shortcuts.resetAllTitle"),
      message: t("shortcuts.resetAllMsg"),
      confirmLabel: t("shortcuts.resetAll"),
      cancelLabel: t("actions.cancel", { ns: "common" }),
    });
    if (!ok) return;
    setNotice(null);
    await resetAllBindings();
  }

  const anyChanged = SHORTCUT_ACTIONS.some((action) => !isDefault(action.id));

  return (
    <div data-testid="shortcuts-settings">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="text-[11.5px] leading-relaxed text-muted2">{t("shortcuts.intro")}</div>
        <SecondaryButton onClick={() => void resetAll()} disabled={!anyChanged} className="shrink-0">
          {t("shortcuts.resetAll")}
        </SecondaryButton>
      </div>
      {SHORTCUT_GROUPS.map((group) => {
        const actions = SHORTCUT_ACTIONS.filter((action) => action.group === group && !(web && action.desktop));
        const locked = fixed.filter((entry) => entry.group === group);
        if (!actions.length && !locked.length) return null;
        return (
          <Group
            key={group}
            title={t(`shortcuts.groups.${group}`)}
            subtitle={group === "cull" ? t("shortcuts.advanceNote", { shift: platform === "darwin" ? "⇧" : "Shift" }) : undefined}
          >
            {actions.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                recording={recording}
                onStartRecording={(id, index) => { setNotice(null); setRecording({ id, index }); }}
                onRecorded={record}
                onCancelRecording={() => setRecording(null)}
                notice={notice}
                onResolve={() => {
                  const { id, next, conflicts } = notice;
                  setNotice(null);
                  void setBindings(id, next, conflicts);
                }}
                onDismiss={() => setNotice(null)}
              />
            ))}
            {locked.map((entry) => <FixedRow key={entry.id} entry={entry} />)}
          </Group>
        );
      })}
    </div>
  );
}
