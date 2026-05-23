// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2.5 share-link management modal.
//
// Lets a workspace owner:
//   - browse existing active shares for the current target
//   - create a new share with password / allowDownload / expiry / maxViews
//   - copy URLs, revoke shares, and inspect the last 50 views per share
//
// Render this from any "Share…" affordance — see <PhotoLightbox> for the
// asset case. Pass `targetType` + `targetId` and the dialog handles the rest.

"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Eye, Loader2, Lock, Trash2, X } from "lucide-react";

export type ShareTargetType = "asset" | "collection" | "set";

interface ShareRow {
  id: string;
  slug: string;
  targetType: ShareTargetType;
  targetId: string;
  allowDownload: boolean;
  maxViews: number | null;
  viewCount: number;
  expiresAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  passwordProtected: boolean;
}

interface ShareView {
  id: string;
  accessedAt: string;
  ipHash: string | null;
  userAgent: string | null;
  success: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  targetType: ShareTargetType;
  targetId: string;
}

const EXPIRY_PRESETS = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "Never", ms: 0 },
] as const;

function passwordStrengthHint(pw: string): string {
  if (!pw) return "";
  if (pw.length < 8) return "Short — consider 8+ chars.";
  if (!/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Add a digit + capital to strengthen.";
  return "Looks strong.";
}

export function ShareDialog({ open, onClose, targetType, targetId }: Props) {
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // Form state
  const [password, setPassword] = useState("");
  const [allowDownload, setAllowDownload] = useState(true);
  const [expiryMs, setExpiryMs] = useState<number>(7 * 24 * 60 * 60 * 1000);
  const [maxViews, setMaxViews] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Views drawer
  const [viewsOpenFor, setViewsOpenFor] = useState<string | null>(null);
  const [views, setViews] = useState<ShareView[]>([]);
  const [viewsLoading, setViewsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/v1/shares")
      .then((r) => r.json())
      .then((d: { shares?: ShareRow[] }) => {
        const all = d.shares ?? [];
        setShares(all.filter((s) => s.targetType === targetType && s.targetId === targetId));
      })
      .catch(() => setShares([]))
      .finally(() => setLoading(false));
  }, [open, targetType, targetId]);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        targetType,
        targetId,
        allowDownload,
      };
      if (password) body.password = password;
      if (expiryMs > 0) body.expiresAt = new Date(Date.now() + expiryMs).toISOString();
      const mv = Number(maxViews);
      if (maxViews && Number.isFinite(mv) && mv > 0) body.maxViews = Math.floor(mv);

      const res = await fetch("/api/v1/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setError(err.error ?? `Create failed (${res.status})`);
        return;
      }
      const created = (await res.json()) as ShareRow & { url: string };
      // Refresh list
      const listRes = await fetch("/api/v1/shares").then((r) => r.json());
      const all: ShareRow[] = listRes.shares ?? [];
      setShares(all.filter((s) => s.targetType === targetType && s.targetId === targetId));
      // Copy new URL automatically.
      try {
        await navigator.clipboard.writeText(created.url);
        setCopiedSlug(created.slug);
        setTimeout(() => setCopiedSlug(null), 2000);
      } catch {
        /* clipboard unavailable */
      }
      // Reset form.
      setPassword("");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    const res = await fetch(`/api/v1/shares/${id}`, { method: "DELETE" });
    if (res.ok) {
      setShares((prev) => prev.filter((s) => s.id !== id));
      if (viewsOpenFor === id) setViewsOpenFor(null);
    }
  }

  async function handleCopy(slug: string) {
    const url = `${window.location.origin}/share/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function handleOpenViews(id: string) {
    if (viewsOpenFor === id) {
      setViewsOpenFor(null);
      return;
    }
    setViewsOpenFor(id);
    setViewsLoading(true);
    try {
      const res = await fetch(`/api/v1/shares/${id}/views`);
      const data = (await res.json()) as { views?: ShareView[] };
      setViews(data.views ?? []);
    } finally {
      setViewsLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-xl border border-border bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Share link</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {/* Create form */}
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs font-semibold text-foreground">New share</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                Expiry
                <select
                  value={expiryMs}
                  onChange={(e) => setExpiryMs(Number(e.target.value))}
                  className="rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  {EXPIRY_PRESETS.map((p) => (
                    <option key={p.label} value={p.ms}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                Max views (optional)
                <input
                  type="number"
                  min={1}
                  value={maxViews}
                  onChange={(e) => setMaxViews(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1 text-xs"
                  placeholder="Unlimited"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Password (optional)
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for none"
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              />
              {password && (
                <span className="text-[10px] text-muted-foreground">
                  {passwordStrengthHint(password)}
                </span>
              )}
            </label>
            <label className="flex items-center gap-2 text-[11px] text-foreground">
              <input
                type="checkbox"
                checked={allowDownload}
                onChange={(e) => setAllowDownload(e.target.checked)}
              />
              Allow viewers to download the original
            </label>
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <button
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create link
            </button>
          </div>

          {/* Existing shares */}
          <div>
            <p className="mb-2 text-xs font-semibold text-foreground">Active shares</p>
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active shares.</p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-lg border border-border bg-card p-2"
                  >
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        /share/{s.slug}
                      </code>
                      {s.passwordProtected && (
                        <span title="Password protected" className="text-muted-foreground">
                          <Lock className="h-3 w-3" />
                        </span>
                      )}
                      <span
                        title="Views"
                        className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        <Eye className="h-3 w-3" />
                        {s.viewCount}
                        {s.maxViews !== null && <span>/{s.maxViews}</span>}
                      </span>
                      <button
                        onClick={() => handleCopy(s.slug)}
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title="Copy URL"
                      >
                        {copiedSlug === s.slug ? (
                          <Check className="h-3 w-3 text-green-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        onClick={() => handleOpenViews(s.id)}
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title="Recent views"
                      >
                        <Eye className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => handleRevoke(s.id)}
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                        title="Revoke"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                      {s.expiresAt ? (
                        <span>Expires {new Date(s.expiresAt).toLocaleString()}</span>
                      ) : (
                        <span>Never expires</span>
                      )}
                      {!s.allowDownload && <span>· No download</span>}
                      {s.lastAccessedAt && (
                        <span>· Last seen {new Date(s.lastAccessedAt).toLocaleString()}</span>
                      )}
                    </div>

                    {viewsOpenFor === s.id && (
                      <div className="mt-2 max-h-48 overflow-y-auto rounded border border-border bg-background p-2 text-[10px]">
                        {viewsLoading ? (
                          <p className="text-muted-foreground">Loading…</p>
                        ) : views.length === 0 ? (
                          <p className="text-muted-foreground">No views yet.</p>
                        ) : (
                          <ul className="space-y-1">
                            {views.map((v) => (
                              <li
                                key={v.id}
                                className={`flex items-center gap-2 ${
                                  v.success ? "" : "text-red-500"
                                }`}
                              >
                                <span className="font-mono">
                                  {new Date(v.accessedAt).toLocaleString()}
                                </span>
                                {!v.success && <span>(failed)</span>}
                                {v.userAgent && (
                                  <span className="ml-auto max-w-[50%] truncate text-muted-foreground">
                                    {v.userAgent}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
