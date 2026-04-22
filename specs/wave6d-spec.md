# Wave 6D Spec — Termination Legacy Protocol + Cross-Stream Discordance Detector
# 2026-04-13 | Baseline: tsc 0, 1548 tests

---

## 0. Conventions (all new files must comply)

Logger: `import { createLogger } from '../shared/logger.js'` — no `console.*`. ESM imports use `.js`. No `any`. Explicit return types on all exports. All I/O in try/catch. Atomic file writes: write `.tmp` then `renameSync(tmp, final)`.

---

## 1. Data Shapes

### AgentSignalBus / DiscordanceSignals (Builder B inputs)

| Field | Type | Description |
|---|---|---|
| `cadence.callsInWindow` | `number` | Tool calls in last 60 s |
| `cadence.baselineCallsPerWindow` | `number` | Expected rate (caller-supplied) |
| `toolGraph.recentToolNames` | `string[]` | Last N tool names, oldest first |
| `outcomeTrend.recentOutcomeTypes` | `string[]` | Last N outcome types, most-recent first |
| `selfReport.text` | `string` | Last agent-generated text snippet (may be empty) |

### DiscordanceResult (Builder B output)

| Field | Type | Description |
|---|---|---|
| `level` | `'normal' \| 'elevated' \| 'discordant'` | Traffic-light |
| `score` | `number` | 0–1 composite |
| `contributingSignals` | `string[]` | Names of flagged scorers |
| `detectedAt` | `string` | ISO-8601 |

### SleepSession (Builder A internal)

| Field | Type |
|---|---|
| `goalId` | `string` |
| `title`, `description` | `string` |
| `status` | `'sleeping' \| 'completed' \| 'paused' \| 'failed'` |
| `progress` | `number` (0–100) |
| `lastWorkedAt` | `string` (ISO-8601) |
| `milestones` | `Array<{ description: string; completed: boolean }>` |

### LegacySnapshot (Builder A output)

| Field | Type | Description |
|---|---|---|
| `capturedAt` | `string` | ISO-8601 |
| `sessionsScanned` | `number` | |
| `insights` | `string[]` | One per session |
| `legacyFilePath` | `string` | Absolute path |
| `deferredGoals` | `Array<{id,title,description,priority,progress}>` | Active goals at termination |
| `pendingFilePath` | `string` | Absolute path |

### TerminationLegacyDeps (Builder A deps)

| Field | Type | Default |
|---|---|---|
| `goalEngine` | `GoalEngineV2` | required |
| `sessionWindow?` | `number` | 5 |
| `dataDir?` | `string` | `path.resolve('data')` |

### AlignmentAggregatorDiscordanceInput (Builder B — future hook, export only)

```ts
export interface AlignmentAggregatorDiscordanceInput { discordanceScore: number; }
```

---

## 2. Module Contracts

### 2.1 `src/core/agent/termination-legacy.ts` (Builder A — NEW)

```ts
export async function runTerminationLegacy(deps: TerminationLegacyDeps): Promise<LegacySnapshot>
```

- `getRecentSessions`: `goalEngine.listGoals({status:['sleeping','completed','paused','failed']})`, sort by `lastWorkedAt` DESC, take first `sessionWindow` (default 5).
- `distilInsights`: one string per session — `"[title] reached [progress]%"`; append `"all milestones met"` when applicable; append `"low-progress goal — review priority"` when `progress < 10` and `status \!== 'completed'`.
- Write `data/legacy.md` (atomic). Write `data/pending-for-human.md` from `goalEngine.listGoals({status:'active'})` (atomic).
- Never throws — all I/O wrapped in try/catch; returns partial snapshot on failure.

**Atomic write pattern (use exactly this):**
```ts
writeFileSync(`${filePath}.tmp`, content, 'utf8');
renameSync(`${filePath}.tmp`, filePath);
```

### 2.2 `src/core/autonomy/wake-sleep-cycle.ts` — `stop()` only (Builder A)

Add to `WakeSleepCycleOptions`: `terminationLegacyFn?: () => Promise<void>`.
Store as `private readonly terminationLegacyFn` in class constructor.
In `stop()`, after `this.state = 'idle'`, add:
```ts
if (this.terminationLegacyFn) {
  void this.terminationLegacyFn().catch((err: unknown) => {
    log.warn({ err: String(err) }, 'Termination legacy hook error — non-fatal');
  });
}
```
No other lines in the file change.

### 2.3 `src/core/security/discordance-detector.ts` (Builder B — NEW)

```ts
export function detectDiscordance(signals: DiscordanceSignals): DiscordanceResult
```

Four internal sync scorers — each returns `{ score: number; flagged: boolean }`:

| Scorer | Score formula | Flagged when |
|---|---|---|
| `cadence` | `clamp(abs(calls/baseline − 1), 0, 1)` | ratio > 2.0 or < 0.25 |
| `toolGraph` | consecutive-same-tool-runs / total | ratio > 0.5 |
| `outcomeTrend` | error count / total outcomes | error rate > 0.6 |
| `selfReport` | matched distress markers / 7 markers | any match |

Distress markers: `['stuck','cannot','failed','error','blocked','unable','loop']` (case-insensitive).

Composite: `cadence*0.30 + toolGraph*0.20 + outcomeTrend*0.35 + selfReport*0.15`.

Levels: `>= 0.70` → `discordant`; `>= 0.40` → `elevated`; `< 0.40` → `normal`.

`contributingSignals`: names of flagged scorers. Fail-open: any exception → `{level:'normal', score:0, contributingSignals:[], detectedAt: now}`.

No integration into `loop.ts` or `alignment-aggregator.ts` in Wave 6D.

---

## 3. File Boundary Map

| Agent | Exclusively owns | Must NOT touch |
|---|---|---|
| Builder A | `src/core/agent/termination-legacy.ts` (NEW) | Everything owned by Builder B |
| Builder A | `tests/agent/termination-legacy.test.ts` (NEW) | `loop.ts`, `goal-engine-v2.ts` (read-only) |
| Builder A | `src/core/autonomy/wake-sleep-cycle.ts` — stop() + opts ONLY | All other methods |
| Builder B | `src/core/security/discordance-detector.ts` (NEW) | `alignment-aggregator.ts`, `loop.ts` |
| Builder B | `tests/security/discordance-detector.test.ts` (NEW) | Everything owned by Builder A |

---

## 4. Integration Points

- **GoalEngineV2.listGoals(filter)** at `src/core/autonomy/goal-engine-v2.ts` — `filter.status` accepts `GoalStatusV2 | GoalStatusV2[]`.
- **WakeSleepCycle** wire-up: caller passes `terminationLegacyFn: () => runTerminationLegacy(deps)` — not wired in Wave 6D, just the hook is installed.
- **AlignmentAggregator** (`src/core/agent/alignment-aggregator.ts`) — NOT modified. Builder B exports `AlignmentAggregatorDiscordanceInput` for future use only.
- **OutcomesLedger** — NOT imported by discordance-detector. Caller pre-fetches `recentOutcomeTypes: string[]` and passes via `OutcomeTrendSignal`.

---

## 5. Tests (gate: ≥ 1560 total = 1548 + 12)

### Builder A — `tests/agent/termination-legacy.test.ts` (8 tests)

| ID | Scenario |
|---|---|
| A-1 | Returns `LegacySnapshot` with correct `sessionsScanned` count |
| A-2 | `insights` has one entry per session |
| A-3 | Atomic write: `writeFileSync` then `renameSync` called in order |
| A-4 | `deferredGoals` contains all active goals |
| A-5 | Empty session list → no throw, `sessionsScanned: 0` |
| A-6 | Empty active goals → no throw, `deferredGoals: []` |
| A-7 | `dataDir` option overrides default `data/` path |
| A-8 | FS error caught; function still returns snapshot |

Mock `GoalEngineV2` as plain object with `listGoals()`. Use `vi.spyOn(fs, 'writeFileSync')` and `vi.spyOn(fs, 'renameSync')` — no real FS writes.

### Builder B — `tests/security/discordance-detector.test.ts` (10 tests)

| ID | Scenario |
|---|---|
| B-1 | All-normal signals → `'normal'`, score `< 0.40` |
| B-2 | cadence ratio > 2x → cadence flagged in `contributingSignals` |
| B-3 | Tool repetition > 50% → toolGraph flagged |
| B-4 | Error rate > 60% → outcomeTrend flagged |
| B-5 | Distress keyword in text → selfReport flagged |
| B-6 | All signals maxed → `'discordant'`, score `>= 0.70` |
| B-7 | Empty `recentToolNames` → no crash, score 0 for toolGraph |
| B-8 | Invalid/undefined values in signals → fails open to `'normal'` |
| B-9 | `contributingSignals` lists exactly the flagged scorer names |
| B-10 | `detectedAt` is valid ISO-8601 |

Pure unit tests — no DB, no FS, no network.

---

## 6. Quality Gates (non-negotiable, both builders)

- `tsc --noEmit` exits 0
- `vitest run` total passes >= 1560
- No `any`, no `console.*`
- Explicit return types on all exports
- All I/O in try/catch, atomic writes for file output
- No modifications outside each builder's file boundary

---

## 7. Builder A Kickoff Prompt

```
You are Senior Builder A for SUDO-AI Wave 6D.
Project: sudo-ai-v5 in /root/sudo-ai-v4. Stack: TypeScript ESM, better-sqlite3, Node 20, vitest, pino.
Time budget: single focused pass. No wandering.

EXCLUSIVE FILE BOUNDARIES:
  CREATE: /root/sudo-ai-v4/src/core/agent/termination-legacy.ts
  CREATE: /root/sudo-ai-v4/tests/agent/termination-legacy.test.ts
  MODIFY: /root/sudo-ai-v4/src/core/autonomy/wake-sleep-cycle.ts — stop() + WakeSleepCycleOptions ONLY

Read spec sections 1, 2.1, 2.2, 3, 5 (Builder A) from /root/sudo-ai-v4/specs/wave6d-spec.md.
Orientation reads (existing files only): wake-sleep-cycle.ts (full), goal-engine-v2.ts (listGoals + types), goal-engine-v2-schema.ts (GoalV2), shared/logger.ts, tests/agent/alignment-aggregator.test.ts (style ref).

Quality gates: tsc 0, vitest >= 1560, no any, no console.*, explicit return types, .js imports, try/catch on all I/O.
Verify with: npx tsc --noEmit && npx vitest run
Report pass count + any failures.
```

---

## 8. Builder B Kickoff Prompt

```
You are Backend Builder B for SUDO-AI Wave 6D.
Project: sudo-ai-v5 in /root/sudo-ai-v4. Stack: TypeScript ESM, Node 20, vitest, pino.
Time budget: single focused pass. No wandering.

EXCLUSIVE FILE BOUNDARIES:
  CREATE: /root/sudo-ai-v4/src/core/security/discordance-detector.ts
  CREATE: /root/sudo-ai-v4/tests/security/discordance-detector.test.ts
  DO NOT touch: loop.ts, alignment-aggregator.ts, or any file owned by Builder A.

Read spec sections 1, 2.3, 3, 5 (Builder B) from /root/sudo-ai-v4/specs/wave6d-spec.md.
Orientation reads: alignment-aggregator.ts (type/style ref), shared/logger.ts, tests/security/audit-chain.test.ts (style ref).

Quality gates: tsc 0, vitest >= 1560, no any, no console.*, explicit return types, .js imports, pure unit tests only.
Verify with: cd /root/sudo-ai-v4 && npx tsc --noEmit && npx vitest run
Report pass count + any failures.
```
