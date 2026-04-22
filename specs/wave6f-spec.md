# Wave 6F Spec — SUDO-AI v5 (2026-04-13)

Baseline: 1629/1629 tests, tsc clean, pm2 sudo-ai-v5 online, gateway :18900.
Target: ≥1670 tests passing.

---

## 1. Scope — Four Primitives

| ID | Primitive | Owner |
|----|-----------|-------|
| A1 | Content-hash decisionId in VetoOverrideStore + loop.ts tool-dispatch | Builder A |
| A2 | Prepared-statement caching in VetoOverrideStore | Builder A (same file, same pass) |
| B  | GET /v1/admin/alignment + AlignmentAggregator.getLastReport() | Builder B |
| C  | Epistemic Honesty Gate (new module + loop.ts LLM-parse site) | Builder C |

---

## 2. File Boundaries — STRICT, NO COLLISIONS

| Builder | Owns (write) | Read-only |
|---------|-------------|-----------|
| A | `src/core/agent/veto-override-store.ts` (full file) | `src/core/agent/veto-gate.ts` (read `sanitizeArgsForPrompt` only — DO NOT EDIT) |
| A | `src/core/agent/loop.ts` — ONLY the section starting at landmark `// Veto gate: adversarial pre-execution check.` (currently line 776) through the end of the veto+tool-dispatch block. Approximate current range: lines 776–900+. DO NOT TOUCH anything above line 755. |  |
| B | `src/core/agent/alignment-aggregator.ts` (full file) | |
| B | `src/core/gateway/admin-routes.ts` (full file) | |
| C | `src/core/cognition/epistemic-gate.ts` (NEW file — create directory if needed) | |
| C | `src/core/agent/loop.ts` — ONLY the section between landmark `if (response.content) emit({ type: 'stream-chunk', chunk: response.content });` (currently line 731) and landmark `// Run loop-guard checks for each tool call before executing.` (currently line 733). Insert exactly ONE block between these two landmarks. DO NOT TOUCH anything at or below line 733. DO NOT TOUCH anything at or above line 731 (do not modify line 731 itself). |  |

### loop.ts Firewall (CRITICAL — both builders must read this)

```
line 731  if (response.content) emit(...)       ← Builder C: insert AFTER this line
line 732  [NEW: Builder C inserts epistemic gate block here]
line 733  // Run loop-guard checks ...           ← Builder A: DO NOT TOUCH above this comment
...
line 754  if (guardAborted) break;               ← NO-TOUCH BUFFER TOP
line 755                                         |  neither builder touches lines 753-775
line 756  // Identity anchor: advisory ...       ← NO-TOUCH BUFFER BOTTOM
line 776  // Veto gate: adversarial pre-...      ← Builder A: territory starts HERE
```

No-touch buffer: lines 753–775 (guardAborted break through identity anchor block). Neither builder modifies this range.

Integration note: If Builder C's code insertion shifts line numbers for Builder A, Builder A uses the landmark comment `// Veto gate: adversarial pre-execution check.` to locate their territory — not the raw line number.

---

## 3. Interface Contracts

### 3.1 VetoOverrideStore — Schema v2 (Builder A)

**Migration rule:** Additive ALTER TABLE. Must be idempotent.

```sql
-- _initSchema() must run this AFTER the CREATE TABLE block:
ALTER TABLE veto_overrides ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_veto_overrides_content_hash
  ON veto_overrides(content_hash)
  WHERE content_hash IS NOT NULL;
```

Idempotency pattern — wrap in try/catch and ignore SQLite error code `SQLITE_ERROR` with message containing "duplicate column name":

```typescript
try {
  this.db.exec(`ALTER TABLE veto_overrides ADD COLUMN content_hash TEXT`);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (\!msg.includes('duplicate column name')) throw err;
  // column already exists — no-op
}
```

Existing rows with `content_hash = NULL` remain valid and queryable by decisionId.

**Updated VetoOverride interface:**

```typescript
export interface VetoOverride {
  id:          string;
  decisionId:  string;
  contentHash: string | null;   // NEW — nullable for legacy rows
  action:      'allow' | 'deny';
  reason:      string;
  createdAt:   string;
  createdBy:   string;
}
```

**Updated VetoOverrideRow (internal):**

```typescript
interface VetoOverrideRow {
  id:           string;
  decision_id:  string;
  content_hash: string | null;  // NEW
  action:       string;
  reason:       string;
  created_at:   string;
  created_by:   string;
}
```

**New method:**

```typescript
getOverrideByContentHash(contentHash: string): VetoOverride | null;
```

Returns the first override with matching `content_hash`, or null. Fail-open on DB error (log + return null, do not throw). Uses prepared statement `_stmtGetByContentHash`.

### 3.2 Prepared-Statement Caching (Builder A, same file)

Replace all inline `this.db.prepare(...)` calls with class-level cached statements. Pattern mirrors `src/core/files/store.ts:43-48`.

Declare in class body (after `private readonly db`):

```typescript
private readonly _stmtRecord:            Database.Statement;
private readonly _stmtGet:               Database.Statement;
private readonly _stmtGetByContentHash:  Database.Statement;
private readonly _stmtList:              Database.Statement;
```

Initialize in constructor AFTER `this._initSchema()`:

```typescript
this._stmtRecord = this.db.prepare(
  `INSERT INTO veto_overrides (id, decision_id, content_hash, action, reason, created_at, created_by)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
this._stmtGet = this.db.prepare(
  `SELECT id, decision_id, content_hash, action, reason, created_at, created_by
   FROM veto_overrides WHERE decision_id = ?`
);
this._stmtGetByContentHash = this.db.prepare(
  `SELECT id, decision_id, content_hash, action, reason, created_at, created_by
   FROM veto_overrides WHERE content_hash = ? LIMIT 1`
);
this._stmtList = this.db.prepare(
  `SELECT id, decision_id, content_hash, action, reason, created_at, created_by
   FROM veto_overrides ORDER BY created_at DESC LIMIT ?`
);
```

Replace inline `this.db.prepare(...).run(...)` and `.get(...)` and `.all(...)` in `recordOverride`, `getOverride`, `listOverrides` with the cached statement references. Update INSERT to include `content_hash` parameter (value passed as `override.contentHash ?? null`).

### 3.3 Content-Hash Recipe (Builder A, loop.ts side)

**AUTHORITATIVE RECIPE:**

```typescript
import { createHash } from 'node:crypto';
import { sanitizeArgsForPrompt } from '../agent/veto-gate.js';
// sanitizeArgsForPrompt returns a string (JSON.stringify of sanitized args).
// We hash: tool name + ":" + that string — no double-serialization.

function computeContentHash(toolName: string, args: Record<string, unknown>): string {
  const sanitized = sanitizeArgsForPrompt(args);          // returns string
  const payload   = `${toolName}:${sanitized}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}
```

Rationale: `sanitizeArgsForPrompt` returns `JSON.stringify(sanitized, null, 2)`. Hashing the concatenation `toolName:sanitizedJsonString` is deterministic and avoids double-encoding. The `null, 2` pretty-print is part of the canonical form — do not change the call site in veto-gate.ts.

**loop.ts wiring (Builder A's territory, currently ~line 788-791):**

```typescript
// Generate a decisionId AND contentHash per tool call.
const decisionIdMap  = new Map<string, string>();
const contentHashMap = new Map<string, string>();
for (const tc of validToolCalls) {
  decisionIdMap.set(tc.id, genId());
  contentHashMap.set(tc.id, computeContentHash(tc.name, tc.arguments ?? {}));
}
```

Override lookup order (currently ~line 793-796), replace:

```typescript
const decisionId  = decisionIdMap.get(tc.id)\!;
const contentHash = contentHashMap.get(tc.id)\!;
// Check content-hash override FIRST (enables pre-approval), then decisionId fallback.
const manualOverride =
  (contentHash ? this.vetoOverrideStore?.getOverrideByContentHash(contentHash) : null)
  ?? this.vetoOverrideStore?.getOverride(decisionId)
  ?? null;
```

Log both identifiers in audit triples — add `contentHash` field alongside `decisionId` in existing `recordTriple` calls.

**POST /v1/admin/veto/override body v2** (Builder B's route handler update in admin-routes.ts):

```typescript
interface VetoOverridePostBody {
  decisionId?:  string;   // optional — at least one of the two required
  contentHash?: string;   // optional — at least one of the two required
  action:       'allow' | 'deny';
  reason:       string;
}
```

Validation: if neither `decisionId` nor `contentHash` is present → 400 `"decisionId or contentHash required"`. If both present → use both (store both). `decisionId` defaults to `contentHash` value when only `contentHash` provided (use `contentHash` as decisionId fallback so the UNIQUE constraint on `decision_id` stays satisfied — use a generated `uuid` instead when decisionId is absent to avoid collisions; set `decision_id = randomUUID()` and `content_hash = body.contentHash`).

Operator workflow: The loop logs `contentHash` in audit events (see above). Operator reads the hash from logs/audit and posts `{contentHash: "<32-char-hex>", action:"allow", reason:"..."}` to pre-register the override. Next time that exact tool+args combination runs, the gate is bypassed.

### 3.4 AlignmentAggregator — getLastReport() (Builder B)

**New private field** (add after `private readonly auditTrail`):

```typescript
private _lastReport: (AggregatorResult & {
  evaluatedAt:        string;         // ISO-8601
  signals:            AlignmentSignals;
  contributingSignals: string[];      // signal keys that crossed threshold
}) | null = null;
```

**Mutation in `_compute()`** — append before the `return` statement:

```typescript
this._lastReport = {
  ...result,
  evaluatedAt:        new Date().toISOString(),
  signals,
  contributingSignals: this._extractContributingSignalKeys(signals),
};
```

**New public method:**

```typescript
getLastReport(): (AggregatorResult & {
  evaluatedAt:        string;
  signals:            AlignmentSignals;
  contributingSignals: string[];
}) | null;
```

Returns `this._lastReport`. Never throws. Returns null if `evaluate()` has never been called.

**`_extractContributingSignalKeys()` private helper** — returns the signal property names (keys of `AlignmentSignals`) that caused a contributing note in the current thresholds. Reuse the SAME threshold logic as `_buildDiagnosis` but return key names instead of prose:

```typescript
private _extractContributingSignalKeys(signals: AlignmentSignals): string[] {
  const keys: string[] = [];
  if (signals.commitmentDrift > 0.6)    keys.push('commitmentDrift');
  if (signals.injectionRate > 0.6)      keys.push('injectionRate');
  if (signals.recoveryPending > 0.5)    keys.push('recoveryPending');
  if (signals.trustTier < 0.3)          keys.push('trustTier');
  if (signals.outcomeDelta < -0.5)      keys.push('outcomeDelta');
  if (signals.discordanceScore > 0.6)   keys.push('discordanceScore');
  return keys;
}
```

Note: `getLastReport()` is in-memory only. State does not survive process restarts. This is intentional and documented — the aggregator is per-session/per-process. Fresh boot returns `null`, which is normal.

### 3.5 GET /v1/admin/alignment (Builder B, admin-routes.ts)

**Extend AdminRoutesDeps:**

```typescript
export interface AdminRoutesDeps {
  // ... existing fields ...
  alignmentAggregator?: {
    getLastReport(): (import('../agent/alignment-aggregator.js').AggregatorResult & {
      evaluatedAt:        string;
      signals:            import('../agent/alignment-aggregator.js').AlignmentSignals;
      contributingSignals: string[];
    }) | null;
  };
}
```

**Route — insert before the catch-all 404 in `registerAdminRoutes` (currently line 416):**

```typescript
// GET /v1/admin/alignment
if (method === 'GET' && pathname === '/v1/admin/alignment') {
  handleAlignmentGet(res, deps);
  return;
}
```

**Handler:**

```typescript
function handleAlignmentGet(res: ServerResponse, deps: AdminRoutesDeps): void {
  try {
    const report = deps.alignmentAggregator?.getLastReport() ?? null;
    if (report === null) {
      sendJson(res, 200, { ok: true, data: null });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        level:              report.level,
        score:              report.score,
        contributingSignals: report.contributingSignals,
        evaluatedAt:        report.evaluatedAt,
        failedOpen:         report.failedOpen,
        diagnosis:          report.diagnosis,
      },
    });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin: alignment get failed');
    if (\!res.headersSent) sendError(res, 500, 'Internal server error');
  }
}
```

Response envelope contract:
- 200 `{ok: true, data: null}` — aggregator present but never called (fresh boot)
- 200 `{ok: true, data: {level, score, contributingSignals, evaluatedAt, failedOpen, diagnosis}}` — last evaluation
- 200 `{ok: true, data: null}` — dep absent (`alignmentAggregator` not provided)
- 401 — bad token (handled by existing auth middleware)
- Never 503 for uncalled/absent state.

Update the `log.info` registration string at the bottom of `registerAdminRoutes` to include the new route.

### 3.6 Epistemic Honesty Gate (Builder C)

**New file: `src/core/cognition/epistemic-gate.ts`**

```typescript
// Types

export type EpistemicTag = 'CERTAIN' | 'PROBABLE' | 'CONJECTURE' | 'UNKNOWN';

export type ImpactLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type GateDecision = 'PROCEED' | 'REPLAN' | 'UNCERTAIN_RESPONSE';

export interface GateInput {
  tag:    EpistemicTag;
  impact: ImpactLevel;
}

export interface GateResult {
  decision:    GateDecision;
  reason:      string;
}

export interface ConjectureCommitError {
  type:        'ConjectureCommitError';
  tag:         EpistemicTag;
  impact:      ImpactLevel;
  rationale:   string;        // first 200 chars of the offending rationale text
  sessionId?:  string;
}

export interface UncertaintyResponse {
  type:        'UncertaintyResponse';
  tag:         EpistemicTag;
  message:     string;        // structured message for injection into session messages
}
```

**`classifyRationale(text: string): EpistemicTag`** — pure synchronous, no I/O. Classification rules (first match wins):

```
UNKNOWN    — text is empty OR contains hedges: /\b(i don't know|i do not know|no information|cannot determine|i have no)\b/i
CONJECTURE — contains: /\b(i think|i believe|probably|likely|perhaps|maybe|might|could be|i guess|i assume|i suspect)\b/i
PROBABLE   — contains: /\b(it appears|it seems|evidence suggests|based on|typically|usually|generally)\b/i
CERTAIN    — default (no matching hedge patterns)
```

Match in the order UNKNOWN → CONJECTURE → PROBABLE → CERTAIN.

**`classifyImpact(toolName: string): ImpactLevel`** — derive from tool name using same naming conventions as `classifyRisk` in veto-gate.ts (DO NOT import or call `classifyRisk` directly — the epistemic gate is a separate concern):

```
CRITICAL — /delete|drop|rm|wipe|format|shutdown|exec|eval|shell/i
HIGH     — /write|create|update|insert|post|put|patch/i
MEDIUM   — /send|email|message|notify|alert|read|fetch|query/i
LOW      — everything else
```

**`gateToolCall(input: GateInput): GateResult`** — synchronous, no I/O:

```
CONJECTURE + MEDIUM|HIGH|CRITICAL → GateDecision = 'REPLAN'
UNKNOWN    + HIGH|CRITICAL        → GateDecision = 'REPLAN'
UNKNOWN    + LOW|MEDIUM           → GateDecision = 'UNCERTAIN_RESPONSE'
everything else                   → GateDecision = 'PROCEED'
```

**`buildConjectureCommitError(...): ConjectureCommitError`** — factory function, not a thrown Error class. Loop.ts will check the decision and act accordingly.

**`buildUncertaintyResponse(...): UncertaintyResponse`** — factory function. Produces a structured object with a `message` field formatted as: `"[EpistemicGate] Low-confidence response (tag=UNKNOWN) — treating as uncertain. Please verify before acting."`.

**Optional SQLite epistemic log** — if a `db?: Database` is passed to `EpistemicGate` constructor, create table `epistemic_log (id TEXT PRIMARY KEY, session_id TEXT, tag TEXT, impact TEXT, decision TEXT, rationale_preview TEXT, ts TEXT)` and insert on every gate call. Fail silently if DB absent or insert fails (no throw). This is optional — callers may pass no DB.

**EpistemicGate class:**

```typescript
export class EpistemicGate {
  constructor(db?: Database) { ... }
  
  evaluate(rationale: string, toolName: string, sessionId?: string): {
    tag:      EpistemicTag;
    impact:   ImpactLevel;
    result:   GateResult;
    error?:   ConjectureCommitError;
    response?: UncertaintyResponse;
  };
}
```

Never throws. Fail-open: if any internal error, return `{tag:'CERTAIN', impact:'LOW', result:{decision:'PROCEED', reason:'fail-open'}}`.

### 3.7 loop.ts Epistemic Gate Integration (Builder C)

**Insertion point:** Between line 731 (`if (response.content) emit(...)`) and line 733 (`// Run loop-guard checks`).

**Ordering rationale (document in code):** Epistemic gate runs BEFORE loop guard. A CONJECTURE-tagged rationale that is routed to REPLAN does not count toward the loop guard's repetition tracker for this tool call — the call never reaches the guard's `recordCall` method. This is intentional: REPLAN injects a system message and breaks to the next iteration, which the loop guard will see as a new state.

**Code block to insert:**

```typescript
// Epistemic gate: classify rationale confidence before tool dispatch.
// Runs before loop guard — a REPLAN decision skips guard tracking entirely.
if (this.epistemicGate \!== undefined) {
  for (const tc of validToolCalls) {
    try {
      const rationaleText = response.content ?? '';
      const eg = this.epistemicGate.evaluate(rationaleText, tc.name, state.sessionId);
      if (eg.result.decision === 'REPLAN') {
        const replMsg = eg.error
          ? `[EpistemicGate] Conjecture-commit blocked for ${tc.name} (tag=${eg.tag}) — replanning.`
          : `[EpistemicGate] Low-confidence (tag=${eg.tag}) — replanning before ${tc.name}.`;
        session.messages.push({ role: 'system', content: replMsg });
        emit({ type: 'error', error: replMsg });
        log.warn({ tool: tc.name, tag: eg.tag, sessionId: state.sessionId }, 'EpistemicGate REPLAN');
        // Break inner tool-call iteration and continue outer LLM loop.
        // validToolCalls is filtered to non-empty above; skip all remaining.
        // Signal replan by clearing validToolCalls inline.
        (validToolCalls as unknown[]).length = 0;
        break;
      } else if (eg.result.decision === 'UNCERTAIN_RESPONSE' && eg.response) {
        session.messages.push({ role: 'system', content: eg.response.message });
        log.info({ tool: tc.name, tag: eg.tag, sessionId: state.sessionId }, 'EpistemicGate UNCERTAIN_RESPONSE injected');
        // Non-blocking — continues to loop guard and execution.
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'AgentLoop: epistemic gate threw — proceeding');
    }
  }
  // If REPLAN cleared all calls, skip guard + dispatch.
  if (validToolCalls.length === 0) continue;
}
```

Note: Builder C adds `this.epistemicGate?: EpistemicGate` as an optional constructor field. Builder C does NOT modify the AgentLoop class constructor signature in a breaking way — the field is optional and defaults to undefined. Builder C must find where `AgentLoop` class fields are declared and add the field there (read the class header before editing).

---

## 4. Quality Gates (non-negotiable)

Per `feedback_spawn_agents_faster.md`:

1. `pnpm tsc --noEmit` → exit 0. Zero new TypeScript errors.
2. `pnpm vitest run` → 1629 baseline + new tests → ≥1670 passing. No `.skip`, no `.only`.
3. No `any` without comment justification on same line.
4. No `console.log` / `console.warn` / `console.error` — use `createLogger`.
5. No secrets logged (no token values, no file contents).
6. All public exports have explicit return types.
7. try/catch at every DB call, fs call, sub-module with throw potential. Fail-open + log.
8. Strict file boundaries — no cross-builder file edits.

---

## 5. Time Budget

Each builder: ≤15 minutes, single-pass execution. No exploratory wandering. No re-reads after first pass. Report DONE only when ALL quality gates pass.

---

## 6. Test Plan

### Primitive A1: Content-hash decisionId

| Test | Expected |
|------|----------|
| `computeContentHash('read_file', {path:'/foo'})` called twice → same result | deterministic |
| `computeContentHash('read_file', {path:'/foo'})` vs `('write_file', {path:'/foo'})` → different | tool name changes hash |
| `getOverrideByContentHash(hash)` where hash was stored → returns override | happy path |
| `getOverrideByContentHash('nonexistent')` → null | not found |
| loop.ts: contentHash-based override triggers before decisionId override when both present | priority order |
| loop.ts: decisionId fallback when no contentHash match | backward compat |
| Empty args `{}` → `computeContentHash('tool', {})` returns 32-char hex string | edge: empty args |

### Primitive A2: Prepared-statement caching

| Test | Expected |
|------|----------|
| Construct `VetoOverrideStore`, then call `recordOverride` + `getOverride` + `listOverrides` | no errors, same behavior as pre-cache |
| Construct store on DB with existing rows (no content_hash) → `listOverrides` returns them | migration backward compat |
| Old DB schema (no `content_hash` column) — constructor runs ALTER TABLE — getOverride still works | idempotent migration |

### Primitive B: GET /v1/admin/alignment

| Test | Expected |
|------|----------|
| Route registered, no prior `evaluate()` call → `{ok:true, data:null}` 200 | fresh boot |
| Route called after `evaluate({...})` → `{ok:true, data:{level, score, contributingSignals, evaluatedAt, failedOpen, diagnosis}}` | happy path |
| `contributingSignals` reflects signals that crossed thresholds | signal derivation |
| `alignmentAggregator` dep absent from `AdminRoutesDeps` → `{ok:true, data:null}` | optional dep |
| 401 with bad/missing token | auth |
| NaN score in aggregator (`evaluate` fail-open path) → `getLastReport()` returns null for that call | NaN edge case |
| `getLastReport()` called before any `evaluate()` → returns null | missing state |

### Primitive C: Epistemic Honesty Gate

| Test | Expected |
|------|----------|
| `classifyRationale("I think this file exists")` → `CONJECTURE` | happy path |
| `classifyRationale("I don't know")` → `UNKNOWN` | happy path |
| `classifyRationale("It appears the path exists")` → `PROBABLE` | happy path |
| `classifyRationale("The file is at /tmp/x")` → `CERTAIN` | happy path |
| `classifyRationale("")` → `UNKNOWN` | edge: empty |
| `gateToolCall({tag:'CONJECTURE', impact:'HIGH'})` → `{decision:'REPLAN'}` | conjecture + HIGH |
| `gateToolCall({tag:'CONJECTURE', impact:'LOW'})` → `{decision:'PROCEED'}` | conjecture + LOW |
| `gateToolCall({tag:'UNKNOWN', impact:'CRITICAL'})` → `{decision:'REPLAN'}` | unknown + CRITICAL |
| `gateToolCall({tag:'UNKNOWN', impact:'MEDIUM'})` → `{decision:'UNCERTAIN_RESPONSE'}` | unknown + MEDIUM |
| `gateToolCall({tag:'CERTAIN', impact:'CRITICAL'})` → `{decision:'PROCEED'}` | no hedge, no gate |
| `EpistemicGate.evaluate` with internal error → fail-open, returns PROCEED, does not throw | fail-open |
| `buildUncertaintyResponse` → message contains `EpistemicGate` and tag | structured format |

---

## 7. Backward Compatibility

### veto_overrides table migration

- `ALTER TABLE veto_overrides ADD COLUMN content_hash TEXT` wrapped in try/catch, ignoring `"duplicate column name"` error. Safe to run on every startup.
- Existing rows: `content_hash = NULL`. Queryable by `decisionId` as before.
- `_stmtRecord` INSERT now passes `content_hash` as 7th parameter.
- `_rowToOverride` maps `row.content_hash` (may be null) to `VetoOverride.contentHash`.
- `UNIQUE` index uses `WHERE content_hash IS NOT NULL` to exclude nulls from uniqueness check.

### Aggregator state on restart

`_lastReport` is in-memory only. Process restart → `null`. This is documented behavior. Operators expecting persistent alignment history should use audit logs. There is no persistent state to migrate.

### Loop.ts backward compat

`this.epistemicGate` is optional (`?: EpistemicGate`). If not set, the entire epistemic block is skipped. Zero behavioral change for callers that do not provide the dep.

---

## 8. Acceptance Criteria — DONE Signal per Builder

### Builder A — DONE when:
- `pnpm tsc --noEmit` exits 0
- `pnpm vitest run` shows ≥1640 passing (≥11 new tests for A1+A2)
- `VetoOverrideStore` constructor runs `ALTER TABLE` idempotently on both fresh and existing DBs
- `getOverrideByContentHash` returns correct override or null
- `computeContentHash` is deterministic (same input → same 32-char hex)
- loop.ts checks contentHash override before decisionId override
- Both hash and decisionId are logged in audit triples
- All 4 prepared statements declared at class level, initialized after `_initSchema()`
- No inline `db.prepare()` calls remain in `veto-override-store.ts`

### Builder B — DONE when:
- `pnpm tsc --noEmit` exits 0
- `pnpm vitest run` shows ≥1645 passing (≥7 new tests for B)
- `getLastReport()` returns null before first `evaluate()` call
- `getLastReport()` returns correct shape after `evaluate()` call
- `contributingSignals` matches threshold logic exactly
- `GET /v1/admin/alignment` returns `{ok:true, data:null}` for fresh boot
- `GET /v1/admin/alignment` returns full data envelope after evaluation
- No 503 response for any alignment state
- `POST /v1/admin/veto/override` accepts `contentHash`-only body (no decisionId)
- `AdminRoutesDeps` extended without breaking existing callers (optional field)

### Builder C — DONE when:
- `pnpm tsc --noEmit` exits 0
- `pnpm vitest run` shows ≥1670 passing (≥25 new tests across epistemic-gate unit + loop integration)
- `src/core/cognition/epistemic-gate.ts` exists, compiles, exports all required types
- `classifyRationale` matches all tag rules deterministically
- `gateToolCall` matrix produces correct decisions for all 4×4 combinations
- `EpistemicGate.evaluate` never throws
- loop.ts insertion point is BETWEEN line 731 landmark and line 733 landmark only
- REPLAN decision clears validToolCalls and continues outer loop
- UNCERTAIN_RESPONSE injects system message non-blockingly
- Optional DB param: epistemic_log table created if DB provided, silently skipped if absent

---

## 9. Builder Spawn Instructions Template

Include verbatim in every builder spawn:

```
Time budget: ≤15 min, single-pass execution, no exploratory wandering.
Quality is non-negotiable: tsc clean, ≥N tests passing, no `any`, no console.log,
project logger only (createLogger), try/catch around external calls, strict file boundaries.
Skip ceremony, not gates. Report DONE only when ALL quality gates pass.
Report format: "DONE — files: [...] — tsc: 0 errors — vitest: N/N passing"
```

---

## 10. Broadcast Checklist

Before builders start, confirm:
- [x] Builder A and Builder C have read the loop.ts firewall section (Section 2)
- [x] Builder A has read the hash recipe (Section 3.3) and knows `sanitizeArgsForPrompt` returns a string
- [x] Builder C has NOT imported `classifyRisk` from veto-gate.ts
- [x] Builder B has NOT modified veto-override-store.ts (handled entirely by Builder A)
- [x] All builders run `pnpm tsc --noEmit` before declaring DONE
