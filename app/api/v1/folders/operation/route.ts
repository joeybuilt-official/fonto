// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-2 — POST /api/v1/folders/operation
//
// Folders in Fonto are not rows — they're prefixes of `directory_path`.
// "Rename / move / delete" all become bulk updates over the asset rows
// that match the path (exact + descendants).
//
// Body shape (discriminated union):
//
//   { op: "rename",  path: "/Photos/2024", newName: "2024-old" }
//     → renames the leaf segment. `/Photos/2024` → `/Photos/2024-old`,
//       `/Photos/2024/Iceland` → `/Photos/2024-old/Iceland`.
//
//   { op: "move",    path: "/Photos/2024", newParent: "/Archive" }
//     → reparents the whole subtree. newParent="" or "/" moves to root.
//       `/Photos/2024` → `/Archive/2024`, `/Photos/2024/x` → `/Archive/2024/x`.
//
//   { op: "delete",  path: "/Photos/2024", action: "trash" | "orphan" }
//     → trash: every asset under the prefix gets lifecycle_state='trashed'
//       (deleted_at stamped). Recoverable via /trash.
//     → orphan: every asset gets directory_path=NULL (moved to root).
//       Use this when you only want the folder structure gone.
//
// Response:
//   { affected: <int>, op, path, ...args }
//
// Editor role required. Audit event emitted per operation.

import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { and, eq, sql, or, like } from "drizzle-orm";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";
import { recordAuditEvent, AuditAction } from "@/lib/audit";

type Op = "rename" | "move" | "delete";

interface Body {
  op: Op;
  path: string;
  newName?: string;
  newParent?: string;
  action?: "trash" | "orphan";
  workspaceId?: string;
}

function leafName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? "";
}

function parentOf(p: string): string {
  const segs = p.split("/").filter(Boolean);
  segs.pop();
  return segs.length === 0 ? "" : "/" + segs.join("/");
}

export async function POST(request: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<Body>;
  if (
    !body ||
    typeof body.op !== "string" ||
    !["rename", "move", "delete"].includes(body.op)
  ) {
    return NextResponse.json({ error: "op must be rename|move|delete" }, { status: 400 });
  }
  if (typeof body.path !== "string" || body.path.length === 0) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const path = normalizeDirectoryPath(body.path);
  if (!path) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }
  const workspace = body.workspaceId
    ? workspaces.find((w) => w.id === body.workspaceId)
    : workspaces[0];
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const gate = await requireWorkspaceAccessOrResponse(
    user.id,
    workspace.id,
    "editor"
  );
  if (!gate.ok) return gate.response;

  // Match-set: any row at the exact path OR under it. Built once, reused
  // by every op.
  const matchPredicate = and(
    eq(schema.assets.workspaceId, workspace.id),
    or(
      eq(schema.assets.directoryPath, path),
      like(schema.assets.directoryPath, `${path}/%`)
    )
  );

  let affected = 0;
  let auditAction: AuditAction = AuditAction.AssetUpdate;
  let auditMeta: Record<string, unknown> = { op: body.op, path };

  if (body.op === "rename") {
    if (typeof body.newName !== "string" || body.newName.length === 0) {
      return NextResponse.json({ error: "newName required" }, { status: 400 });
    }
    // newName must be a single segment. We sanitise by re-normalising
    // the candidate path; if it doesn't survive, reject.
    if (body.newName.includes("/")) {
      return NextResponse.json(
        { error: "newName must be a single segment (no slashes)" },
        { status: 400 }
      );
    }
    const candidate = `${parentOf(path)}/${body.newName}`;
    const target = normalizeDirectoryPath(candidate);
    if (!target) {
      return NextResponse.json({ error: "Invalid newName" }, { status: 400 });
    }
    // Rewrite the matched prefix to `target`. Postgres `OVERLAY` would
    // work too; concat + substring is more obviously correct.
    const result = await db
      .update(schema.assets)
      .set({
        directoryPath: sql`${target} || SUBSTRING(${schema.assets.directoryPath} FROM ${path.length + 1})`,
      })
      .where(matchPredicate)
      .returning({ id: schema.assets.id });
    affected = result.length;
    auditMeta = { ...auditMeta, newName: body.newName, target };
  } else if (body.op === "move") {
    const rawParent = body.newParent ?? "";
    let newParent: string;
    if (rawParent === "" || rawParent === "/") {
      newParent = "";
    } else {
      const norm = normalizeDirectoryPath(rawParent);
      if (!norm) {
        return NextResponse.json({ error: "Invalid newParent" }, { status: 400 });
      }
      newParent = norm;
    }
    // Prevent moving a folder under itself or a descendant.
    if (newParent === path || newParent.startsWith(`${path}/`)) {
      return NextResponse.json(
        { error: "Cannot move folder under itself" },
        { status: 400 }
      );
    }
    const leaf = leafName(path);
    const target = newParent ? `${newParent}/${leaf}` : `/${leaf}`;
    const result = await db
      .update(schema.assets)
      .set({
        directoryPath: sql`${target} || SUBSTRING(${schema.assets.directoryPath} FROM ${path.length + 1})`,
      })
      .where(matchPredicate)
      .returning({ id: schema.assets.id });
    affected = result.length;
    auditMeta = { ...auditMeta, newParent, target };
  } else if (body.op === "delete") {
    const action = body.action === "orphan" ? "orphan" : "trash";
    if (action === "trash") {
      const result = await db
        .update(schema.assets)
        .set({
          lifecycleState: "trashed",
          deletedAt: new Date(),
        })
        .where(and(matchPredicate, eq(schema.assets.lifecycleState, "active"))!)
        .returning({ id: schema.assets.id });
      affected = result.length;
      auditAction = AuditAction.AssetDelete;
    } else {
      const result = await db
        .update(schema.assets)
        .set({ directoryPath: null })
        .where(matchPredicate)
        .returning({ id: schema.assets.id });
      affected = result.length;
    }
    auditMeta = { ...auditMeta, action };
  }

  // Fire-and-forget audit.
  void recordAuditEvent({
    workspaceId: workspace.id,
    userId: user.id,
    action: auditAction,
    targetType: "folder",
    targetId: path,
    metadata: { ...auditMeta, affected },
    request,
  });

  return NextResponse.json({ op: body.op, path, ...auditMeta, affected });
}
