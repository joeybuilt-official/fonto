// Phase 5 — shared error-state component for list surfaces.
// Each surface controls its own empty/loading copy (the wording is too
// surface-specific to generalize), but the error-with-retry pattern is
// uniform: friendly message + Retry button that re-runs the fetch.

"use client";

import { AlertCircle } from "lucide-react";

export function ListErrorState({
  message = "Couldn't load this. Check your connection and retry.",
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <AlertCircle className="h-10 w-10 text-destructive/70" />
      <p className="text-sm text-muted-foreground">{message}</p>
      <button
        onClick={onRetry}
        className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
      >
        Retry
      </button>
    </div>
  );
}
