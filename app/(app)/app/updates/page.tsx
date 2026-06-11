// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (UX consolidation) — Updates surface.
//
// Merges the legacy Inbox (`/app/dashboard`), Activity (`/app/activity`),
// and Shared-with-me (`/app/shared`) routes into a single page. On
// desktop (md+) all three sections stack vertically — the operator
// scrolls through them as one continuous "what's new" view. On mobile
// (<md) a tab strip at the top of the page switches between sections
// so the surface stays scrollable without competing for screen real
// estate.
//
// URL state: `?section=uploads|activity|shared` (default = uploads).
// On desktop the param scrolls the page to the matching section
// anchor; on mobile it selects the active tab. Deep links from the
// upcoming Phase 5 redirect layer use these anchors so old bookmarks
// land on the right section.
//
// ADR 0004, plan-ux.md Phase 3. UX-C1 (Home stays) + UX-C5 (Activity
// merges into Updates) defaults applied — operator may revisit either
// once usage data exists.

"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Upload, Activity as ActivityIcon, Share2 } from "lucide-react";
import { TabBar, type TabDef } from "../_components/tab-bar";
import { UploadsSection } from "./_components/uploads-section";
import { ActivitySection } from "./_components/activity-section";
import { SharedSection } from "./_components/shared-section";

const TABS: TabDef[] = [
  { key: "uploads", label: "Uploads", icon: Upload },
  { key: "activity", label: "Activity", icon: ActivityIcon },
  { key: "shared", label: "Shared", icon: Share2 },
];

const DEFAULT_SECTION = "uploads";

function UpdatesContent() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("section");
  const active = TABS.some((t) => t.key === raw) ? (raw as string) : DEFAULT_SECTION;

  // Desktop anchor-scroll. When `?section=` is set, scroll the matching
  // section into view on mount (and on param change). On mobile the
  // wrapper hides the inactive sections, so the scroll is a no-op there.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!searchParams.get("section")) return;
    const el = document.getElementById(`updates-section-${active}`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [active, searchParams]);

  return (
    <div className="space-y-4">
      <div className="px-4 pt-4">
        <h1 className="text-2xl font-semibold text-[var(--ft-color-on-surface)]">Updates</h1>
        <p className="mt-1 text-sm text-[var(--ft-color-on-surface-variant)]">
          What&apos;s new in your workspace — uploads, activity, and assets
          shared with you.
        </p>
      </div>

      {/* Mobile-only tab strip. Desktop stacks all three sections. */}
      <TabBar
        tabs={TABS}
        active={active}
        defaultKey={DEFAULT_SECTION}
        label="Updates sections"
        paramName="section"
        className="md:hidden"
      />

      <div className="space-y-8 px-4 pb-8">
        <div
          id="updates-section-uploads"
          className={active === "uploads" ? "" : "hidden md:block"}
        >
          <UploadsSection />
        </div>

        <div
          id="updates-section-activity"
          className={active === "activity" ? "" : "hidden md:block"}
        >
          <ActivitySection />
        </div>

        <div
          id="updates-section-shared"
          className={active === "shared" ? "" : "hidden md:block"}
        >
          <SharedSection />
        </div>
      </div>
    </div>
  );
}

export default function UpdatesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-[var(--ft-color-on-surface-variant)] py-4 px-4">Loading…</div>}>
      <UpdatesContent />
    </Suspense>
  );
}
