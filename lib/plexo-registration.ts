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
    { id: "fonto.asset.list",      type: "tool" as const, name: "List Assets",     config: { description: "List assets in the Fonto workspace, optionally filtered by classification.",  bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.asset.search",    type: "tool" as const, name: "Search Assets",   config: { description: "Search assets by filename, AI description, or extracted text.",            bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.collection.list", type: "tool" as const, name: "List Collections",config: { description: "List curated asset groups (collections) in the workspace.",               bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.tag.list",        type: "tool" as const, name: "List Tags",       config: { description: "List tags (labels) in the Fonto workspace.",                              bridge: "@joeybuilt/fonto-bridge" } },
    { id: "fonto.tag.create",      type: "tool" as const, name: "Create Tag",      config: { description: "Create a new tag in the Fonto workspace.",                                bridge: "@joeybuilt/fonto-bridge" } },
  ],

  eventContracts: [
    "fonto.asset.uploaded",
    "fonto.asset.classified",
    "fonto.asset.deleted",
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
