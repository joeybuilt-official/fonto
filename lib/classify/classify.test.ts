// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// The classifier scores an embedding against a matrix it is HANDED. These cases
// pin that contract: the same vector wins whichever function asks, a different
// matrix moves the answer, and a null matrix falls back instead of throwing.
// Before the matrix moved out of the domain, `loadTaxonomyVectors()` ran inside
// every call — a caller could not see, stub, or reason about the vectors the
// answer came from.

import { describe, it, expect } from "vitest";
import {
  classifyAsset,
  classifyAssetArgmax,
  relaxedTaxonomyTags,
  type TaxonomyCache,
} from "./classify";
import { TAXONOMY } from "./taxonomy";

const TOP_A = TAXONOMY[0].key;
const TOP_B = TAXONOMY[1].key;

/** One vector per taxonomy entry; `winner` scores 1 against [1,0,0], everything else 0. */
function cacheFor(winner: string): TaxonomyCache {
  const vectors = TAXONOMY.flatMap((top) => [
    { id: `top:${top.key}`, vec: top.key === winner ? [1, 0, 0] : [0, 1, 0] },
    ...top.subs.map((sub) => ({
      id: `sub:${top.key}:${sub.key}`,
      vec: top.key === winner ? [1, 0, 0] : [0, 1, 0],
    })),
  ]);
  return { modelId: "test-model", embeddedAt: "2026-10-29T00:00:00.000Z", vectors };
}

describe("classifyAsset — the matrix is injected, not fetched", () => {
  it("picks the top-level whose vector it scores highest", async () => {
    const result = await classifyAsset(
      [1, 0, 0],
      { classify: async () => ({ topLevel: "never" }) },
      cacheFor(TOP_A),
    );
    expect(result.taxonomyTopKey).toBe(TOP_A);
    expect(result.method).toBe("clip");
    expect(result.confidence).toBeCloseTo(1, 5);
  });

  it("follows the matrix, not the clip vector alone", async () => {
    const result = await classifyAsset(
      [1, 0, 0],
      { classify: async () => ({ topLevel: "never" }) },
      cacheFor(TOP_B),
    );
    expect(result.taxonomyTopKey).toBe(TOP_B);
  });

  it("falls back when no matrix was available", async () => {
    const result = await classifyAsset(
      [1, 0, 0],
      { classify: async () => ({ topLevel: "photo" }) },
      null,
    );
    expect(result.method).toBe("llm-fallback");
    expect(result.topLevel).toBe("photo");
  });

  it("argmax carries no placeholder when the matrix is absent", async () => {
    const empty = await classifyAssetArgmax([1, 0, 0], null);
    expect(empty).toMatchObject({ topLevel: null, taxonomyTopKey: null, confidence: 0 });
  });

  it("relaxed tags come from the injected matrix", async () => {
    const tags = await relaxedTaxonomyTags([1, 0, 0], { floor: 0.5, maxTags: 2 }, cacheFor(TOP_A));
    expect(tags.length).toBeGreaterThan(0);
    expect(await relaxedTaxonomyTags([1, 0, 0], { floor: 0.5, maxTags: 2 }, null)).toEqual([]);
  });
});
