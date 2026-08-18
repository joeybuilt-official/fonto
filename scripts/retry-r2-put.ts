// SPDX-License-Identifier: MIT
// One-shot — re-PUT the bytes for assets whose row exists but whose R2 upload
// failed (sync_state='error'), then flip them back to 'synced'. Pair with
// reprocess-one.ts to re-enqueue processing.
//
// Source path is reconstructed from the asset's own directory_path + filename
// (joined under --root) so we never have to pass space-bearing paths on argv.
// Args: --root=/import  --id=<uuid> [--id=<uuid> ...]
import fsp from "node:fs/promises";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import path from "node:path";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { detectMime } from "@/lib/mime";
import { getS3Client as getR2Client, assetStorageKey } from "@/lib/r2";

async function main(): Promise<void> {
  const root =
    process.argv.find((a) => a.startsWith("--root="))?.slice("--root=".length) ??
    "/import";
  const ids = process.argv
    .filter((a) => a.startsWith("--id="))
    .map((a) => a.slice("--id=".length));
  if (ids.length === 0) throw new Error("need at least one --id=<uuid>");

  const r2 = getR2Client();
  const bucket = process.env.R2_BUCKET!;

  for (const id of ids) {
    const [row] = await db
      .select({
        id: schema.assets.id,
        workspaceId: schema.assets.workspaceId,
        filename: schema.assets.filename,
        directoryPath: schema.assets.directoryPath,
      })
      .from(schema.assets)
      .where(eq(schema.assets.id, id))
      .limit(1);
    if (!row) {
      console.error(`[retry-r2-put] skip ${id} — row not found`);
      continue;
    }
    const relDir = (row.directoryPath ?? "").replace(/^\/+/, "");
    const file = path.join(root, relDir, row.filename);
    const buf = await fsp.readFile(file);
    const { mimeType } = await detectMime(buf, "", row.filename);
    const key = assetStorageKey(row.workspaceId, row.id, row.filename);
    await r2.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buf,
        ContentType: mimeType,
        ContentLength: buf.length,
      })
    );
    await db
      .update(schema.assets)
      .set({ syncState: "synced" })
      .where(eq(schema.assets.id, row.id));
    console.log(`[retry-r2-put] ok ${row.id} ${key} ${buf.length}B ${mimeType}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[retry-r2-put] fatal:", err);
    process.exit(1);
  });
