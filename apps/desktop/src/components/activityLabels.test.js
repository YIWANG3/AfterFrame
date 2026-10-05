import fs from "node:fs";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import enNav from "../i18n/locales/en/nav.json";
import zhNav from "../i18n/locales/zh-CN/nav.json";
import { finishedLine, jobLine } from "./ActivityCenter";

async function translator(lng) {
  const i18n = createInstance();
  await i18n.init({ lng, fallbackLng: "en", resources: { en: { nav: enNav }, "zh-CN": { nav: zhNav } }, defaultNS: "nav" });
  return i18n.t.bind(i18n);
}

const running = (phase, phaseLabel, processed, total) => ({
  jobType: "import", status: "running", phase, phaseLabel,
  result: { current_phase: { result: { processed, total } } },
});

describe("background activity in Chinese", () => {
  it("names the import's phase, not the sidecar's English label", async () => {
    const t = await translator("zh-CN");
    expect(jobLine(running("match_processed_media", "Match with RAW", 48, 75), t)).toBe("匹配 RAW · 48/75");
    expect(jobLine(running("index_processed_media", "Index Images", 0, 0), t)).toBe("索引图片");
  });

  it("says how a job ended in the same language as the job's name", async () => {
    const t = await translator("zh-CN");
    expect(finishedLine({ jobType: "import", status: "cancelled" }, t)).toBe("导入已取消");
    expect(finishedLine({ jobType: "import", status: "failed" }, t)).toBe("导入失败");
    expect(finishedLine({ jobType: "import", status: "succeeded" }, t)).toBe("导入已完成");
  });

  it("keeps English as it was, and falls back to the sidecar's label for an unknown phase", async () => {
    const t = await translator("en");
    expect(finishedLine({ jobType: "import", status: "failed" }, t)).toBe("Import failed");
    expect(jobLine(running("match_processed_media", "Match with RAW", 48, 75), t)).toBe("Match with RAW · 48/75");
    const zh = await translator("zh-CN");
    expect(jobLine(running("brand_new_phase", "Brand New Phase", 0, 0), zh)).toBe("Brand New Phase");
  });

  it("has a name in both languages for every phase the job runner reports", () => {
    const runner = fs.readFileSync(new URL("../../../../services/sidecar/src/media_workspace/job_runner.py", import.meta.url), "utf8");
    const keys = new Set([...runner.matchAll(/"(?:key|phase)": "([a-z_]+)"/g)].map((match) => match[1]));
    expect(keys.size).toBeGreaterThan(8);
    for (const key of keys) {
      expect(enNav.activity.phases[key], `en phase ${key}`).toBeTruthy();
      expect(zhNav.activity.phases[key], `zh-CN phase ${key}`).toBeTruthy();
    }
  });
});
