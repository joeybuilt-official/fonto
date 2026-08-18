// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Unified analyze-image client — single multimodal call into Plexo Core's
// POST /api/v1/vision/analyze-image. Collapses the legacy 5-LLM-call chain
// (plexoClassifyAsset + labelImageUrl + plexoVisionOcr + plexoDescribeImage
// + plexoSuggestTags) into ONE call returning a structured JSON payload.
//
// See ADR 0002 (workspace fonto-taxonomy-standard/0002-analyze-image-api.md).
//
// Lives separately from `lib/plexo.ts` and `lib/plexo-vision.ts` so the
// rollout can be feature-flagged without touching either of the legacy
// surfaces. Once the unified path is the default, this module can be
// folded into `lib/plexo.ts` and the legacy helpers retired.
//
// We call the endpoint directly via fetch — same pattern as plexo-vision.ts
// — instead of going through @joeybuilt/plexo-sdk because the SDK is
// pinned to 1.1.0 in this repo and bumping it is a separate ops step.
// When/if the SDK is updated to 1.5.0+ we can switch this module over.

const ANALYZE_TIMEOUT_MS = 180_000;

export interface AnalyzeImageHints {
  topClipClass?: string;
  clipConfidence?: number;
  cameraMake?: string;
  hasExposureExif?: boolean;
  widthPx?: number;
  heightPx?: number;
}

export interface AnalyzeImageOptions {
  workspaceId: string;
  imageUrl: string;
  mimeType?: string;
  filename?: string;
  hints?: AnalyzeImageHints;
}

export interface AnalyzeImageResult {
  classification: string;
  subClassification: string | null;
  confidence: number;
  description: string;
  ocrText: string | null;
  labels: string[];
  suggestedTags: string[];
  model: string;
  latencyMs: number;
}

/**
 * Returns true iff the unified path is enabled AND Plexo Core is reachable.
 * Worker callers branch on this *before* swapping in `analyzeImageUnified`
 * so a missing env doesn't silently fall through to a broken call.
 */
export function unifiedAnalyzeEnabled(): boolean {
  const flag = process.env.USE_UNIFIED_ANALYZE;
  if (flag !== "1" && flag !== "true") return false;
  return Boolean(process.env.PLEXO_URL && process.env.PLEXO_SERVICE_KEY);
}

/**
 * Call Plexo Core's unified analyze-image endpoint. Throws on any failure
 * so the caller can decide whether to fall back to the legacy 5-call chain.
 *
 * No silent error-swallowing — the worker's per-asset try/catch is the
 * right place to record + retry.
 */
export async function analyzeImageUnified(
  opts: AnalyzeImageOptions,
): Promise<AnalyzeImageResult> {
  const plexoUrl = process.env.PLEXO_URL;
  const serviceKey = process.env.PLEXO_SERVICE_KEY;
  if (!plexoUrl || !serviceKey) {
    throw new Error(
      "plexo-analyze: PLEXO_URL and PLEXO_SERVICE_KEY must be set",
    );
  }

  const url = plexoUrl.replace(/\/+$/, "") + "/api/v1/vision/analyze-image";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${serviceKey}`,
        "X-App-Id": "fonto",
        "X-Service-Key-Version": "v1",
        "X-Workspace-Id": opts.workspaceId,
      },
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        imageUrl: opts.imageUrl,
        mimeType: opts.mimeType,
        filename: opts.filename,
        hints: opts.hints,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `plexo analyze-image HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await res.json()) as Partial<AnalyzeImageResult>;
    return {
      classification:
        typeof data.classification === "string" ? data.classification : "photo",
      subClassification:
        typeof data.subClassification === "string"
          ? data.subClassification
          : null,
      confidence:
        typeof data.confidence === "number" ? data.confidence : 0,
      description: typeof data.description === "string" ? data.description : "",
      ocrText: typeof data.ocrText === "string" ? data.ocrText : null,
      labels: Array.isArray(data.labels)
        ? data.labels.filter((s): s is string => typeof s === "string")
        : [],
      suggestedTags: Array.isArray(data.suggestedTags)
        ? data.suggestedTags.filter((s): s is string => typeof s === "string")
        : [],
      model: typeof data.model === "string" ? data.model : "unknown",
      latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
