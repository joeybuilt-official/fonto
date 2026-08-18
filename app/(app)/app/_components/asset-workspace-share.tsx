// SPDX-License-Identifier: MIT
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

import { useCallback, useEffect, useState } from "react";
import { Users, Loader2, Check, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

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
    <Popover open={open} onOpenChange={setOpen}>
      {/* text-white on photo-chrome top bar per ADR 0009 lightbox rule —
          overlay icons stay white-on-black regardless of system theme. */}
      <PopoverTrigger
        render={
          <button
            className={`rounded-full p-1.5 transition-colors shrink-0 ${
              open ? "text-white bg-white/15" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
            title="Share to workspace"
          >
            <Users className="h-5 w-5" />
          </button>
        }
      />

      {/* ADR 0009 phase 2 (group D) — peer/people object lives on an
          MD3 <Card variant="elevated"> surface. PopoverContent is
          stripped of its own bg/shadow/ring so the Card is the only
          visible chrome; the Popover keeps providing positioning,
          portal, and open/close animation. */}
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-80 bg-transparent p-0 shadow-none ring-0"
      >
        <Card variant="elevated" className="w-full">
          <CardHeader>
            <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)]">
              Share to workspace
            </p>
          </CardHeader>
          <CardContent className="pt-0">

        {loading ? (
          <div className="flex justify-center py-[var(--ft-space-4)]">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--ft-color-on-surface-variant)]" />
          </div>
        ) : workspaces.length === 0 ? (
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] italic text-[var(--ft-color-on-surface-variant)]">
            No other workspaces to share with.
          </p>
        ) : (
          <div className="space-y-[var(--ft-space-2)]">
            <div>
              <label className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Workspace
              </label>
              <Select<string>
                value={targetId}
                onValueChange={(v) => { if (v) setTargetId(v); }}
              >
                <SelectTrigger className="mt-0.5 h-9">
                  <SelectValue placeholder="Select workspace" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">
                Access level
              </label>
              <Select<AccessLevel>
                value={accessLevel}
                onValueChange={(v) => { if (v) setAccessLevel(v); }}
              >
                <SelectTrigger className="mt-0.5 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_LEVELS.map((lvl) => (
                    <SelectItem key={lvl} value={lvl}>
                      {lvl}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error && (
              <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-error)]">
                {error}
              </p>
            )}
            <Button
              onClick={() => void handleShare()}
              disabled={submitting || !targetId}
              variant="filled"
              size="sm"
              className="w-full"
            >
              {submitting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Share
            </Button>
          </div>
        )}

        {shares.length > 0 && (
          <div className="mt-[var(--ft-space-3)] border-t border-[var(--ft-color-outline-variant)] pt-[var(--ft-space-2)]">
            <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-widest text-[var(--ft-color-on-surface-variant)] mb-1.5">
              Active shares
            </p>
            <ul className="space-y-1.5">
              {shares.map((s) => {
                const ws = workspaces.find((w) => w.id === s.targetWorkspaceId);
                return (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-[var(--ft-space-2)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]"
                  >
                    <span className="truncate text-[var(--ft-color-on-surface)]">
                      {ws?.name ?? s.targetWorkspaceId.slice(0, 8)}
                      <span className="ml-1.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">
                        ({s.accessLevel})
                      </span>
                    </span>
                    <Button
                      size="icon-xs"
                      variant="text"
                      onClick={() => void handleRevoke(s.targetWorkspaceId)}
                      title="Revoke share"
                      className="text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-error)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
          </CardContent>
        </Card>
      </PopoverContent>
    </Popover>
  );
}
