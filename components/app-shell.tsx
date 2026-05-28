// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { AppMobileBottomBar } from "@/components/app-mobile-bottom-bar";
import { AppMobileAvatarMenu } from "@/components/app-mobile-avatar-menu";
import { PlexoConnectionStatus } from "@/components/plexo-connection-status";
import { UiV2ChangelogDialog } from "@/app/(app)/app/_components/ui-v2-changelog-dialog";
import type { User } from "@/lib/auth/types";
import type { RecentAlbum } from "@/lib/sidebar/recent-albums";

export function AppShell({
  user,
  recentAlbums,
  children,
}: {
  user: User;
  recentAlbums: RecentAlbum[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar - hidden on mobile */}
      <div className="hidden md:flex">
        <AppSidebar user={user} recentAlbums={recentAlbums} />
      </div>

      {/* Mobile overlay */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <AppSidebar
              user={user}
              recentAlbums={recentAlbums}
              onClose={() => setOpen(false)}
            />
          </div>
        </>
      )}

      {/* Content area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header — hamburger (sidebar drawer for Home + the
            still-extant legacy entries), brand, plexo status, avatar
            menu (UX-C6 Settings demotion target). */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:hidden">
          <button
            onClick={() => setOpen(true)}
            className="rounded p-2 -ml-2 text-muted-foreground hover:text-foreground"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/app/home" className="font-heading text-sm font-semibold">
            <span className="text-primary">_</span>fonto
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <PlexoConnectionStatus />
            <AppMobileAvatarMenu user={user} />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
        {/* Phase 6 (UX consolidation) — primary mobile nav: 5 tabs at
            the bottom of the viewport, hidden on md+ where the sidebar
            is always visible. Diego's UX-C3 a11y contract enforced
            inside the component. */}
        <AppMobileBottomBar />
      </div>
      {/* Phase 5 (UX consolidation) — first-login "what moved where"
          dialog. Self-gated on a localStorage flag; renders nothing
          after dismissal. */}
      <UiV2ChangelogDialog />
    </div>
  );
}
