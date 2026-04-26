"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth/client";
import Link from "next/link";

interface StorageInfo {
  totalBytes: number;
  assetCount: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const user = session?.user;
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    fetch("/api/v1/workspace")
      .then((r) => r.json())
      .then((d) => setStorage(d.storage ?? null))
      .catch(() => null);
  }, []);

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account and workspace</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Account</h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</label>
            <p className="mt-1 text-sm text-foreground">{user?.name ?? "—"}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</label>
            <p className="mt-1 text-sm text-foreground">{user?.email ?? "—"}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Storage</h2>
        {storage ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total assets</span>
              <span className="text-sm font-medium text-foreground">{storage.assetCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Storage used</span>
              <span className="text-sm font-medium text-foreground">{formatBytes(storage.totalBytes)}</span>
            </div>
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground">
                Assets are stored securely in Cloudflare R2. No storage limits on the current plan.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading storage info…</p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Data</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-foreground">Export metadata</p>
            <p className="text-xs text-muted-foreground">Download all asset metadata as JSON</p>
          </div>
          <Link
            href="/api/export"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
          >
            Export JSON
          </Link>
        </div>
      </div>
    </div>
  );
}
