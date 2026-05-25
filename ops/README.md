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

## Compose wiring (NAS)

The Fonto compose file at `/data/appdata/appdata/docker-compose.yml` needs three services added (mount this `ops/` dir read-only into each):

```yaml
prometheus:
  image: prom/prometheus:latest
  container_name: service
  restart: unless-stopped
  networks: [service]
  volumes:
    - /path/to/repo/ops/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    - /path/to/repo/ops/alerts/rules.yml:/etc/prometheus/rules.yml:ro
    - prometheus-data:/prometheus
  command:
    - --config.file=/etc/prometheus/prometheus.yml
    - --storage.tsdb.path=/prometheus
    - --storage.tsdb.retention.time=30d

alertmanager:
  image: prom/alertmanager:latest
  container_name: alertmanager
  restart: unless-stopped
  networks: [service]
  volumes:
    - /path/to/repo/ops/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    - /data/appdata/appdata/secrets/alertmanager:/etc/alertmanager/secrets:ro
  command:
    - --config.file=/etc/alertmanager/alertmanager.yml

grafana:
  image: grafana/grafana:latest
  container_name: service
  restart: unless-stopped
  networks: [service]
  volumes:
    - /path/to/repo/ops/grafana/provisioning:/etc/grafana/provisioning:ro
    - /path/to/repo/ops/grafana/dashboards:/etc/grafana/dashboards:ro
    - grafana-data:/var/lib/grafana
  environment:
    GF_AUTH_ANONYMOUS_ENABLED: "false"
    GF_SECURITY_ADMIN_USER: admin
    # GF_SECURITY_ADMIN_PASSWORD set from .env

volumes:
  prometheus-data:
  grafana-data:
```

Secrets (Discord webhook URL, SMTP creds) go in
`/data/appdata/appdata/secrets/alertmanager/` — `chmod 600`,
file-per-key (not env vars b/c alertmanager wants `_file` indirection).

## Verifying alerts

Pull-power test (verifies the rule + routing both work):

```bash
# Force a 5xx by hitting a known-broken route, ~10 times in 30s
ssh <server> 'for i in {1..10}; do curl -sS https://myfonto.com/api/v1/no-such-route; done'

# Watch the alert fire (typically within 60s of `for: 5m` expiring)
ssh <server> 'docker logs alertmanager 2>&1 | tail -20'
```

## Worker prom listener

The worker container exposes `:9090/metrics` (see `worker/index.ts`).
Already wired into the scrape config above.
