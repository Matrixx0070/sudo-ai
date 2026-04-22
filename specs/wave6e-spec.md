# Wave 6E — Architecture Spec
**Date:** 2026-04-13
**Baseline:** 1573/1573 vitest, tsc clean, pm2 sudo-ai-v5 online, gateway :18900
**Stack:** TypeScript strict ESM, vitest, better-sqlite3, pnpm
**Target test count:** ≥1600 passing (≥27 net new across 3 primitives)

---

## 1. Wave 6E Scope

Three primitives, all shippable in parallel:

### Primitive A — Discordance 7th Signal (Builder A)
Wire the `discordance-detector.ts` output into `AlignmentAggregator` as a 7th scoring signal. The bridge type `AlignmentAggregatorDiscordanceInput` was exported in Wave 6D for exactly this purpose.

### Primitive B — Veto Manual-Override REST (Builder B)
Add two admin REST endpoints to let the principal manually pre-set APPROVE or DENY for a pending tool-call decision before the veto-gate runs. Requires a new SQLite-backed `VetoOverrideStore`, decisionId generation in loop.ts before the veto for-loop, and an override-check that intercepts before `runVetoGate()`.

### Primitive C — Sleep DEGRADED Consequences (Builder C)
Give `_degraded = true` observable consequences: skip non-critical phases (3 + 5) on the *next* `startSleep()` call, emit a structured warn log at cycle start when degraded, add a public `clearDegraded()` method, and expose a REST reset endpoint in a new `admin-sleep-routes.ts`.

---

## 2. File Boundaries (STRICT — zero overlap)

### Builder A (Senior) — Primitive A
| File | Action |
|------|--------|
| `src/core/agent/alignment-aggregator.ts` | Add `discordanceScore` to `AlignmentSignals`; update `WEIGHTS`; extend `_compute()` |
| `src/core/agent/loop.ts` lines 817–844 | Collect `DiscordanceSignals` + call `detectDiscordance()` before building `AlignmentSignals` |
| `src/core/security/discordance-detector.ts` | READ-ONLY — import `detectDiscordance` and `DiscordanceSignals` only; **no edits** |

Builder A does NOT touch: loop.ts lines 1–816 or 845+, veto-gate.ts, admin-routes.ts, consolidator.ts.

### Builder B (Backend) — Primitive B
| File | Action |
|------|--------|
| `src/core/agent/veto-override-store.ts` | CREATE: new SQLite store |
| `src/core/gateway/admin-routes.ts` | Extend `AdminRoutesDeps`; add 2 new route handlers + registration |
| `src/core/agent/loop.ts` lines 758–810 | Generate `decisionId` per tool call; check override before `runVetoGate()` |
| `src/core/agent/veto-gate.ts` | READ-ONLY — no edits needed; decisionId lives in loop only |

Builder B does NOT touch: alignment-aggregator.ts, loop.ts lines 1–757 or 811+, admin-sleep-routes.ts, consolidator.ts.

**No-touch zone in loop.ts: lines 811–816** (hooks emit block between Builder B and Builder A regions).

### Builder C (Extra) — Primitive C
| File | Action |
|------|--------|
| `src/core/consciousness/sleep-cycle/consolidator.ts` | Add `clearDegraded()` public method; add degraded-check guard at start of `startSleep()` to skip Phases 3 + 5; add structured warn log |
| `src/core/gateway/admin-sleep-routes.ts` | CREATE: new file; `registerAdminSleepRoutes()` with POST /v1/admin/sleep/reset-degraded |

Builder C does NOT touch: admin-routes.ts, alignment-aggregator.ts, loop.ts, veto-override-store.ts, veto-gate.ts.

**Integrator** wires `registerAdminSleepRoutes()` alongside `registerAdminRoutes()` in the gateway bootstrap file (whichever file currently calls `registerAdminRoutes`). Builder C may note the exact bootstrap file location for the Integrator.

---

## 3. Interface Contracts

### 3A — AlignmentSignals extended (Builder A)

```typescript
// alignment-aggregator.ts — updated interface
export interface AlignmentSignals {
  outcomeDelta:      number; // [-1, +1]
  commitmentDrift:   number; // [0, 1]
  trustTier:         number; // [0, 1]
  injectionRate:     number; // [0, 1]
  recoveryPending:   number; // 0 or 1
  reAnchor:          number; // 0 or 1
  /** Cross-stream discordance composite [0, 1]. 0 = fully aligned. New in Wave 6E. */
  discordanceScore:  number;
}
```

### 3A — Weights (MUST sum exactly to 1.0)

| Signal | Old weight | New weight |
|--------|-----------|-----------|
| outcomeDelta | 0.25 | **0.20** |
| commitmentDrift | 0.25 | **0.20** |
| trustTier | 0.20 | **0.15** |
| injectionRate | 0.15 | 0.15 (unchanged) |
| recoveryPending | 0.10 | **0.15** (bumped +0.05 to close sum) |
| reAnchor | 0.05 | 0.05 (unchanged) |
| **discordanceScore** | — | **0.10** (new) |
| **Total** | **1.00** | **1.00** |

Weight contribution in `_compute()`:
```
WEIGHTS.discordanceScore * (1 - resolvedDiscordanceScore)
```
(High discordance → low loyalty contribution — mirrors inverted pattern of `commitmentDrift`.)

`_buildDiagnosis()` must add: if `signals.discordanceScore > 0.6` → push `'cross-stream discordance elevated'`.

### 3A — loop.ts signal collection (lines 817–844)

Before building `AlignmentSignals`, collect and call detectDiscordance:
```typescript
const discordanceResult = detectDiscordance({
  cadence:      { callsInWindow: state.iteration, baselineCallsPerWindow: 10 },
  toolGraph:    { recentToolNames: activeToolCalls.map(tc => tc.name) },
  outcomeTrend: { recentOutcomeTypes: [] },   // future expansion placeholder
  selfReport:   { text: finalText ?? '' },
});
// then add to AlignmentSignals:
discordanceScore: discordanceResult.score,
```

### 3B — VetoOverride record shape

```typescript
// veto-override-store.ts
export interface VetoOverride {
  id:          string;   // UUID / genId()
  decisionId:  string;   // matches the per-tool-call decisionId from loop.ts
  action:      'allow' | 'deny';
  reason:      string;   // ≥20 chars required for CRITICAL-risk context (validated at REST layer)
  createdAt:   string;   // ISO-8601
  createdBy:   string;   // from auth bearer identity or literal 'admin'
}
```

### 3B — SQLite schema

```sql
CREATE TABLE IF NOT EXISTS veto_overrides (
  id          TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  action      TEXT NOT NULL CHECK(action IN ('allow','deny')),
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
```

Use `better-sqlite3` synchronous API. Initialise table in constructor (CREATE TABLE IF NOT EXISTS).

### 3B — VetoOverrideStore public API

```typescript
export class VetoOverrideStore {
  constructor(db: import('better-sqlite3').Database): void

  /** Returns the stored override for this decisionId, or null if absent. */
  getOverride(decisionId: string): VetoOverride | null

  /**
   * Persist a new override. Throws if decisionId already exists.
   * Validates: reason.length ≥ 20 if action is for a CRITICAL context (caller enforces).
   */
  recordOverride(override: Omit<VetoOverride, 'id' | 'createdAt'>): VetoOverride

  /** Return all overrides, newest first. Limit defaults to 100. */
  listOverrides(limit?: number): VetoOverride[]
}
```

### 3B — decisionId in loop.ts (lines 758–810)

Before the veto for-loop (`for (const tc of validToolCalls)`), generate one decisionId per `tc`:
```typescript
const decisionIdMap = new Map<string, string>();
for (const tc of validToolCalls) {
  decisionIdMap.set(tc.id, genId());
}
```
Then inside the loop, before `runVetoGate()`:
```typescript
const decisionId = decisionIdMap.get(tc.id)\!;
const manualOverride = this.vetoOverrideStore?.getOverride(decisionId) ?? null;
if (manualOverride) {
  if (manualOverride.action === 'deny') {
    // block: push system message + add to vetoedIds, continue
  } else {
    // allow: skip runVetoGate(), continue to next tc
  }
}
// else: run existing runVetoGate() logic unchanged
```

`AgentLoopDeps` (or wherever `this.vetoOverrideStore` is injected) must accept `vetoOverrideStore?: VetoOverrideStore`.

### 3B — REST routes (Builder B adds to admin-routes.ts)

**AdminRoutesDeps extension:**
```typescript
export interface AdminRoutesDeps {
  // ... existing fields ...
  vetoOverrideStore?: {
    recordOverride(o: Omit<VetoOverride, 'id' | 'createdAt'>): VetoOverride;
    listOverrides(limit?: number): VetoOverride[];
  };
  auditTrail: {
    verifyChain(): ChainVerifyResult;
    recordTriple(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
  };
}
```

**POST /v1/admin/veto/override**
- Auth: existing `isAuthorised()` bearer check
- Request body:
  ```json
  { "decisionId": "string (required)", "action": "allow|deny (required)", "reason": "string (required)" }
  ```
- Validation:
  - `decisionId`: non-empty string, no path traversal chars (`/`, `..`)
  - `action`: must be `'allow'` or `'deny'`
  - `reason`: required, non-empty string; if `action === 'deny'` reason must be ≥20 chars
- On success: `deps.auditTrail.recordTriple({ mistake: 'veto manual override', learned: reason, commitment: 'override logged', ttl_days: 7 })`
- Response 201: `{ "ok": true, "data": { VetoOverride record } }`
- Response 400: `{ "ok": false, "error": "validation message" }`
- Response 401: existing 401 pattern
- Response 500: `{ "ok": false, "error": "Internal server error" }`

**GET /v1/admin/veto/overrides**
- Auth: existing `isAuthorised()` bearer check
- Query params: `limit` (integer, 1–500, default 100)
- Response 200: `{ "ok": true, "data": { "overrides": VetoOverride[], "count": number } }`

### 3C — SleepCycle.clearDegraded()

New public method in `consolidator.ts`:
```typescript
/**
 * Manually clear the degraded flag.
 * Called by the REST reset endpoint. Safe to call at any time — no-op if not degraded.
 */
clearDegraded(): void {
  if (this._degraded) {
    this._degraded = false;
    log.info({ module: 'sleep-cycle' }, 'Sleep-cycle degraded flag cleared by operator');
  }
}
```

### 3C — Degraded phase-skip guard in startSleep()

Insert immediately after `this._sleeping = true` and `const sessionId = genId()` (around line 222), before Phase 1:
```typescript
const startedDegraded = this._degraded;
if (startedDegraded) {
  log.warn({ degraded: true, sessionId }, 'Sleep-cycle starting in DEGRADED state — Phase 3 (Counterfactuals) and Phase 5 (Dream) will be skipped');
}
```

Then wrap each Phase 3 and Phase 5 dispatch:
```typescript
// Phase 3 — skip when degraded
if (\!startedDegraded) {
  log.debug({ sessionId }, 'Phase 3: Counterfactual Simulation');
  await runPhase3Counterfactuals(this.counterfactualEngine, this.wisdomStore, acc);
  if (this._wakeRequested) { ... }
}

// Phase 5 — skip when degraded
if (\!startedDegraded) {
  log.debug({ sessionId }, 'Phase 5: Dream Generation');
  await runPhase5DreamGeneration(this.brain, acc);
}
```

### 3C — REST: POST /v1/admin/sleep/reset-degraded (admin-sleep-routes.ts)

New file: `src/core/gateway/admin-sleep-routes.ts`

Signature:
```typescript
export interface AdminSleepRoutesDeps {
  sleepCycle: {
    clearDegraded(): void;
    isDegraded(): boolean;
  };
  auditTrail: {
    recordTriple(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
  };
}

export function registerAdminSleepRoutes(
  server: HttpServer,
  deps: AdminSleepRoutesDeps,
  tokenBuf: Buffer | null,
): void
```

Route: `POST /v1/admin/sleep/reset-degraded`
- Auth: same `isAuthorised()` pattern (copy helpers or import from shared)
- No request body required
- Effect: calls `deps.sleepCycle.clearDegraded()` + `deps.auditTrail.recordTriple(...)`
- Response 200: `{ "ok": true, "data": { "wasDegrade": boolean } }`
- Response 401, 500: same patterns

Copy `sendJson`, `sendError`, `isAuthorised`, `extractBearer` inline — do NOT import from admin-routes.ts (avoid circular dep risk).

---

## 4. Risk Classifier — Veto Override Audit Contract

| Condition | Requirement |
|-----------|-------------|
| Any override submitted | `auditTrail.recordTriple()` called immediately |
| `action === 'deny'` | `reason` must be ≥20 chars (validated, 400 if violated) |
| `action === 'allow'` | `reason` must be non-empty (any length) |
| `decisionId` contains `/` or `..` | Reject 400, log.warn traversal attempt |
| `vetoOverrideStore` absent on deps | Route returns 503 `{ ok: false, error: 'Override store not configured' }` |
| Override for already-consumed decisionId | Store throws (UNIQUE constraint); route returns 409 `{ ok: false, error: 'Override already exists for this decisionId' }` |

Every override row is permanent in SQLite — no DELETE endpoint. List endpoint is read-only.

---

## 5. Quality Gates (verbatim from feedback_spawn_agents_faster.md)

1. **tsc clean** — `pnpm tsc --noEmit` MUST exit 0. Zero new TypeScript errors. Never relaxed.
2. **vitest 100% pass** — every existing test still green + every new module tested. Never `.skip` or `.only`.
3. **Coverage thresholds** — new modules ≥60% lines / ≥50% branches (project default). Never lowered.
4. **Security review** — Security Engineer pass required before deploy. Speed does NOT skip this step.
5. **No `any` without justification** — if an `any` is needed, comment why on same line.
6. **No `console.log`** — always project logger (`createLogger`).
7. **No new secrets logged** — no file content logging, no token logging.
8. **Strict file boundaries** — no two builders touch the same file. Architect defines, Lead enforces.
9. **All new exports have explicit return types** — no inferred return for public API.
10. **Error handling at boundaries** — try/catch around every external dependency call (DB, fs, network, sub-modules with throw potential), graceful degrade, log + continue.

---

## 6. Time Budget

**Each builder: ≤15 min wall-clock. Single-pass execution. No exploratory wandering.**

Speed directives (mandatory in every spawn prompt):
- "Do not explore the codebase beyond your assigned files."
- "No second-guessing, no rewrites, no 're-read to verify' cycles."
- "No preamble, no executive summary. Report only: DONE/FAIL, file list, gate results."
- "When `pnpm tsc --noEmit` exits 0 AND `pnpm vitest run` shows ≥1600 passing, immediately reply DONE."

---

## 7. Test Plan

### Builder A — Primitive A (≥9 tests)
| # | Case | Expected |
|---|------|----------|
| A-1 | `discordanceScore: 0` (fully aligned) | does not lower composite score vs baseline |
| A-2 | `discordanceScore: 1` (fully discordant) | weight 0.10 reduces score by exactly 0.10 |
| A-3 | `discordanceScore: NaN` | resolveSignal neutralises to 0.5 — no throw |
| A-4 | `discordanceScore: undefined` | resolveSignal neutralises to 0.5 — no throw |
| A-5 | discordance > 0.6 | diagnosis includes `'cross-stream discordance elevated'` |
| A-6 | discordance ≤ 0.6 | diagnosis does NOT include discordance factor |
| A-7 | All 7 weights sum to 1.0 | assertion: sum of WEIGHTS values === 1.0 |
| A-8 | loop.ts integration: detectDiscordance called before aggregator.evaluate | mock detectDiscordance, verify call |
| A-9 | detectDiscordance throws | aggregator still returns GREEN failedOpen — no crash |

### Builder B — Primitive B (≥10 tests)
| # | Case | Expected |
|---|------|----------|
| B-1 | `recordOverride({action:'allow', reason:'test reason longer than 20 chars'})` | returns VetoOverride with id + createdAt |
| B-2 | `getOverride(unknownDecisionId)` | returns null |
| B-3 | `getOverride(existingDecisionId)` | returns stored record |
| B-4 | Duplicate decisionId | throws (UNIQUE constraint) |
| B-5 | POST /v1/admin/veto/override — valid allow body | 201 + auditTrail called |
| B-6 | POST /v1/admin/veto/override — deny with reason < 20 chars | 400 |
| B-7 | POST /v1/admin/veto/override — missing decisionId | 400 |
| B-8 | POST /v1/admin/veto/override — traversal decisionId `../../etc` | 400 |
| B-9 | GET /v1/admin/veto/overrides — returns list | 200 + count matches |
| B-10 | loop.ts: manual 'deny' override blocks tool without calling runVetoGate | mock vetoOverrideStore + runVetoGate, verify veto gate NOT called |
| B-11 | loop.ts: manual 'allow' override bypasses runVetoGate | runVetoGate NOT called, tool proceeds |
| B-12 | loop.ts: no override → runVetoGate called as before | runVetoGate called exactly once per tc |

### Builder C — Primitive C (≥8 tests)
| # | Case | Expected |
|---|------|----------|
| C-1 | `clearDegraded()` when `_degraded = true` | sets `isDegraded()` to false, log.info emitted |
| C-2 | `clearDegraded()` when already false | no-op, no error |
| C-3 | `startSleep()` when degraded: Phase 3 skipped | `runPhase3Counterfactuals` not called (spy) |
| C-4 | `startSleep()` when degraded: Phase 5 skipped | `runPhase5DreamGeneration` not called (spy) |
| C-5 | `startSleep()` when degraded: warn log with `{degraded:true, sessionId}` emitted | assert log.warn captured |
| C-6 | `startSleep()` when NOT degraded: all 5 phases run | Phase 3 + 5 called (spy) |
| C-7 | POST /v1/admin/sleep/reset-degraded — when degraded | 200, clearDegraded called, auditTrail called |
| C-8 | POST /v1/admin/sleep/reset-degraded — unauthorized | 401 |
| C-9 | Edge: startSleep() degraded + _wakeRequested before Phase 2 | skipped phases never reached, returns partial session |

---

## 8. Acceptance Criteria — DONE Signal per Builder

### Builder A DONE when:
- `AlignmentSignals` has `discordanceScore: number` (no compile error)
- WEIGHTS object has 7 keys summing to exactly 1.0
- `_compute()` includes discordance term
- loop.ts 817–844 calls `detectDiscordance` and passes `.score` into signals
- `pnpm tsc --noEmit` exits 0
- `pnpm vitest run` shows ≥1582 passing (baseline 1573 + ≥9 new)
- Report: DONE, files: alignment-aggregator.ts, loop.ts

### Builder B DONE when:
- `veto-override-store.ts` exists, exports `VetoOverrideStore` + `VetoOverride`
- `admin-routes.ts` registers POST /v1/admin/veto/override + GET /v1/admin/veto/overrides
- loop.ts 758–810 generates decisionId per tc, checks override before veto-gate
- `pnpm tsc --noEmit` exits 0
- `pnpm vitest run` shows ≥1583 passing (baseline 1573 + ≥12 new)
- Report: DONE, files: veto-override-store.ts, admin-routes.ts, loop.ts

### Builder C DONE when:
- `consolidator.ts` has `clearDegraded()` public method
- `startSleep()` emits warn log and skips Phases 3 + 5 when `_degraded === true` at cycle start
- `admin-sleep-routes.ts` exports `registerAdminSleepRoutes` handling POST /v1/admin/sleep/reset-degraded
- `pnpm tsc --noEmit` exits 0
- `pnpm vitest run` shows ≥1582 passing (baseline 1573 + ≥9 new)
- Report: DONE, files: consolidator.ts, admin-sleep-routes.ts

### Combined DONE (Integrator gate):
- `pnpm tsc --noEmit` exits 0 with all three builders' files in place
- `pnpm vitest run` shows ≥1600 passing total
- `registerAdminSleepRoutes` wired in gateway bootstrap alongside existing `registerAdminRoutes`
- `vetoOverrideStore` optionally injected in `AgentLoop` constructor

---

## 9. Design Notes

- `admin-sleep-routes.ts` does NOT import from `admin-routes.ts` — copy auth helpers inline to avoid circular dependency risk and keep the file self-contained.
- `discordance-detector.ts` is read-only for all agents this wave — no edits, only imports.
- `veto-gate.ts` is read-only — decisionId is purely a loop.ts concern.
- The `startedDegraded` snapshot ensures phase-skip decision is stable even if `_runIntegrityCheck()` resets `_degraded = false` mid-cycle.
- `vetoOverrideStore` on `AdminRoutesDeps` is typed as optional (`?:`) to preserve backward-compatibility with existing test setups that construct `AdminRoutesDeps` without it.
