// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 6. Reconciliation review queue. Server shell that
// gates on workspace owner (same pattern as app/admin/jobs) and hands off to a
// client island that fetches the lanes + drives batch accept/reject.

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { ReviewQueueClient } from "./review-client";

export const dynamic = "force-dynamic";

function AdminsOnly(): React.ReactElement {
  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Admins only</h1>
      <p className="text-sm text-muted-foreground">
        The reconciliation review queue is restricted to the workspace owner.
      </p>
    </main>
  );
}

export default async function ReviewQueuePage(): Promise<React.ReactElement> {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return <AdminsOnly />;

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return <AdminsOnly />;

  return (
    <main className="p-4 sm:p-8 max-w-5xl mx-auto min-w-0 w-full">
      <h1 className="text-2xl font-semibold mb-2">Review Queue</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Proposals the confidence gate routed to you. Dates write only on confirm;
        variant consolidation is a reversible trash with a grace window.
      </p>
      <ReviewQueueClient />
    </main>
  );
}
