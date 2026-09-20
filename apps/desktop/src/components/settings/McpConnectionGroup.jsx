import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink } from "lucide-react";
import api from "../../api";
import { Group, FieldRow, Callout } from "./SettingsPrimitives";

const DOCS_URL = "https://github.com/YIWANG3/AfterFrame/blob/main/docs/agent-native-mcp.md";

const STATUS_DOT = {
  running: "bg-success",
  starting: "bg-muted2",
  port_in_use: "bg-warn",
  error: "bg-warn",
};

// Claude Code and Cursor speak streamable HTTP natively. Claude Desktop's
// config is stdio-only, so it needs the mcp-remote bridge (and Node).
function snippetsFor(url) {
  const json = (server) => JSON.stringify({ mcpServers: { afterframe: server } }, null, 2);
  return [
    { id: "claudeCode", code: `claude mcp add --transport http afterframe ${url}` },
    { id: "json", code: json({ type: "http", url }) },
    { id: "claudeDesktop", code: json({ command: "npx", args: ["-y", "mcp-remote", url] }) },
  ];
}

function Snippet({ id, code, label, hint }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    await api.copyText(code);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <FieldRow stack label={label} hint={hint}>
      <div className="relative">
        <pre
          data-mcp-snippet={id}
          className="overflow-x-auto rounded-[6px] bg-app px-3 py-2.5 pr-20 font-mono text-[11px] leading-relaxed text-text"
        >{code}</pre>
        <button
          type="button"
          onClick={copy}
          className="absolute right-1.5 top-1.5 inline-flex h-6 items-center gap-1 rounded border border-border bg-panel px-2 text-[11px] text-text transition-colors hover:bg-hover"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t("integrations.mcpCopied") : t("integrations.mcpCopy")}
        </button>
      </div>
    </FieldRow>
  );
}

export default function McpConnectionGroup() {
  const { t } = useTranslation("settings");
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve(api.getMcpStatus?.()).then((next) => { if (alive && next) setInfo(next); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!info) return null;
  const running = info.status === "running";

  return (
    <Group title={t("integrations.mcpTitle")} subtitle={t("integrations.mcpSubtitle")}>
      <FieldRow
        label={
          <span className="inline-flex items-center gap-2" data-mcp-status={info.status}>
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[info.status] || STATUS_DOT.error}`} />
            {t(`integrations.mcpStatus.${info.status}`, { defaultValue: t("integrations.mcpStatus.error") })}
          </span>
        }
        hint={running ? t("integrations.mcpRunningHint", { url: info.url, count: info.toolCount }) : null}
      >
        <button
          type="button"
          onClick={() => api.openExternal(DOCS_URL)}
          className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
        >
          {t("integrations.mcpDocs")}
          <ExternalLink className="h-3 w-3" />
        </button>
      </FieldRow>

      {!running && info.status !== "starting" && (
        <div className="py-3">
          <Callout tone="warn">
            {info.status === "port_in_use"
              ? t("integrations.mcpPortInUseHint", { port: info.port })
              : t("integrations.mcpErrorHint", { error: info.error || "" })}
          </Callout>
        </div>
      )}

      {running && snippetsFor(info.url).map((s) => (
        <Snippet
          key={s.id}
          id={s.id}
          code={s.code}
          label={t(`integrations.mcpSnippets.${s.id}.label`)}
          hint={t(`integrations.mcpSnippets.${s.id}.hint`)}
        />
      ))}
    </Group>
  );
}
