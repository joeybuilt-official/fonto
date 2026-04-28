// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/lib/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { getS3Client, assetStorageKey, assetStorageKeyLegacy } from "@/lib/r2";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FileText, File as FileIcon, Download } from "lucide-react";

interface SharePageProps {
  params: Promise<{ token: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;

  const [link] = await db
    .select()
    .from(schema.shareLinks)
    .where(
      and(
        eq(schema.shareLinks.token, token),
        isNull(schema.shareLinks.revokedAt),
        gt(schema.shareLinks.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!link) notFound();

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.id, link.assetId))
    .limit(1);

  if (!asset || asset.lifecycleState === "trashed" || asset.lifecycleState === "purged") {
    notFound();
  }

  const bucket = process.env.R2_BUCKET!;
  const primaryKey = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  const legacyKey = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);
  const s3 = getS3Client();

  // Probe primary, fall back to legacy
  let key = primaryKey;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: primaryKey }));
  } catch {
    key = legacyKey;
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 }
  );

  const isImage = asset.mimeType.startsWith("image/");
  const isPdf = asset.mimeType === "application/pdf";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" className="font-heading text-sm font-semibold tracking-tight">
            <span className="text-primary">_</span>fonto
          </Link>
          <a
            href={url}
            download={asset.filename}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-6 py-8">
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={asset.description ?? asset.filename}
              className="w-full object-contain max-h-[80vh]"
            />
          ) : isPdf ? (
            <iframe src={url} className="w-full h-[80vh]" title={asset.filename} />
          ) : (
            <div className="flex aspect-video items-center justify-center bg-muted/30">
              {asset.mimeType.startsWith("text/") ? (
                <FileText className="h-16 w-16 text-muted-foreground" />
              ) : (
                <FileIcon className="h-16 w-16 text-muted-foreground" />
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
            <span>·</span>
            <span>Shared until {new Date(link.expiresAt).toLocaleString()}</span>
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
