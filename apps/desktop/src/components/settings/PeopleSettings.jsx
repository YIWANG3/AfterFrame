import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Cpu, Download, FolderPlus, LoaderCircle, Play, Trash2, UsersRound } from "lucide-react";
import api from "../../api";
import { Callout, FieldRow, Group, PrimaryButton, SecondaryButton, Toggle } from "./SettingsPrimitives";

function emptySettings() {
  return { activeModelKey: null, activeModel: null, models: [], automaticDownloads: false, download: { available: false } };
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 * 1024 ? 1 : 0)} MB`;
}

function ModelRow({ model, active, busy, onActivate, onRemove, t }) {
  const unverified = model.license === "Unverified custom model";
  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-3 last:border-b-0">
      <div className={[
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
        active ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-app text-muted2",
      ].join(" ")}
      >
        <Cpu className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-text">{model.name}</span>
          {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-label={t("people.active")} />}
          {!model.available && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label={t("people.modelMissing")} />}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted2">
          {t("people.modelMeta", { version: model.version || "—", size: formatSize(model.sizeBytes), dimensions: model.embeddingDimensions || "—" })}
        </div>
        {unverified && <div className="mt-0.5 text-[10px] text-warn">{t("people.unverified")}</div>}
      </div>
      {!active && model.available && (
        <SecondaryButton disabled={busy} onClick={() => onActivate(model.key)}>{t("people.useModel")}</SecondaryButton>
      )}
      {!active && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRemove(model.key)}
          className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-red-400 disabled:opacity-40"
          title={t("people.removeModel")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export default function PeopleSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const [nextSettings, nextJob] = await Promise.all([
      api.getPeopleSettings(),
      api.getPeopleIndexStatus(),
    ]);
    setSettings(nextSettings || emptySettings());
    setJob(nextJob || null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((reason) => { if (!cancelled) setError(reason?.message || String(reason)); });
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    if (!job?.active) return undefined;
    const timer = window.setInterval(() => {
      api.getPeopleIndexStatus().then(setJob).catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, [job?.active]);

  const perform = useCallback(async (name, action) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(reason?.message || String(reason));
    } finally {
      setBusy(null);
    }
  }, [busy, refresh]);

  if (!settings) return <div className="text-[12px] text-muted">{t("people.loading")}</div>;

  const model = settings.activeModel;
  const indexing = !!job?.active;
  const progress = Math.round(Math.max(0, Math.min(1, Number(job?.progress || 0))) * 100);

  return (
    <div>
      <Group title={t("people.modelTitle")} subtitle={t("people.modelSubtitle")} badge="Local">
        {model ? (
          <div className="flex items-center gap-3 py-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-accent/40 bg-accent/10 text-accent">
              <UsersRound className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-text">{model.name}</div>
              <div className="mt-0.5 text-[10px] text-muted2">{t("people.activeModelHint", { size: formatSize(model.sizeBytes) })}</div>
            </div>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">{t("people.ready")}</span>
          </div>
        ) : (
          <div className="px-1 py-5 text-center text-[11px] text-muted2">{t("people.noModel")}</div>
        )}
        <FieldRow label={t("people.installModel")} hint={t("people.installModelHint")}>
          {settings.download?.available && (
            <PrimaryButton disabled={!!busy} onClick={() => perform("download", () => api.downloadOfficialPeopleModel())}>
              <span className="inline-flex items-center gap-1.5">
                {busy === "download" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {busy === "download" ? t("people.downloading") : t("people.downloadModel", { size: formatSize(settings.download.sizeBytes) })}
              </span>
            </PrimaryButton>
          )}
          <PrimaryButton disabled={!!busy} onClick={() => perform("install", () => api.pickPeopleModel())}>
            <span className="inline-flex items-center gap-1.5">
              {busy === "install" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
              {busy === "install" ? t("people.validating") : t("people.chooseModel")}
            </span>
          </PrimaryButton>
        </FieldRow>
        <FieldRow label={t("people.automaticDownload")} hint={t("people.automaticDownloadHint")}>
          <Toggle on={settings.automaticDownloads} disabled={!settings.download?.available} onChange={(value) => perform("updates", () => api.setPeopleAutomaticDownloads(value))} />
        </FieldRow>
      </Group>

      {settings.models?.length > 0 && (
        <Group title={t("people.installedModels")}>
          {settings.models.map((entry) => (
            <ModelRow
              key={entry.key}
              model={entry}
              active={entry.key === settings.activeModelKey}
              busy={!!busy}
              onActivate={(key) => perform("activate", () => api.setActivePeopleModel(key))}
              onRemove={(key) => perform("remove", () => api.removePeopleModel(key))}
              t={t}
            />
          ))}
        </Group>
      )}

      <Group title={t("people.indexTitle")} subtitle={t("people.indexSubtitle")} scope={t("scope.catalog")}>
        {indexing ? (
          <div className="py-3">
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="min-w-0 truncate text-text">{job.paused ? t("people.paused") : t("people.indexing")}</span>
              <span className="shrink-0 tabular-nums text-muted2">{progress}%</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-app">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : (
          <FieldRow label={t("people.analyzeLibrary")} hint={t("people.analyzeLibraryHint")}>
            <PrimaryButton disabled={!model?.available || !!busy} onClick={() => perform("index", async () => {
              const started = await api.startPeopleIndex({ priority: 5 });
              window.dispatchEvent(new CustomEvent("people-index:started", { detail: started }));
            })}>
              <span className="inline-flex items-center gap-1.5"><Play className="h-3.5 w-3.5" />{t("people.startIndex")}</span>
            </PrimaryButton>
          </FieldRow>
        )}
      </Group>

      <Callout>{t("people.privacy")}</Callout>
      {error && <div role="alert" className="mt-3 flex gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
    </div>
  );
}
