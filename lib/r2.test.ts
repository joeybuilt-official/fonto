// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Pins the R2 transport timeout policy added after the 2026-08-31 thumbnail
// deadlock (R2 half-closed two sockets, the SDK's DEFAULT_REQUEST_TIMEOUT of 0
// meant the job promises never settled, and 12 worker slots were held for 40
// minutes against a 5,325-job backlog).
//
// The 6000ms ceiling is the load-bearing assertion here. @smithy/node-http-
// handler installs the socket timeout immediately only when the value is under
// 6000; at 6000+ it defers registration and the handler's `resolve` cancels it
// as soon as response HEADERS arrive — leaving a streamed body drain, the exact
// thing that hung, unguarded. An operator "being generous" with the env var
// would silently reintroduce the outage, so the clamp is tested, not trusted.
//
// C3 (2026-09-09) added the connectionTimeout default assertion below: 14
// live `hls_state='failed'` rows carried `socket did not establish ... within
// 3000 ms` — the SDK default connectionTimeout was never raised even after
// the socketTimeout fix above landed. connectionTimeout has no smithy
// registration cliff (that's a socketTimeout-only bug), so it's pinned only
// to "greater than the old 3000ms default," not to an exact ceiling.
//
// Run: npx vitest run lib/r2.test.ts

import { describe, it, expect, afterEach } from "vitest";
import { resolveR2Timeouts } from "./r2";

const ENV_KEYS = ["R2_SOCKET_TIMEOUT_MS", "R2_CONNECTION_TIMEOUT_MS"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("resolveR2Timeouts", () => {
  it("defaults to a socket timeout under the 6000ms registration cliff", () => {
    const { socketTimeout } = resolveR2Timeouts();
    expect(socketTimeout).toBeGreaterThan(0);
    expect(socketTimeout).toBeLessThan(6000);
  });

  it("defaults to a positive connection timeout", () => {
    expect(resolveR2Timeouts().connectionTimeout).toBeGreaterThan(0);
  });

  it("defaults the connection timeout above the SDK's 3000ms default that caused the C3 incident", () => {
    // 14 production hls_state='failed' rows hit "socket did not establish
    // ... within 3000 ms" under connection contention (concurrent R2
    // connections during a transcode/backfill burst) — 3000ms was too tight
    // for a legitimate-but-slow handshake, not a dead peer.
    expect(resolveR2Timeouts().connectionTimeout).toBeGreaterThan(3000);
  });

  it("accepts an operator override below the cliff", () => {
    process.env.R2_SOCKET_TIMEOUT_MS = "2500";
    expect(resolveR2Timeouts().socketTimeout).toBe(2500);
  });

  it("clamps a socket timeout AT the cliff back to the default", () => {
    process.env.R2_SOCKET_TIMEOUT_MS = "6000";
    expect(resolveR2Timeouts().socketTimeout).toBeLessThan(6000);
  });

  it("clamps a socket timeout ABOVE the cliff back to the default", () => {
    process.env.R2_SOCKET_TIMEOUT_MS = "60000";
    expect(resolveR2Timeouts().socketTimeout).toBeLessThan(6000);
  });

  it("never resolves to 0 — that is the SDK default that caused the deadlock", () => {
    for (const bad of ["0", "-1", "not-a-number", ""]) {
      process.env.R2_SOCKET_TIMEOUT_MS = bad;
      process.env.R2_CONNECTION_TIMEOUT_MS = bad;
      const t = resolveR2Timeouts();
      expect(t.socketTimeout).toBeGreaterThan(0);
      expect(t.connectionTimeout).toBeGreaterThan(0);
    }
  });

  it("leaves the connection timeout uncapped by the socket cliff", () => {
    process.env.R2_CONNECTION_TIMEOUT_MS = "9000";
    expect(resolveR2Timeouts().connectionTimeout).toBe(9000);
  });
});
