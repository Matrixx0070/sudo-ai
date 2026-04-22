---
id: system.self-diagnostic
name: self-diagnostic
display_name: "Self Diagnostic"
version: 1.0.0
description: Run comprehensive SUDO-AI platform health diagnostic across six local subsystems.
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: [fs.read, db.read]
tags: [system, health, local]
source: bundled:sudo-ai
metadata:
  trust_tier: bundled
---

## Description

Runs a comprehensive health diagnostic for the SUDO-AI platform. Checks six subsystems
locally without any external API calls:

| Check | Pass | Warn | Fail |
|-------|------|------|------|
| `mind.db` | Accessible, < 500MB | > 500MB | Missing or corrupted |
| `cron_runs` | Runs in last 24h, 0 failures | Some failures | No activity or >50% failures |
| `api_costs` | < 80% daily budget | 80–100% used | > 100% budget |
| `disk_usage` | data/ < 5GB | 5–10GB | > 10GB |
| `log_file` | < 500MB | > 500MB | N/A |
| `process_memory` | RSS < 2GB | RSS > 2GB | N/A |

Overall status: `healthy` (all pass) → `degraded` (any warn) → `critical` (any fail).

## Input Schema

```json
{ "type": "object", "properties": {}, "required": [] }
```

## Output Schema

```json
{
  "type": "object",
  "properties": {
    "status":    { "type": "string", "enum": ["healthy", "degraded", "critical"] },
    "checks":    { "type": "array", "description": "Per-subsystem check results" },
    "issues":    { "type": "array", "items": { "type": "string" }, "description": "Human-readable issue list" },
    "timestamp": { "type": "string", "description": "ISO timestamp of diagnostic run" }
  }
}
```

## Example

```ts
const result = await registry.execute('system.self-diagnostic', {});
// result.data.status → 'healthy' | 'degraded' | 'critical'
// result.data.issues → ['[WARN] cron_runs: 2 ok / 1 failed in 24h']
```

## Notes

- Runs entirely from local files and mind.db — no external calls.
- Daily API cost budget is hard-coded at $5.00 USD (matches `DAILY_BUDGET_USD` constant).
- Suitable to run on every heartbeat or on demand.
