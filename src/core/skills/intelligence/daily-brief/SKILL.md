---
id: intelligence.daily-brief
name: daily-brief
display_name: "Daily Brief"
version: 1.0.0
description: Generate structured daily briefing from Hacker News, GitHub Trending, and mind.db.
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: [net.fetch, db.read]
tags: [intelligence, briefing, daily]
source: bundled:sudo-ai
isReadOnly: true
isConcurrencySafe: true
metadata:
  trust_tier: bundled
---

## Description

Generates a structured daily intelligence briefing by aggregating four data sources:

| Source | What it provides |
|--------|-----------------|
| Hacker News (Algolia API) | Top 5 front-page stories today |
| GitHub Trending | Top 5 trending repositories |
| mind.db cron_runs | Cron failures in last 24h |
| mind.db content_ideas | Count of pending ideas from the owner's backlog |

The brief includes action items (things that need attention) and content opportunities
(trending topics suitable for the owner's YouTube channel).

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "focus": {
      "type": "string",
      "description": "Optional filter: 'tech' (HN+GitHub only), 'system' (health only), or omit for all sections"
    }
  },
  "required": []
}
```

## Output Schema

```json
{
  "type": "object",
  "properties": {
    "brief":        { "type": "string", "description": "Full Markdown briefing text" },
    "actionItems":  { "type": "array",  "items": { "type": "string" }, "description": "Items needing attention" },
    "opportunities": { "type": "array", "items": { "type": "string" }, "description": "Content opportunity signals" },
    "generatedAt":  { "type": "string", "description": "ISO timestamp" }
  }
}
```

## Example

```ts
const result = await registry.execute('intelligence.daily-brief', {});
// result.data.brief       → full markdown brief
// result.data.actionItems → ['Fix cron failure: system.heartbeat: connection timeout']
// result.data.opportunities → ['AI trending on HN — good for reaction content']
```

## Notes

- HN and GitHub fetches are parallel — total latency is max(HN, GH), not sum.
- Network failures for external sources are gracefully handled (fallback messages included).
- system health data comes from mind.db only — no external calls for that section.
- Suitable to run daily as a cron job or on demand at session start.
