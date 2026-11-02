// The repaint feature's MCP tool (features/repaint/manifest.mjs `mcpTools`):
// shape and ctx as in electron/mcp/tools/index.js, which appends this group
// to its own. `deps.startAiRepaintTask` / `deps.activeRepaintProvider` are the
// host's task starters (electron/tasks.js).

module.exports = (ctx) => {
  const { deps, commands, requireCatalog } = ctx;
  return [
    {
      name: "repaint_asset",
      description:
        "AI image generation on a photo (image-to-image) using the provider configured in the app's Settings → AI: " +
        "restyle, repaint, enhance, upscale per the prompt. The result is registered as a new version in the " +
        "original's version stack. Style references (colour matching): pass other catalog photos as " +
        "reference_asset_ids and/or image files as reference_paths — the result takes on their colours and mood " +
        "while keeping the photo's content. Long-running: returns a job_id — poll get_job_status, then show_in_app the result.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          prompt: { type: "string", description: "What to generate/change, in natural language" },
          model: { type: "string", description: "Provider-specific model id; default uses the provider's default" },
          aspect_ratio: { type: "string", description: "e.g. '4:3', '1:1'; default keeps the source ratio" },
          reference_asset_ids: {
            type: "array", items: { type: "string" },
            description: "Catalog photos to use as style references (their colour palette and mood are matched)",
          },
          reference_paths: {
            type: "array", items: { type: "string" },
            description: "Absolute paths of image files on this machine to use as style references",
          },
        },
        required: ["asset_id", "prompt"],
      },
      async handler(args) {
        requireCatalog();
        if (!deps.startAiRepaintTask || !deps.activeRepaintProvider) throw new Error("Repaint bridge unavailable.");
        const detail = await commands.assetDetail({ assetId: String(args.asset_id) });
        if (!detail?.image_path) throw new Error(`No file path for asset ${args.asset_id}.`);
        const configured = deps.activeRepaintProvider();
        if (!configured) throw new Error("No AI repaint provider configured. Open Settings → AI to add one.");
        // Style references: catalog photos resolve to their files; paths pass
        // through as given. The sidecar rejects a file that is not there.
        const referencePaths = [];
        for (const refId of Array.isArray(args.reference_asset_ids) ? args.reference_asset_ids : []) {
          const ref = await commands.assetDetail({ assetId: String(refId) });
          if (!ref?.image_path) throw new Error(`No file path for reference asset ${refId}.`);
          referencePaths.push(ref.image_path);
        }
        for (const refPath of Array.isArray(args.reference_paths) ? args.reference_paths : []) {
          if (refPath) referencePaths.push(String(refPath));
        }
        // Model precedence: explicit arg > the user's pick in the app UI
        // (selectedModels) > sidecar's per-provider default.
        const { provider: active, model: uiModel } = configured;
        const status = await deps.startAiRepaintTask({
          sourcePath: detail.image_path,
          prompt: String(args.prompt),
          provider: active.id,
          providerType: active.type,
          model: args.model ? String(args.model) : uiModel,
          aspectRatio: args.aspect_ratio || null,
          referencePaths,
        });
        deps.broadcastCatalogChanged?.("jobs", { jobId: status.jobId, jobType: "ai_repaint" });
        return {
          job_id: status.jobId,
          status: status.status,
          provider: active.name || active.type,
          note: "Generation runs in the background — poll get_job_status. The result lands in the original's version stack.",
        };
      },
    },
  ];
};
