// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance-admin console. The /api/v1/admin/* routes enforce
// the tier (403 for non-admins); this page calls /admin/me first and renders
// "Not found" for everyone else so the UI never leaks admin surface.
"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Stats {
  workspaceCount: number;
  activeAssets: number;
  totalAssets: number;
  usageBytes: number;
  userCount: number | null;
}
interface AdminUser {
  id: string;
  email: string | null;
  name: string | null;
  createdAt: string | null;
  workspaceCount: number;
  usageBytes: number;
}
interface AdminWorkspace {
  id: string;
  name: string;
  ownerEmail: string | null;
  quotaBytes: number | null;
  usageBytes: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

export default function AdminConsolePage() {
  const [state, setState] = useState<"loading" | "denied" | "ready">("loading");
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);

  useEffect(() => {
    (async () => {
      const me = await fetch("/api/v1/admin/me").then((r) => r.json()).catch(() => null);
      if (!me?.isInstanceAdmin) {
        setState("denied");
        return;
      }
      const [s, u, w] = await Promise.all([
        fetch("/api/v1/admin/server-stats").then((r) => r.json()),
        fetch("/api/v1/admin/users").then((r) => r.json()),
        fetch("/api/v1/admin/workspaces").then((r) => r.json()),
      ]);
      setStats(s);
      setUsers(u.users ?? []);
      setWorkspaces(w.workspaces ?? []);
      setState("ready");
    })();
  }, []);

  async function saveQuota(id: string, gb: string) {
    const quotaBytes = gb.trim() === "" ? null : Math.round(Number(gb) * 1024 * 1024 * 1024);
    const res = await fetch(`/api/v1/admin/workspaces/${id}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaBytes }),
    });
    if (res.ok) {
      setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, quotaBytes } : w)));
    }
  }

  if (state === "loading") {
    return <div className="p-6 text-[var(--ft-color-on-surface-variant)]">Loading…</div>;
  }
  if (state === "denied") {
    return <div className="p-6 text-[var(--ft-color-on-surface-variant)]">Not found.</div>;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <h1 className="text-[length:var(--ft-type-title-large-size)] font-semibold text-[var(--ft-color-on-surface)]">
        Instance admin
      </h1>

      {stats && (
        <Card variant="outlined">
          <CardHeader>
            <CardTitle>Server</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Users" value={stats.userCount ?? "—"} />
              <Stat label="Workspaces" value={stats.workspaceCount} />
              <Stat label="Assets" value={stats.activeAssets} />
              <Stat label="Storage" value={fmtBytes(stats.usageBytes)} />
            </div>
          </CardContent>
        </Card>
      )}

      <Card variant="outlined">
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col divide-y divide-[var(--ft-color-outline-variant)]">
            {workspaces.map((w) => (
              <WorkspaceRow key={w.id} ws={w} onSave={saveQuota} fmtBytes={fmtBytes} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle>Users</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col divide-y divide-[var(--ft-color-outline-variant)]">
            {users.map((u) => (
              <div key={u.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <div className="text-[var(--ft-color-on-surface)]">{u.email ?? u.id}</div>
                  {u.name && (
                    <div className="text-[var(--ft-color-on-surface-variant)]">{u.name}</div>
                  )}
                </div>
                <div className="text-right text-[var(--ft-color-on-surface-variant)]">
                  {u.workspaceCount} ws · {fmtBytes(u.usageBytes)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[length:var(--ft-type-title-medium-size)] font-semibold text-[var(--ft-color-on-surface)]">
        {value}
      </div>
      <div className="text-[length:var(--ft-type-body-small-size)] text-[var(--ft-color-on-surface-variant)]">
        {label}
      </div>
    </div>
  );
}

function WorkspaceRow({
  ws,
  onSave,
  fmtBytes,
}: {
  ws: AdminWorkspace;
  onSave: (id: string, gb: string) => void;
  fmtBytes: (n: number) => string;
}) {
  const [gb, setGb] = useState(
    ws.quotaBytes == null ? "" : (ws.quotaBytes / 1024 / 1024 / 1024).toFixed(1)
  );
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="truncate text-[var(--ft-color-on-surface)]">{ws.name}</div>
        <div className="truncate text-[var(--ft-color-on-surface-variant)]">
          {ws.ownerEmail ?? "—"} · {fmtBytes(ws.usageBytes)} used
          {ws.quotaBytes != null && ` / ${fmtBytes(ws.quotaBytes)}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <input
          value={gb}
          onChange={(e) => setGb(e.target.value)}
          placeholder="∞"
          inputMode="decimal"
          aria-label={`Quota in GB for ${ws.name}`}
          className="w-20 rounded border border-[var(--ft-color-outline)] bg-transparent px-2 py-1 text-right text-[var(--ft-color-on-surface)]"
        />
        <span className="text-[var(--ft-color-on-surface-variant)]">GB</span>
        <Button variant="outlined" size="sm" onClick={() => onSave(ws.id, gb)}>
          Save
        </Button>
      </div>
    </div>
  );
}
