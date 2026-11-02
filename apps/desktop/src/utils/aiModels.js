// Model lists from the AI providers, as the UI shows them: the text tool's
// handwriting modal and the repaint feature (features/repaint) both pick from
// one.

// Defensive display-time dedupe: stale modelsCache entries may hold several
// ids under one display name (Gemini stable + "-preview", Ark dated
// snapshots). Keep one per name, preferring the stable / newer id.
export function dedupeModels(models) {
  const byName = new Map();
  for (const m of models || []) {
    const key = m.name || m.id;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, m);
      continue;
    }
    const prevPreview = /-preview$/.test(prev.id || "");
    const curPreview = /-preview$/.test(m.id || "");
    if (prevPreview && !curPreview) byName.set(key, m);
    else if (prevPreview === curPreview && String(m.id) > String(prev.id)) byName.set(key, m);
  }
  return [...byName.values()];
}
