// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// E4-M6 — which image mimes the ML consumers may NOT feed raw originals to.
// RAW/HEIC/HEIF/AVIF need the sharp-decoded preview; everything else the
// pipeline treats as image/ decodes from the original fine.

import { describe, expect, it } from "vitest";
import { visionNeedsPreview, isRawMime } from "./mime";

describe("visionNeedsPreview", () => {
  it("gates the RAW container mimes", () => {
    expect(visionNeedsPreview("image/x-canon-cr2")).toBe(true);
    expect(visionNeedsPreview("image/x-canon-cr3")).toBe(true);
    expect(visionNeedsPreview("image/x-adobe-dng")).toBe(true);
    expect(visionNeedsPreview("image/x-sony-arw")).toBe(true);
    expect(visionNeedsPreview("image/x-nikon-nef")).toBe(true);
  });

  it("gates HEIC / HEIF / AVIF", () => {
    expect(visionNeedsPreview("image/heic")).toBe(true);
    expect(visionNeedsPreview("image/heif")).toBe(true);
    expect(visionNeedsPreview("image/avif")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(visionNeedsPreview("IMAGE/HEIC")).toBe(true);
    expect(visionNeedsPreview("image/x-Canon-CR3")).toBe(true);
  });

  it("does NOT gate mimes the pipeline decodes from the original", () => {
    expect(visionNeedsPreview("image/jpeg")).toBe(false);
    expect(visionNeedsPreview("image/png")).toBe(false);
    expect(visionNeedsPreview("image/webp")).toBe(false);
    expect(visionNeedsPreview("image/gif")).toBe(false);
    expect(visionNeedsPreview("image/bmp")).toBe(false);
    expect(visionNeedsPreview("image/tiff")).toBe(false);
    expect(visionNeedsPreview("image/svg+xml")).toBe(false);
  });

  it("never gates non-image mimes", () => {
    expect(visionNeedsPreview("video/mp4")).toBe(false);
    expect(visionNeedsPreview("application/pdf")).toBe(false);
    expect(visionNeedsPreview("")).toBe(false);
  });

  it("RAW gate agrees with the existing isRawMime helper", () => {
    for (const m of [
      "image/x-canon-cr2",
      "image/x-pentax-pef",
      "image/x-sigma-x3f",
      "image/jpeg",
    ]) {
      expect(visionNeedsPreview(m)).toBe(isRawMime(m));
    }
  });
});