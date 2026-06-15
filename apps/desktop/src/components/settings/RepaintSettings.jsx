// Global Settings tab for AI Repaint providers. Reads/writes the same
// aiPreferences store as the editor's AiRepaintPanel (which reloads prefs on
// open) and the MCP repaint_asset tool, so the three stay in sync:
// providers + credentials, the active provider, and each provider's model.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Group, Callout, SecondaryButton } from "./SettingsPrimitives";
import { PROVIDER_TYPES, getProviderType, ProviderModal } from "../ai/providers";

export default function RepaintSettings() {
  const { t } = useTranslation("settings");
  const [prefs, setPrefs] = useState(null);
  const [modal, setModal] = useState(null); // { mode: "new"|"edit", instance }
  const [refreshing, setRefreshing] = useState({});

  useEffect(() => {
    void (async () => {
      const p = (await window.mediaWorkspace?.getAiPreferences?.()) || {};
      setPrefs({ providers: [], activeProvider: null, selectedModels: {}, modelsCache: {}, ...p });
    })();
  }, []);

  function persist(patch) {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      void window.mediaWorkspace?.saveAiPreferences?.(next);
      return next;
    });
  }

  function modelOptions(inst) {
    const cached = prefs.modelsCache?.[inst.id];
    const models = Array.isArray(cached) && cached.length ? cached : getProviderType(inst.type)?.defaultModels || [];
    return models.map((m) => ({ value: m.id, label: m.name || m.id }));
  }

  async function refreshModels(inst) {
    setRefreshing((r) => ({ ...r, [inst.id]: true }));
    try {
      const models = await window.mediaWorkspace?.listAiModels?.(inst.id, inst.type);
      if (Array.isArray(models) && models.length) {
        const selected = prefs.selectedModels?.[inst.id];
        persist({
          modelsCache: { ...prefs.modelsCache, [inst.id]: models },
          selectedModels: {
            ...prefs.selectedModels,
            [inst.id]: models.some((m) => m.id === selected) ? selected : models[0].id,
          },
        });
      }
    } finally {
      setRefreshing((r) => ({ ...r, [inst.id]: false }));
    }
  }

  async function handleSave(inst, tokenValue) {
    const exists = prefs.providers.some((p) => p.id === inst.id);
    const providers = exists
      ? prefs.providers.map((p) => (p.id === inst.id ? { id: inst.id, type: inst.type, name: inst.name } : p))
      : [...prefs.providers, { id: inst.id, type: inst.type, name: inst.name }];
    if (tokenValue) {
      await window.mediaWorkspace?.setAiProviderToken?.(inst.id, tokenValue);
    }
    persist({
      providers,
      activeProvider: prefs.activeProvider || inst.id,
    });
    setModal(null);
  }

  async function handleDelete(instanceId) {
    await window.mediaWorkspace?.deleteAiProviderToken?.(instanceId);
    const providers = prefs.providers.filter((p) => p.id !== instanceId);
    const selectedModels = { ...prefs.selectedModels };
    const modelsCache = { ...prefs.modelsCache };
    delete selectedModels[instanceId];
    delete modelsCache[instanceId];
    persist({
      providers,
      selectedModels,
      modelsCache,
      activeProvider: prefs.activeProvider === instanceId ? providers[0]?.id || null : prefs.activeProvider,
    });
    setModal(null);
  }

  if (!prefs) return null;

  return (
    <div>
      <Group
        title={t("repaint.providers")}
        subtitle={t("repaint.providersSubtitle")}
      >
        <div className="py-3">
        {prefs.providers.length === 0 && (
          <div className="mb-2.5"><Callout>{t("repaint.noProvider")}</Callout></div>
        )}

        <div className="flex flex-col gap-1.5">
          {prefs.providers.map((inst) => {
            const tmpl = getProviderType(inst.type);
            const active = prefs.activeProvider === inst.id;
            return (
              <div
                key={inst.id}
                className={[
                  "flex items-center gap-2.5 rounded-lg border px-3 py-2",
                  active ? "border-accent/40 bg-accent/5" : "border-border/50 bg-panel2",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={() => persist({ activeProvider: inst.id })}
                  title={active ? t("repaint.activeProvider") : t("repaint.makeActive")}
                  className={[
                    "h-3.5 w-3.5 shrink-0 rounded-full border transition-colors",
                    active ? "border-accent bg-accent" : "border-border hover:border-accent/60",
                  ].join(" ")}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-text">{inst.name}</div>
                  <div className="truncate text-[10px] text-muted2">{tmpl?.label || inst.type}</div>
                </div>
                <select
                  value={prefs.selectedModels?.[inst.id] || ""}
                  onChange={(e) => persist({ selectedModels: { ...prefs.selectedModels, [inst.id]: e.target.value } })}
                  className="h-7 w-[180px] shrink-0 rounded-md border border-border/60 bg-app px-1.5 text-[11px] text-text outline-none hover:border-border focus:border-accent/50"
                >
                  {modelOptions(inst).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => refreshModels(inst)}
                  title={t("repaint.refreshModels")}
                  className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-text"
                >
                  <RefreshCw className={`h-3 w-3 ${refreshing[inst.id] ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setModal({ mode: "edit", instance: inst })}
                  title={t("repaint.editProvider")}
                  className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-text"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(inst.id)}
                  title={t("repaint.removeProvider")}
                  className="rounded p-1 text-muted2 transition-colors hover:bg-hover hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-2.5">
          <SecondaryButton onClick={() => setModal({ mode: "new", instance: null })}>
            <span className="inline-flex items-center gap-1"><Plus className="h-3 w-3" /> {t("repaint.addProvider")}</span>
          </SecondaryButton>
        </div>
        </div>
      </Group>

      {modal && (
        <ProviderModal
          mode={modal.mode}
          instances={prefs.providers}
          instance={modal.instance}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
