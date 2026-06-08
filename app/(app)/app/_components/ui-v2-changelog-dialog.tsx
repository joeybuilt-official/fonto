// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5 (UX consolidation) — "What moved where" first-login dialog.
//
// Shows once per browser. Gated on a localStorage flag
// (`fonto:ui_v2_seen_at`) — set on dismiss, never expired. localStorage
// is the v1 storage because it ships without a DB migration; if the
// operator later prefers a server-side preference (so a user who
// switches browsers doesn't see the dialog twice), the gate can move
// to `/api/v1/me/preferences` w/ minimal call-site change.
//
// The dialog is content-only (no a11y-traps the framework already
// covers; focus-management is "close button is the only interactive
// element"). Phase 6 will revisit the a11y contract once Diego's
// UX-C3 mobile-bottom-bar work lands.

"use client";

import { useEffect, useState } from "react";
import { X, Library, FolderOpen, Bell, Compass, ArrowRight } from "lucide-react";

const STORAGE_KEY = "fonto:ui_v2_seen_at";

interface MoveRow {
  icon: React.ComponentType<{ className?: string }>;
  destination: string;
  movedItems: string;
  destinationHref: string;
}

const MOVES: MoveRow[] = [
  {
    icon: Library,
    destination: "Library",
    movedItems: "Photos · Timeline · Memories · Folders · Documents · Trash",
    destinationHref: "/app/library",
  },
  {
    icon: FolderOpen,
    destination: "Collections",
    movedItems: "Albums · Smart Collections · Projects · Stacks",
    destinationHref: "/app/collections",
  },
  {
    icon: Bell,
    destination: "Updates",
    movedItems: "Inbox · Activity · Shared with me",
    destinationHref: "/app/updates",
  },
  {
    icon: Compass,
    destination: "Explore",
    movedItems: "People · Places · Things",
    destinationHref: "/app/explore",
  },
];

export function UiV2ChangelogDialog() {
  const [open, setOpen] = useState(false);

  // Defer the localStorage read to an effect so the first SSR render
  // matches the client's first paint (open=false), avoiding a hydration
  // flicker of the dialog appearing-then-vanishing.
  //
  // Phase 6: set the seen-at key on FIRST MOUNT (not on dismiss). This
  // means a user who closes the tab without explicitly clicking "Got it"
  // is not re-blocked on every subsequent visit — the modal is auto-
  // dismissed on the second visit. Matches the "informational, not
  // blocking" intent in the plan ("don't intercept first-tap").
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) == null) {
        window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setOpen(true);
      }
    } catch {
      // localStorage blocked (incognito + restrictive setting) — better
      // to skip than to show the dialog every load.
    }
  }, []);

  function dismiss() {
    // Key is already set on mount; we just hide the dialog. Kept as a
    // function so all the explicit dismiss buttons (X / Got it / Open
    // links) close the panel without each duplicating setOpen(false).
    setOpen(false);
  }

  // Escape dismisses the dialog — without this the modal is a keyboard trap
  // (mouse-click was the only way out).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ui-v2-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Phase 6: backdrop is now a passive dim, NOT a click-to-close
          target. The giant backdrop-button was swallowing the user's
          first tap (e.g. reaching for a tab) and dismissing the modal
          implicitly. Explicit dismiss buttons (X, Got it, Open links)
          + Escape still close it. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/60"
      />

      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-primary">
              What&apos;s new
            </p>
            <h2
              id="ui-v2-dialog-title"
              className="mt-1 text-lg font-semibold text-foreground"
            >
              Fonto&apos;s navigation just got simpler
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              We collapsed 18 sidebar entries down to 7. Same features,
              fewer places to look.
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="divide-y divide-border">
          {MOVES.map((m) => {
            const Icon = m.icon;
            return (
              <li
                key={m.destination}
                className="flex items-start gap-3 px-5 py-4"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {m.destination}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {m.movedItems}
                  </p>
                </div>
                <a
                  href={m.destinationHref}
                  onClick={dismiss}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-background px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                >
                  Open
                  <ArrowRight className="h-3 w-3" />
                </a>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border px-5 py-4">
          <p className="text-xs text-muted-foreground">
            Old bookmarks still work — they now redirect to the right
            section automatically.
          </p>
          <div className="mt-3 flex justify-end">
            <button
              onClick={dismiss}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
