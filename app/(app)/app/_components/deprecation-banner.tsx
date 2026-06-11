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
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
    <Card
      variant="filled"
      className="mx-[var(--ft-space-4)] mt-[var(--ft-space-3)] flex flex-row items-center gap-[var(--ft-space-2)] !bg-[var(--ft-color-surface-container-high)] px-[var(--ft-space-3)] py-[var(--ft-space-2)]"
    >
      <Info className="h-3.5 w-3.5 shrink-0 text-[var(--ft-color-primary)]" />
      <p className="min-w-0 flex-1 text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface)]">
        <span className="font-medium">{label}</span> has moved into {movedInto}.
      </p>
      <Button
        render={<Link href={newHref} />}
        variant="text"
        size="xs"
      >
        Go to {newLabel}
        <ArrowRight className="h-3 w-3" />
      </Button>
    </Card>
  );
}
