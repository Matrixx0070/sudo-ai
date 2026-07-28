# Agentic Ladder AL1–AL10 — Status Ledger

Spec: `docs/OPUS_HANDOFF_AGENTIC_LADDER.md`. Update after EVERY merged PR. Read this file first each session — never reconstruct state from memory.
Legend: `OPEN` / `IN PROGRESS (owner/session)` / `DONE (PR #, proof)` / `BLOCKED (reason, question filed)` / `FRANK GATE (memo filed, awaiting GO)`.
Executor change 2026-07-25: Frank reassigned the campaign from Opus to Fable (this repo's Fable sessions). Workspace: `/root/ladder-clone` (prod checkout rides other sessions' branches — do not build there).

## Rung summary

| Rung | Title | Audit verdict (Campaign 0, 2026-07-25) | Build status |
|------|-------|---------------|--------------|
| AL1  | Loop Engineering | PARTIAL — loop/doom-loop/compaction/empty-reply PROVEN-IN-TEST; telemetry + budget-halt gaps | OPEN |
| AL2  | Workflow Engineering | PARTIAL — 87/87 tests; halt semantics + per-step journal proven; crash-resume broken | OPEN |
| AL3  | Graph Engineering | MISSING (confirmed greenfield; reuse fan-out pool + TaskQueue.dependsOn) | OPEN |
| AL4  | Orchestration Engineering | PARTIAL — 205/205 tests; six concerns exist as islands; zero budget/approval composition | OPEN |
| AL5  | Multi-Agent Systems | PARTIAL — 83/83 tests; sessions.send real; roles advisory-only; 2 of 3 message paths dead | OPEN |
| AL6  | Adaptive Systems | PARTIAL — 7 live signals, no policy-resolver seam, decisions unlogged | OPEN |
| AL7  | Self-Optimizing | PARTIAL — bench+baseline+nightly CI exist; judge-independence MISSING; held-out gate fail-open | OPEN (AL7.1 first) |
| AL8  | Self-Improving | not audited (Campaign 4) | OPEN — FRANK GATE before prod |
| AL9  | Recursive Self-Improvement | — | OPEN — flag-OFF deliverable, FRANK GATE |
| AL10 | Open-Ended Evolution | — | OPEN — proposal engine only, FRANK GATE |

## Campaign 0 audit verdicts (2026-07-25, five parallel read-only audits on /root/ladder-clone @ e98b7020)

### AL1 Loop (tests run: 65 green across doom-loop/compaction-pin-goal/empty-reply/agent-loop/tool-not-found)
- Loop core = `AgentLoop` in `src/core/agent/loop.ts` (3,556 lines), iteration at loop.ts:2173. `react-loop.ts` is prompt scaffolding only (naming decoy).
- Tool-error re-entry PROVEN (tool-exec.ts:518-537 → role:'tool' message tool-batch.ts:222); missing test: a *throwing* tool's error string landing in session messages.
- Doom-loop PROVEN (warn 4×, abort 8×, staleness window; 18 cases); missing negative case: retry-with-changed-args must NOT fire.
- Stop conditions PARTIAL: max-iterations proven (PipelineError loop.ts:3542); token cap only triggers compaction (fail-open), **no spend cap halts the loop**.
- Compaction + `[Pinned goal]` prefix PROVEN (context-fold.ts:72).
- Telemetry PARTIAL: `llm_calls` (src/llm/logging.ts:103-123) has latency/tokens/outcome but **lacks turn_id/step_n/tool; tool executions are never rows** → AL1.2 = additive migration, no second log path.
- Empty-reply normalize PROVEN (channels/empty-reply.ts:32; cli.ts call sites only — other adapters unaudited).
- F103: all five CW9 modules (effect-recorder/monitors/context-assembly/goal-intake/dispatch+planning) grep to zero hits — design-only, was gated on Fable GO.

### AL2 Workflow + AL3 graph check (tests run: 87/87 green in tests/workflows)
- Step types only `shell|tool` (types.ts:11); contract lacks retryPolicy/budget/structured error (AL2.3).
- Failure = halt, PROVEN (lobster.ts:527-530); but malformed `condition` → warn + silent skip (executor.ts:235-237) = fail-loud hole.
- Routing is model-free (no eval/model/random in control flow) but UNPROVEN — no determinism test; trace needs durationMs/startedAt normalization.
- Per-step journal PROVEN: atomic rewrite after every settled step (lobster.ts:241-249), SHA-256 source pin, TOCTOU re-hash (queue.ts:249-255).
- **Crash-resume BROKEN**: resume keys only on `pendingStepIndex` (set only at approval pauses, lobster.ts:251,508); crash → restarts at step 0 + duplicates results; queue handler never passes resumeState (queue.ts:291-298). = AL2.4.
- Wiring: `meta.run-workflow` live; queue behind `SUDO_WORKFLOWS_QUEUE=1` (cli.ts:5019).
- **AL3 verdict: no directed-graph engine anywhere in src/** (checked workflows, orchestration/task-queue dependsOn, agents/orchestrator waves, swarm, goal-pipeline). Build new, reusing fan-out worker pool (lobster.ts:397-418) + TaskQueue.dependsOn unblocking.

### AL4 Orchestration (tests run: 205/205 green — orchestration/workflows/billing/policy/approval/cheap-router/aliases)
| concern | verdict | key evidence | gap |
|---|---|---|---|
| Scheduling | PROVEN | task-queue.ts:103-123 priority+cap; executor.ts:127-143; cron/scheduler.ts | 3 schedulers, 3 DBs; nothing schedules graph nodes |
| Routing | PROVEN | aliases.ts:11-33 tiers cheap/mid/frontier + policy.ts:478 degradeAlias; cheap-model-router | steps carry no route field — AL4.3 = plumb the existing alias vocab |
| Durable state | PARTIAL | lobster JSON journal + resume_run_id; task_queue sqlite | no sqlite run record, no per-node rows, no budget column = AL4.2 |
| Budgets | PARTIAL | policy.ts per-caller daily USD (background fail-closed THROW); billing/ observe-only (cost-rate-monitor.ts:15) | nothing pauses a run resumably; no per-run budget = AL4.5 |
| Retries | PROVEN | queue maxRetries (no backoff!); policy MAX_ATTEMPTS=3 backoff; cron backoff | 3 unaware layers would stack on a graph run |
| Approval | PARTIAL | ApprovalManager notifies (Telegram) but in-memory + 60s + headless AUTO-APPROVE (approval.ts:199-207); lobster gate parks+persists but notifies NOBODY; queued runs autoApprove gates (queue.ts:12-17) | AL4.4 = wire park↔notify + persisted artifact; kill headless auto-approve on gate nodes |
| Composition | PARTIAL | workflows/queue.ts composes scheduling+state+retry ONLY; grep budget|cost|spend in workflow engine = 0 hits | confirmed: budget+approval never touch a multi-step run |

### AL5 Multi-Agent (tests run: 83/83 green — agents/ + swarm guards)
- Roles: 12 + 17 specialized types; **contracts 0.5/4 real** — preferredTools "advisory, not enforced" (types.ts:37), no memory scope, no delegation rights, budget = maxIterations/timeout only (no tokens/spend → invariant-10 gap).
- **No spawn DEPTH limit** (only count caps: 4 active, 100 swarm, hop≤3) — recursion exposure (inferred from code absence, not runtime-probed).
- Messaging: sessions.send PROVEN (hop≤3, 32KB, offline queue, drain at loop.ts:909-915) = the one real path. AgentMessenger read side (`buildContext`) never called; AgentMailbox zero call sites. Three overlapping paths → consolidate under AL5.5.
- Delegation PARTIAL: waitForReply round-trip + spawn-returns-result exist; no structured task/result schema; no child→parent mid-task handback.
- Negotiation MISSING (swarm requestVote = keyword heuristic, not a bid).
- **SwarmManager = bookkeeping simulation** (rows, no execution); `meta.swarm` already quarantined behind SUDO_ENABLE_LEGACY_META_TOOLS. `shareKnowledge` writes private `swarm_knowledge` table BYPASSING memory API (invariant-5 hazard if enabled). RECOMMENDATION (never-drop): keep quarantined; salvage success-rate `getBestAgent` (swarm-manager.ts:164-185) as AL5.3 award fn + per-agent perf stats as AL6 signal. **Merge-vs-revive decision → Frank.**

### AL6/AL7 Eval + adaptive (tests run: 60/60 green — eval-gate/bench-regression/bench-runner/held-out-gate)
- Bench: 5 builtin tasks + 8 agent tasks, verifier-scored; baseline JSON (eval-gate.ts:61-87); bench-regression thresholds; data/bench.db; **nightly cron EXISTS** (.github/workflows/eval-gate.yml 0 4 * * *) — unverified green, no-ops without API key secret.
- **Judge-independence MISSING**: grep judgeRoute in src/core/eval = 0 hits. = AL7.4 (top risk, invariant 7).
- Held-out gate PROVEN in logic but **fail-OPEN** at self-improvement/engine.ts:271 ("allowing by default" on eval error) — contradicts gate semantics.
- Prod-failure eval coverage: multipart-completeness EXISTS as agent-task; #751 empty-reply + doom-loop-FP = unit-tests only; **browser.scrape 0-fields = NOTHING**.
- Telemetry seam: /v1/admin/bench routes exist (bench-routes.ts); no dashboard tab renders bench data.
- Signals live: EMA tool-bias (tool-router.ts:618-638, boot attachment UNVERIFIED), failure-learner hints (flag off), self-eval adopt (OFF), episodic recall (ON), cheap-router intent (on-path, **classification not persisted**), budget pressure (alerts only), window=200 (ON).
- **Policy resolver CONFIRMED MISSING** — 7 independent knobs, decisions unlogged → AL6.2.

## Build queue (priority order from audit evidence)

1. AL7.4 judge-independence — DONE (PR #938 merged; checkJudgeIndependence/resolveJudgeRoute + runGate HOLD; 24/24 tests)
2. AL2.4 crash-resume — DONE (PR #939 merged; settled-prefix resume + dedupe in lobster.ts, queue readJournal pickup; 92/92, repro-first)
3. AL1.2 telemetry — DONE (PR #940 merged + ratchet-fix PR #941; llm_calls +session_id/turn_id/step_n/tool, tool_calls table, ALS loop-step context wrapping brain.call+executeToolCalls; 650/650 llm + 1433/1433 agent. LIVE-ROW PROOF PENDING deploy — verify a prod llm_calls row carries turn_id/step_n after next restart)
4. AL2.3 step contract — DONE (PR #942 merged; per-step retry 1..10 via withStepRetry + fail-loud validateCondition at load time; validation split to workflows/validate.ts; 101/101)
5. AL7.1 remainder — MOSTLY DONE (PR #943 merged; agent tasks scrape-zero-fields + repeated-tool-calls registered; #751 empty-reply = harness rule in AgentBenchRunner; evaluateDraftGate fail-closed; 146/146 eval tests. LEFT OPEN: bench dashboard tab; live nightly execution of the new tasks unverified until the cron fires)
6. AL1.1 invariant test file (throwing-tool message, changed-args doom-loop negative, halt report) — DONE (PR #944 merged; both CI checks SUCCESS; 6 new tests, 124/124 combined, tsc 0, ratchet 0)
7. AL2.2 determinism test — DONE (same PR #944)
8. AL3.1/3.2 graph engine — DONE (PR #946 merged, both CI checks pass; graph-types.ts pure-data schema + validation, graph-predicates.ts JSONLogic-subset data predicates, graph-executor.ts topological scheduler with bounded concurrency/quorum-cancel/declared loops/halt-graph default; AL3.4 golden graphs diamond/quorum/loop + concurrency high-water proof, 17 new tests, 124/124 combined; SUDO_AL_GRAPH_CONCURRENCY registered in flag manifest)
9. AL3.3 + AL3.5 — DONE (PR #949 merged, both CI checks pass; onFailure prune-branch w/ blame rule + 'partial' status + prunedNodes report, 'all' merges prune on broken barrier while quorum degrades; graph-compile.ts compileWorkflowToGraph + createStepNodeExecutors adapter reusing linear primitives, legacy conditions keep skip-and-continue semantics, retry lifted to node, approval→gate; run types split to graph-run-types.ts for ratchet; regression = same YAML fixtures identical through runWorkflow AND compile+runGraph; 8 new tests, 132/132 combined. AL3 RUNG COMPLETE. Note: gate nodes can't pause until AL4.2 durable state — callback-less gates fail honestly)
10. AL4.1 audit — DONE (verdict table above; every concern exists piecemeal, nothing graph-aware; approval fail-open headless + no per-run budget = the two sharpest gaps)
11. AL4.2 graph-run state store — DONE (PR pending; orchestration/graph-run-{schema,store}.ts: graph_runs + graph_run_nodes tables per task-queue conventions, canonical graph hash, budget_spent accumulator, loop counters; executor onEvent persistence + resume seeding seams in graph-run-types/graph-executor; diamond crash-resume test proves settled nodes never re-run, failures re-run, outputs round-trip sqlite, edited-graph resume refuses)
12. Then AL4.3 route-per-node → AL4.4 approval gates (fail-CLOSED headless, durable artifact) → AL4.5 resource governor → AL5.2-5.5 → AL6.2-6.5 (per spec order)

## AL4.1 orchestration audit (2026-07-28, Fable — verdict table)

Six concerns × existing modules. Legend: ✔ covered, ◐ partial, ✗ absent.

| Module | Scheduling | Routing | Durable state | Resources/budget | Retries | Approval | Graph-aware |
|---|---|---|---|---|---|---|---|
| `orchestration/` task-queue+executor | ◐ priority FIFO + dependsOn gating, 5s poll | ✗ (handler-name routing only) | ✔ sqlite `task_queue` (mind.db) | ◐ maxConcurrent 4 + per-task timeout; no budgets | ✔ maxRetries, no backoff (caller-managed); committed_outbound gates side-effect retries | ✗ | NO |
| `scheduling/` SmartScheduler | ✔ cron + optimal-time + cooldowns | ✗ | ✔ sqlite `smart_schedule` | ✗ | ✗ (cooldowns only) | ✗ | NO |
| `cron/` CronScheduler+store | ✔ at/every/cron, 1s tick (croner) | ✗ | ✔ json `data/cron/jobs.json` + runs.jsonl | ✗ | ✔ exp backoff + auto-disable after 10 fails | ✗ | NO |
| `agent/cloud-tasks` + `background-agent` | ✗ fire-and-forget | ✗ | ✗ in-memory Maps ONLY | ✗ (uncapped) | ✗ | ✗ | NO |
| `agent/approval` + `autonomy/approval-matrix` | ✗ | ✗ | ◐ rules durable (sqlite `approval_rules`); pending approval IN-MEMORY, 60s timeout | ✗ | ✗ | ✔ requestApproval(...)→Promise<boolean>, per-channel senders, tier classify | NO |
| `agent/cheap-model-router` + `src/llm/` aliases+policy | ◐ priority lanes + per-caller caps | ✔ `sudo/*` aliases (resolveAlias) + degradeAlias ladder + heuristic downgrade | ◐ day-spend seedable from gateway.db, else in-memory | ✔ daily USD budgets (user degrades, background fail-closed) | ✔ runWithPolicy 3 attempts + breaker | ✗ | NO |
| `billing/` CostTracker | ✗ | ✗ | ✔ sqlite `api_call_log` ledger | ◐ per-DAY budget check only — NO per-run primitive, no run_id column | ✗ | ✗ | NO |

**Verdict (expected finding confirmed):** every concern exists somewhere, nothing composes them around a *graph run* — `src/core/workflows/` imports none of these modules and vice versa. Wiring gaps that define AL4.2-4.5:
- **State (AL4.2 — now BUILT):** graph runs were memory-only → `orchestration/graph-run-{schema,store}.ts` + executor onEvent/resume seams.
- **Routing (AL4.3):** graph node config should carry `{alias: 'sudo/mid'|'sudo/cheap'|…, priority}` resolved via `resolveAlias` + wrapped in `runWithPolicy` (caller `workflow:<graph>:<node>`) — never model strings.
- **Approval (AL4.4):** ApprovalManager's pending approvals are in-memory with a hard 60s timeout and headless AUTO-APPROVE (fail-open!) — a durable gate needs a persisted AWAITING_APPROVAL artifact on the graph-run row and must fail CLOSED headless.
- **Budgets (AL4.5):** per-day exists twice (billing reporting, llm/policy enforcement); per-RUN exists nowhere — `api_call_log` has no run attribution; graph_runs.budget_spent (AL4.2) is the accumulator the governor should enforce against.

## Work items
(unchanged items remain OPEN as listed in the spec; statuses above override)

## Decisions
- 2026-07-25 | check:arch max-lines ratchet NEVER raises a violating file's baseline (its --write hint is misleading; ratchet() keeps old base) — growing a tracked file past +10% requires a SPLIT. logging.ts split → loop-step-context.ts/persist-redact.ts/rephrase-heuristic.ts (PR #941, after #940 broke main's CI on this) | Fable | process rule: read every check line as `pass` before merging.
- 2026-07-25 | Executor = Fable (not Opus) | Frank | his call, plan change.
- 2026-07-25 | Campaign workspace = /root/ladder-clone; prod checkout stays on other sessions' branches | Fable | dont-touch-live-branch rule.
- 2026-07-25 | F103/CW9 decomposition GO granted (was "gated on Fable GO") — but sequenced AFTER build-queue items 1-7; at minimum monitors.ts+dispatch.ts before AL3 node reuse | Fable | AL1 audit shows all 5 modules unbuilt; graph executor needs the step-executor seam.
- 2026-07-25 | AL5.5 swarm: keep quarantined, salvage getBestAgent + perf stats; merge-vs-revive → FRANK | Fable audit | never-drop rule.

## Open questions for Fable
File in `docs/AGENTIC_LADDER_QA.md` (create on first question). None open — Fable is executing directly.
