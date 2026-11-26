// The camera of a camera-mockup frame (frame-mockups/): which camera, the
// photo with black bars or filling the display, the camera held level or
// upright, and a reflection on its glass. Shown while the frame has a camera.

import { useTranslation } from "react-i18next";
import { Select, Toggle } from "../../../ui";
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
 * @param {(patch: object) => void} props.onChange
 */
export default function MockupControls({ mockup, rotation, onChange }) {
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
      <Row label={t("border.mockup.photo")}>
        <SegGroup
          className="flex-1"
          options={[
            choice("contain", t("border.mockup.contain"), mockup.fit !== "fill", { fit: "contain" }),
            choice("fill", t("border.mockup.fill"), mockup.fit === "fill", { fit: "fill" }),
          ]}
        />
      </Row>
      <Row label={t("border.mockup.orientation")}>
        <SegGroup
          className="flex-1"
          options={[
            choice("landscape", t("border.mockup.landscape"), rotation === 0, { rotation: 0 }),
            choice("portrait", t("border.mockup.portrait"), rotation !== 0, { rotation: -90 }),
          ]}
        />
      </Row>
      <Row label={t("border.mockup.reflection")}>
        <span data-frame-mockup-reflection="true">
          <Toggle on={!!mockup.reflection} onChange={(on) => onChange({ reflection: on })} />
        </span>
      </Row>
    </div>
  );
}
