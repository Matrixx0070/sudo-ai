# Wave 14 P0 — Tool Name Sanitization Spec

**Status:** ARCHITECT APPROVED  
**Date:** 2026-04-21  
**Priority:** P0 — Production outage (all tool calls return 502 since ~04:36 UTC)  
**Estimated LOC change:** ≤50  

---

## D1 — Scope

Single file: `/root/sudo-ai-v4/src/core/brain/brain.ts`  
New helper file: `/root/sudo-ai-v4/src/core/brain/tool-name-sanitize.ts`  
New test file: `/root/sudo-ai-v4/tests/brain/tool-name-sanitize.test.ts`  

**Root cause:** Anthropic API enforces `^[a-zA-Z0-9_-]{1,128}$` on tool names. All 230+ SUDO-AI tools use dotted names (e.g. `browser.search`). Dots are rejected, causing HTTP 502 from the local gateway on every tool-bearing LLM call.

**Kill-switch:** `SUDO_TOOL_NAME_SANITIZE_DISABLE=1` (exact `=== '1'`) reverts outbound names to raw dotted form and bypasses reverse-lookup. Default: sanitization ON.

---

## D2 — Sanitization Function

**File:** `/root/sudo-ai-v4/src/core/brain/tool-name-sanitize.ts`

```
export function sanitizeToolName(name: string): string {
  if (process.env['SUDO_TOOL_NAME_SANITIZE_DISABLE'] === '1') return name;
  return name.replace(/\./g, '_');
}
```

**Rule:** Replace dot (`.`) with underscore (`_`). No broader substitution.  
**Rationale:** Anthropic regex allows `_` and `-`. Dots are the only disallowed character present in SUDO-AI names. Broadening to strip all non-conforming characters risks mangling hyphens (`coder.apply-patch` must become `coder_apply-patch`, NOT `coderapply-patch`).

**Behavior for the mixed case:** `browser.file_upload` → `browser_file_upload` (existing underscore preserved; only the dot is replaced).

---

## D3 — Reverse Map

**Location:** Local `Map<string, string>` (apiName → originalName) allocated per-call, inside both `call()` and `stream()` method bodies.

**Never on the class instance.** Brain is a singleton handling concurrent sessions. A shared instance-level map would introduce a write-read race across concurrent calls. Allocate fresh per invocation.

**Population:** Built at the same `Object.fromEntries(...)` loop that builds `callParams.tools`, before the LLM call is made:

```
const reverseMap = new Map<string, string>();
callParams.tools = Object.fromEntries(
  request.tools.map((t: any) => {
    const origName = t.function?.name ?? t.name;
    const apiName  = sanitizeToolName(origName);
    reverseMap.set(apiName, origName);
    return [apiName, aiTool({ description: ..., inputSchema: ... })];
  })
);
```

The `reverseMap` is then passed to `extractToolCalls(result.toolCalls, reverseMap)`.

---

## D4 — Lookup Point

**Site 1 (outbound, generateText path):** `brain.ts` lines 668–678.  
Build `reverseMap` at `callParams.tools` construction. Pass it to `extractToolCalls`.

**Site 2 (outbound, streamText path):** `brain.ts` lines 784–797.  
Same pattern: build local `reverseMap`, apply `sanitizeToolName` to the key in `Object.fromEntries`. Note: `stream()` does not call `extractToolCalls`; it yields raw text chunks. If streaming ever returns tool calls (Vercel AI SDK `streamText` with `onToolCall`), the reverse-map must be consulted there. For now, wire the sanitization for outbound names only on this path (no reverse needed unless `onToolCall` is added).

**Site 3 (inbound, extractToolCalls):** `brain.ts` line 283.  
Change signature to:  
`private extractToolCalls(rawCalls: unknown[], reverseMap?: Map<string, string>): ToolCallFromLLM[]`  
At line 283, after extracting `name`:  
```
const name = reverseMap?.get(rawName) ?? rawName;
```
This restores `browser_search` → `browser.search` before the name is returned to `loop.ts` and onward to `toolRegistry.execute(tc.name, ...)`.

**No changes in loop.ts or loop-helpers.ts.** The registry lookup in `loop-helpers.ts:411` (`toolRegistry.execute(tc.name, ...)`) receives the already-restored dotted name and requires no modification.

---

## D5 — Tests

File: `/root/sudo-ai-v4/tests/brain/tool-name-sanitize.test.ts`

| ID | Description | Pass condition |
|----|-------------|----------------|
| SAN-1 | `sanitizeToolName('browser.search')` | Returns `'browser_search'` |
| SAN-2 | `sanitizeToolName('browser.file_upload')` | Returns `'browser_file_upload'` (preserves existing underscore; only dot replaced) |
| SAN-3 | `sanitizeToolName('coder.apply-patch')` | Returns `'coder_apply-patch'` (hyphen unchanged) |
| SAN-4 | Reverse-lookup round-trip: given `reverseMap` with `browser_search → browser.search`, `extractToolCalls` returns `tc.name === 'browser.search'` | Dotted name restored |
| SAN-5 | With `SUDO_TOOL_NAME_SANITIZE_DISABLE=1`, `sanitizeToolName('browser.search')` returns `'browser.search'` unchanged; `reverseMap` is built but all keys equal their values (no-op) | Raw dotted name passes through |
| SAN-6 | Stream path: `streamParams.tools` keys are sanitized (apiName has no dots) | `Object.keys(streamParams.tools)` contains no `.` characters |

Tests follow the mock pattern in `tests/brain/concatenated-tool-args.test.ts` (vi.mock for `ai`, `@ai-sdk/*`).

---

## D6 — Backward Compatibility and Collision Analysis

**Empirical check performed:** All dotted tool names extracted from `/root/sudo-ai-v4/src/core/` (230+ names). After applying `.replace(/\./g, '_')`, zero duplicate API names result.

**One notable case:** `browser.file_upload` already contains an underscore. Its sanitized form `browser_file_upload` is unique and does not collide with any other tool.

**Pre-existing underscore-only tools:** None found. All 230+ SUDO-AI tool names use exactly one dot as the category separator. No tool is registered with a flat underscore-only name.

**Future-collision guard:** The builder must add a one-time startup assertion in `brain.ts` (or wherever tools are first attached) that walks `request.tools`, builds the sanitized keys, and throws/logs-error if two original names produce the same API name:

```
const seen = new Map<string, string>();
for (const apiName of sanitizedKeys) {
  if (seen.has(apiName)) {
    log.error({ collision: apiName }, 'Tool name collision after sanitization — fix tool registration');
  }
  seen.set(apiName, origName);
}
```

This is a debug-level safety net; it must be fail-open (log only, do not throw) so a future naming mistake does not crash production.

---

## D7 — File Boundaries (Single Builder)

One builder owns all three files exclusively:

| File | Action |
|------|--------|
| `/root/sudo-ai-v4/src/core/brain/brain.ts` | Edit: 3 sites (D3 Site 1, D3 Site 2, D4 Site 3) |
| `/root/sudo-ai-v4/src/core/brain/tool-name-sanitize.ts` | Create: exports `sanitizeToolName()` |
| `/root/sudo-ai-v4/tests/brain/tool-name-sanitize.test.ts` | Create: SAN-1 through SAN-6 |

No other file is touched.

---

## D8 — Rollout Sequence

1. Builder implements changes (≤50 LOC total across 2 files + 1 new test file).
2. `tsc --noEmit` — must be clean (zero new errors).
3. `pnpm test tests/brain/tool-name-sanitize.test.ts` — 6/6 SAN tests pass.
4. `pnpm test` (full suite) — zero regressions from current baseline.
5. Security spot-check: confirm `sanitizeToolName` cannot be exploited to forge tool names (it is pure string transform; no dynamic eval; no registry side-effects).
6. `pm2 reload sudo-ai-v5` — rolling reload, no downtime.
7. Live verify: send `browser.fetch github.com` via `chat_sudo.py`; confirm HTTP 200 tool result returns (not 502).
8. Optionally verify kill-switch: set `SUDO_TOOL_NAME_SANITIZE_DISABLE=1` in pm2 env → reload → confirm 502 returns → unset → reload → confirm 200.

---

## Edit Sites Summary (Exact Line References)

| Site | File | Approx lines | Change |
|------|------|-------------|--------|
| Outbound generateText | brain.ts | 668–678 | Add `reverseMap` local, `sanitizeToolName(origName)` as key |
| Outbound streamText | brain.ts | 784–797 | `sanitizeToolName(name)` as key; no reverse needed |
| Inbound extractToolCalls | brain.ts | 278–291 | Signature gains `reverseMap?` param; line 283 applies reverse lookup |

