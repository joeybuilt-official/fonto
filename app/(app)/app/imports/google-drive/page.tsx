// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports/google-drive — Google Drive import. Reuses the existing Google
// OAuth (drive.readonly scope). When not connected, a prompt links to the
// server-side OAuth start. Once connected, a server-proxied folder browser lets
// the user walk folders, multi-select files, and import them. The browser never
// talks to the Drive API directly — every listing/download is proxied by our
// API routes (so the access token never reaches the client).
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  Folder,
  HardDrive,
  Home,
  Loader2,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ImportsList } from "../_components/imports-list";

interface DriveEntry {
  id: string;
  name: string;
  isDir: boolean;
  mimeType: string;
  size: number;
}

interface ImportSummary {
  imported: number;
  skipped: number;
  failed: Array<{ id: string; error: string }>;
  total: number;
}

interface Crumb {
  id: string;
  name: string;
}

const ROOT: Crumb = { id: "root", name: "My Drive" };

// The OAuth start (returnTo is advisory; the callback lands on the Google
// imports hub either way, from which the user can return here).
const CONNECT_URL =
  "/api/v1/integrations/google/auth?returnTo=/app/imports/google-drive";

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

export default function GoogleDriveImportPage() {
  // connected: null = still running the initial connection probe.
  const [connected, setConnected] = useState<boolean | null>(null);

  return (
    <div className="space-y-6 max-w-xl md:max-w-3xl">
      <div>
        <Link
          href="/app/imports"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Imports
        </Link>
        <h1 className="text-2xl font-semibold text-foreground mt-2">
          Import from Google Drive
        </h1>
      </div>

      {connected === false ? (
        <ConnectPrompt />
      ) : (
        <BrowseAndImport
          onConnectionResolved={setConnected}
          onNeedsReconnect={() => setConnected(false)}
        />
      )}

      <ImportsList />
    </div>
  );
}

function ConnectPrompt() {
  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <span className="shrink-0 rounded-md bg-muted p-2 text-foreground">
          <HardDrive className="h-5 w-5" aria-hidden="true" />
        </span>
        <p className="text-sm text-muted-foreground">
          Connect your Google account so Fonto can browse and import photos and
          documents from your Google Drive. Fonto requests read-only access.
        </p>
      </div>
      <a href={CONNECT_URL} className={buttonVariants()}>
        Connect Google Drive
      </a>
    </div>
  );
}

function BrowseAndImport({
  onConnectionResolved,
  onNeedsReconnect,
}: {
  onConnectionResolved: (connected: boolean) => void;
  onNeedsReconnect: () => void;
}) {
  // Navigation stack of folders drilled into; last item is the current folder.
  const [stack, setStack] = useState<Crumb[]>([ROOT]);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const current = stack[stack.length - 1];

  const loadFolder = useCallback(
    async (folderId: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/integrations/google-drive/browse?folderId=${encodeURIComponent(folderId)}`
        );
        const body = (await res.json().catch(() => ({}))) as {
          entries?: DriveEntry[];
          error?: string;
          needsReconnect?: boolean;
        };
        if (!res.ok) {
          if (body.needsReconnect) {
            onNeedsReconnect();
            return;
          }
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        onConnectionResolved(true);
        setEntries(body.entries ?? []);
      } catch (err) {
        setEntries([]);
        setError(
          err instanceof Error ? err.message : "Couldn't list that folder."
        );
      } finally {
        setLoading(false);
      }
    },
    [onConnectionResolved, onNeedsReconnect]
  );

  useEffect(() => {
    void loadFolder(current.id);
  }, [current.id, loadFolder]);

  function openFolder(entry: DriveEntry) {
    setStack((prev) => [...prev, { id: entry.id, name: entry.name }]);
  }

  function goTo(index: number) {
    setStack((prev) => prev.slice(0, index + 1));
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImport() {
    if (importing || selected.size === 0) return;
    setImporting(true);
    setSummary(null);
    setError(null);
    try {
      const res = await fetch("/api/v1/imports/google-drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: Array.from(selected) }),
      });
      const body = (await res.json().catch(() => ({}))) as ImportSummary & {
        error?: string;
        message?: string;
        needsReconnect?: boolean;
      };
      if (!res.ok) {
        if (body.needsReconnect) {
          onNeedsReconnect();
          return;
        }
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      if (body.needsReconnect) {
        setError(
          "Your Google connection expired mid-import. Reconnect to finish the rest."
        );
      }
      setSummary({
        imported: body.imported,
        skipped: body.skipped,
        failed: body.failed ?? [],
        total: body.total,
      });
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  const folders = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        {/* Breadcrumb navigation. */}
        <nav
          aria-label="Folder path"
          className="flex flex-wrap items-center gap-0.5 text-xs"
        >
          {stack.map((c, i) => (
            <span key={c.id} className="inline-flex items-center gap-0.5">
              {i > 0 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              <button
                type="button"
                onClick={() => goTo(i)}
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {i === 0 && <Home className="h-3.5 w-3.5" />}
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      </div>

      <div className="rounded-lg border border-border bg-card">
        {loading ? (
          <div className="divide-y divide-border">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted" />
                <div className="h-3.5 flex-1 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-6 space-y-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadFolder(current.id)}
            >
              Retry
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            This folder is empty.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {folders.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => openFolder(e)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted"
                >
                  <Folder className="h-4 w-4 shrink-0 text-primary-text" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {e.name}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
            {files.map((e) => {
              const isSel = selected.has(e.id);
              return (
                <li key={e.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(e.id)}
                      aria-label={`Select ${e.name}`}
                      className="h-4 w-4 shrink-0 accent-[var(--ft-color-primary)]"
                    />
                    <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {e.name}
                    </span>
                    {e.size > 0 && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatSize(e.size)}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Selection + import action bar. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {selected.size > 0
            ? `${selected.size} file${selected.size === 1 ? "" : "s"} selected`
            : "Select files to import"}
        </span>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={importing}
            >
              Clear
            </Button>
          )}
          <Button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            className="shrink-0"
          >
            {importing ? "Importing…" : "Import selected"}
          </Button>
        </div>
      </div>

      {summary && (
        <div className="rounded-lg border border-border bg-card p-4 text-sm space-y-1">
          <p className="font-medium text-foreground">
            Imported {summary.imported} of {summary.total}
            {summary.skipped > 0
              ? ` · ${summary.skipped} already in your library`
              : ""}
            {summary.failed.length > 0 ? ` · ${summary.failed.length} failed` : ""}
          </p>
          {summary.failed.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {summary.failed.slice(0, 8).map((f) => (
                <li key={f.id} className="truncate">
                  {f.id}: {f.error}
                </li>
              ))}
              {summary.failed.length > 8 && (
                <li>…and {summary.failed.length - 8} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
