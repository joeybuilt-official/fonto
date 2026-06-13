// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { requireWorkspaceAccessOrResponse } from "@/lib/authz";
import { db, schema } from "@/lib/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { assetStorageKey, assetStorageKeyLegacy } from "@/lib/r2";
import { storage } from "@/lib/storage";
import { isStoragePolicy } from "@/lib/storage/policy";
import { isShootStage } from "@/lib/scope";
import { plexoPublishEvent } from "@/lib/plexo";
import { nextSeq } from "@/lib/db/seq";
import { serializeAsset } from "@/lib/assets/createAssetRow";
import { normalizeDirectoryPath } from "@/lib/folders/normalize";
import { recordAuditEvent, AuditAction } from "@/lib/audit";

const LIFECYCLE_EVENTS: Record<string, string> = {
  archivable: "ext.fonto.asset.archivable",
  archived: "ext.fonto.asset.archived",
  purged: "ext.fonto.asset.purged",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspaceIds = workspaces.map((w) => w.id);
  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ asset: serializeAsset(asset) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const body = (await request.json()) as {
    lifecycleState?: string;
    trash?: boolean;
    restore?: boolean;
    isFavorite?: boolean;
    rating?: number;
    // UX-2 — drag-drop a single asset between folders. Pass `null` to
    // move it to the workspace root.
    directoryPath?: string | null;
    // Phase B6 (storage placement) — per-asset policy override. `null` clears
    // the override (asset follows the workspace default). C4: only r2_only +
    // mirror are selectable this initiative.
    storagePolicyOverride?: string | null;
    // ADR 0008 — per-asset SHOOT stage (RAW|SELECTS|DELIVERED|REJECTS). `null`
    // clears the stage (still scope='SHOOT' but no bucket).
    shootStage?: string | null;
  };

  const updates: Record<string, unknown> = {};
  let emitEvent: string | null = null;

  if (body.trash) {
    updates.lifecycleState = "trashed";
    updates.deletedAt = new Date();
  } else if (body.restore) {
    updates.lifecycleState = "active";
    updates.deletedAt = null;
  } else if (body.lifecycleState) {
    const valid = ["active", "archivable", "archived", "purged"];
    if (!valid.includes(body.lifecycleState)) {
      return NextResponse.json({ error: "Invalid lifecycleState" }, { status: 400 });
    }
    updates.lifecycleState = body.lifecycleState;
    if (body.lifecycleState === "archived") {
      updates.archivedAt = new Date();
    }
    if (body.lifecycleState === "purged") {
      updates.purgedAt = new Date();
    }
    emitEvent = LIFECYCLE_EVENTS[body.lifecycleState] ?? null;
  }

  // Phase 3.4 — favorites + 0..5 star ratings. Either or both can come in
  // alongside (or independent of) a lifecycle mutation. The DB also has a
  // CHECK constraint on `rating IN [0,5]`; we validate here so callers get
  // a 400 instead of a 500.
  if (body.isFavorite !== undefined) {
    if (typeof body.isFavorite !== "boolean") {
      return NextResponse.json({ error: "isFavorite must be boolean" }, { status: 400 });
    }
    updates.isFavorite = body.isFavorite;
  }
  if (body.rating !== undefined) {
    if (
      typeof body.rating !== "number" ||
      !Number.isInteger(body.rating) ||
      body.rating < 0 ||
      body.rating > 5
    ) {
      return NextResponse.json(
        { error: "rating must be an integer 0..5" },
        { status: 400 }
      );
    }
    updates.rating = body.rating;
  }

  // UX-2 — directoryPath move (drag-drop). `null` strips the asset to
  // the workspace root; a string is normalised through the same helper
  // every upload site uses so a bogus path won't poison the tree.
  if (body.directoryPath !== undefined) {
    if (body.directoryPath === null || body.directoryPath === "" || body.directoryPath === "/") {
      updates.directoryPath = null;
    } else if (typeof body.directoryPath !== "string") {
      return NextResponse.json(
        { error: "directoryPath must be a string or null" },
        { status: 400 }
      );
    } else {
      const normalised = normalizeDirectoryPath(body.directoryPath);
      if (!normalised) {
        return NextResponse.json(
          { error: "Invalid directoryPath" },
          { status: 400 }
        );
      }
      updates.directoryPath = normalised;
    }
  }

  // Phase B6 (storage placement) — per-asset override. `null`/""/"default"
  // clears it (asset follows the workspace policy); otherwise it must be a
  // selectable policy (r2_only | mirror — C4 defers local_only).
  let overrideTouched = false;
  if (body.storagePolicyOverride !== undefined) {
    const v = body.storagePolicyOverride;
    if (v === null || v === "" || v === "default") {
      updates.storagePolicyOverride = null;
    } else if (isStoragePolicy(v) && (v === "r2_only" || v === "mirror")) {
      updates.storagePolicyOverride = v;
    } else {
      return NextResponse.json(
        { error: "storagePolicyOverride must be null, r2_only, or mirror" },
        { status: 400 }
      );
    }
    overrideTouched = true;
  }

  if (body.shootStage !== undefined) {
    if (body.shootStage === null) {
      updates.shootStage = null;
    } else if (!isShootStage(body.shootStage)) {
      return NextResponse.json(
        { error: "shootStage must be null or RAW|SELECTS|DELIVERED|REJECTS" },
        { status: 400 }
      );
    } else {
      updates.shootStage = body.shootStage;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Phase 2.3 — find the asset's workspace so we can bump its delta-sync
  // seq alongside the lifecycle/state mutation. We have to know the
  // workspace_id specifically (not just "one the user owns") to keep the
  // per-workspace counter monotonic.
  const [existing] = await db
    .select({ workspaceId: schema.assets.workspaceId })
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase 3.1 — mutating an asset requires editor or higher on its workspace.
  const gate = await requireWorkspaceAccessOrResponse(user.id, existing.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  updates.seq = await nextSeq(existing.workspaceId, "asset");

  // TODO(phase-3.2): once `recordAuditEvent(AuditAction.AssetUpdate, ...)`
  // lands, emit an audit row here covering the field-level diff (which of
  // lifecycle/isFavorite/rating changed). Favorites + ratings are client-
  // visible so they want to show up in the per-asset history.

  const [updated] = await db
    .update(schema.assets)
    .set(updates)
    .where(
      and(
        eq(schema.assets.id, id),
        inArray(schema.assets.workspaceId, workspaceIds)
      )
    )
    .returning();

  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase B6 — if the override changed, (re)enqueue a mirror-sync. The handler
  // reads the effective policy and no-ops when the asset isn't mirror-bound or
  // is already synced, so a flip ONTO mirror starts mirroring and a flip off is
  // harmless. Fault-tolerant; never block the response.
  if (overrideTouched) {
    void (async () => {
      try {
        const { storageSyncQueue, JobNames } = await import("@/lib/queue");
        await storageSyncQueue().add(JobNames.StorageSync, {
          assetId: id,
          workspaceId: existing.workspaceId,
        });
      } catch (err) {
        console.warn("[fonto] storage-sync enqueue after override skipped:", err);
      }
    })();
  }

  if (emitEvent) {
    void plexoPublishEvent(emitEvent, {
      assetId: id,
      filename: updated.filename,
      mimeType: updated.mimeType,
      lifecycleState: updated.lifecycleState,
    });
  }

  // Phase 3.2 — audit. Pick the most specific action verb so the admin
  // viewer's filter dropdown is useful (restore/archive/delete are distinct
  // from a generic update).
  const auditAction: AuditAction =
    body.trash
      ? AuditAction.AssetDelete
      : body.restore
        ? AuditAction.AssetRestore
        : updates.lifecycleState === "archived"
          ? AuditAction.AssetArchive
          : AuditAction.AssetUpdate;
  void recordAuditEvent({
    workspaceId: existing.workspaceId,
    userId: user.id,
    action: auditAction,
    targetType: "asset",
    targetId: id,
    metadata: {
      lifecycleState: updated.lifecycleState,
      filename: updated.filename,
    },
    request,
  });

  return NextResponse.json({ asset: serializeAsset(updated) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) return NextResponse.json({ error: "No workspace" }, { status: 404 });
  const workspaceIds = workspaces.map((w) => w.id);

  const [asset] = await db
    .select()
    .from(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds)))
    .limit(1);

  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Phase 3.1 — deleting an asset requires editor or higher.
  const gate = await requireWorkspaceAccessOrResponse(user.id, asset.workspaceId, "editor");
  if (!gate.ok) return gate.response;

  const key = assetStorageKey(asset.workspaceId, asset.id, asset.filename);
  const legacyKey = assetStorageKeyLegacy(asset.workspaceId, asset.id, asset.filename);

  try {
    await storage().delete(key);
  } catch {
    // Try legacy key path for assets uploaded before the fonto/ prefix migration
    try {
      await storage().delete(legacyKey);
    } catch (err) {
      console.error("[fonto] R2 delete failed for both key paths, proceeding with DB delete:", err);
    }
  }

  await db
    .delete(schema.assets)
    .where(and(eq(schema.assets.id, id), inArray(schema.assets.workspaceId, workspaceIds)));

  // Phase 9.1 — decrement workspace usage (fire-and-forget; reconcile corrects drift).
  void db
    .update(schema.workspaces)
    .set({ usageBytes: sql`GREATEST(0, ${schema.workspaces.usageBytes} - ${asset.sizeBytes})` })
    .where(eq(schema.workspaces.id, asset.workspaceId));

  void plexoPublishEvent("ext.fonto.asset.purged", {
    assetId: id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    reason: "hard-delete",
  });

  void recordAuditEvent({
    workspaceId: asset.workspaceId,
    userId: user.id,
    action: AuditAction.AssetDelete,
    targetType: "asset",
    targetId: id,
    metadata: {
      filename: asset.filename,
      mimeType: asset.mimeType,
      hardDelete: true,
    },
    request,
  });

  return NextResponse.json({ deleted: true });
}
