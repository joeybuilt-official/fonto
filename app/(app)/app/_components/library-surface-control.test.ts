// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M2 lens reconciliation — the `?kind=` ↔ (surface, lens) contract. These pure
// functions are the whole substance of collapsing the Photos/Files surface
// split into a single `?kind=` param, so they carry deterministic coverage.

import { describe, it, expect } from "vitest";
import {
  deriveSplitState,
  kindForSelection,
  INBOX_KIND,
  type LibrarySurface,
} from "./library-surface-control";

describe("kindForSelection (write: selection → ?kind=)", () => {
  it("maps Photos lenses to single kinds and the union", () => {
    expect(kindForSelection("photos", "all")).toBe("moment,video");
    expect(kindForSelection("photos", "moment")).toBe("moment");
    expect(kindForSelection("photos", "video")).toBe("video");
  });

  it("maps Files lenses to single kinds and the union", () => {
    expect(kindForSelection("files", "all")).toBe("screenshot,graphics,document");
    expect(kindForSelection("files", "screenshot")).toBe("screenshot");
    expect(kindForSelection("files", "graphics")).toBe("graphics");
    expect(kindForSelection("files", "document")).toBe("document");
  });

  it("maps the Inbox surface to the unclassified sentinel", () => {
    expect(kindForSelection("unsorted", "all")).toBe(INBOX_KIND);
    expect(INBOX_KIND).toBe("unclassified");
  });
});

describe("deriveSplitState (read: ?kind= → selection)", () => {
  it("defaults a missing kind to Photos · All", () => {
    expect(deriveSplitState(null)).toEqual({ surface: "photos", lens: "all" });
    expect(deriveSplitState("")).toEqual({ surface: "photos", lens: "all" });
  });

  it("resolves the Inbox sentinel to the Unsorted surface", () => {
    expect(deriveSplitState("unclassified")).toEqual({
      surface: "unsorted",
      lens: "all",
    });
  });

  it("resolves a comma-union to that surface's All lens", () => {
    expect(deriveSplitState("moment,video")).toEqual({
      surface: "photos",
      lens: "all",
    });
    expect(deriveSplitState("screenshot,graphics,document")).toEqual({
      surface: "files",
      lens: "all",
    });
  });

  it("resolves a single kind to its surface + lens", () => {
    expect(deriveSplitState("moment")).toEqual({ surface: "photos", lens: "moment" });
    expect(deriveSplitState("video")).toEqual({ surface: "photos", lens: "video" });
    expect(deriveSplitState("document")).toEqual({ surface: "files", lens: "document" });
    expect(deriveSplitState("screenshot")).toEqual({
      surface: "files",
      lens: "screenshot",
    });
  });

  it("routes any file kind in a mixed set to the Files surface", () => {
    // A file kind present anywhere wins the surface classification.
    expect(deriveSplitState("document").surface).toBe("files");
  });
});

describe("round-trip: derive(kindFor(surface, lens)) is identity for every valid pair", () => {
  const pairs: Array<{ surface: LibrarySurface; lens: string }> = [
    { surface: "photos", lens: "all" },
    { surface: "photos", lens: "moment" },
    { surface: "photos", lens: "video" },
    { surface: "files", lens: "all" },
    { surface: "files", lens: "screenshot" },
    { surface: "files", lens: "graphics" },
    { surface: "files", lens: "document" },
    { surface: "unsorted", lens: "all" },
  ];
  for (const p of pairs) {
    it(`${p.surface} · ${p.lens}`, () => {
      expect(deriveSplitState(kindForSelection(p.surface, p.lens))).toEqual(p);
    });
  }
});
