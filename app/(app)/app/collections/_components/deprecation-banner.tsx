// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 (UX consolidation) — deprecation banner shown on legacy
// routes (`/smart-collections`, `/projects`, `/stacks`) until the
// Phase 5 redirect layer takes over. Inline, dismissible-only-by-
// navigating-away (no per-user persistence — Phase 5 owns that).

import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";

export function DeprecationBanner({
  label,
  newHref,
  newLabel,
}: {
  label: string;
  newHref: string;
  newLabel: string;
}) {
  return (
    <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
      <Info className="h-3.5 w-3.5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{label}</span> has moved into the
        consolidated Collections page.
      </p>
      <Link
        href={newHref}
        className="flex items-center gap-1 rounded border border-primary/40 bg-background px-2 py-1 font-medium text-primary hover:bg-primary/10 transition-colors"
      >
        Go to {newLabel}
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
