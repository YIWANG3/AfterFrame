// The camera of a camera-mockup frame (frame-mockups/): which camera (with a
// note when the photo's own has no picture here), the camera held level or
// upright, the display's corners, the camera's exposure and a reflection on
// its glass. Shown while the frame has a camera.

import { useTranslation } from "react-i18next";
import { Select, SliderRow, Toggle } from "../../../ui";
import { SegGroup } from "../text/controls";
import { MOCKUPS } from "../mockups";

const BRAND_NAMES = {
  hasselblad: "Hasselblad", leica: "Leica", canon: "Canon", nikon: "Nikon", sony: "Sony",
  panasonic: "Panasonic", fujifilm: "Fujifilm", ricoh: "Ricoh", om: "OM System", sigma: "Sigma", pentax: "Pentax",
};

// The cameras by maker, in the table's order; each named without its maker.
const CAMERA_GROUPS = (() => {
  const groups = new Map();
  for (const m of MOCKUPS) {
    const brand = BRAND_NAMES[m.brand] || m.brand;
    if (!groups.has(brand)) groups.set(brand, []);
    const label = m.name.startsWith(`${brand} `) ? m.name.slice(brand.length + 1) : m.name;
    groups.get(brand).push({ value: m.id, label });
  }
  return [...groups].map(([label, options]) => ({ label, options }));
})();

function Row({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-[48px] text-[10px] text-muted2">{label}</span>
      {children}
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.mockup    canvas.mockup
 * @param {number} props.rotation  the quarter turn it has on this photo now
 * @param {{ camera: string|null }|null} [props.missing]  the photo's camera has
 *   no picture here (camera: its name, null when the photo doesn't say)
 * @param {(patch: object, opts?: { live?: boolean }) => void} props.onChange
 *   `live`: a slider mid-drag, recorded on release
 */
export default function MockupControls({ mockup, rotation, missing = null, onChange }) {
  const { t } = useTranslation("editor");
  if (!mockup) return null;
  const choice = (key, label, active, patch) => ({ key, label, active, onClick: () => onChange(patch) });
  return (
    <div className="flex flex-col gap-2" data-frame-mockup-controls="true">
      <Row label={t("border.mockup.camera")}>
        <Select
          className="min-w-0 flex-1"
          value={mockup.id}
          options={CAMERA_GROUPS}
          onChange={(id) => onChange({ id })}
          data-frame-mockup-camera="true"
        />
      </Row>
      {missing && (
        <div className="-mt-1 pl-[56px] text-[10px] text-muted2" data-frame-mockup-missing="true">
          {missing.camera ? t("border.mockup.missing", { camera: missing.camera }) : t("border.mockup.unknown")}
        </div>
      )}
      <Row label={t("border.mockup.orientation")}>
        <SegGroup
          className="flex-1"
          options={[
            choice("landscape", t("border.mockup.landscape"), rotation === 0, { rotation: 0 }),
            choice("portrait", t("border.mockup.portrait"), rotation !== 0, { rotation: -90 }),
          ]}
        />
      </Row>
      <SliderRow
        compact
        label={t("border.radius")}
        min={0} max={100} resetValue={0}
        value={mockup.radius || 0}
        onChange={(v) => onChange({ radius: v }, { live: true })}
        onCommit={(v) => onChange({ radius: v })}
        testId="frame-mockup-radius"
      />
      <SliderRow
        compact
        label={t("border.mockup.exposure")}
        min={-100} max={100} resetValue={0}
        value={mockup.exposure || 0}
        onChange={(v) => onChange({ exposure: v }, { live: true })}
        onCommit={(v) => onChange({ exposure: v })}
        testId="frame-mockup-exposure"
      />
      <Row label={t("border.mockup.reflection")}>
        <span data-frame-mockup-reflection="true">
          <Toggle on={!!mockup.reflection} onChange={(on) => onChange({ reflection: on })} />
        </span>
      </Row>
    </div>
  );
}
