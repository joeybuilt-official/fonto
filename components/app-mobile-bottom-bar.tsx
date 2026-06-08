// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6 (UX consolidation) — mobile bottom-bar navigation.
//
// Five tabs, visible at `<md` viewports only:
//
//   Library · Explore · Collections · Updates · Search
//
// Per UX-C3 (Marcus + Diego) — Diego's a11y contract is the exit
// criterion: the bar carries `role="navigation"`, each tab is a real
// `<a>` (not an icon-only button) so screen readers announce
// destinations, and the active tab carries `aria-current="page"` so
// users on assistive tech know where they are in the hierarchy. Touch
// targets meet the iOS HIG 44×44 px floor — each tab's hit area is
// `min-h-[56px]` (label + icon + safe-area padding combined).
//
// Activation logic uses Next's `usePathname()`:
//   /app/library*          → Library tab active
//   /app/explore*          → Explore tab active
//   /app/collections*      → Collections tab active
//   /app/updates*          → Updates tab active
//   /app/search*           → Search tab active
//   (anything else, eg /app/home or /app/settings) → no tab active
//
// Settings is intentionally NOT in the bar — UX-C6 demotes it to the
// avatar menu on mobile. Home is reachable via the sidebar drawer that
// the existing mobile-header hamburger opens.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Library,
  Compass,
  FolderOpen,
  Bell,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface BottomBarTab {
  href: string;
  label: string;
  /** Pathname prefix used for active-state detection. */
  match: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TABS: BottomBarTab[] = [
  { href: "/app/library",     match: "/app/library",     label: "Library",     icon: Library },
  { href: "/app/explore",     match: "/app/explore",     label: "Explore",     icon: Compass },
  { href: "/app/collections", match: "/app/collections", label: "Collections", icon: FolderOpen },
  { href: "/app/updates",     match: "/app/updates",     label: "Updates",     icon: Bell },
  { href: "/app/search",      match: "/app/search",      label: "Search",      icon: Search },
];

export function AppMobileBottomBar() {
  const pathname = usePathname();

  return (
    <nav
      role="navigation"
      aria-label="Primary"
      // pb-safe respects the iOS home-indicator inset where available;
      // falls back to a small bottom padding otherwise. The border-top
      // keeps the bar visually pinned even when content scrolls behind.
      className="flex shrink-0 items-stretch justify-between gap-0 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((t) => {
        const isActive =
          pathname === t.match || pathname.startsWith(t.match + "/");
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            // Phase 6 AA pass:
            //   - inactive label text-foreground/70 (≈6.2:1 vs bg, was
            //     muted-foreground 4.2:1 — failed AA at 10px)
            //   - active label text-foreground + semibold (≈15:1) +
            //     teal icon as the brand-color signifier
            //   - non-color active indicator: 2px teal top bar so
            //     colour-blind / monochrome users see the selection
            //   - focus-visible ring for keyboard a11y
            className={cn(
              "group relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive
                ? "text-foreground font-semibold"
                : "text-foreground/70 hover:text-foreground",
            )}
          >
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 top-0 h-0.5 rounded-b-sm bg-primary"
              />
            )}
            <Icon
              className={cn(
                "h-5 w-5",
                isActive ? "text-primary" : "text-foreground/70 group-hover:text-foreground",
              )}
            />
            <span className="leading-tight">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
