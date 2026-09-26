import { type NextRequest, NextResponse } from "next/server";

const PUBLIC_PREFIXES = ["/", "/login", "/api/health", "/api/auth", "/share"];

function isPublic(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some(
    (p) => p !== "/" && (pathname === p || pathname.startsWith(p + "/")),
  );
}

/**
 * Phase 5 (UX consolidation) — old → new route map.
 *
 * Every entry is an EXACT pathname match. Detail / `[id]` children are
 * intentionally NOT mapped (the Phase 2 + 3 recons established that
 * `/app/projects/<id>`, `/app/stacks/<id>`, `/app/collections/<id>` etc.
 * still resolve through their original page handlers). Only the
 * top-level "landing" routes of each consolidated page are redirected.
 *
 * `params` are MERGED with the incoming request's search params. The
 * incoming params win over the pre-applied ones for keys that collide,
 * because the user (or the deep-link) is more likely to know what they
 * want than a defaulted Phase-5 hint — e.g. an old bookmark with an
 * explicit `?favorite=1` should keep that param even though the
 * map's `?mime=image/` is also applied.
 *
 * 307 (temporary) is used deliberately, NOT 308 (permanent), so that:
 *   - revert is a no-op (operator can drop the table and old routes
 *     resume serving from their deprecation-banner pages).
 *   - browsers don't aggressively cache the redirect and lock users
 *     into the new URL forever.
 *
 * Three release cycles after Phase 7 (sidebar cleanup) lands and old
 * bookmarks stop being meaningfully observed, the operator may
 * graduate this to 308 + remove the deprecation-banner pages
 * entirely.
 */
type RedirectRule = { to: string; params?: Record<string, string> };

const REDIRECT_MAP: Record<string, RedirectRule> = {
  // Phase 1 — Library consolidation. 5 routes → 1 surface.
  "/app/photos":            { to: "/app/library", params: { kind: "moment" } },
  "/app/timeline":          { to: "/app/library" },
  // /app/memories is a live route again: the unified library cannot express
  // its "on this day across prior years" query (captured_mmdd_utc functional
  // index, migration 0023), so the dedicated surface fills a real gap.
  "/app/folders":           { to: "/app/library", params: { pathPrefix: "/" } },
  "/app/documents":         { to: "/app/library", params: { kind: "document" } },
  "/app/trash":             { to: "/app/library", params: { lc: "trashed" } },

  // Phase 2 — Collections fan-out. Detail routes (/app/<x>/[id]) stay
  // as-is and are NOT redirected here.
  "/app/projects":          { to: "/app/collections", params: { tab: "projects" } },
  "/app/smart-collections": { to: "/app/collections", params: { tab: "smart" } },
  "/app/stacks":            { to: "/app/collections", params: { tab: "stacks" } },

  // Phase 3 — Updates merge.
  "/app/dashboard":         { to: "/app/updates", params: { section: "uploads" } },
  "/app/activity":          { to: "/app/updates", params: { section: "activity" } },
  "/app/shared":            { to: "/app/updates", params: { section: "shared" } },

  // Phase 4 — Explore hub. People + Map are still real routes (the
  // Explore tiles link to them), so they are NOT redirected. Only
  // future Things-related deep links would land here.
};

function applyRedirect(
  request: NextRequest,
  rule: RedirectRule,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = rule.to;
  if (rule.params) {
    for (const [k, v] of Object.entries(rule.params)) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
  }
  return NextResponse.redirect(url, 307);
}

export function middleware(request: NextRequest) {
  // Canonical host. The auth client + session cookie are bound to the apex
  // origin configured via NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL. A page loaded
  // on the www. variant makes the sign-in fetch CROSS-ORIGIN → blocked
  // by CORS → login throws "Couldn't sign in". Redirect www → apex (read the
  // public host from the forwarded header so it works behind the proxy).
  const fwdHost =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "";
  if (fwdHost.startsWith("www.")) {
    const apex = fwdHost.slice(4);
    const dest = `https://${apex}${request.nextUrl.pathname}${request.nextUrl.search}`;
    return NextResponse.redirect(dest, 308);
  }

  const pathname = request.nextUrl.pathname;

  // Public routes (login, health, auth callbacks, share viewer) bypass
  // the consolidation map entirely.
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // Phase 5 redirect map — exact pathname match only.
  const rule = REDIRECT_MAP[pathname];
  if (rule) return applyRedirect(request, rule);

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Excluding `.apk` so a docker-cp'd APK gets served by Next's raw static
    // handler before the App Router can render (and ISR-cache) the not-found
    // page for /fonto.apk. Otherwise the mobile-republish-without-restart
    // flow loses to the cached 404 after any fresh container build.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|apk)$).*)",
  ],
};
