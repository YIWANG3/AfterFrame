import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Github, Download, FileText, MessageSquare } from "lucide-react";
import { FieldRow, Group, PrimaryButton, SecondaryButton, Toggle } from "./SettingsPrimitives";
import { Spinner } from "../../ui";
import useUpdateState from "../../hooks/useUpdateState";
import logo from "../../assets/logo.png";
import api from "../../api";

const REPO_URL = "https://github.com/YIWANG3/AfterFrame";
const RELEASES_URL = `${REPO_URL}/releases`;
const ISSUES_URL = `${REPO_URL}/issues`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

const LINKS = [
  { icon: Github, labelKey: "githubRepo", target: REPO_URL, value: "github.com/YIWANG3/AfterFrame" },
  { icon: FileText, labelKey: "license", target: LICENSE_URL, value: "MIT" },
  { icon: MessageSquare, labelKey: "reportIssue", target: ISSUES_URL, valueKey: "openIssueTracker" },
];

function LinkButton({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-text"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </button>
  );
}

// Restarting stops the background work the app is doing; it waits for that.
function useJobsRunning(watch) {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!watch || !api.has("getActiveJobs")) { setRunning(false); return undefined; }
    let alive = true;
    const poll = async () => {
      const jobs = await Promise.resolve(api.getActiveJobs()).catch(() => []);
      if (alive) setRunning((jobs || []).some((job) => job.running));
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [watch]);
  return running;
}

// Settings ▸ About ▸ Software Update (electron/updater.js): what the updater is
// doing and the one step it waits for. A build without an updater (dev, the
// web build) keeps the link to the releases page.
function UpdateRows({ update, openExternal }) {
  const { t } = useTranslation("settings");
  const jobsRunning = useJobsRunning(update.status === "ready");
  const { status, version, percent, error, canInstall } = update;

  let line;
  let action = null;
  if (status === "checking") {
    line = <span className="inline-flex items-center gap-1.5"><Spinner className="h-3 w-3" />{t("about.updateChecking")}</span>;
  } else if (status === "current") {
    line = t("about.updateCurrent");
  } else if (status === "available") {
    line = t("about.updateAvailable", { version });
    action = canInstall
      ? <PrimaryButton onClick={() => api.downloadUpdate()}>{t("about.updateDownload")}</PrimaryButton>
      : <SecondaryButton onClick={() => openExternal(update.releaseUrl)}>{t("about.updateFromGithub")}</SecondaryButton>;
  } else if (status === "downloading") {
    line = t("about.updateDownloading", { percent: percent ?? 0 });
  } else if (status === "ready") {
    line = jobsRunning ? t("about.updateJobsRunning") : t("about.updateReady", { version });
    action = <PrimaryButton disabled={jobsRunning} onClick={() => api.installUpdate()}>{t("about.updateRestart")}</PrimaryButton>;
  } else if (status === "error") {
    line = <span className="text-error">{t(`about.updateError.${error?.stage || "check"}`)}</span>;
    action = error?.stage === "download"
      ? <SecondaryButton onClick={() => api.downloadUpdate()}>{t("about.updateRetry")}</SecondaryButton>
      : error?.stage === "install"
        ? <SecondaryButton onClick={() => openExternal(update.releaseUrl)}>{t("about.updateFromGithub")}</SecondaryButton>
        : <SecondaryButton onClick={() => api.checkForUpdates()}>{t("about.updateRetry")}</SecondaryButton>;
  }
  if (!action && status !== "checking" && status !== "downloading") {
    action = <SecondaryButton onClick={() => api.checkForUpdates()}>{t("about.updateCheck")}</SecondaryButton>;
  }
  // A copy on a disk image, or one macOS runs from a read-only copy, can't
  // replace itself: says where it has to be.
  const hint = status === "available" && !canInstall ? t("about.updateMoveToApplications") : null;

  return (
    <Group>
      <div data-update-status={status} className="border-b border-border/50 py-3 last:border-b-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12px] text-text">
              <Download className="h-3.5 w-3.5 text-muted2" />
              {t("about.softwareUpdate")}
            </div>
            {line && <div className="mt-1 pl-[22px] text-[11px] text-muted2" data-update-line="">{line}</div>}
            {hint && <div className="mt-1 pl-[22px] text-[11px] text-muted2">{hint}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {version && status !== "current" && (
              <LinkButton onClick={() => openExternal(update.releaseUrl)}>{t("about.updateWhatsNew")}</LinkButton>
            )}
            {action}
          </div>
        </div>
        {status === "downloading" && (
          <div className="ml-[22px] mt-2 h-1 overflow-hidden rounded-full bg-[var(--fill-3)]" role="progressbar" aria-valuenow={percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent ?? 0}%` }} />
          </div>
        )}
      </div>
      <FieldRow label={t("about.updateAutoCheck")}>
        <Toggle on={update.autoCheck} onChange={(on) => api.setUpdateAutoCheck(on)} />
      </FieldRow>
    </Group>
  );
}

export default function AboutSettings() {
  const { t } = useTranslation("settings");
  const update = useUpdateState();

  function openExternal(url) {
    api.openExternal(url);
  }

  return (
    <div>
      {/* Header sits on the page itself, no card: the icon's own rounded shape
          fought with a card radius around it. */}
      <div className="mb-5 flex items-center gap-4 px-1 pb-1 pt-2">
        <img src={logo} alt="AfterFrame" className="h-16 w-16" />
        <div>
          <div className="text-[18px] font-semibold text-text">AfterFrame</div>
          <div className="text-[12px] text-muted2">{t("about.tagline")}</div>
          {update?.currentVersion && (
            <div className="mt-1.5 text-[11px] tabular-nums text-muted" data-app-version="">
              {update.currentVersion} · {update.arch}
            </div>
          )}
        </div>
      </div>

      {update?.supported && <UpdateRows update={update} openExternal={openExternal} />}

      <Group>
        {!update?.supported && (
          <div className="flex items-center justify-between border-b border-border/50 py-3 last:border-b-0">
            <span className="flex items-center gap-2 text-[12px] text-text">
              <Download className="h-3.5 w-3.5 text-muted2" />
              {t("about.checkUpdates")}
            </span>
            <LinkButton onClick={() => openExternal(RELEASES_URL)}>{t("about.openReleases")}</LinkButton>
          </div>
        )}
        {LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <div key={link.labelKey} className="flex items-center justify-between border-b border-border/50 py-3 last:border-b-0">
              <span className="flex items-center gap-2 text-[12px] text-text">
                <Icon className="h-3.5 w-3.5 text-muted2" />
                {t(`about.${link.labelKey}`)}
              </span>
              <LinkButton onClick={() => openExternal(link.target)}>
                {link.valueKey ? t(`about.${link.valueKey}`) : link.value}
              </LinkButton>
            </div>
          );
        })}
      </Group>
    </div>
  );
}
