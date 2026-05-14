import { useEffect, useState } from "react";
import { ExternalLink, Github, Download, FileText, MessageSquare } from "lucide-react";
import { Group } from "./SettingsPrimitives";

const REPO_URL = "https://github.com/YIWANG3/AfterFrame";
const RELEASES_URL = `${REPO_URL}/releases`;
const ISSUES_URL = `${REPO_URL}/issues`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

const LINKS = [
  { icon: Github, label: "GitHub repository", target: REPO_URL, value: "github.com/YIWANG3/AfterFrame" },
  { icon: Download, label: "Check for updates", target: RELEASES_URL, value: "Open Releases" },
  { icon: FileText, label: "License", target: LICENSE_URL, value: "MIT" },
  { icon: MessageSquare, label: "Report an issue", target: ISSUES_URL, value: "Open issue tracker" },
];

export default function AboutSettings() {
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
      <div className="mb-6 flex items-center gap-4 border-b border-border pb-5">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent/70 text-[28px] font-bold text-app shadow-[0_4px_16px_rgba(212,167,85,0.3)]">
          A
        </div>
        <div>
          <div className="text-[18px] font-semibold text-text">AfterFrame</div>
          <div className="text-[12px] text-muted2">A local-first photo workspace for photographers.</div>
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
            <div key={link.label} className="flex items-center justify-between border-b border-border/50 py-3 last:border-b-0">
              <span className="flex items-center gap-2 text-[12px] text-text">
                <Icon className="h-3.5 w-3.5 text-muted2" />
                {link.label}
              </span>
              <button
                type="button"
                onClick={() => openExternal(link.target)}
                className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80"
              >
                {link.value}
                <ExternalLink className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}
      </Group>

      <div className="mt-5 border-t border-border pt-4 text-[11px] leading-relaxed text-muted2">
        Updates are <strong className="text-muted">not automatic</strong> — when a new version ships, download the .dmg from{" "}
        <button onClick={() => openExternal(RELEASES_URL)} className="text-accent hover:underline">GitHub Releases</button>
        {" "}and drag it over the old Applications/AfterFrame.app. Catalogs and settings persist across updates.
        <br /><br />
        Built with{" "}
        <button onClick={() => openExternal("https://claude.com/claude-code")} className="text-accent hover:underline">Claude Code</button>.
        Sticker extraction uses Apple VisionKit; depth-aware text uses Depth Anything V2.
      </div>
    </div>
  );
}
