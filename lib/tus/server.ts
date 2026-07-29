// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.4: resumable / chunked upload server backed by tus.
//
// Today the regular POST /api/v1/assets path caps uploads at 50MB and a
// dropped connection kills the transfer. This module wraps `@tus/server`
// with `@tus/s3-store` pointed at the same Cloudflare R2 bucket the rest of
// Fonto uses, exposes the tus protocol at `/api/v1/uploads/tus`, and on
// completion materializes a `fonto.assets` row + R2 object at the canonical
// `fonto/{workspaceId}/{assetId}/{filename}` key so the downstream
// processing pipeline is unchanged.
//
// The route handler at `app/api/v1/uploads/tus/[...path]/route.ts` bridges
// the App Router's standard Request/Response to tus via `server.handleWeb`,
// which @tus/server v2 exposes natively — no Node http adapter required.

import { randomUUID } from "crypto";
import { Server } from "@tus/server";
import { S3Store } from "@tus/s3-store";
import { headers } from "next/headers";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { createAssetRow } from "@/lib/assets/createAssetRow";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────

/** Public route the tus protocol is mounted at. */
export const TUS_PATH = "/api/v1/uploads/tus";

/** S3 multipart part size; can be tuned via env without touching code. */
const PART_SIZE_BYTES = Number(process.env.TUS_PART_SIZE_BYTES) || 8 * 1024 * 1024;

/** Max accepted file size; default 10GB, override via env. */
const MAX_FILE_SIZE_BYTES = Number(process.env.TUS_MAX_FILE_SIZE_BYTES) || 10 * 1024 * 1024 * 1024;

/**
 * Temp prefix the S3 store writes parts + the final assembled object under.
 * Once tus completes the multipart upload we server-side copy this object
 * to its canonical `fonto/{ws}/{assetId}/{filename}` key and delete the temp.
 */
const TUS_TEMP_PREFIX = "fonto/tus";

/**
 * Build an Error that tus surfaces as the chosen HTTP status code + body.
 * Throwing this from `onUploadCreate` / `onUploadFinish` is how the server
 * communicates rejection — keeping it in one helper avoids spraying
 * @ts-expect-error annotations everywhere we need to attach status/body.
 */
function tusReject(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { status_code: number; body: string };
  err.status_code = statusCode;
  err.body = JSON.stringify({ error: message });
  return err;
}

// ─────────────────────────────────────────────────────────────────────────
// Singleton — @tus/server is heavy (opens S3 client, attaches event emitter).
// Build once per process; subsequent App Router requests reuse the instance.
// ─────────────────────────────────────────────────────────────────────────

let _server: Server | null = null;

export function getTusServer(): Server {
  if (_server) return _server;

  // @tus/s3-store ships its own pinned @aws-sdk/client-s3, which TypeScript
  // sees as a structurally-different (but functionally identical) version
  // from the one Fonto's `lib/r2.ts` uses. Cast to `any` to bypass the
  // duplicated-type-graph noise — the runtime config shape is identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s3ClientConfig: any = {
    endpoint: process.env.R2_ENDPOINT,
    region: "auto",
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
    // R2's S3 surface speaks multipart, but it does NOT support the default
    // bucket-virtual-host addressing the AWS SDK uses by default.
    forcePathStyle: true,
    bucket: process.env.R2_BUCKET ?? "",
  };

  const datastore = new S3Store({
    partSize: PART_SIZE_BYTES,
    s3ClientConfig,
  });

  _server = new Server({
    path: TUS_PATH,
    datastore,
    respectForwardedHeaders: true,
    maxSize: MAX_FILE_SIZE_BYTES,
    // Set sane CORS expose headers. The route wrapper layers on its own
    // CORS handling for OPTIONS — see `adapter.ts`.
    allowedHeaders: [
      "Authorization",
      "X-Requested-With",
      "Tus-Resumable",
      "Upload-Length",
      "Upload-Offset",
      "Upload-Metadata",
      "Upload-Defer-Length",
      "Upload-Concat",
      "Content-Type",
    ],
    exposedHeaders: [
      "Location",
      "Upload-Offset",
      "Upload-Length",
      "Tus-Version",
      "Tus-Resumable",
      "Tus-Max-Size",
      "Tus-Extension",
      "Upload-Metadata",
    ],

    /**
     * Validate auth + workspace BEFORE the S3 multipart upload is created.
     * Throwing rejects the POST with the message we attach to the error.
     *
     * The Web Request we get here is the same instance the App Router route
     * handler forwarded — meaning `next/headers` cookies are visible to
     * Better Auth via the standard `headers()` helper.
     */
    async onUploadCreate(_req, upload) {
      const user = await getAuthUser();
      if (!user) {
        throw tusReject(401, "Unauthorized");
      }

      const workspaces = await getUserWorkspaces(user.id);
      if (!workspaces.length) {
        throw tusReject(400, "No workspace found");
      }
      const workspaceId = workspaces[0].id;

      // M9 — quota preflight, matching the /assets/init + multipart paths.
      // Reject the upload BEFORE the multipart is created so an over-quota
      // large file never streams a single byte. NULL quota = unlimited.
      if (upload.size != null) {
        const [ws] = await db
          .select({
            quotaBytes: schema.workspaces.quotaBytes,
            usageBytes: schema.workspaces.usageBytes,
          })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId))
          .limit(1);
        if (ws?.quotaBytes != null && (ws.usageBytes ?? 0) + upload.size > ws.quotaBytes) {
          throw tusReject(413, "Storage quota exceeded");
        }
      }

      // tus-js-client encodes Upload-Metadata as base64-decoded key/value
      // pairs. We expect at least `filename` and `filetype` (the standard
      // tus-js-client defaults). Anything else (e.g. `source`) is optional.
      const metadata = upload.metadata ?? {};
      const filename = metadata.filename ?? "upload.bin";
      const mimeType = metadata.filetype ?? "application/octet-stream";

      // Record the open upload so we can recover state if the client comes
      // back with the same upload-id on a different process.
      try {
        await db
          .insert(schema.tusUploads)
          .values({
            uploadId: upload.id,
            userId: user.id,
            workspaceId,
            filename,
            mimeType,
            sizeBytes: upload.size ?? null,
            state: "open",
          })
          .onConflictDoNothing();
      } catch (err) {
        console.error("[fonto-tus] failed to record tus upload row:", err);
      }

      // Phase 3.5 — folder path. `tus-js-client` exposes `metadata` as a flat
      // string-keyed object; we accept `path` (preferred) and also tolerate
      // `directoryPath` for clients that pick the longer name. Run through
      // the shared normaliser so the column matches what /init writes.
      const rawPath = metadata.path ?? metadata.directoryPath ?? null;
      const directoryPath = normalizeDirectoryPath(rawPath, { filename });

      // Attach the resolved identity back onto the upload's metadata so it
      // survives across PATCH chunks and is visible inside onUploadFinish.
      // S3Store persists this on the multipart upload's metadata field.
      return {
        metadata: {
          ...metadata,
          filename,
          filetype: mimeType,
          userId: user.id,
          workspaceId,
          // Stash the normalised value back into metadata so onUploadFinish
          // doesn't have to re-derive (or re-trust the client). Empty string
          // sentinels `null` since metadata values are stringy.
          directoryPath: directoryPath ?? "",
        },
      };
    },

    /**
     * tus signals completion AFTER the multipart upload is assembled in R2
     * under the tus temp key. We:
     *   1. Materialize a `fonto.assets` row (stub helper — Phase 1.2 owns
     *      the canonical createAssetRow).
     *   2. CopyObject the temp R2 object to the canonical asset key.
     *   3. Best-effort delete the temp object + tus .info sidecar.
     *   4. Enqueue the processing pipeline so OCR / classify / thumbnails
     *      fire just like the regular upload path.
     *
     * The response body we return here is what the tus client sees on its
     * final HEAD — we set Upload-Metadata so `tus-js-client` exposes the
     * resulting assetId through its onAfterResponse hook.
     */
    async onUploadFinish(_req, upload) {
      const metadata = upload.metadata ?? {};
      const userId = metadata.userId;
      const workspaceId = metadata.workspaceId;
      const filename = metadata.filename ?? "upload.bin";
      const mimeType = metadata.filetype ?? "application/octet-stream";
      // Phase 3.5 — onUploadCreate stashed the normalised path here (or ""
      // for "no folder"). Coerce the empty-string sentinel back to null.
      const directoryPath =
        metadata.directoryPath && metadata.directoryPath.length > 0
          ? metadata.directoryPath
          : null;

      if (!userId || !workspaceId) {
        throw tusReject(500, "Upload finalize failed: missing identity metadata");
      }

      // M9 — funnel tus uploads through the SAME shared helper as the legacy
      // multipart + presigned-PUT paths, so dedup (real SHA-256), EXIF/pHash,
      // scope, activity/webhook events, and the full processing enqueue all
      // behave identically. createAssetRow needs (a) the bytes in memory and
      // (b) the object already at its canonical key (it does not move R2
      // objects). So we mirror the presigned-PUT contract: pre-reserve the
      // asset id, copy temp→canonical, then insert with preReservedId.
      const tempKey = upload.storage?.path ?? `${TUS_TEMP_PREFIX}/${upload.id}`;

      let buffer: Buffer;
      try {
        buffer = await storage().getBuffer(tempKey);
      } catch (err) {
        console.error("[fonto-tus] failed to read assembled tus object:", err);
        throw tusReject(500, "Failed to finalize upload");
      }

      const reservedId = randomUUID();
      const finalKey = assetStorageKey(workspaceId, reservedId, filename);
      try {
        await storage().copy(tempKey, finalKey, { contentType: mimeType });
      } catch (err) {
        console.error("[fonto-tus] failed to move object to final key:", err);
        throw tusReject(500, "Failed to finalize upload");
      }

      let result;
      try {
        result = await createAssetRow({
          workspaceId,
          userId,
          filename,
          mimeType,
          sizeBytes: upload.size ?? buffer.length,
          buffer,
          source: "tus",
          directoryPath,
          preReservedId: reservedId,
        });
      } catch (err) {
        console.error("[fonto-tus] createAssetRow failed:", err);
        // Roll back the canonical copy we just made so we don't orphan bytes.
        await storage().delete(finalKey).catch(() => {});
        throw tusReject(500, "Failed to finalize upload");
      }
      const asset = result.asset;

      // On SHA-256 dedup createAssetRow returns the EXISTING row and ignores
      // preReservedId — so the canonical copy we made under reservedId is an
      // orphan. Drop it (and always drop the tus temp object + .info sidecar).
      const cleanup: Promise<unknown>[] = [
        storage().delete(tempKey).catch(() => {}),
        storage().delete(`${tempKey}.info`).catch(() => {}),
      ];
      if (result.deduplicated && asset.id !== reservedId) {
        cleanup.push(storage().delete(finalKey).catch(() => {}));
      }
      await Promise.allSettled(cleanup);

      // Mark the tus_uploads row completed so a subsequent HEAD can find
      // the asset id. (Best-effort — a missing row just means the original
      // create-side insert failed and we still want to ship the asset.)
      try {
        await db
          .update(schema.tusUploads)
          .set({ state: "completed", assetId: asset.id, completedAt: new Date() })
          .where(eq(schema.tusUploads.uploadId, upload.id));
      } catch (err) {
        console.error("[fonto-tus] failed to mark tus_uploads completed:", err);
      }

      // tus's HEAD response normally has no body. We surface the new asset
      // id through Upload-Metadata so `tus-js-client`'s `onAfterResponse`
      // hook can expose it to the caller of `uploadTus`.
      const responseMetadata = `assetId ${Buffer.from(asset.id).toString("base64")}`;
      return {
        status_code: 200,
        headers: {
          "Upload-Metadata": responseMetadata,
          "X-Fonto-Asset-Id": asset.id,
        },
        body: JSON.stringify({ assetId: asset.id }),
      };
    },
  });

  return _server;
}

/**
 * Re-export so route.ts can hand a Web Request straight to the server
 * without depending on @tus/server's internals.
 */
export async function handleTusRequest(request: Request): Promise<Response> {
  // Ensure cookies/headers flow through next/headers for the auth check
  // inside onUploadCreate. Calling `headers()` here is enough to bind the
  // App Router request scope for downstream `await headers()` calls.
  await headers();
  return getTusServer().handleWeb(request);
}
