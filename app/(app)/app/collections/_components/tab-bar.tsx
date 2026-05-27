// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — tab strip for the Collections fan-out.
//
// Renders as anchor-tabs so right-click "open in new tab" works and the
// browser back/forward stack treats sub-tab switches as history entries.
// ARIA roles follow Diego's contract from UX-C3: `role="tablist"`, each
// trigger has `role="tab"` + `aria-selected`. Active tab carries
// `aria-current="page"` so screen readers announce the current view.
//
// Tab switches drop the toolbar's sort/q/filter URL params — each tab
// owns its own surface and its own sort vocabulary; preserving stale
// values across tabs would surface non-applicable sort modes.

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
}: {
  tabs: TabDef[];
  active: string;
  defaultKey: string;
  label: string;
}) {
  const pathname = usePathname();

  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 overflow-x-auto border-b border-border px-4"
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const href =
          t.key === defaultKey ? pathname : `${pathname}?tab=${t.key}`;
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
                : "border-transparent text-muted-foreground hover:text-foreground"
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
