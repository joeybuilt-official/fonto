# Fonto ops — dashboards + alerts as code

## What's in here

```
ops/
  prometheus.yml                          # scrape config + rule_files ref
  alertmanager.yml                        # routing (Discord + email)
  alerts/
    rules.yml                             # alerting rules — queue, latency, processing
  grafana/
    provisioning/
      datasources/prometheus.yaml         # auto-add Prometheus on Grafana boot
      dashboards/fonto.yaml               # auto-import dashboards from /etc/grafana/dashboards
    dashboards/
      overview.json
      processing.json
      queue-depth.json
      api-latency.json
```

## Compose wiring

Add these three services to YOUR Fonto compose file (the shipped
`docker-compose.yml` defines an `observability` profile with the same shape —
enable it with `docker compose --profile observability up -d`, or copy the block
below into your own infra compose file). Mount this `ops/` dir read-only into
each service. `<host-path>` and `<repo-path>` stand for your own directories:
nothing here should name the maintainer's host layout.

```yaml
prometheus:
  image: prom/prometheus:latest
  container_name: fonto-prometheus
  restart: unless-stopped
  networks: [fonto]
  volumes:
    - <repo-path>/ops/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    - <repo-path>/ops/alerts/rules.yml:/etc/prometheus/rules.yml:ro
    - prometheus-data:/prometheus
  command:
    - --config.file=/etc/prometheus/prometheus.yml
    - --storage.tsdb.path=/prometheus
    - --storage.tsdb.retention.time=30d

alertmanager:
  image: prom/alertmanager:latest
  container_name: fonto-alertmanager
  restart: unless-stopped
  networks: [fonto]
  volumes:
    - <repo-path>/ops/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    - <host-path>/secrets/alertmanager:/etc/alertmanager/secrets:ro
  command:
    - --config.file=/etc/alertmanager/alertmanager.yml

grafana:
  image: grafana/grafana:latest
  container_name: fonto-grafana
  restart: unless-stopped
  networks: [fonto]
  volumes:
    - <repo-path>/ops/grafana/provisioning:/etc/grafana/provisioning:ro
    - <repo-path>/ops/grafana/dashboards:/etc/grafana/dashboards:ro
    - grafana-data:/var/lib/grafana
  environment:
    GF_AUTH_ANONYMOUS_ENABLED: "false"
    GF_SECURITY_ADMIN_USER: admin
    # GF_SECURITY_ADMIN_PASSWORD set from .env

volumes:
  prometheus-data:
  grafana-data:
```

Secrets (Discord webhook URL, SMTP creds) go in your own
`<host-path>/secrets/alertmanager/` — `chmod 600`,
file-per-key (not env vars b/c alertmanager wants `_file` indirection).

## Verifying alerts

Pull-power test (verifies the rule + routing both work):

```bash
# Force a 5xx by hitting a known-broken route on YOUR instance, ~10 times in 30s
ssh <server> 'for i in {1..10}; do curl -sS https://<YOUR_APP_ORIGIN>/api/v1/no-such-route; done'

# Watch the alert fire (typically within 60s of `for: 5m` expiring)
ssh <server> 'docker logs fonto-alertmanager 2>&1 | tail -20'
```

## Worker prom listener

The worker container exposes its Prometheus metrics on `WORKER_METRICS_PORT`,
which defaults to **9464** (the OTel community default for Prom HTTP exposers) —
see `worker/index.ts`. `ops/prometheus.yml` scrapes `fonto-worker:9464` to match.
If you override `WORKER_METRICS_PORT`, update the scrape target in lockstep or
the worker job silently scrapes nothing (Prometheus reports it as `down`, not as
an error).
