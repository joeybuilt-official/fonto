export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { db, schema } from "@/lib/db"
import { and, desc, eq, ilike, or } from "drizzle-orm"

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
    const collections = await db.select({
      id: schema.collections.id,
      name: schema.collections.name,
      description: schema.collections.description,
      createdAt: schema.collections.createdAt,
    })
      .from(schema.collections)
      .where(eq(schema.collections.workspaceId, workspaceId))
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

  return NextResponse.json({ error: "Unsupported entity or action" }, { status: 400 })
}
