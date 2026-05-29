# Fonto deploy chain (NAS)

Reference for every UX-consolidation phase. Run after each phase's
code commit lands on `origin/main`.

## Identity table

| What | Path / value |
|---|---|
| Source-of-truth checkout (claude-code-rc / your dev container) | `/data/appdata/app-stack/workspace/fonto/` |
| NAS compose build context | `/data/appdata/appdata/source/fonto/` |
| NAS compose file | `/data/appdata/appdata/docker-compose.yml` |
| Web container | `fonto` |
| Worker container | `fonto-worker` |
| Bull-board container | `fonto-bullboard` |
| Autoscaler (DRY_RUN=1) | `fonto-autoscaler` |
| Postgres container | `postgres` |
| Postgres database | `pushd` (schema `fonto`) |
| Secret backups dir | `/data/_secrets/` |
| Public origin | `https://myfonto.com` (Cloudflare tunnel → `fonto`) |

## Step 1 — Sync source to build context (every phase)

```bash
ssh <server> 'rsync -a --delete \
  --exclude=node_modules/ --exclude=.next/ --exclude=dist/ --exclude=.pnpm-store/ \
  /data/appdata/app-stack/workspace/fonto/ \
  /data/appdata/appdata/source/fonto/'
```

(NAS's source dir was diverged from `origin/main` until 2026-05-25;
the rsync replaces it wholesale rather than fighting the dirty tree.
The old dir is backed up at `/data/_secrets/fonto-source-pre-deploy-*.tar.gz`.)

## Step 2 — When the phase touches DB schema

```bash
# A. Backup first.
TS=$(date -u +%Y%m%dT%H%M%SZ)
ssh <server> "docker exec postgres pg_dump -U postgres -Fc -d pushd \
  > /data/_secrets/fonto-pushd-pre-NNNN-${TS}.pgdump"

# B. Apply migration. Drizzle has no journal — raw psql + single tx.
ssh <server> "cat /data/appdata/appdata/source/fonto/drizzle/migrations/NNNN_*.sql \
  | (echo 'BEGIN;'; cat; echo 'COMMIT;') \
  | docker exec -i postgres psql -U postgres -d pushd -v ON_ERROR_STOP=1"

# C. Verify the new tables / columns exist before rebuilding images.
```

## Step 3 — Rebuild image(s)

Pick the minimum set for the phase's surface:

```bash
# Web-only change (UX phases usually):
ssh <server> 'cd /data/appdata/appdata && docker compose build fonto'

# Worker change (rare for UX phases):
ssh <server> 'cd /data/appdata/appdata && docker compose build fonto-worker'

# Bullboard (only when lib/queue/* changes):
ssh <server> 'cd /data/appdata/appdata && docker compose build fonto-bullboard'
```

Build context is large (~11 MB transfer + many layers). First build of
the day is slow; subsequent are cached. Pipe through `tee /tmp/fonto-build.log`
when run via `run_in_background: true` so the foreground stays responsive.

## Step 4 — Recreate container(s)

```bash
ssh <server> 'cd /data/appdata/appdata && docker compose up -d --force-recreate fonto'
```

`--force-recreate` ensures the new image is picked up even when the
service file hasn't changed.

## Step 5 — Smoke

```bash
ssh <server> 'sleep 8 && \
  curl -sI -o /dev/null -w "/: %{http_code}\n" https://myfonto.com/ && \
  curl -sI -o /dev/null -w "/app/library: %{http_code}\n" https://myfonto.com/app/library && \
  docker logs fonto --tail 5'
```

Expected: `/` → 200, app routes → 307 (unauth redirect to login),
worker logs show your new schedule registration / job pickup if
worker was rebuilt.

## Git identity for NAS-side commits (none required here)

Commits happen in the dev checkout (`/workspace/fonto/`), not on the host.
Use env vars per CLAUDE.md "NEVER update the git config":

```bash
GIT_AUTHOR_NAME="Claude (Joeybuilt)" \
GIT_AUTHOR_EMAIL="claude@joeybuilt.local" \
GIT_COMMITTER_NAME="Claude (Joeybuilt)" \
GIT_COMMITTER_EMAIL="claude@joeybuilt.local" \
  git commit -m "..."
```

## Rollback

```bash
# Schema rollback (last good dump):
ssh <server> "docker exec -i postgres pg_restore -U postgres -c -d pushd \
  < /data/_secrets/fonto-pushd-pre-NNNN-<TS>.pgdump"

# Code rollback (previous image tag):
# Image tags are all 'latest' today. Roll back via `git revert` + redeploy.

# Compose rollback (autoscaler block added 2026-05-25):
ssh <server> 'cp /data/_secrets/docker-compose-pre-autoscaler-*.yml \
  /data/appdata/appdata/docker-compose.yml'
```

## Mobile APK republish (test distribution)

The operator's phone can't reliably download the Codemagic artifact link
(Gmail webview / Chrome .apk block). Workaround: serve the APK from the
fonto app's public dir at `https://myfonto.com/fonto.apk` (clean direct
download, correct apk MIME). After a green Codemagic build:

1. Get the build's signed APK URL from the "[Build SUCCEEDED]" email to
   user@example.com (Gmail MCP: get_thread → app-release.apk
   "Install" href; links expire 24h).
2. On NAS (full docker, NOT the read-only fonto proxy):
   ```bash
   ssh <server> 'curl -fsSL "<signed-apk-url>" -o /tmp/fonto.apk \
     && docker cp /tmp/fonto.apk fonto:/app/public/fonto.apk \
     && rm /tmp/fonto.apk && docker restart fonto'
   ```
   The restart is REQUIRED — Next.js standalone scans `public/` at boot, so
   a file `docker cp`'d into a running container isn't served until restart.
3. Verify: `curl -sI https://myfonto.com/fonto.apk` → 200,
   `application/vnd.android.package-archive`.

Ephemeral: wiped on the next `docker compose up` recreate (not baked into
the image). Re-run after any backend redeploy.

## Known orphan

`fonto-web` container (Image: fonto-web, Up 23h+ at session-start) lives
outside the appdata compose file and is NOT what the
Cloudflare tunnel routes to. Cleanup: `ssh <server> 'docker rm -f fonto-web'`
when convenient.
