import { Group, FieldRow, Chip } from "./SettingsPrimitives";

export default function GeneralSettings() {
  return (
    <div>
      <Group title="Appearance">
        <FieldRow label="Theme">
          <span className="text-[11px] text-muted2">Dark</span>
        </FieldRow>
        <FieldRow label="Accent color">
          <Chip on>Brass</Chip>
        </FieldRow>
      </Group>
    </div>
  );
}
