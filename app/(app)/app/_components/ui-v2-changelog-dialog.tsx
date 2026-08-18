// SPDX-License-Identifier: MIT
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
import { Library, FolderOpen, Bell, Compass, ArrowRight } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";

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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-[var(--ft-space-5)] pt-[var(--ft-space-4)] pb-[var(--ft-space-3)] border-b border-[var(--ft-color-outline-variant)]">
          <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-wide text-[var(--ft-color-primary)]">
            What&apos;s new
          </p>
          <DialogTitle>Fonto&apos;s navigation just got simpler</DialogTitle>
          <DialogDescription>
            We collapsed 18 sidebar entries down to 7. Same features, fewer
            places to look.
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-y divide-[var(--ft-color-outline-variant)]">
          {MOVES.map((m) => {
            const Icon = m.icon;
            return (
              <li
                key={m.destination}
                className="flex items-start gap-[var(--ft-space-3)] px-[var(--ft-space-5)] py-[var(--ft-space-4)]"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ft-shape-small)] bg-[var(--ft-color-primary-container)] text-[var(--ft-color-on-primary-container)]">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-medium text-[var(--ft-color-on-surface)]">
                    {m.destination}
                  </p>
                  <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
                    {m.movedItems}
                  </p>
                </div>
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={dismiss}
                  render={<a href={m.destinationHref} />}
                >
                  Open
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-[var(--ft-color-outline-variant)] px-[var(--ft-space-5)] py-[var(--ft-space-4)]">
          <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
            Old bookmarks still work — they now redirect to the right
            section automatically.
          </p>
          <DialogFooter className="mt-[var(--ft-space-3)]">
            <Button variant="filled" onClick={dismiss}>
              Got it
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
