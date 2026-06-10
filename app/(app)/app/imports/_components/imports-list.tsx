// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared imports-progress list. Polls GET /api/v1/imports every ~3s and renders
// per-job progress; stops polling once every job is terminal. Bump `reloadKey`
// to force an immediate refetch (e.g. right after a parent starts an import).
"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface ImportJob {
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

export function ImportsList({ reloadKey = 0 }: { reloadKey?: number }) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (cancelled) return;
      const list = await fetch("/api/v1/imports")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: { imports?: ImportJob[] }) => d.imports ?? [])
        .catch(() => null);
      if (cancelled) return;
      if (list === null) {
        setError(true);
        timer = setTimeout(loop, POLL_MS);
        return;
      }
      setError(false);
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
  }, [reloadKey]);

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <h2 className="text-sm font-semibold text-foreground">Imports</h2>
      {error && jobs.length === 0 ? (
        <p className="text-sm text-destructive">
          Couldn&apos;t load imports. Retrying…
        </p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No imports yet.</p>
      ) : (
        <ul className="space-y-4">
          {jobs.map((job) => {
            const total = job.itemsTotal || 0;
            const processed = job.itemsProcessed || 0;
            const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
            return (
              <li
                key={job.id}
                className="space-y-1.5 border-t border-border pt-4 first:border-t-0 first:pt-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {providerLabel(job.provider)}
                  </span>
                  <span
                    className={cn(
                      "text-xs font-medium capitalize",
                      statusBadgeClass(job.status)
                    )}
                  >
                    {job.status}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      job.status === "failed" ? "bg-destructive" : "bg-primary"
                    )}
                    style={{
                      width: `${total > 0 ? pct.toFixed(1) : job.status === "completed" ? 100 : 0}%`,
                    }}
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
  );
}
