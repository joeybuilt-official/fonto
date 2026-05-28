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
//   - The popover is `role="menu"` and each item is a real `<a>` or
//     `<button>` so Tab + Enter both work.
//   - Closing on Escape is wired up.
//
// Click-outside closes the menu via a backdrop layer instead of a
// document listener — simpler, and matches the modal idiom we already
// use elsewhere (UiV2ChangelogDialog).

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Settings, User as UserIcon, Home } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import type { User } from "@/lib/auth/types";

function initialsFor(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length === 0) return email.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function AppMobileAvatarMenu({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // `user.email` is optional on the auth type — coerce to a stable
  // fallback so the label / initials never blank out.
  const email = user.email ?? "account";

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${email}`}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-foreground hover:bg-muted transition-colors"
      >
        {initialsFor(email)}
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
          />
          <div
            role="menu"
            aria-label="Account menu"
            className="absolute right-0 top-11 z-50 w-56 rounded-lg border border-border bg-card shadow-lg"
          >
            <div className="border-b border-border px-3 py-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <UserIcon className="h-3.5 w-3.5" />
                <span className="truncate">{email}</span>
              </div>
            </div>

            <div className="py-1">
              <Link
                role="menuitem"
                href="/app/home"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <Home className="h-4 w-4 text-muted-foreground" />
                Home
              </Link>
              <Link
                role="menuitem"
                href="/app/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <Settings className="h-4 w-4 text-muted-foreground" />
                Settings
              </Link>
            </div>

            <div className="border-t border-border py-1">
              <button
                role="menuitem"
                type="button"
                onClick={handleSignOut}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
