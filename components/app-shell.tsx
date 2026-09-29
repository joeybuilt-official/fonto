// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { AppMobileBottomBar } from "@/components/app-mobile-bottom-bar";
import { AppMobileAvatarMenu } from "@/components/app-mobile-avatar-menu";
import { ReviewNudge } from "@/components/review-nudge";
import { ReviewQueueCountProvider } from "@/components/review-queue-count";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { UiV2ChangelogDialog } from "@/app/(app)/app/_components/ui-v2-changelog-dialog";
import type { User } from "@/lib/auth/types";
import type { RecentAlbum } from "@/lib/sidebar/recent-albums";

// MD3 migration (ADR 0009, Phase 2): chrome surfaces tokenized to the
// MD3 surface scale — the app frame reads as `surface`, the mobile
// header sits on `surface-container-low` with an `outline-variant`
// divider, and the modal scrim uses the MD3 scrim role.

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
    <ReviewQueueCountProvider>
    <div className="flex h-dvh overflow-hidden bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface)]">
      {/* Desktop sidebar - hidden on mobile */}
      <div className="hidden md:flex">
        <AppSidebar user={user} recentAlbums={recentAlbums} />
      </div>

      {/* Mobile nav drawer — the base-ui Sheet primitive supplies the dialog
          focus-trap, Escape-to-close, body scroll-lock, and focus restoration
          to the hamburger that the hand-rolled overlay lacked. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          id="app-mobile-nav"
          aria-label="Navigation"
          className="w-56 max-w-[14rem] gap-0 rounded-none border-0 bg-transparent p-0 shadow-none md:hidden"
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <AppSidebar
            user={user}
            recentAlbums={recentAlbums}
            onClose={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>

      {/* Content area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header — hamburger (sidebar drawer for Home + the
            still-extant legacy entries), brand, avatar menu
            (UX-C6 Settings demotion target). */}
        <header className="flex h-14 shrink-0 items-center gap-[var(--ft-space-3)] border-b border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] px-[var(--ft-space-4)] md:hidden">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="app-mobile-nav"
            className="-ml-[var(--ft-space-2)] flex min-h-11 min-w-11 items-center justify-center rounded-[var(--ft-shape-full)] p-[var(--ft-space-2)] text-[var(--ft-color-on-surface-variant)] transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)] focus-visible:ring-2 focus-visible:ring-[var(--ft-color-primary)]/40 focus-visible:outline-none"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/app/home" className="font-heading text-sm font-semibold">
            <span className="text-[var(--ft-color-primary)]">_</span>fonto
          </Link>
          <div className="ml-auto flex items-center gap-[var(--ft-space-2)]">
            <AppMobileAvatarMenu user={user} />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-[var(--ft-space-4)] md:p-[var(--ft-space-6)]">
          {children}
        </main>
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
      {/* Intelligence Core (Phase 6) — owner-only load-time review nudge. */}
      <ReviewNudge />
    </div>
    </ReviewQueueCountProvider>
  );
}
