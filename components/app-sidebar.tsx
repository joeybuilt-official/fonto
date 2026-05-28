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
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOut } from "@/lib/auth/client";
import type { User } from "@/lib/auth/types";

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
const navItems = [
  { href: "/app/home",        label: "Home",        icon: Home },
  { href: "/app/library",     label: "Library",     icon: Library },
  { href: "/app/explore",     label: "Explore",     icon: Compass },
  { href: "/app/collections", label: "Collections", icon: FolderOpen },
  { href: "/app/updates",     label: "Updates",     icon: Bell },
  { href: "/app/search",      label: "Search",      icon: Search },
  { href: "/app/settings",    label: "Settings",    icon: Settings },
];

export function AppSidebar({ user, onClose }: { user: User; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <aside className="flex w-56 flex-col border-r border-border bg-sidebar h-full">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <Link
          href="/app/home"
          className="font-heading text-sm font-semibold tracking-tight"
          onClick={onClose}
        >
          <span className="text-primary">_</span>fonto
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
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
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border px-3 py-3 space-y-2">
        <ThemeToggle />
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground min-w-0">
            {user.email}
          </span>
          <button
            onClick={handleSignOut}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-foreground"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
