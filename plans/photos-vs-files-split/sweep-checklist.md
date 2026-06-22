# Pre-split sweep — operator checklist

The sweep re-derives KIND for the rows that would otherwise land on the wrong
surface. Run it with the flag OFF in prod, off-hours. Do NOT run it from the
implementation session.

Script: `scripts/photos-vs-files-presplit-sweep.ts` (thin wrapper over
`classify-only-rerun.ts --scope=presplit`). CLIP-only, cached `clip_vec`, no LLM,
no re-OCR, no model cost.

Predicate swept: `kind IS NULL OR (kind='moment' AND mime_type IN ('image/png','image/gif'))`,
active image rows with a `clip_vec`, in the given workspace.

## Order (must hold)
1. `v2.0.363` installed; `LIBRARY_SURFACE_SPLIT_ENABLED` flipped ON locally; you validated Photos/Files/Inbox on device + web.
2. Confirm the flag is still **OFF in prod**.
3. Dry-run the sweep, review proposed changes.
4. Run the sweep for real.
5. Spot-check distribution.
6. Only then flip `LIBRARY_SURFACE_SPLIT_ENABLED` default ON in prod.

## Commands

Personal workspace id (prod): `9d4a122f-…` (use the full UUID).

Dry run (no writes — single chunk, prints proposed class/kind changes):
```
DATABASE_URL=<prod fonto DSN> \
  tsx scripts/photos-vs-files-presplit-sweep.ts --workspace-id=<uuid> --dry-run
```

Real run (chunks of 2000, loops until the predicate drains):
```
DATABASE_URL=<prod fonto DSN> \
  tsx scripts/photos-vs-files-presplit-sweep.ts --workspace-id=<uuid>
```
Optional: `--chunk=2000` (default), `--max-chunks=100` (safety cap; re-run if hit).

Run from the Fonto deploy tree (has tsx + DATABASE_URL). Same execution context
as the existing `classify-only-rerun.ts` runs.

## Verify after
- [ ] `SELECT kind, count(*) FROM fonto.assets WHERE workspace_id='<uuid>' AND lifecycle_state='active' GROUP BY kind` — `NULL` bucket near zero; screenshot/graphics up by the png/gif-moment reclassifications; moment down accordingly.
- [ ] Inbox banner count in the app drops toward 0.
- [ ] Spot-check a handful of reclassified png/gif assets land on the expected surface.

## Notes / caveats
- NULL-kind rows WITHOUT a `clip_vec` (still in the `captured`/processing drain) are NOT touched by this CLIP-only sweep — they pick up a KIND through the normal pipeline as they finish processing. Re-run the sweep later if a residual NULL count remains after the draining completes.
- The sweep only re-derives KIND/classification; it never re-CLIPs, re-OCRs, or calls a model. It uses the SAME `deriveKind`/override helpers as live ingest, so there is no classifier-rule drift.
