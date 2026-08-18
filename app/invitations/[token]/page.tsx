// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Public invitation acceptance page.
//
// Renders the metadata for an invitation (without exposing internal ids),
// and provides an Accept button. The button POSTs to the accept endpoint
// when the user is signed in; if it returns 401 + signupRequired, the
// client bounces to /login with `?callback=` set to this page so the
// post-signup redirect lands back here.
import Link from "next/link";
import { headers } from "next/headers";
import { Clock, Ban, CheckCircle2 } from "lucide-react";
import { AcceptButton } from "./accept-button";

interface InvitationView {
  workspace: { name: string };
  inviterEmail: string | null;
  inviterName: string | null;
  role: "editor" | "viewer";
  email: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  expired: boolean;
  used: boolean;
  revoked: boolean;
  expiresAt: string;
}

async function loadInvitation(token: string): Promise<InvitationView | null> {
  // Server-side fetch — resolve the base URL from the incoming request so
  // dev (http://localhost:3500) and prod work without extra env wiring.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto =
    h.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const base = host
    ? `${proto}://${host}`
    : (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3500");

  try {
    const res = await fetch(
      `${base}/api/v1/workspace/invitations/${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    return (await res.json()) as InvitationView;
  } catch {
    return null;
  }
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const inv = await loadInvitation(token);

  if (!inv) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-8 text-center">
          <h1 className="text-xl font-semibold text-foreground">
            Invitation not found
          </h1>
          <p className="text-sm text-muted-foreground">
            This invitation link is invalid or has been removed.
          </p>
          <Link
            href="/"
            className="inline-block text-sm font-medium text-primary-text hover:underline"
          >
            Back to Fonto
          </Link>
        </div>
      </div>
    );
  }

  const inviter = inv.inviterName || inv.inviterEmail || "Someone";

  if (inv.state !== "pending") {
    const variant =
      inv.state === "expired"
        ? {
            Icon: Clock,
            color: "text-amber-500",
            title: "Invitation expired",
            message: "This invitation has expired. Ask the inviter to send a new one.",
          }
        : inv.state === "revoked"
          ? {
              Icon: Ban,
              color: "text-destructive",
              title: "Invitation revoked",
              message: "This invitation has been revoked.",
            }
          : {
              Icon: CheckCircle2,
              color: "text-green-600",
              title: "Already accepted",
              message: "This invitation has already been accepted.",
            };
    const { Icon, color, title, message } = variant;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-card p-8 text-center">
          <Icon className={`mx-auto h-10 w-10 ${color}`} aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
          <Link
            href="/"
            className="inline-block text-sm font-medium text-primary-text hover:underline"
          >
            Back to Fonto
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-card p-8">
        <div className="text-center">
          <Link
            href="/"
            className="font-heading text-2xl font-semibold tracking-tight text-foreground"
          >
            <span className="text-primary">_</span>fonto
          </Link>
        </div>
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-semibold text-foreground">
            {inviter} invited you to{" "}
            <span className="text-primary-text">{inv.workspace.name}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            as <span className="font-medium">{inv.role}</span>. The invitation
            is addressed to{" "}
            <span className="font-medium text-foreground">{inv.email}</span>.
          </p>
          <p className="text-xs text-muted-foreground">
            Expires {formatExpiry(inv.expiresAt)}
          </p>
        </div>
        <AcceptButton token={token} expectedEmail={inv.email} />
      </div>
    </div>
  );
}
