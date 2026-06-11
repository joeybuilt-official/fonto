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
//
// MD3 migration (ADR 0009, Phase 2): the bar is rendered through the
// `NavBar` / `NavBarItem` primitives so the selection state becomes the
// MD3 `secondary-container` pill behind the icon + `label-medium`
// typography. The active 2 px teal top-bar indicator is retained as a
// non-color signifier (colour-blind / monochrome fallback) on top of
// the MD3 pill.

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
import { NavBar, NavBarItem } from "@/components/ui/nav-bar";
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
    <NavBar
      role="navigation"
      aria-label="Primary"
      // pb-safe respects the iOS home-indicator inset where available;
      // falls back to a small bottom padding otherwise.
      className="h-auto min-h-20 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((t) => {
        const isActive =
          pathname === t.match || pathname.startsWith(t.match + "/");
        const Icon = t.icon;
        return (
          <NavBarItem
            key={t.href}
            render={
              <Link
                href={t.href}
                aria-current={isActive ? "page" : undefined}
              />
            }
            active={isActive}
            icon={<Icon />}
            label={t.label}
            // Preserve the non-color 2 px brand-teal top indicator for
            // colour-blind / monochrome a11y; layered over the MD3 pill.
            className={cn(
              "min-h-[56px]",
              isActive &&
                "before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-b-sm before:bg-[var(--ft-color-primary)] before:content-['']",
            )}
          />
        );
      })}
    </NavBar>
  );
}
