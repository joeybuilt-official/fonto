// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { db, schema } from "@/lib/db"
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm"
import { bumpCollectionSeq } from "@/lib/db/seq"

function isServiceKeyRequest(req: NextRequest): boolean {
  const svcKey = process.env.PLEXO_SERVICE_KEY
  const rawToken = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (!svcKey || !rawToken) return false
  const a = Buffer.from(rawToken)
  const b = Buffer.from(svcKey)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function resolveWorkspaceId(userId: string): Promise<string | null> {
  const [ws] = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId))
    .limit(1)
  return ws?.id ?? null
}

export async function GET(request: NextRequest) {
  if (!isServiceKeyRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const entity = searchParams.get("entity")
  const userId = searchParams.get("userId")

  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 })

  const workspaceId = await resolveWorkspaceId(userId)
  if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

  if (entity === "asset") {
    const id = searchParams.get("id")

    if (id) {
      const [asset] = await db.select({
        id: schema.assets.id,
        filename: schema.assets.filename,
        mimeType: schema.assets.mimeType,
        sizeBytes: schema.assets.sizeBytes,
        classification: schema.assets.classification,
        description: schema.assets.description,
        extractedText: schema.assets.extractedText,
        capturedAt: schema.assets.capturedAt,
        createdAt: schema.assets.createdAt,
        lifecycleState: schema.assets.lifecycleState,
      })
        .from(schema.assets)
        .where(and(eq(schema.assets.workspaceId, workspaceId), eq(schema.assets.id, id)))
        .limit(1)
      if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
      return NextResponse.json({ asset })
    }

    const subtype = searchParams.get("subtype")
    const collectionId = searchParams.get("collectionId")
    const tagId = searchParams.get("tagId")
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "30", 10), 100)

    const assetSelect = {
      id: schema.assets.id,
      filename: schema.assets.filename,
      mimeType: schema.assets.mimeType,
      sizeBytes: schema.assets.sizeBytes,
      classification: schema.assets.classification,
      description: schema.assets.description,
      capturedAt: schema.assets.capturedAt,
      createdAt: schema.assets.createdAt,
    }

    if (collectionId) {
      const assets = await db.select(assetSelect)
        .from(schema.assets)
        .innerJoin(schema.collectionAssets, eq(schema.collectionAssets.assetId, schema.assets.id))
        .where(and(
          eq(schema.assets.workspaceId, workspaceId),
          eq(schema.assets.lifecycleState, "active"),
          eq(schema.collectionAssets.collectionId, collectionId),
        ))
        .orderBy(desc(schema.assets.createdAt))
        .limit(limit)
      return NextResponse.json({ assets, total: assets.length })
    }

    if (tagId) {
      const assets = await db.select(assetSelect)
        .from(schema.assets)
        .innerJoin(schema.assetTags, eq(schema.assetTags.assetId, schema.assets.id))
        .where(and(
          eq(schema.assets.workspaceId, workspaceId),
          eq(schema.assets.lifecycleState, "active"),
          eq(schema.assetTags.tagId, tagId),
        ))
        .orderBy(desc(schema.assets.createdAt))
        .limit(limit)
      return NextResponse.json({ assets, total: assets.length })
    }

    const conditions = [
      eq(schema.assets.workspaceId, workspaceId),
      eq(schema.assets.lifecycleState, "active"),
    ]
    if (subtype) conditions.push(eq(schema.assets.classification, subtype))

    const assets = await db.select(assetSelect)
      .from(schema.assets)
      .where(and(...conditions))
      .orderBy(desc(schema.assets.createdAt))
      .limit(limit)

    return NextResponse.json({ assets, total: assets.length })
  }

  if (entity === "asset_search") {
    const q = searchParams.get("q")?.trim()
    if (!q) return NextResponse.json({ error: "q required" }, { status: 400 })
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 50)
    const pattern = `%${q}%`

    const assets = await db.select({
      id: schema.assets.id,
      filename: schema.assets.filename,
      classification: schema.assets.classification,
      description: schema.assets.description,
    })
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.workspaceId, workspaceId),
          eq(schema.assets.lifecycleState, "active"),
          or(
            ilike(schema.assets.filename, pattern),
            ilike(schema.assets.description, pattern),
            ilike(schema.assets.extractedText, pattern),
          ),
        ),
      )
      .orderBy(desc(schema.assets.createdAt))
      .limit(limit)

    return NextResponse.json({ assets, total: assets.length })
  }

  if (entity === "collection") {
    const id = searchParams.get("id")

    if (id) {
      const [collection] = await db.select({
        id: schema.collections.id,
        name: schema.collections.name,
        description: schema.collections.description,
        createdAt: schema.collections.createdAt,
      })
        .from(schema.collections)
        .where(and(eq(schema.collections.workspaceId, workspaceId), eq(schema.collections.id, id), isNull(schema.collections.deletedAt)))
        .limit(1)
      if (!collection) return NextResponse.json({ error: "Collection not found" }, { status: 404 })
      return NextResponse.json({ collection })
    }

    const collections = await db.select({
      id: schema.collections.id,
      name: schema.collections.name,
      description: schema.collections.description,
      createdAt: schema.collections.createdAt,
    })
      .from(schema.collections)
      .where(and(eq(schema.collections.workspaceId, workspaceId), isNull(schema.collections.deletedAt)))
      .orderBy(desc(schema.collections.createdAt))

    return NextResponse.json({ collections, total: collections.length })
  }

  if (entity === "tag") {
    const tags = await db.select({
      id: schema.tags.id,
      name: schema.tags.name,
      color: schema.tags.color,
      aiSuggested: schema.tags.aiSuggested,
    })
      .from(schema.tags)
      .where(eq(schema.tags.workspaceId, workspaceId))

    return NextResponse.json({ tags, total: tags.length })
  }

  return NextResponse.json({ error: "entity must be asset, asset_search, collection, or tag" }, { status: 400 })
}

const tagCreateSchema = z.object({
  entity: z.literal("tag"),
  action: z.literal("create"),
  userId: z.string().min(1),
  name: z.string().min(1).max(100),
  color: z.string().max(20).optional(),
})

const collectionCreateSchema = z.object({
  entity: z.literal("collection"),
  action: z.literal("create"),
  userId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
})

const assetTagSchema = z.object({
  entity: z.literal("asset"),
  action: z.enum(["tag", "untag"]),
  userId: z.string().min(1),
  assetId: z.string().uuid(),
  tagId: z.string().uuid(),
})

const collectionAssetSchema = z.object({
  entity: z.literal("collection"),
  action: z.enum(["add_asset", "remove_asset"]),
  userId: z.string().min(1),
  collectionId: z.string().uuid(),
  assetId: z.string().uuid(),
})

const assetDeleteSchema = z.object({
  entity: z.literal("asset"),
  action: z.literal("delete"),
  userId: z.string().min(1),
  id: z.string().uuid(),
})

const collectionUpdateSchema = z.object({
  entity: z.literal("collection"),
  action: z.literal("update"),
  userId: z.string().min(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
})

const collectionDeleteSchema = z.object({
  entity: z.literal("collection"),
  action: z.literal("delete"),
  userId: z.string().min(1),
  id: z.string().uuid(),
})

const tagUpdateSchema = z.object({
  entity: z.literal("tag"),
  action: z.literal("update"),
  userId: z.string().min(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  color: z.string().max(20).optional(),
})

const tagDeleteSchema = z.object({
  entity: z.literal("tag"),
  action: z.literal("delete"),
  userId: z.string().min(1),
  id: z.string().uuid(),
})

export async function POST(request: NextRequest) {
  if (!isServiceKeyRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const baseEntity = (body as { entity?: string }).entity
  const action = (body as { action?: string }).action

  if (baseEntity === "tag" && action === "create") {
    const v = tagCreateSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const [tag] = await db.insert(schema.tags).values({
      workspaceId,
      name: v.data.name.trim(),
      color: v.data.color ?? "#6366f1",
    }).returning({ id: schema.tags.id, name: schema.tags.name })

    return NextResponse.json({ tag }, { status: 201 })
  }

  if (baseEntity === "collection" && action === "create") {
    const v = collectionCreateSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const [collection] = await db.insert(schema.collections).values({
      workspaceId,
      userId: v.data.userId,
      name: v.data.name.trim(),
      description: v.data.description ?? "",
    }).returning({ id: schema.collections.id, name: schema.collections.name })

    return NextResponse.json({ collection }, { status: 201 })
  }

  if (baseEntity === "asset" && (action === "tag" || action === "untag")) {
    const v = assetTagSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    if (action === "tag") {
      const [existing] = await db.select({ id: schema.assetTags.id })
        .from(schema.assetTags)
        .where(and(eq(schema.assetTags.assetId, v.data.assetId), eq(schema.assetTags.tagId, v.data.tagId)))
        .limit(1)
      if (!existing) {
        await db.insert(schema.assetTags).values({ assetId: v.data.assetId, tagId: v.data.tagId })
      }
      return NextResponse.json({ tagged: true })
    } else {
      await db.delete(schema.assetTags)
        .where(and(eq(schema.assetTags.assetId, v.data.assetId), eq(schema.assetTags.tagId, v.data.tagId)))
      return NextResponse.json({ untagged: true })
    }
  }

  if (baseEntity === "collection" && (action === "add_asset" || action === "remove_asset")) {
    const v = collectionAssetSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    if (action === "add_asset") {
      const [existing] = await db.select({ id: schema.collectionAssets.id })
        .from(schema.collectionAssets)
        .where(and(eq(schema.collectionAssets.collectionId, v.data.collectionId), eq(schema.collectionAssets.assetId, v.data.assetId)))
        .limit(1)
      if (!existing) {
        await db.insert(schema.collectionAssets).values({ collectionId: v.data.collectionId, assetId: v.data.assetId })
      }
      return NextResponse.json({ added: true })
    } else {
      await db.delete(schema.collectionAssets)
        .where(and(eq(schema.collectionAssets.collectionId, v.data.collectionId), eq(schema.collectionAssets.assetId, v.data.assetId)))
      return NextResponse.json({ removed: true })
    }
  }

  if (baseEntity === "asset" && action === "delete") {
    const v = assetDeleteSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const [asset] = await db.update(schema.assets)
      .set({ lifecycleState: "deleted" })
      .where(and(eq(schema.assets.id, v.data.id), eq(schema.assets.workspaceId, workspaceId)))
      .returning({ id: schema.assets.id, filename: schema.assets.filename })

    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
    return NextResponse.json({ deleted: true, asset })
  }

  if (baseEntity === "collection" && action === "update") {
    const v = collectionUpdateSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const updates: Record<string, unknown> = {}
    if (v.data.name !== undefined) updates.name = v.data.name.trim()
    if (v.data.description !== undefined) updates.description = v.data.description

    if (!Object.keys(updates).length) return NextResponse.json({ error: "No fields to update" }, { status: 400 })

    const [collection] = await db.update(schema.collections)
      .set(updates)
      .where(and(eq(schema.collections.id, v.data.id), eq(schema.collections.workspaceId, workspaceId)))
      .returning({ id: schema.collections.id, name: schema.collections.name })

    if (!collection) return NextResponse.json({ error: "Collection not found" }, { status: 404 })
    return NextResponse.json({ collection })
  }

  if (baseEntity === "collection" && action === "delete") {
    const v = collectionDeleteSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const [existing] = await db.select({ id: schema.collections.id })
      .from(schema.collections)
      .where(and(eq(schema.collections.id, v.data.id), eq(schema.collections.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) return NextResponse.json({ error: "Collection not found" }, { status: 404 })

    // Soft-delete (delta-sync): drop the join rows but keep the collection
    // row, stamping deleted_at + bumping seq so it surfaces as a `delete`
    // tombstone on /sync/collections instead of vanishing.
    await db.delete(schema.collectionAssets).where(eq(schema.collectionAssets.collectionId, v.data.id))
    await db.update(schema.collections)
      .set({ deletedAt: new Date() })
      .where(eq(schema.collections.id, v.data.id))
    await bumpCollectionSeq(workspaceId, v.data.id)

    return NextResponse.json({ deleted: true })
  }

  if (baseEntity === "tag" && action === "update") {
    const v = tagUpdateSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const updates: Record<string, unknown> = {}
    if (v.data.name !== undefined) updates.name = v.data.name.trim()
    if (v.data.color !== undefined) updates.color = v.data.color

    if (!Object.keys(updates).length) return NextResponse.json({ error: "No fields to update" }, { status: 400 })

    const [tag] = await db.update(schema.tags)
      .set(updates)
      .where(and(eq(schema.tags.id, v.data.id), eq(schema.tags.workspaceId, workspaceId)))
      .returning({ id: schema.tags.id, name: schema.tags.name })

    if (!tag) return NextResponse.json({ error: "Tag not found" }, { status: 404 })
    return NextResponse.json({ tag })
  }

  if (baseEntity === "tag" && action === "delete") {
    const v = tagDeleteSchema.safeParse(body)
    if (!v.success) return NextResponse.json({ error: "Invalid request", details: v.error.flatten() }, { status: 400 })

    const workspaceId = await resolveWorkspaceId(v.data.userId)
    if (!workspaceId) return NextResponse.json({ error: "No Fonto workspace for user" }, { status: 404 })

    const [existing] = await db.select({ id: schema.tags.id })
      .from(schema.tags)
      .where(and(eq(schema.tags.id, v.data.id), eq(schema.tags.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) return NextResponse.json({ error: "Tag not found" }, { status: 404 })

    await db.delete(schema.assetTags).where(eq(schema.assetTags.tagId, v.data.id))
    await db.delete(schema.tags).where(eq(schema.tags.id, v.data.id))

    return NextResponse.json({ deleted: true })
  }

  return NextResponse.json({ error: "Unsupported entity or action" }, { status: 400 })
}
