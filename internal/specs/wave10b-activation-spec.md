# Wave 10B-Activation Spec
**Date**: 2026-04-19
**Architect**: Sonnet 4.6
**Status**: READY FOR BUILDER REVIEW

---

## 1. Scope Summary

Pure wiring wave. Three built modules (SkillDiscovery, AgentConfigEvolver, trace-meta)
accumulate zero live data because their feed points in loop.ts are dead. This wave
connects the three feed points in exactly two files (loop.ts and registry.ts) plus
minimal cli.ts DI lines and one new integration test.

No new SQLite schema. No internal changes to SkillDiscovery or AgentConfigEvolver.
No Phase 10E (taint/signing). Existing 3472 tests must continue to pass.

---

## 2. Architecture Decisions

### D1: Tool-to-Skill Reverse Lookup

**Decision**: `ToolRegistry.skillIdForTool(name: string): string | null` — returns null
always this wave.

**Rationale**: SKILL.md files carry `allowed-tools` in frontmatter (e.g.
`allowed-tools: [comms.gmail-send, comms.gmail-read]`). There is no canonical `id:`
field in SKILL.md frontmatter and no reverse index in ToolRegistry today. Building a
runtime reverse index (scan skill files at registry init, map each tool name to skill
name) is a meaningful new feature, not wiring. The `trace-meta` event defines
`skillId?` as optional — emitting it as undefined is correct and spec-compliant when no
mapping exists. Builder A uses optional chaining so absence of the method at test time
does not break anything.

**Consequence**: trace-meta events will carry `skillId: undefined` this wave. The field
stays in the event shape, ready for a future wave to populate it once a skill-id
standard lands. This is not a regression.

**Non-goal**: Do NOT add `id:` to SKILL.md frontmatter, do NOT scan skill files in
ToolRegistry constructor, do NOT add `skillId` to `ToolDefinition`. Those are Wave 10C+.

### D2: DI Pattern — Setters, Not Constructor Args

**Decision**: `AgentLoop` gets two new setter methods, matching the Wave 6L/6O pattern.
`AgentConfig` in `types.ts` is NOT extended.

**Rationale**: Constructor already has 9 positional args. `wave13AgentConfigEvolver` is
constructed at cli.ts:1845, after `finalAgentLoop` at cli.ts:905 — constructor injection
requires reordering ~940 lines of bootstrap. Setter pattern
(`setConfidenceCalibrationTracker` at loop.ts:362, `setInjectionDetector` at loop.ts:384)
is the established convention. No new type exports needed.

New methods on `AgentLoop`:
```ts
setSkillDiscovery(sd: { recordToolCall(sessionId: string, toolName: string, success: boolean): void }): void
setAgentConfigEvolver(ace: { recordTrace(trace: TraceInput): void }): void
```

Both duck-typed. Both fail-open (warn and return if duck-type mismatch).

### D3: Session Quality Calculation

**Decision**: `quality = successCount / totalToolCallCount` within one `run()` call.
If `totalToolCallCount === 0`, skip `recordTrace` entirely (no signal worth recording).

**Rationale**: Simpler, no coupling to veto/alignment/trust signals. The evolver already
gates on `MIN_QUALITY_THRESHOLD = 0.7` internally. Tool-call success rate is the direct
signal SkillDiscovery cares about.

### D4: When to Flush recordTrace

**Decision**: Flush one `TraceInput` per `run()` call, at the `session:end` hook site
(loop.ts:726), immediately after `hooks.emit('session:end')`.

**Rationale**: The evolver already listens for `sleep-cycle-complete` from the
consolidator (consolidator.ts:667) to trigger `propose()`. Flushing per-run means traces
accumulate in `this.traces[]` across runs, and the evolver's existing MIN_TRACE_COUNT
gate (10 traces) functions correctly.

### D5: trace-meta skillId Source

**Decision**: Populate `skillId` from the last active tool call's name, looked up via
`this.toolRegistry.skillIdForTool?.(lastToolName)`. Since D1 establishes this returns
null always this wave, the field is emitted as `undefined` (omitted from the event
object). The single trace-meta emit at loop.ts:1257 is unchanged in position — only
augmented.

---

## 3. File Boundaries — Strict, Zero Overlap

### Builder A owns exclusively:
- `/root/sudo-ai-v4/src/core/agent/loop.ts` — add two private fields, two setters,
  three call sites (recordToolCall, recordTrace, trace-meta augment)
- `/root/sudo-ai-v4/src/cli.ts` — DI lines only (two setter calls, placed correctly)

### Builder B owns exclusively:
- `/root/sudo-ai-v4/src/core/tools/registry.ts` — add `skillIdForTool()` method
- `/root/sudo-ai-v4/tests/learning/wave10b-activation.test.ts` — new integration test

### No other files are touched.

Specifically excluded from both builders:
- `src/core/agent/types.ts` — AgentConfig NOT extended (D2)
- `src/core/learning/skill-discovery.ts` — internal unchanged
- `src/core/learning/agent-config-evolver.ts` — internal unchanged
- `src/core/gateway/learning-routes.ts` — unchanged
- `src/core/consciousness/sleep-cycle/consolidator.ts` — unchanged
- Any Grafana/ops files
- Any SKILL.md files

---

## 4. Exact Interfaces

### 4.1 New private fields on AgentLoop (loop.ts)

Add alongside `_confidenceCalibrationTracker` (~line 191):

```ts
private _skillDiscovery?: {
  recordToolCall(sessionId: string, toolName: string, success: boolean): void;
};
private _agentConfigEvolver?: {
  recordTrace(trace: {
    sessionId: string;
    agentId: string;
    toolSequence: string[];
    quality: number;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }): void;
};
```

### 4.2 New setter methods on AgentLoop (loop.ts)

Add after `getInjectionDetector()` at ~line 396:

```ts
/** Wire SkillDiscovery after construction (Wave 10B). Fail-open if duck-type mismatch. */
setSkillDiscovery(sd: { recordToolCall(sessionId: string, toolName: string, success: boolean): void }): void {
  if (sd && typeof sd.recordToolCall === 'function') {
    this._skillDiscovery = sd;
    log.info('AgentLoop: SkillDiscovery attached');
  } else {
    log.warn('AgentLoop: setSkillDiscovery: invalid duck-type — ignoring');
  }
}

/** Wire AgentConfigEvolver after construction (Wave 10B). Fail-open if duck-type mismatch. */
setAgentConfigEvolver(ace: {
  recordTrace(trace: {
    sessionId: string; agentId: string; toolSequence: string[];
    quality: number; timestamp: string; metadata?: Record<string, unknown>;
  }): void;
}): void {
  if (ace && typeof ace.recordTrace === 'function') {
    this._agentConfigEvolver = ace;
    log.info('AgentLoop: AgentConfigEvolver attached');
  } else {
    log.warn('AgentLoop: setAgentConfigEvolver: invalid duck-type — ignoring');
  }
}
```

### 4.3 ToolRegistry.skillIdForTool (registry.ts)

Add in the Lookups section (~line 177), after `getByCategory()`:

```ts
/**
 * Return the skill ID that claims this tool via its allowed-tools frontmatter list.
 * Returns null when no skill-to-tool mapping is loaded.
 * Reserved for future reverse-index population (Wave 10C+).
 *
 * @param name - Tool name (e.g. "comms.gmail-send")
 * @returns null always in Wave 10B
 */
skillIdForTool(name: string): string | null {
  void name; // parameter reserved for future use
  return null;
}
```

### 4.4 Per-run accumulators in run() (loop.ts)

Add after `attachments` array declaration (~line 443):

```ts
// Wave 10B: per-run accumulators for SkillDiscovery and AgentConfigEvolver feeds
let _w10bToolCallCount = 0;
let _w10bToolSuccessCount = 0;
const _w10bToolSequence: string[] = [];
```

### 4.5 recordToolCall feed in emit closure (loop.ts)

Location: inside the `emit` closure, AFTER the `after:tool-call` hook at line 498,
BEFORE the `try { onEvent?.(event) }` at line 500.

```ts
// Wave 10B: feed SkillDiscovery (fail-open)
try {
  if (this._skillDiscovery && event.type === 'tool-result') {
    const _tr = event as { type: string; name: string; result: unknown };
    const _isSuccess = \!(typeof _tr.result === 'string' && _tr.result.startsWith('Error'));
    this._skillDiscovery.recordToolCall(sessionId, _tr.name, _isSuccess);
    _w10bToolCallCount++;
    if (_isSuccess) _w10bToolSuccessCount++;
    _w10bToolSequence.push(_tr.name);
  }
} catch { /* fail-open */ }
```

NOTE: The `emit` closure is defined inside `run()` and closes over `sessionId` and the
`let` accumulators. Updates inside the closure are visible in `run()` because `let` vars
are captured by reference.

### 4.6 trace-meta augment (loop.ts:1257)

Inside the `try` block at loop.ts:1245, replace:
```ts
emit({ type: 'trace-meta', complexity });
```
with:
```ts
const _traceMeta: import('./types.js').AgentEvent & { type: 'trace-meta' } = { type: 'trace-meta', complexity };
if (_w10bToolSequence.length > 0) {
  const _lastTool = _w10bToolSequence.at(-1);
  if (_lastTool) {
    const _sid = (this.toolRegistry as { skillIdForTool?: (n: string) => string | null })
      .skillIdForTool?.(_lastTool) ?? undefined;
    if (_sid \!== undefined) _traceMeta.skillId = _sid;
  }
}
emit(_traceMeta);
```

This avoids introducing `activeToolCalls` scope dependency. Uses the same `_w10bToolSequence`
accumulator already populated in 4.5.

### 4.7 recordTrace flush at session:end (loop.ts:726)

After `void this.hooks?.emit('session:end', ...)` at line 726:

```ts
// Wave 10B: flush one trace per session to AgentConfigEvolver (fail-open)
try {
  if (this._agentConfigEvolver && _w10bToolCallCount > 0) {
    const _quality = _w10bToolSuccessCount / _w10bToolCallCount;
    this._agentConfigEvolver.recordTrace({
      sessionId,
      agentId: sessionId, // proxy — loop has no separate agentId concept
      toolSequence: [..._w10bToolSequence],
      quality: _quality,
      timestamp: new Date().toISOString(),
    });
  }
} catch { /* fail-open */ }
```

### 4.8 DI wiring in cli.ts

**SkillDiscovery setter** — insert after the `setInjectionDetector` block at line 924:

```ts
// Wave 10B: wire SkillDiscovery into agent loop (fail-open)
if (wave13SkillDiscovery) {
  try {
    finalAgentLoop.setSkillDiscovery(wave13SkillDiscovery);
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'Wave 10B: SkillDiscovery wiring failed — learning feed disabled');
  }
}
```

**AgentConfigEvolver setter** — insert AFTER line 1864 (end of Wave 13 init block),
specifically after:
```ts
log.info('Wave 13: AgentConfigEvolver + SkillOptimizer initialised and wired into SleepCycle');
```

```ts
// Wave 10B: wire AgentConfigEvolver into agent loop (fail-open)
if (wave13AgentConfigEvolver) {
  try {
    finalAgentLoop.setAgentConfigEvolver(wave13AgentConfigEvolver);
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'Wave 10B: AgentConfigEvolver wiring failed — trace feed disabled');
  }
}
```

`wave13AgentConfigEvolver` is declared at line 1840 inside a try block. The insertion
point at line 1865 is inside the same try block scope. Builder A must verify the scope
is accessible there and not inside a nested block that makes the variable inaccessible.
If it is, move both lines immediately after the `wave13AgentConfigEvolver = new AgentConfigEvolver(...)` assignment at line 1845.

---

## 5. Pipeline Sequencing

### Builders A and B run in parallel — no blocking dependency.

Builder A uses optional chaining on `skillIdForTool`:
```ts
(this.toolRegistry as { skillIdForTool?: (n: string) => string | null }).skillIdForTool?.(_lastTool)
```
If ToolRegistry does not yet have the method (Builder B not done), the chain
short-circuits to `undefined`. No compilation error. This pattern already exists at
loop.ts:1249-1250 for `getSchemaForLLM`.

Builder B's test file references no loop.ts code directly — it tests SkillDiscovery
and ToolRegistry in isolation. No coupling.

---

## 6. Kill-Switch

No new kill-switch required. All three new call sites are wrapped in
`try { ... } catch { /* fail-open */ }` matching the pattern at loop.ts:1184.
Optional chaining on the setter-injected instances means no data path changes if
instances are not wired. Architecturally equivalent to a kill-switch defaulting OFF —
simply omit the setter calls in cli.ts to disable.

There is no `SUDO_LEARNING_ENABLED` env var in the codebase. Do not add one.

---

## 7. Acceptance Criteria

**AC1** — SkillDiscovery buffer fills during a real session: after 10+ tool-result
events across 2+ sessions, `skillDiscovery.mine()` returns at least one `TracePattern`
with `occurrences >= 2`.

**AC2** — AgentConfigEvolver accumulates traces: after 10+ `recordTrace` calls with
`quality >= 0.7`, and after `sleep-cycle-complete` fires, `proposalStore.list()` returns
at least one proposal.

**AC3** — trace-meta skillId field: the trace-meta event emitted at `finishReason=stop`
must include `skillId` key only when `skillIdForTool()` returns non-null. Currently
always omitted. Field must be wired so a future implementation populates it without
further changes to loop.ts.

**AC4** — Zero regressions: `pnpm test` passes all 3472 existing tests.

**AC5** — Manual post-deploy: `GET /v1/admin/learning/proposals` returns HTTP 200.
After 10+ sessions with 10+ tool calls each, response body `proposals` array is
non-empty.

---

## 8. Integration Test Specification

**File**: `/root/sudo-ai-v4/tests/learning/wave10b-activation.test.ts`
**Owner**: Builder B
**Minimum**: 7 tests

```
Test 1: 'recordToolCall is called for each tool-result in a run'
  Assert mockSkillDiscovery.recordToolCall called N times for N tool-result events
  Assert each call carries correct sessionId and toolName

Test 2: 'mine() returns patterns after sufficient tool calls across sessions'
  Use real SkillDiscovery instance
  Call recordToolCall 5x for sessionA (same sequence) + 5x for sessionB (same sequence)
  Assert mine() returns TracePattern[] with length >= 1
  Assert returned pattern has occurrences >= 2

Test 3: 'recordTrace called once per run with correct quality'
  Mock AgentConfigEvolver.recordTrace
  Simulate run with 4 tool calls (3 success, 1 failure)
  Assert recordTrace called exactly once
  Assert trace.quality === 0.75 (±0.01 tolerance)
  Assert trace.toolSequence.length === 4
  Assert trace.timestamp matches ISO-8601 format

Test 4: 'recordTrace skipped when zero tool calls in run'
  Mock AgentConfigEvolver.recordTrace
  Simulate run with 0 tool calls (pure text response turn)
  Assert recordTrace never called

Test 5: 'trace-meta event skillId absent when no skill mapping'
  Simulate run with finishReason=stop
  Collect emitted events, find trace-meta
  Assert event.type === 'trace-meta'
  Assert \!('skillId' in event) — key must be absent, not present as undefined

Test 6: 'ToolRegistry.skillIdForTool returns null for any input'
  Instantiate real ToolRegistry
  Register one dummy tool definition
  Assert skillIdForTool('dummy.tool') === null
  Assert skillIdForTool('') === null
  Assert skillIdForTool('nonexistent') === null

Test 7: 'setSkillDiscovery and setAgentConfigEvolver duck-type validation'
  Instantiate minimal AgentLoop mock
  setSkillDiscovery with valid duck-typed object → succeeds silently
  setAgentConfigEvolver with valid duck-typed object → succeeds silently
  setSkillDiscovery with null → does not throw, logs warn
  setAgentConfigEvolver with {} (missing recordTrace) → does not throw, logs warn
```

---

## 9. Explicit Non-Goals

This wave does NOT:
- Modify `SkillDiscovery` or `AgentConfigEvolver` internals
- Build a reverse index mapping tool names to skill IDs (Wave 10C+)
- Add `id:` field to SKILL.md frontmatter
- Add `skillId` field to `ToolDefinition`
- Modify `src/core/agent/types.ts`
- Modify `learning-routes.ts`
- Modify `consolidator.ts`
- Add any Grafana panels or ops metrics
- Change Phase 10E (TaintTracker / ArtifactSigner)
- Add a new SQLite table or migration
- Add `SUDO_LEARNING_ENABLED` env var

---

## 10. Risk Register

| Risk | Mitigation |
|------|-----------|
| `activeToolCalls` not in scope at trace-meta emit site (loop.ts:1257) | Use `_w10bToolSequence` accumulator instead — populated in emit closure, available throughout run() |
| `wave13AgentConfigEvolver` declared after naïve setter insertion at line 924 | Move AgentConfigEvolver setter to after line 1864; SkillDiscovery setter stays at line 924 |
| `emit` closure sees stale accumulator values | Accumulators are `let` vars in `run()` scope — closure captures by reference, mutations visible |
| SkillDiscovery.mine() returns empty in test | DEFAULT_MIN_SUPPORT=2 requires same N-gram in ≥2 sessions; test uses 2 sessions |
| TypeScript error on toolRegistry cast | Use `as { skillIdForTool?: (n: string) => string \| null }` — identical pattern to loop.ts:1249 |
| AgentConfigEvolver setter out of scope inside try block | If needed, move to immediately after `wave13AgentConfigEvolver = new AgentConfigEvolver(...)` at line 1845 |
