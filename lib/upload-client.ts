// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Client-side helper for the direct-to-R2 upload flow (Phase 1.2).
//
//   await uploadDirect(file, { source: "drag-drop", onProgress })
//     1. POST /api/v1/assets/init       → presigned PUT URL
//     2. PUT  <presignedUrl>            → body goes straight to R2 (XHR for progress)
//     3. POST /api/v1/assets/:id/complete → server finalizes the asset row
//
// Returns the same shape the legacy multipart POST returns
// (`{ asset, possibleDuplicate?, deduplicated? }`) so call-sites can swap
// paths under a feature flag without otherwise changing.
//
// This module is browser-only (uses XMLHttpRequest); do NOT import from
// server code.

export interface DirectUploadAsset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  // The asset row shape is broader than we need to enumerate here — the
  // dashboard treats it as an opaque server-returned object.
  [key: string]: unknown;
}

export interface DirectUploadResult {
  asset: DirectUploadAsset;
  deduplicated?: boolean;
  possibleDuplicate?: {
    assetId: string;
    filename: string;
    capturedAt: string | null;
    createdAt: string;
    /** Hamming distance for pHash matches, cosine similarity for CLIP. */
    distance: number;
    thumbUrl: string;
    // Phase 4.5 — discriminates the detection path so the UI can vary
    // wording ("Near-duplicate" vs "Visually similar") and confidence
    // can drive banner styling. Optional for back-compat with older
    // servers that haven't shipped Phase 4.5 yet.
    method?: "phash" | "clip";
    confidence?: "high" | "medium" | "low";
  };
}

export interface UploadDirectOptions {
  /** Free-form source label (`"web-upload"`, `"drag-drop"`, etc.). */
  source?: string;
  /** Called with 0..1 progress as the body is uploaded to R2. */
  onProgress?: (fraction: number) => void;
  /** AbortSignal — cancels the XHR PUT mid-flight. */
  signal?: AbortSignal;
}

interface InitResponse {
  uploadId: string;
  presignedUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
  expiresIn: number;
  storageKey: string;
}

/**
 * Whether the client should use the direct-to-R2 path. Reads
 * NEXT_PUBLIC_DIRECT_UPLOAD ("true"/"1" → enabled). Defaults to disabled so
 * we can ship the route without flipping the upload UI behavior.
 */
export function directUploadEnabled(): boolean {
  const v = (process.env.NEXT_PUBLIC_DIRECT_UPLOAD ?? "").toLowerCase();
  return v === "1" || v === "true";
}

async function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress?: (n: number) => void,
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(1);
        resolve();
      } else {
        reject(new Error(`R2 PUT failed: ${xhr.status} ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("R2 PUT network error"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

/**
 * Compute a SHA-256 hex digest of a Blob using the WebCrypto subtle API. Used
 * only when SKIP_SERVER_CHECKSUM is enabled on the server — if the client
 * sends a hash, the server trusts it.
 */
async function computeClientChecksum(file: Blob): Promise<string | undefined> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return undefined;
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

/**
 * Upload a File directly to R2 using the presigned-PUT flow. Returns the same
 * `{ asset, possibleDuplicate? }` shape as the legacy multipart endpoint.
 */
export async function uploadDirect(
  file: File,
  opts: UploadDirectOptions = {}
): Promise<DirectUploadResult> {
  // Step 1: ask the server for a presigned URL.
  // Client-side checksum is opt-in (cheap on small files, slow on huge ones)
  // — we just skip it if the file is over 100 MB.
  const clientChecksum =
    file.size < 100 * 1024 * 1024 ? await computeClientChecksum(file) : undefined;

  const initRes = await fetch("/api/v1/assets/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      clientChecksum,
    }),
    signal: opts.signal,
  });
  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({}));
    throw new Error(err?.error ?? `Init failed: ${initRes.status}`);
  }
  const init = (await initRes.json()) as InitResponse;

  // Step 2: stream the body straight to R2 (no Next.js hop).
  await putWithProgress(init.presignedUrl, file, init.headers, opts.onProgress, opts.signal);

  // Step 3: tell the server to finalize.
  const completeRes = await fetch(`/api/v1/assets/${init.uploadId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId, source: opts.source }),
    signal: opts.signal,
  });
  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({}));
    throw new Error(err?.error ?? `Complete failed: ${completeRes.status}`);
  }
  return (await completeRes.json()) as DirectUploadResult;
}
