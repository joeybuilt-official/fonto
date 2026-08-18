// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// M14 / ADR 0055 — instance-admin console. The /api/v1/admin/* routes enforce
// the tier (403 for non-admins); this page calls /admin/me first and renders
// "Not found" for everyone else so the UI never leaks admin surface.
"use client";

import { useCallback, useEffect, useState } from "react";
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export default function AdminConsolePage() {
  const [state, setState] = useState<"loading" | "denied" | "error" | "ready">(
    "loading"
  );
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);

  const load = useCallback(async () => {
    // Note: the "loading" reset lives in the retry handler, not here — a
    // synchronous setState at the top of an effect-invoked fn trips
    // react-hooks/set-state-in-effect. The first statement must be async.
    const me = await fetch("/api/v1/admin/me")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!me?.isInstanceAdmin) {
      setState("denied");
      return;
    }
    try {
      const [s, u, w] = await Promise.all([
        fetchJson<Stats>("/api/v1/admin/server-stats"),
        fetchJson<{ users?: AdminUser[] }>("/api/v1/admin/users"),
        fetchJson<{ workspaces?: AdminWorkspace[] }>("/api/v1/admin/workspaces"),
      ]);
      setStats(s);
      setUsers(u.users ?? []);
      setWorkspaces(w.workspaces ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    // Inline async IIFE (not a direct `void load()`): the first statement is
    // an await, so no setState runs synchronously in the effect body.
    void (async () => {
      await load();
    })();
  }, [load]);

  // Returns an error message to display on the row, or null on success.
  async function saveQuota(id: string, gb: string): Promise<string | null> {
    const trimmed = gb.trim();
    let quotaBytes: number | null;
    if (trimmed === "") {
      // Blank = no quota (unlimited) — the intentional way to clear a cap.
      quotaBytes = null;
    } else {
      const n = Number(trimmed);
      if (!isFinite(n) || n < 0) {
        // Guard: NaN would serialize to null and silently set "unlimited".
        return "Enter a non-negative number of GB, or leave blank for unlimited.";
      }
      quotaBytes = Math.round(n * 1024 * 1024 * 1024);
    }
    try {
      const res = await fetch(`/api/v1/admin/workspaces/${id}/quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaBytes }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        return body?.error ?? `Save failed (HTTP ${res.status}).`;
      }
    } catch {
      return "Save failed — network error.";
    }
    setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, quotaBytes } : w)));
    return null;
  }

  if (state === "loading") {
    return <div className="p-6 text-[var(--ft-color-on-surface-variant)]">Loading…</div>;
  }
  if (state === "denied") {
    return <div className="p-6 text-[var(--ft-color-on-surface-variant)]">Not found.</div>;
  }
  if (state === "error") {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-start gap-3 p-6">
        <p className="text-[var(--ft-color-on-surface-variant)]">
          Couldn&apos;t load the admin console.
        </p>
        <Button
          variant="outlined"
          size="sm"
          onClick={() => {
            setState("loading");
            void load();
          }}
        >
          Retry
        </Button>
      </div>
    );
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
  onSave: (id: string, gb: string) => Promise<string | null>;
  fmtBytes: (n: number) => string;
}) {
  const [gb, setGb] = useState(
    ws.quotaBytes == null ? "" : (ws.quotaBytes / 1024 / 1024 / 1024).toFixed(1)
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setErr(await onSave(ws.id, gb));
    setSaving(false);
  }

  return (
    <div className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
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
            onChange={(e) => {
              setGb(e.target.value);
              if (err) setErr(null);
            }}
            placeholder="∞"
            inputMode="decimal"
            aria-label={`Quota in GB for ${ws.name}`}
            aria-invalid={err != null}
            className="w-20 rounded border border-[var(--ft-color-outline)] bg-transparent px-2 py-1 text-right text-[var(--ft-color-on-surface)]"
          />
          <span className="text-[var(--ft-color-on-surface-variant)]">GB</span>
          <Button
            variant="outlined"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {err && (
        <p className="text-right text-xs text-[var(--ft-color-error)]">{err}</p>
      )}
    </div>
  );
}
