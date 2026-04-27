// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = "force-dynamic";

import { plexoAvailable } from "@/lib/plexo";

export async function GET() {
  if (!plexoAvailable()) {
    return Response.json({ connected: false });
  }
  try {
    const PLEXO_URL = process.env.PLEXO_URL!.replace(/\/$/, "");
    const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY!;
    const res = await fetch(`${PLEXO_URL}/api/v1/health`, {
      headers: { Authorization: `Bearer ${PLEXO_SERVICE_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    return Response.json({ connected: res.ok });
  } catch {
    return Response.json({ connected: false });
  }
}
