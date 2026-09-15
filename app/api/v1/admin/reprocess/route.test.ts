// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Colocated endpoint test for POST /api/v1/admin/reprocess (M5d).
//
// The route is a thin enqueue dispatcher: instance-admin gate, then a fixed
// whitelist of maintenance-job names forwarded straight to a real bullmq
// handle. We mock the two edges (admin gate + queue) so the assertions test
// the route's own contract — authorization, whitelist validation, and that a
// valid job name reaches the queue unchanged — without a Redis/DB boot.
//
// This is the first colocated route.test.ts in the repo; it exists because
// the endpoint-test gate requires one (the allowlist refuses net-new entries
// and a test green-lights a real handler). vitest.config.ts adds the `@/`
// alias so the handler's root-relative imports resolve here too.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const redirect = vi.fn();

vi.mock("@/lib/authz/instance", () => ({
  requireInstanceAdmin: () =>
    Promise.resolve(
      process.env.__ADMIN === "yes"
        ? { ok: true, user: { id: "u1", email: "admin@example.com" } }
        : { ok: false, response: redirect() }
    ),
}));

const added: Array<{ name: string; payload: unknown; opts: unknown }> = [];
vi.mock("@/lib/queue/queues", () => ({
  maintenanceQueue: () => ({
    add: (name: string, payload: unknown, opts?: unknown) => {
      added.push({ name, payload, opts });
      return Promise.resolve({ id: "job" });
    },
  }),
}));

vi.mock("@/lib/processing/backfillFaceCrops", () => ({
  enqueueBackfillFaceCrops: () => {
    added.push({ name: "backfill-face-crops", payload: {}, opts: undefined });
    return Promise.resolve();
  },
}));

import { POST } from "./route";

function req(job?: string): NextRequest {
  const body = job === undefined ? JSON.stringify({}) : JSON.stringify({ job });
  return {
    json: () => Promise.resolve(JSON.parse(body)),
    // Sigh — NextRequest is a class; casting a plain object keeps it simple.
  } as unknown as NextRequest;
}

beforeEach(() => {
  added.length = 0;
  redirect.mockClear();
  delete process.env.__ADMIN;
});

describe("POST /api/v1/admin/reprocess", () => {
  it("returns 401 for a non-admin caller", async () => {
    const res = await POST(req("thumbnails"));
    expect(res).toBe(redirect());
    expect(redirect).toHaveBeenCalled();
    expect(added).toHaveLength(0);
  });

  it("returns 400 for an unknown job name", async () => {
    process.env.__ADMIN = "yes";
    const res = await POST(req("bogus"));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("Unknown maintenance job");
    expect(added).toHaveLength(0);
  });

  it("returns 400 for a missing body / job field", async () => {
    process.env.__ADMIN = "yes";
    const res = await POST(req(undefined));
    expect(res.status).toBe(400);
    expect(added).toHaveLength(0);
  });

  it("enqueues thumbnails on the maintenance queue unchanged", async () => {
    process.env.__ADMIN = "yes";
    const res = await POST(req("thumbnails"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.enqueued).toBe("backfill-thumbnails");
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe("backfill-thumbnails");
  });

  it("enqueues clip on the maintenance queue unchanged", async () => {
    process.env.__ADMIN = "yes";
    const res = await POST(req("clip"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.enqueued).toBe("backfill-clip");
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe("backfill-clip");
  });

  it("enqueues every whitelisted job name unchanged", async () => {
    process.env.__ADMIN = "yes";
    for (const job of [
      "thumbnails",
      "clip",
      "auto-cluster",
      "evidence",
      "inference",
      "face-crops",
      "reap-stuck",
    ]) {
      await POST(req(job));
    }
    const enqueued = added.map((a) => a.name);
    expect(enqueued).toEqual([
      "backfill-thumbnails",
      "backfill-clip",
      "auto-cluster-scan",
      "backfill-evidence",
      "backfill-inference",
      "backfill-face-crops",
      "reap-stuck-assets",
    ]);
  });
});