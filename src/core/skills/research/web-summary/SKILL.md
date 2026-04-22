---
id: research.web-summary
name: web-summary
display_name: "Web Summary"
version: 1.0.0
description: Search the web via DuckDuckGo and return structured summary with key facts and source URLs.
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: [net.fetch]
tags: [research, web, no-llm]
source: bundled:sudo-ai
metadata:
  trust_tier: bundled
---

## Description

Searches the web for any topic using the DuckDuckGo Instant Answer API, fetches up to
`maxSources` related pages, and returns a structured summary with extracted key facts and
source URLs.

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "The topic or question to research"
    },
    "maxSources": {
      "type": "number",
      "description": "Maximum number of web sources to fetch (1–10, default 3)"
    }
  },
  "required": ["topic"]
}
```

## Output Schema

```json
{
  "type": "object",
  "properties": {
    "summary":   { "type": "string",  "description": "Paragraph summary of the topic" },
    "sources":   { "type": "array",   "items": { "type": "string" }, "description": "URLs consulted" },
    "keyFacts":  { "type": "array",   "items": { "type": "string" }, "description": "Up to 8 extracted facts" }
  }
}
```

## Example

```ts
const result = await registry.execute('research.web-summary', {
  topic: 'quantum computing breakthroughs 2025',
  maxSources: 5,
});
// result.data.summary   → paragraph text
// result.data.sources   → ['https://...', ...]
// result.data.keyFacts  → ['Fact 1.', 'Fact 2.', ...]
```

## Notes

- Uses DuckDuckGo Instant Answer (no API key required).
- Falls back gracefully if pages are unreachable.
- No LLM calls — pure web scraping and text extraction.
- Timeout: 60 seconds total.
