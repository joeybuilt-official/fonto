// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3.1 — workspace-isolation audit manifest.
//
// Lists every mutating /api/v1 route and the workspace-membership role
// required to hit it. NOT a test runner — this is a printable manifest CI
// (or a human) can grep to confirm every mutating endpoint went through the
// Phase 3.1 audit. When you add a new mutating route, append a row.
//
// Run: pnpm tsx scripts/check-workspace-isolation.ts

type Row = {
  route: string;
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  minimumRole: "viewer" | "editor" | "owner";
  notes?: string;
};

const ROUTES: Row[] = [
  // Assets
  { route: "/api/v1/assets", method: "POST", minimumRole: "editor", notes: "Legacy multipart upload (deprecated)" },
  { route: "/api/v1/assets/:id", method: "PATCH", minimumRole: "editor" },
  { route: "/api/v1/assets/:id", method: "DELETE", minimumRole: "editor" },
  { route: "/api/v1/assets/init", method: "POST", minimumRole: "editor", notes: "Direct-to-R2 presigned init" },
  { route: "/api/v1/assets/:id/complete", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/uploads/tus/*", method: "POST", minimumRole: "editor", notes: "Gated inside lib/tus/server.ts onUploadCreate" },

  // Collections
  { route: "/api/v1/collections", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/collections/:id/assets", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/collections/:id/assets", method: "DELETE", minimumRole: "editor" },

  // Tags
  { route: "/api/v1/tags", method: "POST", minimumRole: "editor" },

  // Projects
  { route: "/api/v1/projects", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/projects/:id", method: "PATCH", minimumRole: "editor" },
  { route: "/api/v1/projects/:id", method: "DELETE", minimumRole: "editor" },

  // Correspondents
  { route: "/api/v1/correspondents", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/correspondents", method: "DELETE", minimumRole: "editor" },

  // Document types
  { route: "/api/v1/document-types", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/document-types", method: "DELETE", minimumRole: "editor" },

  // Smart collections
  { route: "/api/v1/smart-collections", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/smart-collections/:id", method: "PATCH", minimumRole: "editor" },
  { route: "/api/v1/smart-collections/:id", method: "DELETE", minimumRole: "editor" },

  // Shares
  { route: "/api/v1/shares", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/shares/:id", method: "DELETE", minimumRole: "editor", notes: "Revoke share link" },

  // Webhooks
  { route: "/api/v1/webhooks", method: "POST", minimumRole: "editor" },
  { route: "/api/v1/webhooks/:id", method: "PATCH", minimumRole: "editor" },
  { route: "/api/v1/webhooks/:id", method: "DELETE", minimumRole: "editor" },
  { route: "/api/v1/webhooks/:id/test", method: "POST", minimumRole: "editor" },
];

// Routes intentionally NOT gated by requireWorkspaceAccess (with reasons).
const UNGATED: Row[] = [
  { route: "/api/v1/tokens", method: "POST", minimumRole: "viewer", notes: "Personal access tokens — per-user, not per-workspace" },
  { route: "/api/v1/tokens/:id", method: "DELETE", minimumRole: "viewer", notes: "Personal access tokens — per-user, not per-workspace" },
  { route: "/api/v1/cron/ocr-backfill", method: "POST", minimumRole: "viewer", notes: "Cron token-auth, not user-scoped" },
  { route: "/api/v1/cron/purge-trashed", method: "POST", minimumRole: "viewer", notes: "Cron token-auth, not user-scoped" },
  { route: "/api/v1/assets/:id/reprocess", method: "POST", minimumRole: "viewer", notes: "TODO: add editor gate" },
  { route: "/api/v1/assets/:id/share", method: "POST", minimumRole: "viewer", notes: "Legacy single-asset share; see /api/v1/shares (gated)" },
  { route: "/api/v1/assets/:id/tags", method: "POST", minimumRole: "viewer", notes: "TODO: add editor gate" },
];

function main() {
  const rows = [...ROUTES].sort(
    (a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method)
  );

  const lines: string[] = [];
  lines.push("# Phase 3.1 workspace-isolation manifest\n");
  lines.push("| Method | Route | Minimum role | Notes |");
  lines.push("| ------ | ----- | ------------ | ----- |");
  for (const r of rows) {
    lines.push(`| ${r.method} | ${r.route} | ${r.minimumRole} | ${r.notes ?? ""} |`);
  }
  lines.push(`\n${rows.length} mutating routes audited.\n`);

  if (UNGATED.length > 0) {
    lines.push("# Intentionally ungated routes\n");
    lines.push("| Method | Route | Notes |");
    lines.push("| ------ | ----- | ----- |");
    for (const r of UNGATED) {
      lines.push(`| ${r.method} | ${r.route} | ${r.notes ?? ""} |`);
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}

main();
