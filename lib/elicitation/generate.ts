// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 5.5. Generate the highest-information-value
// questions for a workspace. MVP taxonomy:
//
//   confirm_date — a date inference the gate sent to `review` (mid-confidence or
//                  in conflict with the stored date). Answer sharpens one asset.
//   birth_year   — a NAMED person with no birth anchor who appears in many
//                  photos. A birth year unlocks identity_bound date evidence
//                  across every photo they're in — high leverage.
//
// Ranking (info_value, 0..1): confirm_date ∝ uncertainty (1 - confidence);
// birth_year ∝ how many photos the anchor would touch (instanceCount, squashed).
//
// Idempotent: a regenerate DELETES the open rows of these kinds and re-inserts
// the fresh ranked set. Answered/dismissed rows are preserved.

import { and, desc, eq, gte, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { DEFAULT_GATE_THRESHOLDS } from "@/lib/fusion/gate";
import { logger } from "@/lib/logger";

const DATE_HIGH = DEFAULT_GATE_THRESHOLDS.date.high;
const DATE_LOW = DEFAULT_GATE_THRESHOLDS.date.low;
const CONFIRM_DATE_LIMIT = 100;
const BIRTH_YEAR_LIMIT = 50;
const BIRTH_YEAR_MIN_FACES = 3;

interface NewQuestion {
  workspaceId: string;
  kind: "confirm_date" | "birth_year";
  targetType: "asset" | "person";
  targetId: string;
  prompt: string;
  payload: Record<string, unknown>;
  infoValue: number;
}

export async function generateElicitationQuestions(workspaceId: string): Promise<{ generated: number }> {
  const log = logger.child({ component: "elicitation.generate", workspaceId });
  const questions: NewQuestion[] = [];

  // confirm_date — review-band inferences.
  const dateRows = await db
    .select({
      assetId: schema.imageDateInference.assetId,
      mapEstimate: schema.imageDateInference.mapEstimate,
      mapPrecision: schema.imageDateInference.mapPrecision,
      confidence: schema.imageDateInference.confidence,
      conflictFlag: schema.imageDateInference.conflictFlag,
    })
    .from(schema.imageDateInference)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.imageDateInference.assetId))
    .where(
      and(
        eq(schema.assets.workspaceId, workspaceId),
        eq(schema.assets.lifecycleState, "active"),
        eq(schema.imageDateInference.status, "inferred"),
        or(
          eq(schema.imageDateInference.conflictFlag, true),
          and(
            gte(schema.imageDateInference.confidence, DATE_LOW),
            lt(schema.imageDateInference.confidence, DATE_HIGH)
          )
        )
      )
    )
    .orderBy(desc(schema.imageDateInference.conflictFlag), schema.imageDateInference.confidence)
    .limit(CONFIRM_DATE_LIMIT);

  for (const r of dateRows) {
    if (!r.mapEstimate) continue;
    const proposed = String(r.mapEstimate).slice(0, r.mapPrecision === "year" ? 4 : r.mapPrecision === "month" ? 7 : 10);
    questions.push({
      workspaceId,
      kind: "confirm_date",
      targetType: "asset",
      targetId: r.assetId,
      prompt: `Is this photo from ${proposed}?`,
      payload: { proposedDate: String(r.mapEstimate), precision: r.mapPrecision, conflict: r.conflictFlag },
      // Conflicts are maximally valuable; otherwise uncertainty drives value.
      infoValue: r.conflictFlag ? 0.95 : Math.min(0.9, 1 - r.confidence),
    });
  }

  // birth_year — named persons with no birth anchor + enough photos to matter.
  const persons = await db
    .select({ id: schema.persons.id, name: schema.persons.name, instanceCount: schema.persons.instanceCount })
    .from(schema.persons)
    .where(
      and(
        eq(schema.persons.workspaceId, workspaceId),
        eq(schema.persons.hidden, false),
        isNotNull(schema.persons.name),
        isNull(schema.persons.birthDate),
        gte(schema.persons.instanceCount, BIRTH_YEAR_MIN_FACES)
      )
    )
    .orderBy(desc(schema.persons.instanceCount))
    .limit(BIRTH_YEAR_LIMIT);

  for (const p of persons) {
    questions.push({
      workspaceId,
      kind: "birth_year",
      targetType: "person",
      targetId: p.id,
      prompt: `What year was ${p.name} born?`,
      payload: { personName: p.name, instanceCount: p.instanceCount },
      // Squash count → 0..1; a person in 50+ photos anchors a lot.
      infoValue: Math.min(0.99, (p.instanceCount ?? 0) / (p.instanceCount + 25)),
    });
  }

  // Replace the open set of these kinds, preserving answered/dismissed history.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.elicitationQuestions)
      .where(
        and(
          eq(schema.elicitationQuestions.workspaceId, workspaceId),
          eq(schema.elicitationQuestions.status, "open"),
          sql`${schema.elicitationQuestions.kind} in ('confirm_date','birth_year')`
        )
      );
    if (questions.length > 0) {
      await tx.insert(schema.elicitationQuestions).values(questions);
    }
  });

  log.info({ generated: questions.length }, "elicitation questions generated");
  return { generated: questions.length };
}
