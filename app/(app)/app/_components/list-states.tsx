// Phase 5 — shared error-state component for list surfaces.
// Each surface controls its own empty/loading copy (the wording is too
// surface-specific to generalize), but the error-with-retry pattern is
// uniform: friendly message + Retry button that re-runs the fetch.

"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ListErrorState({
  message = "Couldn't load this. Check your connection and retry.",
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-[var(--ft-space-3)] py-12 text-center">
      <AlertCircle className="h-10 w-10 text-[var(--ft-color-error)]/70" />
      <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
        {message}
      </p>
      <Button variant="outlined" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
