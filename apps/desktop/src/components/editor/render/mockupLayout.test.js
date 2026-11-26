import { describe, expect, it } from "vitest";
import {
  MOCKUP_MAX_UPSCALE, mockupBodyPad, mockupHidesPhoto, mockupLayout, mockupOutputScale, mockupRotation, turnedAsset,
} from "./mockupLayout";

// A 1000×600 camera picture with a 4:3 display (400×300) at (100, 150).
const CAMERA = { size: [1000, 600], screen: { x: 0.1, y: 0.25, w: 0.4, h: 0.5, radius: 0.05 } };
const contain = { fit: "contain", rotation: "auto" };
const fill = { fit: "fill", rotation: "auto" };

describe("mockup rotation", () => {
  it("keeps a landscape camera level for a landscape or square photo", () => {
    expect(mockupRotation(CAMERA, contain, 3000, 2000)).toBe(0);
    expect(mockupRotation(CAMERA, contain, 2000, 2000)).toBe(0);
  });

  it("turns the camera upright, to the left, for a portrait photo", () => {
    expect(mockupRotation(CAMERA, contain, 2000, 3000)).toBe(-90);
  });

  it("turns a camera with a portrait display for a landscape photo", () => {
    const upright = { size: [1000, 600], screen: { x: 0.1, y: 0.1, w: 0.3, h: 0.8 } };
    expect(mockupRotation(upright, contain, 3000, 2000)).toBe(-90);
    expect(mockupRotation(upright, contain, 2000, 3000)).toBe(0);
  });

  it("keeps a turn asked for by hand", () => {
    expect(mockupRotation(CAMERA, { rotation: 0 }, 2000, 3000)).toBe(0);
    expect(mockupRotation(CAMERA, { rotation: -90 }, 3000, 2000)).toBe(-90);
  });

  it("turns the picture and its display together", () => {
    const left = turnedAsset(CAMERA, -90);
    expect([left.w, left.h]).toEqual([600, 1000]);
    // (x, y) → (y, W − x): the display's left edge (x 100) becomes its bottom (y 900).
    expect(left.screen).toEqual({ x: 150, y: 500, w: 300, h: 400 });
    const right = turnedAsset(CAMERA, 90);
    expect(right.screen).toEqual({ x: 150, y: 100, w: 300, h: 400 });
  });
});

describe("mockup layout", () => {
  it("fits the whole photo on the display, centred, with bars on the rest", () => {
    const content = { x: 50, y: 40, width: 1200, height: 800 };
    const L = mockupLayout(CAMERA, contain, content);
    // 3:2 photo on a 4:3 display: the width decides.
    expect(L.k).toBeCloseTo(3);
    expect(L.screen.width).toBeCloseTo(1200);
    expect(L.screen.height).toBeCloseTo(900);
    expect(L.screen.x + L.screen.width / 2).toBeCloseTo(content.x + content.width / 2);
    expect(L.screen.y + L.screen.height / 2).toBeCloseTo(content.y + content.height / 2);
    expect(L.screen.radius).toBeCloseTo(0.05 * 900);
    expect(L.camera.width).toBeCloseTo(3000);
    expect(L.camera.x).toBeCloseTo(content.x - 100 * 3);
  });

  it("covers the display with the photo when filling it", () => {
    const L = mockupLayout(CAMERA, fill, { x: 0, y: 0, width: 1200, height: 800 });
    expect(L.k).toBeCloseTo(800 / 300);
    expect(L.screen.height).toBeCloseTo(800);
    expect(L.screen.width).toBeLessThan(1200);
  });

  it("puts an upright camera's display around a portrait photo", () => {
    const L = mockupLayout(CAMERA, contain, { x: 0, y: 0, width: 800, height: 1200 });
    expect(L.rotation).toBe(-90);
    expect(L.screen.width).toBeCloseTo(900);
    expect(L.screen.height).toBeCloseTo(1200);
    expect(L.camera.width).toBeCloseTo(600 * L.k);
    expect(L.camera.height).toBeCloseTo(1000 * L.k);
  });

  it("gives the margins from the photo out to the camera's edges", () => {
    const pad = mockupBodyPad(CAMERA, contain, 1200, 800);
    // Camera 3000×1800 around the photo; the display (1200×900) sits 300 in
    // from the left, 450 from the top, and the photo 50 inside its height.
    expect(pad.left).toBeCloseTo(300);
    expect(pad.right).toBeCloseTo(3000 - 300 - 1200);
    expect(pad.top).toBeCloseTo(450 + 50);
    expect(pad.bottom).toBeCloseTo(1800 - 450 - 900 + 50);
  });

  it("stacks the camera above the photo, the photo on its display too", () => {
    const stack = { fit: "fill", rotation: "auto", layout: "stack" };
    const content = { x: 0, y: 0, width: 1200, height: 800 };
    const L = mockupLayout(CAMERA, stack, content);
    // 80% of the photo's width, centred, a gap of 6% of its width above it.
    expect(L.camera.width).toBeCloseTo(960);
    expect(L.camera.x).toBeCloseTo(120);
    expect(L.camera.y + L.camera.height).toBeCloseTo(-72);
    // The display filled: the photo covers it, centred on it.
    expect(L.photo.width).toBeGreaterThanOrEqual(L.screen.width - 1e-6);
    expect(L.photo.height).toBeCloseTo(L.screen.height);
    expect(L.photo.x + L.photo.width / 2).toBeCloseTo(L.screen.x + L.screen.width / 2);
    // All the margin is above the photo.
    const pad = mockupBodyPad(CAMERA, stack, 1200, 800);
    expect(pad.top).toBeCloseTo(72 + L.camera.height);
    expect([pad.left, pad.right, pad.bottom]).toEqual([0, 0, 0]);
    expect(mockupHidesPhoto(stack)).toBe(false);
    expect(mockupHidesPhoto(contain)).toBe(true);
  });

  it("draws a big photo smaller rather than blowing the camera up", () => {
    // The display is 400 px wide: a 4000 px photo would need the camera ×10.
    expect(mockupOutputScale(CAMERA, contain, 4000, 2667)).toBeCloseTo(MOCKUP_MAX_UPSCALE / 10);
    expect(mockupOutputScale(CAMERA, contain, 400, 267)).toBe(1);
  });
});
