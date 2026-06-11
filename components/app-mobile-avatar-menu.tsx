// SPDX-License-Identifier: AGPL-3.0-only
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
//   - Each item is a real `<a>` or `<button>` so Tab + Enter both work.
//   - Closing on Escape is handled by the Sheet primitive (Base UI's
//     dialog-modal trap).
//
// ADR 0009 Phase 2 (group C) — the bespoke popover + custom backdrop
// were replaced with the MD3 `<Sheet side="bottom">` primitive (which
// gives us scrim, focus-trap, Escape handling, swipe-down indicator
// and surface-container-high colour for free). Menu rows share the
// MD3 `text` button variant via `buttonVariants` — applying the
// variant as a className rather than nesting `<Button render={...}>`
// inside `<SheetClose render={...}>` keeps the Base UI render-prop
// composition single-level and avoids cloneElement surprises.

"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Settings, User as UserIcon, Home } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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

// Shared classes for the menu rows — MD3 `text` variant, full-width,
// left-aligned. Pulled out so the Link rows and the sign-out button row
// stay visually identical.
const menuRowClass = cn(
  buttonVariants({ variant: "text" }),
  "w-full justify-start gap-2 px-3",
);

export function AppMobileAvatarMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  // `user.email` is optional on the auth type — coerce to a stable
  // fallback so the label / initials never blank out.
  const email = user.email ?? "account";

  async function handleSignOut() {
    setOpen(false);
    await signOut();
    router.push("/login");
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <button
            type="button"
            aria-haspopup="menu"
            aria-label={`Account menu for ${email}`}
            className="flex h-9 w-9 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] text-xs font-semibold text-[var(--ft-color-on-secondary-container)] transition-colors hover:brightness-95"
          >
            {initialsFor(email)}
          </button>
        }
      />
      <SheetContent side="bottom" aria-label="Account menu">
        <SheetTitle className="sr-only">Account menu</SheetTitle>
        {/* Email header row — uses on-surface-variant for the muted-label
            equivalent in the MD3 token namespace. */}
        <div className="flex items-center gap-[var(--ft-space-2)] border-b border-[var(--ft-color-outline-variant)] pb-[var(--ft-space-3)] text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]">
          <UserIcon className="h-3.5 w-3.5" />
          <span className="truncate">{email}</span>
        </div>

        <div className="flex flex-col gap-[var(--ft-space-1)]">
          <SheetClose
            render={
              <Link href="/app/home" role="menuitem" className={menuRowClass}>
                <Home className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
                Home
              </Link>
            }
          />
          <SheetClose
            render={
              <Link
                href="/app/settings"
                role="menuitem"
                className={menuRowClass}
              >
                <Settings className="h-4 w-4 text-[var(--ft-color-on-surface-variant)]" />
                Settings
              </Link>
            }
          />
        </div>

        {/* Sign-out gets its own group + an error-tint to match the legacy
            "destructive" styling. */}
        <div className="flex flex-col border-t border-[var(--ft-color-outline-variant)] pt-[var(--ft-space-2)]">
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            className={cn(
              menuRowClass,
              "text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-error)_8%,transparent)]",
            )}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
