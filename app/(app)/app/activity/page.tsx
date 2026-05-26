// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 7a — workspace activity feed page.
//
// Cursor-paginated list of fonto.activity_events for the active
// workspace. Each entry renders a one-line summary, an actor label, a
// relative timestamp, and (when known) a deep link to the asset
// involved. "Load more" calls /api/v1/workspace/activity with the
// `createdBefore` cursor returned by the previous page.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Activity as ActivityIcon } from "lucide-react";

interface ActivityEvent {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  kind: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

function summarize(ev: ActivityEvent): { text: string; assetId: string | null } {
  const payload = ev.payload ?? {};
  const assetId =
    (typeof payload.assetId === "string" ? payload.assetId : null) ??
    (ev.targetType === "asset" ? ev.targetId : null);
  const actor = ev.actorUserId ? ev.actorUserId.slice(0, 8) : "someone";
  switch (ev.kind) {
    case "comment.posted": {
      const excerpt = typeof payload.excerpt === "string" ? payload.excerpt : "";
      return { text: `${actor} commented: ${excerpt}`, assetId };
    }
    case "comment.deleted":
      return { text: `${actor} deleted a comment`, assetId };
    case "asset.uploaded":
      return { text: `${actor} uploaded a new asset`, assetId };
    default:
      return { text: `${actor} · ${ev.kind}`, assetId };
  }
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const fetchPage = useCallback(async (createdBefore: string | null) => {
    const params = new URLSearchParams({ limit: "50" });
    if (createdBefore) params.set("createdBefore", createdBefore);
    const res = await fetch(`/api/v1/workspace/activity?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { events: ActivityEvent[]; nextCursor: string | null };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchPage(null);
        if (cancelled) return;
        setEvents(data.events);
        setCursor(data.nextCursor);
        setDone(data.nextCursor === null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function handleLoadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(cursor);
      setEvents((prev) => [...prev, ...data.events]);
      setCursor(data.nextCursor);
      setDone(data.nextCursor === null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center gap-3 mb-6">
        <ActivityIcon className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Activity</h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          No activity yet. Comments, uploads, and shares will show up here.
        </p>
      ) : (
        <ol className="space-y-3">
          {events.map((ev) => {
            const s = summarize(ev);
            return (
              <li key={ev.id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm text-foreground">
                    {s.assetId ? (
                      <Link
                        href={`/app/photos?asset=${s.assetId}`}
                        className="hover:underline"
                      >
                        {s.text}
                      </Link>
                    ) : (
                      s.text
                    )}
                  </p>
                  <span
                    className="text-xs text-muted-foreground shrink-0"
                    title={new Date(ev.createdAt).toLocaleString()}
                  >
                    {formatRelative(ev.createdAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {!loading && !done && events.length > 0 && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="rounded-md border border-input bg-background px-4 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {loadingMore ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </span>
            ) : (
              "Load more"
            )}
          </button>
        </div>
      )}
    </div>
  );
}
