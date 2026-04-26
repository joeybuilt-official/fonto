import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function ensurePersonalWorkspace(userId: string) {
  const existing = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [workspace] = await db
    .insert(schema.workspaces)
    .values({
      userId,
      name: "Personal",
      slug: "personal",
      kind: "personal",
      color: "#6366f1",
    })
    .returning();

  return workspace;
}

export async function getUserWorkspaces(userId: string) {
  return db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.userId, userId));
}
