// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Pins the path-style addressing decision in lib/r2.ts.
//
// Why this matters: a self-hosted S3-compatible store (MinIO in the shipped
// docker-compose.yml) does not serve wildcard DNS, so virtual-hosted URLs like
// `https://fonto-assets.minio:9000/key` do not resolve — every request AND every
// presigned URL handed to the browser fails. Hosted stores (Cloudflare R2, AWS
// S3) do serve wildcard bucket DNS and have always run with the SDK default, so
// their behaviour must NOT change.
//
// These cases are the contract: hosted → SDK default (false), self-hosted →
// path style (true), explicit S3_FORCE_PATH_STYLE always wins.

import { afterEach, describe, expect, it } from "vitest";

import { resolveForcePathStyle } from "./r2";

const R2 = "https://abc123.r2.cloudflarestorage.com";

afterEach(() => {
  delete process.env.S3_FORCE_PATH_STYLE;
});

describe("resolveForcePathStyle", () => {
  it("keeps Cloudflare R2 on the SDK default (virtual-hosted)", () => {
    expect(resolveForcePathStyle(R2)).toBe(false);
  });

  it("keeps AWS S3 on the SDK default", () => {
    expect(resolveForcePathStyle("https://s3.us-east-1.amazonaws.com")).toBe(false);
  });

  it("uses path style for MinIO (no wildcard DNS)", () => {
    expect(resolveForcePathStyle("http://minio:9000")).toBe(true);
    expect(resolveForcePathStyle("http://127.0.0.1:9000")).toBe(true);
    expect(resolveForcePathStyle("http://localhost:9000")).toBe(true);
  });

  it("uses path style for an arbitrary self-hosted endpoint", () => {
    expect(resolveForcePathStyle("https://objects.example.internal")).toBe(true);
  });

  it("falls back to the SDK default when no endpoint is configured", () => {
    expect(resolveForcePathStyle(undefined)).toBe(false);
    expect(resolveForcePathStyle("")).toBe(false);
  });

  it("does not throw on an unparsable endpoint", () => {
    expect(resolveForcePathStyle("not a url")).toBe(false);
  });

  it("lets S3_FORCE_PATH_STYLE=true override a hosted endpoint", () => {
    process.env.S3_FORCE_PATH_STYLE = "true";
    expect(resolveForcePathStyle(R2)).toBe(true);
    process.env.S3_FORCE_PATH_STYLE = "1";
    expect(resolveForcePathStyle(R2)).toBe(true);
  });

  it("lets S3_FORCE_PATH_STYLE=false override a self-hosted endpoint", () => {
    process.env.S3_FORCE_PATH_STYLE = "false";
    expect(resolveForcePathStyle("http://minio:9000")).toBe(false);
    process.env.S3_FORCE_PATH_STYLE = "0";
    expect(resolveForcePathStyle("http://minio:9000")).toBe(false);
  });

  it("ignores an empty override and infers from the endpoint", () => {
    process.env.S3_FORCE_PATH_STYLE = "";
    expect(resolveForcePathStyle(R2)).toBe(false);
    expect(resolveForcePathStyle("http://minio:9000")).toBe(true);
  });

  it("does not treat a lookalike suffix as a hosted provider", () => {
    // `evilamazonaws.com` must NOT be read as AWS.
    expect(resolveForcePathStyle("https://evilamazonaws.com")).toBe(true);
    expect(resolveForcePathStyle("https://notamazonaws.com.evil.test")).toBe(true);
  });
});
