// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Public share-resolve page. Path is `/share/[token]` for backward compat —
// new links use the 8-char `slug` as the URL segment; legacy long random
// tokens still resolve by falling back to the `token` column.
//
// Behaviour (Phase 2.5):
//   1. Per-IP rate limit (30 req/min via Valkey).
//   2. Lookup by slug, then token; reject revoked / expired / over-maxViews.
//   3. Always record an access in `share_link_views` (incl. failed password
//      attempts — that's the audit trail).
//   4. If passwordHash set: the unlock form POSTs to a server action that
//      stores the password in an httpOnly, path-scoped cookie (never the URL);
//      the page reads that cookie. argon2id verify is timing-safe.
//   5. On success: atomically bump viewCount + lastAccessedAt.
//   6. Resolve target:
//      - asset:      presigned URL + inline preview (download gated by allowDownload).
//      - collection: JSON-ish gallery of contained assets w/ thumbnail URLs.
//      - set:        currently same shape as collection.

import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { getAuthUser } from "@/lib/auth/server";
import { db, schema } from "@/lib/db";
import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  assetStorageKey,
  assetStorageKeyLegacy,
  assetDerivativeKey,
} from "@/lib/r2";
import { storage } from "@/lib/storage";
import { FileText, File as FileIcon, Download, Lock } from "lucide-react";
import { verifyPassword } from "@/lib/share-links/password";
import { hashIp } from "@/lib/share-links/ip-hash";
import {
  checkShareLinkRateLimit,
  SHARE_LINK_RATE_LIMIT_WINDOW_SECONDS,
} from "@/lib/share-links/rate-limit";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

/** Per-token cookie holding the submitted password — httpOnly so it never
 *  appears in the URL, browser history, Referer, or access logs (unlike the
 *  old ?p= query string). Scoped to the share path, short-lived. */
function sharePwCookie(token: string): string {
  return `share_pw_${encodeURIComponent(token)}`;
}

async function unlockShare(formData: FormData): Promise<void> {
  "use server";
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("p") ?? "");
  if (!token) return;
  const jar = await cookies();
  jar.set(sharePwCookie(token), password, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: `/share/${token}`,
    maxAge: 3600,
  });
  redirect(`/share/${token}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function clientIpFromHeaders(): Promise<string> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip") ?? "";
}

async function recordView(opts: {
  shareLinkId: string;
  ipHash: string | null;
  userAgent: string | null;
  success: boolean;
  referer: string | null;
}) {
  try {
    await db.insert(schema.shareLinkViews).values({
      shareLinkId: opts.shareLinkId,
      ipHash: opts.ipHash,
      userAgent: opts.userAgent,
      success: opts.success,
      referer: opts.referer ? opts.referer.slice(0, 500) : null,
    });
  } catch {
    /* analytics best-effort — never block the share render */
  }
}

async function presignAssetUrl(asset: {
  id: string;
  workspaceId: string;
  filename: string;
}): Promise<string | null> {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) return null;
  const primary = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  const legacy = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);
  let key = primary;
  try {
    await storage().stat(primary);
  } catch {
    key = legacy;
  }
  return storage().presignGet(key, { expiresIn: 3600 });
}

async function presignThumb(workspaceId: string, assetId: string): Promise<string | null> {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) return null;
  const key = assetDerivativeKey(workspaceId, assetId, "thumb");
  try {
    return await storage().presignGet(key, { expiresIn: 3600 });
  } catch {
    return null;
  }
}

/** Size-limited preview derivative (not the original). Used for the inline
 *  render when the share link does NOT allow downloads, so the full-res
 *  original URL is never handed to the viewer. */
async function presignPreview(workspaceId: string, assetId: string): Promise<string | null> {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) return null;
  const key = assetDerivativeKey(workspaceId, assetId, "preview");
  try {
    return await storage().presignGet(key, { expiresIn: 3600 });
  } catch {
    return null;
  }
}

// ─── Shared request-scoped loaders ──────────────────────────────────────────
// Both generateMetadata and the page component resolve the same share link and
// its target. cache() dedupes the DB work (and the rate-limit side effect) so
// each runs exactly once per request instead of twice.

/** Constant bucket for requests with no resolvable client IP. Ensures such
 *  requests are still throttled collectively rather than skipping the limiter
 *  (the old `if (ipHash)` guard was fail-open → password brute-force vector). */
const NO_IP_RATE_BUCKET = "__share_no_ip__";

type ShareLinkRow = typeof schema.shareLinks.$inferSelect;

type ShareResolution =
  | { kind: "rate_limited"; resetSeconds: number }
  | { kind: "not_found" }
  | { kind: "ok"; link: ShareLinkRow; ipHash: string | null };

/** Rate-limit + link lookup + validity, shared by generateMetadata and the
 *  page. Rate-limiting lives here so the metadata path can't bypass it. */
const resolveShare = cache(async (token: string): Promise<ShareResolution> => {
  const ip = await clientIpFromHeaders();
  const ipHash = ip ? hashIp(ip) : null;
  const rl = await checkShareLinkRateLimit(ipHash ?? NO_IP_RATE_BUCKET);
  if (!rl.allowed) {
    return { kind: "rate_limited", resetSeconds: rl.resetSeconds };
  }

  const [link] = await db
    .select()
    .from(schema.shareLinks)
    .where(or(eq(schema.shareLinks.slug, token), eq(schema.shareLinks.token, token)))
    .limit(1);

  // Revoked / expired / burned-out → treat as not found (don't leak existence).
  if (!link) return { kind: "not_found" };
  if (link.revoked || link.revokedAt) return { kind: "not_found" };
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    return { kind: "not_found" };
  }
  if (link.maxViews !== null && link.viewCount >= link.maxViews) {
    return { kind: "not_found" };
  }

  return { kind: "ok", link, ipHash };
});

const loadAsset = cache(async (assetId: string) => {
  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.id, assetId))
    .limit(1);
  return asset ?? null;
});

const loadCollection = cache(async (collectionId: string) => {
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
    .limit(1);
  return collection ?? null;
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (resolved.kind !== "ok") return { title: "Fonto — Shared" };
  const { link } = resolved;

  if (link.targetType === "asset") {
    const asset = await loadAsset(link.targetId);
    if (!asset) return { title: "Fonto — Shared" };
    const thumbUrl = await presignThumb(asset.workspaceId, asset.id);
    const desc = asset.description ?? "Shared via Fonto";
    return {
      title: asset.filename,
      description: desc,
      openGraph: {
        title: asset.filename,
        description: desc,
        images: thumbUrl ? [{ url: thumbUrl }] : [],
        type: "website",
      },
      twitter: {
        card: "summary_large_image",
        title: asset.filename,
        description: desc,
        images: thumbUrl ? [thumbUrl] : [],
      },
    };
  }

  if (link.targetType === "collection") {
    const collection = await loadCollection(link.targetId);
    if (!collection) return { title: "Fonto — Shared Collection" };
    const desc = collection.description ?? "A collection shared via Fonto";
    return {
      title: collection.name,
      description: desc,
      openGraph: { title: collection.name, description: desc, type: "website" },
    };
  }

  return { title: "Fonto — Shared" };
}

function RateLimitedPage({ resetSeconds }: { resetSeconds: number }) {
  return (
    <div className="min-h-screen bg-background grid place-items-center px-6">
      <div className="max-w-md text-center space-y-2">
        <h1 className="text-lg font-semibold">Too many requests</h1>
        <p className="text-sm text-muted-foreground">
          Try again in about {resetSeconds || SHARE_LINK_RATE_LIMIT_WINDOW_SECONDS} seconds.
        </p>
      </div>
    </div>
  );
}

function PasswordPrompt({ token, error }: { token: string; error?: string }) {
  return (
    <div className="min-h-screen bg-background grid place-items-center px-6">
      <form
        action={unlockShare}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6"
      >
        <input type="hidden" name="token" value={token} />
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-base font-semibold">Password required</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          This share is password-protected. Enter the password to view its contents.
        </p>
        <input
          type="password"
          name="p"
          autoFocus
          required
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="Password"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          type="submit"
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Unlock
        </button>
      </form>
    </div>
  );
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;
  const jar = await cookies();
  const submittedPassword = jar.get(sharePwCookie(token))?.value ?? null;

  const h = await headers();
  const userAgent = h.get("user-agent");
  const referer = h.get("referer");

  // Rate-limit + lookup + validity run in the shared cached resolver so the
  // metadata path can't bypass the limiter and the DB work isn't repeated.
  const resolved = await resolveShare(token);
  if (resolved.kind === "rate_limited") {
    return <RateLimitedPage resetSeconds={resolved.resetSeconds} />;
  }
  if (resolved.kind === "not_found") {
    // 410-Gone / revoked / expired all surface as notFound() to keep the
    // public surface small (don't leak "no link" vs "burned-out link").
    notFound();
  }
  const { link, ipHash } = resolved;

  // Authenticated users with an asset target land directly in the app lightbox.
  if (link.targetType === "asset") {
    const authUser = await getAuthUser();
    if (authUser) redirect(`/app/library?lb=${link.targetId}`);
  }

  // Password gate.
  if (link.passwordHash) {
    if (!submittedPassword) {
      await recordView({
        shareLinkId: link.id,
        ipHash,
        userAgent,
        success: false,
        referer,
      });
      return <PasswordPrompt token={token} />;
    }
    const ok = await verifyPassword(link.passwordHash, submittedPassword);
    if (!ok) {
      await recordView({
        shareLinkId: link.id,
        ipHash,
        userAgent,
        success: false,
        referer,
      });
      return <PasswordPrompt token={token} error="Incorrect password." />;
    }
  }

  // Success → atomic bump of viewCount + lastAccessedAt.
  await db
    .update(schema.shareLinks)
    .set({
      viewCount: sql`${schema.shareLinks.viewCount} + 1`,
      lastAccessedAt: new Date(),
    })
    .where(eq(schema.shareLinks.id, link.id));

  await recordView({ shareLinkId: link.id, ipHash, userAgent, success: true, referer });

  // ─── Asset target ───────────────────────────────────────────────────────
  if (link.targetType === "asset") {
    const asset = await loadAsset(link.targetId);
    if (
      !asset ||
      asset.lifecycleState === "trashed" ||
      asset.lifecycleState === "purged"
    ) {
      notFound();
    }
    const isImage = asset.mimeType.startsWith("image/");
    const isPdf = asset.mimeType === "application/pdf";

    // SECURITY: only ever presign the ORIGINAL when the link allows downloads.
    // Otherwise the allowDownload toggle is cosmetic — the full-res original
    // URL would sit in the <img>/<iframe> src for any viewer to copy or
    // right-click-save. When downloads are off we serve a size-limited preview
    // derivative (images) and expose no direct original URL at all.
    const originalUrl = link.allowDownload ? await presignAssetUrl(asset) : null;
    const previewUrl = link.allowDownload
      ? originalUrl
      : isImage
        ? await presignPreview(asset.workspaceId, asset.id)
        : null;

    // Download enabled but the original couldn't be signed (bucket misconfig)
    // → 404, preserving prior behaviour.
    if (link.allowDownload && !originalUrl) notFound();

    // Reserve layout space from stored intrinsic dimensions so the public
    // render doesn't reflow / flash blank while the image loads.
    const previewAspect =
      asset.widthPx && asset.heightPx && asset.widthPx > 0 && asset.heightPx > 0
        ? `${asset.widthPx} / ${asset.heightPx}`
        : "4 / 3";

    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link href="/" className="font-heading text-sm font-semibold tracking-tight">
              <span className="text-primary">_</span>fonto
            </Link>
            {link.allowDownload && originalUrl && (
              <a
                href={originalUrl}
                download={asset.filename}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
              >
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            )}
          </div>
        </header>

        <main className="mx-auto max-w-5xl space-y-4 px-6 py-8">
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {isImage && previewUrl ? (
              <div
                className="relative w-full bg-muted/30"
                style={{ aspectRatio: previewAspect, maxHeight: "80vh" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl}
                  alt={asset.description ?? asset.filename}
                  {...(asset.widthPx && asset.heightPx
                    ? { width: asset.widthPx, height: asset.heightPx }
                    : {})}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : isPdf && originalUrl ? (
              <iframe src={originalUrl} className="w-full h-[80vh]" title={asset.filename} />
            ) : (
              <div className="flex aspect-video flex-col items-center justify-center gap-2 bg-muted/30">
                {asset.mimeType.startsWith("text/") ? (
                  <FileText className="h-16 w-16 text-muted-foreground" />
                ) : (
                  <FileIcon className="h-16 w-16 text-muted-foreground" />
                )}
                {!link.allowDownload && (
                  <p className="px-6 text-center text-xs text-muted-foreground">
                    Preview unavailable — downloads are disabled for this share.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <h1 className="text-xl font-semibold text-foreground break-all">{asset.filename}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{asset.mimeType}</span>
              <span>·</span>
              <span>{formatBytes(asset.sizeBytes)}</span>
              {link.expiresAt && (
                <>
                  <span>·</span>
                  <span>Shared until {new Date(link.expiresAt).toLocaleString()}</span>
                </>
              )}
            </div>
            {asset.description && (
              <p className="mt-3 text-sm text-foreground">{asset.description}</p>
            )}
          </div>

          <p className="pt-6 text-center text-xs text-muted-foreground">
            Shared via <Link href="/" className="hover:text-foreground">Fonto</Link>
          </p>
        </main>
      </div>
    );
  }

  // ─── Collection / Set target ────────────────────────────────────────────
  if (link.targetType === "collection") {
    const collection = await loadCollection(link.targetId);
    if (!collection) notFound();

    const rows = await db
      .select({
        id: schema.assets.id,
        filename: schema.assets.filename,
        mimeType: schema.assets.mimeType,
        workspaceId: schema.assets.workspaceId,
        addedAt: schema.collectionAssets.addedAt,
      })
      .from(schema.collectionAssets)
      .innerJoin(schema.assets, eq(schema.collectionAssets.assetId, schema.assets.id))
      .where(
        and(
          eq(schema.collectionAssets.collectionId, collection.id),
          eq(schema.assets.lifecycleState, "active")
        )
      )
      .orderBy(asc(schema.collectionAssets.addedAt))
      .limit(500);

    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mimeType,
        thumbUrl: await presignThumb(r.workspaceId, r.id),
      }))
    );

    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <Link href="/" className="font-heading text-sm font-semibold tracking-tight">
              <span className="text-primary">_</span>fonto
            </Link>
            <span className="text-xs text-muted-foreground">{items.length} items</span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">
          <h1 className="text-xl font-semibold">{collection.name}</h1>
          {collection.description && (
            <p className="mt-1 text-sm text-muted-foreground">{collection.description}</p>
          )}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {items.map((it) => (
              <div
                key={it.id}
                className="aspect-square overflow-hidden rounded-md border border-border bg-card"
              >
                {it.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.thumbUrl}
                    alt={it.filename}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="grid h-full place-items-center text-xs text-muted-foreground">
                    {it.filename}
                  </div>
                )}
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  // 'set' (smart_collections) — placeholder; smart-collection query evaluation
  // lives elsewhere. Treat as empty for now.
  return (
    <div className="min-h-screen bg-background grid place-items-center px-6">
      <p className="text-sm text-muted-foreground">
        Sets are not yet renderable in shared view.
      </p>
    </div>
  );
}
