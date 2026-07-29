// SPDX-License-Identifier: MIT
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
import { Check, Copy, Eye, Loader2, Lock, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "@/components/ui/text-field";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Share link</DialogTitle>
        </DialogHeader>

        <div className="space-y-[var(--ft-space-5)]">
          {/* Create form */}
          <div className="space-y-[var(--ft-space-3)] rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] p-[var(--ft-space-3)]">
            <p className="text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-surface)]">
              New share
            </p>
            <div className="grid grid-cols-2 gap-[var(--ft-space-2)]">
              <TextField className="gap-[var(--ft-space-1)]">
                <TextFieldLabel>Expiry</TextFieldLabel>
                <Select<number>
                  value={expiryMs}
                  onValueChange={(v) => setExpiryMs(v as number)}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_PRESETS.map((p) => (
                      <SelectItem key={p.label} value={p.ms}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TextField>
              <TextField variant="outlined">
                <TextFieldLabel>Max views (optional)</TextFieldLabel>
                <TextFieldInput
                  type="number"
                  min={1}
                  value={maxViews}
                  onChange={(e) => setMaxViews(e.target.value)}
                  placeholder="Unlimited"
                />
              </TextField>
            </div>
            <TextField variant="outlined">
              <TextFieldLabel>Password (optional)</TextFieldLabel>
              <TextFieldInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for none"
              />
              {password && (
                <span className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                  {passwordStrengthHint(password)}
                </span>
              )}
            </TextField>
            <label className="flex items-center gap-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)]">
              <Switch
                checked={allowDownload}
                onCheckedChange={setAllowDownload}
              />
              Allow viewers to download the original
            </label>
            {error && (
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]">
                {error}
              </p>
            )}
            <Button onClick={handleCreate} disabled={creating} size="sm">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create link
            </Button>
          </div>

          {/* Existing shares */}
          <div>
            <p className="mb-[var(--ft-space-2)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-on-surface)]">
              Active shares
            </p>
            {loading ? (
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">No active shares.</p>
            ) : (
              <ul className="space-y-[var(--ft-space-2)]">
                {shares.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-[var(--ft-shape-medium)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] p-[var(--ft-space-2)]"
                  >
                    <div className="flex items-center gap-[var(--ft-space-2)]">
                      <code className="flex-1 truncate font-mono text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                        /share/{s.slug}
                      </code>
                      {s.passwordProtected && (
                        <span title="Password protected" className="text-[var(--ft-color-on-surface-variant)]">
                          <Lock className="h-3 w-3" />
                        </span>
                      )}
                      <span
                        title="Views"
                        className="inline-flex items-center gap-[var(--ft-space-1)] rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container-high)] px-[var(--ft-space-2)] py-0.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]"
                      >
                        <Eye className="h-3 w-3" />
                        {s.viewCount}
                        {s.maxViews !== null && <span>/{s.maxViews}</span>}
                      </span>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => handleCopy(s.slug)}
                        title="Copy URL"
                      >
                        {copiedSlug === s.slug ? (
                          <Check className="h-3 w-3 text-[var(--ft-color-success)]" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => handleOpenViews(s.id)}
                        title="Recent views"
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="destructive"
                        onClick={() => handleRevoke(s.id)}
                        title="Revoke"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="mt-[var(--ft-space-1)] flex flex-wrap gap-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-surface-variant)]">
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
                      <div className="mt-[var(--ft-space-2)] max-h-48 overflow-y-auto rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] p-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)]">
                        {viewsLoading ? (
                          <p className="text-[var(--ft-color-on-surface-variant)]">Loading…</p>
                        ) : views.length === 0 ? (
                          <p className="text-[var(--ft-color-on-surface-variant)]">No views yet.</p>
                        ) : (
                          <ul className="space-y-[var(--ft-space-1)]">
                            {views.map((v) => (
                              <li
                                key={v.id}
                                className={`flex items-center gap-[var(--ft-space-2)] ${
                                  v.success ? "" : "text-[var(--ft-color-error)]"
                                }`}
                              >
                                <span className="font-mono">
                                  {new Date(v.accessedAt).toLocaleString()}
                                </span>
                                {!v.success && <span>(failed)</span>}
                                {v.userAgent && (
                                  <span className="ml-auto max-w-[50%] truncate text-[var(--ft-color-on-surface-variant)]">
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
      </DialogContent>
    </Dialog>
  );
}
