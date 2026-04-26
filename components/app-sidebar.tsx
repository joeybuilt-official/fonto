"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Image, FileText, FolderOpen, Settings, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { useRouter } from "next/navigation";
import type { User } from "@/lib/auth/types";

const navItems = [
  { href: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/photos", label: "Photos", icon: Image },
  { href: "/app/documents", label: "Documents", icon: FileText },
  { href: "/app/collections", label: "Collections", icon: FolderOpen },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

export function AppSidebar({ user }: { user: User }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <aside className="flex w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-border px-4">
        <Link
          href="/app/dashboard"
          className="font-heading text-sm font-semibold tracking-tight"
        >
          <span className="text-primary">_</span>fonto
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-2 py-3">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-muted-foreground">
            {user.email}
          </span>
          <button
            onClick={handleSignOut}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
