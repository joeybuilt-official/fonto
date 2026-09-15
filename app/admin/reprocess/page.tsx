// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// M5d — on-demand maintenance backfill triggers, the web replacement for the
// backfill:* SSH one-liners. Server shell gates the surface (instance admin,
// M14 / ADR 0055 — env allowlist, fail-closed, same tier as the other /admin
// pages), then renders the client button list. Each button POSTs `{ job }` to
// the owner-gated /api/v1/admin/reprocess route; the WORKER does the actual
// repair, so this page performs no bulk selects itself. The API route is the
// enforcement point; this shell just keeps the surface hidden from
// non-admins the same way /admin/jobs does.

import { redirect } from "next/navigation";
import { requireInstanceAdmin } from "@/lib/authz/instance";
import { ReprocessButtons } from "./_reprocess-buttons";

export const dynamic = "force-dynamic";

export default async function AdminReprocessPage() {
  const gate = await requireInstanceAdmin();
  if (!gate.ok) redirect("/login");

  return (
    <main className="p-4 sm:p-8 max-w-3xl mx-auto min-w-0 w-full">
      <h1 className="text-2xl font-semibold mb-2">Reprocess / Backfill</h1>
      <p className="text-sm text-muted-foreground mb-6">
        On-demand maintenance jobs — the web equivalent of the{" "}
        <code className="font-mono">pnpm backfill:*</code> SSH one-liners. Each
        button enqueues one job on the maintenance queue; the worker performs
        the work in bounded batches, so nothing here is destructive or
        unbounded.
      </p>
      <ReprocessButtons />
    </main>
  );
}