// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared deprecation banner for legacy UX-consolidation routes
// (Phase 2 Collections fan-out, Phase 3 Updates merge).
//
// Renders inline above the relocated content. Dismissible only by
// navigating to the new location — Phase 5 owns per-user persistence
// + a one-time "What moved where" dialog gated on a settings flag.

import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";

export function DeprecationBanner({
  label,
  newHref,
  newLabel,
  /**
   * Free-form copy after "has moved into". Phase-2 callers pass
   * "the consolidated Collections page", Phase-3 callers pass
   * "the consolidated Updates page". Defaults to a neutral phrase.
   */
  movedInto = "its new home",
}: {
  label: string;
  newHref: string;
  newLabel: string;
  movedInto?: string;
}) {
  return (
    <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
      <Info className="h-3.5 w-3.5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{label}</span> has moved into {movedInto}.
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
