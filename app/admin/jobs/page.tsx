// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Minimal admin view of the BullMQ queues. This is a placeholder until the
// full bull-board UI is wired up — see Phase 0 item 0.6 of the
// fonto-immich-parity-plan. For now we render live counts so the operator
// can confirm the queue is moving without needing a separate sidecar.
//
// TODO(phase-0.6): mount the real bull-board UI here, either via an express
// sidecar container or by porting the bull-board UI to Next.js App Router.
// The plain JSON counts below are intentionally Spartan.

import { getAuthUser } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { allQueues } from "@/lib/queue";

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
      out.push({ name: q.name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
    }
  }
  return out;
}

export default async function JobsAdminPage(): Promise<React.ReactElement> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  // TODO(phase-0.6): real admin RBAC check. For now any authenticated user
  // can see queue stats (read-only).

  const rows = await snapshot();

  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Background Jobs</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Live BullMQ counts. Full bull-board UI is deferred to Phase 0.6.
      </p>
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
    </main>
  );
}
