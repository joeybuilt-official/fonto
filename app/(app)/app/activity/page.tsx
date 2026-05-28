// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (UX consolidation) — deprecated route. Activity has moved
// into `/app/updates?section=activity`. Phase 5 will replace this
// stub with a hard redirect in middleware.ts.

"use client";

import { Suspense } from "react";
import { ActivitySection } from "../updates/_components/activity-section";
import { DeprecationBanner } from "../_components/deprecation-banner";

export default function ActivityPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <DeprecationBanner
        label="Activity"
        newHref="/app/updates?section=activity"
        newLabel="Updates · Activity"
        movedInto="the consolidated Updates page"
      />
      <div className="px-4 py-4">
        <ActivitySection />
      </div>
    </Suspense>
  );
}
