// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0002 — unified analyze-image client tests.
//
// The full `processAsset` pipeline is too DB/S3/Plexo-heavy to unit-test
// here without a fixture harness. This file covers the boundary: the
// fetch-based `analyzeImageUnified` client + the `unifiedAnalyzeEnabled`
// env probe. The integration-with-processAsset behaviour is exercised
// end-to-end against a live worker on the host (see ADR 0002 §10 rollout).
//
// Run: cd /workspace/fonto && npx vitest run lib/processing/__tests__/processAsset.unified.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  analyzeImageUnified,
  unifiedAnalyzeEnabled,
  type AnalyzeImageResult,
} from "../../intelligence/adapters/plexo-unified";

const SAMPLE_PAYLOAD: AnalyzeImageResult = {
  classification: "photo",
  subClassification: "portrait",
  confidence: 0.84,
  description: "Sara at the park bench with the dog, late afternoon.",
  ocrText: null,
  labels: ["person", "dog", "park", "bench"],
  suggestedTags: ["Portraits", "Pets"],
  model: "qwen2.5vl:7b",
  latencyMs: 5840,
};

describe("unifiedAnalyzeEnabled", () => {
  const ORIG_FLAG = process.env.USE_UNIFIED_ANALYZE;
  const ORIG_URL = process.env.PLEXO_URL;
  const ORIG_KEY = process.env.PLEXO_SERVICE_KEY;

  afterEach(() => {
    process.env.USE_UNIFIED_ANALYZE = ORIG_FLAG;
    process.env.PLEXO_URL = ORIG_URL;
    process.env.PLEXO_SERVICE_KEY = ORIG_KEY;
  });

  it("returns false when flag is unset", () => {
    delete process.env.USE_UNIFIED_ANALYZE;
    process.env.PLEXO_URL = "http://plexo:7000";
    process.env.PLEXO_SERVICE_KEY = "sk_test";
    expect(unifiedAnalyzeEnabled()).toBe(false);
  });

  it("returns false when flag is on but PLEXO_URL is missing", () => {
    process.env.USE_UNIFIED_ANALYZE = "1";
    delete process.env.PLEXO_URL;
    process.env.PLEXO_SERVICE_KEY = "sk_test";
    expect(unifiedAnalyzeEnabled()).toBe(false);
  });

  it("returns true on '1' + creds set", () => {
    process.env.USE_UNIFIED_ANALYZE = "1";
    process.env.PLEXO_URL = "http://plexo:7000";
    process.env.PLEXO_SERVICE_KEY = "sk_test";
    expect(unifiedAnalyzeEnabled()).toBe(true);
  });

  it("returns true on 'true' + creds set", () => {
    process.env.USE_UNIFIED_ANALYZE = "true";
    process.env.PLEXO_URL = "http://plexo:7000";
    process.env.PLEXO_SERVICE_KEY = "sk_test";
    expect(unifiedAnalyzeEnabled()).toBe(true);
  });

  it("returns false on '0'", () => {
    process.env.USE_UNIFIED_ANALYZE = "0";
    process.env.PLEXO_URL = "http://plexo:7000";
    process.env.PLEXO_SERVICE_KEY = "sk_test";
    expect(unifiedAnalyzeEnabled()).toBe(false);
  });
});

describe("analyzeImageUnified", () => {
  const ORIG_URL = process.env.PLEXO_URL;
  const ORIG_KEY = process.env.PLEXO_SERVICE_KEY;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.PLEXO_URL = "http://plexo:7000";
    process.env.PLEXO_SERVICE_KEY = "sk_test";
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    process.env.PLEXO_URL = ORIG_URL;
    process.env.PLEXO_SERVICE_KEY = ORIG_KEY;
    fetchSpy.mockRestore();
  });

  it("POSTs to /api/v1/vision/analyze-image with the right headers + body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await analyzeImageUnified({
      workspaceId: "11111111-1111-1111-1111-111111111111",
      imageUrl: "https://r2.example.com/img.jpg?sig=abc",
      mimeType: "image/jpeg",
      filename: "IMG_20260606.jpg",
      hints: {
        topClipClass: "photo",
        clipConfidence: 0.74,
        cameraMake: "Apple",
        hasExposureExif: true,
        widthPx: 4032,
        heightPx: 3024,
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://plexo:7000/api/v1/vision/analyze-image");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test");
    expect(headers["X-App-Id"]).toBe("fonto");
    expect(headers["X-Workspace-Id"]).toBe(
      "11111111-1111-1111-1111-111111111111",
    );

    const body = JSON.parse(init.body as string);
    expect(body.workspaceId).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.imageUrl).toBe("https://r2.example.com/img.jpg?sig=abc");
    expect(body.hints.topClipClass).toBe("photo");
    expect(body.hints.hasExposureExif).toBe(true);

    expect(result).toEqual(SAMPLE_PAYLOAD);
  });

  it("normalises missing fields to safe defaults", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ classification: "document" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await analyzeImageUnified({
      workspaceId: "11111111-1111-1111-1111-111111111111",
      imageUrl: "https://r2.example.com/x.jpg",
    });

    expect(result.classification).toBe("document");
    expect(result.subClassification).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.description).toBe("");
    expect(result.ocrText).toBeNull();
    expect(result.labels).toEqual([]);
    expect(result.suggestedTags).toEqual([]);
    expect(result.model).toBe("unknown");
    expect(result.latencyMs).toBe(0);
  });

  it("throws on HTTP error so the caller can fall back to legacy chain", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "MODEL_TIMEOUT" } }), {
        status: 504,
      }),
    );
    await expect(
      analyzeImageUnified({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        imageUrl: "https://r2.example.com/x.jpg",
      }),
    ).rejects.toThrow(/HTTP 504/);
  });

  it("throws if PLEXO_URL is not configured", async () => {
    delete process.env.PLEXO_URL;
    await expect(
      analyzeImageUnified({
        workspaceId: "11111111-1111-1111-1111-111111111111",
        imageUrl: "https://r2.example.com/x.jpg",
      }),
    ).rejects.toThrow(/PLEXO_URL/);
  });

  it("filters out non-string entries in labels + tags arrays", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          classification: "photo",
          labels: ["person", 42, null, "dog"],
          suggestedTags: ["Portraits", true, "Pets"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await analyzeImageUnified({
      workspaceId: "11111111-1111-1111-1111-111111111111",
      imageUrl: "https://r2.example.com/x.jpg",
    });

    expect(result.labels).toEqual(["person", "dog"]);
    expect(result.suggestedTags).toEqual(["Portraits", "Pets"]);
  });
});
