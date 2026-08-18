// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Daily-driver P0 (media import) — Nextcloud WebDAV helpers.
//
// A self-hosted photo library often lives on the user's own Nextcloud. Unlike
// Google (OAuth refresh token), Nextcloud auth is a Basic-auth pair
// (username + app password) against the user's WebDAV endpoint:
//
//   <baseUrl>/remote.php/dav/files/<username>/
//
// We reuse the existing `integrations` table + `tokenCrypto` (no new columns,
// no migration): the credential blob is the JSON {baseUrl,username,appPassword}
// encrypted into `encryptedRefreshToken`, with `provider = 'nextcloud'`. The
// browser NEVER talks to Nextcloud directly (CORS + credential exposure) — every
// PROPFIND / GET below runs server-side inside the API routes.
//
// This is a small fetch-based WebDAV client: no `webdav` npm dep, no XML dep.
// The PROPFIND response is hand-parsed (namespace-prefix-insensitive) into a
// flat entry list. Only Depth:1 listing + single-file GET are needed for the
// browse + import flows.

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { decryptToken, encryptToken } from "./tokenCrypto";

export const NEXTCLOUD_PROVIDER = "nextcloud";

/** Credential set stored (encrypted) for a Nextcloud connection. */
export interface NextcloudCredentials {
  /** Origin (+ optional subpath) of the Nextcloud instance, no trailing slash. */
  baseUrl: string;
  username: string;
  appPassword: string;
}

/** One WebDAV listing entry (file or directory), relative to the user root. */
export interface NextcloudEntry {
  /** Last path segment (display name). */
  name: string;
  /** Path relative to the user's WebDAV files root, leading slash (e.g. "/Photos/a.jpg"). */
  path: string;
  isDir: boolean;
  /** Byte size (0 for directories / when the server omits it). */
  size: number;
  /** RFC-1123 last-modified string as returned by the server (may be empty). */
  mtime: string;
  /** MIME type the server reported (empty for directories / when omitted). */
  contentType: string;
}

/**
 * Bad-credential signal (WebDAV replied 401). Distinct from generic transport
 * failures so routes can map it to a `needs-reconnect` / 400 response.
 */
export class NextcloudAuthError extends Error {
  constructor(message = "Nextcloud rejected the credentials (401)") {
    super(message);
    this.name = "NextcloudAuthError";
  }
}

/** Strip trailing slash(es) from the instance base URL. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function basicAuthHeader(creds: NextcloudCredentials): string {
  const raw = `${creds.username}:${creds.appPassword}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/**
 * Build the absolute WebDAV URL for a path relative to the user's files root.
 * Each path segment is individually percent-encoded (spaces, unicode, etc.).
 */
function buildWebdavUrl(creds: NextcloudCredentials, path: string): string {
  const base = normalizeBaseUrl(creds.baseUrl);
  const user = encodeURIComponent(creds.username);
  const rel = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const suffix = rel ? `${rel}` : "";
  return `${base}/remote.php/dav/files/${user}/${suffix}`;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

/**
 * Issue a Depth:1 PROPFIND and parse the children of `path` (the collection
 * entry for `path` itself is dropped). Throws `NextcloudAuthError` on 401.
 */
export async function propfind(
  creds: NextcloudCredentials,
  path: string
): Promise<NextcloudEntry[]> {
  const url = buildWebdavUrl(creds, path);
  const res = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: basicAuthHeader(creds),
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: PROPFIND_BODY,
  });

  if (res.status === 401) throw new NextcloudAuthError();
  // 207 Multi-Status is the WebDAV success code for PROPFIND.
  if (res.status !== 207) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Nextcloud PROPFIND ${path} failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`
    );
  }

  const xml = await res.text();
  return parsePropfind(xml, path);
}

/**
 * Parse a WebDAV multistatus PROPFIND body into entries. Namespace-prefix
 * insensitive: we strip the leading `prefix:` from element tags first (so
 * `<d:response>` and `<D:response>` and `<response>` all parse), then pull the
 * fields per `<response>` block with small regexes.
 *
 * `requestedPath` is the collection being listed; the `<response>` whose href
 * resolves to that same path is the collection itself and is skipped.
 */
function parsePropfind(xml: string, requestedPath: string): NextcloudEntry[] {
  // Drop the leading namespace prefix from every element tag: `<d:href>` →
  // `<href>`, `</d:href>` → `</href>`, `<d:collection/>` → `<collection/>`.
  // `xmlns:d="DAV:"` attributes (not preceded by `<`) are left untouched.
  const norm = xml.replace(/<(\/?)[A-Za-z0-9]+:/g, "<$1");

  const wantRoot = trimSlashes(requestedPath);
  const entries: NextcloudEntry[] = [];

  const responseRe = /<response>([\s\S]*?)<\/response>/g;
  let m: RegExpExecArray | null;
  while ((m = responseRe.exec(norm)) !== null) {
    const block = m[1];

    const hrefRaw = firstMatch(block, /<href>([\s\S]*?)<\/href>/);
    if (!hrefRaw) continue;
    const rel = hrefToRelativePath(hrefRaw.trim());
    if (rel === null) continue;

    // Skip the collection entry for the listed path itself.
    if (trimSlashes(rel) === wantRoot) continue;

    const isDir = /<resourcetype>[\s\S]*?<collection\s*\/?>/i.test(block);
    const sizeStr = firstMatch(block, /<getcontentlength>([\s\S]*?)<\/getcontentlength>/);
    const contentType = firstMatch(block, /<getcontenttype>([\s\S]*?)<\/getcontenttype>/) ?? "";
    const mtime = firstMatch(block, /<getlastmodified>([\s\S]*?)<\/getlastmodified>/) ?? "";
    const displayName = firstMatch(block, /<displayname>([\s\S]*?)<\/displayname>/);

    const name = (displayName?.trim() || lastSegment(rel)) ?? "";

    entries.push({
      name,
      path: rel,
      isDir,
      size: sizeStr ? Number.parseInt(sizeStr.trim(), 10) || 0 : 0,
      mtime: mtime.trim(),
      contentType: contentType.trim(),
    });
  }

  return entries;
}

/**
 * Turn a WebDAV href into a path relative to the user's files root, leading
 * slash. Handles both path-only hrefs and absolute-URL hrefs, and strips the
 * `/remote.php/dav/files/<username>/` prefix. Returns null if the marker is
 * absent (a foreign href we can't map).
 */
function hrefToRelativePath(href: string): string | null {
  let p = href;
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  const marker = "/remote.php/dav/files/";
  const i = p.indexOf(marker);
  if (i < 0) return null;
  // After the marker: "<username>/<...rest>" (each segment percent-encoded).
  const afterUser = p.slice(i + marker.length);
  const slash = afterUser.indexOf("/");
  const encodedRel = slash >= 0 ? afterUser.slice(slash) : "/";
  let rel: string;
  try {
    rel = decodeURIComponent(encodedRel);
  } catch {
    rel = encodedRel;
  }
  if (!rel.startsWith("/")) rel = `/${rel}`;
  return rel;
}

function firstMatch(s: string, re: RegExp): string | null {
  const m = re.exec(s);
  return m ? m[1] : null;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

function lastSegment(path: string): string {
  const parts = trimSlashes(path).split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Download a single file over WebDAV GET. Returns the buffer plus the reported
 * content type and derived filename. Throws `NextcloudAuthError` on 401.
 */
export async function download(
  creds: NextcloudCredentials,
  path: string
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const url = buildWebdavUrl(creds, path);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: basicAuthHeader(creds) },
  });

  if (res.status === 401) throw new NextcloudAuthError();
  if (!res.ok) {
    throw new Error(
      `Nextcloud GET ${path} failed: ${res.status} ${res.statusText}`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType:
      res.headers.get("content-type")?.split(";")[0].trim() ||
      "application/octet-stream",
    filename: lastSegment(path) || "download",
  };
}

/**
 * Verify a credential set by PROPFIND-ing the user root. Returns a discriminated
 * ok/err result (never throws) so the connect route can turn a bad password into
 * a 400 without a try/catch dance.
 */
export async function verifyConnection(
  creds: NextcloudCredentials
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await propfind(creds, "/");
    return { ok: true };
  } catch (err) {
    if (err instanceof NextcloudAuthError) {
      return { ok: false, error: "invalid_credentials" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "connection_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Credential persistence (integrations table + tokenCrypto). One row per
// (workspace, user, provider='nextcloud'); the JSON blob is encrypted into
// `encryptedRefreshToken`. Mirrors the Google upsert (no unique constraint on
// the triple → explicit lookup-then-write).
// ---------------------------------------------------------------------------

async function findRow(workspaceId: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.workspaceId, workspaceId),
        eq(schema.integrations.userId, userId),
        eq(schema.integrations.provider, NEXTCLOUD_PROVIDER)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Encrypt + upsert the Nextcloud credentials, flipping the row to 'active'. The
 * baseUrl is normalized before storage. Caller is responsible for verifying the
 * credentials first (see `verifyConnection`).
 */
export async function saveNextcloudCredentials(
  workspaceId: string,
  userId: string,
  creds: NextcloudCredentials
): Promise<void> {
  const normalized: NextcloudCredentials = {
    baseUrl: normalizeBaseUrl(creds.baseUrl),
    username: creds.username,
    appPassword: creds.appPassword,
  };
  const encryptedRefreshToken = encryptToken(JSON.stringify(normalized));
  const now = new Date();

  const existing = await findRow(workspaceId, userId);
  if (existing) {
    await db
      .update(schema.integrations)
      .set({
        encryptedRefreshToken,
        // Nextcloud grants no scopes; record the WebDAV endpoint kind instead.
        grantedScopes: "webdav",
        status: "active",
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.integrations.id, existing.id));
  } else {
    await db.insert(schema.integrations).values({
      workspaceId,
      userId,
      provider: NEXTCLOUD_PROVIDER,
      encryptedRefreshToken,
      grantedScopes: "webdav",
      status: "active",
    });
  }
}

/**
 * Load + decrypt the stored Nextcloud credentials for a workspace user, or null
 * if there is no active connection (missing row, revoked, or empty token).
 */
export async function loadNextcloudCredentials(
  workspaceId: string,
  userId: string
): Promise<NextcloudCredentials | null> {
  const row = await findRow(workspaceId, userId);
  if (!row || !row.encryptedRefreshToken || row.status === "revoked") {
    return null;
  }
  try {
    const parsed = JSON.parse(
      decryptToken(row.encryptedRefreshToken)
    ) as NextcloudCredentials;
    if (!parsed?.baseUrl || !parsed?.username || !parsed?.appPassword) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Disconnect: null the encrypted blob + flip to 'revoked'. Returns false if
 * there was nothing connected. Mirrors the Google revoke local-row semantics.
 */
export async function revokeNextcloudIntegration(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const row = await findRow(workspaceId, userId);
  if (!row) return false;
  await db
    .update(schema.integrations)
    .set({
      encryptedRefreshToken: null,
      status: "revoked",
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.integrations.id, row.id));
  return true;
}
