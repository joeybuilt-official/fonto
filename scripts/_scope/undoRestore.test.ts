// ADR 0008 — executable assertions for resolveUndoRestore (the shoot-delete
// dangling-ref guard). Run: npx tsx scripts/_scope/undoRestore.test.ts
// (Repo has no vitest; self-contained tsx harness. Non-zero exit on failure.)
import { resolveUndoRestore } from "../../lib/scope";

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

const live = new Set(["shoot-A", "shoot-B"]);

// Normal reassign-undo: PERSONAL had no shoot -> restore PERSONAL, no shoot.
eq("personal/no-shoot", resolveUndoRestore("PERSONAL", null, live), { scope: "PERSONAL", shootId: null });

// SHOOT->PERSONAL reassign undo, shoot still exists -> re-file into it.
eq("shoot-live restore", resolveUndoRestore("SHOOT", "shoot-A", live), { scope: "SHOOT", shootId: "shoot-A" });

// The guarded edge: shoot was DELETED -> keep PERSONAL, do NOT re-orphan.
eq("shoot-gone -> personal", resolveUndoRestore("SHOOT", "shoot-GONE", live), { scope: "PERSONAL", shootId: null });

// from_shoot_id undefined behaves like null.
eq("undefined shoot", resolveUndoRestore("PERSONAL", undefined, live), { scope: "PERSONAL", shootId: null });

// SHOOT scope with no recorded shoot id (unfiled) + live set irrelevant -> restore SHOOT unfiled.
eq("shoot unfiled", resolveUndoRestore("SHOOT", null, live), { scope: "SHOOT", shootId: null });

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall undo-restore assertions passed");
