import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Github, Download, FileText, MessageSquare } from "lucide-react";
import { Group, SecondaryButton } from "./SettingsPrimitives";
import logo from "../../assets/logo.png";

const REPO_URL = "https://github.com/YIWANG3/AfterFrame";
const RELEASES_URL = `${REPO_URL}/releases`;
const ISSUES_URL = `${REPO_URL}/issues`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

const LINKS = [
  { icon: Github, labelKey: "githubRepo", target: REPO_URL, value: "github.com/YIWANG3/AfterFrame" },
  { icon: Download, labelKey: "checkUpdates", target: RELEASES_URL, valueKey: "openReleases" },
  { icon: FileText, labelKey: "license", target: LICENSE_URL, value: "MIT" },
  { icon: MessageSquare, labelKey: "reportIssue", target: ISSUES_URL, valueKey: "openIssueTracker" },
];

export default function AboutSettings() {
  const { t } = useTranslation("settings");
  const [version, setVersion] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const info = await window.mediaWorkspace?.getInfo?.();
        if (info?.version) setVersion(String(info.version));
      } catch {}
    })();
  }, []);

  function openExternal(url) {
    window.mediaWorkspace?.openExternal?.(url);
  }

  return (
    <div>
      {/* Header sits on the page itself, no card: the icon's own rounded shape
          fought with a card radius around it. */}
      <div className="mb-5 flex items-center gap-4 px-1 pb-1 pt-2">
        <img src={logo} alt="AfterFrame" className="h-16 w-16 rounded-[14px]" />
        <div>
          <div className="text-[18px] font-semibold text-text">AfterFrame</div>
          <div className="text-[12px] text-muted2">{t("about.tagline")}</div>
          {version && (
            <div className="mt-1.5 text-[11px] tabular-nums text-muted">
              {version} · arm64
            </div>
          )}
        </div>
      </div>

      <Group>
        {LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <div key={link.labelKey} className="flex items-center justify-between border-b border-border/50 py-3 last:border-b-0">
              <span className="flex items-center gap-2 text-[12px] text-text">
                <Icon className="h-3.5 w-3.5 text-muted2" />
                {t(`about.${link.labelKey}`)}
              </span>
              <SecondaryButton onClick={() => openExternal(link.target)}>
                <span className="inline-flex items-center gap-1.5">
                  {link.valueKey ? t(`about.${link.valueKey}`) : link.value}
                  <ExternalLink className="h-3 w-3" />
                </span>
              </SecondaryButton>
            </div>
          );
        })}
      </Group>

      <Group>
        <div className="py-3 text-[11px] leading-relaxed text-muted2">
          {t("about.updatesPre")}<strong className="text-muted">{t("about.updatesNotAuto")}</strong>{t("about.updatesMid")}
          <button onClick={() => openExternal(RELEASES_URL)} className="text-accent hover:underline">{t("about.githubReleases")}</button>
          {t("about.updatesPost")}
        </div>
      </Group>
    </div>
  );
}
