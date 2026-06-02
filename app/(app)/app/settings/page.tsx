// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth/client";
import Link from "next/link";
import { PlexoConnectionStatus } from "@/components/plexo-connection-status";

interface StorageInfo {
  usageBytes: number;
  quotaBytes: number | null;
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
  const [rescanScope, setRescanScope] = useState<"all" | "images" | "failed">("all");
  const [rescanBusy, setRescanBusy] = useState(false);
  const [rescanMsg, setRescanMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/workspace")
      .then((r) => r.json())
      .then((d) => setStorage(d.storage ?? null))
      .catch(() => null);
  }, []);

  async function handleRescanAll() {
    if (rescanBusy) return;
    setRescanBusy(true);
    setRescanMsg(null);
    try {
      const res = await fetch("/api/v1/workspace/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: rescanScope }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { queued: number };
      setRescanMsg(`Queued ${data.queued} asset${data.queued === 1 ? "" : "s"} for re-scan.`);
    } catch (err) {
      setRescanMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed to queue re-scan.");
    } finally {
      setRescanBusy(false);
    }
  }

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
              <span className="text-sm font-medium text-foreground">
                {formatBytes(storage.usageBytes)}
                {storage.quotaBytes != null && (
                  <span className="text-muted-foreground font-normal"> / {formatBytes(storage.quotaBytes)}</span>
                )}
              </span>
            </div>
            {storage.quotaBytes != null && (
              <div className="space-y-1">
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      storage.usageBytes / storage.quotaBytes >= 0.9
                        ? "bg-destructive"
                        : storage.usageBytes / storage.quotaBytes >= 0.75
                        ? "bg-yellow-500"
                        : "bg-primary"
                    }`}
                    style={{ width: `${Math.min(100, (storage.usageBytes / storage.quotaBytes) * 100).toFixed(1)}%` }}
                  />
                </div>
                {storage.usageBytes / storage.quotaBytes >= 0.9 && (
                  <p className="text-xs text-destructive">Storage almost full — delete or archive assets to free space.</p>
                )}
              </div>
            )}
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground">
                Assets are stored securely in Cloudflare R2.
                {storage.quotaBytes == null && " No storage quota on the current plan."}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading storage info…</p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Plexo AI</h2>
          <PlexoConnectionStatus />
        </div>
        <p className="text-xs text-muted-foreground">
          Plexo powers AI classification, auto-tagging, and cross-app intelligence for your assets.
        </p>
        <div className="space-y-3 pt-1">
          {[
            { id: "google-drive", label: "Google Drive", desc: "Import assets from Google Drive" },
            { id: "dropbox", label: "Dropbox", desc: "Sync assets from Dropbox" },
            { id: "icloud-drive", label: "iCloud Drive", desc: "Import from iCloud Drive" },
          ].map((conn) => (
            <div key={conn.id} className="flex items-center justify-between">
              <div>
                <p className="text-sm text-foreground">{conn.label}</p>
                <p className="text-xs text-muted-foreground">{conn.desc}</p>
              </div>
              <span className="text-xs text-muted-foreground rounded-md border border-border px-2 py-1">
                Coming soon
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Recognition</h2>
        <p className="text-xs text-muted-foreground">
          Re-run AI recognition (OCR, object/scene labels, descriptions, and
          face detection) across your library. Runs on the local vision engine
          and processes assets in the background.
        </p>
        <div className="flex items-center justify-between gap-3 pt-1">
          <div>
            <p className="text-sm text-foreground">Re-scan assets</p>
            <p className="text-xs text-muted-foreground">Choose which assets to re-scan.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              aria-label="Re-scan scope"
              value={rescanScope}
              onChange={(e) => setRescanScope(e.target.value as "all" | "images" | "failed")}
              disabled={rescanBusy}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
            >
              <option value="all">All assets</option>
              <option value="images">Images only</option>
              <option value="failed">Failed / unprocessed</option>
            </select>
            <button
              onClick={handleRescanAll}
              disabled={rescanBusy}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {rescanBusy ? "Queuing…" : "Re-scan"}
            </button>
          </div>
        </div>
        {rescanMsg && <p className="text-xs text-muted-foreground">{rescanMsg}</p>}
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Members</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-foreground">Workspace members</p>
            <p className="text-xs text-muted-foreground">
              Invite collaborators as editors or viewers.
            </p>
          </div>
          <Link
            href="/app/settings/members"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
          >
            Manage members
          </Link>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">API access</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-foreground">Personal access tokens</p>
            <p className="text-xs text-muted-foreground">
              For the CLI, mobile app, and 3rd-party integrations.
            </p>
          </div>
          <Link
            href="/app/settings/tokens"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
          >
            Manage tokens
          </Link>
        </div>
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
