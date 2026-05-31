# Wave 10C Spec

**Author:** Architect | **Date:** 2026-04-19 | **Status:** DRAFT — broadcast to all builders before work begins

---

## §1 Scope

Three items. All ship in one wave (Option A for Item 3 — no split).

### Item 1 — Array caps (MEDIUM security)

**Problem:** `SkillDiscovery.records[]` and `AgentConfigEvolver.traces[]` are unbounded in-memory arrays that grow for the lifetime of the process. A sufficiently active instance will exhaust heap.

**Decision:** Use the metrics batch-evict pattern (Pattern 2 from briefing). Both arrays are single flat arrays with no per-key bucketing, so the failure-learner splice pattern (per-key Map) does not fit. The kairos `slice-assign` pattern reassigns the array reference, which is incompatible with `readonly` array declarations. Metrics batch-evict does an in-place `splice(0, EVICT_COUNT)` on the array — compatible with `readonly` (readonly prevents reassignment; splice is mutation).

**Constants:**
- `SkillDiscovery.records`: `MAX_RECORDS = 10_000`, `RECORDS_EVICT_COUNT = 1_000`
- `AgentConfigEvolver.traces`: `MAX_TRACES = 5_000`, `TRACES_EVICT_COUNT = 500`

Rationale for different sizes: each `TraceInput` carries a `toolSequence: string[]` plus metadata, making it 3-5x heavier than a `ToolCallRecord`. `mine()` already applies a `windowMs` cutoff, so evicted entries would eventually be filtered out anyway.

**Eviction placement:**
- In `recordToolCall()` at line 74, after `this.records.push(...)`, check `if (this.records.length > MAX_RECORDS) this.records.splice(0, RECORDS_EVICT_COUNT)`.
- In `recordTrace()` at line 85, after `this.traces.push(...)`, check `if (this.traces.length > MAX_TRACES) this.traces.splice(0, TRACES_EVICT_COUNT)`.

Log a debug message on each eviction (matching the metrics.ts pattern: `log.debug({ evicted: N }, '...')`).

### Item 2 — `_isSuccess` misclassification (LOW data-integrity)

**Problem:** `loop.ts:548` predicate only checks string-shaped errors. Object-shaped results like `{error: "..."}` pass as `true`, corrupting the `quality` value fed to `AgentConfigEvolver`.

**Decision:** Extract to a named helper module for testability.

**New file:** `/root/sudo-ai-v4/src/core/agent/tool-result-classifier.ts`

**Exported function signature:**
```typescript
export function isToolResultSuccess(result: unknown): boolean
```

**Predicate rules (evaluated in order):**
1. `result === null || result === undefined` → `true` (no error returned = success)
2. `typeof result === 'boolean'` → `result` (boolean false = failure)
3. `typeof result === 'number'` → `true` (numeric results = success)
4. `typeof result === 'string'` → `\!/^error/i.test(result)` (covers both 'Error' and 'error')
5. `Array.isArray(result)` → `true` (array results = success)
6. `typeof result === 'object'` → `result.error \!= null ? false : (result.ok === false ? false : true)` (null-check: `error === null` sentinel is a valid "no error" payload, must not classify as failure)

**Replacement in loop.ts:548:**
```typescript
// Before (delete):
const _isSuccess = \!(typeof _tr.result === 'string' && _tr.result.startsWith('Error'));

// After (insert):
const _isSuccess = isToolResultSuccess(_tr.result);
```

Import at top of loop.ts:
```typescript
import { isToolResultSuccess } from './tool-result-classifier.js';
```

### Item 3 — `skillIdForTool` reverse index (functionality gap)

**Decision: Option A — flat `skills/*.md` as data source.** The bundled `SKILL.md` files (Path B) carry zero `allowed-tools` entries; implementing them would require frontmatter migration to 5 files with no data gain. The flat `skills/*.md` loader already parses `allowed-tools` into `MarkdownSkill.allowedTools?: string[]` for 33 files. No migration needed.

Option C (both paths) degenerates to A because Path B contributes nothing. Option D (defer) leaves T2 feed uncalibrated another wave.

**Tie-breaker rule:** When multiple skills list the same tool in `allowed-tools`, return `null` (ambiguous — skip). Rationale: `memory_search` appears in 8+ skills. Returning a random or alphabetically-first skill would inject systematic bias into `AgentConfigEvolver` proposals — the learning signal integrity risk outweighs the volume gain. The `null` propagates to `trace-meta.skillId` remaining absent, which is the correct Wave 10B behavior for ambiguous tools.

**Fan-out tracking:** at index build time, log a single debug message listing all tools that resolved to multiple skills (collision count only, no content).

**New file:** `/root/sudo-ai-v4/src/core/skills/skill-tool-index.ts`

**Exported function signature:**
```typescript
export function buildSkillToolIndex(skills: MarkdownSkill[]): Map<string, string>
// Returns: tool name → skill name. Ambiguous tool names (>1 skill) are NOT included in the map.
```

**Build logic:**
1. For each `MarkdownSkill` in `skills`, if `skill.allowedTools` is a non-empty array, iterate over each tool string.
2. Maintain a `Map<string, string>` (tool→skillName) and a `Map<string, number>` (tool→claimCount) as a scratch collision tracker.
3. First pass: populate claimCount for all tools.
4. Second pass: for each tool where `claimCount === 1`, add to the result map with value `skill.name`.
5. After build, log: `log.debug({ unambiguous, ambiguous }, 'skillToolIndex built')` where `ambiguous` = count of tools with claimCount > 1.
6. Return the result map (ambiguous tools absent, not null-valued).

**ToolRegistry integration — `setSkillIndex` setter:**

Add to `ToolRegistry` class in `/root/sudo-ai-v4/src/core/tools/registry.ts`:

```typescript
private _skillIndex: Map<string, string> | null = null;

// Kill-switch: SUDO_SKILL_INDEX_DISABLE=1 prevents index lookup without process reload
setSkillIndex(index: Map<string, string>): void {
  if (process.env['SUDO_SKILL_INDEX_DISABLE'] === '1') {
    log.debug('setSkillIndex: disabled by kill-switch — ignoring');
    return;
  }
  this._skillIndex = index;
  log.info({ toolCount: index.size }, 'skillToolIndex loaded into registry');
}

skillIdForTool(name: string): string | null {
  if (\!name) return null;
  return this._skillIndex?.get(name) ?? null;
}
```

The `void name` stub is replaced by the real lookup. When `_skillIndex` is null (not yet set), `?.get()` short-circuits to undefined, `?? null` returns null — identical to current behavior.

**cli.ts wiring (single line, near L1766):**

After `loadMarkdownSkills` completes on L1766, add immediately after:
```typescript
// Wave 10C: build skill→tool reverse index and wire into registry
const _skillToolIndex = buildSkillToolIndex(mdSkills);
registry.setSkillIndex(_skillToolIndex);
```

This is the only cli.ts change. It lives inside the existing try block at L1765. Import `buildSkillToolIndex` from `./core/skills/skill-tool-index.js` at the top of cli.ts.

**Index lifecycle:** startup build only (not lazy). `loadMarkdownSkills` is async and runs at boot in the v5 try block. Registry is already live at this point. No need for lazy rebuild — skill files are static at deploy time.

**Test 6 update (wave10b-activation.test.ts):** The existing test asserts `skillIdForTool returns null for any input`. This test must be updated by Builder B to verify:
- `null` before `setSkillIndex` called (backwards-compatible)
- mapped value returned after `setSkillIndex` called with a single-claim map
- `null` returned after `setSkillIndex` for a tool with ambiguous claims (tool absent from map)
- `null` for an unrecognised tool (key not in map)

**MarkdownSkill.name collision note:** The loader falls back to `file.replace('.md', '')` when `meta.name` is absent. Name collisions across files are theoretically possible. The skill-tool-index build uses `skill.name` as the value, so collision in skill names does not break correctness — it just means two distinct files mapping the same tool would both register claimCount > 1, correctly triggering the null tie-breaker.

---

## §2 File Boundaries

**Strict: no builder touches files owned by the other.**

### Builder A — Array caps
Owns:
- `/root/sudo-ai-v4/src/core/learning/skill-discovery.ts` (add MAX_RECORDS, RECORDS_EVICT_COUNT, cap logic in recordToolCall)
- `/root/sudo-ai-v4/src/core/learning/agent-config-evolver.ts` (add MAX_TRACES, TRACES_EVICT_COUNT, cap logic in recordTrace)
- `/root/sudo-ai-v4/tests/learning/skill-discovery.test.ts` (append new cap tests)
- `/root/sudo-ai-v4/tests/learning/agent-config-evolver.test.ts` (append new cap tests)

Does NOT touch: loop.ts, registry.ts, cli.ts, or any test files outside tests/learning/.

### Builder B — Predicate + reverse index
Owns:
- `/root/sudo-ai-v4/src/core/agent/tool-result-classifier.ts` (NEW — create)
- `/root/sudo-ai-v4/src/core/agent/loop.ts` (replace L548 predicate, add import)
- `/root/sudo-ai-v4/src/core/skills/skill-tool-index.ts` (NEW — create)
- `/root/sudo-ai-v4/src/core/tools/registry.ts` (add _skillIndex field, setSkillIndex(), replace skillIdForTool stub)
- `/root/sudo-ai-v4/src/cli.ts` (2 lines only: import + 2-line wiring block after L1766)
- `/root/sudo-ai-v4/tests/agent/tool-result-classifier.test.ts` (NEW — create)
- `/root/sudo-ai-v4/tests/skills/skill-tool-index.test.ts` (NEW — create)
- `/root/sudo-ai-v4/tests/tools/registry-skill-index.test.ts` (NEW — create)
- `/root/sudo-ai-v4/tests/learning/wave10b-activation.test.ts` (update Test 6 only — item 3 owns this, even though file lives under tests/learning/)

Does NOT touch: skill-discovery.ts, agent-config-evolver.ts, tests/learning/skill-discovery.test.ts, tests/learning/agent-config-evolver.test.ts.

---

## §3 Non-Goals

The following are explicitly out of scope for Wave 10C:

- Bundled SKILL.md files (`src/core/skills/**/SKILL.md`) — no `allowed-tools` frontmatter migration
- Lazy/on-demand index rebuild — startup-only build is sufficient for static skill files
- Alphabetical-first tie-breaker variant — deferred (telemetry will inform if null rate is too high)
- Any staging reload — 48h seal soak is active; prod reload only
- SQLite persistence of the skill-tool index — in-memory Map is the correct shape for O(1) lookup
- Changing the `allowed-tools` value format in skill frontmatter files
- Any change to the `MarkdownSkill` type definition or the loader itself
- Python, new system packages, new npm dependencies

---

## §4 Implementation Details

### 4.1 Cap implementation detail — exact code shape

Both files follow identical structure. Example for `skill-discovery.ts`:

```typescript
// After existing constants block, add:
const MAX_RECORDS = 10_000;
const RECORDS_EVICT_COUNT = 1_000;

// In recordToolCall(), after this.records.push({...}):
if (this.records.length > MAX_RECORDS) {
  this.records.splice(0, RECORDS_EVICT_COUNT);
  log.debug({ evicted: RECORDS_EVICT_COUNT }, 'SkillDiscovery records buffer eviction');
}
```

For `agent-config-evolver.ts`:

```typescript
// After existing constants block, add:
const MAX_TRACES = 5_000;
const TRACES_EVICT_COUNT = 500;

// In recordTrace(), after this.traces.push(trace):
if (this.traces.length > MAX_TRACES) {
  this.traces.splice(0, TRACES_EVICT_COUNT);
  log.debug({ evicted: TRACES_EVICT_COUNT }, 'AgentConfigEvolver traces buffer eviction');
}
```

The existing `pre-filter if (trace.quality < 0) return` at L84 still precedes the push — no change to that guard.

### 4.2 tool-result-classifier.ts — complete function contract

File header: `/** @file tool-result-classifier.ts — classify tool execution result as success or failure. */`

No imports required. The function is a pure predicate over `unknown`.

```typescript
export function isToolResultSuccess(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (typeof result === 'boolean') return result;
  if (typeof result === 'number') return true;
  if (typeof result === 'string') return \!/^error/i.test(result);
  if (Array.isArray(result)) return true;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r['error'] \!= null) return false;
    if (r['ok'] === false) return false;
    return true;
  }
  return true; // symbol, function, bigint — treat as success
}
```

The `\!= null` check (not `\!== null`) intentionally matches both `null` and `undefined` for the `error` key, but the array-check above already handles arrays. The outer `result === null` branch catches null before the object branch.

### 4.3 skill-tool-index.ts — complete function contract

```typescript
import type { MarkdownSkill } from './markdown-loader.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:tool-index');

export function buildSkillToolIndex(skills: MarkdownSkill[]): Map<string, string> {
  const claimCount = new Map<string, number>();
  const claimOwner = new Map<string, string>(); // tool → skillName (first claimant, overwritten on collision)

  for (const skill of skills) {
    if (\!Array.isArray(skill.allowedTools)) continue;
    for (const tool of skill.allowedTools) {
      if (typeof tool \!== 'string' || \!tool) continue;
      claimCount.set(tool, (claimCount.get(tool) ?? 0) + 1);
      claimOwner.set(tool, skill.name); // second write is harmless — count tracks collision
    }
  }

  const result = new Map<string, string>();
  let ambiguous = 0;
  for (const [tool, count] of claimCount) {
    if (count === 1) {
      result.set(tool, claimOwner.get(tool)\!);
    } else {
      ambiguous++;
    }
  }

  log.debug({ unambiguous: result.size, ambiguous }, 'skillToolIndex built');
  return result;
}
```

Note: `claimOwner.set` on second pass overwrites the first owner; this is fine because we only use `claimOwner` when `count === 1`, so the value is always unambiguous when read.

### 4.4 registry.ts — exact additions

Add private field immediately after the `mcpTools` Map declaration:

```typescript
private _skillIndex: Map<string, string> | null = null;
```

Add `setSkillIndex` method after the existing `getByCategory` method (before `skillIdForTool`):

```typescript
setSkillIndex(index: Map<string, string>): void {
  if (process.env['SUDO_SKILL_INDEX_DISABLE'] === '1') {
    logger.debug('setSkillIndex: SUDO_SKILL_INDEX_DISABLE — index not loaded');
    return;
  }
  this._skillIndex = index;
  logger.info({ toolCount: index.size }, 'skillToolIndex loaded into ToolRegistry');
}
```

Replace the existing `skillIdForTool` stub body:

```typescript
skillIdForTool(name: string): string | null {
  if (\!name) return null;
  return this._skillIndex?.get(name) ?? null;
}
```

Remove the `void name;` comment — no longer needed.

### 4.5 cli.ts — exact wiring block

After L1766 (`const mdSkills = await loadMarkdownSkills(...)`), add exactly:

```typescript
// Wave 10C: build skill→tool reverse index and wire into ToolRegistry (fail-open)
try {
  const { buildSkillToolIndex } = await import('./core/skills/skill-tool-index.js');
  registry.setSkillIndex(buildSkillToolIndex(mdSkills));
} catch (err: unknown) {
  log.warn({ err: String(err) }, 'Wave 10C: skill-tool index build failed — skillIdForTool returns null');
}
```

Use a **static top-level import** (not dynamic). Other wave13 modules in cli.ts are statically imported; using dynamic import here is inconsistent. Add to the static imports block near the top of cli.ts:

```typescript
import { buildSkillToolIndex } from './core/skills/skill-tool-index.js';
```

Then the wiring block (inside the existing v5 try block) becomes synchronous:

```typescript
// Wave 10C: wire skill-tool reverse index into ToolRegistry (fail-open)
registry.setSkillIndex(buildSkillToolIndex(mdSkills));
```

Remove the inner try/catch from the wiring block — the outer v5 try block already catches errors with fail-open.

Note: The cli.ts §4.5 code snippet above (with await import) is superseded by this decision. Builder B uses static import.

---

## §5 Test Plan

Target: +25 tests exactly (4 CAP-SD + 4 CAP-ACE + 10 TRC + 5 STI + 4 RSI + Test 6 subcases counted as 1 updated test — but the 4 subcases inside it add depth without adding vitest `it()` count). All new tests must pass. No existing tests must break.

### Builder A tests (append to existing files)

**tests/learning/skill-discovery.test.ts — add 4 tests (CAP-SD-1 through CAP-SD-4):**

| ID | Description |
|----|-------------|
| CAP-SD-1 | `recordCount()` stays <= MAX_RECORDS after MAX_RECORDS+1 pushes |
| CAP-SD-2 | Eviction removes exactly RECORDS_EVICT_COUNT oldest entries (verify via recordCount drop) |
| CAP-SD-3 | Records added after eviction are retained (newest entries not lost) |
| CAP-SD-4 | No eviction fires below MAX_RECORDS (recordCount === N for N < MAX_RECORDS small value) |
*(CAP-SD-5 and CAP-SD-6 are dropped to keep within the test count target. reset() is already tested; mine() correctness post-eviction is a Wave 10D enhancement.)*

**tests/learning/agent-config-evolver.test.ts — add 4 tests (CAP-ACE-1 through CAP-ACE-4):**

| ID | Description |
|----|-------------|
| CAP-ACE-1 | `traceCount()` stays <= MAX_TRACES after MAX_TRACES+1 pushes (negative-quality pre-filter means push MAX_TRACES entries with quality=0.0 — all pass since only quality<0 is filtered) |
| CAP-ACE-2 | Eviction removes exactly TRACES_EVICT_COUNT oldest entries |
| CAP-ACE-3 | Traces added after eviction are retained |
| CAP-ACE-4 | No eviction below MAX_TRACES |
*(CAP-ACE-5 and CAP-ACE-6 dropped; propose() is already tested in existing suite. quality<0 pre-filter is covered there too.)*

### Builder B tests (new test files)

**tests/agent/tool-result-classifier.test.ts — 10 tests:**

| ID | Description |
|----|-------------|
| TRC-1 | `null` → true |
| TRC-2 | `undefined` → true |
| TRC-4 | `'Error: something'` → false |
| TRC-5 | `'error: something'` → false (lowercase — widened from Wave 10B behavior) |
| TRC-7 | `{error: 'not found'}` → false |
| TRC-8 | `{error: null}` → true (null error sentinel = no error) |
| TRC-9 | `{ok: false}` → false |
| TRC-10 | `{ok: true, data: 'result'}` → true |
| TRC-11 | `{result: 'ok'}` (no error/ok key) → true |
| TRC-12 | `false` (boolean) → false |

**Exactly these 10 tests required.** TRC-3, TRC-6, TRC-13, TRC-14 are dropped (least discriminating).

**tests/skills/skill-tool-index.test.ts — 5 tests:**

| ID | Description |
|----|-------------|
| STI-1 | Single skill with 2 allowed-tools → both mapped to skill name |
| STI-2 | Two skills sharing one tool → that tool absent from map (null tie-breaker), each unique tool present |
| STI-3 | Skill with no allowed-tools field → ignored |
| STI-4 | Empty skills array → empty map |
| STI-5 | Tool appearing in 3 skills → absent from map, other tools present |

**tests/tools/registry-skill-index.test.ts — 4 tests:**

| ID | Description |
|----|-------------|
| RSI-1 | `skillIdForTool` returns null before `setSkillIndex` called |
| RSI-2 | `skillIdForTool` returns mapped skill name after `setSkillIndex` called |
| RSI-3 | `skillIdForTool` returns null for unknown tool (not in index) |
| RSI-4 | `SUDO_SKILL_INDEX_DISABLE=1` env → `setSkillIndex` silently ignored, `skillIdForTool` still returns null |

**tests/learning/wave10b-activation.test.ts — update Test 6:**

Replace the existing "returns null for any input" test with expanded coverage:
- Subcase: null before index (backwards-compatible, same as before)
- Subcase: mapped value after setSkillIndex with a single-claim map
- Subcase: null for ambiguous tool (tool absent from map because 2 skills claimed it)
- Subcase: null for unknown tool (not in map at all)

This test still lives in tests/learning/ but Builder B owns it (explicitly flagged here to prevent Builder A from touching it).

---

## §6 Risks and Rollback

### Risks

1. **Cap tests are slow:** Pushing 10_000 records in a test suite is fast (pure JS push), but if vitest workers time out, reduce test count to 5_000 for CAP-SD-1. Annotate with comment.

2. **loop.ts import:** Adding `isToolResultSuccess` import to loop.ts is a static import change to a large file. Builder B must verify `tsc --noEmit` passes. The import path `./tool-result-classifier.js` must use `.js` extension (ESM requirement).

3. **cli.ts dynamic import inside try block:** Dynamic `await import()` inside the v5 try block is consistent with the existing pattern. Risk: if `skill-tool-index.ts` has a compile error, the catch logs a warn and the process continues — fail-open by design.

4. **Test 6 flip:** The existing `wave10b-activation.test.ts` Test 6 assertion `expect(registry.skillIdForTool('dummy.tool')).toBeNull()` remains valid (still null before setSkillIndex). The update extends the test rather than replacing its core assertion.

5. **Overwrite risk in `claimOwner` map:** Documented in §4.3. Second write to same key is harmless because the value is only read when `claimCount === 1`, guaranteeing the entry is unambiguous and the single owner is accurate.
6. **FIFO eviction and per-agent fairness:** Both caps evict by global insertion order (oldest first across all agents). An agent that recorded many traces hours ago may have all its traces evicted while a recently active agent retains full history. This can drop a historical agent below `MIN_TRACE_COUNT = 10`, preventing `propose()` from generating proposals for it. This is an acceptable tradeoff for Wave 10C (global FIFO is simple and mirrors the metrics.ts precedent). A per-agent ring buffer is a Wave 10D enhancement candidate.

7. **Quality baseline shift for Item 2:** The `/^error/i` predicate widens the old `startsWith('Error')` check to also catch lowercase `'error: ...'` results. On first deploy, any tools that previously returned lowercase `'error...'` strings will be reclassified as failures. The `quality` value fed to `AgentConfigEvolver` may shift downward. This is correct behavior (those were always failures) but operators watching quality metrics should expect a one-time step-down in the moving average after prod reload.

### Rollback

All three items are independently rollback-able:

- **Item 1 (caps):** Remove the 4 lines (constant + guard) from each file. No external contracts change.
- **Item 2 (predicate):** Revert loop.ts to inline `\!tr.result.startsWith('Error')`. Delete tool-result-classifier.ts.
- **Item 3 (index):** Set `SUDO_SKILL_INDEX_DISABLE=1` in pm2 ecosystem env without process reload. The `setSkillIndex` setter returns early; `skillIdForTool` returns null (Wave 10B state). No data loss. Full rollback: remove 2-line wiring block from cli.ts + delete skill-tool-index.ts + revert registry.ts setter.

---

## §7 Kill-switches

| Switch | Env var | Default | Effect |
|--------|---------|---------|--------|
| Skill index disable | `SUDO_SKILL_INDEX_DISABLE=1` | OFF | setSkillIndex() is a no-op; skillIdForTool() returns null (Wave 10B state) |

No kill-switch is needed for Items 1 or 2 — both are pure defensive fixes with no new external behavior to revert via env var.

---

## §8 Deploy

- Staging reload: FORBIDDEN (48h seal soak active on sudo-ai-v5-staging PID 2042660)
- Prod reload: `pm2 reload sudo-ai-v5 --update-env` after all gates pass (security APPROVED zero HIGH+, tsc clean, all tests green)
- No new environment variables need to be set for default operation (kill-switch is opt-in)

---

*Broadcast this spec to Builder A and Builder B before either starts work.*
