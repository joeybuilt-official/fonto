// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Tidy Up — the consumer-facing home for reconciliation review. Lives inside
// the app route group so it inherits the AppShell chrome (sidebar + mobile
// bottom bar). The (app)/layout.tsx already gates login and wraps in AppShell,
// so this page only adds the owner gate and renders the in-shell container.

import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { requireWorkspaceOwner } from "@/lib/authz";
import { TidyUpClient } from "./review-client";

export const dynamic = "force-dynamic";

function OwnerOnly(): React.ReactElement {
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] font-semibold text-[var(--ft-color-on-surface)]">
        Owner only
      </h1>
      <p className="mt-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
        Tidy Up is available to the workspace owner.
      </p>
    </div>
  );
}

export default async function TidyUpPage(): Promise<React.ReactElement> {
  // Login is already enforced by (app)/layout.tsx; getAuthUser here only
  // feeds the workspace lookup. A missing user is impossible past the layout
  // gate, but guard anyway so the owner check has a stable input.
  const user = await getAuthUser();
  if (!user) return <OwnerOnly />;

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return <OwnerOnly />;

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return <OwnerOnly />;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <TidyUpClient />
    </div>
  );
}
