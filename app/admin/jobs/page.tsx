// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Admin landing page for background-job operations. Two surfaces:
//
//  1. A pointer to the bull-board sidecar (Express container) — the real
//     queue UI with retry/promote/clean controls. Surfaced when
//     `BULL_BOARD_URL` is set.
//  2. A live counts table as a fallback for self-hosters who haven't stood
//     up the sidecar yet. The same data, less polish, no actions.
//
// Access gate: workspace owner only via `requireWorkspaceOwner`. This is a
// Phase 0.6 stub for the full Phase 3 multi-user RBAC — see `lib/authz.ts`.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { allQueues } from "@/lib/queue";
import { requireWorkspaceOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

interface QueueRow {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

async function snapshot(): Promise<QueueRow[]> {
  const queues = allQueues();
  const out: QueueRow[] = [];
  for (const q of queues) {
    try {
      const counts = await q.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed"
      );
      out.push({
        name: q.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      });
    } catch {
      out.push({
        name: q.name,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
    }
  }
  return out;
}

function AdminsOnly(): React.ReactElement {
  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Admins only</h1>
      <p className="text-sm text-muted-foreground">
        Background-job administration is restricted to the workspace owner.
        If you reached this page in error, contact the workspace owner.
      </p>
    </main>
  );
}

export default async function JobsAdminPage(): Promise<React.ReactElement> {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  // Resolve the active workspace using the same pattern as the (app) layout.
  // Single-owner today; Phase 3 will turn this into the user's selected
  // workspace from a multi-membership list.
  const workspace = await ensurePersonalWorkspace(user.id);
  if (!workspace) return <AdminsOnly />;

  const authz = await requireWorkspaceOwner(workspace.id);
  if (!authz.ok) return <AdminsOnly />;

  const bullBoardUrl = process.env.BULL_BOARD_URL;
  const rows = await snapshot();

  return (
    <main className="p-4 sm:p-8 max-w-3xl mx-auto min-w-0 w-full">
      <h1 className="text-2xl font-semibold mb-2">Background Jobs</h1>
      <p className="text-sm text-muted-foreground mb-6">
        BullMQ queues for asset processing. Restart-safe; retries on failure.
      </p>

      {bullBoardUrl ? (
        <section className="mb-8 rounded-lg border p-4">
          <h2 className="text-lg font-semibold mb-1">Open Bull-board</h2>
          <p className="text-sm text-muted-foreground mb-3">
            The full queue UI — retry, promote, clean, inspect job payloads —
            runs as a separate sidecar container. It is protected by HTTP
            Basic Auth; ask your operator for the credentials.
          </p>
          <Link
            href={bullBoardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Open Bull-board &rarr;
          </Link>
        </section>
      ) : (
        <section className="mb-8 rounded-lg border border-dashed p-4">
          <h2 className="text-lg font-semibold mb-1">Bull-board sidecar not configured</h2>
          <p className="text-sm text-muted-foreground">
            Set <code className="font-mono">BULL_BOARD_URL</code> to surface a
            link to the bull-board container here. See{" "}
            <code className="font-mono">Dockerfile.bullboard</code> and the
            &quot;Background Jobs&quot; section of the README for the deploy
            story.
          </p>
        </section>
      )}

      <h2 className="text-lg font-semibold mb-2">Live counts</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Snapshot from each queue. Use bull-board for live updates and
        actions.
      </p>
      <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2">Queue</th>
            <th className="text-right">Waiting</th>
            <th className="text-right">Active</th>
            <th className="text-right">Completed</th>
            <th className="text-right">Failed</th>
            <th className="text-right">Delayed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b">
              <td className="py-2 font-mono">{r.name}</td>
              <td className="text-right">{r.waiting}</td>
              <td className="text-right">{r.active}</td>
              <td className="text-right">{r.completed}</td>
              <td className="text-right">{r.failed}</td>
              <td className="text-right">{r.delayed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </main>
  );
}
