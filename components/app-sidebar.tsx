// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  Compass,
  FolderOpen,
  Home,
  Library,
  LogOut,
  Search,
  Settings,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOut } from "@/lib/auth/client";
import type { User } from "@/lib/auth/types";
import type { RecentAlbum } from "@/lib/sidebar/recent-albums";

// UX consolidation Phase 7a — the sidebar is the canonical desktop
// surface; mobile relies on `app-mobile-bottom-bar.tsx` for the same
// five primary destinations.
//
// Order matches the bottom bar so muscle memory is consistent across
// viewports: Library → Explore → Collections → Updates → Search.
// Home stays as its own entry (UX-C1 default = keep); Settings stays
// as the tail entry on desktop (UX-C6 demotes it to the avatar menu
// on mobile, handled in `app-mobile-avatar-menu.tsx`).
//
// The 13 legacy entries removed in this phase (Photos, Timeline,
// Memories, Folders, Documents, Trash, Inbox, Activity, Shared with
// me, Projects, Smart Collections, Stacks, People, Map) still resolve
// as URLs — the Phase 5 middleware redirect map sends each to its
// consolidated destination with the right pre-applied query string,
// and the deprecation-banner pages under `/app/<old>/page.tsx`
// continue to render for any directly-loaded deep link that bypasses
// the middleware. Phase 7.1 follow-up removes the deprecation pages
// themselves once the redirect layer has been live ≥1 release cycle.
//
// ADR 0009 Phase 2 (group C) — sidebar surface uses Card variant="filled"
// (surface-container-highest); nav rows use Button variant="tonal" for
// active + "text" for inactive. Existing collapse/onClose logic and the
// `aria-current="page"` contract are preserved.
const navItems = [
  { href: "/app/home",        label: "Home",        icon: Home },
  { href: "/app/library",     label: "Library",     icon: Library },
  { href: "/app/explore",     label: "Explore",     icon: Compass },
  { href: "/app/collections", label: "Collections", icon: FolderOpen },
  { href: "/app/updates",     label: "Updates",     icon: Bell },
  { href: "/app/search",      label: "Search",      icon: Search },
  // Phase 4 (media import) — surface the Google Takeout / Amazon Photos
  // import flow. Mobile parity (bottom bar / avatar menu) is Phase 5.
  { href: "/app/imports",     label: "Imports",     icon: Upload },
  { href: "/app/settings",    label: "Settings",    icon: Settings },
];

export function AppSidebar({
  user,
  recentAlbums,
  onClose,
}: {
  user: User;
  recentAlbums: RecentAlbum[];
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <Card
      variant="filled"
      // Override the default rounded card shape — the sidebar is a
      // full-height chrome surface, not a content card. Keep the
      // surface-container-highest fill from the variant.
      className="w-56 h-full rounded-none border-r border-[var(--ft-color-outline-variant)]"
      role="complementary"
    >
      <aside className="flex h-full flex-1 flex-col min-h-0">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--ft-color-outline-variant)] px-4">
          <Link
            href="/app/home"
            className="font-heading text-sm font-semibold tracking-tight"
            onClick={onClose}
          >
            <span className="text-[var(--ft-color-primary)]">_</span>fonto
          </Link>
          {onClose && (
            <Button
              variant="text"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
          {navItems.map((item) => {
            // Active when the pathname matches exactly OR is a deeper
            // sub-route (e.g. /app/collections/<id> keeps Collections
            // highlighted). Home is an exact-only match since it sits at
            // the same level prefix as the rest of /app/*.
            const active =
              item.href === "/app/home"
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(item.href + "/");
            // Phase 7b — Collections entry hosts a pinned-albums sub-list
            // (Immich pattern, ADR 0005 FU-C1). Sub-list renders only when
            // there are albums to pin AND the operator is on desktop or
            // already inside the Collections branch — we always render in
            // the markup but the indent + smaller text keeps it cheap.
            const isCollections = item.href === "/app/collections";
            const Icon = item.icon;
            return (
              <div key={item.href}>
                <Button
                  variant={active ? "tonal" : "text"}
                  // Justify-start for nav-row alignment; full width so the
                  // tonal pill fills the rail.
                  className="w-full justify-start gap-2 px-3"
                  render={
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? "page" : undefined}
                    />
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Button>
                {isCollections && recentAlbums.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 pl-7">
                    {recentAlbums.map((album) => {
                      const albumHref = `/app/collections/${album.id}`;
                      const albumActive = pathname === albumHref;
                      return (
                        <li key={album.id}>
                          <Button
                            variant={albumActive ? "tonal" : "text"}
                            size="sm"
                            className="w-full justify-start truncate"
                            title={album.name}
                            render={
                              <Link
                                href={albumHref}
                                onClick={onClose}
                                aria-current={albumActive ? "page" : undefined}
                              />
                            }
                          >
                            <span className="truncate">{album.name}</span>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-[var(--ft-color-outline-variant)] px-3 py-3 space-y-2">
          <ThemeToggle />
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-[var(--ft-color-on-surface-variant)] min-w-0">
              {user.email}
            </span>
            <Button
              variant="text"
              size="icon-sm"
              onClick={handleSignOut}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </aside>
    </Card>
  );
}
