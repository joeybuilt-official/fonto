// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/client";

interface AcceptButtonProps {
  token: string;
  expectedEmail: string;
}

/**
 * Client-side accept button.
 *
 * Two paths:
 *  - signed in & email matches: POST /accept then redirect to dashboard.
 *  - not signed in: send the user to /login with a callback param so they
 *    return here after signup. The Better Auth login page (Phase 3.3
 *    extension) honours `callback=` to redirect post-signup.
 */
export function AcceptButton({ token, expectedEmail }: AcceptButtonProps) {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginHref = `/login?callback=${encodeURIComponent(`/invitations/${token}`)}&invitation=${encodeURIComponent(token)}&email=${encodeURIComponent(expectedEmail)}`;

  async function handleAccept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspace/invitations/${encodeURIComponent(token)}/accept`,
        { method: "POST" }
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        signupRequired?: boolean;
      };
      if (res.status === 401 || body.signupRequired) {
        router.push(loginHref);
        return;
      }
      if (!res.ok) {
        setError(body.error ?? `Accept failed (status ${res.status})`);
        return;
      }
      router.push("/app/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (isPending) {
    return (
      <button
        type="button"
        disabled
        className="w-full rounded bg-muted px-3 py-2 text-sm font-medium text-muted-foreground"
      >
        Loading…
      </button>
    );
  }

  // Not signed in — link straight to login with callback.
  if (!session?.user) {
    return (
      <div className="space-y-2">
        <a
          href={loginHref}
          className="block w-full rounded bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Sign in to accept
        </a>
        <p className="text-center text-xs text-muted-foreground">
          New to Fonto? Use the same form to create your account.
        </p>
      </div>
    );
  }

  // Signed in but with a different email than the invitation.
  const currentEmail = session.user.email?.toLowerCase().trim();
  if (currentEmail && currentEmail !== expectedEmail) {
    return (
      <div className="space-y-3">
        <div className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          You&rsquo;re signed in as <strong>{session.user.email}</strong>, but
          this invitation was sent to <strong>{expectedEmail}</strong>. Sign in
          with that address to accept.
        </div>
        <a
          href={loginHref}
          className="block w-full rounded border border-border px-3 py-2 text-center text-sm font-medium text-foreground hover:bg-muted"
        >
          Switch account
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleAccept}
        disabled={busy}
        aria-busy={busy}
        className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {busy ? "Joining…" : "Accept invitation"}
      </button>
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
