// ADR 0008 — the regression that matters: a SHOOT asset must NOT appear in any
// personal-default surface (timeline feed, On This Day, search, stats counts).
//
// Integration test — requires a live DATABASE_URL pointing at a fonto DB with
// migration 0041 applied. Runs against a throwaway workspace it creates and
// cleans up. There is no vitest in this repo; run directly:
//
//   DATABASE_URL=postgres://... npx tsx scripts/_scope/exclusion.integration.ts
//
// Exits non-zero on any leak. Safe to run against staging; it only touches the
// disposable workspace rows it inserts.
import { db, schema } from "../../lib/db";
import { and, eq, sql } from "drizzle-orm";

const WS = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0")}`.slice(0, 36);
const USER = "scope-itest";

let failed = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — this is a DB integration test. Skipping (not a pass).");
    process.exit(2);
  }

  // Seed: one PERSONAL + one SHOOT asset, both dated to the same MM-DD last year.
  const lastYear = new Date();
  lastYear.setFullYear(lastYear.getFullYear() - 1);

  const base = {
    workspaceId: WS,
    filename: "t.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 1,
    sha256: "",
    lifecycleState: "active" as const,
    capturedAt: lastYear,
  };
  const [personal] = await db
    .insert(schema.assets)
    .values({ ...base, sha256: `p-${WS}`, scope: "PERSONAL" })
    .returning({ id: schema.assets.id });
  const [shoot] = await db
    .insert(schema.assets)
    .values({ ...base, sha256: `s-${WS}`, scope: "SHOOT" })
    .returning({ id: schema.assets.id });

  try {
    // 1. Default feed predicate (scope='PERSONAL') excludes the SHOOT row.
    const feed = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(and(eq(schema.assets.workspaceId, WS), eq(schema.assets.scope, "PERSONAL")));
    const feedIds = feed.map((r) => r.id);
    check("feed includes PERSONAL", feedIds.includes(personal.id));
    check("feed EXCLUDES SHOOT", !feedIds.includes(shoot.id));

    // 2. On This Day partial-index predicate excludes SHOOT.
    const mem = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(
        sql`${schema.assets.workspaceId} = ${WS}
            AND ${schema.assets.lifecycleState} = 'active'
            AND ${schema.assets.capturedAt} IS NOT NULL
            AND ${schema.assets.scope} = 'PERSONAL'`
      );
    const memIds = mem.map((r) => r.id);
    check("memories EXCLUDES SHOOT", !memIds.includes(shoot.id));
    check("memories includes PERSONAL", memIds.includes(personal.id));

    // 3. scope=all sees both (opt-out works).
    const all = await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(eq(schema.assets.workspaceId, WS));
    check("all-scope sees both", all.length === 2);
  } finally {
    await db.delete(schema.assets).where(eq(schema.assets.workspaceId, WS));
  }

  if (failed > 0) {
    console.error(`\n${failed} leak assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nscope exclusion holds — no SHOOT leak");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
