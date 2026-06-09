// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — unit tests for the Google Takeout sidecar matcher
// and parser. Fixtures cover the four documented filename-mangling cases
// (immich-go heuristics): plain + truncation, duplicate counters, edited
// variants sharing the original's sidecar, and extension-in-the-middle
// truncation. Vitest-style; the repo doesn't yet have vitest installed, so
// these may not run in CI — they document the contract regardless.

import { describe, it, expect } from "vitest";
import { matchSidecar, parseSidecar } from "./takeoutSidecar";

const DIR = "Takeout/Google Photos/Photos from 2021/";

describe("matchSidecar", () => {
  it("(a) matches the plain IMG.jpg -> IMG.jpg.json pairing", () => {
    const members = [`${DIR}IMG_1234.jpg`, `${DIR}IMG_1234.jpg.json`];
    expect(matchSidecar(`${DIR}IMG_1234.jpg`, members)).toBe(
      `${DIR}IMG_1234.jpg.json`,
    );
  });

  it("(a) matches the .supplemental-metadata infix form", () => {
    const members = [
      `${DIR}IMG_1234.jpg`,
      `${DIR}IMG_1234.jpg.supplemental-metadata.json`,
    ];
    expect(matchSidecar(`${DIR}IMG_1234.jpg`, members)).toBe(
      `${DIR}IMG_1234.jpg.supplemental-metadata.json`,
    );
  });

  it("(a) matches a truncated (~46 char) sidecar base name", () => {
    // A long original whose sidecar Google clipped to ~46 chars before .json.
    const longName = "a_very_long_original_photo_filename_from_2021_holiday.jpg";
    const media = `${DIR}${longName}`;
    // ".supplemental-metadata" appended then the whole thing clipped to 46.
    const clipped =
      `${longName}.supplemental-metadata`.slice(0, 46) + ".json";
    const members = [media, `${DIR}${clipped}`];
    expect(matchSidecar(media, members)).toBe(`${DIR}${clipped}`);
  });

  it("(b) matches duplicate counters relocated after the extension", () => {
    const members = [`${DIR}IMG_1234(1).jpg`, `${DIR}IMG_1234.jpg(1).json`];
    expect(matchSidecar(`${DIR}IMG_1234(1).jpg`, members)).toBe(
      `${DIR}IMG_1234.jpg(1).json`,
    );
  });

  it("(b) also matches a counter kept in place on the sidecar", () => {
    const members = [`${DIR}IMG_1234(2).jpg`, `${DIR}IMG_1234(2).jpg.json`];
    expect(matchSidecar(`${DIR}IMG_1234(2).jpg`, members)).toBe(
      `${DIR}IMG_1234(2).jpg.json`,
    );
  });

  it("(c) edited variant shares the original's sidecar", () => {
    const members = [
      `${DIR}IMG_1234.jpg`,
      `${DIR}IMG_1234-edited.jpg`,
      `${DIR}IMG_1234.jpg.json`,
    ];
    expect(matchSidecar(`${DIR}IMG_1234-edited.jpg`, members)).toBe(
      `${DIR}IMG_1234.jpg.json`,
    );
  });

  it("(c) localized -modifié variant shares the original's sidecar", () => {
    const members = [
      `${DIR}IMG_5678.jpg`,
      `${DIR}IMG_5678-modifié.jpg`,
      `${DIR}IMG_5678.jpg.json`,
    ];
    expect(matchSidecar(`${DIR}IMG_5678-modifié.jpg`, members)).toBe(
      `${DIR}IMG_5678.jpg.json`,
    );
  });

  it("(d) extension-in-the-middle truncation still resolves", () => {
    // Base already at the cap; the sidecar's extension is clipped mid-word.
    const base = "x".repeat(44); // 44 chars
    const media = `${DIR}${base}.jpg`; // base+ext
    // Sidecar: "<base>.jpg" clipped to 46 then ".json" -> "<base>.j.json"
    const clipped = `${base}.jpg`.slice(0, 46) + ".json"; // "<44x>.j.json"
    const members = [media, `${DIR}${clipped}`];
    expect(matchSidecar(media, members)).toBe(`${DIR}${clipped}`);
  });

  it("returns null when no sidecar is present", () => {
    const members = [`${DIR}IMG_9999.jpg`];
    expect(matchSidecar(`${DIR}IMG_9999.jpg`, members)).toBeNull();
  });

  it("does not cross directory boundaries", () => {
    const members = [
      `${DIR}IMG_1234.jpg`,
      `Takeout/Google Photos/Other album/IMG_1234.jpg.json`,
    ];
    expect(matchSidecar(`${DIR}IMG_1234.jpg`, members)).toBeNull();
  });
});

describe("parseSidecar", () => {
  it("parses photoTakenTime, geoData, and description", () => {
    const json = JSON.stringify({
      title: "IMG_1234.jpg",
      description: "  Sunset over the bay  ",
      photoTakenTime: { timestamp: "1614556800", formatted: "Mar 1, 2021" },
      geoData: { latitude: 37.7749, longitude: -122.4194, altitude: 0 },
    });
    const md = parseSidecar(json);
    expect(md.capturedAt?.getTime()).toBe(1614556800 * 1000);
    expect(md.latitude).toBeCloseTo(37.7749);
    expect(md.longitude).toBeCloseTo(-122.4194);
    expect(md.description).toBe("Sunset over the bay");
  });

  it("drops the 0/0 geo placeholder", () => {
    const json = JSON.stringify({
      photoTakenTime: { timestamp: "1614556800" },
      geoData: { latitude: 0, longitude: 0 },
    });
    const md = parseSidecar(json);
    expect(md.latitude).toBeUndefined();
    expect(md.longitude).toBeUndefined();
    expect(md.capturedAt).toBeDefined();
  });

  it("falls back to creationTime when photoTakenTime is absent", () => {
    const json = JSON.stringify({
      creationTime: { timestamp: "1600000000" },
    });
    expect(parseSidecar(json).capturedAt?.getTime()).toBe(1600000000 * 1000);
  });

  it("drops a blank description", () => {
    const md = parseSidecar(
      JSON.stringify({ description: "   ", geoDataExif: { latitude: 1, longitude: 2 } }),
    );
    expect(md.description).toBeUndefined();
    expect(md.latitude).toBe(1);
  });

  it("returns an empty object on malformed JSON", () => {
    expect(parseSidecar("{not json")).toEqual({});
  });
});
