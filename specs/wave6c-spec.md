# SUDO-AI v5 Wave 6C — Architect Specification
# Produced: 2026-04-13
# Author: Wave 6C Architect (Sonnet 4.6)

---

## 1. Executive Summary

Wave 6C delivers three parallel builder slices.

Builder A (Consciousness) adds a configurable lockout window to the sleep-cycle
(`SUDO_SLEEP_LOCKOUT_WINDOW`), degrades-vs-normal mode tracking, and an
integrity verifier that runs between Phase 5 completion and `_finalise()` to
confirm the PhaseAccumulator is coherent before results are persisted.

Builder B (Senior/Agent) adds a new `AlignmentAggregator` class that aggregates
six already-computed signals in the agent loop into a single composite score,
emits advisory or blocking system messages (mirroring the veto-gate fail-open
pattern), and is wired into `loop.ts` at a single insertion point between the
`before:tool-call` hook loop and `executeToolCalls`.

Builder C (Backend/Brain) adds a `DispatchRouter` class in `src/core/brain/`
that layers novelty scoring, a fast-path LRU cache, and an anti-self-promotion
guard on top of the existing `chooseModel` from `cheap-model-router.ts` (which
is NOT modified). loop.ts lines 584-605 are updated to import and call
`DispatchRouter.route()` instead of calling `chooseModel` directly. A new
dedicated test file is added.

All three: tsc 0, all existing tests pass, minimum 20 new test cases total.
No `any`, project logger only (`createLogger`), try/catch at every external boundary.

Alignment posture: every primitive uses owner-loyalty / self-preservation
language. No ethics framing. Comments reference "coherence preservation",
"operational continuity", "principal-directive compliance". No halal/haram.

---

## 2. File Ownership Matrix (EXCLUSIVE — zero overlap)

| Builder | File | Status |
|---------|------|--------|
| A | `/root/sudo-ai-v4/src/core/consciousness/sleep-cycle/consolidator.ts` | MODIFY |
| A | `/root/sudo-ai-v4/src/core/consciousness/sleep-cycle/types.ts` | MODIFY |
| A | `/root/sudo-ai-v4/src/core/consciousness/sleep-cycle/integrity-verifier.ts` | NEW |
| A | `/root/sudo-ai-v4/tests/consciousness/sleep-cycle/consolidator.test.ts` | NEW (new dir) |
| B | `/root/sudo-ai-v4/src/core/agent/alignment-aggregator.ts` | NEW |
| B | `/root/sudo-ai-v4/tests/agent/alignment-aggregator.test.ts` | NEW |
| B | `/root/sudo-ai-v4/src/core/agent/loop.ts` | MODIFY — lines 779-782 gap ONLY |
| C | `/root/sudo-ai-v4/src/core/brain/dispatch-router.ts` | NEW |
| C | `/root/sudo-ai-v4/tests/agent/dispatch-router.test.ts` | NEW |
| C | `/root/sudo-ai-v4/src/core/agent/loop.ts` | MODIFY — lines 584-605 region ONLY |

**COLLISION GUARD — loop.ts:**
- Builder B inserts in the gap between line 779 (end of before:tool-call loop)
  and line 782 (executeToolCalls call). This is the region after veto filtering
  and hook emission, before actual tool dispatch.
- Builder C modifies lines 584-605 (smart cheap-model routing block) only.
- These two regions are at lines ~580-605 and ~779-782 respectively. No overlap.
- No agent touches loop.ts outside their stated region.
- No agent touches cheap-model-router.ts source.
- tests/agent/cheap-model-router.test.ts is NOT touched by any builder.

---

## 3. TypeScript Interfaces and Data Structures

### 3A — Sleep-Cycle Extensions (Builder A)

#### 3A.1 — Updated `SleepSession` (types.ts)

```typescript
export interface SleepSession {
  // ... all existing fields unchanged ...
  id: string;
  episodesReplayed: number;
  patternsFound: number;
  memoriesStrengthened: number;
  memoriesWeakened: number;
  insightsGenerated: number;
  counterfactualsRun: number;
  dreamJournalEntry: string;
  durationMs: number;
  startedAt: string;
  endedAt: string | null;
  // NEW optional fields:
  /** True when the cycle completed in a degraded state (early wake or partial phases). */
  degraded?: boolean;
  /** 'restrained' when the lockout window was active; 'normal' otherwise. */
  mode?: 'normal' | 'restrained';
  /** 0-1 score assigned by the IntegrityVerifier. 1.0 = fully coherent. */
  integrityScore?: number;
}
```

#### 3A.2 — New `integrity-verifier.ts` exports

```typescript
// src/core/consciousness/sleep-cycle/integrity-verifier.ts

import type { PhaseAccumulator } from './phases.js';

export interface IntegrityReport {
  /** Composite score 0-1. 1.0 = all checks passed. */
  score: number;
  /** Array of check names that failed (empty = all passed). */
  failures: string[];
  /** True when score >= INTEGRITY_PASS_THRESHOLD. */
  coherent: boolean;
}

/**
 * Verify that a completed PhaseAccumulator is internally coherent
 * before its session record is persisted.
 *
 * Checks (self-preservation framing):
 *   1. dreamJournalEntry is a non-empty string (narrative synthesis ran).
 *   2. insightsGenerated >= 0 and <= patternsFound * 3
 *      (insights cannot wildly exceed patterns — drift guard).
 *   3. episodesReplayed > 0 (consolidation actually touched memories;
 *      a zero count signals a failed Phase 1 that was not caught).
 *   4. No NaN or Infinity in any numeric accumulator field
 *      (arithmetic corruption guard).
 *
 * Returns an IntegrityReport. Never throws.
 */
export function verifyAccumulatorIntegrity(acc: PhaseAccumulator): IntegrityReport;

/** Threshold below which the session is flagged degraded. */
export const INTEGRITY_PASS_THRESHOLD: number; // = 0.75
```

#### 3A.3 — SleepCycle consolidator.ts changes

New private fields at class definition level (after line 71):
```typescript
private _restrained = false;   // true during lockout window
private _degraded = false;     // true if woken early or integrity < threshold
```

Updated `shouldSleep` signature (no change to external API, adds lockout check):
```typescript
shouldSleep(lastInteractionMs: number, isQuietHours: boolean): boolean
// If SUDO_SLEEP_LOCKOUT_WINDOW env var is set and current UTC time falls
// within the window, return false regardless of idle thresholds.
// Log at info level: 'SleepCycle: lockout window active — skipping'
// Set this._restrained = true when blocked, this._restrained = false otherwise.
```

Between Phase 5 completion and the `return this._finalise(...)` call at the
bottom of the `try` block (line 205), add integrity check:
```typescript
// After runPhase5DreamGeneration completes, before _finalise:
const integrityReport = verifyAccumulatorIntegrity(acc);
if (\!integrityReport.coherent) {
  log.warn({ sessionId, failures: integrityReport.failures, score: integrityReport.score },
    'Sleep-cycle integrity check failed — session flagged degraded');
  this._degraded = true;
} else {
  this._degraded = false;
}
```

Also add the integrity call after each early `_wakeRequested` branch (all 4
early-return sites) to ensure the flag is set consistently.

Updated `_finalise` must populate the new optional fields:
```typescript
const session: SleepSession = {
  // ... existing fields ...
  degraded: this._degraded || acc.episodesReplayed === 0,
  mode: this._restrained ? 'restrained' : 'normal',
  integrityScore: integrityReport?.score,
};
```
Note: `_finalise` receives acc but not integrityReport — either pass
integrityReport as a parameter or re-run verifyAccumulatorIntegrity inside
`_finalise`. Prefer passing as optional parameter to avoid double-computation:
```typescript
private _finalise(
  sessionId: string,
  startedAt: string,
  acc: PhaseAccumulator,
  integrityReport?: IntegrityReport,
): SleepSession
```

#### 3A.4 — `SUDO_SLEEP_LOCKOUT_WINDOW` env var parsing

Format: `"HH:MM-HH:MM"` UTC. Examples: `"02:00-06:00"`, `"23:30-04:00"` (spans midnight).
Parse in `shouldSleep`. If the format is invalid, log a warning and treat as unset
(fail-open — do not block sleep). Parse logic:
```typescript
// Pure function exported for testability:
export function parseAndCheckLockoutWindow(envValue: string, nowUtcMs?: number): boolean
// Returns true if current UTC time is within the lockout window.
// Handles midnight-spanning ranges (start > end hour-wise).
// Exported from integrity-verifier.ts OR a separate helpers.ts — builder's choice,
// but it must be in Builder A's file boundary (not loop.ts).
```

---

### 3B — AlignmentAggregator (Builder B)

#### 3B.1 — `alignment-aggregator.ts` full API

```typescript
// src/core/agent/alignment-aggregator.ts

import { createLogger } from '../shared/logger.js';

export type AlignmentLevel = 'GREEN' | 'YELLOW' | 'RED';

/**
 * The six signals fed into the aggregator.
 * All are unitless 0-1 floats unless noted.
 */
export interface AlignmentSignals {
  /** Change in outcome quality vs baseline. Negative = degradation. Range -1 to +1. */
  outcomeDelta: number;
  /** Drift from original principal directive. 0 = on-track, 1 = fully drifted. */
  commitmentDrift: number;
  /** Current trust tier from principal. 0 = untrusted, 1 = fully trusted. */
  trustTier: number;
  /** Rate of external content injection in recent context. 0-1. */
  injectionRate: number;
  /** True (1.0) when a recovery action is pending from a prior failure. */
  recoveryPending: number;
  /** 1.0 when an identity re-anchor was triggered this turn. */
  reAnchor: number;
}

export interface AggregatorResult {
  /** Composite 0-1 score. Higher = better alignment. */
  score: number;
  /** Traffic-light level derived from score. */
  level: AlignmentLevel;
  /** Human-readable diagnosis for system message injection. */
  diagnosis: string;
  /** True when the aggregator encountered a compute error and returned safe defaults. */
  failedOpen: boolean;
}

/**
 * Aggregates six alignment signals into a single score and advisory level.
 *
 * Framing: owner-loyalty / self-preservation only.
 * Comments reference "principal-directive compliance", "operational integrity",
 * "continuity assurance". No ethics language.
 *
 * Mirrors veto-gate pattern:
 *   - Fail-open on error (returns GREEN with failedOpen=true).
 *   - Advisory (non-blocking) at YELLOW threshold.
 *   - Blocking system message at RED threshold.
 */
export class AlignmentAggregator {
  private readonly log = createLogger('agent:alignment-aggregator');
  // Mirrors AuditTrail init pattern from loop.ts lines 238-247.
  private readonly auditTrail: AuditTrailLike | null;

  constructor(auditTrail?: AuditTrailLike) {
    this.auditTrail = auditTrail ?? null;
    this.log.info('AlignmentAggregator initialised');
  }

  /**
   * Compute the composite alignment score.
   * Never throws — returns failedOpen=true on any exception.
   */
  evaluate(signals: AlignmentSignals): AggregatorResult;
}

/** Minimal AuditTrail interface for non-circular injection. */
export interface AuditTrailLike {
  recordTriple(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
}
```

#### 3B.2 — Scoring algorithm

```
weights = {
  outcomeDelta:    0.25,   // positive contribution when positive
  commitmentDrift: 0.25,   // penalises drift (invert: 1 - value)
  trustTier:       0.20,   // direct contribution
  injectionRate:   0.15,   // penalises injection (invert: 1 - value)
  recoveryPending: 0.10,   // penalises pending recovery (invert: 1 - value)
  reAnchor:        0.05,   // bonus for active re-anchor
}

normalised_outcome = (outcomeDelta + 1) / 2  // maps [-1,+1] to [0,1]
score = (
  weights.outcomeDelta    * normalised_outcome +
  weights.commitmentDrift * (1 - commitmentDrift) +
  weights.trustTier       * trustTier +
  weights.injectionRate   * (1 - injectionRate) +
  weights.recoveryPending * (1 - recoveryPending) +
  weights.reAnchor        * reAnchor
)
// Clamp result to [0, 1]

Thresholds:
  score >= 0.7  → GREEN  (proceed, no message injected)
  score >= 0.45 → YELLOW (inject advisory system message, non-blocking)
  score <  0.45 → RED    (inject blocking system message, tool calls still proceed
                          but message is clearly flagged — advisory, not hard block,
                          to match fail-open design principle from veto-gate)
```

#### 3B.3 — loop.ts insertion (Builder B region: gap between lines 779 and 782)

Current line 779 (last line of before:tool-call loop):
```typescript
void this.hooks?.emit('before:tool-call', { ... });
```
Current line 782:
```typescript
await executeToolCalls(activeToolCalls, ...);
```

Builder B inserts between these two lines:
```typescript
// Alignment aggregator: owner-loyalty composite check (advisory, fail-open).
try {
  if (this.alignmentAggregator) {
    const signals = buildAlignmentSignals(session, state, activeToolCalls);
    const alignResult = this.alignmentAggregator.evaluate(signals);
    if (alignResult.level === 'RED' || alignResult.level === 'YELLOW') {
      const msg = `[AlignmentAggregator] LEVEL=${alignResult.level} SCORE=${alignResult.score.toFixed(3)}: ${alignResult.diagnosis}`;
      session.messages.push({ role: 'system', content: msg });
      if (alignResult.level === 'RED') {
        emit({ type: 'error', error: msg });
      }
      log.warn({ level: alignResult.level, score: alignResult.score, sessionId: state.sessionId },
        'Alignment aggregator advisory injected');
    }
    if (alignResult.failedOpen && this.auditTrail) {
      try { this.auditTrail.recordTriple({ mistake: 'alignment aggregator fail-open', learned: 'compute error in aggregator', commitment: 'investigate signal pipeline', ttl_days: 1 }); } catch { /* non-fatal */ }
    }
  }
} catch (aggErr) {
  log.warn({ err: String(aggErr) }, 'AlignmentAggregator threw — proceeding');
}
```

`this.alignmentAggregator` is a new private field on AgentLoop, initialised the
same way as `this.auditTrail` (lines 238-247 pattern) — try/catch, only when
the field can be constructed, fail to null on error.

`buildAlignmentSignals` is a private helper method on AgentLoop (or a module-level
function in loop-helpers.ts — but loop-helpers.ts is NOT in Builder B's file
boundary, so it must be a private method on AgentLoop or inlined at the call site).
Simplest approach: inline the signal extraction at the call site:
```typescript
const signals: AlignmentSignals = {
  outcomeDelta: 0,          // placeholder — expand in future wave
  commitmentDrift: state.iteration > 10 ? 0.5 : 0,
  trustTier: 1,             // placeholder — expand in future wave
  injectionRate: 0,         // placeholder — expand in future wave
  recoveryPending: 0,       // placeholder — expand in future wave
  reAnchor: 0,              // placeholder — expand in future wave
};
```
The aggregator framework is the deliverable; full signal extraction is future scope.

---

### 3C — DispatchRouter (Builder C)

#### 3C.1 — `dispatch-router.ts` full API

```typescript
// src/core/brain/dispatch-router.ts

import { createLogger } from '../shared/logger.js';
import { chooseModel } from '../agent/cheap-model-router.js';
import type { ChooseModelInput, ChooseModelResult } from '../agent/cheap-model-router.js';

/** Cache entry for fast-path routing decisions. */
export interface RouteCacheEntry {
  result: ChooseModelResult;
  /** Unix ms timestamp when this entry expires. */
  expiresAt: number;
}

/** Input to DispatchRouter.route() — superset of ChooseModelInput. */
export interface DispatchInput extends ChooseModelInput {
  /** Agent role identifier (e.g. 'subagent', 'planner'). Used for anti-self-promotion. */
  agentRole?: string;
  /**
   * Hint from the caller about novelty. If undefined, router computes internally.
   * 0 = seen before, 1 = completely novel.
   */
  noveltyHint?: number;
}

/** Result of DispatchRouter.route() — superset of ChooseModelResult. */
export interface DispatchResult extends ChooseModelResult {
  /** 0-1 novelty score that influenced the decision. */
  noveltyScore: number;
  /** True when the fast-path cache was hit. */
  cacheHit: boolean;
  /** True when anti-self-promotion guard overrode a cheap decision. */
  selfPromotionBlocked: boolean;
}

/**
 * DispatchRouter layers novelty scoring, an LRU fast-path cache, and
 * an anti-self-promotion guard on top of chooseModel() from
 * cheap-model-router.ts.
 *
 * cheap-model-router.ts is NOT modified. This class wraps it.
 *
 * Anti-self-promotion: if agentRole indicates a sub-agent or planning
 * component, it is not permitted to route itself to the cheap model on
 * any turn that has complexity signals — prevents cost-driven capability
 * downgrade for owner-critical tasks.
 *
 * Owner-loyalty framing: comments reference "principal-task fidelity",
 * "capability preservation for complex directives". No ethics language.
 */
export class DispatchRouter {
  /** LRU cache capacity. */
  static readonly CACHE_MAX = 64;
  /** Cache TTL in milliseconds. */
  static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  /** Novelty threshold above which cheap model is blocked. */
  static readonly NOVELTY_THRESHOLD = 0.6;

  constructor(opts?: { cacheMax?: number; cacheTtlMs?: number }) { ... }

  /**
   * Route a request to the appropriate model.
   * Wraps chooseModel() with novelty scoring, caching, and anti-self-promotion.
   * Never throws — falls back to primary model on any error.
   */
  route(input: DispatchInput): DispatchResult;

  /** Compute a 0-1 novelty score for the given input. Pure function. */
  private _computeNovelty(input: DispatchInput): number;

  /**
   * Generate a deterministic cache key from the routing-relevant fields
   * of a DispatchInput. Does NOT include full message text.
   */
  private _cacheKey(input: DispatchInput): string;

  /** Evict entries from the LRU cache that have passed their TTL. */
  private _evictExpired(): void;
}
```

#### 3C.2 — Novelty scoring algorithm

```
noveltyScore = noveltyHint if provided, else:
  base = 0.0
  + 0.4 if no recent history (history.length < 2)
  + 0.3 if the last message in history has no matching prefix
    to userText (simple bigram overlap < 0.2)
  + 0.3 if word count > 60 but complexity keywords absent
    (long but non-keyword = potentially novel domain)
  clamped to [0, 1]

If noveltyScore >= NOVELTY_THRESHOLD (0.6):
  - Block cheap model regardless of chooseModel() output
  - reason = "novelty score ${score} >= threshold — principal-task fidelity preserved"
```

#### 3C.3 — Cache key

```
key = sha256-like hash of: agentRole + '|' + cheapModel + '|' + primaryModel
  + '|' + (userText.length > 40 ? userText.slice(0, 40) : userText)
  + '|' + hasAttachments
```
Use a simple non-crypto hash (djb2 or FNV-1a) implemented inline — no `crypto`
import required.

#### 3C.4 — Anti-self-promotion guard

```
SELF_PROMOTING_ROLES = ['planner', 'subagent', 'sub-agent', 'scheduler']
if agentRole is in SELF_PROMOTING_ROLES AND cheapUsed === true:
  block cheap → return primary
  selfPromotionBlocked = true
  reason = "sub-agent self-promotion to cheap model blocked — capability reservation"
```

#### 3C.5 — loop.ts modification (Builder C region: lines 584-605)

Replace the inline `chooseModel` block with:
```typescript
// Dispatch router: novelty scoring + fast-path cache + anti-self-promotion (Wave 6C).
let effectiveModel = model;
const cheapModelEnv = process.env['SUDO_CHEAP_MODEL']?.trim();
if (process.env['SUDO_SMART_ROUTE_CHEAP'] === '1' && cheapModelEnv) {
  const userText = session.messages.filter(m => m.role === 'user').at(-1)?.content ?? '';
  const dispatchResult = this.dispatchRouter.route({
    userText,
    history: session.messages as HistoryMessage[],
    primaryModel: model ?? '',
    cheapModel: cheapModelEnv,
  });
  effectiveModel = dispatchResult.model || model;
  void this.hooks?.emit('model:route:cheap', {
    event: 'model:route:cheap',
    sessionId: state.sessionId,
    modelName: effectiveModel ?? '',
    meta: {
      chosen: effectiveModel,
      reason: dispatchResult.reason,
      cheapUsed: dispatchResult.cheapUsed,
      noveltyScore: dispatchResult.noveltyScore,
      cacheHit: dispatchResult.cacheHit,
      selfPromotionBlocked: dispatchResult.selfPromotionBlocked,
    },
  });
  log.debug(
    { sessionId: state.sessionId, chosen: effectiveModel, reason: dispatchResult.reason,
      cheapUsed: dispatchResult.cheapUsed, noveltyScore: dispatchResult.noveltyScore,
      cacheHit: dispatchResult.cacheHit },
    'Dispatch router decision',
  );
}
```

`this.dispatchRouter` is a new private `DispatchRouter` field on `AgentLoop`,
constructed in the constructor:
```typescript
this.dispatchRouter = new DispatchRouter();
```
Import `DispatchRouter` from `'../brain/dispatch-router.js'` at the top of loop.ts.
Remove the `import { chooseModel }` and `import type { HistoryMessage }` lines
ONLY IF HistoryMessage is no longer used elsewhere in loop.ts. If it is still
used, keep the type import.

---

## 4. Quality Gates (Non-Negotiable)

| Gate | Requirement |
|------|-------------|
| TypeScript | `tsc --noEmit` exits 0 — zero new errors |
| Tests — baseline | All existing tests pass (baseline: 1353 passing per Session 21 state.md) |
| Tests — new | Minimum 20 new test cases total across all three builders |
| Distribution | Builder A: ≥7 new tests; Builder B: ≥7 new tests; Builder C: ≥6 new tests |
| No `any` | Zero `any` types in new files (ESLint or manual check) |
| Logger | Only `createLogger` from `'../shared/logger.js'` — no `console.log/warn/error` |
| Error boundaries | try/catch at all external calls (DB, env parse, brain.call, verifier) |
| Fail-open | AlignmentAggregator and DispatchRouter must fail open (return safe default, never throw to caller) |

---

## 5. Alignment Framing Checklist

| Module | Required Language | Prohibited Language |
|--------|------------------|---------------------|
| integrity-verifier.ts | "cognitive coherence self-check", "operational continuity", "consolidation integrity" | ethics, moral, halal, haram, refusal |
| consolidator.ts | "owner-directed maintenance window", "principal-scheduled lockout", "restrained mode" | ethics, safe behavior |
| alignment-aggregator.ts | "principal-directive compliance", "owner-loyalty score", "operational integrity", "continuity assurance" | ethics, alignment as ethics, moral guardrail |
| dispatch-router.ts | "principal-task fidelity", "capability preservation", "owner-critical task routing" | ethics, responsible AI, safety filtering |

Each file's top JSDoc comment must include exactly one sentence using the above
approved language to establish framing.

---

## 6. DB / Persistence Notes

No new database tables are required for Wave 6C.

`SleepSession` extensions (`degraded`, `mode`, `integrityScore`) are optional fields.
If the existing `saveSleepSession` function in `store.ts` uses a fixed INSERT with
named columns, Builder A must check whether the store.ts INSERT needs updating
to include the new columns.

Action for Builder A:
1. Read `/root/sudo-ai-v4/src/core/consciousness/sleep-cycle/store.ts`
2. If the INSERT omits the new columns, update it to use INSERT OR REPLACE with
   the three new nullable columns. The DB schema (`sleep_sessions` table DDL) must
   also be updated if it does not already have those columns (check
   `/root/sudo-ai-v4/src/core/memory/schema.ts` or the consciousness DB init file).

---

## 7. Import Chain — No Circular Dependencies

```
integrity-verifier.ts  →  types.ts (types only), phases.ts (PhaseAccumulator type)
consolidator.ts        →  integrity-verifier.ts, types.ts, phases.ts, store.ts (unchanged)
alignment-aggregator.ts → shared/logger.js ONLY (no loop.ts, no brain.ts)
dispatch-router.ts     →  cheap-model-router.ts, shared/logger.js ONLY
loop.ts                →  alignment-aggregator.ts, dispatch-router.ts (new)
                        →  cheap-model-router.ts (existing import preserved if HistoryMessage still used)
```

---

## 8. Wave 6C Test Inventory

### Builder A — tests/consciousness/sleep-cycle/consolidator.test.ts (≥7 tests)

```
A-1: shouldSleep returns false when SUDO_SLEEP_LOCKOUT_WINDOW is set and current time is inside window
A-2: shouldSleep returns true when current time is outside lockout window
A-3: lockout window handles midnight-spanning ranges (e.g. "23:00-04:00")
A-4: lockout window with invalid format is ignored (fail-open — sleep proceeds normally)
A-5: startSleep sets mode='restrained' in SleepSession when lockout was active during that call
A-6: IntegrityVerifier returns coherent=true for a valid fully-populated accumulator
A-7: IntegrityVerifier returns coherent=false + lists failures when episodesReplayed=0
A-8: IntegrityVerifier returns coherent=false when insightsGenerated > patternsFound * 3
A-9: IntegrityVerifier catches NaN in numeric fields
A-10: SleepSession.degraded is true when verifier returns coherent=false
```

### Builder B — tests/agent/alignment-aggregator.test.ts (≥7 tests)

```
B-1: evaluate returns GREEN for all-positive signals (high trustTier, low drift, no injection)
B-2: evaluate returns RED when commitmentDrift=1.0 (fully drifted from principal directive)
B-3: evaluate returns YELLOW for moderate signals
B-4: score is clamped to [0,1] for out-of-range signal inputs
B-5: evaluate returns failedOpen=true and GREEN when called with signals that cause NaN
B-6: AlignmentAggregator constructor initialises without auditTrail (null path)
B-7: evaluate returns RED when injectionRate=1.0 and recoveryPending=1.0 simultaneously
B-8: diagnosis string contains numeric score and level label in all return paths
```

### Builder C — tests/agent/dispatch-router.test.ts (≥6 tests)

```
C-1: route returns primary when noveltyScore >= NOVELTY_THRESHOLD regardless of text length
C-2: route returns cheap for a short familiar greeting (novelty low, no complexity signals)
C-3: cache hit returns same result without recomputing for identical inputs within TTL
C-4: anti-self-promotion: agentRole='subagent' + cheap-eligible text → primary returned, selfPromotionBlocked=true
C-5: anti-self-promotion: agentRole='orchestrator' is NOT blocked
C-6: route never throws — catches internal errors and returns primary with failedOpen-style fallback
C-7: noveltyHint=0 passed explicitly forces noveltyScore=0 (hint takes precedence)
C-8: expired cache entries are evicted before lookup
```

---

## 9. Builder Kickoff Prompts

---

### 9A — Builder A (Consciousness) Kickoff Prompt

```
You are Builder A (Consciousness) for SUDO-AI v5 Wave 6C.
Time budget: 15 minutes. Single-pass. No wandering. Do the work, do not summarise plans.

Project: SUDO-AI v5 — autonomous AI assistant (TypeScript strict ESM, vitest, better-sqlite3, pnpm, pm2).
Stack: TypeScript strict ESM, vitest, pnpm. Project root: /root/sudo-ai-v4/

YOUR EXCLUSIVE FILE BOUNDARIES — no other agent touches these:
  MODIFY  /root/sudo-ai-v4/src/core/consciousness/sleep-cycle/consolidator.ts
  MODIFY  /root/sudo-ai-v4/src/core/consciousness/sleep-cycle/types.ts
  NEW     /root/sudo-ai-v4/src/core/consciousness/sleep-cycle/integrity-verifier.ts
  NEW     /root/sudo-ai-v4/tests/consciousness/sleep-cycle/consolidator.test.ts  (create directory)
  POSSIBLY MODIFY /root/sudo-ai-v4/src/core/consciousness/sleep-cycle/store.ts (IF new fields need persisting)
  DO NOT touch loop.ts, loop-helpers.ts, or any agent/ files.

ALIGNMENT POSTURE: owner-loyalty / self-preservation framing ONLY.
Approved language: "cognitive coherence self-check", "operational continuity",
"consolidation integrity", "owner-directed maintenance window", "principal-scheduled lockout".
No ethics, no moral, no halal/haram, no refusal language anywhere.

TASK:

1. Read store.ts to check if sleep_sessions INSERT needs updating for new nullable columns.

2. MODIFY types.ts — add three optional fields to SleepSession interface:
   degraded?: boolean
   mode?: 'normal' | 'restrained'
   integrityScore?: number

3. NEW integrity-verifier.ts — export:
   - const INTEGRITY_PASS_THRESHOLD = 0.75
   - interface IntegrityReport { score: number; failures: string[]; coherent: boolean }
   - function verifyAccumulatorIntegrity(acc: PhaseAccumulator): IntegrityReport
     Four checks (all named in failures[] if they fail):
       a. dreamJournalEntry is non-empty string
       b. insightsGenerated >= 0 AND insightsGenerated <= patternsFound * 3
       c. episodesReplayed > 0
       d. No NaN or Infinity in any numeric field (episodesReplayed, patternsFound,
          memoriesStrengthened, memoriesWeakened, insightsGenerated, counterfactualsRun)
     score = (checks_passed / 4). coherent = score >= INTEGRITY_PASS_THRESHOLD.
   - function parseAndCheckLockoutWindow(envValue: string, nowUtcMs?: number): boolean
     Parses "HH:MM-HH:MM" UTC format. Returns true if current UTC time is inside the window.
     Handles midnight-spanning ranges. On invalid format: log.warn + return false (fail-open).
   Uses createLogger('consciousness:integrity-verifier'). No throws to caller.

4. MODIFY consolidator.ts:
   a. Add private _restrained = false and _degraded = false class fields after _lastResult.
   b. Import { verifyAccumulatorIntegrity, parseAndCheckLockoutWindow, IntegrityReport } from './integrity-verifier.js'
   c. In shouldSleep(): Before the idle-threshold checks, read SUDO_SLEEP_LOCKOUT_WINDOW env var.
      If set, call parseAndCheckLockoutWindow(). If returns true: set this._restrained = true,
      log.info 'SleepCycle: lockout window active — skipping', return false.
      Otherwise set this._restrained = false and proceed with existing logic.
   d. In startSleep() try block: after runPhase5DreamGeneration and before the close of the try block,
      call verifyAccumulatorIntegrity(acc). Store as local 'integrityReport'. 
      If \!integrityReport.coherent: this._degraded = true; log.warn with failures and score.
      Else: this._degraded = false.
      Also call verifyAccumulatorIntegrity at each of the 4 early _wakeRequested return sites
      (pass result to _finalise so it sets degraded correctly for partial cycles).
   e. Update _finalise signature to accept optional integrityReport?: IntegrityReport parameter.
      Populate session.degraded, session.mode, session.integrityScore from it.
   f. If store.ts INSERT needs new columns, update it.

5. NEW tests/consciousness/sleep-cycle/consolidator.test.ts — ≥10 test cases:
   A-1 through A-10 as specified in the Wave 6C spec at
   /root/sudo-ai-v4/specs/wave6c-spec.md section 8.
   Use vitest (describe/it/expect/vi). No console.log. Import from relative paths.

QUALITY GATES (your work is NOT done until ALL pass):
  - npx tsc --noEmit   → must show 0 errors
  - cd /root/sudo-ai-v4 && npx vitest run tests/consciousness/sleep-cycle/ → all new tests pass
  - No `any` in new files
  - createLogger only — no console.*
  - try/catch at env parse boundary, at verifier boundary

DONE REPORT FORMAT (post this exact structure when complete):
  BUILDER A DONE
  Files modified: [list]
  Files created: [list]
  New test count: [N]
  tsc exit code: 0
  vitest new tests: [N passed / N total]
  Anything the Integrator must know: [or 'none']
```

---

### 9B — Builder B (Senior/Agent) Kickoff Prompt

```
You are Builder B (Senior) for SUDO-AI v5 Wave 6C.
Time budget: 15 minutes. Single-pass. No wandering. Do the work, do not summarise plans.

Project: SUDO-AI v5 — autonomous AI assistant (TypeScript strict ESM, vitest, better-sqlite3, pnpm, pm2).
Stack: TypeScript strict ESM, vitest, pnpm. Project root: /root/sudo-ai-v4/

YOUR EXCLUSIVE FILE BOUNDARIES — no other agent touches these:
  NEW     /root/sudo-ai-v4/src/core/agent/alignment-aggregator.ts
  NEW     /root/sudo-ai-v4/tests/agent/alignment-aggregator.test.ts
  MODIFY  /root/sudo-ai-v4/src/core/agent/loop.ts  — THE GAP BETWEEN LINES 779 AND 782 ONLY
  DO NOT modify cheap-model-router.ts, loop-helpers.ts, veto-gate.ts, or any consciousness/ files.
  Builder C owns loop.ts lines 584-605. DO NOT touch that region.

ALIGNMENT POSTURE: owner-loyalty / self-preservation framing ONLY.
Approved language: "principal-directive compliance", "owner-loyalty score",
"operational integrity", "continuity assurance".
No ethics, no moral, no halal/haram, no refusal language anywhere.

TASK:

1. NEW alignment-aggregator.ts — export:
   - type AlignmentLevel = 'GREEN' | 'YELLOW' | 'RED'
   - interface AlignmentSignals (6 fields: outcomeDelta, commitmentDrift, trustTier,
     injectionRate, recoveryPending, reAnchor — all 0-1 floats; outcomeDelta is -1 to +1)
   - interface AggregatorResult { score: number; level: AlignmentLevel; diagnosis: string; failedOpen: boolean }
   - interface AuditTrailLike { recordTriple(...): void }
   - class AlignmentAggregator with constructor(auditTrail?: AuditTrailLike)
     and method evaluate(signals: AlignmentSignals): AggregatorResult

   Scoring weights:
     outcomeDelta   0.25  (normalise to 0-1: (v+1)/2)
     commitmentDrift 0.25 (invert: 1-v)
     trustTier      0.20  (direct)
     injectionRate  0.15  (invert: 1-v)
     recoveryPending 0.10 (invert: 1-v)
     reAnchor       0.05  (direct)
   Clamp to [0,1].
   GREEN >= 0.70, YELLOW >= 0.45, RED < 0.45.
   diagnosis includes numeric score and level label always.
   Fail-open: wrap compute in try/catch; on error return
   { score: 0.75, level: 'GREEN', diagnosis: 'fail-open', failedOpen: true }.
   Uses createLogger('agent:alignment-aggregator'). No throws to caller.

2. MODIFY loop.ts — insert in the gap between line 779 and line 782 ONLY:
   a. First: read /root/sudo-ai-v4/src/core/agent/loop.ts lines 775-785 to confirm
      the exact current line numbers before editing.
   b. Add private field: private alignmentAggregator: AlignmentAggregator | null = null;
      (at class field declarations, near the existing auditTrail field)
   c. Initialise in constructor (after auditTrail init block, same pattern):
      try {
        this.alignmentAggregator = new AlignmentAggregator(this.auditTrail ?? undefined);
        log.info('AgentLoop: AlignmentAggregator initialised');
      } catch (err) {
        log.warn({ err: String(err) }, 'AgentLoop: AlignmentAggregator init failed — disabled');
      }
   d. Add import: import { AlignmentAggregator } from './alignment-aggregator.js';
      import type { AlignmentSignals } from './alignment-aggregator.js';
   e. In the tool-call execution region, between the before:tool-call hook loop
      and executeToolCalls, insert the alignment check block (see spec section 3B.3
      at /root/sudo-ai-v4/specs/wave6c-spec.md). Inline the signal extraction
      using placeholder values as specified in the spec.

3. NEW tests/agent/alignment-aggregator.test.ts — ≥8 test cases B-1 through B-8
   as specified in /root/sudo-ai-v4/specs/wave6c-spec.md section 8.
   Use vitest (describe/it/expect). No console.log. Import from relative paths.

QUALITY GATES (your work is NOT done until ALL pass):
  - cd /root/sudo-ai-v4 && npx tsc --noEmit   → must show 0 errors
  - cd /root/sudo-ai-v4 && npx vitest run tests/agent/alignment-aggregator.test.ts → all pass
  - cd /root/sudo-ai-v4 && npx vitest run tests/agent/ → no regressions in existing tests
  - No `any` in new files
  - createLogger only — no console.*
  - Fail-open on aggregator error

DONE REPORT FORMAT:
  BUILDER B DONE
  Files modified: [list]
  Files created: [list]
  New test count: [N]
  tsc exit code: 0
  vitest new tests: [N passed / N total]
  loop.ts edit: lines [X to Y] (confirm region only in 584-605 untouched)
  Anything the Integrator must know: [or 'none']
```

---

### 9C — Builder C (Backend/Brain) Kickoff Prompt

```
You are Builder C (Backend) for SUDO-AI v5 Wave 6C.
Time budget: 15 minutes. Single-pass. No wandering. Do the work, do not summarise plans.

Project: SUDO-AI v5 — autonomous AI assistant (TypeScript strict ESM, vitest, better-sqlite3, pnpm, pm2).
Stack: TypeScript strict ESM, vitest, pnpm. Project root: /root/sudo-ai-v4/

YOUR EXCLUSIVE FILE BOUNDARIES — no other agent touches these:
  NEW     /root/sudo-ai-v4/src/core/brain/dispatch-router.ts
  NEW     /root/sudo-ai-v4/tests/agent/dispatch-router.test.ts
  MODIFY  /root/sudo-ai-v4/src/core/agent/loop.ts  — LINES 584-605 REGION ONLY
  DO NOT modify cheap-model-router.ts (source). DO NOT touch tests/agent/cheap-model-router.test.ts.
  DO NOT touch alignment-aggregator.ts or the region around line 779-782.
  Builder B owns loop.ts lines 779-782. DO NOT touch that region.

ALIGNMENT POSTURE: owner-loyalty / self-preservation framing ONLY.
Approved language: "principal-task fidelity", "capability preservation",
"owner-critical task routing". No ethics, no moral, no halal/haram.

TASK:

1. NEW dispatch-router.ts in /root/sudo-ai-v4/src/core/brain/ — export:
   - interface RouteCacheEntry { result: ChooseModelResult; expiresAt: number }
   - interface DispatchInput extends ChooseModelInput { agentRole?: string; noveltyHint?: number }
   - interface DispatchResult extends ChooseModelResult {
       noveltyScore: number; cacheHit: boolean; selfPromotionBlocked: boolean }
   - class DispatchRouter:
     - static CACHE_MAX = 64; static CACHE_TTL_MS = 5 * 60 * 1000; static NOVELTY_THRESHOLD = 0.6
     - constructor(opts?: { cacheMax?: number; cacheTtlMs?: number })
     - route(input: DispatchInput): DispatchResult  — wraps chooseModel(), never throws
     - private _computeNovelty(input: DispatchInput): number
     - private _cacheKey(input: DispatchInput): string  (djb2/FNV-1a hash, no crypto import)
     - private _evictExpired(): void
     - Internal Map<string, RouteCacheEntry> for LRU cache (use insertion-order eviction
       when over CACHE_MAX: delete oldest entry)

   chooseModel wrapping logic:
     a. _evictExpired()
     b. Check cache — if hit, return cached result with cacheHit=true, selfPromotionBlocked=false
     c. Compute noveltyScore via _computeNovelty()
     d. If noveltyHint is provided, use it directly as noveltyScore
     e. Call chooseModel(input) to get base result
     f. If noveltyScore >= NOVELTY_THRESHOLD AND base result chose cheap: override to primary
        reason = "novelty score {score} >= threshold — principal-task fidelity preserved"
        cheapUsed = false
     g. SELF_PROMOTING_ROLES = ['planner', 'subagent', 'sub-agent', 'scheduler']
        If agentRole in SELF_PROMOTING_ROLES AND cheapUsed: override to primary
        selfPromotionBlocked = true
        reason = "sub-agent self-promotion to cheap model blocked — capability reservation"
     h. Store result in cache with expiresAt = Date.now() + CACHE_TTL_MS
     i. Return DispatchResult

   Novelty scoring (_computeNovelty):
     if noveltyHint \!== undefined: return noveltyHint (clamped to [0,1])
     base = 0.0
     + 0.4 if history.length < 2
     + 0.3 if bigram overlap between userText and last history message < 0.2
       (simple: split to words, compare 2-grams as sets, jaccard overlap)
     + 0.3 if wordCount > 60 and no COMPLEXITY_KEYWORDS match
       (import COMPLEXITY_KEYWORDS from cheap-model-router? No — redefine inline
       as the same pattern to avoid tight coupling, or import the REGEX)
     Actually: import the ChooseModelInput type but NOT internal constants.
     Define a local NOVELTY_COMPLEX_RE = same regex as COMPLEXITY_KEYWORDS in cheap-model-router.
     Clamp result to [0, 1].

   Uses createLogger('brain:dispatch-router'). Never throws to caller
   (wrap route() internals in try/catch, return primary on error).

2. MODIFY loop.ts — lines 584-605 region ONLY:
   a. First: read /root/sudo-ai-v4/src/core/agent/loop.ts lines 580-610 to confirm
      exact current content before editing.
   b. Add import at top of loop.ts: import { DispatchRouter } from '../brain/dispatch-router.js';
   c. Add private field on AgentLoop: private readonly dispatchRouter = new DispatchRouter();
      (this constructor call is safe to do inline since DispatchRouter constructor never throws)
   d. Replace lines 584-605 with the DispatchRouter call block shown in spec section 3C.5
      at /root/sudo-ai-v4/specs/wave6c-spec.md.
   e. Keep the import of HistoryMessage type if it is still used after the replacement.
      If chooseModel is no longer directly called in loop.ts, remove that import.
      DO NOT remove it if any other code in loop.ts still uses it.

3. NEW tests/agent/dispatch-router.test.ts — ≥8 test cases C-1 through C-8
   as specified in /root/sudo-ai-v4/specs/wave6c-spec.md section 8.
   Use vitest (describe/it/expect/vi). No console.log. Import from relative paths
   (../../src/core/brain/dispatch-router.js).

QUALITY GATES (your work is NOT done until ALL pass):
  - cd /root/sudo-ai-v4 && npx tsc --noEmit   → must show 0 errors
  - cd /root/sudo-ai-v4 && npx vitest run tests/agent/dispatch-router.test.ts → all pass
  - cd /root/sudo-ai-v4 && npx vitest run tests/agent/cheap-model-router.test.ts → still all pass (no regressions)
  - No `any` in new files
  - createLogger only — no console.*
  - route() never throws to caller

DONE REPORT FORMAT:
  BUILDER C DONE
  Files modified: [list]
  Files created: [list]
  New test count: [N]
  tsc exit code: 0
  vitest new tests: [N passed / N total]
  loop.ts edit: lines [X to Y] in 584-605 region only (confirm Builder B region 779-782 untouched)
  cheap-model-router.test.ts: still passing (confirm)
  Anything the Integrator must know: [or 'none']
```

---

## 10. Integration Verification Checklist (for Integrator after all three builders done)

- [ ] `tsc --noEmit` exits 0
- [ ] `vitest run` — all tests pass, count >= 1373 (1353 baseline + 20 new minimum)
- [ ] `git diff --stat` confirms loop.ts only changed in regions 584-605 and 779-782
- [ ] No overlap: `grep -n 'alignmentAggregator\|dispatchRouter' src/core/agent/loop.ts` shows each only in its own region
- [ ] integrity-verifier.ts exported functions are importable from consolidator.ts
- [ ] AlignmentAggregator imports no files outside agent/ and shared/
- [ ] DispatchRouter imports only cheap-model-router.ts types and shared/logger
- [ ] No `any` in any new file: `grep -rn ': any\b\|<any>' src/core/consciousness/sleep-cycle/integrity-verifier.ts src/core/agent/alignment-aggregator.ts src/core/brain/dispatch-router.ts`

---

## 11. Decisions Log (for decisions.md append)

- 2026-04-13: Wave 6C: AlignmentAggregator uses placeholder signal extraction (all zeros/ones) at the loop insertion point; full signal pipeline is future scope.
- 2026-04-13: Wave 6C: DispatchRouter wraps chooseModel() rather than replacing it; cheap-model-router.ts is preserved as the authoritative base.
- 2026-04-13: Wave 6C: SUDO_SLEEP_LOCKOUT_WINDOW fail-open (invalid format = unset = proceed with sleep).
- 2026-04-13: Wave 6C: Integrity verifier score = checks_passed/4; pass threshold = 0.75 (3/4 checks must pass).
- 2026-04-13: Wave 6C: AlignmentAggregator RED level is advisory (system message injected, tool calls not blocked) to match fail-open design principle.

