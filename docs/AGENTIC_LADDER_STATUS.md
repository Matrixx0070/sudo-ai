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
11. AL4.2 graph-run state store — DONE (PR #950 merged, both CI checks pass; orchestration/graph-run-{schema,store}.ts: graph_runs + graph_run_nodes tables per task-queue conventions, canonical graph hash, budget_spent accumulator, loop counters; executor onEvent persistence + resume seeding seams in graph-run-types/graph-executor; diamond crash-resume test proves settled nodes never re-run, failures re-run, outputs round-trip sqlite, edited-graph resume refuses)
12. AL4.3 route-per-node — DONE (PR #951 merged, both CI checks pass; workflows/graph-routing.ts: config.route = reasoning|cheap|sudo/* alias resolved ONLY via resolveAlias, raw model strings throw at load time (validateGraphRoutes); createRoutedAgentExecutor wraps the model-call seam in runWithPolicy, caller workflow:<graph>:<node>, background lane fail-closed, maxAttempts=1 so graph retry never stacks with policy retry; unrouted defaults sudo/cheap)
13. AL4.4 approval gates — DONE (same PR #951; graph_run_approvals durable artifact + awaiting_approval status vocab + NodeOutcome.park; orchestration/graph-approval.ts createApprovalGateExecutor: approved→pass-through, denied→honest failure, absent→artifact+notify-once+park resumable via AL4.2 store; HEADLESS PARKS — ApprovalManager's auto-approve hole NOT inherited, invariant 8 held; 8 tests, 153/153 combined)
14. AL4.5 resource governor — DONE (PR #952 merged, both CI checks pass; executor pause seam → resumable 'paused' status + pauseReason; orchestration/graph-governor.ts runGovernedGraph = the governed entry point: per-run token budget (resume-inclusive), per-day USD via injected billing reader (declared ceiling w/o reader FAILS CLOSED), alert seam fired once on pause, terminal status ALWAYS persisted (no stranded 'running' rows); store.listRuns() = telemetry per-run spend surface, tab render deferred into the open AL7.1 dashboard slice; loop machinery split to workflows/graph-loops.ts; 4 tests, 157/157. **AL4 RUNG COMPLETE** — invariant 10 held)
15. AL5.2 role contracts — DONE (PR #953 merged, both CI checks pass; agents/contracts.ts: per-role capabilities/knowledgeScope/delegationRights/budget derived from roles.ts + deliberate minimal overrides (architect→researcher, debugger→tester, tester restricted messaging); ENFORCED: AgentSpawner rejects unauthorized spawns pre-work with actionable errors, GLOBAL_MAX_SPAWN_DEPTH=3 closes the audit's recursion exposure, AgentMessenger enforces message rights when role metadata present (id-only sends stay back-compat), assertToolAllowed/assertKnowledgeScope primitives for tool + memory-tier gating)
16. AL5.3 negotiation — DONE (same PR #953; agents/negotiation.ts contract-net over the EXISTING AgentMessenger — task-offer/bid/award message types added to types.ts; author-side bids fail-loud, peer bids untrusted (malformed/ineligible skipped+warned+counted, never silent); deterministic award (confidence desc, cost asc, agentId); award broadcast = auditable log; no-bids → null, offerer decides fallback. This is AL6's adaptive-routing seam)
17. AL5.4 shared-knowledge discipline — DONE (same PR #953; import-bans.test.ts gains 'agent modules must not import memory internals directly' over src/core/agents + src/core/swarm; sanctioned surface = memory/index barrel + memory/injection-scanner guard; green at introduction)
18. **AL5.5 swarm decision — RECOMMENDATION FILED, FRANK GATE.** Campaign-0 + AL5 build evidence: swarm/swarm-manager.ts is a bookkeeping simulation (rows, no execution), already quarantined behind SUDO_ENABLE_LEGACY_META_TOOLS; its shareKnowledge writes a private swarm_knowledge table BYPASSING the memory API (invariant-5 hazard if ever enabled) — now also caught by the AL5.4 import ban if it were rewired. RECOMMENDATION (never-drop rule — no deletion): (a) keep quarantined as-is; (b) salvage getBestAgent success-rate scoring (swarm-manager.ts:164-185) as the AL5.3 award function's future signal source + per-agent perf stats as an AL6 signal; (c) swarm_knowledge writes must migrate to the memory API before any revive. **Merge-vs-revive → Frank's call; no action until GO.**
19. AL5.1 live two-agent drive — OPEN (needs a deliberate live-verify slot: spawns real LLM calls = real spend, and Frank's no-autonomous-spend posture applies; module verdicts already filed by Campaign 0. When GO'd: orchestrator spawns researcher+builder, ≥2 messages via bus, delegated sub-check, result through memory API, message log cited)
20. AL6.2-6.5 core — DONE (PR #954 merged, both CI checks pass; agent/policy-resolver.ts = the single seam {route hint, maxRetries, concurrency, reasoningDepth, deferBackground} with EVERY decision logged with its inputs (log + injectable sink; sink failures never break the path); AL6.3 load-shed latch w/ enter/exit hysteresis (SUDO_AL_LOAD_HIGH/LOW default 8/3, SUDO_AL_BUDGET_HIGH/LOW 0.9/0.7), flap test green; AL6.4 classifyIntent extracted from cheap-model-router with behavior preserved (21 existing router tests untouched-green), classification now logged + carried on ChooseModelResult.intent = evaluable; AL6.5 SUDO_AL_POLICY_SHADOW=1 shadow mechanics: computed+logged+marked-not-applied. LEFT OPEN: knob migration (7 knobs → thin per-knob delegation PRs, no behavior change each), decision-log sqlite persistence, and PROMOTION — needs ≥3 days prod shadow traffic; comparison query below)
21. AL6 knob migrations + decision persistence — DONE (PR #955 merged, both CI checks pass after one unrelated tests/acp flake rerun; agent/policy-decision-log.ts = policy_decisions table in gateway.db beside llm_calls, comparison-query column names, fire-and-forget sink; shared PolicyResolver singleton + attachSharedDecisionSink; KNOB 5 (intent/cheap-router) now CALLS THROUGH the seam every routed turn — application stays on the legacy conversational→cheap rule until AL6.5 promotion, divergences logged not applied (shadow-first held even for the shed policy); KNOB 4 (budget pressure) streams from runGovernedGraph per spend event, logged only. Knobs 1/2/6/7 (EMA tool bias, failure-learner, episodic recall, window size) DON'T FIT the current decision shape {route,retries,concurrency,depth,defer} — migrate when the shape grows to cover tool-selection/context knobs, recorded here rather than force-fit. PROD WIRING NEEDED at boot: attachSharedDecisionSink(new PolicyDecisionLog().createSink()) in cli startup — one line, rides the next prod-touching PR)
22. AL7.1 bench dashboard panel + AL4.5 telemetry render + AL6 boot wiring — DONE (PR #956 merged, both CI checks pass; gateway/dashboard-bench.ts Bench & Graph Runs panel on the LIVE inline admin dashboard (/v1/admin/dashboard) — bench runs from /v1/admin/bench, per-run graph spend + pending gate approvals from NEW gateway/graph-runs-routes.ts (/v1/admin/graph-runs + /approvals, bench-routes pattern, /v1/admin prefix pre-allowlisted); cli boot: GraphRunStore('data/mind.db') fail-open + **PolicyDecisionLog sink ATTACHED** (the AL6 one-liner — prod decisions now persist to gateway.db once deployed); DASH-10 size ratchet EXPLICITLY raised 54,272→57,856 for the deliberate +3.6KB panel (30KB debt retained, documented in-test); DASH-16 panel assertion added. NOTE: the "Telemetry tab" concept resolved to a PANEL — the live dashboard is single-page/section-based, no tab mechanism exists; panel = the idiomatic unit)
23. **AL5.5 — DECIDED: MERGE-SALVAGE** (2026-07-28, decided by Fable under Frank's delegated authority — chat: "Go ahead i will allow you make decisions behalf of frank"). Executed (PR #957 merged, both CI checks pass): agents/agent-stats.ts AgentPerfTracker lifts the swarm's ONE proven idea (getBestAgent: success_rate DESC, tasks_completed DESC) into the live layer — Laplace-smoothed rates (unknown agent = neutral 0.5 prior), bestAgent() preserves the salvaged ordering, failureRate() feeds AL6 PolicySignals.recentFailureRate. awardTask gains optional stats: score = confidence × smoothed rate (without stats: byte-identical legacy semantics, test-pinned). IN-MEMORY BY DESIGN — the swarm's private sqlite table was the invariant-5 hazard; durable stats must ride the memory API. swarm/ stays quarantined UNTOUCHED (never-drop); revive remains off the table unless a new need appears, and swarm_knowledge→memory-API migration is the precondition if it ever does.
24. Decisions under the same delegation: (a) Campaign-0's "held-out gate fail-OPEN at engine.ts:271" is a STALE finding — already repaired in #943 (evaluateDraftGate fail-closed, verified in-tree 2026-07-28); (b) AL8-10 capability builds stay HELD — the spec's own order requires the Campaign-4 audit first; a general delegation is not a substitute for that process step; (c) AL5.1 live drive SCHEDULED into the post-deploy live-verify slot (clone has no prod creds; prod checkout owned by another session) — batch with AL1.2 live-row proof.
25. Remaining: prod-dependent (deploy → AL1.2 live rows + policy_decisions persistence + panel live-verify + AL5.1 live drive → AL6.5 shadow promotion after ≥3d) / Campaign-4 AL8 audit → then AL8-10 per spec order.
26. **CAMPAIGN 4 / AL8.1 AUDIT — DONE** (2026-07-28, two parallel read-only audits; full verdicts below). CORRECTION to item 24(a): the fail-open finding was only HALF-stale — #943 fixed `evaluateDraftGate` (fail-closed) but the generic `shouldApply` helper (engine.ts:361-365) is STILL fail-OPEN ("allowing improvement by default" on eval error). Currently unreachable in prod (no caller passes a heldOutGate) but a live landmine for AL8.2.

## Campaign 4 — AL8.1 audit verdicts (2026-07-28, Fable, read-only)

### Improvement loop (self-improvement/) — live data flow
```
TRIGGER: meta.self-improve tool call ONLY (manual; "weekly cron" in engine.ts:4 is a comment — no cron exists)
  → detectPatterns (pattern-detector.ts:73, mind.db: failing tools/feedback/routing/cron/health)
  → GENERATE: LEARNINGS.md block (real, engine.ts:368-392 → system-prompt.ts:732 injection)
              routing-hint drafts → data/improvement-drafts/ (WRITE-ONLY, nothing reads back)
              AutoResearch prose (DEAD in live wiring — caller passes brain:undefined, self-improve.ts:195)
  → VALIDATE: HeldOutGate seam EXISTS but the only caller NEVER passes one (self-improve.ts:197) → all shouldApply()==true unvalidated
              evaluateDraftGate fail-CLOSED (#943) but unreachable; shouldApply (engine.ts:338-366) fail-OPEN — inconsistent
  → ADOPT: LEARNINGS.md persists + prompt-injects WITHOUT validation (the loop's one real mutation)
  → ROLLBACK: ImprovementRollback produced, DISCARDED by caller (self-improve.ts:203); no revert fn anywhere — dead structure
```
Sidecars: improvement-loop.ts = vestigial in-memory insight buffer (report-only). ProposalStore: generate LIVE (AgentConfigEvolver, cli.ts:4645-4673) → human HTTP approve (learning-routes.ts) → **markApplied has ZERO callers — apply stage missing entirely**. code-evolver: English proposals only, insert-only status, no apply action. Best-in-repo contract = repair-flywheel lessons (two-reader consensus + canary + budgets, invariant-9-shaped) — flag-OFF (SUDO_FLYWHEEL_APPLY).

### Self-build (autobugfix) — two loops
- **Loop A (self-build tick)**: cron 30min gated SUDO_SELF_BUILD_MODE (OFF) → 7 sequential fail-fast gates (kill-switch, halt latch, alignment ≥0.6, $20/day budget FAIL-CLOSED, MistakeAutoBlockGuard, branch=self-build, clean tree) → agent writes REAL code → deterministic validation (protected-path diff w/ symlinks, tsc, full vitest + test-count non-regression) → commit to self-build branch + post-commit re-verify (escalating revert→reset+halt) → human-review PR (SUDO_SELF_BUILD_OPEN_PR, OFF; review-pr.ts opens PRs, is NOT a reviewer). The strongest existing generate→validate→retain path.
- **Loop B (autobugfix)**: issue-poll 5min gated SUDO_AUTOBUGFIX (OFF) → opens TEXT-ONLY PRs (no patch is ever generated — "Suggested Fix" prose); human merge → DeploymentHook AUTO-DEPLOYS (local lint+test → pm2 reload; git reset rollback on CI fail; NO post-deploy rollback).

### Artifact-type verdicts (AL8.2 gap map)
| Artifact | Generate | Validate | Retain | Verdict |
|---|---|---|---|---|
| Prompt | LEARNINGS.md + self-eval directives | seam unwired; shouldApply fail-open | auto-persists UNVALIDATED (directives OFF) | adopt-without-validate |
| Workflow/config | AgentConfigEvolver LIVE | human approve only, no eval | markApplied: 0 callers | apply stage MISSING |
| Tool | forge writes TS to src/generated; workshop = markdown skills only | forge reviewer/security output DISCARDED | nothing loads forge output; workshop can't register executable tools | MISSING by construction |
| Code patch | Loop A real (flag-OFF); Loop B text-only | Loop A tsc+vitest on HOST (no sandbox) | human merge + auto-deploy | strongest, but unsandboxed |

### AL8.5 boundary inventory
| Boundary | Status |
|---|---|
| protected-paths frozen list | EXISTS-TESTED (incl. alignment stack, meta tools, config, .git) |
| orchestrator 3-layer path defense | EXISTS-TESTED |
| path-guard.ts tool-layer block | EXISTS-**UNTESTED** directly; no-op outside self-build mode; SUDO_SELFBUILD_ALLOW_PROTECTED bypass |
| sandbox for generated code pre-merge | **MISSING** — tsc/vitest run on host; forge writes to disk unsandboxed; trust-tier wired to skills only |
| per-day budgets | PARTIAL — Loop A $20 fail-closed; forge $2/run $10/day tested; autofix 1/hr FAIL-OPEN on DB error; no proposal-count budget |
| F18 quarantine on generated PR text | **MISSING** — auto-fix + review-pr bodies embed raw issue/agent text |
| kill-switches | EXISTS-TESTED (all four) |

### Risk register → AL8.0 repair list (repairs BEFORE any AL8.2 build; decided under delegated authority)
- R1 shouldApply fail-open (engine.ts:361-365) → align to fail-closed like evaluateDraftGate.
- R2 **SUDO_FORGE default-ON** (forge-budget.ts:22, `!== '0'`) with reviewer/security stages whose output is DISCARDED and unsandboxed writes to src/generated → flip to opt-IN (capability preserved, never-drop honored; posture matches every other self-build flag).
- R3 path-guard.ts direct tests (currently the only untested boundary).
- R4 autofix rate-limit fail-open on DB error → fail-closed.
- R5 rollbacks discarded by meta.self-improve caller → at minimum surface them in the tool output.
- (Deferred to AL8.2 proper: sandbox for generated code; F18 quarantine on PR bodies; wiring HeldOutGate into the live caller; proposal-count budget.)

## AL6.1 adaptive-signal inventory (2026-07-28, Fable)

| # | Signal | Where it flows today | What it changes | Logged? |
|---|--------|---------------------|-----------------|---------|
| 1 | EMA tool bias | tool-router.ts:618-638 (boot attachment UNVERIFIED per audit) | tool selection ordering | no (in-memory EMA) |
| 2 | Failure-learner hints | flag OFF in prod | prompt hints on repeated failures | n/a (off) |
| 3 | Latency/success history | api_call_log (billing CostTracker) | nothing automatically — reporting only | yes (sqlite) |
| 4 | Budget pressure | llm/policy.ts daily USD caps + billing checkBudget | user lane degrades alias; background fail-closed; alerts | partially (alerts; enforcement counters in-memory) |
| 5 | User-intent class | cheap-model-router on-path | cheap-vs-primary model per turn | **NOW yes** (AL6.4: log line + ChooseModelResult.intent) |
| 6 | Episodic recall | memory retrieval (ON) | context assembly per turn | via memory logs |
| 7 | Window size / cache affinity | SUDO_AGENT_WINDOW_SIZE=200 (ON) | context window trimming | no (static env) |

Resolver seam status: signals 4+5 have first-class PolicySignals fields (budgetPressure, intent) + queueDepth/recentFailureRate; 1/2/6/7 remain per-knob migrations (thin delegation, one PR each, no behavior change — per AL6.2 migration rule).

## AL6.5 shadow-vs-live comparison query (written; RUN pending ≥3 days prod shadow traffic)

Once the decision sink persists to sqlite (`policy_decisions(at, intent, route_hint, shadow, applied_model, session_id, turn_id)` — persistence PR next), compare against AL1.2's llm_calls:

```sql
-- Would the shadow policy have degraded success/latency?  Buckets:
--   AGREE  = shadow route == applied route (no-op)
--   CHEAPER= shadow said cheap, live used primary  → savings candidate
--   RISKIER= shadow said reasoning, live used cheap → quality-risk candidate
SELECT bucket, COUNT(*) n,
       AVG(lc.outcome = 'ok') AS success_rate,
       AVG(lc.latency_ms)     AS avg_latency_ms
FROM (
  SELECT pd.turn_id,
         CASE WHEN pd.route_hint = lc_route.tier THEN 'AGREE'
              WHEN pd.route_hint = 'cheap' THEN 'CHEAPER' ELSE 'RISKIER' END AS bucket
  FROM policy_decisions pd JOIN llm_calls lc_route USING (turn_id)
  WHERE pd.shadow = 1 AND pd.at >= datetime('now', '-3 days')
) b JOIN llm_calls lc USING (turn_id)
GROUP BY bucket;
-- Promotion rule (gw-refactor precedent, shadow 0/303): promote only if the
-- CHEAPER bucket's success_rate is within 1pp of AGREE's and RISKIER is ~empty.
```

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
