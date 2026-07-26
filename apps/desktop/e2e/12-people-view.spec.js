// The candidate page remains useful before any groups exist: it should be
// reachable from the normal sidebar and explain the next local-only step.
// Group contents are covered by the sidecar persistence/query tests because
// they depend on a real Core ML model and face embeddings.

const { test, expect } = require("@playwright/test");
const { launchApp, closeApp } = require("./helpers/app");

let ctx;

test.beforeAll(async () => {
  ctx = await launchApp({ testName: "people-view" });
  await expect(ctx.window.locator("[data-gallery-item='true']").first()).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  if (ctx) await closeApp(ctx.app, ctx.userDataDir);
});

test("People sidebar opens the local people wall", async () => {
  const people = ctx.window.getByRole("button", { name: "People" });
  await expect(people).toHaveCount(1);
  await people.click();
  await expect(ctx.window.getByRole("heading", { name: "People" })).toBeVisible();
  // No face model installed in the e2e environment → the empty state is the
  // model-onboarding variant ("download model & scan"), not the plain one.
  await expect(ctx.window.getByText("Face recognition model needed")).toBeVisible();
  await expect(ctx.window.getByText(/one-time model download/i)).toBeVisible();
});
