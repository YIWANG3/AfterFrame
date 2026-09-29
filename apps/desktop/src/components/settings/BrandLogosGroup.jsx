// Settings › Watermark › Camera logos: every camera brand in the library with
// the logo its frames show, which is the brand's own mark or one of my logos
// given to it; a camera with no built-in mark can be given one here. A model
// given its own logo (in the Frame tool) is listed under its brand. The
// Frame tool's Logo row (the camera cell's chooser) changes the same choices.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../../api";
import { localFileUrl } from "../../utils/format";
import { brandKeyForExif, buildLogoRegistry, builtInMarks, normalizeMake } from "../editor/render/frameLogos";
import { setBrandLogo } from "../editor/render/brandLogos";
import { loadPersonalLogos, subscribePersonalLogos } from "../editor/render/personalLogos";
import LogoPicker, { LogoMarks } from "../editor/components/LogoPicker";
import { Group, SecondaryButton } from "./SettingsPrimitives";

// The library's makes grouped by brand: "Leica Camera AG" and "LEICA CAMERA
// AG" are one Leica. A brand given a logo that no photo here has (from
// another catalog) is listed too, so the choice can be undone.
function brandRows(makes, manifest, brandLogos) {
  const base = buildLogoRegistry(manifest || { logos: [], match: {} });
  const rows = new Map();
  for (const { make, count, models } of makes || []) {
    const key = brandKeyForExif({ make, camera_model: models?.[0] || "" }, base);
    if (!key) continue;
    const builtIn = base.byId.get(key) || null;
    const row = rows.get(key) || { key, name: builtIn?.name || make, count: 0, models: [], builtIn };
    row.count += count;
    for (const model of models || []) if (!row.models.includes(model)) row.models.push(model);
    rows.set(key, row);
  }
  for (const choiceKey of Object.keys(brandLogos || {})) {
    const [key, model] = choiceKey.split("#");
    if (!rows.has(key)) {
      const builtIn = base.byId.get(key) || null;
      rows.set(key, { key, name: builtIn?.name || key.replace(/^make:/, ""), count: 0, models: [], builtIn });
    }
    // A model with its own logo: named as EXIF writes it, when a photo has it.
    if (model) {
      const row = rows.get(key);
      row.own = [...(row.own || []), { key: choiceKey, name: row.models.find((m) => normalizeMake(m) === model) || model }];
    }
  }
  return [...rows.values()];
}

// The brand's own marks (Sony: α and SONY), each { src, tintable }.
function ownMarks(row, svgs) {
  return builtInMarks(row.builtIn, row.models[0]).flatMap((variant) => {
    const svg = svgs?.[variant.file];
    return svg ? [{ src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, tintable: !variant.colorLocked && !variant.tintableColors?.length }] : [];
  });
}

export default function BrandLogosGroup() {
  const { t } = useTranslation("settings");
  const [data, setData] = useState(null); // { makes, manifest, svgs, brandLogos }
  const [mine, setMine] = useState([]);
  const [picking, setPicking] = useState(null);
  // Reads overlap (a logo imported from the chooser announces itself while
  // the brand's choice is still being saved): only the latest one lands, so
  // an older read never puts back a choice from before.
  const readRef = useRef({ latest: 0, load: null });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const read = ++readRef.current.latest;
      const [makes, logos, profile, personal] = await Promise.all([
        api.listCameraMakes().catch(() => []),
        api.getFrameLogos().catch(() => null),
        api.getWatermarkProfile().catch(() => null),
        loadPersonalLogos(),
      ]);
      if (!alive || read !== readRef.current.latest) return;
      const brandLogos = profile?.brandLogos || {};
      setMine(personal);
      setData({ makes, manifest: logos?.manifest, svgs: logos?.svgs || {}, brandLogos });
    };
    readRef.current.load = load;
    load();
    // A deleted logo takes its brands back to their own marks.
    const unsubscribe = subscribePersonalLogos(load);
    return () => { alive = false; unsubscribe(); };
  }, []);

  async function choose(key, logo) {
    setPicking(null);
    await setBrandLogo(key, logo?.id || null);
    await readRef.current.load?.();
  }

  // Nothing to choose from where logos cannot be imported and none exist (web).
  if (!api.has("importPersonalLogo") && !mine.length) return null;

  const rows = data ? brandRows(data.makes, data.manifest, data.brandLogos) : [];
  const logoOf = (id) => mine.find((logo) => logo.id === id) || null;
  const markOf = (logo) => (logo ? { src: localFileUrl(logo.path), tintable: logo.tintable } : null);
  // One line: a brand, or (sub) one of its models with its own logo. `own`
  // is what "Default" gives: the brand's marks, or for a model the brand's logo.
  function line({ key, name, meta, own, sub = false, rankOf }) {
    const chosen = logoOf(data.brandLogos[key]);
    const shown = chosen ? [markOf(chosen)] : own;
    return (
      <div key={key} data-brand-logo-row={key} data-brand-logo-choice={chosen?.id || ""} className={sub ? "mt-2 pl-6" : ""}>
        <div className="flex items-center gap-3">
          <div className={`flex shrink-0 items-center justify-center rounded bg-checker p-1 text-text ${sub ? "h-7 w-20" : "h-8 w-24"}`}>
            {shown.length
              ? <LogoMarks marks={shown} />
              : <span className="text-[10px] text-muted2">{t("watermark.brandNone")}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <span className={`block truncate text-text ${sub ? "text-[11.5px]" : "text-[12px]"}`}>{name}</span>
            {meta && <span className="block truncate text-[10.5px] text-muted2" title={meta}>{meta}</span>}
          </div>
          <SecondaryButton onClick={() => setPicking((open) => (open === key ? null : key))}>
            <span data-brand-change="true">{t("watermark.brandChange")}</span>
          </SecondaryButton>
        </div>
        {picking === key && (
          <div className={`mt-2 max-w-sm ${sub ? "pl-[92px]" : "pl-[108px]"}`}>
            <LogoPicker
              selectedId={chosen?.id || null} defaultMarks={own}
              rankOf={rankOf} onPick={(logo) => choose(key, logo)}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <Group title={t("watermark.brandsTitle")} subtitle={t("watermark.brandsSubtitle")}>
      {data && rows.length === 0 && <div className="py-3 text-[11px] text-muted2">{t("watermark.brandsEmpty")}</div>}
      {rows.map((row) => {
        const own = ownMarks(row, data.svgs);
        const brandMark = markOf(logoOf(data.brandLogos[row.key]));
        // This brand's logos first in its chooser, then ones no camera uses;
        // another brand's are left out.
        const used = Object.entries(data.brandLogos);
        const rankOf = (logo) => {
          const keys = used.filter(([, id]) => id === logo.id).map(([key]) => key);
          if (!keys.length) return 1;
          return keys.some((key) => key === row.key || key.startsWith(`${row.key}#`)) ? 0 : Infinity;
        };
        return (
          <div key={row.key} className="border-b border-border/50 py-2.5 last:border-b-0">
            {line({
              key: row.key, name: row.name, own, rankOf,
              meta: [row.count ? t("watermark.brandCount", { count: row.count }) : null, row.models.slice(0, 3).join(", ")].filter(Boolean).join(" · "),
            })}
            {(row.own || []).map((model) => line({
              key: model.key, name: model.name, sub: true, rankOf,
              own: brandMark ? [brandMark] : own,
            }))}
          </div>
        );
      })}
    </Group>
  );
}
