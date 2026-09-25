import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, X } from "lucide-react";
import api from "../../api";
import { Modal, Button, cx } from "../../ui";
import { FieldRow, Group, Toggle } from "./SettingsPrimitives";

// Settings ▸ General ▸ Backup & transfer. Export/import of global settings and
// (passphrase-sealed) API keys as a .afsettings file — see
// docs/settings-transfer-plan.md. Desktop only: hidden when the bridge lacks it.

const SECTIONS = ["general", "repaint", "annotation", "watermark"];
const MIN_PASSPHRASE = 8;
const THEME_STORAGE_KEY = "afterframe-theme";

const FIELD =
  "h-8 w-full rounded-md border border-border/70 bg-app px-2 py-0 text-[12px] text-text outline-none placeholder:text-muted2 hover:border-border focus:border-accent/50";

function DialogShell({ title, onClose, children, footer }) {
  return (
    <Modal onClose={onClose} z="overlayTop" className="max-w-[420px]">
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="text-[13px] font-semibold text-text">{title}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1 text-muted2 transition-colors hover:bg-hover hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-4 py-3">{children}</div>
      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">{footer}</div>
    </Modal>
  );
}

function SectionCheck({ id, checked, onChange, detail, disabled }) {
  const { t } = useTranslation("settings");
  return (
    <label className={cx("flex items-start gap-2.5 py-1.5", disabled ? "opacity-50" : "cursor-pointer")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-[rgb(var(--accent-color))]"
        data-testid={`transfer-section-${id}`}
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-text">{t(`transfer.sections.${id}`)}</span>
        <span className="block text-[11px] leading-snug text-muted2">{detail ?? t(`transfer.sections.${id}Hint`)}</span>
      </span>
    </label>
  );
}

function PassphraseInput({ value, onChange, placeholder, testId, autoFocus }) {
  return (
    <div className="relative">
      <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted2" />
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={cx(FIELD, "pl-7")}
        data-testid={testId}
      />
    </div>
  );
}

function ErrorLine({ error }) {
  const { t } = useTranslation("settings");
  if (!error) return null;
  return (
    <div className="mt-2 text-[11px] text-error" role="alert">
      {t(`transfer.errors.${error.code}`, { message: error.message || "", defaultValue: error.message || error.code })}
    </div>
  );
}

function ExportDialog({ theme, onClose }) {
  const { t } = useTranslation("settings");
  const [sections, setSections] = useState(() => new Set(SECTIONS));
  const [includeKeys, setIncludeKeys] = useState(true);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  function toggleSection(id, on) {
    setSections((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }

  async function handleExport() {
    if (!sections.size) return setError({ code: "no_sections" });
    if (includeKeys && pass.length < MIN_PASSPHRASE) return setError({ code: "weak_passphrase" });
    if (includeKeys && pass !== confirm) return setError({ code: "mismatch" });
    setBusy(true);
    setError(null);
    try {
      const res = await api.exportSettings({
        sections: SECTIONS.filter((s) => sections.has(s)),
        includeSecrets: includeKeys,
        passphrase: includeKeys ? pass : undefined,
        theme,
      });
      if (res?.error) setError({ code: res.error, message: res.message });
      else if (!res?.canceled) setResult(res);
    } catch (err) {
      setError({ code: "failed", message: err?.message });
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <DialogShell
        title={t("transfer.exportTitle")}
        onClose={onClose}
        footer={<Button variant="primary" onClick={onClose}>{t("transfer.done")}</Button>}
      >
        <div className="space-y-1.5 text-[12px] text-text" data-testid="transfer-export-result">
          <div className="break-all">{t("transfer.exported", { path: result.filePath })}</div>
          {includeKeys && <div className="text-muted">{t("transfer.exportedKeys", { count: result.secretCount })}</div>}
          {result.unreadableCount > 0 && (
            <div className="text-warn">{t("transfer.unreadable", { count: result.unreadableCount })}</div>
          )}
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      title={t("transfer.exportTitle")}
      onClose={onClose}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t("transfer.cancel")}</Button>
          <Button variant="primary" onClick={handleExport} disabled={busy} data-testid="transfer-export-confirm">
            {busy ? t("transfer.working") : t("transfer.export")}
          </Button>
        </>
      )}
    >
      {SECTIONS.map((id) => (
        <SectionCheck key={id} id={id} checked={sections.has(id)} onChange={(on) => toggleSection(id, on)} />
      ))}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
        <div className="min-w-0">
          <div className="text-[12px] text-text">{t("transfer.includeKeys")}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-muted2">{t("transfer.includeKeysHint")}</div>
        </div>
        <Toggle on={includeKeys} onChange={setIncludeKeys} />
      </div>
      {includeKeys && (
        <div className="mt-3 space-y-2">
          <PassphraseInput value={pass} onChange={setPass} placeholder={t("transfer.passphrasePlaceholder")} testId="transfer-pass" autoFocus />
          <PassphraseInput value={confirm} onChange={setConfirm} placeholder={t("transfer.passphraseConfirm")} testId="transfer-pass-confirm" />
        </div>
      )}
      <ErrorLine error={error} />
    </DialogShell>
  );
}

function ImportDialog({ inspected, onClose }) {
  const { t, i18n } = useTranslation("settings");
  const { summary } = inspected;
  const available = SECTIONS.filter((s) => summary.sections[s]);
  const [sections, setSections] = useState(() => new Set(available));
  const [includeKeys, setIncludeKeys] = useState(summary.secretCount > 0);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  function cancel() {
    void api.cancelSettingsImport();
    onClose();
  }

  function finish() {
    if (result?.theme) {
      try { localStorage.setItem(THEME_STORAGE_KEY, result.theme); } catch { /* keep current theme */ }
    }
    // Every settings tab and the i18n instance read on mount: reload the
    // renderer rather than threading refreshes through each of them.
    window.location.reload();
  }

  function detailFor(id) {
    const section = summary.sections[id];
    if (!section) return t("transfer.notInFile");
    if (id === "general") return t("transfer.sections.generalHint");
    if (id === "watermark") {
      const parts = [];
      if (section.author) parts.push(t("transfer.authorName", { name: section.author }));
      parts.push(t("transfer.templateCount", { count: section.templateCount || 0 }));
      return parts.join(" · ");
    }
    const names = section.providers.map((p) => (p.conflict ? `${p.name} (${t("transfer.willOverwrite")})` : p.name));
    const parts = [names.length ? names.join(", ") : t("transfer.noProviders")];
    if (id === "repaint" && section.styleCount) parts.push(t("transfer.styleCount", { count: section.styleCount }));
    return parts.join(" · ");
  }

  async function handleImport() {
    if (!sections.size && !includeKeys) return setError({ code: "no_sections" });
    if (includeKeys && !pass) return setError({ code: "bad_passphrase" });
    setBusy(true);
    setError(null);
    try {
      const res = await api.applySettingsImport({
        importId: inspected.importId,
        sections: SECTIONS.filter((s) => sections.has(s)),
        includeSecrets: includeKeys,
        passphrase: includeKeys ? pass : undefined,
      });
      if (res?.error) setError({ code: res.error, message: res.message });
      else setResult(res);
    } catch (err) {
      setError({ code: "failed", message: err?.message });
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <DialogShell
        title={t("transfer.importTitle")}
        onClose={finish}
        footer={<Button variant="primary" onClick={finish} data-testid="transfer-import-done">{t("transfer.done")}</Button>}
      >
        <div className="space-y-1.5 text-[12px] text-text" data-testid="transfer-import-result">
          <div>{t("transfer.imported")}</div>
          {includeKeys && <div className="text-muted">{t("transfer.importedKeys", { count: result.tokenCount })}</div>}
          {result.warnings?.map((w) => <div key={w} className="text-warn">{t(`transfer.errors.${w}`)}</div>)}
          <div className="text-[11px] text-muted2">{t("transfer.faceModelNote")}</div>
        </div>
      </DialogShell>
    );
  }

  const exportedAt = new Date(summary.exportedAt);
  const dateLabel = Number.isNaN(exportedAt.getTime()) ? summary.exportedAt : exportedAt.toLocaleString(i18n.language);

  return (
    <DialogShell
      title={t("transfer.importTitle")}
      onClose={cancel}
      footer={(
        <>
          <Button variant="secondary" onClick={cancel}>{t("transfer.cancel")}</Button>
          <Button variant="primary" onClick={handleImport} disabled={busy} data-testid="transfer-import-confirm">
            {busy ? t("transfer.working") : t("transfer.import")}
          </Button>
        </>
      )}
    >
      <div className="mb-2 truncate text-[11px] text-muted2" title={inspected.fileName}>
        {t("transfer.fileInfo", { file: inspected.fileName, date: dateLabel })}
      </div>
      {SECTIONS.map((id) => (
        <SectionCheck
          key={id}
          id={id}
          checked={sections.has(id)}
          disabled={!summary.sections[id]}
          detail={detailFor(id)}
          onChange={(on) => setSections((prev) => {
            const next = new Set(prev);
            if (on) next.add(id); else next.delete(id);
            return next;
          })}
        />
      ))}
      <div className="mt-3 border-t border-border/50 pt-3">
        {summary.secretCount > 0 ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12px] text-text">{t("transfer.importKeys")}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted2">
                  {t("transfer.keysInFile", { count: summary.secretCount })}
                </div>
              </div>
              <Toggle on={includeKeys} onChange={setIncludeKeys} />
            </div>
            {includeKeys && (
              <div className="mt-2">
                <PassphraseInput value={pass} onChange={setPass} placeholder={t("transfer.passphrase")} testId="transfer-import-pass" autoFocus />
              </div>
            )}
          </>
        ) : (
          <div className="text-[11px] leading-snug text-muted2">{t("transfer.noKeysInFile")}</div>
        )}
      </div>
      <div className="mt-2 text-[11px] leading-snug text-muted2">{t("transfer.mergeNote")}</div>
      <ErrorLine error={error} />
    </DialogShell>
  );
}

export default function SettingsTransfer({ theme }) {
  const { t } = useTranslation("settings");
  const [exporting, setExporting] = useState(false);
  const [inspected, setInspected] = useState(null);
  const [inspectError, setInspectError] = useState(null);

  if (!api.has("exportSettings")) return null;

  async function startImport() {
    setInspectError(null);
    try {
      const res = await api.inspectSettingsImport();
      if (res?.error) setInspectError({ code: res.error, message: res.message });
      else if (!res?.canceled) setInspected(res);
    } catch (err) {
      setInspectError({ code: "failed", message: err?.message });
    }
  }

  return (
    <Group title={t("transfer.title")} subtitle={t("transfer.subtitle")}>
      <FieldRow label={t("transfer.exportLabel")} hint={t("transfer.exportHint")}>
        <Button variant="secondary" className="h-7 text-[11px]" onClick={() => setExporting(true)}>
          {t("transfer.exportButton")}
        </Button>
      </FieldRow>
      <FieldRow label={t("transfer.importLabel")} hint={t("transfer.importHint")}>
        <Button variant="secondary" className="h-7 text-[11px]" onClick={startImport}>
          {t("transfer.importButton")}
        </Button>
      </FieldRow>
      {inspectError && <div className="pb-3"><ErrorLine error={inspectError} /></div>}
      {exporting && <ExportDialog theme={theme} onClose={() => setExporting(false)} />}
      {inspected && <ImportDialog inspected={inspected} onClose={() => setInspected(null)} />}
    </Group>
  );
}
