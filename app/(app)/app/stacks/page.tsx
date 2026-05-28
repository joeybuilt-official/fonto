// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — deprecated route. The real surface is
// now `/app/collections?tab=stacks`. Phase 5 will replace this stub
// with a hard redirect in middleware.ts.

"use client";

import { Suspense } from "react";
import { StacksTab } from "../collections/_components/stacks-tab";
import { DeprecationBanner } from "../_components/deprecation-banner";

export default function StacksPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <DeprecationBanner
        label="Stacks"
        newHref="/app/collections?tab=stacks"
        newLabel="Collections · Stacks"
        movedInto="the consolidated Collections page"
      />
      <StacksTab />
    </Suspense>
  );
}
