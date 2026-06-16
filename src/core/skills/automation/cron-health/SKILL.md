---
id: automation.cron-health
name: cron-health
display_name: "Cron Health"
version: 1.0.0
description: Check all registered cron jobs and report healthy vs failing/overdue status.
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: [fs.read, db.read]
tags: [automation, monitoring, local]
source: bundled:sudo-ai
isReadOnly: true
isConcurrencySafe: true
metadata:
  trust_tier: bundled
---

## Description

Checks all registered cron jobs from `data/cron/jobs.json` and `mind.db cron_runs` table,
reporting which jobs are healthy and which are failing or overdue.

A job is **healthy** if its last run status is `ok` and it is not past `3×` its scheduled
interval. A job is **failing** if its last run status is `failed` or it is overdue.

## Input Schema

```json
{
  "type": "object",
  "properties": {},
  "required": []
}
```

(No input parameters required.)

## Output Schema

```json
{
  "type": "object",
  "properties": {
    "healthy":  { "type": "array", "items": { "type": "string" }, "description": "Job names running without issues" },
    "failing":  { "type": "array", "items": { "type": "string" }, "description": "Job names that errored or are overdue" },
    "lastRun":  { "type": "string", "description": "ISO timestamp of the most recent cron run" },
    "details":  { "type": "array", "description": "Per-job detail objects with status, lastRan, lastError, overdue" }
  }
}
```

## Example

```ts
const result = await registry.execute('automation.cron-health', {});
// result.data.healthy  → ['system.heartbeat']
// result.data.failing  → ['daily.brief']
// result.data.lastRun  → '2026-03-29T22:37:54.777Z'
```

## Notes

- Reads `data/cron/jobs.json` for job definitions.
- Reads `mind.db` cron_runs table for execution history.
- No network calls — fully local.
- Overdue threshold: `3 × schedule.ms`.
