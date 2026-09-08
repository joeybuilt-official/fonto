// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { describe, expect, it } from "vitest";
import { describeError } from "./describeError";
import { CapabilityUnavailableError } from "../intelligence/ports";

describe("describeError", () => {
  it("keeps a real Error message verbatim", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("describes the production case: an empty-message tagged error", () => {
    // The exact value that wrote 6,704 empty processing_error rows on 2026-09-04.
    const err = new CapabilityUnavailableError({
      port: "jex/Completion",
      reason: "FONTO_LLM_KEY is not set",
    });
    expect(err.message).toBe("");
    const described = describeError(err);
    expect(described).toContain("CapabilityUnavailableError");
    expect(described).toContain("FONTO_LLM_KEY is not set");
    expect(described).toContain("jex/Completion");
  });

  it("never returns an empty string", () => {
    for (const value of [undefined, null, "", 0, {}, new Error(""), [], NaN]) {
      expect(describeError(value)).not.toBe("");
    }
  });

  it("names a tagless empty-message error by its constructor", () => {
    class WeirdError extends Error {}
    expect(describeError(new WeirdError())).toBe("WeirdError");
  });

  it("renders primitive fields and omits object payloads", () => {
    const err = Object.assign(new Error(""), {
      _tag: "UploadError",
      assetId: "abc-123",
      attempt: 3,
      payload: { buffer: "do-not-leak" },
    });
    const described = describeError(err);
    expect(described).toContain("assetId=abc-123");
    expect(described).toContain("attempt=3");
    expect(described).not.toContain("do-not-leak");
  });

  it("passes a plain string through", () => {
    expect(describeError("socket timed out")).toBe("socket timed out");
  });
});
