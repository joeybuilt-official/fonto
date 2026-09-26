# fonto-worker autoscaler — Phase 9b

Queue-depth-driven reconciler that scales `fonto-worker` between 1 and
4 replicas. Default signals: BullMQ waiting+delayed counts across the
throughput-bound queues (`asset-processing`, `thumbnails`,
`clip-embedding`, `face-detect`, `ocr`).

C2 resolution (2026-05-25): queue depth wins over CPU. This image
encodes that choice — no CPU sampler.

## What it does, every tick (default 30s)

1. Reads waiting+delayed counts from Valkey for each watched queue.
2. Sums to a total depth `D`.
3. Decides:
   - `D ≥ AUTOSCALER_SCALE_UP` (default 20)  → `target = current + 1`
   - `D ≤ AUTOSCALER_SCALE_DOWN` (default 5) → `target = current − 1`
   - otherwise                                → hold
4. Clamps `target` to `[FLOOR, CEILING]` (default 1..4).
5. If a previous scale ran less than `AUTOSCALER_DAMPENING_MS` ago
   (default 60_000), holds instead.
6. Shells out to `docker compose -f $COMPOSE_FILE up -d --scale
   fonto-worker=N --no-recreate fonto-worker`.

Set `AUTOSCALER_DRY_RUN=1` to log decisions without invoking compose —
useful during the initial verification window.

## Env knobs

| Var | Default | Notes |
|---|---|---|
| `REDIS_URL` | `redis://valkey:6379` | Same Valkey the workers use |
| `AUTOSCALER_QUEUES` | `asset-processing,thumbnails,clip-embedding,face-detect,ocr` | Comma-separated BullMQ queue names |
| `AUTOSCALER_TICK_MS` | `30000` | Reconcile interval |
| `AUTOSCALER_SCALE_UP` | `20` | Total depth above which we scale up |
| `AUTOSCALER_SCALE_DOWN` | `5` | Total depth below which we scale down |
| `AUTOSCALER_FLOOR` | `1` | Minimum replicas |
| `AUTOSCALER_CEILING` | `4` | Maximum replicas |
| `AUTOSCALER_DAMPENING_MS` | `60000` | Minimum gap between scale actions |
| `AUTOSCALER_DRY_RUN` | unset | Set to `1` to skip the compose call |
| `AUTOSCALER_COMPOSE_FILE` | `/etc/fonto-compose/docker-compose.yml` | Path inside the container |
| `AUTOSCALER_WORKER_SERVICE` | `fonto-worker` | The compose service name to scale |

## Compose snippet (operator wires on the host)

Add to the joeybuilt compose file. Required: docker socket + the
compose file itself, mounted read-only.

```yaml
fonto-autoscaler:
  build:
    context: /path/to/fonto
    dockerfile: ops/autoscaler/Dockerfile
  container_name: fonto-autoscaler
  restart: unless-stopped
  networks: [fonto]
  depends_on: [valkey]
  environment:
    REDIS_URL: redis://valkey:6379
    AUTOSCALER_DRY_RUN: "1"            # flip to 0 after verification
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    # AUTOSCALER_COMPOSE_FILE points here; mount YOUR infra compose file read-only.
    - <host-path>/docker-compose.yml:/etc/fonto-compose/docker-compose.yml:ro
```

`depends_on: [valkey]` keeps the first tick from spamming connection
errors during boot. The compose file mount is read-only — the
autoscaler reads it through `docker compose up --scale` but never
writes.

## Verification

Once the container is up in dry-run mode:

```bash
docker logs -f fonto-autoscaler
# expect a "hold" line every 30s during quiet load
```

Synthetic load (enqueue 100 jobs into asset-processing):

```bash
# From inside the fonto repo with REDIS_URL set:
pnpm tsx ops/autoscaler/test-enqueue.ts 100
```

Watch the autoscaler logs — within one tick you should see a
`would_scale` decision targeting 2, then 3, 4 as more ticks pass with
queue depth still high. After the workers drain (real workers in
non-dry-run; instantly in dry-run since nothing actually processes
the test jobs), expect `would_scale` back down toward 1.

To clear out the test jobs without scaling:

```bash
pnpm tsx ops/autoscaler/test-enqueue.ts drain
```

## Why not the Docker Engine API directly?

We could `dockerode.createContainer` from a template instead of
shelling out to compose. Two reasons we don't:

1. Compose owns the source of truth for the worker's full spec
   (networks, mounts, env, healthcheck). Cloning a running container's
   `HostConfig` introduces drift the moment the compose file changes.
2. `docker compose up --scale` is the documented "create the Nth
   replica from this service" surface. Anything cleverer is more code
   for the same outcome.

The tradeoff is that the autoscaler container needs `docker-cli` +
`docker-cli-compose` installed (~50 MB). That's cheap.
