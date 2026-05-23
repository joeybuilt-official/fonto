// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.2 — admin audit log viewer.
//
// Server component listing the last 200 audit events for the workspace,
// optionally filtered by `?action=...`. Gated on workspace ownership via
// `requireWorkspaceOwner` (Phase 0.6 stub). Phase 3.1 lands a richer
// `assertWorkspaceAccess(userId, workspaceId, 'owner')` that this page
// should migrate to when both PRs merge — the integration agent will do
// the rename.
//
// Privacy: the `ipAddress` column already contains a truncated subnet
// (never a full IP); we render it as-is. We do NOT offer a CSV/JSON
// download endpoint here — that's a future feature once the column-level
// privacy contract is documented.

import { redirect } from "next/navigation";
import { desc, eq, and } from "drizzle-orm";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { requireWorkspaceOwner } from "@/lib/authz";
import { AuditAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

interface PageProps {
  // Next 15 — searchParams is async.
  searchParams: Promise<{ action?: string }>;
}

const ACTION_OPTIONS = Object.values(AuditAction);

function AdminsOnly(): React.ReactElement {
  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Admins only</h1>
      <p className="text-sm text-muted-foreground">
        The audit log is restricted to the workspace owner.
      </p>
    </main>
  );
}

function formatMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "—";
  try {
    const json = JSON.stringify(metadata);
    if (json === "{}") return "—";
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    return "—";
  }
}

export default async function AuditLogPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return <AdminsOnly />;

  // Phase 0.6 fallback. Phase 3.1 will introduce
  // `assertWorkspaceAccess(userId, workspaceId, 'owner')` — when both PRs
  // merge, swap the import and call below.
  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return <AdminsOnly />;

  const params = await searchParams;
  const actionFilter =
    params.action && ACTION_OPTIONS.includes(params.action as AuditAction)
      ? (params.action as AuditAction)
      : null;

  const whereExpr = actionFilter
    ? and(
        eq(schema.auditLog.workspaceId, workspace.id),
        eq(schema.auditLog.action, actionFilter)
      )
    : eq(schema.auditLog.workspaceId, workspace.id);

  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(whereExpr)
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(200);

  return (
    <main className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Audit log</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The 200 most recent mutating actions in this workspace. Rows older
          than the retention window are removed automatically by a daily
          sweep (default 90 days; see <code className="font-mono">AUDIT_RETENTION_DAYS</code>).
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          IPs are stored as a truncated subnet (/24 IPv4, /48 IPv6) — never
          the full client IP.
        </p>
      </div>

      <form className="flex items-center gap-2" action="/app/settings/audit">
        <label htmlFor="action" className="text-xs font-medium text-muted-foreground uppercase">
          Action
        </label>
        <select
          id="action"
          name="action"
          defaultValue={actionFilter ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">All</option>
          {ACTION_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
        >
          Apply
        </button>
        {actionFilter && (
          <Link
            href="/app/settings/audit"
            className="rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
          >
            Clear
          </Link>
        )}
      </form>

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No audit events yet.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Actor</th>
                <th className="text-left px-3 py-2">Action</th>
                <th className="text-left px-3 py-2">Target</th>
                <th className="text-left px-3 py-2">IP subnet</th>
                <th className="text-left px-3 py-2">User agent</th>
                <th className="text-left px-3 py-2">Metadata</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 font-mono whitespace-nowrap">
                    {r.createdAt.toISOString()}
                  </td>
                  <td className="px-3 py-2 font-mono">{r.userId}</td>
                  <td className="px-3 py-2 font-mono">{r.action}</td>
                  <td className="px-3 py-2 font-mono">
                    {r.targetType ? `${r.targetType}:${r.targetId ?? "—"}` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono">{r.ipAddress ?? "—"}</td>
                  <td className="px-3 py-2 truncate max-w-[16ch]" title={r.userAgent ?? ""}>
                    {r.userAgent ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono break-all">
                    {formatMetadata(r.metadata)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
