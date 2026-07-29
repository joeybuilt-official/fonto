// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bell,
  Camera,
  ClipboardCheck,
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
import { ThemeToggle } from "@/components/theme-toggle";
import { signOut } from "@/lib/auth/client";
import type { User } from "@/lib/auth/types";
import type { RecentAlbum } from "@/lib/sidebar/recent-albums";
import { cn } from "@/lib/utils";

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
// MD3 migration (ADR 0009, Phase 2): selection state is the MD3
// `secondary-container` pill behind the row with `on-secondary-container`
// content; hover state is an 8 % state-layer over the on-surface
// foreground role; type ramp is `label-large` for primary entries and
// `label-medium` for the pinned-albums sub-list.
// Grouped into light MD3 sections so core browsing (Primary) reads apart
// from utility surfaces (Tools) and the tail Settings entry. Order within
// Primary matches the mobile bottom bar for muscle-memory parity.
type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const primaryNav: NavItem[] = [
  { href: "/app/home",        label: "Home",        icon: Home },
  { href: "/app/library",     label: "Library",     icon: Library },
  { href: "/app/explore",     label: "Explore",     icon: Compass },
  { href: "/app/collections", label: "Collections", icon: FolderOpen },
  // ADR 0008 Phase 5 — shoot browser (deliberate sessions, hidden from
  // the personal timeline by default).
  { href: "/app/shoots",      label: "Shoots",      icon: Camera },
];

const toolsNav: NavItem[] = [
  { href: "/app/updates",     label: "Updates",     icon: Bell },
  { href: "/app/search",      label: "Search",      icon: Search },
  // Phase 4 (media import) — surface the Google Takeout / Amazon Photos
  // import flow. Mobile parity (bottom bar / avatar menu) is Phase 5.
  { href: "/app/imports",     label: "Imports",     icon: Upload },
];

// Tail entry — demoted to the avatar menu on mobile (UX-C6).
const settingsNav: NavItem[] = [
  { href: "/app/settings",    label: "Settings",    icon: Settings },
];

// MD3 label-small section header for nav groups.
const navSectionLabel =
  "px-[var(--ft-space-3)] pb-[var(--ft-space-1)] pt-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] font-medium uppercase tracking-[0.08em] text-[var(--ft-color-on-surface-variant)]";

// MD3 label-large typography for primary nav rows.
const navItemBase =
  "flex items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium tracking-[var(--ft-type-label-large-tracking)] transition-colors outline-none";

// Inactive: on-surface-variant on transparent + 8 % hover overlay.
// Active: secondary-container pill + on-secondary-container content.
const navItemInactive =
  "text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)] focus-visible:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_10%,transparent)]";
const navItemActive =
  "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]";

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

  // Intelligence Core (Phase 6) — owner-only "Review" entry. The count endpoint
  // 403s for non-owners, so a null result hides the link entirely. Cheap (no
  // SSIM); the badge headline is the actionable date-decision queue.
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/admin/review-queue/count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.ok) setReviewCount(typeof d.total === "number" ? d.total : 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  // Active when the pathname matches exactly OR is a deeper sub-route
  // (e.g. /app/collections/<id> keeps Collections highlighted). Home is an
  // exact-only match since it shares the /app/* level prefix with the rest.
  function renderItem(item: NavItem) {
    const active =
      item.href === "/app/home"
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(item.href + "/");
    // Phase 7b — Collections entry hosts a pinned-albums sub-list (Immich
    // pattern, ADR 0005 FU-C1). Sub-list renders only when there are albums
    // to pin; the indent + smaller text keeps it cheap.
    const isCollections = item.href === "/app/collections";
    return (
      <div key={item.href}>
        <Link
          href={item.href}
          onClick={onClose}
          aria-current={active ? "page" : undefined}
          className={cn(navItemBase, active ? navItemActive : navItemInactive)}
        >
          <item.icon className="h-4 w-4 shrink-0" />
          {item.label}
        </Link>
        {isCollections && recentAlbums.length > 0 && (
          <ul className="mt-[var(--ft-space-1)] space-y-[var(--ft-space-1)] pl-7">
            {recentAlbums.map((album) => {
              const albumHref = `/app/collections/${album.id}`;
              const albumActive = pathname === albumHref;
              return (
                <li key={album.id}>
                  <Link
                    href={albumHref}
                    onClick={onClose}
                    aria-current={albumActive ? "page" : undefined}
                    title={album.name}
                    className={cn(
                      "block truncate rounded-[var(--ft-shape-full)] px-[var(--ft-space-2)] py-[var(--ft-space-1)] text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] font-medium tracking-[var(--ft-type-label-medium-tracking)] transition-colors outline-none",
                      albumActive ? navItemActive : navItemInactive,
                    )}
                  >
                    {album.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return (
    <aside className="flex h-full w-56 flex-col border-r border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] text-[var(--ft-color-on-surface)]">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--ft-color-outline-variant)] px-[var(--ft-space-4)]">
        <Link
          href="/app/home"
          className="font-heading text-sm font-semibold tracking-tight"
          onClick={onClose}
        >
          <span className="text-[var(--ft-color-primary)]">_</span>fonto
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="-mr-[var(--ft-space-2)] flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ft-shape-full)] text-[var(--ft-color-on-surface-variant)] transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-[var(--ft-space-1)] overflow-y-auto px-[var(--ft-space-2)] py-[var(--ft-space-3)]">
        <div className={cn(navSectionLabel, "pt-0")}>Primary</div>
        {primaryNav.map(renderItem)}

        <div className={navSectionLabel}>Tools</div>
        {toolsNav.map(renderItem)}

        {/* Intelligence Core (Phase 6) — owner-only Review entry with a count
            badge. Hidden entirely for non-owners (count endpoint 403s).
            Grouped under Tools as another utility surface. */}
        {reviewCount !== null && (
          <Link
            href="/app/review"
            onClick={onClose}
            aria-current={
              pathname === "/app/review" || pathname.startsWith("/app/review/")
                ? "page"
                : undefined
            }
            className={cn(
              navItemBase,
              pathname.startsWith("/app/review") ? navItemActive : navItemInactive,
            )}
          >
            <ClipboardCheck className="h-4 w-4 shrink-0" />
            <span className="flex-1">Review</span>
            {reviewCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-error)] px-1.5 text-[length:var(--ft-type-label-small-size)] font-semibold text-[var(--ft-color-on-error)]">
                {reviewCount > 99 ? "99+" : reviewCount}
              </span>
            )}
          </Link>
        )}

        <div className={cn(navSectionLabel, "mt-[var(--ft-space-2)] border-t border-[var(--ft-color-outline-variant)]")}>
          Settings
        </div>
        {settingsNav.map(renderItem)}
      </nav>

      <div className="space-y-[var(--ft-space-2)] border-t border-[var(--ft-color-outline-variant)] px-[var(--ft-space-3)] py-[var(--ft-space-3)]">
        <ThemeToggle />
        <div className="flex items-center justify-between gap-[var(--ft-space-2)]">
          <span className="min-w-0 truncate text-xs text-[var(--ft-color-on-surface-variant)]">
            {user.email}
          </span>
          <button
            onClick={handleSignOut}
            className="-mr-[var(--ft-space-2)] flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ft-shape-full)] text-[var(--ft-color-on-surface-variant)] transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
