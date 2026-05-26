// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

// Phase 7b — "Share to workspace" action for the photo lightbox.
//
// Self-contained popover button: on open, lists the caller's other
// workspaces (anything that isn't the asset's source workspace), lets
// them pick an access level, and POSTs to
// /api/v1/assets/:id/share/workspaces. Existing active shares appear
// inline with a Revoke button.
//
// Public share-LINKS (token URLs) are a separate feature — see the
// existing ShareDialog component invoked from MetadataPanel.

import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Loader2, Check, X } from "lucide-react";

interface UserWorkspace {
  id: string;
  name: string;
  role: string;
}

interface ShareRow {
  id: string;
  assetId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  accessLevel: string;
  createdBy: string;
  createdAt: string;
}

const ACCESS_LEVELS = ["viewer", "commenter", "contributor", "editor"] as const;
type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface AssetWorkspaceShareProps {
  assetId: string;
  sourceWorkspaceId: string;
}

export function AssetWorkspaceShare({ assetId, sourceWorkspaceId }: AssetWorkspaceShareProps) {
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<UserWorkspace[]>([]);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [targetId, setTargetId] = useState<string>("");
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("viewer");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [wsRes, shareRes] = await Promise.all([
        fetch("/api/v1/workspaces"),
        fetch(`/api/v1/assets/${assetId}/share/workspaces`),
      ]);
      if (wsRes.ok) {
        const wsData = (await wsRes.json()) as { workspaces?: UserWorkspace[] };
        const eligible = (wsData.workspaces ?? []).filter(
          (w) => w.id !== sourceWorkspaceId
        );
        setWorkspaces(eligible);
        if (eligible.length && !targetId) setTargetId(eligible[0].id);
      }
      if (shareRes.ok) {
        const shareData = (await shareRes.json()) as { shares?: ShareRow[] };
        setShares(shareData.shares ?? []);
      }
    } catch {
      // Surface in the error slot below.
    } finally {
      setLoading(false);
    }
  }, [assetId, sourceWorkspaceId, targetId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function handleShare() {
    if (!targetId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/assets/${assetId}/share/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetWorkspaceId: targetId, accessLevel }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(targetWorkspaceId: string) {
    const res = await fetch(
      `/api/v1/assets/${assetId}/share/workspaces/${targetWorkspaceId}`,
      { method: "DELETE" }
    );
    if (res.ok || res.status === 204) {
      await refresh();
    }
  }

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full p-1.5 transition-colors shrink-0 ${
          open ? "text-white bg-white/15" : "text-white/70 hover:text-white hover:bg-white/10"
        }`}
        title="Share to workspace"
      >
        <Users className="h-5 w-5" />
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-30 w-80 rounded-lg border border-border bg-popover p-3 shadow-xl text-sm">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
            Share to workspace
          </p>

          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : workspaces.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No other workspaces to share with.
            </p>
          ) : (
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-muted-foreground">Workspace</label>
                <select
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground">Access level</label>
                <select
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
                  className="mt-0.5 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                >
                  {ACCESS_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl}
                    </option>
                  ))}
                </select>
              </div>
              {error && <p className="text-[10px] text-destructive">{error}</p>}
              <button
                onClick={() => void handleShare()}
                disabled={submitting || !targetId}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                {submitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                Share
              </button>
            </div>
          )}

          {shares.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">
                Active shares
              </p>
              <ul className="space-y-1.5">
                {shares.map((s) => {
                  const ws = workspaces.find((w) => w.id === s.targetWorkspaceId);
                  return (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="truncate">
                        {ws?.name ?? s.targetWorkspaceId.slice(0, 8)}
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          ({s.accessLevel})
                        </span>
                      </span>
                      <button
                        onClick={() => void handleRevoke(s.targetWorkspaceId)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Revoke share"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
