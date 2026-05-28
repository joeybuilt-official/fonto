// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (UX consolidation) — deprecated route. The Inbox surface
// (upload zone + recent uploads + duplicate prompts + welcome panel)
// has moved into `/app/updates?section=uploads`. This page re-renders
// the same UploadsSection body with a deprecation banner pointing
// users at the new location. Phase 5 will replace this stub with a
// hard redirect in middleware.ts.

"use client";

import { Suspense } from "react";
import { UploadsSection } from "../updates/_components/uploads-section";
import { DeprecationBanner } from "../_components/deprecation-banner";

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <DeprecationBanner
        label="Inbox"
        newHref="/app/updates?section=uploads"
        newLabel="Updates · Uploads"
        movedInto="the consolidated Updates page"
      />
      <div className="px-4 py-4">
        <UploadsSection />
      </div>
    </Suspense>
  );
}
