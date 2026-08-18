// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Public invitation acceptance page.
//
// Renders the metadata for an invitation (without exposing internal ids),
// and provides an Accept button. The button POSTs to the accept endpoint
// when the user is signed in; if it returns 401 + signupRequired, the
// client bounces to /login with `?callback=` set to this page so the
// post-signup redirect lands back here.
import { cache } from "react";
import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import {
  classifyInvitation,
  findInvitationByToken,
} from "@/lib/invitations/core";
import { Clock, Ban, CheckCircle2 } from "lucide-react";
import { AcceptButton } from "./accept-button";

export const dynamic = "force-dynamic";

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

// Resolve the invitation directly from the DB — never over an HTTP hop.
// Deriving a fetch base from request headers (x-forwarded-host/host) is
// attacker-controllable (host-header injection → SSRF + on-domain phishing);
// calling the same lib helpers the API route uses removes both the injection
// surface and the self-fetch waterfall. cache() dedupes within the request.
const loadInvitation = cache(
  async (token: string): Promise<InvitationView | null> => {
    const inv = await findInvitationByToken(token);
    if (!inv) return null;

    const state = classifyInvitation(inv);

    const [workspace] = await db
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, inv.workspaceId))
      .limit(1);

    // Inviter identity lives in Better Auth's `auth` schema — best-effort,
    // parameterized cross-schema read (same as the API route).
    let inviterEmail: string | null = null;
    let inviterName: string | null = null;
    try {
      const rows = (await db.execute(
        sql`SELECT email, name FROM auth."user" WHERE id = ${inv.invitedBy} LIMIT 1`
      )) as unknown as Array<{ email: string | null; name: string | null }>;
      if (rows && rows[0]) {
        inviterEmail = rows[0].email ?? null;
        inviterName = rows[0].name ?? null;
      }
    } catch {
      // Non-fatal — render without the inviter's name.
    }

    return {
      workspace: { name: workspace?.name ?? "a workspace" },
      inviterEmail,
      inviterName,
      role: inv.role as "editor" | "viewer",
      email: inv.email,
      state,
      expired: state === "expired",
      used: state === "accepted",
      revoked: state === "revoked",
      expiresAt: inv.expiresAt.toISOString(),
    };
  }
);

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
