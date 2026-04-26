"use client";

import { useSession } from "@/lib/auth/client";

export default function SettingsPage() {
  const { data: session } = useSession();
  const user = session?.user;

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Account</h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</label>
            <p className="mt-1 text-sm text-foreground">{user?.name ?? "—"}</p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</label>
            <p className="mt-1 text-sm text-foreground">{user?.email ?? "—"}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Storage</h2>
        <p className="text-sm text-muted-foreground">Assets are stored securely in Cloudflare R2.</p>
      </div>
    </div>
  );
}
