// The app window: what the user has selected, and showing them things.
// Shape and ctx: see tools/index.js.

module.exports = (ctx) => {
  const { deps, requireCatalog } = ctx;
  return [
    {
      name: "show_in_app",
      description:
        "Show something to the USER in the AfterFrame window (brings it to front). Default view 'gallery' " +
        "selects the given assets and scrolls to them — prefer this over describing images. Other views hand " +
        "the baton to the user: 'editor' opens the first asset in the image editor, 'collage' opens the collage " +
        "composer with the assets, 'people' / 'stickers' switch to those library views (no asset_ids needed).",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" }, description: "Asset ids (required for gallery/editor/collage)" },
          view: { type: "string", enum: ["gallery", "editor", "collage", "people", "stickers"], description: "Default gallery" },
        },
      },
      async handler(args) {
        requireCatalog();
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        const view = args.view || "gallery";
        if (view === "gallery") {
          if (!deps.revealAssetsInApp) throw new Error("App window bridge unavailable.");
          if (!ids.length) throw new Error("asset_ids is empty.");
          return await deps.revealAssetsInApp(ids);
        }
        if (!deps.askRenderer) throw new Error("App window bridge unavailable.");
        // Views resolve assets from the gallery's current item map — reveal
        // first so the items are guaranteed loaded (and the window is front).
        if (ids.length && deps.revealAssetsInApp) await deps.revealAssetsInApp(ids);
        return await deps.askRenderer("open_view", { view, assetIds: ids }, { timeoutMs: 15_000 });
      },
    },
    {
      name: "get_selection",
      description:
        "What the user currently has selected in the AfterFrame window. Call this when the user says " +
        "\"these photos\", \"this one\", \"my selection\" etc. Returns asset ids plus names/paths; " +
        "use view_assets on the ids to see them.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        requireCatalog();
        const selection = deps.getCurrentSelection ? deps.getCurrentSelection() : { assets: [], updatedAt: null };
        return {
          count: selection.assets.length,
          updated_at: selection.updatedAt,
          assets: selection.assets,
          note: selection.assets.length ? undefined : "Nothing is selected in the app right now.",
        };
      },
    },
  ];
};
