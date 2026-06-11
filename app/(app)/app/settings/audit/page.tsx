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
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

interface PageProps {
  // Next 15 — searchParams is async.
  searchParams: Promise<{ action?: string }>;
}

const ACTION_OPTIONS = Object.values(AuditAction);

function AdminsOnly(): React.ReactElement {
  return (
    <main className="p-[var(--ft-space-8)] max-w-3xl mx-auto">
      <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] tracking-[var(--ft-type-headline-small-tracking)] font-medium text-[var(--ft-color-on-surface)] mb-[var(--ft-space-4)]">
        Admins only
      </h1>
      <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
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
    <main className="p-[var(--ft-space-8)] max-w-6xl mx-auto space-y-[var(--ft-space-6)]">
      <div>
        <h1 className="text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] tracking-[var(--ft-type-headline-small-tracking)] font-medium text-[var(--ft-color-on-surface)]">
          Audit log
        </h1>
        <p className="text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)] mt-[var(--ft-space-1)]">
          The 200 most recent mutating actions in this workspace. Rows older
          than the retention window are removed automatically by a daily
          sweep (default 90 days; see <code className="font-mono">AUDIT_RETENTION_DAYS</code>).
        </p>
        <p className="text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)] mt-[var(--ft-space-1)]">
          IPs are stored as a truncated subnet (/24 IPv4, /48 IPv6) — never
          the full client IP.
        </p>
      </div>

      {/* Filter form is a plain HTML GET form. MD3 Select is a controlled
          client component and would break the bookmarkable `?action=` URL
          flow; native <select> + native submit <button> are tokenised
          instead. Flagged in agent report. */}
      <form className="flex items-center gap-[var(--ft-space-2)]" action="/app/settings/audit">
        <label htmlFor="action" className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] tracking-[var(--ft-type-label-small-tracking)] font-medium text-[var(--ft-color-on-surface-variant)] uppercase">
          Action
        </label>
        <select
          id="action"
          name="action"
          defaultValue={actionFilter ?? ""}
          className="h-9 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] focus:border-[var(--ft-color-primary)] focus:ring-1 focus:ring-[var(--ft-color-primary)]"
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
          className="h-9 rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-4)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] tracking-[var(--ft-type-label-large-tracking)] font-medium text-[var(--ft-color-primary)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]"
        >
          Apply
        </button>
        {actionFilter && (
          <Link
            href="/app/settings/audit"
            className="h-9 inline-flex items-center rounded-[var(--ft-shape-full)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-4)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] tracking-[var(--ft-type-label-large-tracking)] font-medium text-[var(--ft-color-primary)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]"
          >
            Clear
          </Link>
        )}
      </form>

      <Card variant="outlined" className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="px-[var(--ft-space-4)] py-[var(--ft-space-6)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
            No audit events yet.
          </p>
        ) : (
          <table className="w-full text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)]">
            <thead className="text-[var(--ft-color-on-surface-variant)] bg-[var(--ft-color-surface-container-low)]">
              <tr>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">When</th>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">Actor</th>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">Action</th>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">Target</th>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">IP subnet</th>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">User agent</th>
                <th className="text-left px-[var(--ft-space-3)] py-[var(--ft-space-2)]">Metadata</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[var(--ft-color-outline-variant)] align-top text-[var(--ft-color-on-surface)]">
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] font-mono whitespace-nowrap">
                    {r.createdAt.toISOString()}
                  </td>
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] font-mono">{r.userId}</td>
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] font-mono">{r.action}</td>
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] font-mono">
                    {r.targetType ? `${r.targetType}:${r.targetId ?? "—"}` : "—"}
                  </td>
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] font-mono">{r.ipAddress ?? "—"}</td>
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] truncate max-w-[16ch]" title={r.userAgent ?? ""}>
                    {r.userAgent ?? "—"}
                  </td>
                  <td className="px-[var(--ft-space-3)] py-[var(--ft-space-2)] font-mono break-all">
                    {formatMetadata(r.metadata)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </main>
  );
}
