# Wave 13 Architect Spec — SkillOptimizer + 4th Eval Condition
**Date:** 2026-04-17
**Architect:** Claude Sonnet 4.6 (Architect role)
**Status:** FINAL — broadcast to all builders before starting

---

## 0. Executive Summary

Wave 13 ships one new module (`src/core/skills/skill-optimizer.ts`), one new SQLite store
(`SkillOptimizationStore` at `data/skill-optimizations.db`), three new REST endpoints
(`GET /v1/admin/skills/optimizations`, `POST /v1/admin/skills/optimizations/:id/approve`,
`POST /v1/admin/skills/optimizations/:id/reject`), a 4th SkillCondition
(`skills_post_optimizer`), and all sleep-cycle/CLI wiring to make it live.

**Critical prerequisite (confirmed by grep):** `SkillDiscovery` and `AgentConfigEvolver` are
defined in `src/core/learning/` but are NOT instantiated anywhere in `src/cli.ts` today. The
SleepCycle constructor at cli.ts:830-848 does not pass `skillDiscovery` or
`agentConfigEvolver`. Builder 1 must wire both instances into cli.ts in the same wave to give
SkillOptimizer a live data source. Without this, the optimizer runs with zero patterns and
produces no proposals.

---

## 1. SkillOptimizer Module

### File
`/root/sudo-ai-v4/src/core/skills/skill-optimizer.ts` (new)

### Class Signature

```typescript
export class SkillOptimizer {
  constructor(
    skillDiscovery: SkillDiscoveryLike,
    mistakePatternRecognizer: MistakePatternRecognizerLike | undefined,
    confidenceCalibrationTracker: ConfidenceCalibrationTrackerLike | undefined,
    store: SkillOptimizationStore,
    registry: SkillRegistryLike,
  ) {}

  /**
   * Primary entry point called from sleep-cycle post-SkillDiscovery-mine.
   * Returns at most MAX_PROPOSALS_PER_CYCLE (5) proposals.
   * Cap is enforced internally — caller does not need to cap.
   */
  propose(): SkillOptimizationProposal[];

  /** Return pending proposals for REST/bench consumption. */
  listPending(): SkillOptimizationProposal[];

  /** Return latest approved proposal for a specific skill (used by 4th bench condition). */
  getApprovedForSkill(skillId: string): SkillOptimizationProposal | null;
}
```

### Duck-typed interfaces (defined at top of skill-optimizer.ts, NOT imported from anywhere else)

```typescript
interface SkillDiscoveryLike {
  mine(windowMs?: number): Array<{
    id: string;
    toolSequence: string[];
    occurrenceCount: number;
    successRate: number;
    proposalGenerated: boolean;
  }>;
}

interface MistakePatternRecognizerLike {
  analyze(opts?: { windowDays?: number; minOccurrences?: number }): {
    recurringPatterns: Array<{ signature: string; occurrences: number; tags: string[] }>;
  };
}

interface ConfidenceCalibrationTrackerLike {
  getReport(opts?: { windowDays?: number }): {
    brierScore: number;
    totalSamples: number;
  };
}

interface SkillRegistryLike {
  listAll(): Array<{ id: string; name: string; description: string; version: string }>;
}
```

### Signal Sources and Data Flow

SkillOptimizer reads three signals to score and propose optimization targets:

1. **SkillDiscovery.mine(24h)** — TracePattern list. A skill named in a high-frequency
   tool sequence with low success rate is a candidate for description or example refinement.
2. **MistakePatternRecognizer.analyze({ windowDays: 30, minOccurrences: 2 })** — recurring
   mistake patterns. Patterns whose `signature` or `tags` contain a skill name weight the
   confidence score down (candidate for prompt improvements).
3. **ConfidenceCalibrationTracker.getReport({ windowDays: 30 })** — Brier score.
   A high Brier score (> 0.35) adjusts the `confidence` field downward on all proposals in
   this cycle, signalling overall uncertainty in the current config.

### Boundary vs skill.refine — EXPLICIT DECISION

**SkillOptimizer does NOT invoke skill.refine. They consume overlapping data at different
aggregation levels.**

- `skill.refine` (Wave 9, `src/core/tools/builtin/skill/tools/refine.ts`): interactive tool
  call, queries `audit.db` raw `commitment` rows filtered by `toolName`, returns immediate
  RefinementProposal with patch hints to the calling agent. Lifecycle: synchronous,
  session-scoped, driven by explicit agent invocation.
- `SkillOptimizer`: sleep-cycle-driven, reads aggregated outputs (mined TracePatterns,
  analyzed mistake patterns, calibration Brier score), persists SQLite proposals, awaits human
  approval via REST. Lifecycle: asynchronous, system-scoped, driven by sleep cycle.

**Security reviewer gate:** verify that `skill-optimizer.ts` contains zero imports from
`tools/builtin/skill/tools/refine.ts` and zero calls to `queryMistakePatterns()`.

### propose() Algorithm

```
1. Call skillDiscovery.mine(86_400_000)    -> patterns: TracePattern[]
2. Call registry.listAll()                 -> skills: SkillMeta[]
3. If mistakePatternRecognizer present:
     analyze({ windowDays: 30, minOccurrences: 2 })
4. If confidenceCalibrationTracker present:
     getReport({ windowDays: 30 })
5. For each skill in skills:
     a. Find patterns where toolSequence includes skill.name (fuzzy match on id or name substring)
     b. Compute candidate score:
          base           = pattern.occurrenceCount  (higher = more used = worth optimizing)
          successPenalty = (1 - pattern.successRate) * 2  (higher = worse skill)
          mistakePenalty = matchingMistakePatterns.length * 0.1
          rawScore       = base * successPenalty - mistakePenalty
          brierAdjust    = brierScore > 0.35 ? (brierScore - 0.35) * -0.5 : 0
          confidence     = clamp(0.5 + rawScore * 0.05 + brierAdjust, 0.1, 0.99)
     c. If confidence < 0.3 or no patterns match this skill: skip
     d. Build SkillOptimizationProposal (see type below)
6. Sort candidates by confidence desc
7. Cap at MAX_PROPOSALS_PER_CYCLE (= 5) — log.warn if candidates.length > 5
8. Persist each to SkillOptimizationStore (try/catch per save, fail-open per proposal)
9. Return capped array
```

### Output Type — SkillOptimizationProposal

Defined by Builder 2 in `src/core/shared/wave10-types.ts` (Builder 1 imports from there):

```typescript
export type SkillOptimizationStatus = 'pending' | 'approved' | 'rejected';

export interface SkillOptimizationProposal {
  /** UUID */
  id: string;
  /** Target skill id from SkillRegistry */
  skillId: string;
  /** Human-readable skill name for display */
  skillName: string;
  /** Which frontmatter field to optimize */
  targetField: 'description' | 'examples' | 'tags';
  /** Current value (string serialization of the field) */
  currentValue: string;
  /** Proposed replacement value */
  proposedValue: string;
  /** Human-readable evidence / rationale */
  evidence: string;
  /** Confidence score 0..1 */
  confidence: number;
  /** Lifecycle status */
  status: SkillOptimizationStatus;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-modified timestamp */
  updatedAt: string;
}
```

---

## 2. Storage — SkillOptimizationStore (new, separate DB)

**Decision: new store, NOT extending ProposalStore.**

Rationale: ProposalStore's schema models agent-wide config deltas (`delta_json:
Record<string,unknown>`), is agent-centric (`agent_id` PK), and has 4 statuses including
`applied`. SkillOptimizationProposal models per-field skill patches
(`targetField`/`currentValue`/`proposedValue`), is skill-centric (`skill_id`), and has only 3
statuses (no `applied`). Adding a `kind` discriminator to ProposalStore creates coupling that
confuses the approval UI and the 4th bench condition. Separate store is correct.

**DB path:** `data/skill-optimizations.db`
**File:** `src/core/skills/skill-optimization-store.ts` (new, owned by Builder 1)

### Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;

CREATE TABLE IF NOT EXISTS skill_optimizations (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  skill_name      TEXT NOT NULL,
  target_field    TEXT NOT NULL CHECK (target_field IN ('description','examples','tags')),
  current_value   TEXT NOT NULL DEFAULT '',
  proposed_value  TEXT NOT NULL DEFAULT '',
  evidence        TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_so_status    ON skill_optimizations(status);
CREATE INDEX IF NOT EXISTS idx_so_skill_id  ON skill_optimizations(skill_id);
CREATE INDEX IF NOT EXISTS idx_so_created   ON skill_optimizations(created_at DESC);
```

### SkillOptimizationStore Public API

```typescript
export class SkillOptimizationStore {
  constructor(dbPath?: string)  // default: 'data/skill-optimizations.db'

  save(proposal: SkillOptimizationProposal): SkillOptimizationProposal
  list(filter: {
    status?: SkillOptimizationStatus;
    limit: number;
    offset: number;
  }): { data: SkillOptimizationProposal[]; total: number }
  getById(id: string): SkillOptimizationProposal | null
  getLatestApprovedForSkill(skillId: string): SkillOptimizationProposal | null
  approve(id: string): SkillOptimizationProposal
  reject(id: string, reason?: string): SkillOptimizationProposal
  close(): void
}
```

Every method body: wrap DB calls in try/catch per Wave 11 lesson 4. `save()` catches
duplicate-id inserts silently (idempotent on re-run).

---

## 3. REST Endpoints

**Route file to edit: `/root/sudo-ai-v4/src/core/gateway/admin-routes.ts`**

This file is owned exclusively by Builder 1.

Add to `AdminRoutesDeps` interface (after the `alignmentAutoRemediator` block, ~line 208):

```typescript
/** Optional — if absent, skill optimization endpoints return 503. Wave 13. */
skillOptimizationStore?: {
  list(filter: {
    status?: SkillOptimizationStatus;
    limit: number;
    offset: number;
  }): { data: SkillOptimizationProposal[]; total: number };
  approve(id: string): SkillOptimizationProposal;
  reject(id: string, reason?: string): SkillOptimizationProposal;
  getById(id: string): SkillOptimizationProposal | null;
};
```

Import `SkillOptimizationProposal` and `SkillOptimizationStatus` from `'../shared/wave10-types.js'`
at the top of admin-routes.ts (after Builder 2 lands wave10-types.ts at GATE-0).

### GET /v1/admin/skills/optimizations

- Auth: timing-safe Bearer (existing `isAuthorised()` helper — no changes)
- Query params: `status` (optional: `pending|approved|rejected`), `limit` (default 20, max
  100), `offset` (default 0)
- Response 200:

```json
{
  "ok": true,
  "data": [ /* SkillOptimizationProposal[] */ ],
  "total": 7,
  "limit": 20,
  "offset": 0
}
```

- Response 503 if `skillOptimizationStore` absent:
  `{ "ok": false, "error": "SkillOptimizer not initialised" }`

### POST /v1/admin/skills/optimizations/:id/approve

- Auth: timing-safe Bearer
- Body: ignored
- Response 200: `{ "ok": true, "data": SkillOptimizationProposal }`
- Response 404: `{ "ok": false, "error": "Proposal not found" }`
- Response 503: store absent

### POST /v1/admin/skills/optimizations/:id/reject

- Auth: timing-safe Bearer
- Body (optional JSON): `{ "reason": "string" }`
- Response 200: `{ "ok": true, "data": SkillOptimizationProposal }`
- Response 404: `{ "ok": false, "error": "Proposal not found" }`
- Response 503: store absent

Update the route log string in `registerAdminRoutes()` (last line of the function) to append:
`, GET /v1/admin/skills/optimizations, POST /v1/admin/skills/optimizations/:id/approve, POST /v1/admin/skills/optimizations/:id/reject`

---

## 4. Sleep-Cycle Integration

### Part A — consolidator.ts (Builder 1)

**File:** `/root/sudo-ai-v4/src/core/consciousness/sleep-cycle/consolidator.ts`
(851 lines total)

**Edit A — add new duck-typed interface at line 189 (after AgentConfigEvolverLike block closes
at line 188):**

```typescript
// Duck-typed SkillOptimizer interface — avoids hard dep on concrete class. Wave 13.
interface SkillOptimizerLike {
  propose(): unknown[];
}
```

**Edit B — add private field near line 304 (after `agentConfigEvolver` field ~line 304):**

```typescript
private readonly skillOptimizer: SkillOptimizerLike | undefined;
```

**Edit C — add constructor option after line 323 (after `agentConfigEvolver?: AgentConfigEvolverLike`):**

```typescript
skillOptimizer?: SkillOptimizerLike;
```

**Edit D — add assignment after line 354 (after `this.agentConfigEvolver = opts.agentConfigEvolver`):**

```typescript
this.skillOptimizer = opts.skillOptimizer;
```

**Edit E — insert new hook block AFTER the SkillDiscovery hook block (which ends ~line 636),
BEFORE the AgentConfigEvolver emit hook (which begins ~line 638):**

```typescript
// SkillOptimizer hook — generates skill optimization proposals during sleep. Wave 13. Fail-open.
if (this.skillOptimizer) {
  try {
    const proposals = this.skillOptimizer.propose();
    log.debug(
      { event: 'skill.optimizer.proposed', proposalCount: proposals.length },
      'SkillOptimizer.propose() completed in sleep cycle',
    );
  } catch (err: unknown) {
    log.warn(
      { err, event: 'skill.optimizer.error' },
      'SkillOptimizer.propose() threw — skipping (fail-open)',
    );
  }
}
```

**Post-Phase-5 hook execution order (final):**
CommitmentAuditor -> MistakePatternRecognizer -> CrossSignalDiagnostics -> ReAnchorMonitor ->
SkillDiscovery.mine -> **SkillOptimizer.propose** -> AgentConfigEvolver.emit -> PeerAuditTailPull

### Part B — cli.ts (Builder 1)

**File:** `/root/sudo-ai-v4/src/cli.ts` (2000 lines total)

**Edit 1 — new imports after line 81 (after `import { scoreComplexity ... }`):**

```typescript
import { SkillDiscovery } from './core/learning/skill-discovery.js';
import { AgentConfigEvolver } from './core/learning/agent-config-evolver.js';
import { SkillOptimizer } from './core/skills/skill-optimizer.js';
import { SkillOptimizationStore } from './core/skills/skill-optimization-store.js';
```

**Edit 2 — new init block inserted directly after the ProposalStore init block (~line 1768,
inside the `try` block for Wave 10 store init):**

```typescript
let wave13SkillDiscovery: SkillDiscovery | undefined;
let wave13AgentConfigEvolver: AgentConfigEvolver | undefined;
let wave13SkillOptimizer: SkillOptimizer | undefined;
let wave13SkillOptimizationStore: SkillOptimizationStore | undefined;
try {
  wave13SkillDiscovery = new SkillDiscovery();
  wave13SkillOptimizationStore = new SkillOptimizationStore('data/skill-optimizations.db');
  if (wave10ProposalStore) {
    wave13AgentConfigEvolver = new AgentConfigEvolver(wave10ProposalStore);
  }
  const calibTracker = typeof finalAgentLoop.getConfidenceCalibrationTracker === 'function'
    ? (finalAgentLoop.getConfidenceCalibrationTracker() ?? undefined)
    : undefined;
  wave13SkillOptimizer = new SkillOptimizer(
    wave13SkillDiscovery,
    mistakePatternRecognizer,
    calibTracker,
    wave13SkillOptimizationStore,
    registry,   // SkillRegistry instance — already declared earlier in boot as `registry`
  );
  log.info('Wave 13: SkillDiscovery + AgentConfigEvolver + SkillOptimizer initialised');
} catch (err13: unknown) {
  log.warn(
    { err: String(err13) },
    'Wave 13: SkillOptimizer init failed — skill optimization disabled (fail-open)',
  );
}
```

NOTE: `registry` is the `SkillRegistry` variable declared in the main boot sequence. Builder 1
must verify the exact variable name by searching for `new SkillRegistry(` in cli.ts.

**Edit 3 — SleepCycle constructor call (~line 830-848), add two new options inside the
existing object literal:**

```typescript
skillDiscovery: wave13SkillDiscovery,
agentConfigEvolver: wave13AgentConfigEvolver,
skillOptimizer: wave13SkillOptimizer,
```

**Edit 4 — attachHttpApi call (~line 1788-1810), add inside the existing object:**

```typescript
skillOptimizationStore: wave13SkillOptimizationStore,
```

---

## 5. 4th Eval Condition

### Condition Name: `skills_post_optimizer`

Rationale: `skills_optimized` already exists (3rd condition). `skills_post_optimizer` clearly
encodes the source (SkillOptimizer module), self-documents in markdown bench reports, and does
not collide with OpenJarvis's `skills_optimized_dspy` / `skills_optimized_gepa` naming if we
need to add those later.

### wave10-types.ts Change (Builder 2 at GATE-0)

**Line 203 — SkillCondition union extension:**

```typescript
// BEFORE:
export type SkillCondition = 'no_skills' | 'skills_on' | 'skills_optimized';

// AFTER:
export type SkillCondition = 'no_skills' | 'skills_on' | 'skills_optimized' | 'skills_post_optimizer';
```

**Also add after AgentConfigProposal block (~line 175) — new interfaces for Wave 13:**

```typescript
// ---------------------------------------------------------------------------
// B4b. SkillOptimizationProposal — SkillOptimizer output (Wave 13)
// ---------------------------------------------------------------------------

/** Lifecycle status of a skill optimization proposal. */
export type SkillOptimizationStatus = 'pending' | 'approved' | 'rejected';

/**
 * Proposed per-field optimization for a specific skill,
 * generated from trace patterns during sleep cycles.
 */
export interface SkillOptimizationProposal {
  id: string;
  skillId: string;
  skillName: string;
  targetField: 'description' | 'examples' | 'tags';
  currentValue: string;
  proposedValue: string;
  evidence: string;
  confidence: number;
  status: SkillOptimizationStatus;
  createdAt: string;
  updatedAt: string;
}
```

### skill-bench.ts Change (Builder 2)

**File:** `/root/sudo-ai-v4/src/core/eval/skill-bench.ts`

**Line 21:**

```typescript
// BEFORE:
const ALL_CONDITIONS: SkillCondition[] = ['no_skills', 'skills_on', 'skills_optimized'];

// AFTER:
const ALL_CONDITIONS: SkillCondition[] = [
  'no_skills',
  'skills_on',
  'skills_optimized',
  'skills_post_optimizer',
];
```

### bench-runner.ts Change (Builder 2)

**File:** `/root/sudo-ai-v4/src/core/eval/bench-runner.ts`

Add optional dep to BenchRunner's options interface and run() opts:

```typescript
/** Optional — if absent, skills_post_optimizer behaves identically to skills_on. Wave 13. */
skillOptimizer?: {
  getApprovedForSkill(skillId: string): { proposedValue: string; targetField: string } | null;
};
```

When `condition === 'skills_post_optimizer'` in BenchRunner, check
`skillOptimizer?.getApprovedForSkill(task.id ?? task.name)`. If an approved proposal is
found, augment the task prompt with a note about the proposed optimization before calling
brain. If `skillOptimizer` is absent or returns null, fall back to `skills_on` behavior.

### Sequencing Caveat

The test file `tests/eval/skill-bench-4th-condition.test.ts` MUST include this JSDoc comment
on the suite:

```
 * @note skills_post_optimizer produces differentiated results ONLY after at least one
 * sleep cycle has run with a wired SkillOptimizer AND at least one proposal has been
 * approved via POST /v1/admin/skills/optimizations/:id/approve. On a fresh deploy with no
 * approved proposals, this condition falls back to skills_on behavior transparently.
 * This is expected and documented behavior.
```

---

## 6. Wave Execution Plan

```
GATE-0 (BLOCKING — Builder 2 lands first, ~15 min):
  B2 adds SkillOptimizationProposal + SkillOptimizationStatus + SkillCondition 4th literal
  to wave10-types.ts.
  B1 cannot compile skill-optimizer.ts until these types are available.

PARALLEL (after GATE-0 is confirmed via tsc check on wave10-types.ts alone):
  Builder 1 (~60 min):
    - src/core/skills/skill-optimizer.ts             (new)
    - src/core/skills/skill-optimization-store.ts    (new)
    - src/core/gateway/admin-routes.ts               (edit: deps + 3 routes + log line)
    - src/core/consciousness/sleep-cycle/consolidator.ts  (edit: 5 targeted edits)
    - src/cli.ts                                     (edit: imports + init block + 2 constructor opts + 1 attachHttpApi opt)
    - tests/skills/skill-optimizer.test.ts           (new, >= 10 unit)
    - tests/skills/skill-optimizer-rest.test.ts      (new, >= 5 REST)

  Builder 2 (remainder after GATE-0, ~30 min):
    - src/core/eval/skill-bench.ts                   (edit: ALL_CONDITIONS)
    - src/core/eval/bench-runner.ts                  (edit: optional skillOptimizer dep)
    - tests/eval/skill-bench-4th-condition.test.ts   (new, >= 8 bench)

GATE-1 (BLOCKING — both builders done):
  INTEGRATOR runs: tsc --noEmit
  Verifies all new imports resolve.
  Verifies no circular deps.

GATE-2 (SECURITY — adversarial review):
  Checks: skill-optimizer.ts has ZERO imports from tools/builtin/skill/tools/refine.ts
  Checks: no calls to queryMistakePatterns() in skill-optimizer.ts
  Checks: SkillOptimizationStore DB calls all wrapped in try/catch
  Checks: propose() cap of 5 enforced with log.warn

GATE-3 (QUALITY — 100% pass required):
  Full suite: skills/* + eval/* + learning/* (existing regressions zero)
  New test count: >= 23

GATE-4 (DEVOPS — deploy only after all gates):
  pm2 reload sudo-ai-v5
  Verify /v1/admin/skills/optimizations returns 200 or 503 (not 404/500)
```

---

## 7. File Ownership Map (strict, zero overlap)

| File | Owner | Operation |
|------|-------|-----------|
| `src/core/skills/skill-optimizer.ts` | Builder 1 | CREATE |
| `src/core/skills/skill-optimization-store.ts` | Builder 1 | CREATE |
| `src/core/gateway/admin-routes.ts` | Builder 1 | EDIT (AdminRoutesDeps + 3 routes + log) |
| `src/core/consciousness/sleep-cycle/consolidator.ts` | Builder 1 | EDIT (5 targeted edits at lines 188, 302-304, 322-323, 353-354, ~636 insert) |
| `src/cli.ts` line 82-83 (4 new imports) | Builder 1 | EDIT |
| `src/cli.ts` line ~1768 (init block) | Builder 1 | EDIT |
| `src/cli.ts` line ~830-848 (SleepCycle opts) | Builder 1 | EDIT |
| `src/cli.ts` line ~1788 (attachHttpApi opt) | Builder 1 | EDIT |
| `tests/skills/skill-optimizer.test.ts` | Builder 1 | CREATE |
| `tests/skills/skill-optimizer-rest.test.ts` | Builder 1 | CREATE |
| `src/core/shared/wave10-types.ts` | Builder 2 | EDIT (SkillCondition union + 2 new interfaces at GATE-0) |
| `src/core/eval/skill-bench.ts` | Builder 2 | EDIT (ALL_CONDITIONS array) |
| `src/core/eval/bench-runner.ts` | Builder 2 | EDIT (optional skillOptimizer dep) |
| `tests/eval/skill-bench-4th-condition.test.ts` | Builder 2 | CREATE |

**cli.ts handoff rule:** Builder 1 owns ALL cli.ts edits for Wave 13. Builder 2 does NOT
touch cli.ts.

---

## 8. Test Count Targets

| Builder | Test File | Min Count | Coverage Topics |
|---------|-----------|-----------|-----------------|
| B1 | tests/skills/skill-optimizer.test.ts | 10 | constructor, propose() cap at 5, log.warn when >5, empty signals returns [], confidence score formula, duplicate skip (proposalGenerated flag), DB error fail-open, getApprovedForSkill, listPending, all three signal sources wired/unwired |
| B1 | tests/skills/skill-optimizer-rest.test.ts | 5 | GET 200 with data, GET 503 when store absent, POST approve 200, POST approve 404, POST reject with reason |
| B2 | tests/eval/skill-bench-4th-condition.test.ts | 8 | ALL_CONDITIONS.length === 4, ALL_CONDITIONS includes skills_post_optimizer, runSkillBench includes 4th key in report.byCondition, fallback to skills_on when no optimizer dep, markdown table has 4 rows, BenchRunner handles missing skillOptimizer gracefully, SkillCondition type accepts 4th literal, sequencing caveat in JSDoc |

**Total minimum: 23 new tests.**

---

## 9. Acceptance Criteria (all gates must pass)

1. `tsc --noEmit` clean — zero new TypeScript errors
2. All 23+ new tests pass; zero regressions in existing skills/*, eval/*, learning/* suites
3. `skill-optimizer.ts` contains zero imports from `tools/builtin/skill/tools/refine.ts` — Security will grep
4. Every DB-touching method in `SkillOptimizationStore` wrapped in try/catch (Wave 11 lesson 4)
5. `propose()` hard cap at 5 enforced with `log.warn` when candidates.length > 5
6. `tests/eval/skill-bench-4th-condition.test.ts` suite JSDoc states: "Produces differentiated results only after >= 1 sleep cycle with approved SkillOptimizationProposal"
7. `consolidator.ts` hook is fail-open (try/catch, no re-throw)
8. `cli.ts` init block is fail-open (try/catch, warn on failure, all four vars degrade to undefined)
9. `GET /v1/admin/skills/optimizations` returns 503 with `{ ok: false, error: ... }` when store absent
10. Admin route log line updated with all 3 new routes
11. `skills_post_optimizer` condition falls back to `skills_on` behavior when no approved proposals (no crash)

---

## 10. Key Architecture Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Separate SkillOptimizationStore, not extending ProposalStore | Different schema shape (per-field patches vs agent-wide deltas), different status lifecycle (3 vs 4 states), clean separation avoids coupling the approval UI |
| D2 | SkillOptimizer does NOT call skill.refine | Different signal source (aggregated TracePattern+Brier vs raw audit row per tool), different lifecycle (sleep-driven vs interactive), different output shape (SQLite-persisted proposals vs synchronous hints to caller). Security must grep-verify. |
| D3 | 4th condition named `skills_post_optimizer` | Encodes source (Optimizer), distinguishes clearly from `skills_optimized`, will not collide with future OJ-compatible conditions (`skills_optimized_dspy`, `skills_optimized_gepa`) |
| D4 | B2 lands wave10-types.ts FIRST as GATE-0 | B1's skill-optimizer.ts imports SkillOptimizationProposal; compilation dependency forces strict ordering. B2's contribution is ~20 lines and can be done in 15 min. |
| D5 | Builder 1 wires SkillDiscovery + AgentConfigEvolver + SkillOptimizer into cli.ts | Neither SkillDiscovery nor AgentConfigEvolver was instantiated in production (grep on cli.ts returns zero hits). Without wiring, SkillOptimizer has zero trace data at runtime. |
| D6 | Cap enforced inside propose(), not in consolidator | Keeps consolidator dumb; all optimizer policy lives in one place. |
| D7 | `skills_post_optimizer` fallback to `skills_on` when no approved proposals | Prevents bench from crashing on fresh deploys; sequencing caveat documented in test JSDoc. |
