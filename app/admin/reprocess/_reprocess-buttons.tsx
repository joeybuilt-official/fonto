// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M5d — client button list for /admin/reprocess. Each button POSTs `{ job }`
// to the /api/v1/admin/reprocess route; the worker performs the actual
// repair. Client component inside a server-gated page shell.

"use client";

import { useState } from "react";

type JobKey =
  | "thumbnails"
  | "clip"
  | "auto-cluster"
  | "evidence"
  | "inference"
  | "face-crops"
  | "reap-stuck";

interface JobDef {
  key: JobKey;
  title: string;
  description: string;
  label: string;
}

const JOBS: readonly JobDef[] = [
  {
    key: "thumbnails",
    title: "Backfill thumbnails",
    description: "Generate thumbnails for active image/video/PDF rows that have none. Safe to re-run.",
    label: "Run thumbnail backfill",
  },
  {
    key: "clip",
    title: "Backfill CLIP vectors",
    description: "Embed CLIP vectors for active images missing one (restores semantic search coverage).",
    label: "Run CLIP backfill",
  },
  {
    key: "auto-cluster",
    title: "Auto-cluster faces",
    description: "Cluster faces into People across every workspace with face data. Idempotent.",
    label: "Cluster faces now",
  },
  {
    key: "evidence",
    title: "Backfill evidence",
    description: "Enqueue evidence extraction for assets without evidence rows. Resumable, bounded batch.",
    label: "Run evidence backfill",
  },
  {
    key: "inference",
    title: "Backfill inference",
    description: "Enqueue date inference for assets with evidence but no proposal. Resumable, bounded batch.",
    label: "Run inference backfill",
  },
  {
    key: "face-crops",
    title: "Backfill face crops",
    description: "Generate face-crop derivatives for existing faces. Idempotent, bounded batch.",
    label: "Run face-crop backfill",
  },
  {
    key: "reap-stuck",
    title: "Reap stuck assets",
    description: "Re-trigger any asset wedged in a non-terminal processing state past the threshold.",
    label: "Reap stuck assets now",
  },
];

export function ReprocessButtons() {
  const [pending, setPending] = useState<JobKey | null>(null);
  const [result, setResult] = useState<{ key: JobKey; ok: boolean; msg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function trigger(job: JobDef) {
    setPending(job.key);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/v1/admin/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: job.key }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({
          key: job.key,
          ok: false,
          msg: (body?.error as string) ?? `HTTP ${res.status}`,
        });
      } else {
        setResult({
          key: job.key,
          ok: true,
          msg: `Enqueued ${(body?.enqueued as string) ?? job.key}.`,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {error && (
        <div role="alert" className="mb-4 rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <ul className="space-y-3">
        {JOBS.map((job) => (
          <li
            key={job.key}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-4"
          >
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{job.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{job.description}</p>
              {result?.key === job.key && (
                <p
                  className={`mt-2 text-xs font-medium ${result.ok ? "text-emerald-600" : "text-destructive"}`}
                >
                  {result.msg}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => trigger(job)}
              className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {pending === job.key ? "Enqueuing…" : job.label}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}