// SPDX-License-Identifier: MIT
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
  // M14 / ADR 0057 — full-workspace export (manifest + ALL originals, no entry
  // cap). Owner pulls their entire library out of the appliance. Only valid on
  // the authenticated path; ignored for token/share exports.
  scope: "workspace" | null;
}

// Richer column set for the workspace manifest. `manifest.json` correlates each
// in-zip filename back to its asset id + checksum + capture metadata so a
// re-import (or any external tool) can rebuild the library faithfully.
const MANIFEST_COLS = {
  id: schema.assets.id,
  workspaceId: schema.assets.workspaceId,
  filename: schema.assets.filename,
  mimeType: schema.assets.mimeType,
  sizeBytes: schema.assets.sizeBytes,
  sha256: schema.assets.sha256,
  capturedAt: schema.assets.capturedAt,
  createdAt: schema.assets.createdAt,
} as const;
type ManifestRow = {
  id: string;
  workspaceId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  capturedAt: Date | null;
  createdAt: Date;
};

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
      .where(
        and(
          eq(schema.collectionAssets.collectionId, link.targetId),
          // Defense-in-depth: a shared collection can only export assets that
          // belong to the share link's own workspace.
          eq(schema.assets.workspaceId, link.workspaceId),
          ACTIVE_ONLY,
        ),
      )
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
      .where(
        and(
          eq(schema.collectionAssets.collectionId, params.collectionId),
          // Defense-in-depth: only export assets that live in the caller's own
          // workspaces — a foreign asset smuggled into the link table must
          // never be pulled out via a collection export.
          inArray(schema.assets.workspaceId, wsIds),
          ACTIVE_ONLY,
        ),
      )
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
  // M14 — workspace-scope export carries a manifest + lifts the entry/byte
  // caps (the owner is pulling their whole library, which is the point).
  let manifest: { workspaceId: string; workspaceName: string; rows: ManifestRow[] } | null = null;

  if (params.token) {
    const resolved = await resolveShareAssets(params.token);
    if (!resolved) return json({ error: "Not found" }, 404);
    assets = resolved;
  } else {
    const user = await getAuthUser();
    if (!user) return json({ error: "Unauthorized" }, 401);
    const workspaces = await getUserWorkspaces(user.id);
    if (!workspaces.length) return json({ error: "Not found" }, 404);

    if (params.scope === "workspace") {
      // Whole library: every active asset in the caller's primary workspace.
      const ws = workspaces[0];
      const rows = (await db
        .select(MANIFEST_COLS)
        .from(schema.assets)
        .where(and(eq(schema.assets.workspaceId, ws.id), ACTIVE_ONLY))) as ManifestRow[];
      if (!rows.length) return json({ error: "Nothing to export" }, 404);
      manifest = { workspaceId: ws.id, workspaceName: ws.name, rows };
      assets = rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        filename: r.filename,
        sizeBytes: r.sizeBytes,
      }));
    } else {
      const res = await resolveMemberAssets(workspaces.map((w) => w.id), params);
      if (res === "badreq") return json({ error: "ids or collectionId required" }, 400);
      if (res === "notfound") return json({ error: "Not found" }, 404);
      assets = res;
    }
  }

  if (!assets.length) return json({ error: "Nothing to export" }, 404);

  let truncated = 0;
  // Workspace export is uncapped by design (it's the owner's full data export);
  // every other mode keeps the entry + byte guards.
  if (!manifest) {
    if (assets.length > MAX_ENTRIES) {
      truncated = assets.length - MAX_ENTRIES;
      assets = assets.slice(0, MAX_ENTRIES);
    }
    const totalBytes = assets.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return json({ error: "Export too large", maxBytes: MAX_TOTAL_BYTES, totalBytes }, 413);
    }
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
    // M14 — manifest first (small, buffered). Maps each in-zip file → asset id,
    // checksum, mime + capture/ingest time so the export is self-describing.
    if (manifest) {
      const manifestJson = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          workspace: { id: manifest.workspaceId, name: manifest.workspaceName },
          assetCount: manifest.rows.length,
          assets: manifest.rows.map((r) => ({
            id: r.id,
            file: `originals/${r.id}_${r.filename.replace(/^\/+/, "").split("/").pop()}`,
            filename: r.filename,
            mimeType: r.mimeType,
            sizeBytes: r.sizeBytes,
            sha256: r.sha256,
            capturedAt: r.capturedAt ? r.capturedAt.toISOString() : null,
            createdAt: r.createdAt.toISOString(),
          })),
        },
        null,
        2
      );
      const mfConsumed = new Promise<void>((resolve) => archive.once("entry", () => resolve()));
      archive.append(Buffer.from(manifestJson), { name: "manifest.json" });
      await mfConsumed;
    }
    const usedNames = new Set<string>();
    for (const a of assets) {
      // Workspace export: deterministic `originals/<id>_<name>` (id-prefixed so
      // it's collision-free + matches the manifest `file` path). Other modes
      // keep the flat human-friendly naming.
      const name = manifest
        ? `originals/${a.id}_${a.filename.replace(/^\/+/, "").split("/").pop() || a.id}`
        : uniqueName(a, usedNames);
      let body: ReadableStream;
      try {
        ({ body } = await storage().getStream(
          assetStorageKey(a.workspaceId, a.id, a.filename),
          // Archived straight into the response — the downloader paces it.
          { consumerPaced: true }
        ));
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
  const fname = manifest ? `fonto-library-${today}.zip` : `fonto-export-${today}.zip`;
  const headers: Record<string, string> = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${fname}"`,
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
    scope: sp.get("scope") === "workspace" ? "workspace" : null,
  });
}

export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  let ids: string[] = [];
  let collectionId: string | null = sp.get("collectionId");
  const token = sp.get("token");

  let scope: "workspace" | null = sp.get("scope") === "workspace" ? "workspace" : null;

  const ctype = request.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as {
      ids?: string[];
      collectionId?: string;
      scope?: string;
    };
    ids = Array.isArray(body.ids) ? body.ids.filter((s) => typeof s === "string") : [];
    collectionId = body.collectionId ?? collectionId;
    if (body.scope === "workspace") scope = "workspace";
  } else {
    const form = await request.formData().catch(() => null);
    if (form) {
      ids = parseCsv(form.get("ids")?.toString());
      collectionId = (form.get("collectionId")?.toString() || null) ?? collectionId;
      if (form.get("scope")?.toString() === "workspace") scope = "workspace";
    }
  }

  return handle({ ids, collectionId, token, scope });
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
