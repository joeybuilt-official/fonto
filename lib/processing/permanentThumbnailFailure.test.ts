// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { describe, expect, it } from "vitest";
import { isPermanentThumbnailFailure } from "./permanentThumbnailFailure";

describe("isPermanentThumbnailFailure", () => {
  it("classifies the 2026-09-08 EPS/BMP precedent as permanent", () => {
    expect(
      isPermanentThumbnailFailure("decodeToBuffer: unsupported mime type image/bmp")
    ).toBe(true);
  });

  it("classifies an exhausted RAW decode (incl. the decided-against jxrlib gap) as permanent", () => {
    expect(
      isPermanentThumbnailFailure(
        "raw decode failed for p_abc.dng (image/x-adobe-dng): simple_dcraw: no embedded preview; " +
          "dcraw_emu: dcraw_emu exited 2: Cannot open in.dng: Unsupported file format or not RAW file" +
          "; sharp fallback: unsupported tiff colour model 'multiband' for p_abc.dng (3ch uchar) — " +
          "no decoder available; typically a JPEG XR-compressed DNG, which needs jxrlib"
      )
    ).toBe(true);
  });

  it("classifies a fatal libjpeg/libvips stream error as permanent", () => {
    expect(
      isPermanentThumbnailFailure(
        "Input buffer has corrupt header: VipsJpeg: Corrupt JPEG data: 15 extraneous bytes before marker 0x48"
      )
    ).toBe(true);
  });

  it("classifies an exhausted PSD decode as permanent", () => {
    expect(
      isPermanentThumbnailFailure("psd decode produced no output for r_abc.psd")
    ).toBe(true);
    expect(
      isPermanentThumbnailFailure(
        "exiftool exited 1: Error: File format error - /tmp/fonto-psd-x/in.psd"
      )
    ).toBe(true);
  });

  it("classifies a truncated MP4 container as permanent", () => {
    expect(
      isPermanentThumbnailFailure("ffmpeg exit 1: moov atom not found")
    ).toBe(true);
  });

  it("classifies the deprecated old-style-JPEG TIFF codec gap as permanent", () => {
    expect(
      isPermanentThumbnailFailure(
        "tiff2vips: Old-style JPEG compression support is not configured"
      )
    ).toBe(true);
  });

  it("classifies any pdftoppm rejection (password, corrupt xref) as permanent", () => {
    expect(
      isPermanentThumbnailFailure("pdftoppm exit 1: Command Line Error: Incorrect password")
    ).toBe(true);
    expect(
      isPermanentThumbnailFailure(
        "pdftoppm exit 1: Syntax Error: Couldn't find trailer dictionary"
      )
    ).toBe(true);
  });

  it("classifies the deliberate decompression-bomb pixel ceiling as permanent", () => {
    expect(isPermanentThumbnailFailure("Input image exceeds pixel limit")).toBe(true);
  });

  it("does NOT classify the video seek/stream-selection bug as permanent — it is retryable", () => {
    // These are the classes fixed in extractVideoThumbnail.ts (2026-09-09): a real code
    // fix exists, so a retry after deploy should succeed — 'failed' stays correct.
    expect(
      isPermanentThumbnailFailure(
        "ffmpeg exit 234: [vost#0:0/mjpeg] Terminating thread with return code -22 (Invalid argument)"
      )
    ).toBe(false);
    expect(isPermanentThumbnailFailure("Input Buffer is empty")).toBe(false);
    expect(
      isPermanentThumbnailFailure(
        "ffmpeg exit 69: [dec:h264] Terminating thread with return code -1145393733 (No error information)"
      )
    ).toBe(false);
  });

  it("does not classify an arbitrary transient error as permanent", () => {
    expect(isPermanentThumbnailFailure("connect ETIMEDOUT 10.0.0.1:443")).toBe(false);
    expect(isPermanentThumbnailFailure("")).toBe(false);
  });
});
