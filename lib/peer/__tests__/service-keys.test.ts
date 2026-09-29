// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Tests for the published API's inbound service-key auth.
//
// Contract:
//   - unconfigured deployment ⇒ 503 FEATURE_DISABLED (a configuration state,
//     not an outage — no core flow depends on this surface);
//   - missing/wrong bearer ⇒ 401;
//   - the active key and the rotation key both authenticate;
//   - comparison is constant-time over equal-length buffers (verified by
//     behaviour, not timing measurement: wrong key of the same length fails,
//     correct key passes).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  authorizeServiceKey,
  isPeerSurfaceConfigured,
} from "@/lib/peer/service-keys";

const ORIG_KEY = process.env.FONTO_SERVICE_KEY;
const ORIG_KEY2 = process.env.FONTO_SERVICE_KEY_V2;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3500/api/peer/v1/data", { headers });
}

beforeEach(() => {
  delete process.env.FONTO_SERVICE_KEY;
  delete process.env.FONTO_SERVICE_KEY_V2;
});

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.FONTO_SERVICE_KEY;
  else process.env.FONTO_SERVICE_KEY = ORIG_KEY;
  if (ORIG_KEY2 === undefined) delete process.env.FONTO_SERVICE_KEY_V2;
  else process.env.FONTO_SERVICE_KEY_V2 = ORIG_KEY2;
});

describe("peer service keys", () => {
  it("reports the surface unconfigured when no key is set", () => {
    expect(isPeerSurfaceConfigured()).toBe(false);
    const result = authorizeServiceKey(req({ authorization: "Bearer anything" }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.code).toBe("FEATURE_DISABLED");
  });

  it("rejects a missing bearer token with 401", () => {
    process.env.FONTO_SERVICE_KEY = "svc-secret";
    const result = authorizeServiceKey(req());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("rejects a wrong key of equal length with 401", () => {
    process.env.FONTO_SERVICE_KEY = "svc-secret-aaaa";
    const result = authorizeServiceKey(req({ authorization: "Bearer svc-secret-bbbb" }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("accepts the active key", () => {
    process.env.FONTO_SERVICE_KEY = "svc-secret";
    expect(authorizeServiceKey(req({ authorization: "Bearer svc-secret" })).ok).toBe(true);
  });

  it("accepts the rotation key in parallel", () => {
    process.env.FONTO_SERVICE_KEY = "svc-secret";
    process.env.FONTO_SERVICE_KEY_V2 = "svc-secret-next";
    expect(authorizeServiceKey(req({ authorization: "Bearer svc-secret-next" })).ok).toBe(true);
    expect(authorizeServiceKey(req({ authorization: "Bearer svc-secret" })).ok).toBe(true);
  });

  it("ignores blank/whitespace keys (a blank env is unconfigured, not a match)", () => {
    process.env.FONTO_SERVICE_KEY = "   ";
    expect(isPeerSurfaceConfigured()).toBe(false);
    expect(authorizeServiceKey(req({ authorization: "Bearer    " })).status).toBe(503);
  });

  it("is case-insensitive on the scheme", () => {
    process.env.FONTO_SERVICE_KEY = "svc-secret";
    expect(authorizeServiceKey(req({ authorization: "bearer svc-secret" })).ok).toBe(true);
  });
});
