import { describe, expect, it } from "vitest";
import { availableKinds, buildClipboard, canPasteOnto, describeEdits, planForTarget } from "./pasteEdits";
import { BASE_STATE } from "./state/editorStateModel";

const LANDSCAPE = { width: 6000, height: 4000 };
const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };

// Does a box (fractions of a W×H photo) stay inside the photo turned by `deg`?
function fitsInsideRotated(box, photo, deg) {
  const rad = (Math.abs(deg) * Math.PI) / 180;
  const w = box.width * photo.width;
  const h = box.height * photo.height;
  return w * Math.cos(rad) + h * Math.sin(rad) <= photo.width + 1e-6
    && w * Math.sin(rad) + h * Math.cos(rad) <= photo.height + 1e-6;
}

describe("describeEdits", () => {
  it("offers nothing for an untouched photo", () => {
    expect(availableKinds(describeEdits(BASE_STATE, null, LANDSCAPE))).toEqual([]);
  });

  it("offers only what was actually changed", () => {
    const edits = describeEdits({ ...BASE_STATE, quarterTurns: 1, flipX: true }, null, LANDSCAPE);
    expect(availableKinds(edits)).toEqual(["rotate", "flip"]);
    expect(edits.flip).toEqual({ flipX: true, flipY: false });
  });

  it("normalizes turns and treats a full-frame box as no crop", () => {
    expect(describeEdits({ ...BASE_STATE, quarterTurns: -1 }, null, LANDSCAPE).rotate).toEqual({ quarterTurns: 3 });
    expect(describeEdits({ ...BASE_STATE, quarterTurns: 4 }, null, LANDSCAPE).rotate).toBeNull();
    expect(describeEdits(BASE_STATE, { x: 0, y: 0, width: 1, height: 1 }, LANDSCAPE).crop).toBeNull();
  });

  it("records the crop's real aspect, not its fraction aspect", () => {
    // Half of each side of a 3:2 photo is still 3:2.
    expect(describeEdits(BASE_STATE, crop, LANDSCAPE).crop.aspect).toBeCloseTo(1.5);
  });
});

describe("buildClipboard", () => {
  const edits = describeEdits({ ...BASE_STATE, quarterTurns: 1, freeAngle: 3 }, crop, LANDSCAPE);

  it("keeps only the ticked kinds", () => {
    expect(Object.keys(buildClipboard(edits, { rotate: true, crop: true }))).toEqual(["rotate", "crop"]);
  });

  it("is null when nothing usable is ticked", () => {
    expect(buildClipboard(edits, {})).toBeNull();
    expect(buildClipboard(edits, { flip: true })).toBeNull(); // ticked, but the photo was never flipped
  });
});

describe("planForTarget", () => {
  it("passes turns and flips straight through", () => {
    const clipboard = buildClipboard(describeEdits({ ...BASE_STATE, quarterTurns: 3, flipY: true }, null, LANDSCAPE), { rotate: true, flip: true });
    expect(planForTarget(clipboard, { width: 1000, height: 3000 })).toEqual({ quarterTurns: 3, freeAngle: 0, flipX: false, flipY: true, crop: null });
  });

  it("reuses the exact box on a photo of the same shape, whatever its resolution", () => {
    const clipboard = buildClipboard(describeEdits(BASE_STATE, crop, LANDSCAPE), { crop: true });
    expect(planForTarget(clipboard, { width: 3000, height: 2000 }).crop).toEqual(crop);
    expect(planForTarget(clipboard, { width: 6001, height: 4000 }).crop).toEqual(crop); // one pixel off is the same shape
  });

  it("centres the crop's proportions on a photo of a different shape", () => {
    const square = { x: 0.25, y: 0, width: 4000 / 6000, height: 1 }; // 1:1 out of 3:2
    const clipboard = buildClipboard(describeEdits(BASE_STATE, square, LANDSCAPE), { crop: true });
    const plan = planForTarget(clipboard, { width: 2000, height: 3000 }); // portrait target
    expect(plan.crop.width).toBeCloseTo(1);
    expect(plan.crop.height).toBeCloseTo(2 / 3);
    expect(plan.crop.x).toBeCloseTo(0);
    expect(plan.crop.y).toBeCloseTo(1 / 6);
  });

  it("compares shapes after the pasted quarter turn", () => {
    // Source: a portrait file turned on its side, so its transformed shape is 3:2.
    const edits = describeEdits({ ...BASE_STATE, quarterTurns: 1 }, crop, LANDSCAPE);
    const clipboard = buildClipboard(edits, { rotate: true, crop: true });
    // Another portrait file becomes 3:2 after the same turn → identical box.
    expect(planForTarget(clipboard, { width: 4000, height: 6000 }).crop).toEqual(crop);
  });

  it("a pasted angle always gets a crop that leaves no empty corners", () => {
    const clipboard = buildClipboard(describeEdits({ ...BASE_STATE, freeAngle: -7.5 }, null, LANDSCAPE), { angle: true });
    const target = { width: 3000, height: 3000 };
    const plan = planForTarget(clipboard, target);
    expect(plan.freeAngle).toBe(-7.5);
    expect(fitsInsideRotated(plan.crop, target, -7.5)).toBe(true);
    expect(plan.crop.width / plan.crop.height).toBeCloseTo(1); // keeps the photo's own shape
    expect(plan.crop.width).toBeGreaterThan(0.85); // and is the largest such box, not a timid one
  });

  it("angle plus crop onto a different shape still fits inside the turned photo", () => {
    const square = { x: 0.3, y: 0.1, width: 0.4, height: 0.6 };
    const clipboard = buildClipboard(describeEdits({ ...BASE_STATE, freeAngle: 12 }, square, LANDSCAPE), { angle: true, crop: true });
    const target = { width: 2000, height: 3000 };
    const plan = planForTarget(clipboard, target);
    expect(fitsInsideRotated(plan.crop, target, 12)).toBe(true);
    expect((plan.crop.width * target.width) / (plan.crop.height * target.height)).toBeCloseTo(1);
  });

  it("needs the target's size for a crop or an angle, but not for turns and flips", () => {
    const geometry = buildClipboard(describeEdits(BASE_STATE, crop, LANDSCAPE), { crop: true });
    expect(planForTarget(geometry, { width: null, height: null })).toBeNull();
    const turns = buildClipboard(describeEdits({ ...BASE_STATE, quarterTurns: 2 }, null, LANDSCAPE), { rotate: true });
    expect(planForTarget(turns, {}).quarterTurns).toBe(2);
  });
});

describe("canPasteOnto", () => {
  it("accepts what sharp reads and refuses RAW, HEIC and video", () => {
    expect(canPasteOnto({ asset_type: "image", image_path: "/a/B.JPG" })).toBe(true);
    expect(canPasteOnto({ asset_type: "image", image_path: "/a/b.tiff" })).toBe(true);
    expect(canPasteOnto({ asset_type: "image", image_path: "/a/b.heic" })).toBe(false);
    expect(canPasteOnto({ asset_type: "image", image_path: "/a/b.3fr" })).toBe(false);
    expect(canPasteOnto({ asset_type: "video", image_path: "/a/b.mp4" })).toBe(false);
    expect(canPasteOnto(null)).toBe(false);
  });
});
