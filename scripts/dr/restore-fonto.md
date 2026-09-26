# Fonto disaster-recovery restore runbook (M14 / ADR 0058)

This restores the `fonto` schema from an age-encrypted `pg_dump` produced by
`backup-fonto.sh`. Object-storage originals are durable independently
(dual-backend) and are **not** in these dumps — this recovers the database
(metadata, tags, faces, collections, review state), and the originals are
re-linked by their stored storage keys.

> The age **private key is offline**. You need it (and only it) to decrypt.
> Never copy the private key onto the production host.

Throughout, `<backup-dir>` is the `DEST` you configured for `backup-fonto.sh`,
`<your-db>` is the database holding the `fonto` schema (the `DB` env var),
`<repo-path>` is your checkout, and `<YOUR_APP_ORIGIN>` is your instance's public
origin. This runbook intentionally names none of them.

## 0. Prerequisites
- The offline age private key (`key.txt`).
- A backup artifact: `<backup-dir>/fonto-<TS>.pgdump.gz.age` (+ its `.sha256`).
- `age` + `docker` on the host. Postgres container `postgres`.

## 1. Pick + verify the artifact
```bash
ls -t <backup-dir>/fonto-*.pgdump.gz.age | head
cd <backup-dir> && sha256sum -c fonto-<TS>.pgdump.gz.age.sha256
```

## 2. Drill first (non-destructive, isolated DB)
Always prove the artifact restores before any prod cutover:
```bash
scripts/dr/verify-restore.sh /path/to/offline/key.txt \
  <backup-dir>/fonto-<TS>.pgdump.gz.age
# expect: [verify] PASS  (restored into throwaway DB fonto_restore_test, then dropped)
```
A passing drill is the gate that marks ADR 0058 **Accepted**.

## 3. Decrypt to a scratch file (when doing a real restore)
```bash
age -d -i /path/to/offline/key.txt \
  <backup-dir>/fonto-<TS>.pgdump.gz.age | gunzip > /tmp/fonto.pgdump
```

## 4. PROD CUTOVER — destructive, do only after a passing drill
**Confirm out loud that you intend to overwrite the live `fonto` schema.**
1. Stop the app + workers so nothing writes mid-restore:
   ```bash
   cd <repo-path>            # wherever your compose file lives
   docker compose stop fonto fonto-worker
   ```
2. Restore into the live DB, replacing existing objects, inside one transaction:
   ```bash
   docker cp /tmp/fonto.pgdump postgres:/tmp/fonto.pgdump
   docker exec postgres sh -lc \
     "pg_restore --clean --if-exists --no-owner --no-privileges \
        --single-transaction -d <your-db> /tmp/fonto.pgdump"
   docker exec postgres rm -f /tmp/fonto.pgdump
   ```
3. Re-apply any migrations newer than the dump's head. The applied-file log is
   `fonto.__db_apply_log` (written by `scripts/db-apply.sh`); compare it against
   `drizzle/migrations/`:
   ```bash
   docker exec postgres psql -U postgres -d <your-db> -tAc \
     "SELECT filename FROM fonto.__db_apply_log ORDER BY filename DESC LIMIT 3;"
   ls drizzle/migrations | tail -3
   ```
   Then run the applier — it is idempotent, skips everything already logged, and
   applies only the newer files in strict filename order:
   ```bash
   DATABASE_URL="postgresql://postgres@localhost:5432/<your-db>" pnpm db:setup
   ```
   Note the dump also restores `__db_apply_log` itself (it lives in the `fonto`
   schema and is included by `--schema=fonto`), which is what makes step 3's
   comparison meaningful. If your dump predates `__db_apply_log` (it has
   `fonto.__drizzle_migrations` rows instead), `db-apply.sh` refuses to guess and
   tells you to run `pnpm db:setup:adopt` after verifying the head matches.
4. Restart + smoke:
   ```bash
   docker compose up -d fonto fonto-worker
   curl -fsS https://<YOUR_APP_ORIGIN>/api/v1/health
   ```
5. Spot-check the library in the web app (timeline, a few originals load, tags,
   review queue).

## 5. Rollback of the restore
If the cutover went wrong, restore from a *different* (older) good artifact via
the same steps; the dumps are immutable + checksummed, so a known-good one is
always available within the retention window.
