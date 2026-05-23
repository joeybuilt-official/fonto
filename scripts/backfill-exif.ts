// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Backfill EXIF / IPTC / XMP metadata for image assets uploaded before
// Phase 0.3 (Fonto → Immich parity) shipped.
//
// Usage:
//   pnpm backfill:exif                   # full pass, batch=100
//   pnpm backfill:exif -- --batch=50     # custom batch size
//   pnpm backfill:exif -- --dry-run      # log decisions, no writes
//
// Idempotent: scopes to rows where `exif IS NULL AND mime_type LIKE 'image/%'`,
// so re-running after a failure picks up where it left off.
//
// Reads DATABASE_URL and R2_* from env.

import postgres from "postgres";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { extractExif } from "../lib/exif";

function arg(name: string): string | true | null {
  const flag = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`)
  );
  if (!flag) return null;
  if (flag.includes("=")) return flag.split("=")[1];
  return true;
}

function s3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: "auto",
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

async function fetchObject(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer> {
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const chunks: Buffer[] = [];
  // AWS SDK v3 streams Body as a Node Readable in Node environments.
  const body = out.Body as AsyncIterable<Uint8Array>;
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

interface AssetRow {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET not set");

  const batchSize = parseInt(String(arg("batch") ?? "100"), 10);
  const dryRun = !!arg("dry-run");

  const sql = postgres(dbUrl, { prepare: false });
  const s3 = s3Client();

  const stats = { tried: 0, ok: 0, skip: 0, fail: 0, withDate: 0, withGps: 0 };

  console.log(
    `[backfill-exif] start (batch=${batchSize}${dryRun ? ", dry-run" : ""})`
  );

  // Loop in workspace-stable order so progress is monotonic and a re-run
  // after Ctrl-C picks up where we left off. We scope to NULL exif so each
  // pass shrinks the working set even without an explicit cursor.
  while (true) {
    const rows = (await sql`
      SELECT id, workspace_id, filename, mime_type
      FROM fonto.assets
      WHERE lifecycle_state = 'active'
        AND mime_type LIKE 'image/%'
        AND exif IS NULL
      ORDER BY created_at DESC
      LIMIT ${batchSize}
    `) as unknown as AssetRow[];

    if (rows.length === 0) break;

    for (const r of rows) {
      stats.tried++;
      const key = `fonto/${r.workspace_id}/${r.id}/${r.filename}`;
      try {
        const buf = await fetchObject(s3, bucket, key);
        const exif = await extractExif(buf, r.mime_type);

        if (exif.raw == null) {
          stats.skip++;
          // Still write a sentinel so we don't reprocess this row on every
          // future run. An empty object is cheap and tells us "we tried".
          if (!dryRun) {
            await sql`
              UPDATE fonto.assets
              SET exif = ${sql.json({})}::jsonb,
                  updated_at = now()
              WHERE id = ${r.id}
            `;
          }
          continue;
        }

        if (exif.capturedAt) stats.withDate++;
        if (exif.latitude != null && exif.longitude != null) stats.withGps++;

        if (dryRun) {
          console.log(
            `[backfill-exif] ${r.id} ${r.filename} → captured=${exif.capturedAt?.toISOString() ?? "-"} gps=${exif.latitude ?? "-"},${exif.longitude ?? "-"} camera=${exif.cameraMake ?? "-"}/${exif.cameraModel ?? "-"}`
          );
          stats.ok++;
          continue;
        }

        await sql`
          UPDATE fonto.assets
          SET exif          = ${sql.json(JSON.parse(JSON.stringify(exif.raw)))}::jsonb,
              captured_at   = COALESCE(${exif.capturedAt ?? null}, captured_at),
              latitude      = ${exif.latitude},
              longitude     = ${exif.longitude},
              camera_make   = ${exif.cameraMake},
              camera_model  = ${exif.cameraModel},
              lens_model    = ${exif.lensModel},
              focal_length  = ${exif.focalLength},
              f_number      = ${exif.fNumber},
              iso           = ${exif.iso},
              exposure_time = ${exif.exposureTime},
              orientation   = ${exif.orientation},
              width_px      = ${exif.widthPx},
              height_px     = ${exif.heightPx},
              updated_at    = now()
          WHERE id = ${r.id}
        `;
        stats.ok++;
      } catch (err) {
        stats.fail++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[backfill-exif] fail ${r.id} (${r.filename}): ${msg}`);
        // Write a sentinel so the row drops out of the next batch's
        // `exif IS NULL` filter and the loop can terminate. Records the
        // failure shape so a later sweep can re-select these explicitly
        // (e.g. WHERE exif ? '_backfill_error').
        if (!dryRun) {
          try {
            await sql`
              UPDATE fonto.assets
              SET exif = ${sql.json({ _backfill_error: msg.slice(0, 200) })}::jsonb,
                  updated_at = now()
              WHERE id = ${r.id}
            `;
          } catch {
            // Best-effort sentinel — if the UPDATE itself fails we still
            // proceed so a single dead row can't strand the whole backfill.
          }
        }
      }
    }

    console.log(
      `[backfill-exif] batch done — ${JSON.stringify(stats)} (last ${rows.length} rows)`
    );
  }

  await sql.end({ timeout: 5 });
  console.log(`[backfill-exif] complete: ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[backfill-exif] fatal:", e);
  process.exit(1);
});
