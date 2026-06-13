import { db, schema } from "@/lib/db";
import { inArray, eq } from "drizzle-orm";

function arg(name: string): string | null {
  const f = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!f) return null;
  return f === `--${name}` ? "" : f.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const workspaceId = arg("workspace")!;
  const shas = (arg("shas") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const rows = await db
    .select({
      id: schema.assets.id,
      sha256: schema.assets.sha256,
      filename: schema.assets.filename,
      ws: schema.assets.workspaceId,
      lifecycle: schema.assets.lifecycleState,
      sync: schema.assets.syncState,
      createdAt: schema.assets.createdAt,
      deletedAt: schema.assets.deletedAt,
      purgedAt: schema.assets.purgedAt,
    })
    .from(schema.assets)
    .where(inArray(schema.assets.sha256, shas));
  console.log(`requested shas=${shas.length} rows=${rows.length}`);
  for (const r of rows) {
    console.log(
      `${r.sha256.slice(0, 12)} ws=${r.ws === workspaceId ? "THIS" : r.ws.slice(0, 8)} life=${r.lifecycle} sync=${r.sync} created=${r.createdAt?.toISOString?.() ?? r.createdAt} deleted=${r.deletedAt?.toISOString?.() ?? r.deletedAt} ${r.filename}`
    );
  }
  const found = new Set(rows.map((r) => r.sha256));
  for (const s of shas) if (!found.has(s)) console.log(`${s.slice(0, 12)} NO-ROW-ANY-WORKSPACE`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
