// ADR 0008 — scope partition (PERSONAL vs SHOOT) shared logic.
//
// `scope` is the authoritative single-valued partition on every asset. It
// drives DEFAULT behavior: the timeline, "On This Day", search and most
// personal surfaces show only PERSONAL assets unless a caller opts in.
//
// Auto-assignment is deliberately conservative (Option A, no inference): an
// asset becomes SHOOT only on an EXPLICIT signal — a user's choice at upload,
// or an upload whose folder matches a configured shoot-folder prefix. We never
// guess SHOOT from camera/lens/EXIF, because the dangerous failure direction is
// mislabeling a PERSONAL photo as SHOOT (it would silently vanish from the
// timeline). Mislabeling a SHOOT as PERSONAL is harmless + reversible (it just
// shows in the timeline until reassigned). So we bias hard to PERSONAL.

import { type SQL, eq } from "drizzle-orm";
import { assets } from "./db/schema";

export type Scope = "PERSONAL" | "SHOOT";

/** A scope value, or the sentinel "all" meaning "do not filter by scope". */
export type ScopeFilter = Scope | "all";

export const SHOOT_STAGES = ["RAW", "SELECTS", "DELIVERED", "REJECTS"] as const;
export type ShootStage = (typeof SHOOT_STAGES)[number];

export function isScope(v: unknown): v is Scope {
  return v === "PERSONAL" || v === "SHOOT";
}

export function isShootStage(v: unknown): v is ShootStage {
  return typeof v === "string" && (SHOOT_STAGES as readonly string[]).includes(v);
}

/**
 * Configured folder prefixes whose uploads are auto-classified SHOOT. Comma-
 * separated, normalised (leading `/`, no trailing `/`). Empty by default —
 * auto-SHOOT is pure opt-in until the operator configures it, so out of the box
 * the only way to get a SHOOT asset is an explicit user choice.
 */
export function shootDirPrefixes(): string[] {
  const raw = process.env.FONTO_SHOOT_DIR_PREFIXES ?? "";
  return raw
    .split(",")
    .map((p) => p.trim().replace(/\/+$/, ""))
    .filter((p) => p.length > 0);
}

export interface DeriveScopeInput {
  /** Explicit caller/user choice — wins over every heuristic. */
  explicit?: Scope | null;
  /** Pre-normalised virtual folder path of the upload (or null). */
  directoryPath?: string | null;
}

/** Deterministic, inference-free scope assignment at ingestion. Defaults PERSONAL. */
export function deriveScope(input: DeriveScopeInput): Scope {
  if (isScope(input.explicit)) return input.explicit;
  const dir = input.directoryPath;
  if (dir) {
    for (const prefix of shootDirPrefixes()) {
      if (dir === prefix || dir.startsWith(`${prefix}/`)) return "SHOOT";
    }
  }
  return "PERSONAL";
}

/**
 * Parse the `?scope=` query param. PERSONAL is the default for every browsable
 * surface; `?scope=SHOOT` flips to the shoot browser; `?scope=all` disables the
 * filter (an explicit all-assets view).
 */
export function parseScopeParam(searchParams: URLSearchParams): ScopeFilter {
  const v = searchParams.get("scope");
  if (v === "SHOOT") return "SHOOT";
  if (v === "all") return "all";
  return "PERSONAL";
}

/**
 * Drizzle condition for a scope filter, or `undefined` when no filter should be
 * applied (`scope=all`). Push the result onto a WHERE array, skipping undefined:
 *   const cond = scopeCond(parseScopeParam(sp)); if (cond) where.push(cond);
 */
export function scopeCond(scope: ScopeFilter): SQL | undefined {
  return scope === "all" ? undefined : eq(assets.scope, scope);
}
