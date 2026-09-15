// Split tool on the web bridge: no file system, so the N panels arrive as
// sequential browser downloads named after the source file.
const { test, expect } = require("@playwright/test");

const FIXTURE = "/e2e/fixtures/real-images/0Y1A6707-9.jpg"; // 2400 × 1600

async function dropFiles(page, urls) {
  await page.evaluate(async ({ urls }) => {
    const dt = new DataTransfer();
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fixture fetch failed: ${url}`);
      dt.items.add(new File([await res.blob()], url.split("/").pop(), { type: "image/jpeg" }));
    }
    const empty = Array.from(document.querySelectorAll("div")).find((d) => d.textContent === "No assets in this view");
    const target = empty?.parentElement || document.querySelector('img[alt="AfterFrame"]')?.closest("section");
    if (!target) throw new Error("no gallery drop target");
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }, { urls });
}

test("split exports N panels as browser downloads", async ({ page }) => {
  await page.goto("/web.html");
  await expect(page.getByRole("button", { name: "Browse Sample Library" })).toBeVisible();
  await dropFiles(page, [FIXTURE]);
  const card = page.locator('img[alt="0Y1A6707-9"]').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  await page.keyboard.press("e");
  await expect(page.getByTestId("tool-crop")).toBeVisible();
  await page.getByTestId("tool-split").click();
  // 2400 × 1600 at 3:4 → floor(2400 / 1200) = 2 panels of 1200 × 1600.
  await expect(page.getByTestId("split-count")).toHaveText("2");
  await expect(page.getByTestId("split-panel-size")).toHaveText("1200 × 1600");
  await expect(page.getByTestId("split-web-hint")).toBeVisible();
  await expect(page.getByTestId("split-output-dir")).toHaveCount(0);

  const downloads = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.getByTestId("split-export").click();
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(2);
  expect(downloads.sort()).toEqual(["0Y1A6707-9_split_01.jpg", "0Y1A6707-9_split_02.jpg"]);
  await expect(page.getByText("Exported 2 panels")).toBeVisible();
});
