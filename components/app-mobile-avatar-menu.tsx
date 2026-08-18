// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 6 (UX consolidation) — mobile avatar menu.
//
// Implements UX-C6 (Marcus + Diego majority): on `<md` viewports the
// Settings link is demoted from the sidebar to a dropdown anchored on
// the user-avatar button in the mobile header. Tess argued for
// always-shown for brand consistency; the 5-tab bottom-bar leaves no
// room for it without burying a primary surface, so Settings becomes
// the obvious demotion target.
//
// Diego's a11y contract:
//   - The trigger is a real `<button>` with an `aria-label` describing
//     the user (not just "menu") so SR users know whose menu opens.
//   - The popover is `role="menu"` and each item is a real `<a>` or
//     `<button>` so Tab + Enter both work.
//   - Closing on Escape is wired up.
//
// MD3 migration (ADR 0009, Phase 2 — app chrome): the menu now rides on
// the shared `Popover` primitive (replaces the bespoke backdrop button
// + absolutely-positioned div). Items use MD3 list-item geometry — 56 px
// row, `label-large` typography, 8 % state-layer on hover/focus over
// the on-surface foreground role.

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, LogOut, Settings, User as UserIcon, Home } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { signOut } from "@/lib/auth/client";
import type { User } from "@/lib/auth/types";
import { cn } from "@/lib/utils";

function initialsFor(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length === 0) return email.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// MD3 list-item: 56 px row, label-large type, 8 % state layer over the
// foreground role on hover/focus. Shared across menuitem links + the
// sign-out button so visual rhythm stays consistent.
const menuItemBase =
  "flex h-14 w-full items-center gap-[var(--ft-space-3)] px-[var(--ft-space-4)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium tracking-[var(--ft-type-label-large-tracking)] outline-none transition-colors";

export function AppMobileAvatarMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const router = useRouter();
  // `user.email` is optional on the auth type — coerce to a stable
  // fallback so the label / initials never blank out.
  const email = user.email ?? "account";

  async function handleSignOut() {
    if (signingOut) return; // guard against a double-tap firing signOut twice
    setSigningOut(true);
    setSignOutError(false);
    try {
      await signOut();
      router.push("/login");
      // keep the menu open + control disabled through the navigation; the tree
      // unmounts on success
    } catch {
      setSignOutError(true);
      setSigningOut(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={`Account menu for ${email}`}
            className="flex h-11 w-11 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] text-xs font-semibold text-[var(--ft-color-on-secondary-container)] transition-colors hover:brightness-95"
          >
            {initialsFor(email)}
          </button>
        }
      />
      <PopoverContent
        role="menu"
        aria-label="Account menu"
        align="end"
        sideOffset={8}
        className="w-64 gap-0 rounded-[var(--ft-shape-medium)] bg-[var(--ft-color-surface-container)] p-0 text-[var(--ft-color-on-surface)] shadow-[var(--ft-elev-2)] ring-0"
      >
        <div className="flex items-center gap-[var(--ft-space-2)] border-b border-[var(--ft-color-outline-variant)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
          <UserIcon className="h-3.5 w-3.5" />
          <span className="truncate">{email}</span>
        </div>

        <div className="py-[var(--ft-space-1)]">
          <Link
            role="menuitem"
            href="/app/home"
            onClick={() => setOpen(false)}
            className={cn(
              menuItemBase,
              "text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_10%,transparent)]",
            )}
          >
            <Home className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
            Home
          </Link>
          <Link
            role="menuitem"
            href="/app/settings"
            onClick={() => setOpen(false)}
            className={cn(
              menuItemBase,
              "text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_10%,transparent)]",
            )}
          >
            <Settings className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
            Settings
          </Link>
        </div>

        <div className="border-t border-[var(--ft-color-outline-variant)] py-[var(--ft-space-1)]">
          <button
            role="menuitem"
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            aria-busy={signingOut}
            className={cn(
              menuItemBase,
              "text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-error)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ft-color-error)_10%,transparent)] disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {signingOut ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            Sign out
          </button>
          {signOutError && (
            <p
              role="alert"
              className="px-[var(--ft-space-4)] pb-[var(--ft-space-2)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]"
            >
              Sign-out failed. Try again.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
