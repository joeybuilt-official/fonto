// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (media import) — POST /api/v1/imports/upload
//
// Streaming upload endpoint for an export ZIP the user downloaded. Default
// provider is `amazon-photos` (EXIF-only); pass `?provider=google-takeout` for
// a downloaded Takeout archive so the worker applies its sidecar JSON metadata
// (dates/geo/albums). Either way we hand the worker a local ZIP path
// (uploadTmpPath) and runImport walks it.
//
// Transport: a raw `application/zip` request body (NOT multipart/form-data).
// Rationale — the body is piped straight to a temp file via a Node stream, so
// peak RAM is bounded by one chunk regardless of archive size (multi-GB safe).
// multipart parsing would either pull in a buffering library or require manual
// boundary handling for a single file field; a raw body is the simplest
// streaming-safe contract, and the Phase 4/5 UI will POST the file's bytes as
// the request body with Content-Type: application/zip.
//
// Flow:
//  1. Authenticate (getAuthUser) + resolve workspace (getUserWorkspaces),
//     mirroring app/api/v1/imports/google/route.ts.
//  2. Stream req.body → os.tmpdir()/fonto-import-<uuid>.zip, counting bytes and
//     aborting (+ unlinking) if the total exceeds MAX_IMPORT_ZIP_BYTES.
//  3. Sniff the first bytes for the ZIP magic (PK\x03\x04); reject + unlink if
//     it isn't a ZIP.
//  4. Insert a `pending` import_jobs row (provider='amazon-photos').
//  5. tryEnqueueImport({ ..., provider:'amazon-photos', uploadTmpPath }).
//  6. Return { importJobId }. runImport unlinks uploadTmpPath in its finally.
//
// On any error after the temp file is opened we unlink it so a failed upload
// never leaks a partial ZIP into the temp dir.
export const dynamic = "force-dynamic";
// The streamed body can be large; keep this on the Node.js runtime (not Edge)
// so node:fs / node:stream are available.
export const runtime = "nodejs";

import { createWriteStream } from "node:fs";
import { open as fsOpen, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { tryEnqueueImport } from "@/lib/queue/queues";
import { logger } from "@/lib/logger";

/** Default ceiling for an uploaded ZIP: 5 GiB. Override via MAX_IMPORT_ZIP_BYTES. */
const DEFAULT_MAX_IMPORT_ZIP_BYTES = 5 * 1024 * 1024 * 1024;

function maxImportZipBytes(): number {
  const raw = process.env.MAX_IMPORT_ZIP_BYTES;
  if (!raw) return DEFAULT_MAX_IMPORT_ZIP_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMPORT_ZIP_BYTES;
}

/** Thrown to abort the stream pipe once the byte budget is exceeded. */
class UploadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Upload exceeds the ${limit}-byte limit`);
    this.name = "UploadTooLargeError";
  }
}

/** First-4-bytes ZIP local-file-header magic check (PK\x03\x04). */
async function fileLooksLikeZip(path: string): Promise<boolean> {
  const fh = await fsOpen(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    // "PK" prefix covers the local-file-header (03 04), empty-archive (05 06)
    // and spanned (07 08) signatures; yauzl reads the central directory anyway.
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } finally {
    await fh.close();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const log = logger.child({ component: "import.upload" });

  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }
  // Optional ?workspaceId= selector (query param, since the body is the ZIP).
  const requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId");
  const workspace = requestedWorkspaceId
    ? workspaces.find((w) => w.id === requestedWorkspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // Optional ?provider= — a Google Takeout archive the user downloaded and
  // uploaded gets tagged `google-takeout` so the worker applies its sidecar
  // metadata (dates/geo/albums). Anything else falls back to Amazon (EXIF-only).
  const provider =
    request.nextUrl.searchParams.get("provider") === "google-takeout"
      ? "google-takeout"
      : "amazon-photos";

  if (!request.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const limit = maxImportZipBytes();
  const tmpPath = join(tmpdir(), `fonto-import-${randomUUID()}.zip`);

  // Stream the body straight to disk. A Transform-free byte counter wired into
  // the pipeline aborts the moment we cross the limit; pipeline() then rejects
  // and the catch below unlinks the partial file.
  let bytes = 0;
  const nodeBody = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
  const out = createWriteStream(tmpPath);

  try {
    await pipeline(nodeBody, async function* (source) {
      for await (const chunk of source) {
        bytes += (chunk as Buffer).length;
        if (bytes > limit) throw new UploadTooLargeError(limit);
        yield chunk;
      }
    }, out);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json(
        { error: `Upload exceeds the maximum allowed size (${limit} bytes)` },
        { status: 413 },
      );
    }
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "import upload stream failed",
    );
    return NextResponse.json({ error: "Upload failed" }, { status: 400 });
  }

  if (bytes === 0) {
    await unlink(tmpPath).catch(() => undefined);
    return NextResponse.json({ error: "Empty upload" }, { status: 400 });
  }

  if (!(await fileLooksLikeZip(tmpPath))) {
    await unlink(tmpPath).catch(() => undefined);
    return NextResponse.json(
      { error: "Uploaded file is not a ZIP archive" },
      { status: 400 },
    );
  }

  // Persist + enqueue. If either step throws, unlink the temp file (the worker
  // never received the path, so nothing else will clean it up).
  try {
    const [row] = await db
      .insert(schema.importJobs)
      .values({
        workspaceId: workspace.id,
        userId: user.id,
        provider,
        status: "pending",
      })
      .returning({ id: schema.importJobs.id });

    await tryEnqueueImport({
      importJobId: row.id,
      workspaceId: workspace.id,
      userId: user.id,
      provider,
      uploadTmpPath: tmpPath,
    });

    log.info(
      { importJobId: row.id, workspaceId: workspace.id, bytes, provider },
      "uploaded import enqueued",
    );
    return NextResponse.json({ importJobId: row.id }, { status: 202 });
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "failed to enqueue import after upload",
    );
    return NextResponse.json({ error: "Failed to start import" }, { status: 500 });
  }
}
