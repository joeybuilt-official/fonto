// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. Orchestrate the evidence adapters for ONE asset
// and write the resulting rows to `fonto.image_date_evidence`. This is the only
// I/O-bearing piece (DB reads + one optional vision label call); the adapters it
// calls are pure.
//
// Idempotency vs append-only: the ledger is append-only ACROSS model versions
// (a model bump inserts new rows, old ones retained for audit + filtered at
// fusion — ADR-0006). But re-running the SAME version must not pile up
// duplicates, so for each (evidence_type, model_version) produced this run we
// delete-then-insert. Older model_versions are left untouched.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { intelligence } from "@/lib/intelligence/client";
import { logger } from "@/lib/logger";
import type { EvidenceInput, EvidenceType } from "./types";
import {
  identityEvidence,
  exifEvidence,
  filenameEvidence,
  fsMtimeEvidence,
  ocrDateEvidence,
  sceneSeasonEvidence,
  type PersonDateBounds,
} from "./adapters";

export interface ExtractResult {
  assetId: string;
  written: EvidenceType[];
  sceneSeasonSkipped?: string;
}

/**
 * Load the dated persons identified in an asset. Reads non-hidden,
 * person-assigned face instances → their person rows. Persons without
 * birth/death dates are still returned (the artifact lists who was present);
 * `identityEvidence` decides whether any constraint exists.
 */
async function loadPresentPersons(
  assetId: string,
  workspaceId: string
): Promise<PersonDateBounds[]> {
  const faces = await db
    .selectDistinct({ personId: schema.faceInstances.personId })
    .from(schema.faceInstances)
    .where(
      and(
        eq(schema.faceInstances.assetId, assetId),
        eq(schema.faceInstances.hidden, false),
        isNotNull(schema.faceInstances.personId)
      )
    );
  const personIds = faces
    .map((f) => f.personId)
    .filter((p): p is string => !!p);
  if (personIds.length === 0) return [];

  const rows = await db
    .select({
      id: schema.persons.id,
      birthDate: schema.persons.birthDate,
      birthPrecision: schema.persons.birthPrecision,
      deathDate: schema.persons.deathDate,
      deathPrecision: schema.persons.deathPrecision,
    })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.workspaceId, workspaceId),
        inArray(schema.persons.id, personIds)
      )
    );

  return rows.map((r) => ({
    personId: r.id,
    birthDate: r.birthDate,
    birthPrecision: r.birthPrecision,
    deathDate: r.deathDate,
    deathPrecision: r.deathPrecision,
  }));
}

/** Idempotent delete-then-insert per (asset, evidence_type, model_version). */
async function writeEvidence(assetId: string, inputs: EvidenceInput[]): Promise<void> {
  if (inputs.length === 0) return;
  await db.transaction(async (tx) => {
    for (const inp of inputs) {
      await tx
        .delete(schema.imageDateEvidence)
        .where(
          and(
            eq(schema.imageDateEvidence.assetId, assetId),
            eq(schema.imageDateEvidence.evidenceType, inp.evidenceType),
            eq(schema.imageDateEvidence.modelVersion, inp.modelVersion)
          )
        );
      await tx.insert(schema.imageDateEvidence).values({
        assetId,
        evidenceType: inp.evidenceType,
        sourceDetail: inp.sourceDetail,
        modelVersion: inp.modelVersion,
        // likelihood stays NULL — computed by the Phase 4 fusion engine.
      });
    }
  });
}

/**
 * Extract + persist all available date evidence for an asset. Never throws on a
 * silent source: a missing EXIF date, no faces, no OCR text simply yield fewer
 * rows. A vision label failure is caught + reported in `sceneSeasonSkipped`, not
 * fatal. Returns the evidence types written.
 */
export async function extractAssetEvidence(assetId: string): Promise<ExtractResult> {
  const log = logger.child({ component: "evidence.extract", assetId });

  const [asset] = await db
    .select({
      id: schema.assets.id,
      workspaceId: schema.assets.workspaceId,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      previewKey: schema.assets.previewKey,
      exif: schema.assets.exif,
      ocrText: schema.assets.ocrText,
      createdAt: schema.assets.createdAt,
    })
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);

  if (!asset) {
    log.warn("asset row vanished — skipping evidence extraction");
    return { assetId, written: [] };
  }

  const inputs: EvidenceInput[] = [];

  // --- Fonto-local adapters (no network) ---
  const persons = await loadPresentPersons(asset.id, asset.workspaceId);
  const identity = identityEvidence(persons);
  if (identity) inputs.push(identity);

  const exif = exifEvidence(asset.exif as Record<string, unknown> | null);
  if (exif) inputs.push(exif);

  const filename = filenameEvidence(asset.filename);
  if (filename) inputs.push(filename);

  // fs_mtime floor always present (weakest, widest).
  inputs.push(fsMtimeEvidence(asset.createdAt));

  const ocr = ocrDateEvidence(asset.ocrText);
  if (ocr) inputs.push(ocr);

  // --- vision perception adapter (scene_season), gated + non-fatal ---
  let sceneSeasonSkipped: string | undefined;
  if (intelligence.available("label") && asset.mimeType.startsWith("image/")) {
    try {
      const visionKey =
        asset.previewKey ??
        assetStorageKey(asset.workspaceId, asset.id, asset.filename);
      const signedUrl = await storage().presignGet(visionKey, { expiresIn: 300 });
      const base64 = Buffer.from(await (await fetch(signedUrl)).arrayBuffer()).toString("base64");
      const r = await intelligence.label(base64);
      const scene = sceneSeasonEvidence(r.labels.map((l) => l.label), r.modelId);
      if (scene) inputs.push(scene);
      else sceneSeasonSkipped = "no-seasonal-labels";
    } catch (err) {
      sceneSeasonSkipped = err instanceof Error ? err.message : String(err);
      log.warn({ err: sceneSeasonSkipped }, "scene_season extraction failed — skipping");
    }
  } else {
    sceneSeasonSkipped = intelligence.available("label") ? "non-image" : "vision-unconfigured";
  }

  await writeEvidence(asset.id, inputs);

  const written = inputs.map((i) => i.evidenceType);
  log.info({ written, sceneSeasonSkipped }, "evidence extracted");
  return { assetId, written, sceneSeasonSkipped };
}
