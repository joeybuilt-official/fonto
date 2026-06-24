# Fonto disaster-recovery restore runbook (M14 / ADR 0058)

This restores the `fonto` schema from an age-encrypted `pg_dump` produced by
`backup-fonto.sh`. R2 originals are durable independently (dual-backend) and are
**not** in these dumps — this recovers the database (metadata, tags, faces,
collections, review state), and the originals are re-linked by their stored R2
keys.

> The age **private key is offline**. You need it (and only it) to decrypt.
> Never copy the private key onto NAS.

## 0. Prerequisites
- The offline age private key (`key.txt`).
- A backup artifact: `/data/backups/fonto/fonto-<TS>.pgdump.gz.age` (+ its
  `.sha256`).
- `age` + `docker` on the host. Postgres container `postgres`.

## 1. Pick + verify the artifact
```bash
ls -t /data/backups/fonto/fonto-*.pgdump.gz.age | head
cd /data/backups/fonto && sha256sum -c fonto-<TS>.pgdump.gz.age.sha256
```

## 2. Drill first (non-destructive, isolated DB)
Always prove the artifact restores before any prod cutover:
```bash
scripts/dr/verify-restore.sh /path/to/offline/key.txt \
  /data/backups/fonto/fonto-<TS>.pgdump.gz.age
# expect: [verify] PASS  (restored into throwaway DB fonto_restore_test, then dropped)
```
A passing drill is the gate that marks ADR 0058 **Accepted**.

## 3. Decrypt to a scratch file (when doing a real restore)
```bash
age -d -i /path/to/offline/key.txt \
  /data/backups/fonto/fonto-<TS>.pgdump.gz.age | gunzip > /tmp/fonto.pgdump
```

## 4. PROD CUTOVER — destructive, do only after a passing drill
**Confirm out loud that you intend to overwrite the live `fonto` schema.**
1. Stop the app + workers so nothing writes mid-restore:
   ```bash
   cd /data/appdata/appdata
   docker compose stop fonto fonto-worker
   ```
2. Restore into the live DB, replacing existing objects, inside one transaction:
   ```bash
   docker cp /tmp/fonto.pgdump postgres:/tmp/fonto.pgdump
   docker exec postgres sh -lc \
     "pg_restore --clean --if-exists --no-owner --no-privileges \
        --single-transaction -d pushd /tmp/fonto.pgdump"
   docker exec postgres rm -f /tmp/fonto.pgdump
   ```
3. Re-apply any drizzle migrations newer than the dump's head (compare
   `fonto.__drizzle_migrations` to `drizzle/migrations/`), applying their SQL in
   order as usual.
4. Restart + smoke:
   ```bash
   docker compose up -d fonto fonto-worker
   curl -fsS https://myfonto.com/api/v1/health
   ```
5. Spot-check the library in the web app (timeline, a few originals load, tags,
   review queue).

## 5. Rollback of the restore
If the cutover went wrong, restore from a *different* (older) good artifact via
the same steps; the dumps are immutable + checksummed, so a known-good one is
always available within the retention window.
