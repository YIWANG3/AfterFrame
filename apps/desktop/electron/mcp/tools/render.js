// Rendering in the app's own pipeline, inside the renderer (agentBridge.askRenderer).
// Shape and ctx: see tools/index.js.

const path = require("node:path");
const { thumbnailUrl } = require("./shared");

module.exports = (ctx) => {
  const { deps, commands, port, requireCatalog, rememberPreview, withRawHdPreviews, derivedOutputDir } = ctx;
  return [
    {
      name: "get_editor_capabilities",
      description:
        "Enumerations for the rendering tools: frame template ids (apply_frame), collage template ids per " +
        "photo count (render_collage), available fonts and layer types (edit_asset). Call before using those " +
        "tools when you need valid values.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        return await deps.askRenderer("capabilities", {}, { timeoutMs: 15_000 });
      },
    },
    {
      name: "render_collage",
      description:
        "Compose photos into collage pages — the same renderer as the app's collage tool, pixel-identical. " +
        "Without per_page: ONE page from all asset_ids (2-12). With per_page: batch mode — assets are chunked " +
        "into pages of that size. template_id (see get_editor_capabilities) must match the per-page photo " +
        "count; omit it for the default layout. Each page is saved as a new catalog asset linked to its " +
        "source photos. Requires the app window to be open.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          template_id: { type: "string", description: "Collage layout id, e.g. '4-grid'; default first layout for the count" },
          per_page: { type: "number", description: "Batch mode: photos per page (2-12)" },
          ratio: { type: "number", description: "Canvas aspect ratio W/H, default 1 (square)" },
          gap: { type: "number", description: "Gap between cells in export px, default 0" },
          padding: { type: "number", description: "Outer margin in export px, default 0" },
          radius: { type: "number", description: "Cell corner radius in export px, default 0" },
          bg: { type: "string", description: "Background color, default #000000" },
          export_width: { type: "number", description: "Output width in px, default 4096" },
        },
        required: ["asset_ids"],
      },
      async handler(args) {
        requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (ids.length < 2) throw new Error("render_collage needs at least 2 asset_ids.");
        const perPage = args.per_page ? Math.max(1, Math.min(12, Math.round(args.per_page))) : ids.length;
        if (!args.per_page && ids.length > 12) throw new Error("A single page holds at most 12 photos — pass per_page for batch mode.");
        let details = [];
        for (const id of ids) {
          const detail = await commands.assetDetail({ assetId: id });
          if (!detail?.image_path) throw new Error(`No file path for asset ${id}.`);
          details.push(detail);
        }
        // The renderer can't decode a RAW, so a RAW cell is drawn from its preview.
        details = await withRawHdPreviews(ids, details);
        const files = details.map((detail, i) => ({
          assetId: ids[i],
          imagePath: detail.image_path,
          previewPath: detail.image_preview_hd_path || detail.image_preview_path || null,
        }));
        const derivedDir = derivedOutputDir();
        const stamp = Date.now();
        const pages = [];
        for (let i = 0; i < files.length; i += perPage) pages.push(files.slice(i, i + perPage));
        // A trailing 1-photo remainder still renders (template "1-full").
        const results = [];
        for (let p = 0; p < pages.length; p++) {
          const page = pages[p];
          const savePath = path.join(derivedDir, `collage_${stamp}_p${p + 1}.jpg`);
          try {
            const out = await deps.askRenderer("collage", {
              files: page,
              templateId: page.length === perPage ? args.template_id || null : null,
              canvasRatio: args.ratio,
              gap: args.gap,
              padding: args.padding,
              borderRadius: args.radius,
              bgColor: args.bg,
              width: args.export_width,
              savePath,
              sourceAssetIds: page.map((f) => f.assetId),
            });
            rememberPreview(out.asset?.asset_id, null, null);
            results.push({
              page: p + 1,
              new_asset_id: out.asset?.asset_id,
              template_id: out.template_id,
              width: out.width,
              height: out.height,
              path: out.saved_path,
              thumbnail_url: out.asset?.asset_id ? thumbnailUrl(port, out.asset.asset_id) : undefined,
            });
          } catch (error) {
            results.push({ page: p + 1, error: error.message });
          }
        }
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { pages: results.length, results };
      },
    },
    {
      name: "edit_asset",
      description:
        "Composite edit on one photo using the app's editor pipeline: geometry (crop rect / rotation / flip), " +
        "canvas margins with background color, and overlay layers (text with font/color/outline/glow/shadow, " +
        "sticker from a PNG path). Positions are normalized 0-1; text size is a fraction of image width. " +
        "Non-destructive: the result is a new derived version in the original's version stack. " +
        "Requires the app window to be open. For a plain crop use crop_assets; for one-line text add_text also works.",
      inputSchema: {
        type: "object",
        properties: {
          asset_id: { type: "string" },
          geometry: {
            type: "object",
            properties: {
              crop: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } },
              quarter_turns: { type: "number" },
              free_angle: { type: "number" },
              flip_x: { type: "boolean" },
              flip_y: { type: "boolean" },
            },
          },
          canvas: {
            type: "object",
            description: "Optional margins: pad fractions of the photo's short edge, bg color",
            properties: {
              pad: { type: "object", properties: { top: { type: "number" }, right: { type: "number" }, bottom: { type: "number" }, left: { type: "number" } } },
              bg: { type: "string", description: "Margin color, default #ffffff" },
            },
          },
          layers: {
            type: "array",
            description: "Overlay layers, drawn in order. type 'text': {text, x, y, size, font, color, align, bold, italic, rotation, opacity, outline{width,color}, glow{radius,color,opacity}, shadow{x,y,blur,color,opacity}}. type 'sticker': {path, x, y, scale, rotation, opacity}",
            items: { type: "object" },
          },
          format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg" },
        },
        required: ["asset_id"],
      },
      async handler(args) {
        requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        const detail = await commands.assetDetail({ assetId: String(args.asset_id) });
        if (!detail?.image_path) throw new Error(`No file path for asset ${args.asset_id}.`);
        const hasWork = args.geometry || args.canvas || (args.layers || []).length;
        if (!hasWork) throw new Error("Nothing to do — pass geometry, canvas and/or layers.");
        const derivedDir = derivedOutputDir();
        const ext = args.format === "png" ? ".png" : ".jpg";
        const stem = path.basename(detail.image_path).replace(/\.[^.]+$/, "");
        const savePath = path.join(derivedDir, `${stem}_edit_${Date.now()}${ext}`);
        const out = await deps.askRenderer("edit", {
          imagePath: detail.image_path,
          savePath,
          geometry: args.geometry || {},
          canvas: args.canvas || {},
          layers: args.layers || [],
        });
        rememberPreview(out.asset?.asset_id, null, null);
        deps.broadcastCatalogChanged?.("assets", { ids: [String(args.asset_id)] });
        return {
          source_asset_id: String(args.asset_id),
          new_asset_id: out.asset?.asset_id,
          path: out.saved_path,
          thumbnail_url: out.asset?.asset_id ? thumbnailUrl(port, out.asset.asset_id) : undefined,
        };
      },
    },
    {
      name: "apply_frame",
      description:
        "Apply a photo frame / EXIF watermark template (the app's Frame presets: white borders with camera, " +
        "lens and exposure text plus brand logo — e.g. classic bottom bar, polaroid, overlay captions). " +
        "template ids come from get_editor_capabilities frame_templates, which also lists the user's own " +
        "templates saved in the editor (user: true); their text and logo follow each photo. EXIF is read from the photo " +
        "automatically. Non-destructive: each result is a new derived version. Requires the app window to be open.",
      inputSchema: {
        type: "object",
        properties: {
          asset_ids: { type: "array", items: { type: "string" } },
          template: { type: "string", description: "Frame template id" },
        },
        required: ["asset_ids", "template"],
      },
      async handler(args) {
        requireCatalog();
        if (!deps.askRenderer) throw new Error("Render bridge unavailable.");
        const ids = (args.asset_ids || []).map(String).filter(Boolean);
        if (!ids.length) throw new Error("asset_ids is empty.");
        const derivedDir = derivedOutputDir();
        const results = [];
        for (const id of ids) {
          try {
            const detail = await commands.assetDetail({ assetId: id });
            if (!detail?.image_path) throw new Error("no file path for asset");
            const stem = path.basename(detail.image_path).replace(/\.[^.]+$/, "");
            const savePath = path.join(derivedDir, `${stem}_frame_${Date.now()}.jpg`);
            const out = await deps.askRenderer("frame", {
              imagePath: detail.image_path,
              templateId: String(args.template),
              exifItem: { image_metadata: detail.image_metadata, raw_metadata: detail.raw_metadata },
              savePath,
            });
            rememberPreview(out.asset?.asset_id, null, null);
            results.push({
              source_asset_id: id,
              new_asset_id: out.asset?.asset_id,
              width: out.width,
              height: out.height,
              path: out.saved_path,
              thumbnail_url: out.asset?.asset_id ? thumbnailUrl(port, out.asset.asset_id) : undefined,
            });
          } catch (error) {
            results.push({ source_asset_id: id, error: error.message });
          }
        }
        deps.broadcastCatalogChanged?.("assets", { ids });
        return { template: args.template, results };
      },
    },
  ];
};
