// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared anchor-tab strip used by the UX-consolidation fan-out pages
// (Phase 2 Collections, Phase 3 Updates).
//
// Anchor-based so right-click "open in new tab" works and the back /
// forward stack treats sub-tab switches as history entries. ARIA roles
// follow Diego's UX-C3 contract: `role="tablist"`, each trigger has
// `role="tab"` + `aria-selected`. Active tab carries
// `aria-current="page"` so screen readers announce the current view.
//
// `paramName` selects the URL search-param to drive selection
// (default `tab` for Collections; Updates uses `section`). The default
// key is rendered as the clean pathname (no query string) so the
// landing URL stays minimal.
//
// `className` lets a caller hide the bar at certain breakpoints
// (Updates renders it only on `<md` viewports — sections stack
// vertically on desktop and the bar collapses to a tab-strip on
// mobile).

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface TabDef {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function TabBar({
  tabs,
  active,
  defaultKey,
  label,
  paramName = "tab",
  className,
}: {
  tabs: TabDef[];
  active: string;
  defaultKey: string;
  label: string;
  paramName?: string;
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex gap-1 overflow-x-auto border-b border-border px-4",
        className,
      )}
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const href =
          t.key === defaultKey
            ? pathname
            : `${pathname}?${paramName}=${t.key}`;
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            href={href}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            tabIndex={isActive ? 0 : -1}
            className={cn(
              "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
