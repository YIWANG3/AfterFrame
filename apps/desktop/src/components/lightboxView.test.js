import { describe, expect, it } from "vitest";

import { buildLightboxSources, compareSource, resolveLightboxLogicalSize } from "./lightboxView";

describe("lightbox source selection", () => {
  it("uses the 512px preview for interaction and reserves the original for detail", () => {
    expect(buildLightboxSources({
      asset_type: "image",
      exists_on_disk: true,
      image_path: "/photos/original.jpg",
      preview_hd_path: "/catalog/preview-hd.jpg",
      preview_path: "/catalog/preview.jpg",
    })).toEqual({
      baseSources: [
        "/catalog/preview.jpg",
        "/catalog/preview-hd.jpg",
        "/photos/original.jpg",
      ],
      detailPath: "/photos/original.jpg",
    });
  });

  it("falls back to the HD preview when the 512px preview is missing", () => {
    expect(buildLightboxSources({
      asset_type: "image",
      exists_on_disk: true,
      image_path: "/photos/original.jpg",
      preview_hd_path: "/catalog/preview-hd.jpg",
    })).toEqual({
      baseSources: ["/catalog/preview-hd.jpg", "/photos/original.jpg"],
      detailPath: "/photos/original.jpg",
    });
  });

  it("falls back to the original as base when previews are missing", () => {
    expect(buildLightboxSources({
      asset_type: "image",
      exists_on_disk: true,
      image_path: "/photos/original.jpg",
    })).toEqual({
      baseSources: ["/photos/original.jpg"],
      detailPath: null,
    });
  });

  it("does not try to layer an undecodable RAW original", () => {
    expect(buildLightboxSources({
      asset_type: "raw",
      image_path: "/photos/source.cr3",
      preview_hd_path: "/catalog/source.jpg",
      preview_path: "/catalog/source-small.jpg",
    })).toEqual({
      baseSources: ["/catalog/source.jpg", "/catalog/source-small.jpg"],
      detailPath: null,
    });
  });

  it("layers a RAW's on-demand HD preview over its thumbnail, like an original", () => {
    const raw = {
      asset_type: "raw",
      image_path: "/photos/source.cr3",
      preview_path: "/catalog/source-small.jpg",
    };
    expect(buildLightboxSources(raw)).toEqual({
      baseSources: ["/catalog/source-small.jpg"],
      detailPath: null,
    });
    expect(buildLightboxSources(raw, { onDemandHd: "/catalog/hd/source.jpg" })).toEqual({
      baseSources: ["/catalog/source-small.jpg", "/catalog/hd/source.jpg"],
      detailPath: "/catalog/hd/source.jpg",
    });
  });
});

describe("lightbox logical image size", () => {
  it("keeps full-resolution dimensions when metadata and intrinsic orientation match", () => {
    expect(resolveLightboxLogicalSize(512, 341.333333, 6000, 4000)).toEqual({ width: 6000, height: 4000 });
  });

  it("uses Chromium's EXIF-corrected portrait orientation", () => {
    expect(resolveLightboxLogicalSize(400, 600, 6000, 4000)).toEqual({
      width: 4000,
      height: 6000,
    });
  });

  it("uses intrinsic dimensions when catalog dimensions are unavailable", () => {
    expect(resolveLightboxLogicalSize(512, 341, 0, 0)).toEqual({ width: 512, height: 341 });
  });
});

describe("compareSource", () => {
  const raw = { asset_id: "r1", asset_type: "raw", image_path: "/p/a.ARW", exists_on_disk: true, image_preview_path: "/c/previews/r1.jpg" };

  it("never hands Compare a RAW, a TIFF or a video to decode", () => {
    expect(compareSource(raw)).toBe("/c/previews/r1.jpg");
    expect(compareSource({ ...raw, preview_hd_path: "/c/previews-hd/r1.jpg" })).toBe("/c/previews-hd/r1.jpg");
    expect(compareSource({ asset_type: "image", image_path: "/p/b.tif", image_preview_path: "/c/previews/b.jpg" })).toBe("/c/previews/b.jpg");
    expect(compareSource({ asset_type: "video", image_path: "/p/c.mp4", image_preview_path: "/c/previews/c.jpg" })).toBe("/c/previews/c.jpg");
  });

  it("shows a RAW's on-demand HD preview once it arrives", () => {
    expect(compareSource(raw, { onDemandHd: "/c/previews-hd/r1.jpg" })).toBe("/c/previews-hd/r1.jpg");
  });

  it("shows a photo's original when the browser can read it and it is there", () => {
    expect(compareSource({ asset_type: "image", image_path: "/p/d.JPG", image_preview_path: "/c/previews/d.jpg" })).toBe("/p/d.JPG");
    expect(compareSource({ asset_type: "image", image_path: "/p/d.jpg", exists_on_disk: false, image_preview_path: "/c/previews/d.jpg" })).toBe("/c/previews/d.jpg");
    expect(compareSource(null)).toBeNull();
  });
});
