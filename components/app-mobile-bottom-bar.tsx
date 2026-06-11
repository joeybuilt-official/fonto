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
// targets meet the iOS HIG 44×44 px floor — NavBar's MD3 default
// height (80 px) clears that with margin.
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
// ADR 0009 Phase 2 (group C) — migrated to the MD3 `<NavBar>` primitive.
// The hand-tuned 64×32 active-indicator pill is now NavBar's built-in
// selected state (secondary-container fill, on-secondary-container
// icon/label colour). Each tab renders as a `Link` via Base UI's
// `render` prop so we keep client-side routing + `aria-current` while
// still getting NavBarItem's MD3 styling and focus ring.

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
      // md:hidden hides the bar on desktop where the sidebar is always
      // visible. The NavBar primitive owns the surface colour
      // (surface-container) + elevation-2 + 80 px height.
      className="border-t border-[var(--ft-color-outline-variant)] pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((t) => {
        const isActive =
          pathname === t.match || pathname.startsWith(t.match + "/");
        const Icon = t.icon;
        return (
          <NavBarItem
            key={t.href}
            active={isActive}
            icon={<Icon />}
            label={t.label}
            // Base UI's `render` prop lets us swap the underlying button
            // for a Next.js `Link` so we keep client-side routing and the
            // `aria-current="page"` contract from Phase 6 (UX-C3).
            render={
              <Link
                href={t.href}
                aria-current={isActive ? "page" : undefined}
              />
            }
          />
        );
      })}
    </NavBar>
  );
}
