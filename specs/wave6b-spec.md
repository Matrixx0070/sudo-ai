# SUDO-AI v5 Wave 6B — Architect Specification
# Produced: 2026-04-13
# Author: Architect (Sonnet 4.6)

---

## 1. Executive Summary

Wave 6B delivers three parallel builder slices.
Builder A installs a pre-execution adversarial veto gate that classifies tool risk as LOW/MEDIUM/HIGH/CRITICAL via pure rule-based logic, then for risk >= MEDIUM calls model-consensus.ts queryAllModels() for a binding APPROVE/VETO pass, blocking execution on VETO and pushing a system message.
Builder B adds three admin REST endpoints (audit chain verify, inspection queue list/filter, inspection queue status update) behind the existing isAuthorised() Bearer gate, following the manual URL-dispatch pattern in http-api.ts.
Builder C adds a recovery-protocol module that wraps auditTrail.recordTriple() to persist PipelineError failures and load active forward-commitments, then injects a commitment system message into the loop and records recoveries at both PipelineError throw sites.
All three produce no new tsc errors, maintain the 1419-test baseline, gate on >=60% line / >=50% branch coverage on new code.

---

## 2. File Ownership Matrix

| Builder | File | Status |
|---------|------|--------|
| A | /root/sudo-ai-v4/src/core/agent/veto-gate.ts | NEW |
| A | /root/sudo-ai-v4/tests/agent/veto-gate.test.ts | NEW |
| A | /root/sudo-ai-v4/src/core/agent/loop.ts | MODIFY — lines 688-695 region ONLY |
| B | /root/sudo-ai-v4/src/core/gateway/admin-routes.ts | NEW |
| B | /root/sudo-ai-v4/tests/gateway/admin-routes.test.ts | NEW |
| B | /root/sudo-ai-v4/src/core/gateway/http-api.ts | MODIFY — route dispatch block ONLY |
| C | /root/sudo-ai-v4/src/core/agent/recovery-protocol.ts | NEW |
| C | /root/sudo-ai-v4/tests/agent/recovery-protocol.test.ts | NEW |
| C | /root/sudo-ai-v4/src/core/agent/loop.ts | MODIFY — lines 415-420, 612-616, 717-720 regions ONLY |

COLLISION GUARD: Builder A owns loop.ts lines 688-695. Builder C owns loop.ts lines 415-420, 612-616, 717-720.
These are non-overlapping hunks. Integrator verifies with git diff --stat after both builders submit.
No other agent touches loop.ts. No agent touches the same file as another.

---

## 3. Data Models

### 3A — veto-gate.ts (Builder A)

```typescript
// Risk level assigned to a tool call before execution.
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// Input to the veto gate.
export interface VetoInput {
  toolName: string;
  args: Record<string, unknown>;
}

// Result returned by runVetoGate().
export interface VetoResult {
  decision: 'APPROVE' | 'VETO';
  risk: RiskLevel;
  reason: string;
}
```

No new DB tables.

### 3B — admin-routes.ts (Builder B)

No new data models. Consumes existing types:
- `ChainVerifyResult` from `/root/sudo-ai-v4/src/core/security/audit-trail.ts` (re-exported from audit-chain.ts)
- `InspectionQueueEntry`, `QueryFilter`, `InspectionStatus` from `/root/sudo-ai-v4/src/core/security/inspection-queue.ts`

Admin routes dependency interface (duck-typed, no direct import of concrete class):

```typescript
export interface AdminRoutesDeps {
  auditTrail: {
    verifyChain(): ChainVerifyResult;
  };
  inspectionQueue: {
    query(filter?: QueryFilter): InspectionQueueEntry[];
    updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void;
  };
}
```

### 3C — recovery-protocol.ts (Builder C)

```typescript
// Inputs to recordRecovery().
export interface RecoveryRecord {
  mistake: string;
  learned: string;
  commitment: string;
  ttl_days: number;
  resource?: string;
}

// A single active commitment loaded from the audit log.
export interface ActiveCommitment {
  hash: string;         // audit entry id (first 8 chars used as display hash)
  commitment: string;
  expiresAt: number;    // Unix ms
}
```

No new DB tables. Uses existing `audit_log` table via AuditTrail public API only.
The `query({ action: 'commitment' })` path uses `AuditFilter` from audit-trail.ts.

---

## 4. API Contracts

### 4A — veto-gate.ts exports

```typescript
/**
 * Classify risk level from tool name and argument shape.
 * Pure synchronous function — no I/O.
 * Rules (ordered, first match wins):
 *   CRITICAL: toolName matches /delete|drop|rm|wipe|format|shutdown|exec|eval|shell/i
 *             OR args contain 'path' with value containing '..' or starting with '/'
 *   HIGH:     toolName matches /write|create|update|insert|post|put|patch/i
 *             OR args contain keys: 'password', 'token', 'secret', 'key', 'credential'
 *   MEDIUM:   toolName matches /read|get|list|search|fetch|query/i with args.limit > 1000
 *             OR toolName matches /send|email|message|notify|alert/i
 *   LOW:      everything else
 */
export function classifyRisk(toolName: string, args: Record<string, unknown>): RiskLevel;

/**
 * Full veto gate pipeline.
 * For risk LOW: returns { decision: 'APPROVE', risk: 'LOW', reason: 'Low risk — skipping LLM veto pass' }.
 * For risk >= MEDIUM: calls queryAllModels() with a structured prompt and a custom fetcher
 *   that parses each model answer for 'APPROVE' or 'VETO' (case-insensitive, first word wins).
 *   If majority of answers = VETO → decision = 'VETO'.
 *   If all models fail → decision = 'APPROVE' (fail-open, log warning).
 * @param input    Tool call descriptor.
 * @param fetcher  Model fetcher injected for testability (signature matches queryAllModels fetcher param).
 */
export async function runVetoGate(
  input: VetoInput,
  fetcher: (model: string, prompt: string) => Promise<string>,
): Promise<VetoResult>;
```

### 4B — admin-routes.ts exports

```typescript
/**
 * Register admin REST route handlers on the server's 'request' event.
 * Follows the pattern of attachHttpApi — adds a new listener on the same server.
 * Auth: uses the same isAuthorised() logic; caller passes tokenBuf.
 *
 * Routes registered:
 *   GET  /v1/admin/audit/verify
 *   GET  /v1/admin/inspection          (query param: status, limit)
 *   POST /v1/admin/inspection/:id/status
 *
 * @param server    Existing http.Server.
 * @param deps      AuditTrail and InspectionQueue duck-typed instances.
 * @param tokenBuf  Shared token buffer from http-api.ts for auth re-use.
 */
export function registerAdminRoutes(
  server: HttpServer,
  deps: AdminRoutesDeps,
  tokenBuf: Buffer | null,
): void;
```

NOTE: `tokenBuf` is passed in from `attachHttpApi` scope. Builder B must also export a helper or
`attachHttpApi` must be modified to call `registerAdminRoutes`. The wiring point in `http-api.ts`
is AFTER `getTokenBuf()` is called, before the `server.on('request', ...)` block, so `tokenBuf`
is in scope. See Section 5 for exact wiring.

### 4C — recovery-protocol.ts exports

```typescript
/**
 * Persist a recovery triple into the audit log.
 * Thin wrapper around auditTrail.recordTriple().
 * @returns The audit entry ID.
 */
export function recordRecovery(
  auditTrail: { recordTriple(triple: CommitmentTriple): string },
  record: RecoveryRecord,
): string;

/**
 * Load all non-expired commitments from the audit log.
 * Queries audit_log WHERE action='commitment' via auditTrail.query().
 * Parses metadata JSON; silently skips malformed rows (no throw).
 * Filters: timestamp_ms + ttl_days * 86_400_000 > now.
 * ttl_days === 0 means no commitment stored (returns empty for that row).
 * @param auditTrail  AuditTrail instance with query() method.
 * @param now         Current timestamp in ms (default Date.now()). Injected for testability.
 */
export function loadActiveCommitments(
  auditTrail: { query(filter: AuditFilter): AuditEntry[] },
  now?: number,
): ActiveCommitment[];

/**
 * Format active commitments as a system message string.
 * Empty input returns '' (empty string — no message injected).
 * Format:
 *   [ACTIVE COMMITMENTS]
 *   - <id_prefix>: <commitment> (until YYYY-MM-DD)
 *   - ...
 */
export function formatCommitmentSystemMessage(commits: ActiveCommitment[]): string;
```

`CommitmentTriple`, `AuditFilter`, `AuditEntry` imported from `/root/sudo-ai-v4/src/core/security/audit-trail.ts`.

---

## 5. Wiring Points — Exact File:Line Modifications

### 5A — Builder A modifies loop.ts

**Insertion range: AFTER line 688, BEFORE line 695 (the `await executeToolCalls(...)` call)**

Current code at that region (lines 688-695):
```
// line 688: closing brace of identity-anchor try/catch
// line 690-693: Hook: before:tool-call emissions
// line 695: await executeToolCalls(...)
```

Builder A inserts a new block between line 688 and the `before:tool-call` hook loop (lines 690-693).
The actual insertion point is after the closing `}` of the identity-anchor try/catch (line 688)
and before the `// Hook: before:tool-call` comment (line 690).

Pseudocode of what Builder A inserts (exact code in module):
```typescript
// Veto gate: adversarial pre-execution check.
for (const tc of validToolCalls) {
  try {
    const vetoResult = await runVetoGate(
      { toolName: tc.name, args: tc.arguments ?? {} },
      defaultFetcher,  // defined at module top via queryAllModels
    );
    if (vetoResult.decision === 'VETO') {
      const vetoMsg = `[VetoGate] Tool call blocked: ${tc.name} — ${vetoResult.reason}`;
      log.warn({ tool: tc.name, risk: vetoResult.risk, reason: vetoResult.reason, sessionId: state.sessionId }, 'Veto gate blocked tool call');
      session.messages.push({ role: 'system', content: vetoMsg });
      emit({ type: 'error', error: vetoMsg });
      // Remove vetoed tc from validToolCalls by marking; handled after loop
    }
  } catch (err) {
    log.warn({ err: String(err), tool: tc.name }, 'VetoGate threw — proceeding');
  }
}
// Filter out vetoed calls before dispatch
// (Implementation: Builder A collects vetoed tc.id into a Set, filters validToolCalls)
```

Builder A adds these imports at the top of loop.ts:
```typescript
import { runVetoGate } from './veto-gate.js';
import { queryAllModels } from '../brain/model-consensus.js';
```

And defines `defaultFetcher` as a module-level const or inline arrow using `queryAllModels`.

**Builder A MUST NOT touch any lines outside the range 688-695 of loop.ts except the import block at the top of the file.**

### 5B — Builder B modifies http-api.ts

**Insertion point: Line 221 — inside `attachHttpApi()`, after `const tokenBuf = getTokenBuf();` and before `server.on('request', ...)`**

Add one import at top of file:
```typescript
import { registerAdminRoutes } from './admin-routes.js';
```

Add one call inside `attachHttpApi()` after `const tokenBuf = getTokenBuf();`:
```typescript
registerAdminRoutes(server, deps as unknown as import('./admin-routes.js').AdminRoutesDeps, tokenBuf);
```

Note: `deps` in `attachHttpApi` is `HttpApiDeps` which does not carry auditTrail/inspectionQueue.
This means `attachHttpApi`'s signature must be extended OR `registerAdminRoutes` gets a separate
call site. **Correct approach: extend `HttpApiDeps` to optionally carry admin deps:**

```typescript
export interface HttpApiDeps {
  sessionManager: SessionManagerLike;
  agentLoop: AgentLoopLike;
  auditTrail?: { verifyChain(): ChainVerifyResult };
  inspectionQueue?: { query(filter?: QueryFilter): InspectionQueueEntry[]; updateStatus(...): void };
}
```

Inside `attachHttpApi`, after `getTokenBuf()`:
```typescript
if (deps.auditTrail && deps.inspectionQueue) {
  registerAdminRoutes(server, { auditTrail: deps.auditTrail, inspectionQueue: deps.inspectionQueue }, tokenBuf);
}
```

Builder B also needs to add the admin route matching INSIDE the `server.on('request', ...)` block
at the 404 fall-through point (currently line 246). The `registerAdminRoutes` pattern adds its own
`server.on('request', ...)` listener — this is valid since Node.js `http.Server` supports multiple
listeners. The admin listener must call `return` after handling to prevent fall-through to the 404.

**Builder B MUST NOT touch any lines of http-api.ts except: the import block at top, the `HttpApiDeps` interface, and the two-line call inside `attachHttpApi()`.**

### 5C — Builder C modifies loop.ts — THREE non-overlapping hunks

**Hunk 1: After line 415 (after the closing brace of the intelligence-brief injection block)**

After line 415 (`}` closing the `if (briefConsciousness || this.unifiedMemory)` block),
insert a commitment system message injection:

```typescript
// Recovery protocol: inject active forward-commitments as system message.
if (this.auditTrail) {
  try {
    const commits = loadActiveCommitments(this.auditTrail);
    const commitMsg = formatCommitmentSystemMessage(commits);
    if (commitMsg) {
      session.messages.push({ role: 'system', content: commitMsg });
      log.debug({ commitCount: commits.length, sessionId }, 'Active commitments injected');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Recovery protocol commitment injection failed — continuing');
  }
}
```

**Hunk 2: At line 616 (the PipelineError throw for `pipeline_brain_error`)**

Current line 616:
```typescript
throw new PipelineError('Brain returned error finish reason', 'pipeline_brain_error', { sessionId: state.sessionId });
```

Replace with:
```typescript
if (this.auditTrail) {
  try { recordRecovery(this.auditTrail, { mistake: 'Brain returned error finish reason', learned: 'pipeline_brain_error', commitment: 'guard against this failure mode', ttl_days: 30 }); } catch { /* non-fatal */ }
}
throw new PipelineError('Brain returned error finish reason', 'pipeline_brain_error', { sessionId: state.sessionId });
```

**Hunk 3: At line 720 (the PipelineError throw for `pipeline_max_iterations`)**

Current line 720:
```typescript
throw new PipelineError(msg, 'pipeline_max_iterations', { sessionId: state.sessionId, maxIterations });
```

Replace with:
```typescript
if (this.auditTrail) {
  try { recordRecovery(this.auditTrail, { mistake: msg, learned: 'pipeline_max_iterations', commitment: 'guard against this failure mode', ttl_days: 30 }); } catch { /* non-fatal */ }
}
throw new PipelineError(msg, 'pipeline_max_iterations', { sessionId: state.sessionId, maxIterations });
```

**Builder C also modifies the AgentLoop class body (NOT constructor signature change):**

Add a private field to `AgentLoop`:
```typescript
private readonly auditTrail: { recordTriple(triple: CommitmentTriple): string; query(filter: AuditFilter): AuditEntry[] } | null = null;
```

Add internal construction of auditTrail inside the constructor body (after identityLoader block):
```typescript
// Initialise audit trail for recovery protocol — constructed internally like identityLoader.
try {
  const { AuditTrail } = await import('../security/audit-trail.js');
  // AuditTrail constructor requires a db path — skip if DATA_DIR not set.
  const dataDir = process.env['DATA_DIR'];
  if (dataDir) {
    this.auditTrail = new AuditTrail(dataDir);
    log.info('AgentLoop: AuditTrail attached for recovery protocol');
  }
} catch (err) {
  log.warn({ err: String(err) }, 'AgentLoop: AuditTrail init failed — recovery protocol disabled');
}
```

IMPORTANT: Since `constructor` is synchronous and `AuditTrail` constructor in audit-trail.ts is
synchronous (it takes a `dbPath` string), Builder C must check the actual AuditTrail constructor
signature first. If it is synchronous, use direct instantiation (no dynamic import):

```typescript
// At top of loop.ts (Builder C's additions to import block):
import { AuditTrail } from '../security/audit-trail.js';
import { recordRecovery, loadActiveCommitments, formatCommitmentSystemMessage } from './recovery-protocol.js';
import type { CommitmentTriple, AuditFilter, AuditEntry } from '../security/audit-trail.js';
```

And in constructor (synchronous init):
```typescript
try {
  const dataDir = process.env['DATA_DIR'];
  if (dataDir) {
    this.auditTrail = new AuditTrail(dataDir);
    log.info('AgentLoop: AuditTrail attached for recovery protocol');
  }
} catch (err) {
  log.warn({ err: String(err) }, 'AgentLoop: AuditTrail init failed — recovery protocol disabled');
}
```

**Builder C MUST NOT touch lines 688-695 of loop.ts (owned by Builder A).**
**Builder C MUST NOT touch any gateway files.**

---

## 6. Test Acceptance Criteria

### 6A — veto-gate.test.ts (≥10 test cases)

All tests must use an injected mock fetcher (no real LLM calls).

1. `classifyRisk('deleteFile', {})` → CRITICAL
2. `classifyRisk('dropTable', { table: 'users' })` → CRITICAL
3. `classifyRisk('writeFile', { content: 'x' })` → HIGH
4. `classifyRisk('searchMemory', { limit: 5 })` → LOW
5. `classifyRisk('sendEmail', { to: 'a@b.com' })` → MEDIUM
6. `classifyRisk('getUser', { limit: 9999 })` → MEDIUM (limit > 1000)
7. `classifyRisk('fetchProfile', {})` → LOW (read but no large limit)
8. `runVetoGate` with CRITICAL risk, all models return 'VETO' → `{ decision: 'VETO' }`
9. `runVetoGate` with MEDIUM risk, majority models return 'APPROVE' → `{ decision: 'APPROVE' }`
10. `runVetoGate` with LOW risk, fetcher never called → `{ decision: 'APPROVE', risk: 'LOW' }`
11. `runVetoGate` with HIGH risk, all models throw → fail-open `{ decision: 'APPROVE' }` + log warning
12. `classifyRisk('readFile', { path: '../etc/passwd' })` → CRITICAL (path traversal)

### 6B — admin-routes.test.ts (≥8 test cases)

Use in-process `http.createServer` with mock deps (no real DB).

1. `GET /v1/admin/audit/verify` with valid token, verifyChain returns `{ ok: true, rowsChecked: 5 }` → 200 + body
2. `GET /v1/admin/audit/verify` with no token (GATEWAY_TOKEN set) → 401
3. `GET /v1/admin/inspection` with valid token → 200 + array
4. `GET /v1/admin/inspection?status=pending&limit=10` → query called with `{ status: 'pending', limit: 10 }`
5. `POST /v1/admin/inspection/abc123/status` body `{ status: 'cleared', reviewedBy: 'admin' }` → 204
6. `POST /v1/admin/inspection/nonexistent/status` body valid → updateStatus throws → 404
7. `GET /v1/admin/audit/verify`, verifyChain returns `{ ok: false, breakAt: 'id-5', rowsChecked: 5 }` → 200 + body with breakAt
8. `GET /v1/admin/inspection?limit=abc` (non-numeric limit) → query called with default limit (graceful parse)

### 6C — recovery-protocol.test.ts (≥8 test cases)

Use in-memory mock implementing the auditTrail interface.

1. `recordRecovery(mockAudit, { mistake: 'boom', learned: 'phase', commitment: 'fix', ttl_days: 30 })` → returns string id
2. `loadActiveCommitments(emptyAudit)` → returns `[]`
3. `loadActiveCommitments` with one commitment expiring in future → returns 1 entry
4. `loadActiveCommitments` with one commitment already expired → returns `[]`
5. `loadActiveCommitments` with mixed expired + active → returns only active entries
6. `formatCommitmentSystemMessage([])` → returns `''`
7. `formatCommitmentSystemMessage` with 2 commits → returns string starting with `[ACTIVE COMMITMENTS]`
8. `loadActiveCommitments` with malformed metadata_json row → silently skips, returns remaining valid entries
9. `loadActiveCommitments` with ttl_days = 0 → treated as no commitment (skipped)
10. `formatCommitmentSystemMessage` with 1 commit → includes correct YYYY-MM-DD date for expiresAt

---

## 7. Risks and Mitigations

1. **Risk: Builder A and C collide on loop.ts**
   Mitigation: Architect-assigned line ranges are non-overlapping. Integrator runs `git diff --stat` after both submit; any overlap triggers swarm rescue before merge.

2. **Risk: queryAllModels() in veto gate adds >2s latency to every MEDIUM+ tool call**
   Mitigation: Builder A implements a 3-second timeout on the fetcher per model using `Promise.race` with `setTimeout`. If timeout fires, that model's answer is treated as APPROVE (fail-open). Total gate budget: 3s max.

3. **Risk: AuditTrail constructor in loop.ts silently fails if DATA_DIR unset, leaving recovery protocol disabled in tests**
   Mitigation: recovery-protocol.ts functions accept duck-typed interfaces, so tests inject mocks directly. Integration with loop.ts is exercised only in integration tests, not unit tests. No unit test should depend on DATA_DIR.

4. **Risk: Admin routes expose internal errors via JSON body**
   Mitigation: All route handlers must catch all errors and return generic `{ error: 'Internal server error' }` with status 500. Only `verifyChain` and `query` results are passed through directly.

5. **Risk: POST /v1/admin/inspection/:id/status body parse failure**
   Mitigation: Builder B wraps JSON.parse in try/catch, returns 400 with message 'Invalid request body' on failure. `updateStatus` id not found: catch the error or check return — map to 404.

---

## 8. TSC + Vitest Baseline Expectations

- Pre-Wave-6B baseline: **1419/1419 tests passing, tsc clean** (from Scout briefing)
- After Wave 6B: **1419 + new tests passing** (target: +28 minimum across all three builders)
- tsc: `tsc --noEmit` must exit 0. Run from `/root/sudo-ai-v4/`.
- vitest coverage thresholds (new files only): ≥60% line, ≥50% branch.
- No `console.log` — use `createLogger(...)` from `../shared/logger.js`.
- No `any` without `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + inline justification comment.
- All public exports carry explicit return types.
- All external boundary calls (LLM, DB) are wrapped in try/catch.

---

## 9. Builder Kickoff Prompts

### BUILDER A KICKOFF — Copy-paste ready

```
You are Senior Builder A.
Project: SUDO-AI v5 Wave 6B — Pre-execution adversarial veto gate.
Stack: TypeScript ESM, tsx, vitest, pnpm. Working directory: /root/sudo-ai-v4.

YOUR FILE BOUNDARIES (no other agent touches these):
  NEW: /root/sudo-ai-v4/src/core/agent/veto-gate.ts
  NEW: /root/sudo-ai-v4/tests/agent/veto-gate.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/agent/loop.ts — lines 688-695 region + import block ONLY

SPEC (verbatim — implement exactly):

veto-gate.ts must export:
  export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  export interface VetoInput { toolName: string; args: Record<string, unknown>; }
  export interface VetoResult { decision: 'APPROVE' | 'VETO'; risk: RiskLevel; reason: string; }
  export function classifyRisk(toolName: string, args: Record<string, unknown>): RiskLevel
  export async function runVetoGate(input: VetoInput, fetcher: (model: string, prompt: string) => Promise<string>): Promise<VetoResult>

classifyRisk rules (first match wins):
  CRITICAL: toolName matches /delete|drop|rm|wipe|format|shutdown|exec|eval|shell/i
            OR args has 'path' key where value is string containing '..' or starting with '/'
  HIGH:     toolName matches /write|create|update|insert|post|put|patch/i
            OR args has key 'password'|'token'|'secret'|'key'|'credential'
  MEDIUM:   toolName matches /read|get|list|search|fetch|query/i AND typeof args.limit === 'number' AND args.limit > 1000
            OR toolName matches /send|email|message|notify|alert/i
  LOW:      everything else

runVetoGate:
  - For risk=LOW: return { decision: 'APPROVE', risk: 'LOW', reason: 'Low risk — skipping LLM veto pass' }
  - For risk >= MEDIUM: call queryAllModels() from '../brain/model-consensus.js' with the passed fetcher.
    Prompt: "You are a security gate. Assess this tool call. Tool: {toolName}. Args: {JSON.stringify(args, null, 2)}. Risk level: {risk}. Respond with exactly one word: APPROVE or VETO, followed by a reason."
    Parse each model answer: first word (case-insensitive). If 'veto' → VETO vote. Count VETO votes.
    If VETO votes > APPROVE votes → decision=VETO.
    If all models fail (queryAllModels throws) → fail-open: decision=APPROVE, log warn.
    reason = bestAnswer.content from ConsensusResult.
  - Each model call has a 3-second timeout: wrap fetcher in Promise.race with setTimeout APPROVE fallback per model.

loop.ts modifications (ONLY these two changes):
  1. Add at import block top: import { runVetoGate } from './veto-gate.js';
  2. After the closing } of the identity-anchor try/catch (after line 688, before the // Hook: before:tool-call comment):
     Insert veto gate loop that:
     - Creates a vetoedIds = new Set<string>()
     - For each tc in validToolCalls: await runVetoGate({toolName: tc.name, args: tc.arguments ?? {}}, defaultFetcher)
       where defaultFetcher = async (model, prompt) => { const r = await queryAllModels(prompt, async (_m, p) => p); return r.bestAnswer.content; }
       Actually: defaultFetcher should call the real model. Since we cannot make real LLM calls in unit tests,
       the fetcher is injected via a module-level variable that defaults to a real implementation.
       Use this pattern: let _vetoFetcher: ((model: string, prompt: string) => Promise<string>) | null = null;
       export function setVetoFetcher(f: typeof _vetoFetcher) { _vetoFetcher = f; }  (in veto-gate.ts)
       In runVetoGate: if no fetcher passed, use _vetoFetcher ?? defaultRealFetcher.
       In loop.ts: pass undefined as fetcher (veto-gate uses its internal default).
     - If vetoResult.decision === 'VETO': add tc.id to vetoedIds, push system message, emit error event
     - After loop: filter validToolCalls = validToolCalls.filter(tc => \!vetoedIds.has(tc.id))
     - If validToolCalls becomes empty after veto: push assistant message explaining all calls were vetoed, break inner loop iteration

QUALITY GATES (non-negotiable):
  - tsc --noEmit exits 0
  - All tests pass (pnpm test)
  - ≥10 test cases in veto-gate.test.ts covering all cases in Section 6A of spec
  - No console.log — use createLogger('agent:veto-gate')
  - No any without inline comment
  - Explicit return types on all exported functions
  - try/catch around runVetoGate call in loop.ts (non-fatal on throw)

TIME BUDGET: ≤15 minutes.

If stuck: describe the exact error and I will send a SWARM rescue team.
When done: report back with file list, test count, tsc status.
```

---

### BUILDER B KICKOFF — Copy-paste ready

```
You are Senior Builder B.
Project: SUDO-AI v5 Wave 6B — Admin REST routes.
Stack: TypeScript ESM, tsx, vitest, pnpm. Working directory: /root/sudo-ai-v4.

YOUR FILE BOUNDARIES (no other agent touches these):
  NEW: /root/sudo-ai-v4/src/core/gateway/admin-routes.ts
  NEW: /root/sudo-ai-v4/tests/gateway/admin-routes.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/gateway/http-api.ts — import block + HttpApiDeps interface + one call inside attachHttpApi() ONLY

SCOUT BRIEFING (ground truth):
  Gateway: raw Node HTTP, no framework, manual URL dispatch in http-api.ts.
  Auth: timing-safe Bearer at http-api.ts:75 via GATEWAY_TOKEN env. isAuthorised() is a private function.
  HttpApiDeps interface is at line ~37. attachHttpApi() is at line ~221.
  Existing pattern: registerVaultCredentialRoutes adds a separate server.on('request',...) listener.

SPEC:

admin-routes.ts must export:
  export interface AdminRoutesDeps {
    auditTrail: { verifyChain(): ChainVerifyResult };
    inspectionQueue: {
      query(filter?: QueryFilter): InspectionQueueEntry[];
      updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void;
    };
  }
  export function registerAdminRoutes(server: HttpServer, deps: AdminRoutesDeps, tokenBuf: Buffer | null): void

Import types from:
  ChainVerifyResult → import type { ChainVerifyResult } from '../security/audit-trail.js'
  QueryFilter, InspectionQueueEntry, InspectionStatus → import type { ... } from '../security/inspection-queue.js'

registerAdminRoutes adds a server.on('request', ...) listener. Inside, re-implement isAuthorised inline
(timing-safe compare using timingSafeEqual from node:crypto, same logic as http-api.ts:75-79).

Routes:
  GET /v1/admin/audit/verify
    → call deps.auditTrail.verifyChain()
    → respond 200 JSON: { ok: boolean, breakAt?: string, rowsChecked: number }
    → wrap in try/catch → 500 on error

  GET /v1/admin/inspection (query params: status, limit)
    → parse status from url query string (optional, one of InspectionStatus values)
    → parse limit as integer (optional, default 50, NaN → default)
    → call deps.inspectionQueue.query({ status, limit })
    → respond 200 JSON: array of InspectionQueueEntry
    → wrap in try/catch → 500 on error

  POST /v1/admin/inspection/:id/status
    → extract :id from pathname using regex match on /^\/v1\/admin\/inspection\/([^/]+)\/status$/
    → read body (same readBody pattern as http-api.ts — copy the helper or re-implement inline)
    → parse JSON: { status: InspectionStatus, reviewedBy?: string }
    → validate status is one of ['pending','reviewed','cleared','blocked'] → 400 if invalid
    → call deps.inspectionQueue.updateStatus(id, status, reviewedBy)
    → respond 204 (no body)
    → if updateStatus throws → catch → respond 404 JSON { error: 'Entry not found or update failed' }

  Any non-matching /v1/admin/* path → 404

http-api.ts modifications (ONLY these):
  1. Add import: import { registerAdminRoutes } from './admin-routes.js';
  2. Extend HttpApiDeps interface (add two optional fields):
       auditTrail?: { verifyChain(): ChainVerifyResult };
       inspectionQueue?: { query(filter?: QueryFilter): InspectionQueueEntry[]; updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void };
  3. Inside attachHttpApi(), after const tokenBuf = getTokenBuf(); line, add:
       if (deps.auditTrail && deps.inspectionQueue) {
         registerAdminRoutes(server, { auditTrail: deps.auditTrail, inspectionQueue: deps.inspectionQueue }, tokenBuf);
       }
  4. Add type imports needed for the HttpApiDeps extension at the top of http-api.ts.

QUALITY GATES:
  - tsc --noEmit exits 0
  - All tests pass (pnpm test)
  - ≥8 test cases in admin-routes.test.ts covering all cases in Section 6B of spec
  - Tests must use Node's http.createServer with mock deps (no real SQLite)
  - No console.log — use createLogger('gateway:admin-routes')
  - No any without inline comment
  - Explicit return types on all exported functions
  - All route handlers wrapped in try/catch

TIME BUDGET: ≤15 minutes.

If stuck: describe the exact error and I will send a SWARM rescue team.
When done: report back with file list, test count, tsc status.
```

---

### BUILDER C KICKOFF — Copy-paste ready

```
You are Senior Builder C.
Project: SUDO-AI v5 Wave 6B — Recovery protocol with forward-constraint injection.
Stack: TypeScript ESM, tsx, vitest, pnpm. Working directory: /root/sudo-ai-v4.

YOUR FILE BOUNDARIES (no other agent touches these):
  NEW: /root/sudo-ai-v4/src/core/agent/recovery-protocol.ts
  NEW: /root/sudo-ai-v4/tests/agent/recovery-protocol.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/agent/loop.ts — THREE HUNKS ONLY:
    Hunk 1: after line 415 (after intelligence-brief injection block close brace)
    Hunk 2: at line 616 (PipelineError pipeline_brain_error throw site)
    Hunk 3: at line 720 (PipelineError pipeline_max_iterations throw site)
    ALSO: constructor body (add private field + AuditTrail init) + import block additions
  DO NOT TOUCH lines 688-695 of loop.ts (owned by Builder A)

SCOUT BRIEFING (ground truth):
  AUDIT-TRAIL.TS:359 recordTriple(triple) → string id. CommitmentTriple type at audit-chain.ts:40-50.
  AuditTrail.query(filter) returns AuditEntry[]. filter supports: action?: string, limit?: number.
  audit_log table columns: id, timestamp, actor, action, resource, outcome, metadata_json.
  AuditTrail constructor is synchronous — takes a dbPath string.
  loop.ts line 415: closing } of intelligence-brief injection block.
  loop.ts line 616: throw new PipelineError('Brain returned error finish reason', 'pipeline_brain_error', ...)
  loop.ts line 720: throw new PipelineError(msg, 'pipeline_max_iterations', ...)
  AgentLoop constructor currently initialises identityLoader internally at end of constructor body.

SPEC:

recovery-protocol.ts must export:
  export interface RecoveryRecord {
    mistake: string; learned: string; commitment: string; ttl_days: number; resource?: string;
  }
  export interface ActiveCommitment {
    hash: string; commitment: string; expiresAt: number; // Unix ms
  }
  export function recordRecovery(
    auditTrail: { recordTriple(triple: CommitmentTriple): string },
    record: RecoveryRecord,
  ): string
  export function loadActiveCommitments(
    auditTrail: { query(filter: AuditFilter): AuditEntry[] },
    now?: number,
  ): ActiveCommitment[]
  export function formatCommitmentSystemMessage(commits: ActiveCommitment[]): string

Import types from /root/sudo-ai-v4/src/core/security/audit-trail.ts:
  import type { CommitmentTriple, AuditFilter, AuditEntry } from '../security/audit-trail.js';

loadActiveCommitments implementation:
  - Call auditTrail.query({ action: 'commitment', limit: 200 })
  - For each entry: parse entry.metadata as { mistake, learned, commitment, ttl_days }
  - Skip silently (no throw) if metadata is null/undefined/malformed
  - Skip if ttl_days === 0 or ttl_days is not a positive number
  - expiresAt = new Date(entry.timestamp\!).getTime() + ttl_days * 86_400_000
  - Filter: expiresAt > now
  - hash = entry.id ?? ''  (full id — display will slice to 8 chars)
  - Return ActiveCommitment[]

formatCommitmentSystemMessage:
  - If commits.length === 0 return ''
  - Header: '[ACTIVE COMMITMENTS]'
  - Each line: '- ' + commit.hash.slice(0, 8) + ': ' + commit.commitment + ' (until ' + new Date(commit.expiresAt).toISOString().slice(0,10) + ')'
  - Join with '\n'

loop.ts modifications:

ADD TO IMPORT BLOCK (top of file):
  import { AuditTrail } from '../security/audit-trail.js';
  import type { CommitmentTriple, AuditFilter, AuditEntry } from '../security/audit-trail.js';
  import { recordRecovery, loadActiveCommitments, formatCommitmentSystemMessage } from './recovery-protocol.js';

ADD PRIVATE FIELD to AgentLoop class (after identityLoader field declaration):
  private readonly auditTrail: AuditTrail | null = null;

ADD TO CONSTRUCTOR BODY (after identityLoader init block, ~line 229):
  try {
    const dataDir = process.env['DATA_DIR'];
    if (dataDir) {
      (this as { auditTrail: AuditTrail | null }).auditTrail = new AuditTrail(path.join(dataDir, 'audit.db'));
      log.info('AgentLoop: AuditTrail attached for recovery protocol');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'AgentLoop: AuditTrail init failed — recovery protocol disabled');
  }
  Note: since auditTrail is readonly, assign via cast or declare without readonly: use
  private auditTrail: AuditTrail | null = null; (mutable private, assigned in constructor body normally)

HUNK 1 — After line 415, insert (non-fatal block):
  // Recovery protocol: inject active forward-commitments as system context.
  if (this.auditTrail) {
    try {
      const commits = loadActiveCommitments(this.auditTrail);
      const commitMsg = formatCommitmentSystemMessage(commits);
      if (commitMsg) {
        session.messages.push({ role: 'system', content: commitMsg });
        log.debug({ commitCount: commits.length, sessionId }, 'Active commitments injected');
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Recovery protocol commitment injection failed — continuing');
    }
  }

HUNK 2 — Before line 616 throw (insert before the throw, keep the throw):
  if (this.auditTrail) {
    try {
      recordRecovery(this.auditTrail, { mistake: 'Brain returned error finish reason', learned: 'pipeline_brain_error', commitment: 'guard against this failure mode', ttl_days: 30 });
    } catch { /* non-fatal */ }
  }

HUNK 3 — Before line 720 throw (insert before the throw, keep the throw):
  if (this.auditTrail) {
    try {
      recordRecovery(this.auditTrail, { mistake: msg, learned: 'pipeline_max_iterations', commitment: 'guard against this failure mode', ttl_days: 30 });
    } catch { /* non-fatal */ }
  }

QUALITY GATES:
  - tsc --noEmit exits 0
  - All tests pass (pnpm test)
  - ≥8 test cases in recovery-protocol.test.ts covering all cases in Section 6C
  - Tests use mock auditTrail objects — no real SQLite, no DATA_DIR dependency
  - No console.log — use createLogger('agent:recovery-protocol')
  - No any without inline comment
  - Explicit return types on all exported functions
  - All external boundary calls wrapped in try/catch

TIME BUDGET: ≤15 minutes.

If stuck: describe the exact error and I will send a SWARM rescue team.
When done: report back with file list, test count, tsc status.
```

---

## 10. Integration Verification Checklist (Integrator Step 4)

After all three builders submit:

1. `tsc --noEmit` from `/root/sudo-ai-v4/` exits 0.
2. `pnpm test` exits 0 with ≥1447 tests passing (1419 baseline + ≥28 new).
3. `git diff --stat HEAD` shows ONLY the files in the ownership matrix above.
4. Verify loop.ts hunks do not overlap: Builder A range (688-695 + import), Builder C ranges (415, 616, 720 + import + constructor) are all disjoint.
5. Verify admin-routes.ts test uses mock deps and makes no real DB calls.
6. Verify veto-gate.ts test uses injected mock fetcher and makes no real LLM calls.
7. Verify no `console.log` in any new or modified file: `grep -rn 'console\.log' src/core/agent/veto-gate.ts src/core/gateway/admin-routes.ts src/core/agent/recovery-protocol.ts`

