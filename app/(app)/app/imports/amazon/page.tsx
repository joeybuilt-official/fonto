// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// /app/imports/amazon — Amazon Photos import. Pick a .zip and POST it as the
// raw request body (Content-Type: application/zip) to the streaming endpoint.
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ImportsList } from "../_components/imports-list";

export default function AmazonImportPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    fetch("/api/v1/workspace")
      .then((r) => r.json())
      .then((d) => setWorkspaceId(d.workspace?.id ?? null))
      .catch(() => null);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!zipFile) {
      setMsg("Choose a .zip file first.");
      return;
    }
    if (!workspaceId) {
      setMsg("Workspace not ready — try again in a moment.");
      return;
    }
    setBusy(true);
    setMsg(null);
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
      setMsg("Upload received — import started. Watch its progress below.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setMsg(err instanceof Error ? `Failed: ${err.message}` : "Upload failed.");
    } finally {
      setBusy(false);
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
          Import from Amazon Photos
        </h1>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <p className="text-xs text-muted-foreground">
          Upload a ZIP exported from Amazon Photos. Large files stream directly
          to the server.
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
            disabled={busy}
            aria-label="Amazon Photos ZIP file"
            className="flex-1 text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !zipFile}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
          >
            {busy ? "Uploading…" : "Upload & import"}
          </button>
        </form>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </div>

      <ImportsList reloadKey={reloadKey} />
    </div>
  );
}
