// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

// Phase 7a — comments side-drawer for the photo lightbox.
//
// Self-contained: fetches comments for the open asset on mount + on
// asset change, owns a post form + delete actions. The lightbox passes
// in the current asset id + a `currentUserId` so we can render the
// delete-mine action without an extra round-trip for identity.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Trash2 } from "lucide-react";

interface CommentRow {
  id: string;
  assetId: string;
  workspaceId: string;
  userId: string;
  body: string;
  parentId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentsPanelProps {
  assetId: string;
  currentUserId: string | null;
  // Whether the caller can moderate (delete others' comments). Lightbox
  // computes this from the workspace role; passing it in avoids a per-
  // panel /me round-trip.
  canModerate: boolean;
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

export function CommentsPanel({ assetId, currentUserId, canModerate }: CommentsPanelProps) {
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/assets/${assetId}/comments`);
      if (!res.ok) {
        setComments([]);
        return;
      }
      const data = (await res.json()) as { comments: CommentRow[] };
      setComments(data.comments ?? []);
    } catch {
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/assets/${assetId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Post failed (${res.status})`);
        return;
      }
      setDraft("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setPosting(false);
    }
  }

  async function handleDelete(commentId: string) {
    const res = await fetch(`/api/v1/assets/${assetId}/comments/${commentId}`, {
      method: "DELETE",
    });
    if (res.ok || res.status === 204) {
      await refresh();
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-sm shrink-0 flex-col border-l border-border bg-card text-sm sm:static sm:inset-auto sm:z-auto sm:w-80 sm:max-w-none">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Comments
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : comments.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No comments yet.</p>
        ) : (
          comments.map((c) => {
            const isDeleted = c.deletedAt !== null;
            const isMine = currentUserId !== null && c.userId === currentUserId;
            const canDelete = !isDeleted && (isMine || canModerate);
            return (
              <div key={c.id} className="group">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-foreground truncate">
                    {isMine ? "You" : c.userId.slice(0, 8)}
                  </span>
                  <span
                    className="text-[10px] text-muted-foreground shrink-0"
                    title={new Date(c.createdAt).toLocaleString()}
                  >
                    {formatRelative(c.createdAt)}
                  </span>
                </div>
                <p
                  className={`mt-0.5 whitespace-pre-wrap break-words text-xs ${
                    isDeleted ? "italic text-muted-foreground" : "text-foreground"
                  }`}
                >
                  {isDeleted ? "[deleted]" : c.body}
                </p>
                {canDelete && (
                  <button
                    onClick={() => void handleDelete(c.id)}
                    className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="h-3 w-3" />
                    delete
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={handlePost}
        className="border-t border-border p-3 flex flex-col gap-2"
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment…"
          rows={2}
          maxLength={10_240}
          className="resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handlePost(e as unknown as React.FormEvent);
            }
          }}
        />
        {error && <p className="text-[10px] text-destructive">{error}</p>}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">⌘+Enter to send</span>
          <button
            type="submit"
            disabled={!draft.trim() || posting}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            {posting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Post
          </button>
        </div>
      </form>
    </div>
  );
}
