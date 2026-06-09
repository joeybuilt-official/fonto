// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (media import) — stream a Google Drive file to disk.
//
// Takeout archives are multi-GB. We never buffer the whole archive in RAM (and
// yauzl needs random access to read the ZIP central directory anyway), so the
// import worker streams the Drive object straight to a temp file and then opens
// that file member-by-member. This module owns the download leg: given a
// fileId + a live access token, it returns a Drive v3 read stream
// (`alt=media`), plus a small helper that drains that stream to a temp path.

import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { google } from "googleapis";

/**
 * Open a streaming read of a Drive file. The OAuth2 client is constructed with
 * just the access token (the worker already minted it via
 * `getFreshAccessToken`), so this never touches the refresh token. Returns the
 * raw `Readable` of the file bytes.
 */
export async function openDriveFileStream(
  fileId: string,
  accessToken: string,
): Promise<Readable> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );
  return res.data as unknown as Readable;
}

/**
 * Fetch the file's name + size (for progress UI + a sanity log) without
 * downloading the bytes. Best-effort: returns null fields on error so a
 * metadata hiccup never blocks the actual download.
 */
export async function getDriveFileMeta(
  fileId: string,
  accessToken: string,
): Promise<{ name: string | null; size: number | null }> {
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: "v3", auth });
    const res = await drive.files.get({
      fileId,
      fields: "name,size",
      supportsAllDrives: true,
    });
    const size = res.data.size != null ? Number(res.data.size) : null;
    return {
      name: res.data.name ?? null,
      size: Number.isFinite(size) ? size : null,
    };
  } catch {
    return { name: null, size: null };
  }
}

/**
 * Stream a Drive file to a fresh temp file and return its path. The caller is
 * responsible for deleting the file (and ideally its parent temp dir) when
 * done — the worker does this eagerly in a `finally`.
 *
 * Uses `stream/promises.pipeline` so backpressure is honoured and the promise
 * rejects (after cleaning up the partial file) on any stream error.
 */
export async function downloadDriveFileToTemp(
  fileId: string,
  accessToken: string,
): Promise<{ tmpPath: string; tmpDir: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "fonto-import-"));
  const tmpPath = join(tmpDir, `${fileId}.zip`);
  const src = await openDriveFileStream(fileId, accessToken);
  const dst = createWriteStream(tmpPath);
  await pipeline(src, dst);
  return { tmpPath, tmpDir };
}
