// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { describe, expect, it } from "vitest";
import { tryGenerative } from "./tryGenerative";
import { CapabilityUnavailableError } from "../intelligence/ports";

describe("tryGenerative", () => {
  it("passes a successful value through", async () => {
    await expect(tryGenerative(async () => "photo")).resolves.toEqual({
      ok: true,
      value: "photo",
    });
  });

  it("degrades on CapabilityUnavailableError with a non-empty reason", async () => {
    const result = await tryGenerative(async () => {
      throw new CapabilityUnavailableError({
        port: "jex/Completion",
        reason: "no providers configured for workspace",
      });
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toBe("");
    expect(result.reason).toContain("no providers configured for workspace");
  });

  it("RETHROWS a transient failure so BullMQ still retries it", async () => {
    // The rule that keeps a recoverable asset recoverable. A timeout must not
    // be mistaken for a permanently unconfigured capability.
    await expect(
      tryGenerative(async () => {
        throw new Error("socket timed out");
      }),
    ).rejects.toThrow("socket timed out");
  });

  it("rethrows a non-Error throw rather than silently degrading", async () => {
    await expect(
      tryGenerative(async () => {
        throw "upstream exploded";
      }),
    ).rejects.toBe("upstream exploded");
  });
});
