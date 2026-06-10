// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 (media import) — /app/imports
//
// Minimal-but-real import surface:
//   - Google Takeout: paste a Drive file ID of the Takeout archive (no Drive
//     picker yet — that's a later enhancement) and kick a server-side import.
//   - Amazon Photos: pick a .zip and POST it as the RAW request body
//     (Content-Type: application/zip) to the streaming upload endpoint.
//   - Imports list: polls GET /api/v1/imports every ~3s and renders per-job
//     progress; stops polling once every job is terminal.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

interface ImportJob {
  id: string;
  provider: string;
  status: "pending" | "running" | "completed" | "failed";
  itemsTotal: number;
  itemsProcessed: number;
  itemsDeduped: number;
  itemsFailed: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Integration {
  provider: string;
  status: "active" | "needs_reconnect" | "revoked";
}

const POLL_MS = 3000;
const TERMINAL = new Set(["completed", "failed"]);

function providerLabel(provider: string): string {
  if (provider === "google-takeout") return "Google Takeout";
  if (provider === "amazon-photos") return "Amazon Photos";
  return provider;
}

function statusBadgeClass(status: ImportJob["status"]): string {
  switch (status) {
    case "completed":
      return "text-green-600 dark:text-green-500";
    case "failed":
      return "text-destructive";
    case "running":
      return "text-primary";
    default:
      return "text-muted-foreground";
  }
}

export default function ImportsPage() {
  const searchParams = useSearchParams();
  const connected = searchParams.get("connected");
  const oauthError = searchParams.get("error");

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [jobs, setJobs] = useState<ImportJob[]>([]);

  // Google Takeout form
  const [driveFileId, setDriveFileId] = useState("");
  const [takeoutBusy, setTakeoutBusy] = useState(false);
  const [takeoutMsg, setTakeoutMsg] = useState<string | null>(null);

  // Amazon ZIP upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/workspace")
      .then((r) => r.json())
      .then((d) => setWorkspaceId(d.workspace?.id ?? null))
      .catch(() => null);
    fetch("/api/v1/integrations")
      .then((r) => r.json())
      .then((d: { integrations?: Integration[] }) => {
        const g = (d.integrations ?? []).find((i) => i.provider === "google");
        setGoogleConnected(g?.status === "active");
      })
      .catch(() => null);
  }, []);

  const fetchJobs = useCallback(() => {
    return fetch("/api/v1/imports")
      .then((r) => r.json())
      .then((d: { imports?: ImportJob[] }) => setJobs(d.imports ?? []))
      .catch(() => null);
  }, []);

  // Poll while any job is non-terminal; stop once everything is terminal.
  // `pollWhileActive` re-arms itself only when an active job remains, so a
  // fully-finished list quiesces instead of polling forever.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (cancelled) return;
      const list = await fetch("/api/v1/imports")
        .then((r) => r.json())
        .then((d: { imports?: ImportJob[] }) => d.imports ?? [])
        .catch(() => null);
      if (cancelled || list === null) return;
      setJobs(list);
      if (list.some((j) => !TERMINAL.has(j.status))) {
        timer = setTimeout(loop, POLL_MS);
      }
    };

    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Re-arm after a manual fetchJobs() (e.g. just-submitted import) bumps
    // `jobs` with a fresh non-terminal row.
  }, [jobs.length]);

  async function handleTakeoutSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (takeoutBusy) return;
    const id = driveFileId.trim();
    if (!id) return;
    setTakeoutBusy(true);
    setTakeoutMsg(null);
    try {
      const res = await fetch("/api/v1/imports/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driveFileId: id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDriveFileId("");
      setTakeoutMsg("Import started — watch its progress below.");
      fetchJobs();
    } catch (err) {
      setTakeoutMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed to start import.");
    } finally {
      setTakeoutBusy(false);
    }
  }

  async function handleZipSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (uploadBusy) return;
    if (!zipFile) {
      setUploadMsg("Choose a .zip file first.");
      return;
    }
    if (!workspaceId) {
      setUploadMsg("Workspace not ready — try again in a moment.");
      return;
    }
    setUploadBusy(true);
    setUploadMsg(null);
    try {
      // The upload endpoint expects the raw ZIP bytes as the body (NOT
      // multipart/form-data). Passing a File to fetch streams it directly.
      const res = await fetch(
        `/api/v1/imports/upload?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/zip" },
          body: zipFile,
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setZipFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadMsg("Upload received — import started. Watch its progress below.");
      fetchJobs();
    } catch (err) {
      setUploadMsg(err instanceof Error ? `Failed: ${err.message}` : "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-xl md:max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Imports</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Bring your existing photo library into Fonto.
        </p>
      </div>

      {connected === "google" && (
        <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          Google connected. Paste a Takeout archive file ID below to start an import.
        </div>
      )}
      {oauthError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Google connection failed: {oauthError}
        </div>
      )}

      {/* Google Takeout */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Import from Google Takeout</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {googleConnected
              ? "Paste the Google Drive file ID of your Takeout archive (.zip or .tgz)."
              : "Connect Google in Settings → Integrations first."}
          </p>
        </div>
        <form onSubmit={handleTakeoutSubmit} className="flex flex-col sm:flex-row gap-2">
          {/* Minimal entry — no Drive picker yet (planned enhancement). */}
          <input
            type="text"
            value={driveFileId}
            onChange={(e) => setDriveFileId(e.target.value)}
            disabled={!googleConnected || takeoutBusy}
            aria-label="Google Drive file ID of your Takeout archive"
            placeholder="Drive file ID, e.g. 1aBcD..."
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!googleConnected || takeoutBusy || !driveFileId.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
          >
            {takeoutBusy ? "Starting…" : "Start import"}
          </button>
        </form>
        {takeoutMsg && <p className="text-xs text-muted-foreground">{takeoutMsg}</p>}
        {!googleConnected && (
          <a href="/app/settings" className="inline-block text-xs font-medium text-primary hover:underline">
            Go to Settings → Integrations
          </a>
        )}
      </div>

      {/* Amazon Photos ZIP */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Import from Amazon Photos</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Upload a ZIP exported from Amazon Photos. Large files stream directly to the server.
          </p>
        </div>
        <form onSubmit={handleZipSubmit} className="flex flex-col sm:flex-row gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
            disabled={uploadBusy}
            className="flex-1 text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={uploadBusy || !zipFile}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
          >
            {uploadBusy ? "Uploading…" : "Upload & import"}
          </button>
        </form>
        {uploadMsg && <p className="text-xs text-muted-foreground">{uploadMsg}</p>}
      </div>

      {/* Imports list */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Imports</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          <ul className="space-y-4">
            {jobs.map((job) => {
              const total = job.itemsTotal || 0;
              const processed = job.itemsProcessed || 0;
              const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
              return (
                <li key={job.id} className="space-y-1.5 border-t border-border pt-4 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {providerLabel(job.provider)}
                    </span>
                    <span className={cn("text-xs font-medium capitalize", statusBadgeClass(job.status))}>
                      {job.status}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        job.status === "failed" ? "bg-destructive" : "bg-primary"
                      )}
                      style={{ width: `${total > 0 ? pct.toFixed(1) : job.status === "completed" ? 100 : 0}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      {processed}
                      {total > 0 ? ` / ${total}` : ""} processed
                    </span>
                    {job.itemsDeduped > 0 && <span>{job.itemsDeduped} deduped</span>}
                    {job.itemsFailed > 0 && (
                      <span className="text-destructive">{job.itemsFailed} failed</span>
                    )}
                  </div>
                  {job.status === "failed" && job.error && (
                    <p className="text-xs text-destructive">{job.error}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
