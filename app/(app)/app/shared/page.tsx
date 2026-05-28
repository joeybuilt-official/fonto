// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 (UX consolidation) — deprecated route. Shared-with-me has
// moved into `/app/updates?section=shared`. Phase 5 will replace this
// stub with a hard redirect in middleware.ts.

"use client";

import { Suspense } from "react";
import { SharedSection } from "../updates/_components/shared-section";
import { DeprecationBanner } from "../_components/deprecation-banner";

export default function SharedPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <DeprecationBanner
        label="Shared with me"
        newHref="/app/updates?section=shared"
        newLabel="Updates · Shared"
        movedInto="the consolidated Updates page"
      />
      <div className="px-4 py-4">
        <SharedSection />
      </div>
    </Suspense>
  );
}
