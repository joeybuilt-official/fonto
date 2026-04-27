/**
 * Plexo App Profile registration for Fonto.
 *
 * Called once at boot (via instrumentation.ts) when PLEXO_URL is configured.
 * Idempotent — Plexo Core upserts on appId, so re-starting never duplicates.
 * Tool ids must align with @joeybuilt/fonto-bridge tool surface.
 */

const PLEXO_URL = process.env.PLEXO_URL?.replace(/\/$/, "") ?? ""
const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ""

const PROFILE = {
  appId: "fonto",
  schemaNamespace: "fonto",
  displayName: "Fonto",
  port: 3500,
  domain: "myfonto.com",

  extensions: [
    { id: "fonto.asset.list",             type: "tool" as const, name: "List Assets",            config: { description: "List assets in the Fonto workspace, optionally filtered by classification, collection, or tag.",     bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.asset.search",           type: "tool" as const, name: "Search Assets",          config: { description: "Search assets by filename, AI description, or extracted text.",                                      bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.asset.get",              type: "tool" as const, name: "Get Asset",              config: { description: "Fetch full details of a single asset by ID, including description and extracted text.",              bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.asset.delete",           type: "tool" as const, name: "Delete Asset",           config: { description: "Soft-delete an asset by ID.",                                                                        bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.asset.tag",              type: "tool" as const, name: "Tag Asset",              config: { description: "Apply a tag to an asset.",                                                                           bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.asset.untag",            type: "tool" as const, name: "Untag Asset",            config: { description: "Remove a tag from an asset.",                                                                        bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.list",        type: "tool" as const, name: "List Collections",       config: { description: "List curated asset groups (collections) in the workspace.",                                         bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.get",         type: "tool" as const, name: "Get Collection",         config: { description: "Fetch details of a single collection by ID.",                                                       bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.create",      type: "tool" as const, name: "Create Collection",      config: { description: "Create a new collection in the Fonto workspace.",                                                    bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.update",      type: "tool" as const, name: "Update Collection",      config: { description: "Rename or update the description of a collection.",                                                  bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.delete",      type: "tool" as const, name: "Delete Collection",      config: { description: "Delete a collection. Assets in the collection are NOT deleted.",                                    bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.add_asset",   type: "tool" as const, name: "Add Asset to Collection",config: { description: "Add an asset to a collection.",                                                                     bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.remove_asset",type: "tool" as const, name: "Remove Asset from Collection", config: { description: "Remove an asset from a collection.",                                                          bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.tag.list",               type: "tool" as const, name: "List Tags",              config: { description: "List tags (labels) in the Fonto workspace.",                                                        bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.tag.create",             type: "tool" as const, name: "Create Tag",             config: { description: "Create a new tag in the Fonto workspace.",                                                          bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.tag.update",             type: "tool" as const, name: "Update Tag",             config: { description: "Rename or recolor a tag.",                                                                          bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.tag.delete",             type: "tool" as const, name: "Delete Tag",             config: { description: "Delete a tag by ID. The tag is removed from all assets it was applied to.",                         bridge: "@joeybuilt/fonto-bridge" } },
  ],

  eventContracts: [
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
  ],
}

async function attemptRegistration(): Promise<boolean> {
  try {
    const res = await fetch(`${PLEXO_URL}/api/v1/profiles/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
        "X-App-Id": "fonto",
      },
      body: JSON.stringify(PROFILE),
      signal: AbortSignal.timeout(8_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => `HTTP ${res.status}`)
      console.error("[plexo] Registration failed:", body)
      return false
    }

    console.info("[plexo] Registered with Core as appId=fonto (schema=fonto)")
    return true
  } catch (err) {
    console.warn("[plexo] Core unreachable:", (err as Error).message)
    return false
  }
}

export async function registerWithPlexoCore(): Promise<void> {
  if (!PLEXO_URL || !PLEXO_SERVICE_KEY) {
    console.warn("[plexo] PLEXO_URL or PLEXO_SERVICE_KEY not set — running without Core (standalone mode)")
    return
  }

  if (await attemptRegistration()) return

  const delays = [5_000, 10_000, 20_000]
  for (const delay of delays) {
    console.info(`[plexo] Retrying registration in ${delay / 1000}s...`)
    await new Promise((r) => setTimeout(r, delay))
    if (await attemptRegistration()) return
  }

  console.warn("[plexo] All registration retries exhausted — running standalone")
}
