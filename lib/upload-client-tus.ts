// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1.4 — browser-side tus uploader.
//
// Wraps `tus-js-client` with the bits Fonto cares about: localStorage-backed
// resume across reloads, an 8MB chunk size to match what R2 multipart wants,
// and an `assetId` returned from `onUploadFinish` so the calling component
// can immediately deep-link to the new asset.

import * as tus from "tus-js-client";

/** Same path the server is mounted at. */
const TUS_ENDPOINT = "/api/v1/uploads/tus";

/** Match the server's PART_SIZE_BYTES default (see lib/tus/server.ts). */
const CHUNK_SIZE = 8 * 1024 * 1024;

export type UploadTusOptions = {
  /** 0..1 progress callback. */
  onProgress?: (loaded: number, total: number) => void;
  /** Override the chunk size (bytes). Defaults to 8MiB. */
  chunkSize?: number;
  /** Extra metadata key/value pairs forwarded to the server. */
  metadata?: Record<string, string>;
  /** Abort signal — calls `upload.abort()` when fired. */
  signal?: AbortSignal;
};

export type UploadTusResult = {
  assetId: string;
  /** Final tus upload URL — handy for debugging / receipt printing. */
  uploadUrl: string;
};

/**
 * Upload a single File to the tus endpoint. Resolves with the newly minted
 * `assetId` once the server has assembled the multipart upload, copied it
 * to the canonical R2 key, and inserted the `assets` row.
 *
 * Resumes automatically if a previous upload of the same file (matched by
 * fingerprint) is found in localStorage.
 */
export function uploadTus(
  file: File,
  options: UploadTusOptions = {}
): Promise<UploadTusResult> {
  const { onProgress, chunkSize = CHUNK_SIZE, metadata = {}, signal } = options;

  return new Promise((resolve, reject) => {
    let assetId: string | null = null;

    const upload = new tus.Upload(file, {
      endpoint: TUS_ENDPOINT,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      chunkSize,
      // Use the default URL-storage so resume works across page reloads.
      // tus-js-client picks the right backend for the platform automatically.
      metadata: {
        filename: file.name,
        filetype: file.type || "application/octet-stream",
        ...metadata,
      },
      // tus-js-client posts the size in Upload-Length; this is required
      // because the server explicitly rejects deferred-length uploads.
      uploadDataDuringCreation: false,
      onError(error) {
        reject(error);
      },
      onProgress(bytesUploaded, bytesTotal) {
        if (onProgress) onProgress(bytesUploaded, bytesTotal);
      },
      onAfterResponse(_req, res) {
        // Server stamps `X-Fonto-Asset-Id` on the final PATCH/HEAD response
        // once `onUploadFinish` has materialized the asset row. We read it
        // here so it's available the moment `onSuccess` fires.
        try {
          const fromHeader = res.getHeader("x-fonto-asset-id");
          if (fromHeader) assetId = String(fromHeader);
        } catch {
          // Header read failures aren't fatal — onSuccess will still fire
          // and we'll reject if assetId is still null.
        }
      },
      onSuccess() {
        if (!assetId) {
          reject(new Error("Upload succeeded but server did not return asset id"));
          return;
        }
        resolve({ assetId, uploadUrl: upload.url ?? "" });
      },
    });

    // Resume from a prior interrupted upload if tus-js-client recognizes
    // the file fingerprint. Falls through to `start()` if no resume.
    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) {
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }
      upload.start();
    });

    if (signal) {
      const onAbort = () => {
        try {
          upload.abort();
        } catch {
          /* ignore */
        }
        reject(new DOMException("Upload aborted", "AbortError"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
