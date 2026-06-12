// Phase 5 — shared error-state component for list surfaces.
// Each surface controls its own empty/loading copy (the wording is too
// surface-specific to generalize), but the error-with-retry pattern is
// uniform: friendly message + Retry button that re-runs the fetch.
//
// ADR 0009 phase 2 (group D) — central area swapped onto the MD3
// <Card variant="filled"> surface, the retry CTA onto <Button
// variant="filled">, copy/icon now resolve via the --ft-* namespace.

"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function ListErrorState({
  message = "Couldn't load this. Check your connection and retry.",
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex justify-center py-[var(--ft-space-12)]">
      <Card
        variant="filled"
        className="flex w-full max-w-sm flex-col items-center gap-[var(--ft-space-3)] px-[var(--ft-space-6)] py-[var(--ft-space-8)] text-center"
      >
        <AlertCircle className="h-10 w-10 text-[var(--ft-color-error)]/70" />
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
          {message}
        </p>
        <Button variant="filled" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </Card>
    </div>
  );
}
