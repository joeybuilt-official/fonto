// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Storage facade — backend-agnostic interface over asset byte storage.
//
// Phase 1 of the storage-placement initiative (see
// /workspace/.fonto-phased/plan.md Track B). Today the only backend is R2
// (`r2-backend.ts`), wrapping the exact S3 calls that were previously inlined
// at ~20 call sites. A future `local-fs-backend.ts` (Phase B2) implements the
// same surface so a per-workspace policy resolver can pick one.
//
// Key builders stay in `@/lib/r2` (pure path math); this facade owns the
// bucket env + every S3 operation. Method set is derived from the real call
// sites — buffered + streamed reads, GET/PUT presigns, cache-controlled puts,
// HEAD stat (throws on miss, like the SDK), copy (tus temp→canonical), and
// single / batch / prefix deletes.

import type { Readable } from "stream";

export interface PutOptions {
  contentType: string;
  /** Content-Length to declare. Omit to let the SDK infer from the body. */
  contentLength?: number;
  /** Cache-Control header to store on the object (derivatives use immutable). */
  cacheControl?: string;
}

export interface GetOptions {
  /** Raw HTTP Range header value (e.g. "bytes=0-1023") for byte-range reads. */
  range?: string;
}

export interface PresignGetOptions {
  /** Presign TTL in seconds. Defaults to 3600 (the asset-URL default). */
  expiresIn?: number;
}

export interface PresignPutOptions {
  contentType: string;
  contentLength?: number;
  expiresIn?: number;
}

export interface CopyOptions {
  /** Replace the destination Content-Type (tus sets this on the canonical copy). */
  contentType?: string;
}

export interface StatResult {
  /** Object size in bytes, or null if the backend did not report it. */
  contentLength: number | null;
}

export interface StreamResult {
  /** Web ReadableStream of the object bytes, suitable for a Response body. */
  body: ReadableStream;
  contentType?: string;
  contentLength?: number;
  /** Present (and status should be 206) when a Range request was satisfied. */
  contentRange?: string;
}

/**
 * One storage backend. All methods key into a single flat namespace shared
 * across backends (the R2 key doubles as the local relative path in Phase B2).
 */
export interface StorageBackend {
  /** Presign a GET URL for direct browser/client download. */
  presignGet(key: string, opts?: PresignGetOptions): Promise<string>;
  /** Presign a PUT URL for direct client→backend upload. */
  presignPut(key: string, opts: PresignPutOptions): Promise<string>;

  /** Read an object fully into a Buffer (handles every SDK body shape). */
  getBuffer(key: string, opts?: GetOptions): Promise<Buffer>;
  /** Read an object as a streaming Response body (+ range metadata). */
  getStream(key: string, opts?: GetOptions): Promise<StreamResult>;

  /** Write an object. */
  put(key: string, body: Buffer | Uint8Array | Readable, opts: PutOptions): Promise<void>;
  /** Server-side copy srcKey→dstKey within the backend. */
  copy(srcKey: string, dstKey: string, opts?: CopyOptions): Promise<void>;

  /** HEAD an object. THROWS if it does not exist (callers rely on the throw). */
  stat(key: string): Promise<StatResult>;

  /** Delete a single object. */
  delete(key: string): Promise<void>;
  /** Delete up to many objects (chunked into ≤1000-key batch requests). */
  deleteMany(keys: string[]): Promise<void>;
  /** List every key under a prefix (paginates internally). */
  list(prefix: string): Promise<string[]>;
  /** List + delete every object under a prefix. Returns the count deleted. */
  deletePrefix(prefix: string): Promise<number>;
}
