// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/server";
import { getUserWorkspaces } from "@/lib/workspace";
import { db, schema } from "@/lib/db";
import { and, asc, eq, gt } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Page size for the keyset-paginated asset scan. Bounds peak memory: we never
// hold more than one page of rows, and never build one giant in-memory string.
const ASSET_PAGE = 500;
// Defensive upper bound on pages so a bug can't spin forever (each page strictly
// advances the id cursor, so this is unreachable in practice).
const MAX_PAGES = 100_000;

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaces = await getUserWorkspaces(user.id);
  if (!workspaces.length) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  // Honor ?workspaceId when supplied (validated against membership); otherwise
  // export every workspace the caller belongs to. The previous `workspaces[0]`
  // silently dropped every other workspace a multi-workspace user owned.
  const { searchParams } = new URL(request.url);
  const requestedWorkspaceId = searchParams.get("workspaceId");
  let targets = workspaces;
  if (requestedWorkspaceId) {
    const match = workspaces.find((w) => w.id === requestedWorkspaceId);
    if (!match) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    targets = [match];
  }

  const encoder = new TextEncoder();

  // Stream a single valid JSON document chunk-by-chunk instead of loading the
  // whole assets table and JSON.stringify-ing it into one buffer (OOM risk on a
  // 100k+ row library). Assets are keyset-paginated by id.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        push(
          `{"exportedAt":${JSON.stringify(new Date().toISOString())},"workspaces":[`
        );

        let firstWs = true;
        for (const ws of targets) {
          push(
            `${firstWs ? "" : ","}{"workspace":${JSON.stringify({
              id: ws.id,
              name: ws.name,
            })},"assets":[`
          );
          firstWs = false;

          let cursor: string | null = null;
          let firstAsset = true;
          for (let page = 0; page < MAX_PAGES; page++) {
            const conds = [eq(schema.assets.workspaceId, ws.id)];
            if (cursor) conds.push(gt(schema.assets.id, cursor));

            const rows = await db
              .select({
                id: schema.assets.id,
                filename: schema.assets.filename,
                mimeType: schema.assets.mimeType,
                sizeBytes: schema.assets.sizeBytes,
                sha256: schema.assets.sha256,
                syncState: schema.assets.syncState,
                processingState: schema.assets.processingState,
                lifecycleState: schema.assets.lifecycleState,
                source: schema.assets.source,
                classification: schema.assets.classification,
                description: schema.assets.description,
                capturedAt: schema.assets.capturedAt,
                createdAt: schema.assets.createdAt,
              })
              .from(schema.assets)
              .where(and(...conds))
              .orderBy(asc(schema.assets.id))
              .limit(ASSET_PAGE);

            if (rows.length === 0) break;
            for (const a of rows) {
              push(
                `${firstAsset ? "" : ","}${JSON.stringify({
                  id: a.id,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  sizeBytes: a.sizeBytes,
                  sha256: a.sha256,
                  syncState: a.syncState,
                  processingState: a.processingState,
                  lifecycleState: a.lifecycleState,
                  source: a.source,
                  classification: a.classification,
                  description: a.description,
                  capturedAt: a.capturedAt?.toISOString(),
                  createdAt: a.createdAt.toISOString(),
                })}`
              );
              firstAsset = false;
            }
            if (rows.length < ASSET_PAGE) break;
            cursor = rows[rows.length - 1].id;
          }

          push(`],"collections":[`);

          const collectionsData = await db
            .select({
              id: schema.collections.id,
              name: schema.collections.name,
              description: schema.collections.description,
              createdAt: schema.collections.createdAt,
            })
            .from(schema.collections)
            .where(eq(schema.collections.workspaceId, ws.id));

          let firstCol = true;
          for (const c of collectionsData) {
            push(
              `${firstCol ? "" : ","}${JSON.stringify({
                id: c.id,
                name: c.name,
                description: c.description,
                createdAt: c.createdAt.toISOString(),
              })}`
            );
            firstCol = false;
          }
          push(`]}`);
        }

        push(`]}`);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="fonto-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
