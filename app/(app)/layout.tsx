// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { getRecentAlbumsForWorkspace } from "@/lib/sidebar/recent-albums";
import { AppShell } from "@/components/app-shell";
import { SnackbarHost } from "@/components/ui/snackbar-host";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const workspace = await ensurePersonalWorkspace(user.id);

  // Phase 7b — pinned-albums sub-list under the Collections sidebar
  // entry. SSR-fetched here so first paint has the data; client-side
  // fetch would cause a layout shift after hydration.
  const recentAlbums = await getRecentAlbumsForWorkspace(workspace.id);

  return (
    <SnackbarHost>
      <AppShell user={user} recentAlbums={recentAlbums}>
        {children}
      </AppShell>
    </SnackbarHost>
  );
}
