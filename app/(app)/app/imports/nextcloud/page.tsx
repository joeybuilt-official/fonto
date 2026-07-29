// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports/nextcloud — Nextcloud (WebDAV) import. When not connected, a
// credential form (baseUrl + username + app password) POSTs to the connect
// route. Once connected, a server-proxied file browser lets the user walk
// folders, multi-select files, and import them. The browser never talks to
// Nextcloud directly — every listing/download is proxied by our API routes.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Cloud,
  File as FileIcon,
  Folder,
  Home,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImportsList } from "../_components/imports-list";

interface NextcloudEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
  contentType: string;
}

interface ImportSummary {
  imported: number;
  skipped: number;
  failed: Array<{ path: string; error: string }>;
  total: number;
}

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

// Split "/Photos/2024" → [{name:"Photos",path:"/Photos"},{name:"2024",path:"/Photos/2024"}].
function breadcrumbs(path: string): Array<{ name: string; path: string }> {
  const segs = path.split("/").filter(Boolean);
  const out: Array<{ name: string; path: string }> = [];
  let acc = "";
  for (const seg of segs) {
    acc += `/${seg}`;
    out.push({ name: seg, path: acc });
  }
  return out;
}

export default function NextcloudImportPage() {
  // status: null = still loading the initial connection check.
  const [connected, setConnected] = useState<boolean | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/integrations/nextcloud/status")
      .then((r) => r.json())
      .then((d: { connected?: boolean; baseUrl?: string }) => {
        if (cancelled) return;
        setConnected(Boolean(d.connected));
        setBaseUrl(d.baseUrl ?? null);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          Import from Nextcloud
        </h1>
      </div>

      {connected === null ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking connection…
          </div>
        </div>
      ) : connected ? (
        <BrowseAndImport
          baseUrl={baseUrl}
          onDisconnected={() => {
            setConnected(false);
            setBaseUrl(null);
          }}
        />
      ) : (
        <ConnectForm
          onConnected={(url) => {
            setBaseUrl(url);
            setConnected(true);
          }}
        />
      )}

      <ImportsList />
    </div>
  );
}

function ConnectForm({ onConnected }: { onConnected: (baseUrl: string) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    baseUrl.trim() && username.trim() && appPassword.trim() && !busy;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/integrations/nextcloud/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          username: username.trim(),
          appPassword,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onConnected(baseUrl.trim());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't connect to Nextcloud."
      );
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50";

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect your Nextcloud server so Fonto can read and import your photos.
        Use an{" "}
        <span className="font-medium text-foreground">app password</span>, not
        your login password — create one in Nextcloud under{" "}
        <span className="font-medium text-foreground">
          Settings → Security → Devices &amp; sessions
        </span>
        .
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">Server URL</span>
          <input
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={busy}
            placeholder="https://cloud.example.com"
            aria-label="Nextcloud server URL"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">Username</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            placeholder="your-nextcloud-user"
            aria-label="Nextcloud username"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">App password</span>
          <input
            type="password"
            autoComplete="off"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            disabled={busy}
            placeholder="xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
            aria-label="Nextcloud app password"
            className={inputClass}
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          {error ? (
            <span className="text-xs text-destructive">{error}</span>
          ) : (
            <span className="text-xs text-muted-foreground"> </span>
          )}
          <Button type="submit" disabled={!canSubmit} className="shrink-0">
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function BrowseAndImport({
  baseUrl,
  onDisconnected,
}: {
  baseUrl: string | null;
  onDisconnected: () => void;
}) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<NextcloudEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadPath = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/integrations/nextcloud/browse?path=${encodeURIComponent(p)}`
      );
      const body = (await res.json().catch(() => ({}))) as {
        entries?: NextcloudEntry[];
        error?: string;
        needsReconnect?: boolean;
      };
      if (!res.ok) {
        if (body.needsReconnect) {
          setError(
            "Your Nextcloud app password no longer works. Disconnect and reconnect to fix it."
          );
        }
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setEntries(body.entries ?? []);
    } catch (err) {
      setEntries([]);
      setError((prev) =>
        prev ??
        (err instanceof Error ? err.message : "Couldn't list that folder.")
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPath(path);
  }, [path, loadPath]);

  function toggle(p: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function handleImport() {
    if (importing || selected.size === 0) return;
    setImporting(true);
    setSummary(null);
    setError(null);
    try {
      const res = await fetch("/api/v1/imports/nextcloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: Array.from(selected) }),
      });
      const body = (await res.json().catch(() => ({}))) as ImportSummary & {
        error?: string;
        message?: string;
        needsReconnect?: boolean;
      };
      if (!res.ok) {
        if (body.needsReconnect) {
          setError(
            "Your Nextcloud app password no longer works. Disconnect and reconnect to fix it."
          );
        }
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      setSummary({
        imported: body.imported,
        skipped: body.skipped,
        failed: body.failed ?? [],
        total: body.total,
      });
      setSelected(new Set());
    } catch (err) {
      setError((prev) =>
        prev ??
        (err instanceof Error ? err.message : "Import failed.")
      );
    } finally {
      setImporting(false);
    }
  }

  async function handleDisconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await fetch("/api/v1/integrations/nextcloud/revoke", { method: "POST" });
    } catch {
      // Local row is source of truth; even a failed call leaves the UI safe to reset.
    } finally {
      setDisconnecting(false);
      onDisconnected();
    }
  }

  const crumbs = breadcrumbs(path);
  const folders = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            Connected{baseUrl ? ` to ${baseUrl}` : ""}
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="shrink-0"
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>

        {/* Breadcrumb navigation. */}
        <nav
          aria-label="Folder path"
          className="flex flex-wrap items-center gap-0.5 text-xs"
        >
          <button
            type="button"
            onClick={() => setPath("/")}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <Home className="h-3.5 w-3.5" /> Home
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className="inline-flex items-center gap-0.5">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                onClick={() => setPath(c.path)}
                className="rounded px-1 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
              >
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
            <Button variant="outline" size="sm" onClick={() => loadPath(path)}>
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
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => setPath(e.path)}
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
              const isSel = selected.has(e.path);
              return (
                <li key={e.path}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(e.path)}
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
                <li key={f.path} className="truncate">
                  {f.path}: {f.error}
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

// Icon kept exported-adjacent for the hub's provider registry parity (unused here).
export const NextcloudIcon = Cloud;
