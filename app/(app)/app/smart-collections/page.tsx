// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — deprecated route. The real surface is
// now `/app/collections?tab=smart`. Phase 5 will replace this stub
// with a hard redirect in middleware.ts.

"use client";

import { Suspense } from "react";
import { SmartTab } from "../collections/_components/smart-tab";
import { DeprecationBanner } from "../_components/deprecation-banner";

export default function SmartCollectionsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <DeprecationBanner
        label="Smart Collections"
        newHref="/app/collections?tab=smart"
        newLabel="Collections · Smart"
        movedInto="the consolidated Collections page"
      />
      <SmartTab />
    </Suspense>
  );
}
