// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// R2 (Cloudflare, S3-compatible) implementation of StorageBackend. Wraps the
// exact AWS SDK calls that were previously inlined across the codebase, with
// no behavior change — same bucket env, same presign TTLs (passed by callers),
// same body-handling, same cache headers.

import { Readable } from "stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client } from "@/lib/r2";
import type {
  CopyOptions,
  GetOptions,
  PresignGetOptions,
  PresignPutOptions,
  PutOptions,
  StatResult,
  StorageBackend,
  StreamResult,
} from "./interface";

// S3 DeleteObjects accepts at most 1000 keys per request.
const DELETE_BATCH_MAX = 1000;

function bucket(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET not configured");
  return b;
}

/**
 * Collect any AWS SDK GetObject body shape into a Buffer. The SDK returns
 * different concrete types across runtimes (Node Readable, web ReadableStream,
 * or a Blob-like with arrayBuffer); mirror the resilient handling the upload
 * finalize path used so no call site regresses.
 */
async function collectBody(body: unknown, key: string): Promise<Buffer> {
  if (!body) throw new Error(`R2 object empty body: ${key}`);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  if (typeof (body as { getReader?: unknown }).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (typeof (body as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === "function") {
    const ab = await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(ab);
  }
  // AsyncIterable<Uint8Array> fallback (Node SDK stream without instanceof match).
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`Unsupported R2 GetObject body type for ${key}`);
}

export class R2Backend implements StorageBackend {
  async presignGet(key: string, opts?: PresignGetOptions): Promise<string> {
    return getSignedUrl(
      getS3Client(),
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
      { expiresIn: opts?.expiresIn ?? 3600 }
    );
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return getSignedUrl(
      getS3Client(),
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
      }),
      { expiresIn: opts.expiresIn ?? 3600 }
    );
  }

  async getBuffer(key: string, opts?: GetOptions): Promise<Buffer> {
    const out = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key, Range: opts?.range })
    );
    return collectBody(out.Body, key);
  }

  async getStream(key: string, opts?: GetOptions): Promise<StreamResult> {
    const out = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key, Range: opts?.range })
    );
    if (!out.Body) throw new Error(`R2 object empty body: ${key}`);
    const body = (out.Body as { transformToWebStream: () => ReadableStream }).transformToWebStream();
    return {
      body,
      contentType: out.ContentType,
      contentLength: out.ContentLength ?? undefined,
      contentRange: out.ContentRange ?? undefined,
    };
  }

  async put(
    key: string,
    body: Buffer | Uint8Array | Readable,
    opts: PutOptions
  ): Promise<void> {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: opts.contentLength,
        CacheControl: opts.cacheControl,
      })
    );
  }

  async copy(srcKey: string, dstKey: string, opts?: CopyOptions): Promise<void> {
    const b = bucket();
    await getS3Client().send(
      new CopyObjectCommand({
        Bucket: b,
        Key: dstKey,
        CopySource: `/${b}/${srcKey}`,
        MetadataDirective: "REPLACE",
        ContentType: opts?.contentType,
      })
    );
  }

  async stat(key: string): Promise<StatResult> {
    const head = await getS3Client().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key })
    );
    return {
      contentLength: typeof head.ContentLength === "number" ? head.ContentLength : null,
    };
  }

  async delete(key: string): Promise<void> {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const b = bucket();
    const s3 = getS3Client();
    for (let i = 0; i < keys.length; i += DELETE_BATCH_MAX) {
      const batch = keys.slice(i, i + DELETE_BATCH_MAX);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: b,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        })
      );
    }
  }

  async list(prefix: string): Promise<string[]> {
    const b = bucket();
    const s3 = getS3Client();
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: b,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of page.Contents ?? []) {
        if (c.Key) keys.push(c.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  // Paginate + delete page-by-page (don't buffer the whole key list for huge
  // prefixes), matching the prior purge loop.
  async deletePrefix(prefix: string): Promise<number> {
    const b = bucket();
    const s3 = getS3Client();
    let total = 0;
    let continuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: b,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      const keys = (page.Contents ?? [])
        .map((c) => c.Key)
        .filter((k): k is string => !!k);
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: b,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          })
        );
        total += keys.length;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return total;
  }
}
