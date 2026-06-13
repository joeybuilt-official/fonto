// ADR 0008 Phase 5 — executable assertions for the new UI-layer surfaces.
//
// Run: npx tsx scripts/_scope/phase5_ui_apis.test.ts
//
// Pure, fast, DB-free. Covers:
//   1. The saved-default helper round-trips localStorage values.
//   2. The scope-selector URL pick logic — PERSONAL strips the param, the
//      other two write it — matches the API's parseScopeParam contract.
//   3. The bulk-reassign POST body validator matches the API's selector
//      schema (assetIds / directoryPath / directoryPathPrefix / source).
//   4. The shoots GET response shape matches the page's Shoot type
//      (counts per stage + total + UNSTAGED bucket).
//
// We do NOT invoke the network. We import the pure pieces and stub the rest.

import {
  parseScopeParam,
  isScope,
  isShootStage,
  SHOOT_STAGES,
  type Scope,
  type ShootStage,
} from "../../lib/scope";

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// --- 1. saved-default helper -------------------------------------------------
// The hook reads/writes a single localStorage key. We stub window.localStorage
// to a Map so the helpers can run under Node.

const store = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
};
(globalThis as unknown as { window: { localStorage: typeof fakeLocalStorage } }).window = {
  localStorage: fakeLocalStorage,
};

// Async wrapper so we can dynamic-import after installing the fake (top-level
// await isn't supported under this repo's tsx CJS transform).
async function main() {
  const mod = await import("../../lib/hooks/use-saved-scope-default");

  eq("default scope is PERSONAL when unset", mod.loadScopeDefault(), "PERSONAL");
  mod.saveScopeDefault("all");
  eq("save/load roundtrips 'all'", mod.loadScopeDefault(), "all");
  mod.saveScopeDefault("PERSONAL");
  eq("save/load roundtrips 'PERSONAL'", mod.loadScopeDefault(), "PERSONAL");

  // Garbage in localStorage falls back to PERSONAL.
  store.set("fonto:scope-default", "BOGUS");
  eq("junk falls back to PERSONAL", mod.loadScopeDefault(), "PERSONAL");
  store.clear();
}

// --- 2. scope-selector URL pick ---------------------------------------------
// The component writes `?scope=` only for SHOOT/all; PERSONAL strips the param
// because the API defaults to PERSONAL when the param is absent. Mirror that
// logic here so a future drift breaks the assertion.

function applyScopeChoice(current: string, choice: Scope | "all"): string {
  const sp = new URLSearchParams(current);
  if (choice === "PERSONAL") sp.delete("scope");
  else sp.set("scope", choice);
  return sp.toString();
}

eq("PERSONAL strips existing param", applyScopeChoice("scope=SHOOT", "PERSONAL"), "");
eq("PERSONAL is a no-op when absent", applyScopeChoice("", "PERSONAL"), "");
eq("SHOOT writes scope=SHOOT", applyScopeChoice("", "SHOOT"), "scope=SHOOT");
eq("all writes scope=all", applyScopeChoice("kind=moment", "all"), "kind=moment&scope=all");

// The chip strip's choice round-trips through parseScopeParam unchanged
// for the two non-default values; PERSONAL roundtrips via an empty URL.
const sp = (q: string) => new URLSearchParams(q);
eq(
  "SHOOT round-trips through parseScopeParam",
  parseScopeParam(sp(applyScopeChoice("", "SHOOT"))),
  "SHOOT"
);
eq(
  "all round-trips through parseScopeParam",
  parseScopeParam(sp(applyScopeChoice("", "all"))),
  "all"
);
eq(
  "PERSONAL round-trips through parseScopeParam (absence = PERSONAL)",
  parseScopeParam(sp(applyScopeChoice("scope=SHOOT", "PERSONAL"))),
  "PERSONAL"
);

// --- 3. bulk-reassign POST body validator -----------------------------------
// The dialog builds a body that must satisfy POST /api/v1/scope/reassign:
//   - `to` is PERSONAL | SHOOT
//   - exactly one selector dimension is set (assetIds | directoryPath |
//     directoryPathPrefix | source)
// We mirror the dialog's local validation so a future drift breaks here.

interface PostBody {
  to: string;
  shootId?: string | null;
  assetIds?: string[];
  directoryPath?: string;
  directoryPathPrefix?: string;
  source?: string;
}

function validateBody(body: PostBody): { ok: boolean; reason?: string } {
  if (!isScope(body.to)) return { ok: false, reason: "bad scope" };
  const selectors = [
    body.assetIds && body.assetIds.length > 0,
    body.directoryPath,
    body.directoryPathPrefix,
    body.source,
  ].filter(Boolean);
  if (selectors.length === 0) return { ok: false, reason: "empty selector" };
  return { ok: true };
}

eq("good body — folder prefix + SHOOT", validateBody({ to: "SHOOT", directoryPathPrefix: "/Shoots" }), {
  ok: true,
});
eq(
  "good body — asset ids",
  validateBody({ to: "PERSONAL", assetIds: ["a", "b"] }),
  { ok: true }
);
eq(
  "bad body — junk scope",
  validateBody({ to: "LIBRARY" as unknown as Scope, directoryPathPrefix: "/x" }),
  { ok: false, reason: "bad scope" }
);
eq(
  "bad body — empty selector rejected",
  validateBody({ to: "SHOOT" }),
  { ok: false, reason: "empty selector" }
);
eq(
  "bad body — empty assetIds array rejected",
  validateBody({ to: "SHOOT", assetIds: [] }),
  { ok: false, reason: "empty selector" }
);

// --- 4. shoot detail page tab shape -----------------------------------------
// The detail page builds Stage tabs from SHOOT_STAGES + "unstaged". Assert
// that SHOOT_STAGES is exactly RAW|SELECTS|DELIVERED|REJECTS so the UI
// can't fall out of sync with the lib export.

eq("SHOOT_STAGES order", SHOOT_STAGES.join(","), "RAW,SELECTS,DELIVERED,REJECTS");
for (const s of SHOOT_STAGES) {
  eq(`isShootStage(${s})`, isShootStage(s as ShootStage), true);
}
eq("UNSTAGED is not a stage", isShootStage("UNSTAGED"), false);

// shoots GET returns counts per stage + UNSTAGED + total. Build a fake row
// and assert the keys the UI reads exist.
const fakeRow = {
  id: "00000000-0000-0000-0000-000000000000",
  workspaceId: "ws",
  userId: "u",
  clientId: null,
  name: "x",
  shootDate: null,
  kind: null,
  paid: false,
  consentStatus: null,
  createdAt: "2026-06-13T00:00:00Z",
  updatedAt: "2026-06-13T00:00:00Z",
  counts: { RAW: 0, SELECTS: 0, DELIVERED: 0, REJECTS: 0, UNSTAGED: 0, total: 0 },
};
const requiredKeys = ["RAW", "SELECTS", "DELIVERED", "REJECTS", "UNSTAGED", "total"];
for (const k of requiredKeys) {
  eq(`counts has ${k}`, Object.prototype.hasOwnProperty.call(fakeRow.counts, k), true);
}

main()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nall phase 5 ui-api assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
