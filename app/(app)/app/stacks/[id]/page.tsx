// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5.5 — /app/stacks/[id] stack detail.
//
// Reads GET /api/v1/stacks/:id (returns stack + member assets sorted
// primary-first) and renders:
//
//   - Header: name (inline-editable), member count, "Dissolve" action
//   - Member grid: every member as a square thumb. Click sets that
//     member as the new primary (PATCH /api/v1/stacks/:id w/
//     primaryAssetId). Hover reveals a remove button (DELETE
//     /api/v1/stacks/:id/assets/:assetId — if the removed asset was
//     the primary, the API auto-promotes the next-oldest member;
//     removing the last member deletes the stack row entirely).
//
// Lightbox carousel (per audit phase 5.5 follow-up notes) is still
// queued — clicking a member today just sets it as primary, not opens
// it in the lightbox. That's a separate change to PhotoLightbox.

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Check, Layers, Loader2, Pencil, Trash2, X } from "lucide-react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  classification: string | null;
  capturedAt: string | null;
  createdAt: string;
}

interface Stack {
  id: string;
  name: string | null;
  primaryAssetId: string;
  workspaceId: string;
  createdAt: string;
}

function StackDetailContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const stackId = params.id;

  const [stack, setStack] = useState<Stack | null>(null);
  const [members, setMembers] = useState<Asset[]>([]);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/stacks/${stackId}`);
      if (!r.ok) {
        setError(r.status === 404 ? "Stack not found." : `Load failed (${r.status}).`);
        return;
      }
      const d = (await r.json()) as { stack: Stack; assets: Asset[] };
      setStack(d.stack);
      setMembers(d.assets ?? []);
      setNameDraft(d.stack.name ?? "");

      if (d.assets && d.assets.length > 0) {
        const urlRes = await fetch("/api/v1/assets/urls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: d.assets.map((a) => a.id),
            variant: "thumb",
          }),
        });
        const urlData = (await urlRes.json()) as { urls?: Record<string, string> };
        setThumbUrls(urlData.urls ?? {});
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [stackId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setPrimary(assetId: string) {
    if (!stack || assetId === stack.primaryAssetId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/stacks/${stackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryAssetId: assetId }),
      });
      if (r.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(assetId: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/stacks/${stackId}/assets/${assetId}`, {
        method: "DELETE",
      });
      if (r.ok) {
        // If we removed the last member, the API also deleted the stack
        // row; treat as dissolved and bounce back to the list.
        if (members.length <= 1) {
          router.push("/app/stacks");
          return;
        }
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function dissolveStack() {
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/stacks/${stackId}`, { method: "DELETE" });
      if (r.ok) router.push("/app/stacks");
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    if (!stack) return;
    const next = nameDraft.trim() || null;
    if (next === stack.name) {
      setEditingName(false);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/stacks/${stackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (r.ok) {
        setEditingName(false);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !stack) {
    return (
      <div className="space-y-3 px-4 py-6">
        <button
          onClick={() => router.push("/app/stacks")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Stacks
        </button>
        <p className="text-sm text-destructive">{error ?? "Stack not found."}</p>
      </div>
    );
  }

  const primary = members.find((m) => m.id === stack.primaryAssetId) ?? members[0];

  return (
    <div className="space-y-4 px-4 py-3">
      <button
        onClick={() => router.push("/app/stacks")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Stacks
      </button>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {primary && thumbUrls[primary.id] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbUrls[primary.id]}
              alt={primary.filename}
              className="h-full w-full object-cover"
            />
          ) : (
            <Layers className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editingName ? (
              <>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") {
                      setEditingName(false);
                      setNameDraft(stack.name ?? "");
                    }
                  }}
                  autoFocus
                  placeholder={primary?.filename ?? "Stack name"}
                  className="rounded-md border border-border bg-background px-2 py-1 text-base font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Button size="sm" onClick={() => void saveName()} disabled={busy}>
                  <Check className="h-3.5 w-3.5" />
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingName(false);
                    setNameDraft(stack.name ?? "");
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <h1 className="font-heading text-lg font-semibold text-foreground">
                  {stack.name ?? primary?.filename ?? "Untitled stack"}
                </h1>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setEditingName(true)}
                  aria-label="Edit name"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {members.length} {members.length === 1 ? "member" : "members"} ·
            created {new Date(stack.createdAt).toLocaleDateString()}
          </p>
        </div>
        <ConfirmButton
          onConfirm={dissolveStack}
          className="flex h-8 items-center gap-1.5 rounded-md bg-destructive/10 px-3 text-sm font-medium text-destructive hover:bg-destructive/20"
          armedClassName="bg-destructive/20 ring-1 ring-destructive"
          confirmLabel={
            <span className="flex items-center gap-1.5 font-bold">
              <Trash2 className="h-3.5 w-3.5" />
              Dissolve stack?
            </span>
          }
        >
          <Trash2 className="h-3.5 w-3.5" />
          Dissolve
        </ConfirmButton>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {members.map((m) => {
          const isPrimary = m.id === stack.primaryAssetId;
          return (
            <div key={m.id} className="group relative">
              <button
                onClick={() => void setPrimary(m.id)}
                disabled={busy || isPrimary}
                className={cn(
                  "block w-full aspect-square overflow-hidden rounded-lg bg-muted transition-all",
                  isPrimary
                    ? "ring-2 ring-primary ring-offset-2 ring-offset-background cursor-default"
                    : "hover:ring-2 hover:ring-muted-foreground/40"
                )}
                title={isPrimary ? "Primary member" : "Set as primary"}
              >
                {thumbUrls[m.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbUrls[m.id]}
                    alt={m.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <Layers className="h-6 w-6" />
                  </div>
                )}
                {isPrimary && (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                    Primary
                  </span>
                )}
              </button>
              <button
                onClick={() => void removeMember(m.id)}
                disabled={busy}
                className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white hover:bg-destructive group-hover:flex disabled:opacity-50"
                title="Remove from stack"
                aria-label={`Remove ${m.filename}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <p className="mt-1 truncate text-[11px] text-muted-foreground" title={m.filename}>
                {m.filename}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function StackDetailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <StackDetailContent />
    </Suspense>
  );
}
