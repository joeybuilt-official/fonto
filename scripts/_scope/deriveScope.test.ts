// ADR 0008 — executable assertions for the pure scope logic.
// Run: npx tsx scripts/_scope/deriveScope.test.ts
// (Repo has no vitest; this is a self-contained tsx harness like the other
// scripts/ tooling. Exits non-zero on failure.)
import { deriveScope, parseScopeParam, isScope, isShootStage } from "../../lib/scope";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Default bias: no signal -> PERSONAL (the safe direction).
eq("default personal", deriveScope({}), "PERSONAL");
eq("null dir personal", deriveScope({ directoryPath: null }), "PERSONAL");
eq("ordinary dir personal", deriveScope({ directoryPath: "/Camera Roll" }), "PERSONAL");

// Explicit choice wins over everything.
eq("explicit SHOOT", deriveScope({ explicit: "SHOOT" }), "SHOOT");
process.env.FONTO_SHOOT_DIR_PREFIXES = "/Shoots";
eq(
  "explicit PERSONAL beats prefix",
  deriveScope({ explicit: "PERSONAL", directoryPath: "/Shoots/wedding" }),
  "PERSONAL"
);

// Folder-prefix heuristic (configured).
process.env.FONTO_SHOOT_DIR_PREFIXES = "/Shoots,/Clients";
eq("prefix exact", deriveScope({ directoryPath: "/Shoots" }), "SHOOT");
eq("prefix descendant", deriveScope({ directoryPath: "/Shoots/2026/smith-wedding" }), "SHOOT");
eq("second prefix", deriveScope({ directoryPath: "/Clients/acme" }), "SHOOT");
eq("non-prefix stays personal", deriveScope({ directoryPath: "/ShootsX/nope" }), "PERSONAL");
delete process.env.FONTO_SHOOT_DIR_PREFIXES;
eq("no prefixes -> personal even on /Shoots", deriveScope({ directoryPath: "/Shoots/x" }), "PERSONAL");

// parseScopeParam defaults + values.
const sp = (q: string) => new URLSearchParams(q);
eq("param default personal", parseScopeParam(sp("")), "PERSONAL");
eq("param SHOOT", parseScopeParam(sp("scope=SHOOT")), "SHOOT");
eq("param all", parseScopeParam(sp("scope=all")), "all");
eq("param junk -> personal", parseScopeParam(sp("scope=bogus")), "PERSONAL");

// Guards.
eq("isScope true", isScope("SHOOT"), true);
eq("isScope false", isScope("LIBRARY"), false);
eq("isShootStage true", isShootStage("SELECTS"), true);
eq("isShootStage false", isShootStage("FINAL"), false);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall scope assertions passed");
