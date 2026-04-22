---
category: skill
version: 9C
wave: Wave 9C
status: stable
risk: LOW
---

# Skill Meta-Cognition Tools

These tools enable SUDO-AI to **reflect on its own tool use** — examining performance, proposing improvements, composing chains, and sharing refinements across instances.

## Overview

| Tool | Purpose | Risk |
|------|---------|------|
| `skill.usage-stats` | Aggregate call/success/failure stats per tool | LOW (read-only) |
| `skill.refine` | Generate refinement proposals from mistake patterns | LOW (dry-run default) |
| `skill.federate` | Publish/fetch skill events via federation layer | LOW (fails open) |
| `skill.compose` | Propose a tool chain for a goal | LOW (read-only) |
| `skill.explain` | Emit markdown explanation for any tool | LOW (read-only) |

---

## skill.usage-stats

**Description:** Reads audit.db and calibration.db to aggregate per-tool call statistics within a configurable time window.

**Parameters:**
- `toolName` (string, optional): Filter to a specific tool (substring match). Omit to get top-20 by call volume.
- `windowDays` (number, default: 7): Look-back window in days.

**Returns:**
```json
{
  "stats": [
    {
      "toolName": "browser.navigate",
      "totalCalls": 42,
      "successCount": 38,
      "failureCount": 4,
      "vetoCount": 0,
      "avgDurationMs": 1820,
      "successRate": 0.905,
      "brierForTool": 0.12,
      "topErrorKinds": ["timeout", "not_found"]
    }
  ],
  "windowDays": 7,
  "toolName": null
}
```

**Decision table:**
- No DB file → returns empty stats (fail-open)
- No rows in window → returns empty array
- No calibration tag match → brierForTool: null

---

## skill.refine

**Description:** Scans the audit_log for mistake patterns mentioning the tool name or category. Emits a structured refinement proposal with issues, suggestions, and patch hints.

**Parameters:**
- `toolName` (string, required): Dot-namespaced tool to analyze.
- `dryRun` (boolean, default: true): When false, logs self-modify intent (no actual patching in Wave 9C).

**Returns:**
```json
{
  "proposal": {
    "toolName": "browser.navigate",
    "issues": [{"pattern": "...", "occurrences": 3, "suggestion": "..."}],
    "proposedPatchHints": ["..."],
    "sourceFileFound": true,
    "sourceFilePath": "src/core/tools/builtin/browser/navigate.ts",
    "dryRun": true,
    "generatedAt": "2026-04-13T..."
  }
}
```

**Decision table:**
- Audit DB missing → returns empty issues (fail-open)
- Source file not found → `sourceFileFound: false`, proposal still emitted
- `dryRun=false` → logs intent, does NOT patch in this wave

---

## skill.federate

**Description:** Publishes tool refinement events to the federation layer (AuditChainSync from Wave 7E) or fetches peer events. Fails open when federation is not configured.

**Parameters:**
- `action` (string, required): `"publish"` or `"fetch"`.
- `eventType` (string, default: `"skill.federate"`): Event type tag.
- `payload` (object): Data to publish (for action=publish).
- `peerName` (string): Peer filter (for action=fetch).

**Decision table:**
- `SUDO_FEDERATION_URL` env not set → `{ok: false, reason: 'federation not configured'}`
- AuditChainSync not in globalThis → same fail-open response
- `fetchPeerTail` unavailable → `{ok: false, reason: 'fetchPeerTail not available'}`

---

## skill.compose

**Description:** Proposes a tool chain to achieve a high-level goal using keyword matching against all registered tools. Does NOT execute the chain.

**Parameters:**
- `goal` (string, required): Natural language goal description.
- `maxChainLength` (number, default: 5, max: 10): Maximum chain length.

**Returns:**
```json
{
  "proposal": {
    "chain": ["browser.search", "content.write-script", "media.tts"],
    "rationale": "Proposed 3-step chain from 180 registered tools...",
    "estimatedDurationMs": 9500
  }
}
```

**Decision table:**
- Registry unavailable → falls back to static keyword catalog
- No tools match → returns empty chain with rationale
- Category deduplication: max 2 tools per category prefix

---

## skill.explain

**Description:** Emits a rich SKILL.md-style markdown block for any registered tool, combining schema metadata with live usage statistics.

**Parameters:**
- `toolName` (string, required): Tool to explain.
- `windowDays` (number, default: 7): Usage stats look-back window.

**Returns:** Markdown string in the format:
```markdown
## browser.navigate

**Description:** Navigate to a URL...

**Parameters:**
- `url` (string, required): The URL to navigate to.

**Usage (last 7d):** 42 calls, 90.5% success

**Common failures:**
- timeout
- not_found
```

**Decision table:**
- Tool not in registry → description shows "(Tool not found in active registry)"
- Usage stats DB missing → shows 0 calls, 0% success (fail-open)

---

## Architecture Notes

- All tools are **read-only** by default (risk: LOW).
- All external deps (DBs, federation, registry) are **duck-typed** — no hard coupling.
- `skill.compose` uses `ToolRegistry.getGlobal()` and falls back to a static catalog.
- `skill.explain` reuses the `getUsageStats()` function from `usage-stats.ts` directly (no registry round-trip).
- `skill.federate` checks `SUDO_FEDERATION_URL` env and `globalThis.__auditChainSync` — both must be present to activate.
