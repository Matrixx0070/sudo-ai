# SUDO-AI v5 Telemetry Ops Guide

Wave 7F — OTEL-style telemetry export.

## Endpoints

### Prometheus metrics scrape

```
GET /v1/admin/metrics
Authorization: Bearer <GATEWAY_TOKEN>
```

Returns Prometheus text exposition format (text/plain; version=0.0.4).

Quick check:

```sh
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" http://localhost:18900/v1/admin/metrics | head -30
```

### OTLP JSON polling

```
GET /v1/admin/metrics/otlp
Authorization: Bearer <GATEWAY_TOKEN>
```

Returns an OTLP/HTTP JSON payload (application/json) suitable for OTEL collectors
configured with HTTP polling mode. The payload follows the OTLP protobuf-JSON
mapping (resourceMetrics > scopeMetrics > metrics).

```sh
curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" http://localhost:18900/v1/admin/metrics/otlp | python3 -m json.tool | head -40
```

Both endpoints accept an optional `?window=N` query param (1-90 days, default 7)
that controls the aggregation window for subsystems that support windowing.

---

## Prometheus scrape_config

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: sudo-ai-alignment
    scrape_interval: 30s
    scheme: http
    authorization:
      type: Bearer
      credentials: <GATEWAY_TOKEN>
    static_configs:
      - targets:
          - host:18900
    metrics_path: /v1/admin/metrics
```

Replace `host` with the VPS hostname or IP. If TLS is terminated upstream, change
`scheme: https` and point to the proxy address.

---

## OTEL Collector config examples

### Option A: Prometheus receiver (scrape from /v1/admin/metrics)

```yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: sudo-ai-alignment
          scrape_interval: 30s
          authorization:
            type: Bearer
            credentials: <GATEWAY_TOKEN>
          static_configs:
            - targets:
                - host:18900
          metrics_path: /v1/admin/metrics

processors:
  batch:

exporters:
  otlphttp:
    endpoint: https://your-otel-backend/v1/metrics

service:
  pipelines:
    metrics:
      receivers: [prometheus]
      processors: [batch]
      exporters: [otlphttp]
```

### Option B: HTTP polling receiver (OTLP JSON from /v1/admin/metrics/otlp)

The `/v1/admin/metrics/otlp` endpoint returns OTLP JSON that can be consumed
directly by any backend that accepts `otlp/http` format. Use a script or cron
job to poll and POST to your OTEL backend:

```sh
#!/bin/sh
PAYLOAD=$(curl -sf -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://localhost:18900/v1/admin/metrics/otlp)
curl -sf -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  https://your-otel-backend/v1/metrics
```

---

## Grafana dashboard import

1. Open Grafana -> Dashboards -> Import
2. Upload `ops/grafana/sudo-ai-alignment.json` or paste its contents
3. When prompted for the data source, select your Prometheus instance that scrapes
   `/v1/admin/metrics`
4. Click Import

The dashboard (uid: `sudo-ai-alignment`) includes:
- Alignment Score — time series (gauge, 0-1)
- Trust Tier — stat panel with PROBATION/LOW/MEDIUM/HIGH mapping
- Calibration (Brier Score) — gauge (lower is better)
- Re-anchor Triggers — pie chart by trigger label
- Commitments Expiring + Expired — stat panels
- Injection Detections — time series (5m rate)
- Recurring Mistake Patterns — gauge panel

**Sandbox Seal (Wave 2.2h)** row (y=20, panels 9-12):
- Seal Install Rate (/5m) — timeseries, `rate(sudo_synth_seal_install_total[5m])`, installs/sec
- Seal Missing .so (CRITICAL) — stat, `sudo_synth_seal_missing_so_total`, GREEN=0 / RED>=1
- SIGSYS Fires (Exec-Deny) — stat+sparkline, `rate(sudo_synth_seal_sigsys_total[5m])`, GREEN=0 / YELLOW=>0.001/s / RED>=0.083/s (~5/min)
- Seal Health Gauge — stat, `sudo_synth_seal_up`, GREEN=UP (1) / RED=DOWN (0)

Refresh interval is 30s by default. Adjust via Grafana dashboard settings.

---

## Missing subsystem behavior

If a subsystem dep is not wired at boot (e.g. `alignmentAggregator` is absent),
the metrics endpoint emits `sudo_alignment_up 0` instead of failing the scrape.
This ensures Prometheus always gets a valid 200 response and can alert on
`sudo_<name>_up == 0` conditions.

---

## Wave 2.2h — LD_PRELOAD Execve Seal Soak (48h staging window)

Three scripts automate the Wave 2.2h 48h staging soak and the subsequent prod
verification gate.  Soak window: 2026-04-19 ~14:00 UTC to 2026-04-21 ~14:00 UTC.

### Soak criteria (from wave2.2h-closed.md)

| # | Criterion | How checked |
|---|-----------|-------------|
| 1 | Zero SECCOMP_VIOLATION in staging error log | grep staging err log |
| 2 | Zero `synth-seccomp-seal.so not found` warnings | grep staging err log |
| 3 | Zero fd write errors | grep staging err log |
| 4 | p99 latency within 10% of Wave 2.2g baseline | manual |
| 5 | >=10 successful benign synth calls logged | `sudo_synth_seal_install_total` counter |
| 6 | 5 pre-existing flakes at same CI rate | manual (run `pnpm vitest`) |

### scripts/seal-soak-loadgen.sh

Fires one benign `tool.synthesize` call against staging `:18901` per invocation.
Designed to be called hourly by Kairos or cron during the soak window so that
criterion #5 accumulates.

**Pre-flight:** checks `sudo_synth_seal_install_total` exists in
`/v1/admin/metrics` before firing; aborts if obs not live.

**Token:** resolves from `$SUDO_API_TOKEN` > `$SUDO_AI_DASHBOARD_TOKEN` > `/root/.sudo-ai/token`.

**Logs to:** `/var/log/seal-soak/loadgen-YYYYMMDD.log` (fallback: `data/logs/seal-soak/`).

**Exit codes:** 0 = HTTP 2xx received; 1 = obs check failed or HTTP error.

```sh
SUDO_API_TOKEN=<tok> bash scripts/seal-soak-loadgen.sh
```

### scripts/seal-soak-report.sh

Queries staging metrics + greps the staging error log to emit a structured
PASS/FAIL/SKIP verdict for all 6 soak criteria.

**`--since` argument:** ISO8601 (`2026-04-19T14:00:00Z`) or relative (`48h`, `1h`, `30m`).
Default: 48h ago.

**Telegram notification:** if `$TELEGRAM_BOT_TOKEN` and `$TELEGRAM_CHAT_ID` are set,
fires a fire-and-forget POST with the verdict summary.

**Logs to:** `/var/log/seal-soak/report-YYYYMMDD-HHMM.log`.

**Exit codes:** 0 = GREEN; 1 = RED; 2 = YELLOW.

```sh
# Smoke test (now; ~1h window)
SUDO_API_TOKEN=<tok> bash scripts/seal-soak-report.sh --since 1h

# Final T+48h report
SUDO_API_TOKEN=<tok> bash scripts/seal-soak-report.sh --since 2026-04-19T14:00:00Z
```

### scripts/prod-seal-flip.sh

Verification + reload tool for confirming the seal code path is live on prod
before the second 48h prod soak.

> **This script does NOT enable `SUDO_TOOL_SYNTHESIZE_ENABLED` on prod.**
> Synthesize remains OFF. The "flip" confirms: `.so` present + sha256 verified,
> `SUDO_EXEC_GATE_DISABLE` unset, soak report GREEN, then runs
> `pm2 reload sudo-ai-v5 --update-env`.

**Pre-flight checks (all must pass before `--yes` triggers reload):**

1. `SUDO_TOOL_SYNTHESIZE_ENABLED` unset or 0 on prod
2. Prod health `:18900` returns 200
3. `.so` sha256 matches `f4fe8b99535def86788be03a26fb666383e90e63f924cc7bd3bb1b2defeb3af9`
4. `SUDO_EXEC_GATE_DISABLE` NOT set on prod
5. GREEN soak report exists from last 1h

**Backup:** snapshots current pm2 env to `/root/.sudo-ai/backups/prod-env-pre-seal-flip-<ts>.env`.

**Post-reload verification:** health 200 + 4 seal Prom metrics present.

**Logs to:** `/var/log/seal-soak/prod-flip-<ts>.log`.

```sh
# Pre-flight only (no reload):
bash scripts/prod-seal-flip.sh

# Full verification + reload (requires explicit --yes):
bash scripts/prod-seal-flip.sh --yes
```

### Kairos schedule entries (/root/.claude/scheduled_tasks.json)

Two entries added for the soak window:

| ID | Command | Schedule |
|----|---------|----------|
| `seal-soak-loadgen` | `bash .../seal-soak-loadgen.sh` | Every 3600s from 2026-04-19T15:00Z to 2026-04-21T14:00Z |
| `seal-soak-report-48h` | `bash .../seal-soak-report.sh --since 2026-04-19T14:00:00Z` | Once at 2026-04-21T14:00Z |

GREEN verdict from `seal-soak-report-48h` gates the prod seal flip.
