// Settings › Watermark › Camera logos: every camera in the library, a brand
// and its models under it. A brand's logo is its built-in marks or a camera
// logo of mine, for every model; a model's is its own, or the brand's. Click
// a model's name to rename it (a drone's lenses named the same are one
// camera, sharing a model logo); a brand with no built-in logo can be named
// too. The Frame tool's camera logo rows change the same choices.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../../api";
import { localFileUrl } from "../../utils/format";
import InlineEdit from "../InlineEdit";
import { brandKeyForExif, buildLogoRegistry, builtInBrandMarks, cameraNamer, modelKeyFor, normalizeMake } from "../editor/render/frameLogos";
import { loadCameraNameTables } from "../editor/render/cameraNames";
import { setBrandLogo, setCameraName } from "../editor/render/brandLogos";
import { loadPersonalLogos, subscribePersonalLogos } from "../editor/render/personalLogos";
import LogoPicker, { LogoMarks } from "../editor/components/LogoPicker";
import { Group, SecondaryButton } from "./SettingsPrimitives";

// The library's makes grouped by brand ("Leica Camera AG" and "LEICA CAMERA
// AG" are one Leica), each with its models as EXIF writes them. Brands and
// models only named or given a logo here (another catalog) are listed too.
function brandRows(makes, base, profile) {
  const rows = new Map();
  const rowFor = (key, make) => {
    if (!rows.has(key)) {
      const builtIn = base.byId.get(key) || null;
      rows.set(key, { key, make, builtIn, count: 0, models: new Map() });
    }
    return rows.get(key);
  };
  for (const { make, count, models } of makes || []) {
    const key = brandKeyForExif({ make, camera_model: models?.[0] || "" }, base);
    if (!key) continue;
    const row = rowFor(key, make);
    row.count += count;
    for (const model of models || []) row.models.set(normalizeMake(model), model);
  }
  for (const choiceKey of [...Object.keys(profile.brandLogos || {}), ...Object.keys(profile.cameraNames || {})]) {
    const [key, model] = choiceKey.split("#");
    const row = rowFor(key, key.replace(/^make:/, ""));
    if (model && !row.models.has(model)) row.models.set(model, model);
  }
  return [...rows.values()];
}

export default function BrandLogosGroup() {
  const { t } = useTranslation("settings");
  const [data, setData] = useState(null); // { makes, base, svgs, profile, tables }
  const [mine, setMine] = useState([]);
  const [picking, setPicking] = useState(null);
  const [renaming, setRenaming] = useState(null);
  // Reads overlap (a logo uploaded from a chooser announces itself while the
  // choice is still being saved): only the latest one lands, so an older read
  // never puts back a choice from before.
  const readRef = useRef({ latest: 0, load: null });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const read = ++readRef.current.latest;
      const [makes, logos, profile, personal, tables] = await Promise.all([
        api.listCameraMakes().catch(() => []),
        api.getFrameLogos().catch(() => null),
        api.getWatermarkProfile().catch(() => null),
        loadPersonalLogos(),
        loadCameraNameTables(),
      ]);
      if (!alive || read !== readRef.current.latest) return;
      setMine(personal);
      setData({
        makes,
        base: buildLogoRegistry(logos?.manifest || { logos: [], match: {} }),
        svgs: logos?.svgs || {},
        profile: { brandLogos: profile?.brandLogos || {}, cameraNames: profile?.cameraNames || {} },
        tables,
      });
    };
    readRef.current.load = load;
    load();
    // A deleted logo takes its brands back to their own marks.
    const unsubscribe = subscribePersonalLogos(load);
    return () => { alive = false; unsubscribe(); };
  }, []);

  // Nothing to choose from where logos cannot be uploaded and none exist (web).
  if (!api.has("importPersonalLogo") && !mine.length) return null;

  const { brandLogos = {}, cameraNames = {} } = data?.profile || {};
  const namer = data ? cameraNamer(data.base, cameraNames, data.tables) : null;
  const logoOf = (id) => mine.find((logo) => logo.id === id) || null;
  const markOf = (logo) => ({ src: localFileUrl(logo.path), tintable: logo.tintable });
  // The model keys that are one camera with `key` (named the same): they
  // share one choice, kept on whichever model it was made on.
  const sameCamera = (key) => {
    const [brand, model] = key.split("#");
    return namer.sameCamera(brand, model).map((other) => modelKeyFor(brand, other));
  };
  const modelLogo = (key) => logoOf(brandLogos[key]) || sameCamera(key).map((other) => logoOf(brandLogos[other])).find(Boolean) || null;

  async function reload() { await readRef.current.load?.(); }
  async function choose(key, logo) {
    setPicking(null);
    if (key.includes("#")) {
      for (const other of sameCamera(key)) if (other !== key && brandLogos[other]) await setBrandLogo(other, null);
    }
    await setBrandLogo(key, logo?.id || null);
    await reload();
  }
  async function rename(key, name) {
    setRenaming(null);
    await setCameraName(key, name);
    await reload();
  }

  const nameCell = (key, shown, original, sub) => (renaming === key ? (
    <div className="max-w-xs rounded border border-border bg-app text-[12px]">
      <InlineEdit initial={cameraNames[key] || shown} onConfirm={(name) => rename(key, name)} onCancel={() => setRenaming(null)} />
    </div>
  ) : (
    <button
      type="button"
      data-rename-camera={key}
      title={t("watermark.renameCamera")}
      onClick={() => setRenaming(key)}
      className={`block max-w-full truncate text-left text-text hover:underline ${sub ? "text-[11.5px]" : "text-[12px]"}`}
    >
      {shown}
      {original && original !== shown && <span className="ml-1.5 text-[10.5px] text-muted2">{original}</span>}
    </button>
  ));

  function line({ key, name, meta, shown, own, defaultLabel, brandKey, sub = false }) {
    return (
      <div key={key} data-brand-logo-row={key} data-brand-logo-choice={shown.chosen?.id || ""} className={sub ? "mt-2 pl-6" : ""}>
        <div className="flex items-center gap-3">
          <div className={`flex shrink-0 items-center justify-center rounded bg-checker p-1 text-text ${sub ? "h-7 w-20" : "h-8 w-24"}`}>
            {shown.marks.length
              ? <LogoMarks marks={shown.marks} />
              : <span className="text-[10px] text-muted2">{shown.empty}</span>}
          </div>
          <div className="min-w-0 flex-1">
            {name}
            {meta && <span className="block truncate text-[10.5px] text-muted2" title={meta}>{meta}</span>}
          </div>
          <SecondaryButton onClick={() => setPicking((open) => (open === key ? null : key))}>
            <span data-brand-change="true">{t("watermark.brandChange")}</span>
          </SecondaryButton>
        </div>
        {picking === key && (
          <div className={`mt-2 max-w-sm ${sub ? "pl-[92px]" : "pl-[108px]"}`}>
            <LogoPicker
              selectedId={shown.chosen?.id || null}
              defaultMarks={own}
              defaultLabel={defaultLabel}
              rankOf={(logo) => (logo.kind === "camera" && logo.brand === brandKey ? 0 : Infinity)}
              importOptions={{ kind: "camera", brand: brandKey }}
              onPick={(logo) => choose(key, logo)}
            />
          </div>
        )}
      </div>
    );
  }

  const rows = data ? brandRows(data.makes, data.base, data.profile) : [];
  return (
    <Group title={t("watermark.brandsTitle")} subtitle={t("watermark.brandsSubtitle")}>
      {data && rows.length === 0 && <div className="py-3 text-[11px] text-muted2">{t("watermark.brandsEmpty")}</div>}
      {rows.map((row) => {
        const own = builtInBrandMarks(row.builtIn).flatMap((variant) => {
          const svg = data.svgs[variant.file];
          return svg ? [{ src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, tintable: !variant.colorLocked && !variant.tintableColors?.length }] : [];
        });
        const brandMine = logoOf(brandLogos[row.key]);
        const brandShown = brandMine ? [markOf(brandMine)] : own;
        const brandName = namer.brandName(row.key, row.make);
        return (
          <div key={row.key} className="border-b border-border/50 py-2.5 last:border-b-0">
            {line({
              key: row.key, brandKey: row.key, own,
              name: row.builtIn
                ? <span className="block truncate text-[12px] text-text">{brandName}</span>
                : nameCell(row.key, brandName, row.make, false),
              meta: row.count ? t("watermark.brandCount", { count: row.count }) : null,
              shown: { chosen: brandMine, marks: brandShown, empty: t("watermark.brandNone") },
            })}
            {[...row.models.entries()].map(([norm, model]) => {
              const key = modelKeyFor(row.key, model) || `${row.key}#${norm}`;
              const chosen = modelLogo(key);
              return line({
                key, brandKey: row.key, sub: true,
                own: brandShown, defaultLabel: t("watermark.followBrand"),
                name: nameCell(key, namer.modelName(row.key, model), model, true),
                shown: { chosen, marks: chosen ? [markOf(chosen)] : [], empty: t("watermark.followBrand") },
              });
            })}
          </div>
        );
      })}
    </Group>
  );
}
