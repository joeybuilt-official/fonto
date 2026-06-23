// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M8 — Bulk ZIP export (ADR 0011). Server-streams a STORE-mode zip built with
// `archiver` straight from R2 read streams to the HTTP response, with no
// whole-archive buffering. One object is in flight at a time (we open each R2
// stream lazily and wait for archiver to consume it before opening the next),
// so memory stays bounded regardless of archive size.
//
// GET  ?ids=<csv> | ?collectionId=<id> | ?token=<slugOrToken>
// POST ids=<csv> (form-urlencoded) or { ids: [...] } / { collectionId } (JSON)
//   — POST exists so an arbitrary multi-selection (1000s of ids) can be sent in
//     the body instead of a length-capped URL; a native form submit still
//     triggers a browser download because of the Content-Disposition header.
//
// `allowDownload` is a share-link property only (there is no per-asset flag):
// authenticated workspace members own their assets and export unrestricted; the
// public token path enforces allowDownload exactly as single-file download does.

import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { ZipArchive, type ArchiverError } from "archiver";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { assetStorageKey } from "@/lib/r2";
import { storage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ENTRIES = 1000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB guard

type ExportAsset = Pick<
  typeof schema.assets.$inferSelect,
  "id" | "workspaceId" | "filename" | "sizeBytes"
>;

const ASSET_COLS = {
  id: schema.assets.id,
  workspaceId: schema.assets.workspaceId,
  filename: schema.assets.filename,
  sizeBytes: schema.assets.sizeBytes,
} as const;

const ACTIVE_ONLY = and(
  eq(schema.assets.lifecycleState, "active"),
  isNull(schema.assets.deletedAt)
);

interface ExportParams {
  ids: string[];
  collectionId: string | null;
  token: string | null;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseCsv(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve the public-share asset set, enforcing allowDownload + validity. Returns
// null on any failure (caller responds 404 to avoid leaking link existence).
async function resolveShareAssets(slug: string): Promise<ExportAsset[] | null> {
  const now = new Date();
  const [link] = await db
    .select()
    .from(schema.shareLinks)
    .where(
      and(
        or(eq(schema.shareLinks.slug, slug), eq(schema.shareLinks.token, slug)),
        eq(schema.shareLinks.revoked, false),
        or(isNull(schema.shareLinks.expiresAt), gt(schema.shareLinks.expiresAt, now))
      )
    )
    .limit(1);
  if (!link) return null;
  // Conservative: password-protected and download-disabled links can't bulk-pull.
  if (link.passwordHash) return null;
  if (!link.allowDownload) return null;
  if (link.maxViews !== null && link.viewCount >= link.maxViews) return null;

  if (link.targetType === "collection") {
    return db
      .select(ASSET_COLS)
      .from(schema.collectionAssets)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.collectionAssets.assetId))
      .where(and(eq(schema.collectionAssets.collectionId, link.targetId), ACTIVE_ONLY))
      .limit(MAX_ENTRIES + 1);
  }
  // 'asset' (and legacy default) — a single shared asset.
  return db
    .select(ASSET_COLS)
    .from(schema.assets)
    .where(and(eq(schema.assets.id, link.targetId), ACTIVE_ONLY))
    .limit(1);
}

// Resolve the asset set for an authenticated member. Membership-scoped: only
// assets in a workspace the caller belongs to (cross-workspace shared singles
// are out of scope for bulk export by design).
async function resolveMemberAssets(
  wsIds: string[],
  params: ExportParams
): Promise<ExportAsset[] | "notfound" | "badreq"> {
  if (params.collectionId) {
    const [coll] = await db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.id, params.collectionId),
          inArray(schema.collections.workspaceId, wsIds)
        )
      )
      .limit(1);
    if (!coll) return "notfound";
    return db
      .select(ASSET_COLS)
      .from(schema.collectionAssets)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.collectionAssets.assetId))
      .where(and(eq(schema.collectionAssets.collectionId, params.collectionId), ACTIVE_ONLY))
      .limit(MAX_ENTRIES + 1);
  }
  if (!params.ids.length) return "badreq";
  return db
    .select(ASSET_COLS)
    .from(schema.assets)
    .where(
      and(
        inArray(schema.assets.id, params.ids),
        inArray(schema.assets.workspaceId, wsIds),
        ACTIVE_ONLY
      )
    )
    .limit(MAX_ENTRIES + 1);
}

async function handle(params: ExportParams): Promise<Response> {
  let assets: ExportAsset[];

  if (params.token) {
    const resolved = await resolveShareAssets(params.token);
    if (!resolved) return json({ error: "Not found" }, 404);
    assets = resolved;
  } else {
    const user = await getAuthUser();
    if (!user) return json({ error: "Unauthorized" }, 401);
    const workspaces = await getUserWorkspaces(user.id);
    if (!workspaces.length) return json({ error: "Not found" }, 404);
    const res = await resolveMemberAssets(workspaces.map((w) => w.id), params);
    if (res === "badreq") return json({ error: "ids or collectionId required" }, 400);
    if (res === "notfound") return json({ error: "Not found" }, 404);
    assets = res;
  }

  if (!assets.length) return json({ error: "Nothing to export" }, 404);

  let truncated = 0;
  if (assets.length > MAX_ENTRIES) {
    truncated = assets.length - MAX_ENTRIES;
    assets = assets.slice(0, MAX_ENTRIES);
  }
  const totalBytes = assets.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return json({ error: "Export too large", maxBytes: MAX_TOTAL_BYTES, totalBytes }, 413);
  }

  // STORE mode: media is already compressed; DEFLATE would burn CPU for ~0 gain.
  const archive = new ZipArchive({ store: true });
  archive.on("warning", (err: ArchiverError) => {
    if (err.code !== "ENOENT") archive.destroy(err);
  });
  archive.on("error", () => {
    /* surfaced by destroying the stream → client sees a truncated download */
  });

  // Fill the archive concurrently with the response streaming out. We open each
  // R2 stream only when archiver is ready for it (await the 'entry' event), so
  // exactly one object is in flight — bounded memory + natural backpressure.
  const fill = (async () => {
    const usedNames = new Set<string>();
    for (const a of assets) {
      const name = uniqueName(a, usedNames);
      let body: ReadableStream;
      try {
        ({ body } = await storage().getStream(assetStorageKey(a.workspaceId, a.id, a.filename)));
      } catch {
        // Missing object — skip it rather than abort the whole archive.
        continue;
      }
      const node = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
      const consumed = new Promise<void>((resolve, reject) => {
        archive.once("entry", () => resolve());
        node.once("error", reject);
      });
      archive.append(node, { name });
      await consumed;
    }
    await archive.finalize();
  })();
  fill.catch((err) => archive.destroy(err as Error));

  const today = new Date().toISOString().slice(0, 10);
  const headers: Record<string, string> = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="fonto-export-${today}.zip"`,
    "Cache-Control": "no-store",
  };
  if (truncated) headers["X-Fonto-Export-Truncated"] = String(truncated);

  return new Response(Readable.toWeb(archive) as unknown as ReadableStream, { headers });
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  return handle({
    ids: parseCsv(sp.get("ids")),
    collectionId: sp.get("collectionId"),
    token: sp.get("token"),
  });
}

export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  let ids: string[] = [];
  let collectionId: string | null = sp.get("collectionId");
  const token = sp.get("token");

  const ctype = request.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      ids?: string[];
      collectionId?: string;
    };
    ids = Array.isArray(body.ids) ? body.ids.filter((s) => typeof s === "string") : [];
    collectionId = body.collectionId ?? collectionId;
  } else {
    const form = await request.formData().catch(() => null);
    if (form) {
      ids = parseCsv(form.get("ids")?.toString());
      collectionId = (form.get("collectionId")?.toString() || null) ?? collectionId;
    }
  }

  return handle({ ids, collectionId, token });
}

// Avoid in-zip name collisions by suffixing the short asset id before the ext.
function uniqueName(a: ExportAsset, used: Set<string>): string {
  let base = a.filename.replace(/^\/+/, "").split("/").pop() || `${a.id}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  base = `${stem}-${a.id.slice(0, 8)}${ext}`;
  used.add(base);
  return base;
}
