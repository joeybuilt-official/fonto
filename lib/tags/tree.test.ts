// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// The tag tree's invariants, pinned. `lib/tags/store.ts` enforces the depth and
// cycle guards against these helpers, so a helper that changed shape would move
// the guards without any SQL changing.

import { describe, expect, it } from "vitest";
import { childPath, isSelfOrDescendant, pathDepth, rewriteSubtreePath, TAG_DEPTH_LIMIT } from "./tree";

describe("tag tree paths", () => {
  it("a root child is /<id>/ and a nested one extends the parent path", () => {
    expect(childPath(null, "a")).toBe("/a/");
    expect(childPath("", "a")).toBe("/a/");
    expect(childPath("/a/", "b")).toBe("/a/b/");
  });

  it("depth counts ids, so a root is 1", () => {
    expect(pathDepth("/a/")).toBe(1);
    expect(pathDepth("/a/b/c/")).toBe(3);
  });

  it("the depth cap is a boundary the create path can reach but not pass", () => {
    const atCap = "/" + Array.from({ length: TAG_DEPTH_LIMIT }, (_, i) => `id${i}`).join("/") + "/";
    expect(pathDepth(atCap)).toBe(TAG_DEPTH_LIMIT);
    expect(pathDepth(childPath(atCap, "overflow"))).toBe(TAG_DEPTH_LIMIT + 1);
  });

  it("a node is its own ancestor — the case the cycle guard exists for", () => {
    expect(isSelfOrDescendant("/a/", "/a/")).toBe(true);
    expect(isSelfOrDescendant("/a/b/", "/a/")).toBe(true);
    expect(isSelfOrDescendant("/a/", "/a/b/")).toBe(false);
    expect(isSelfOrDescendant("/ab/", "/a/")).toBe(false);
  });

  it("a subtree rewrite replaces the moved prefix and leaves the tail alone", () => {
    expect(rewriteSubtreePath("/a/", "/x/a/", "/a/")).toBe("/x/a/");
    expect(rewriteSubtreePath("/a/", "/x/a/", "/a/b/c/")).toBe("/x/a/b/c/");
  });
});
