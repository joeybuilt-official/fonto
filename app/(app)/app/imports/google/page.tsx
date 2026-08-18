// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports/google — Google Takeout import. Paste a Google Drive link (or a
// bare file ID) of the Takeout archive; we extract the file ID and kick a
// server-side import.
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { classifyDriveInput } from "@/lib/import/driveLink";
import { Button } from "@/components/ui/button";
import { ImportsList } from "../_components/imports-list";

const TAKEOUT_DOWNLOAD_HINT =
  "That's a Takeout download link — the server can't read it. Re-export with “Add to Drive” and paste the Drive link, or download the .zip and upload it below.";

interface Integration {
  provider: string;
  status: "active" | "needs_reconnect" | "revoked";
}

function GoogleImport() {
  const searchParams = useSearchParams();
  const justConnected = searchParams.get("connected") === "google";
  const oauthError = searchParams.get("error");

  const [googleConnected, setGoogleConnected] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Upload-a-downloaded-archive path.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/integrations")
      .then((r) => r.json())
      .then((d: { integrations?: Integration[] }) => {
        const g = (d.integrations ?? []).find((i) => i.provider === "google");
        setGoogleConnected(g?.status === "active");
      })
      .catch(() => null);
    fetch("/api/v1/workspace")
      .then((r) => r.json())
      .then((d) => setWorkspaceId(d.workspace?.id ?? null))
      .catch(() => null);
  }, []);

  const classified = classifyDriveInput(linkInput);
  const parsedId = classified.kind === "id" ? classified.fileId : null;
  const isTakeoutDownload = classified.kind === "takeout-download";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (isTakeoutDownload) {
      setMsg(TAKEOUT_DOWNLOAD_HINT);
      return;
    }
    if (!parsedId) {
      setMsg("That doesn't look like a Google Drive link or file ID. Paste the link to your Takeout archive in Drive.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/v1/imports/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driveFileId: parsedId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setLinkInput("");
      setMsg("Import started — watch its progress below.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed to start import.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (uploadBusy) return;
    if (!zipFile) {
      setUploadMsg("Choose a .zip archive first.");
      return;
    }
    if (!workspaceId) {
      setUploadMsg("Workspace not ready — try again in a moment.");
      return;
    }
    setUploadBusy(true);
    setUploadMsg(null);
    try {
      // provider=google-takeout so the worker applies Takeout sidecar metadata.
      const res = await fetch(
        `/api/v1/imports/upload?provider=google-takeout&workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "POST", headers: { "Content-Type": "application/zip" }, body: zipFile }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setZipFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadMsg("Upload received — import started. Watch its progress below.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setUploadMsg(err instanceof Error ? `Failed: ${err.message}` : "Upload failed.");
    } finally {
      setUploadBusy(false);
    }
  }

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
          Import from Google Takeout
        </h1>
      </div>

      {justConnected && (
        <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          Google connected. Paste your Takeout archive link below to start an import.
        </div>
      )}
      {oauthError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Google connection failed: {oauthError}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        {!googleConnected ? (
          <>
            <p className="text-sm text-muted-foreground">
              Connect Google first so Fonto can read the archive from your Drive.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="filled"
                size="sm"
                render={
                  <a href="/api/v1/integrations/google/auth?returnTo=/app/imports/google" />
                }
              >
                Connect Google
              </Button>
              <Link
                href="/app/settings"
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Manage in Settings → Integrations
              </Link>
            </div>
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
              <li>
                In Google Takeout, choose <span className="font-medium text-foreground">&ldquo;Add to Drive&rdquo;</span> as the export destination.
              </li>
              <li>
                Open the archive in Google Drive, click <span className="font-medium text-foreground">Share → Copy link</span> (or copy the address bar URL).
              </li>
              <li>Paste that link below.</li>
            </ol>
            <form onSubmit={handleSubmit} className="flex flex-col gap-2">
              <input
                type="text"
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                disabled={busy}
                aria-label="Google Drive link to your Takeout archive"
                placeholder="https://drive.google.com/file/d/…  (or a file ID)"
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {isTakeoutDownload
                    ? TAKEOUT_DOWNLOAD_HINT
                    : linkInput.trim() && !parsedId
                    ? "Couldn't find a Drive file ID in that text."
                    : parsedId
                      ? `Detected file ID: ${parsedId}`
                      : " "}
                </span>
                <button
                  type="submit"
                  disabled={busy || !parsedId}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
                >
                  {busy ? "Starting…" : "Start import"}
                </button>
              </div>
            </form>
            {msg && <p className="text-xs text-muted-foreground">{msg}</p>}

            <div className="border-t border-border pt-4 space-y-2">
              <p className="text-xs font-medium text-foreground">
                Or upload an archive you already downloaded
              </p>
              <p className="text-xs text-muted-foreground">
                Exported with &ldquo;Send download link&rdquo; instead? Those links
                can&apos;t be read by the server — download the <code>.zip</code> in
                your browser, then upload it here (dates, places and albums are kept).
              </p>
              <form
                onSubmit={handleUpload}
                className="flex flex-col sm:flex-row gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                  disabled={uploadBusy}
                  aria-label="Google Takeout ZIP archive"
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
              {uploadMsg && (
                <p className="text-xs text-muted-foreground">{uploadMsg}</p>
              )}
            </div>
          </>
        )}
      </div>

      <ImportsList reloadKey={reloadKey} />
    </div>
  );
}

export default function GoogleImportPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading…</div>}>
      <GoogleImport />
    </Suspense>
  );
}
