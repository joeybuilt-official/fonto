// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Local filesystem implementation of StorageBackend. Bytes live under
// LOCAL_STORAGE_ROOT (a NAS Linux NAS share bind-mounted into fonto + fonto-worker
// at /data/fonto-media — see Track B / Phase B0). The R2 key doubles as the
// relative path verbatim, so both backends share one key space.
//
// Local disk has NO presigned URLs (the load-bearing constraint in ADR 0001):
// presignGet/presignPut throw. Local reads are served by streaming through the
// app server (Phase B4 read path), like the existing HLS proxy.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  GetOptions,
  StatResult,
  StorageBackend,
  StreamResult,
} from "./interface";

function root(): string {
  const r = process.env.LOCAL_STORAGE_ROOT;
  if (!r) throw new Error("LOCAL_STORAGE_ROOT not configured");
  return r;
}

/**
 * Resolve a storage key to an absolute path under the root, refusing any key
 * that escapes the root (path traversal). Keys are backend-shared R2 keys like
 * `fonto/{ws}/{asset}/file` — always relative, forward-slashed.
 */
function resolveKey(key: string): string {
  const base = path.resolve(root());
  const full = path.resolve(base, key);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`storage key escapes LOCAL_STORAGE_ROOT: ${key}`);
  }
  return full;
}

/** Parse an HTTP Range header (single range) into { start, end? }. */
function parseRange(range: string, size: number): { start: number; end: number } {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) throw new Error(`unsupported Range: ${range}`);
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  let start: number;
  let end: number;
  if (hasStart) {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
  } else {
    // suffix range: bytes=-N → last N bytes
    const n = parseInt(m[2], 10);
    start = Math.max(0, size - n);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

export class LocalFsBackend implements StorageBackend {
  async presignGet(): Promise<string> {
    throw new Error("LocalFsBackend has no presigned URLs — stream through the server");
  }

  async presignPut(): Promise<string> {
    throw new Error("LocalFsBackend has no presigned URLs — upload through the server");
  }

  async getBuffer(key: string, opts?: GetOptions): Promise<Buffer> {
    const file = resolveKey(key);
    if (!opts?.range) return fsp.readFile(file);
    const { size } = await fsp.stat(file);
    const { start, end } = parseRange(opts.range, size);
    const fh = await fsp.open(file, "r");
    try {
      const len = end - start + 1;
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, start);
      return buf;
    } finally {
      await fh.close();
    }
  }

  async getStream(key: string, opts?: GetOptions): Promise<StreamResult> {
    const file = resolveKey(key);
    const { size } = await fsp.stat(file);
    if (opts?.range) {
      const { start, end } = parseRange(opts.range, size);
      const node = fs.createReadStream(file, { start, end });
      return {
        body: Readable.toWeb(node) as ReadableStream,
        contentLength: end - start + 1,
        contentRange: `bytes ${start}-${end}/${size}`,
      };
    }
    const node = fs.createReadStream(file);
    return { body: Readable.toWeb(node) as ReadableStream, contentLength: size };
  }

  async put(key: string, body: Buffer | Uint8Array | Readable): Promise<void> {
    const file = resolveKey(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // fsp.writeFile accepts a Buffer/Uint8Array or a Readable stream directly.
    await fsp.writeFile(file, body);
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    const src = resolveKey(srcKey);
    const dst = resolveKey(dstKey);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }

  async stat(key: string): Promise<StatResult> {
    // fs.stat throws ENOENT on a missing file — matching the SDK HEAD throw.
    const st = await fsp.stat(resolveKey(key));
    return { contentLength: st.size };
  }

  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(resolveKey(key));
    } catch (err) {
      // S3 DeleteObject succeeds on a missing key; mirror that.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.delete(k)));
  }

  async list(prefix: string): Promise<string[]> {
    const base = path.resolve(root());
    // Walk the directory subtree the prefix points at. Prefix may be a partial
    // path segment (e.g. ".../hls/360p_"); list the parent dir and filter.
    const prefixFull = path.resolve(base, prefix);
    const startDir = prefix.endsWith("/") ? prefixFull : path.dirname(prefixFull);
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (full.startsWith(prefixFull)) {
          out.push(path.relative(base, full).split(path.sep).join("/"));
        }
      }
    }
    await walk(startDir);
    return out;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    await this.deleteMany(keys);
    return keys.length;
  }
}
