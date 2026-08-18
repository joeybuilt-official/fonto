// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4. The I/O wrapper around the pure fusion engine:
// read an asset's evidence rows + its stored captured_at, fuse, and UPSERT the
// proposal into fonto.image_date_inference.
//
// PROPOSE-DON'T-OVERWRITE (ADR-0005): this NEVER writes assets.captured_at. It
// also never clobbers a human decision — the upsert's setWhere only refreshes
// rows still in `inferred` status; `confirmed`/`overridden`/`quarantined` rows
// are left exactly as the operator left them.

import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { fuse } from "./fuse";
import type { EvidenceRowInput, EvidenceType, InferenceResult } from "./types";

export interface InferResult {
  assetId: string;
  computed: boolean;
  coldStart: boolean;
  confidence: number;
  conflict: boolean;
}

export async function inferAssetDate(assetId: string): Promise<InferResult> {
  const log = logger.child({ component: "fusion.infer", assetId });

  const [asset] = await db
    .select({ id: schema.assets.id, capturedAt: schema.assets.capturedAt })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);
  if (!asset) {
    log.warn("asset row vanished — skipping inference");
    return { assetId, computed: false, coldStart: false, confidence: 0, conflict: false };
  }

  const evidenceRows = await db
    .select({
      evidenceType: schema.imageDateEvidence.evidenceType,
      sourceDetail: schema.imageDateEvidence.sourceDetail,
      modelVersion: schema.imageDateEvidence.modelVersion,
      createdAt: schema.imageDateEvidence.createdAt,
    })
    .from(schema.imageDateEvidence)
    .where(eq(schema.imageDateEvidence.assetId, assetId));

  const rows: EvidenceRowInput[] = evidenceRows.map((r) => ({
    evidenceType: r.evidenceType as EvidenceType,
    sourceDetail: (r.sourceDetail as Record<string, unknown>) ?? {},
    modelVersion: r.modelVersion,
    createdAt: r.createdAt,
  }));

  const result: InferenceResult = fuse(rows, { storedCapturedAt: asset.capturedAt });

  const setFields = {
    mapEstimate: result.mapEstimate,
    mapPrecision: result.mapPrecision,
    ciLow: result.ciLow,
    ciHigh: result.ciHigh,
    confidence: result.confidence,
    conflictFlag: result.conflictFlag,
    conflictDetail: result.conflictDetail,
    explanation: result.explanation,
    dependsOn: result.dependsOn,
    computedAt: new Date(),
  };

  await db
    .insert(schema.imageDateInference)
    .values({ assetId, status: "inferred", ...setFields })
    .onConflictDoUpdate({
      target: schema.imageDateInference.assetId,
      set: setFields,
      // Re-fuse refreshes only an un-actioned proposal; never overwrite a human
      // confirm/override or a quarantine.
      setWhere: eq(schema.imageDateInference.status, "inferred"),
    });

  log.info(
    { coldStart: result.coldStart, confidence: result.confidence, conflict: result.conflictFlag, map: result.mapEstimate },
    "inference computed"
  );
  return {
    assetId,
    computed: true,
    coldStart: result.coldStart,
    confidence: result.confidence,
    conflict: result.conflictFlag,
  };
}
