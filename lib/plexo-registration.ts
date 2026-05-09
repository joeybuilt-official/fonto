/**
 * Plexo App Profile registration for Fonto.
 *
 * Called once at boot via instrumentation.ts. Idempotent — Plexo Core upserts
 * on appId. Tool ids align with @joeybuilt/fonto-bridge tool surface.
 */
import { createPlexoClient, type AppExtension } from "@joeybuilt/plexo-sdk/connect"

const PLEXO_URL = process.env.PLEXO_URL ?? ""
const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ""

const EXTENSIONS: AppExtension[] = [
  { id: "fonto.asset.list",              type: "tool", name: "List Assets",                  config: { description: "List assets in the Fonto workspace, optionally filtered by classification, collection, or tag." } },
  { id: "fonto.asset.search",            type: "tool", name: "Search Assets",                config: { description: "Search assets by filename, AI description, or extracted text." } },
  { id: "fonto.asset.get",               type: "tool", name: "Get Asset",                    config: { description: "Fetch full details of a single asset by ID, including description and extracted text." } },
  { id: "fonto.asset.delete",            type: "tool", name: "Delete Asset",                 config: { description: "Soft-delete an asset by ID." } },
  { id: "fonto.asset.tag",               type: "tool", name: "Tag Asset",                    config: { description: "Apply a tag to an asset." } },
  { id: "fonto.asset.untag",             type: "tool", name: "Untag Asset",                  config: { description: "Remove a tag from an asset." } },
  { id: "fonto.collection.list",         type: "tool", name: "List Collections",             config: { description: "List curated asset groups (collections) in the workspace." } },
  { id: "fonto.collection.get",          type: "tool", name: "Get Collection",               config: { description: "Fetch details of a single collection by ID." } },
  { id: "fonto.collection.create",       type: "tool", name: "Create Collection",            config: { description: "Create a new collection in the Fonto workspace." } },
  { id: "fonto.collection.update",       type: "tool", name: "Update Collection",            config: { description: "Rename or update the description of a collection." } },
  { id: "fonto.collection.delete",       type: "tool", name: "Delete Collection",            config: { description: "Delete a collection. Assets in the collection are NOT deleted." } },
  { id: "fonto.collection.add_asset",    type: "tool", name: "Add Asset to Collection",      config: { description: "Add an asset to a collection." } },
  { id: "fonto.collection.remove_asset", type: "tool", name: "Remove Asset from Collection", config: { description: "Remove an asset from a collection." } },
  { id: "fonto.tag.list",                type: "tool", name: "List Tags",                    config: { description: "List tags (labels) in the Fonto workspace." } },
  { id: "fonto.tag.create",              type: "tool", name: "Create Tag",                   config: { description: "Create a new tag in the Fonto workspace." } },
  { id: "fonto.tag.update",               type: "tool", name: "Update Tag",                  config: { description: "Rename or recolor a tag." } },
  { id: "fonto.tag.delete",              type: "tool", name: "Delete Tag",                   config: { description: "Delete a tag by ID. The tag is removed from all assets it was applied to." } },
]

const EVENT_CONTRACTS = [
  "fonto.asset.uploaded",
  "fonto.asset.processed",
  "fonto.asset.classified",
  "fonto.document.processed",
  "fonto.receipt.detected",
  "fonto.asset.deleted",
  "fonto.asset.archivable",
  "fonto.asset.archived",
  "fonto.asset.purged",
  "fonto.tag.created",
]

export async function registerWithPlexoCore(): Promise<void> {
  if (!PLEXO_URL || !PLEXO_SERVICE_KEY) {
    console.warn("[plexo] PLEXO_URL or PLEXO_SERVICE_KEY not set — running without Core (standalone mode)")
    return
  }

  const client = createPlexoClient({
    appId: "fonto",
    plexoUrl: PLEXO_URL,
    serviceKey: PLEXO_SERVICE_KEY,
    displayName: "Fonto",
    extensions: EXTENSIONS,
    eventContracts: EVENT_CONTRACTS,
    resilience: { registrationBackoffMs: [5_000, 10_000, 20_000] },
  })

  await client.register()
}
