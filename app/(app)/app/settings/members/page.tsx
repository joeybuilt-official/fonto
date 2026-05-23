// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Workspace member management UI (Phase 3.3).
//
// Two sections:
//  - Active members — pulled from /api/v1/workspace/members (Phase 3.1).
//    Until that endpoint lands the section degrades gracefully to a
//    "members endpoint not yet available" notice.
//  - Pending invitations — pulled from /api/v1/workspace/invitations.
//    Each row exposes Copy URL (re-show the plaintext link) and Revoke.
//  - Invite form — email + role dropdown. Posts to the same endpoint.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Role = "owner" | "editor" | "viewer";

interface InvitationSummary {
  id: string;
  workspaceId: string;
  email: string;
  role: "editor" | "viewer";
  token: string;
  url: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

interface MemberSummary {
  userId: string;
  email: string | null;
  name: string | null;
  role: Role;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function MembersSettingsPage() {
  const [invitations, setInvitations] = useState<InvitationSummary[] | null>(
    null
  );
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [membersUnavailable, setMembersUnavailable] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const reloadInvitations = useCallback(async () => {
    const res = await fetch("/api/v1/workspace/invitations");
    if (!res.ok) {
      setInvitations([]);
      return;
    }
    const body = (await res.json()) as { invitations: InvitationSummary[] };
    setInvitations(body.invitations);
  }, []);

  const reloadMembers = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/workspace/members");
      if (res.status === 404) {
        // Phase 3.1 endpoint hasn't shipped in this worktree yet.
        setMembersUnavailable(true);
        return;
      }
      if (!res.ok) {
        setMembers([]);
        return;
      }
      const body = (await res.json()) as { members: MemberSummary[] };
      setMembers(body.members ?? []);
    } catch {
      setMembersUnavailable(true);
    }
  }, []);

  useEffect(() => {
    reloadInvitations().catch(() => null);
    reloadMembers().catch(() => null);
  }, [reloadInvitations, reloadMembers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/v1/workspace/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        url?: string;
      };
      if (!res.ok) {
        setError(body.error ?? "Failed to create invitation");
        return;
      }
      setEmail("");
      setRole("viewer");
      await reloadInvitations();
      // Surface the URL immediately as a "copied" hint — but only if the
      // browser actually has clipboard access.
      if (body.url) {
        try {
          await navigator.clipboard.writeText(body.url);
          setCopiedToken(body.url);
          setTimeout(() => setCopiedToken(null), 2000);
        } catch {
          // Ignore — the table still has a Copy button per row.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this invitation? The link will stop working.")) return;
    const res = await fetch(
      `/api/v1/workspace/invitations/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? "Failed to revoke invitation");
      return;
    }
    await reloadInvitations();
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(url);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      alert("Copy failed — your browser blocked clipboard access");
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2">
        <Link
          href="/app/settings"
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Settings
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Members</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Invite people to your workspace and manage their access.
        </p>
      </div>

      {/* ── Active members ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Active members</h2>
        {membersUnavailable ? (
          <p className="text-xs text-muted-foreground">
            The members endpoint is not yet available in this build. The
            workspace owner is always a member by definition; invited users
            will appear here once they accept.
          </p>
        ) : members === null ? (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Just you. Invite someone below to collaborate.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex items-center justify-between py-2"
              >
                <div>
                  <p className="text-sm text-foreground">
                    {m.name ?? m.email ?? m.userId}
                  </p>
                  {m.email && m.name && (
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  )}
                </div>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {m.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Invite form ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">
          Invite a member
        </h2>
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="flex gap-2">
            <input
              type="email"
              required
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
              className="rounded border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button
              type="submit"
              disabled={creating}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#1D9089] disabled:opacity-60"
            >
              {creating ? "Sending…" : "Send invite"}
            </button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">
            Invitations expire in 7 days. Email delivery is not configured —
            copy the link from the table below and share it manually.
          </p>
        </form>
      </div>

      {/* ── Pending invitations ──────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">
          Pending invitations
        </h2>
        {invitations === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending invitations.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center justify-between py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {inv.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {inv.role} · expires {formatDate(inv.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopy(inv.url)}
                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    {copiedToken === inv.url ? "Copied" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRevoke(inv.id)}
                    className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/5"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
