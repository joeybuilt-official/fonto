// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Web parity for the mobile home_screen "Processing N items on Fonto…" strip.
//
// Mobile (mobile/lib/src/screens/home_screen.dart) renders a slim status strip
// above the library grid whenever GET /api/v1/stats reports processing > 0, and
// polls that (cheap) endpoint every 6s, self-cancelling once nothing is left in
// the pipeline. This is the web-optimized equivalent: a slim full-width strip
// shown above the grid, linking to /app/imports (the web analogue of mobile's
// Transfers screen).

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const POLL_MS = 6000;

export function ProcessingNotice() {
  const [processing, setProcessing] = useState(0);

  // Poll stats while assets are still in the pipeline; stop once processing
  // hits 0. Re-arms on mount, so navigating back to the page resumes polling.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (cancelled) return;
      const count = await fetch("/api/v1/stats")
        .then((r) => (r.ok ? (r.json() as Promise<{ processing?: number }>) : null))
        .then((d) => (d ? d.processing ?? 0 : null))
        .catch(() => null);
      if (cancelled) return;
      if (count !== null) setProcessing(count);
      // Keep polling only while work remains (or the fetch transiently failed).
      if (count === null || count > 0) {
        timer = setTimeout(loop, POLL_MS);
      }
    };

    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (processing <= 0) return null;

  return (
    <Card
      variant="filled"
      className="flex flex-row items-center gap-[var(--ft-space-3)] !bg-[var(--ft-color-surface-container-high)] px-[var(--ft-space-4)] py-[var(--ft-space-2)]"
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ft-color-on-surface-variant)]" />
      <span className="flex-1 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] text-[var(--ft-color-on-surface)]">
        Processing {processing} {processing === 1 ? "item" : "items"} on Fonto…
      </span>
      <Button
        render={<Link href="/app/imports" />}
        variant="text"
        size="xs"
      >
        View
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </Card>
  );
}
