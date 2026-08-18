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
import { ConfirmButton } from "@/components/confirm-button";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextField,
  TextFieldInput,
} from "@/components/ui";

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
  const [membersError, setMembersError] = useState(false);
  const [invitationsError, setInvitationsError] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const reloadInvitations = useCallback(async () => {
    setInvitationsError(false);
    try {
      const res = await fetch("/api/v1/workspace/invitations");
      if (!res.ok) {
        // A 401/500 is NOT an empty workspace — surface it instead of
        // rendering the "No pending invitations." empty state.
        setInvitationsError(true);
        return;
      }
      const body = (await res.json()) as { invitations: InvitationSummary[] };
      setInvitations(body.invitations);
    } catch {
      setInvitationsError(true);
    }
  }, []);

  const reloadMembers = useCallback(async () => {
    setMembersError(false);
    try {
      const res = await fetch("/api/v1/workspace/members");
      if (res.status === 404) {
        // Phase 3.1 endpoint hasn't shipped in this worktree yet.
        setMembersUnavailable(true);
        return;
      }
      if (!res.ok) {
        // Distinguish a real failure from a genuinely empty member list.
        setMembersError(true);
        return;
      }
      const body = (await res.json()) as { members: MemberSummary[] };
      setMembers(body.members ?? []);
    } catch {
      setMembersError(true);
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
    setError(null);
    const res = await fetch(
      `/api/v1/workspace/invitations/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Failed to revoke invitation");
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
      setError("Copy failed — your browser blocked clipboard access");
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2">
        <Link
          href="/app/settings"
          className="text-xs text-[var(--ft-color-on-surface-variant)] hover:underline"
        >
          ← Settings
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-semibold text-[var(--ft-color-on-surface)]">Members</h1>
        <p className="text-sm text-[var(--ft-color-on-surface-variant)] mt-1">
          Invite people to your workspace and manage their access.
        </p>
      </div>

      {/* ── Active members ───────────────────────────────────────────── */}
      <Card variant="outlined" className="space-y-4 p-6">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold">Active members</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
        {membersUnavailable ? (
          <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
            The members endpoint is not yet available in this build. The
            workspace owner is always a member by definition; invited users
            will appear here once they accept.
          </p>
        ) : membersError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[var(--ft-color-error)]">
              Couldn&apos;t load members.
            </p>
            <Button
              variant="outlined"
              size="sm"
              onClick={() => void reloadMembers()}
            >
              Retry
            </Button>
          </div>
        ) : members === null ? (
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">Loading members…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
            Just you. Invite someone below to collaborate.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex items-center justify-between py-2"
              >
                <div>
                  <p className="text-sm text-[var(--ft-color-on-surface)]">
                    {m.name ?? m.email ?? m.userId}
                  </p>
                  {m.email && m.name && (
                    <p className="text-xs text-[var(--ft-color-on-surface-variant)]">{m.email}</p>
                  )}
                </div>
                <span className="text-xs uppercase tracking-wide text-[var(--ft-color-on-surface-variant)]">
                  {m.role}
                </span>
              </li>
            ))}
          </ul>
        )}
        </CardContent>
      </Card>

      {/* ── Invite form ──────────────────────────────────────────────── */}
      <Card variant="outlined" className="space-y-4 p-6">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold">Invite a member</CardTitle>
        </CardHeader>
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <TextField className="flex-1" name="email">
              <TextFieldInput
                type="email"
                required
                aria-label="Email address to invite"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </TextField>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as "editor" | "viewer")}
            >
              <SelectTrigger aria-label="Role" className="sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Viewer</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="submit"
              variant="filled"
              disabled={creating}
            >
              {creating ? "Sending…" : "Send invite"}
            </Button>
          </div>
          {error && <p className="text-xs text-[var(--ft-color-error)]">{error}</p>}
          <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
            Invitations expire in 7 days. Email delivery is not configured —
            copy the link from the table below and share it manually.
          </p>
        </form>
      </Card>

      {/* ── Pending invitations ──────────────────────────────────────── */}
      <Card variant="outlined" className="space-y-4 p-6">
        <CardHeader className="p-0">
          <CardTitle className="text-sm font-semibold">Pending invitations</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
        {invitationsError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[var(--ft-color-error)]">
              Couldn&apos;t load invitations.
            </p>
            <Button
              variant="outlined"
              size="sm"
              onClick={() => void reloadInvitations()}
            >
              Retry
            </Button>
          </div>
        ) : invitations === null ? (
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">Loading…</p>
        ) : invitations.length === 0 ? (
          <p className="text-sm text-[var(--ft-color-on-surface-variant)]">
            No pending invitations.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex items-center justify-between py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--ft-color-on-surface)]">
                    {inv.email}
                  </p>
                  <p className="text-xs text-[var(--ft-color-on-surface-variant)]">
                    {inv.role} · expires {formatDate(inv.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outlined"
                    size="sm"
                    onClick={() => handleCopy(inv.url)}
                  >
                    {copiedToken === inv.url ? "Copied" : "Copy link"}
                  </Button>
                  <ConfirmButton
                    onConfirm={() => handleRevoke(inv.id)}
                    confirmLabel="Confirm revoke"
                    className="rounded-md border border-[var(--ft-color-error)]/40 px-3 py-1.5 text-xs font-medium text-[var(--ft-color-error)] hover:bg-[var(--ft-color-error)]/5"
                  >
                    Revoke
                  </ConfirmButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        </CardContent>
      </Card>
    </div>
  );
}
