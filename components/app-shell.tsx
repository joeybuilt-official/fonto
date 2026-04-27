"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import type { User } from "@/lib/auth/types";

export function AppShell({ user, children }: { user: User; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar - hidden on mobile */}
      <div className="hidden md:flex">
        <AppSidebar user={user} />
      </div>

      {/* Mobile overlay */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <AppSidebar user={user} onClose={() => setOpen(false)} />
          </div>
        </>
      )}

      {/* Content area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile header */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:hidden">
          <button
            onClick={() => setOpen(true)}
            className="rounded p-2 -ml-2 text-muted-foreground hover:text-foreground"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/app/dashboard" className="font-heading text-sm font-semibold">
            <span className="text-primary">_</span>fonto
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
