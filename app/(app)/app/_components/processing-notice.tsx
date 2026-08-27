// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Web parity for the mobile home_screen "Processing N items on Fonto…" strip.
//
// Mobile (mobile/lib/src/screens/home_screen.dart) renders a slim status strip
// above the library grid whenever GET /api/v1/stats reports processing > 0, and
// polls that (cheap) endpoint every 6s, self-cancelling once nothing is left in
// the pipeline. This is the web-optimized equivalent: a slim full-width strip
// shown above the grid, linking to /app/imports (the web analogue of mobile's
// Transfers screen). Web reports the explicit pipeline breakdown instead of one
// opaque number: what is in flight, what is still queued behind it, and what
// failed and needs a retry.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, ChevronRight, AlertTriangle, CloudOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const POLL_MS = 6000;
// Only failures are left: nothing moves until someone retries, so keep watching
// (a retry re-queues the asset and this strip must follow it) but slowly — a
// permanently-failed corpus would otherwise poll every 6s forever.
const IDLE_POLL_MS = 30000;

/** Explicit pipeline buckets from GET /api/v1/stats. */
type Pipeline = { queued: number; inFlight: number; failed: number };

const STRIP_CLASS =
  "flex flex-row items-center gap-[var(--ft-space-3)] !bg-[var(--ft-color-surface-container-high)] px-[var(--ft-space-4)] py-[var(--ft-space-2)]";
const TEXT_CLASS =
  "flex-1 text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] text-[var(--ft-color-on-surface)]";

export function ProcessingNotice() {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // Poll stats while the strip has anything to say — work in the pipeline, or
  // failures a retry elsewhere could clear. Stops only once all three buckets
  // are empty. Re-arms on mount, so navigating back resumes polling.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (cancelled) return;
      const next = await fetch("/api/v1/stats")
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{ queued?: number; inFlight?: number; failed?: number }>)
            : null
        )
        .then((d) =>
          d
            ? {
                queued: d.queued ?? 0,
                inFlight: d.inFlight ?? 0,
                failed: d.failed ?? 0,
              }
            : null
        )
        .catch(() => null);
      if (cancelled) return;

      if (!next) {
        setStatus("error");
        timer = setTimeout(loop, POLL_MS);
        return;
      }
      setPipeline(next);
      setStatus("ready");
      const working = next.queued + next.inFlight > 0;
      if (working || next.failed > 0) {
        timer = setTimeout(loop, working ? POLL_MS : IDLE_POLL_MS);
      }
    };

    loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // First poll in flight: stay silent rather than flash an empty strip.
  if (status === "loading") return null;

  if (status === "error") {
    // Only speak up if we were actively tracking work — and never keep showing
    // the last counts, which we can no longer confirm.
    const wasTracking =
      !!pipeline && pipeline.queued + pipeline.inFlight + pipeline.failed > 0;
    if (!wasTracking) return null;
    return (
      <Card variant="filled" role="status" className={STRIP_CLASS}>
        <CloudOff className="h-3.5 w-3.5 shrink-0 text-[var(--ft-color-on-surface-variant)]" />
        <span className={TEXT_CLASS}>
          Can&apos;t reach Fonto — processing status is out of date. Retrying…
        </span>
      </Card>
    );
  }

  if (!pipeline) return null;
  const { queued, inFlight, failed } = pipeline;
  if (queued + inFlight + failed === 0) return null;

  const active = [
    inFlight > 0 ? `${inFlight} ${inFlight === 1 ? "item" : "items"} processing now` : null,
    queued > 0 ? `${queued} waiting in queue` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card variant="filled" role="status" className={STRIP_CLASS}>
      {active ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ft-color-on-surface-variant)]" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--ft-color-error)]" />
      )}
      <span className={TEXT_CLASS}>
        {active}
        {active && failed > 0 ? " · " : null}
        {failed > 0 ? (
          <span className="font-medium text-[var(--ft-color-error)]">
            {failed} failed — needs a retry
          </span>
        ) : null}
      </span>
      <Button render={<Link href="/app/imports" />} variant="text" size="xs">
        {failed > 0 ? "Review" : "View"}
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </Card>
  );
}
