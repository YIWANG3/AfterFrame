import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ToastStack from "./Toast";
import JobDock from "./JobDock";
import SampleCatalogBanner from "./SampleCatalogBanner";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));

describe("shared bottom floating surfaces", () => {
  it("uses the same surface for every job kind, including future kinds", () => {
    const jobs = ["import", "preview", "enrichment", "annotation", "ai_repaint", "people_index", "people_model_download", "text_image"];
    const html = renderToStaticMarkup(<JobDock jobs={jobs.map((jobType) => ({ jobType, jobId: jobType }))} />);
    expect(html.match(/floating-status-card/g)).toHaveLength(jobs.length);
  });

  it("shares the surface across normal, actionable and error notifications", () => {
    const html = renderToStaticMarkup(<ToastStack toasts={[
      { id: 1, title: "Complete" },
      { id: 2, title: "Watch this folder?", actions: [{ label: "Watch", primary: true }] },
      { id: 3, title: "Failed", tone: "error" },
    ]} />);
    expect(html.match(/floating-status-card/g)).toHaveLength(3);
    expect(html).toContain("text-error");
    expect(html).not.toContain("shadow-overlay");
    expect(html).not.toContain("border-red");
  });

  it("uses the shared surface for the bottom-center sample notice", () => {
    expect(renderToStaticMarkup(<SampleCatalogBanner />)).toContain("floating-status-card sample-catalog-banner");
  });
});
