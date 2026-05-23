// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Image, FileText, FolderOpen, Settings, LogOut, Clock, Search, Trash2, X, Folder, FolderTree, Zap, Sparkles, Users } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOut } from "@/lib/auth/client";
import { useRouter } from "next/navigation";
import type { User } from "@/lib/auth/types";

const navItems = [
  { href: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/timeline", label: "Timeline", icon: Clock },
  // Phase 5.3 — Memories ("On this day"). Logically a sibling of Timeline
  // (both are time-axis browsing); the plan calls for it under Map, but Map
  // isn't in the nav yet so Timeline is the right adjacent home for now.
  { href: "/app/memories", label: "Memories", icon: Sparkles },
  { href: "/app/folders", label: "Folders", icon: FolderTree },
  { href: "/app/photos", label: "Photos", icon: Image },
  // Phase 5.1 — People (face clusters). Sits between Photos and Documents
  // since it's a primary browsing axis over the image library.
  { href: "/app/people", label: "People", icon: Users },
  { href: "/app/documents", label: "Documents", icon: FileText },
  { href: "/app/collections", label: "Albums", icon: FolderOpen },
  { href: "/app/projects", label: "Projects", icon: Folder },
  { href: "/app/smart-collections", label: "Smart Collections", icon: Zap },
  { href: "/app/search", label: "Search", icon: Search },
  { href: "/app/trash", label: "Trash", icon: Trash2 },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

export function AppSidebar({ user, onClose }: { user: User; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <aside className="flex w-56 flex-col border-r border-border bg-sidebar h-full">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <Link
          href="/app/dashboard"
          className="font-heading text-sm font-semibold tracking-tight"
          onClick={onClose}
        >
          <span className="text-primary">_</span>fonto
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={`flex items-center gap-2 rounded px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border px-3 py-3 space-y-2">
        <ThemeToggle />
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground min-w-0">
            {user.email}
          </span>
          <button
            onClick={handleSignOut}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:text-foreground"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
