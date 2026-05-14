import { Group, FieldRow } from "./SettingsPrimitives";

export default function LibrarySettings() {
  return (
    <div>
      <Group title="Current catalog">
        <div className="py-3 text-[11px] text-muted2">Catalog management — coming soon.</div>
      </Group>
      <Group title="Cache & storage" subtitle="All caches live under ~/Library/Application Support/AfterFrame.">
        <FieldRow label="Preview thumbnails"><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
        <FieldRow label="Depth maps"><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
        <FieldRow label="Sticker library"><span className="text-[11px] tabular-nums text-muted2">—</span></FieldRow>
      </Group>
    </div>
  );
}
