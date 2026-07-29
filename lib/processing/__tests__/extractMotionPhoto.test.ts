// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M12 / ADR 0014 — embedded motion-video extraction unit tests.
//
// Run: cd /workspace/fonto && npx vitest run lib/processing/__tests__/extractMotionPhoto.test.ts

import { describe, it, expect } from "vitest";
import { findEmbeddedMotionVideo } from "../extractMotionPhoto";

// Minimal synthetic JPEG: SOI … some entropy … EOI. Not a real decodable
// image — the extractor only cares about the SOI/EOI markers + the trailing
// MP4, never decodes pixels.
function fakeJpeg(bodyLen = 64): Buffer {
  const body = Buffer.alloc(bodyLen, 0x42);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    body,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

// Minimal MP4: a valid `ftyp` box (size + "ftyp" + brand) followed by filler
// so the slice clears the MIN_CLIP_BYTES floor.
function fakeMp4(totalLen = 4096): Buffer {
  const brand = Buffer.from("isommp42", "latin1"); // major + compatible
  const boxSize = 8 + brand.length; // size(4) + "ftyp"(4) + brand
  const header = Buffer.alloc(8);
  header.writeUInt32BE(boxSize, 0);
  header.write("ftyp", 4, "latin1");
  const ftyp = Buffer.concat([header, brand]);
  const filler = Buffer.alloc(Math.max(0, totalLen - ftyp.length), 0x00);
  return Buffer.concat([ftyp, filler]);
}

describe("findEmbeddedMotionVideo", () => {
  it("locates an MP4 appended after the JPEG EOI (byte-scan path)", () => {
    const jpeg = fakeJpeg();
    const mp4 = fakeMp4(4096);
    const file = Buffer.concat([jpeg, mp4]);

    const res = findEmbeddedMotionVideo(file);
    expect(res).not.toBeNull();
    expect(res!.offset).toBe(jpeg.length);
    expect(res!.length).toBe(mp4.length);
    // The sliced bytes must be exactly the embedded MP4.
    expect(file.subarray(res!.offset, res!.offset + res!.length).equals(mp4)).toBe(true);
  });

  it("honours the MicroVideoOffset XMP fast-path when present + valid", () => {
    const mp4 = fakeMp4(4096);
    // XMP packet carrying MicroVideoOffset = clip length, embedded in the
    // JPEG head (inside an APP1-ish region — the parser only string-scans).
    const xmp = Buffer.from(
      `<x:xmpmeta><rdf:Description GCamera:MicroVideoOffset="${mp4.length}"/></x:xmpmeta>`,
      "latin1",
    );
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      xmp,
      Buffer.alloc(32, 0x42),
      Buffer.from([0xff, 0xd9]),
    ]);
    const file = Buffer.concat([jpeg, mp4]);

    const res = findEmbeddedMotionVideo(file);
    expect(res).not.toBeNull();
    // Fast path measures back from EOF, so it lands on the real clip start.
    expect(res!.length).toBe(mp4.length);
    expect(res!.offset).toBe(file.length - mp4.length);
  });

  it("returns null for a plain JPEG with no trailing MP4", () => {
    expect(findEmbeddedMotionVideo(fakeJpeg())).toBeNull();
  });

  it("returns null for non-JPEG input (no SOI)", () => {
    const notJpeg = Buffer.concat([Buffer.alloc(16, 0x00), fakeMp4()]);
    expect(findEmbeddedMotionVideo(notJpeg)).toBeNull();
  });

  it("ignores a sub-threshold trailing 'ftyp' that is too small to be a clip", () => {
    const jpeg = fakeJpeg();
    // A tiny valid ftyp box but nowhere near MIN_CLIP_BYTES of trailing data.
    const tiny = fakeMp4(64);
    const file = Buffer.concat([jpeg, tiny]);
    expect(findEmbeddedMotionVideo(file)).toBeNull();
  });
});
