import { describe, expect, it } from "vitest";

import { buildLightboxSources, resolveLightboxLogicalSize } from "./lightboxView";

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
