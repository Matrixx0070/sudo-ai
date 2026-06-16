---
id: content.viral-hook
name: viral-hook
display_name: "Viral Hook"
version: 1.0.0
description: Generate viral YouTube Shorts hook lines in curiosity/shock/challenge styles.
author: sudo-ai
trust_tier: bundled
license: MIT
compatibility: [node-22]
caps: []
tags: [content, youtube, no-llm, no-network]
source: bundled:sudo-ai
isReadOnly: true
isConcurrencySafe: true
metadata:
  trust_tier: bundled
---

## Description

Generates viral hook lines for YouTube Shorts targeted at the owner's configured target audience.
Three hook styles are supported:

| Style | Psychology | Best for |
|-------|-----------|---------|
| `curiosity` | Creates information gap | Educational, tech topics |
| `shock` | Activates amygdala response | News, controversy, records |
| `challenge` | Triggers social comparison | Quizzes, challenges, polls |

Returns 10 hook variants plus a recommended pick (shortest, highest CTR potential).

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "The subject of the Short (e.g. 'ChatGPT', 'crypto crash')"
    },
    "style": {
      "type": "string",
      "enum": ["curiosity", "shock", "challenge"],
      "description": "Hook style"
    }
  },
  "required": ["topic", "style"]
}
```

## Output Schema

```json
{
  "type": "object",
  "properties": {
    "hooks":       { "type": "array", "items": { "type": "string" }, "description": "All generated hook lines" },
    "recommended": { "type": "string", "description": "Best hook to use" }
  }
}
```

## Example

```ts
const result = await registry.execute('content.viral-hook', {
  topic: 'AI taking jobs',
  style: 'shock',
});
// result.data.recommended → "BREAKING: AI taking jobs has been lying to you this whole time 🚨"
```

## Notes

- No LLM calls — deterministic, instant output.
- Includes localised variants with Hindi/Urdu slang for desi audience resonance.
- Agent can further refine hooks via `content.write-copy` for deeper personalization.
