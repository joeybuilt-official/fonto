// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Photos/Files split — surface segmented control + Inbox banner + scoped lens
// chips. Rendered only when the `librarySurfaceSplit` flag is ON; replaces the
// flat KIND lens row. See plans/photos-vs-files-split/plan.md.

"use client";

import {
  Images,
  Files as FilesIcon,
  FileQuestion,
  Image as ImageIcon,
  Film,
  Smartphone,
  Palette,
  FileText,
  LayoutGrid,
} from "lucide-react";

export type LibrarySurface = "photos" | "files" | "unsorted";

export interface LensOption {
  value: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Surface-scoped lens chips. "all" is the per-surface union; the remaining
// values are single KINDs. Inbox has no lenses (it is the unclassified union).
export const PHOTO_LENSES: LensOption[] = [
  { value: "all", label: "All", icon: LayoutGrid },
  { value: "moment", label: "Moments", icon: ImageIcon },
  { value: "video", label: "Videos", icon: Film },
];

export const FILE_LENSES: LensOption[] = [
  { value: "all", label: "All", icon: LayoutGrid },
  { value: "screenshot", label: "Screenshots", icon: Smartphone },
  { value: "graphics", label: "Graphics", icon: Palette },
  { value: "document", label: "Documents", icon: FileText },
];

// Map a (surface, lens) selection to the `?kind=` value the API expects. The
// route accepts a comma-separated set; "all" expands to the surface's union.
// Inbox uses `?unclassified=1` instead and returns null here.
export function computeKindParam(
  surface: LibrarySurface,
  lens: string
): string | null {
  if (surface === "unsorted") return null;
  if (surface === "photos") {
    if (lens === "moment") return "moment";
    if (lens === "video") return "video";
    return "moment,video"; // all
  }
  // files
  if (lens === "screenshot") return "screenshot";
  if (lens === "graphics") return "graphics";
  if (lens === "document") return "document";
  return "screenshot,graphics,document"; // all
}

export function lensesForSurface(surface: LibrarySurface): LensOption[] {
  return surface === "files" ? FILE_LENSES : PHOTO_LENSES;
}

function segBtn(active: boolean): string {
  return `inline-flex h-9 flex-1 items-center justify-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] px-[var(--ft-space-4)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium transition-colors ${
    active
      ? "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
      : "text-[var(--ft-color-on-surface-variant)] hover:text-[var(--ft-color-on-surface)]"
  }`;
}

function chipBtn(active: boolean): string {
  return `inline-flex h-8 shrink-0 items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap transition-colors ${
    active
      ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
      : "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] hover:text-[var(--ft-color-on-surface)]"
  }`;
}

export function LibrarySurfaceControl({
  surface,
  lens,
  unsortedCount,
  onSurface,
  onLens,
}: {
  surface: LibrarySurface;
  lens: string;
  unsortedCount: number;
  onSurface: (s: LibrarySurface) => void;
  onLens: (lens: string) => void;
}) {
  const lenses = lensesForSurface(surface);
  const inUnsorted = surface === "unsorted";

  return (
    <div className="space-y-3">
      {/* Unsorted banner — only when there are unclassified assets to triage, or
          while the user is inside the Unsorted surface (so they can leave it). */}
      {(unsortedCount > 0 || inUnsorted) && (
        <button
          onClick={() => onSurface(inUnsorted ? "photos" : "unsorted")}
          className={`flex w-full items-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-medium)] border px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-left text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium transition-colors ${
            inUnsorted
              ? "border-transparent bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)]"
              : "border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_6%,transparent)]"
          }`}
        >
          <FileQuestion className="h-4 w-4" />
          <span>Unsorted</span>
          {unsortedCount > 0 && (
            <span className="ml-auto rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] px-2 py-0.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] text-[var(--ft-color-on-primary)]">
              {unsortedCount} pending
            </span>
          )}
          {inUnsorted && <span className="ml-auto text-[length:var(--ft-type-label-medium-size)]">Done</span>}
        </button>
      )}

      {/* Segmented control — Photos / Files. The mode switch. */}
      <div
        className="flex items-center gap-1 rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] p-1"
        role="tablist"
        aria-label="Library surface"
      >
        <button
          role="tab"
          aria-selected={surface === "photos"}
          onClick={() => onSurface("photos")}
          className={segBtn(surface === "photos")}
        >
          <Images className="h-4 w-4" />
          Photos
        </button>
        <button
          role="tab"
          aria-selected={surface === "files"}
          onClick={() => onSurface("files")}
          className={segBtn(surface === "files")}
        >
          <FilesIcon className="h-4 w-4" />
          Files
        </button>
      </div>

      {/* Surface-scoped lens chips. Hidden inside the Unsorted surface. */}
      {!inUnsorted && (
        <div
          className="flex items-center gap-1 overflow-x-auto pb-0.5"
          role="tablist"
          aria-label="Library lens"
        >
          {lenses.map((l) => {
            const Icon = l.icon;
            const active = lens === l.value;
            return (
              <button
                key={l.value}
                role="tab"
                aria-selected={active}
                onClick={() => onLens(l.value)}
                className={chipBtn(active)}
              >
                <Icon className="h-4 w-4" />
                {l.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
