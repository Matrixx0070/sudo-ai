# OPUS HANDOFF — Agentic Systems Ladder (AL1–AL10)

Author: Fable 5, 2026-07-24. Executor: Opus. Owner: Frank (gates marked **FRANK GATE** need his explicit GO).
Status ledger: `docs/AGENTIC_LADDER_STATUS.md` — **update after every merged PR; read it first each session; never reconstruct state from memory.**

## Mission

Take sudo-ai-v4 up the 10-rung agentic-systems ladder — from single-agent loop engineering to open-ended evolution — by **auditing what already exists, wiring the gaps, and gating everything above rung 7 behind hard human approval**. This is NOT a greenfield build: `src/core/` already contains `agent/`, `workflows/`, `orchestration/`, `swarm/`, `agents/`, `evolution/`, `self-improvement/`, `self-build/`, `optimization/`, `learning/`, `eval/`, `autonomy/`. The ladder work is: verify each rung is real (live-proven, not just files on disk), close the gaps, and connect the rungs into one coherent stack.

## Non-negotiable ground rules (bind every AL item)

1. **Audit before build.** For every rung, first produce an AUDIT verdict per work item: `LIVE-PROVEN` (exercised end-to-end this campaign with cited output) / `EXISTS-UNPROVEN` (code present, never driven) / `PARTIAL` / `MISSING`. Only PARTIAL/MISSING items get build PRs. Never reimplement an EXISTS-UNPROVEN module — drive it, then fix what breaks.
2. **Reuse, never fork.** Extend the existing module for the rung. A second parallel implementation of workflows/orchestration/swarm is an automatic review reject.
3. **Flags default OFF.** Every new behavior ships behind `SUDO_AL_*` env flags, default OFF, set in `ecosystem.config.cjs` (NEVER in `config/sudo-ai.json5` — top-level `env:{}` there crash-loops prod).
4. **Budgets.** Every recurring/background loop declares per-run + per-day token/spend budgets, halts gracefully on exhaustion, alerts, reports on the Telemetry tab. No unbounded loops.
5. **Judge independence.** Any evaluator/judge route is distinct from the route under test. No independent route available → gate HOLDS for human review.
6. **Frozen surfaces.** Nothing in AL1–AL10 writes identity/constitution/PROTECTED_PATHS (`src/core/self-build/protected-paths.ts`, `path-guard.ts` enforce). Self-modification rungs (AL8–AL10) operate ONLY through the PR pipeline — never direct writes to running code.
7. **Quarantine.** Any external/model-returned text feeding a control decision goes through F18 `inspectContent` quarantine first. Model output never executes as instructions.
8. **No autonomous spend without Frank.** Rungs whose loops call paid models autonomously (AL7+ background optimization, AL8+ generation loops) stay flag-OFF in prod until a per-rung **FRANK GATE** GO. (Precedent: `WORLD_STATE_GOALS=0`, `SELF_EVAL_ADOPT=0` in prod for exactly this reason.)
9. **Never drop capabilities.** A blocked approach = keep the item OPEN, surface re-scope options in the status doc, wait for Frank. Never silently cut.
10. **DoD per PR:** compiles, tsc clean, tests pass, new behavior covered by tests, flag census updated (`docs/FLAG_CENSUS.md`), `graphify update .` run, status ledger updated. Ship small: every PR deployable and reversible.
11. **SCAFFOLD markers** on every workaround for a current-model limitation. Design for the model ~6 months out — prefer giving the model better context/tools over hardcoded heuristics (bitter lesson).
12. **Questions to Fable:** append OPEN questions to `docs/AGENTIC_LADDER_QA.md` (create on first need, same protocol as `docs/CAS_WIRING_QA.md`). Fable answers them at session start; do not block >1 rung on an unanswered question — move to the next independent item.

## Rung dependency graph

```
AL1 loop ──► AL2 workflow ──► AL3 graph ──► AL4 orchestration ──► AL5 multi-agent
                                                    │                    │
                                                    ▼                    ▼
                                              AL6 adaptive ◄─────────────┘
                                                    │
                                                    ▼
                                       AL7 self-optimizing (telemetry+eval backbone)
                                                    │  FRANK GATE
                                                    ▼
                                       AL8 self-improving (PR-pipeline mutations)
                                                    │  FRANK GATE
                                                    ▼
                                       AL9 recursive self-improvement (meta-level)
                                                    │  FRANK GATE
                                                    ▼
                                       AL10 open-ended evolution (frontier ledger)
```

AL1–AL5 can be audited in parallel. AL6+ builds strictly on the eval/telemetry backbone hardened in AL7.1 — do AL7.1 early even though the rung is numbered 7.

---

## AL1 — Loop Engineering (single agent, iterative feedback loop)

**Definition of the rung:** one agent runs observe→think→act→observe with tool feedback, error recovery, doom-loop detection, context compaction, and a stop condition.

**Already in tree (audit these):** the ReACT loop in `src/core/agent/` (loop core + `best-of-n.ts`, `doom-loop` detection — see memory of #438, `agency-monitor.ts`), session compaction with goal-pinning (#733), write-through persistence (#668/#670), window-size cache discipline (`SUDO_AGENT_WINDOW_SIZE=200`), self-verify (#441), F103 loop-decomposition design (`docs/F103_LOOP_DECOMPOSITION_DESIGN.md`).

**Work items:**
- **AL1.1 Loop audit + invariant tests.** Write `tests/agentic-ladder/al1-loop-invariants.test.ts` asserting the five loop invariants: (a) every tool error re-enters the loop as observation, never silently swallowed; (b) doom-loop detector fires on a synthetic 3×-repeat and does NOT fire on legitimate retry-with-changed-args; (c) compaction preserves the pinned goal verbatim; (d) max-step/max-token stop conditions halt with a user-visible report; (e) empty-model-reply normalization (the #751 class) holds for every channel adapter.
- **AL1.2 Loop telemetry contract.** Ensure every loop iteration logs `{turn_id, step_n, tool, latency_ms, tokens_in/out, outcome}` to the existing `gateway.db` / `api_call_log` schema — this is the raw feed AL6/AL7 consume. Gap-fill only; do not create a second logging path.
- **AL1.3 F103 remainder.** Execute the remaining slices of the loop-decomposition design doc (read the doc; only OPEN slices) so the loop is modular enough for AL3 to reuse its step-executor as a graph node.

**DONE MEANS:** invariant test file green in CI; one live prod turn traced end-to-end with all AL1.2 fields present (cite the sqlite row); F103 status section updated with per-slice verdicts.

---

## AL2 — Workflow Engineering (deterministic pipelines)

**Definition:** predefined multi-step execution paths — DAG-less linear/branching pipelines with deterministic control flow, model calls only inside steps.

**Already in tree:** `src/core/workflows/` (`executor.ts`, `queue.ts`, `yaml-parser.ts`, `lobster.ts`, `types.ts`).

**Work items:**
- **AL2.1 Workflow audit.** Drive one YAML workflow end-to-end in dev (parse→queue→execute→result) and record: what step types exist, what the failure semantics are (does a failed step halt, skip, or retry?), and whether results persist. Verdict per capability.
- **AL2.2 Deterministic-core guarantee.** Add tests proving control flow is model-free: given a fixed workflow + mocked step outputs, the execution trace is byte-identical across runs. Any `Math.random`/model call found in the executor's routing logic is a bug — fix at cause.
- **AL2.3 Step contract v1.** Normalize every step to `{input, output, error, retryPolicy, timeoutMs, budget}` in `types.ts` (extend, don't break existing YAML). Retries: bounded, exponential, per-step; on exhaustion the workflow fails loudly with the step's last error — no silent skip (silent-failure rule).
- **AL2.4 Idempotency + resume.** Persist per-step completion (reuse `queue.ts` storage); a re-run of a crashed workflow skips completed steps. Test: kill mid-workflow, resume, assert no step ran twice.

**DONE MEANS:** determinism test green; one workflow crashed+resumed in test with cited trace; step contract documented in `docs/AGENTIC_LADDER_STATUS.md` AL2 section.

---

## AL3 — Graph Engineering (directed graphs: branching, merging, parallel)

**Definition:** workflows generalize to a directed graph of specialized nodes — conditional branches, fan-out/fan-in merges, parallel execution, cycles only where explicitly declared.

**Already in tree:** nothing graph-shaped confirmed — `workflows/` looks linear/queue-based, `orchestration/task-queue.ts` is a queue. **This rung is the likeliest genuine build.**

**Work items:**
- **AL3.1 Graph schema.** `src/core/workflows/graph-types.ts`: nodes `{id, kind: 'agent'|'tool'|'gate'|'merge'|'branch', config, budget}`, edges `{from, to, condition?}`. Cycles rejected at validation unless the edge is marked `loop: {maxIterations}`. Pure data — JSON-serializable, no functions in the schema.
- **AL3.2 Graph executor.** `src/core/workflows/graph-executor.ts`: topological scheduling; parallel dispatch of ready nodes (bounded concurrency, default from env `SUDO_AL_GRAPH_CONCURRENCY`, default 4); merge nodes wait for ALL inbound edges (barrier) or first-N (quorum) per config; branch nodes evaluate declared predicates over prior node outputs (predicates are data — JSONLogic-style — never eval'd model text). Reuse AL1's step executor for `agent` nodes and AL2's step contract for `tool` nodes; the graph executor is a scheduler, not a new runtime.
- **AL3.3 Failure semantics.** Node failure policies: `halt-graph` (default), `prune-branch` (downstream of failed node cancelled, merges degrade to quorum if configured), `retry` (per AL2.3). Partial results always persisted; final report names every pruned/failed node — no silent truncation.
- **AL3.4 Golden graphs.** Three test graphs in `tests/agentic-ladder/`: (a) diamond (branch→2 parallel→merge), (b) quorum merge (3 finders, first-2 wins, slowest cancelled), (c) declared loop (refine-until-pass, maxIterations honored). Each asserts exact execution traces.
- **AL3.5 Compilation from YAML.** Extend `yaml-parser.ts` so existing linear workflows compile to trivial graphs — one engine, two authoring surfaces. Old YAML files keep working unchanged (regression test on an existing workflow fixture).

**DONE MEANS:** 3 golden graphs green; existing YAML workflows pass unchanged through the graph path; concurrency cap proven with a timing test (4 parallel nodes with cap 2 → 2 waves).

---

## AL4 — Orchestration Engineering (scheduling, routing, state, retries, human approval)

**Definition:** the runtime around the graph — dynamic scheduling, model/route selection, durable state, resource allocation, retries, human-approval gates, cross-graph coordination.

**Already in tree (rich — mostly wiring, not building):** `orchestration/` (task-queue + executor), `agent/approval.ts` + `autonomy/approval-matrix.ts` (human gates), `agent/cheap-model-router.ts` + the `src/llm/` IR/policy layer (routing), `scheduling/` + `cron/` (time), `agent/cloud-tasks.ts` + `background-agent.ts` (background execution), billing/budgets in `billing/`.

**Work items:**
- **AL4.1 Orchestration audit.** Map which of the six concerns (scheduling, routing, state, resources, retries, approval) each existing module covers; verdict table in status doc. Expected finding: everything exists separately; nothing composes them around a *graph run*.
- **AL4.2 Graph-run state store.** Persist graph runs (`graph-runs` table beside `task-queue-schema.ts`): run id, graph hash, per-node status/output-ref, budget spent, resumable. Crash-resume test as in AL2.4 but for a diamond graph.
- **AL4.3 Route-per-node.** Node config accepts a route hint (`reasoning` | `cheap` | explicit route id) resolved through the existing `src/llm/` policy layer — never a hardcoded model string in graph configs. Cheap nodes (classify/extract) default to the cheap router; the failover chain stays exactly as prod-configured (grok stays OFF it — decided, don't re-litigate).
- **AL4.4 Human-approval nodes.** `gate` node kind = existing approval-matrix seam: run parks (state `AWAITING_APPROVAL`), owner notified via existing channel adapters (Telegram/email), resumes on approval artifact. **Harness-enforced:** the gate verifies the approval artifact exists; no-human never means no-gate. Test with a synthetic approval artifact.
- **AL4.5 Resource governor.** Per-run and per-day token/spend budget enforcement at the orchestrator level (compose with `billing/`): budget exhausted → graph pauses in a resumable state + alert; never a hard crash losing state. Telemetry tab shows per-run spend.

**DONE MEANS:** verdict table published; diamond-graph crash-resume green; a gate node live-proven in dev (park → approve → resume, cited log lines); budget-exhaustion test green (pause not crash).

---

## AL5 — Multi-Agent Systems (roles, collaboration, negotiation, delegation, shared knowledge)

**Definition:** independent agents with distinct roles that message each other, delegate subtasks, and share knowledge through a common memory — beyond one orchestrator fanning out workers.

**Already in tree (the richest rung):** `agents/` (roles, orchestrator, spawner, team-manager, session-bus, messenger, sqlite store), `swarm/` (swarm-manager), `sessions.send` inter-agent messaging (hop≤3, 32KB, offline queue, name resolution — LIVE per memory), `agent/agent-messaging.ts`, shared memory API in `memory/`.

**Work items:**
- **AL5.1 Multi-agent audit.** Drive one real two-agent collaboration in dev: orchestrator spawns a researcher + a builder role, they exchange ≥2 messages via session-bus/sessions.send, builder delegates a sub-check back, result lands in shared memory via the memory API. Cite the message log. Verdict per module (`roles.ts`, `team-manager.ts`, `swarm-manager.ts` especially — swarm may be EXISTS-UNPROVEN).
- **AL5.2 Role contracts.** Each role in `roles.ts`/`specialized-types.ts` declares: capabilities (tool allowlist), knowledge scope (memory tiers it may read/write), delegation rights (which roles it may spawn/message), and budget. Enforced at spawn/message time, not just documented. Test: a role without delegation rights attempting spawn → rejected with actionable error.
- **AL5.3 Negotiation primitive.** Minimal contract-net: agent A posts a task offer on the session-bus, eligible roles bid `{confidence, estimatedCost}`, A awards to best bid, award + outcome logged. No new bus — extend `messenger.ts` message types. This is the seam AL6 uses for adaptive routing between agents.
- **AL5.4 Shared-knowledge discipline.** All cross-agent knowledge flows through the memory API with tier+category (invariant 5); agent-to-agent messages are transient signals, not storage. Extend the hot-path test pattern to assert agent modules never import memory internals directly.
- **AL5.5 Swarm decision.** If AL5.1 finds `swarm/` redundant with `agents/`+graph-executor: do NOT delete — write a recommendation in the status doc (never-drop-capabilities rule) and ask Frank.

**DONE MEANS:** live two-agent collaboration trace cited; role-enforcement tests green; one contract-net round-trip in test with cited award log; swarm verdict + recommendation filed.

---

## AL6 — Adaptive Systems (policies change with context/workload/performance/intent)

**Definition:** execution policy — route, concurrency, retry aggressiveness, tool selection, depth of reasoning — is chosen at runtime from observed signals instead of static config.

**Already in tree:** EMA tool-bias + episodic recall + attention/world-goals (outcome-gated learning campaign, LIVE), `cheap-model-router.ts`, `prediction/`, `awareness/`, per-session cache-affinity spec (`docs/SPEC_SESSION_CACHE_AFFINITY.md`).

**Work items:**
- **AL6.1 Signal inventory.** Enumerate adaptive signals already flowing (EMA tool bias, failure-learner, latency/success from `api_call_log`, budget pressure, user-intent classification) and where each currently changes behavior. Table in status doc.
- **AL6.2 Policy resolver.** `src/core/agent/policy-resolver.ts`: single seam answering "for this step, with these signals, what {route, maxRetries, concurrency, reasoningDepth}?" All existing adaptive knobs migrate to call through it (thin delegation, no behavior change in the migration PR). Every decision logged with its inputs → this makes adaptation auditable and gives AL7 its training signal.
- **AL6.3 Workload adaptation.** Under queue depth / budget pressure: cheap-route eligible steps, lower graph concurrency, defer background loops. Deterministic thresholds from env, hysteresis to avoid flapping. Test with synthetic load metrics.
- **AL6.4 Intent adaptation.** Route user turns by intent class (already partially in cheap-model-router): quick-fact → cheap route, agentic/multi-step → strong route, with the classification result logged and evaluable. Misroute becomes an eval case (AL7).
- **AL6.5 Shadow mode first.** Every new adaptive policy ships in shadow (`SUDO_AL_POLICY_SHADOW=1`): decision computed + logged, NOT applied, for ≥3 days of prod traffic; flip to live only after the shadow log shows it would not have degraded success/latency (cite the comparison query). Precedent: gw-refactor shadow 0/303.

**DONE MEANS:** policy-resolver seam merged with all decisions logged; shadow-vs-live comparison query written and one policy promoted through it with cited numbers; flap test (hysteresis) green.

---

## AL7 — Self-Optimizing Systems (telemetry+eval-driven continuous optimization)

**Definition:** the system measures itself (prompts, tool selection, planning, memory usage, cost/latency) and adjusts within a bounded policy space — parameters change, code does not.

**Already in tree:** `optimization/auto-optimizer.ts` + `optimizer-db.ts`, `eval/` (bench-runner, bench-matrix, bench-regression, self-eval, eval-gate, skill-bench), `telemetry/`, `learning/` (failure-learner, lesson-store, held-out-gate, policy-refresh), F86 flywheel consensus, `outcomes/`.

**Work items:**
- **AL7.1 Eval backbone hardening (DO EARLY — AL6 depends on it).** Audit `eval/`: does `bench-runner` run green today? Is there a persisted baseline? Wire a nightly bench run (existing cron seam) publishing score/cost/latency to the Telemetry tab with regression alerts (`bench-regression.ts`). Every production failure class in memory (#751 empty-reply, 0-fields scrape, doom-loop FP) must exist as an eval case — add the missing ones.
- **AL7.2 Optimization loop contract.** `auto-optimizer.ts` conforms to: propose (bounded param change: prompt variant from a versioned registry, tool-bias weight, routing threshold, memory-eviction knob) → evaluate on the bench + held-out set (`held-out-gate.ts`) → adopt only if ≥ baseline on quality AND not worse on cost/latency beyond declared tolerance → record `{proposal, scores, verdict, rollback-ref}` in `optimizer-db`. One-command rollback per adoption.
- **AL7.3 Prompt registry.** Prompts-as-code: versioned prompt variants in-repo, referenced by id; the optimizer selects among *registered* variants (it may propose new variant *files* only via AL8's PR pipeline, never hot-patch a live prompt).
- **AL7.4 Judge independence enforcement.** Code-assert in `eval-gate.ts`: `judgeRoute !== candidateRoute` (and ≠ author route for generated answers); violation → gate HOLDS. Unit test both directions.
- **AL7.5 Memory-usage optimization.** Bounded knobs only: retrieval-k, tier thresholds, compaction cadence — evaluated on retrieval-hit-rate evals. **Memory surgery (deprecate/rewrite/merge/force-decay) requires two-reader consensus (invariant 9) — the optimizer may only FLAG, never operate.** Test: surgery-shaped proposal from the optimizer → rejected at the gate.
- **AL7.6 FRANK GATE — autonomous background spend.** The nightly optimizer loop calls paid models. Ships complete but `SUDO_AL_AUTO_OPTIMIZE=0` in prod. Present Frank: per-night token budget, per-day cap, expected value, kill switch. No GO → it runs only when manually invoked.

**DONE MEANS:** nightly bench live in dev with one regression alert proven (inject a synthetic regression); one full propose→evaluate→adopt→rollback cycle executed with cited optimizer-db rows; judge-independence + surgery-rejection tests green; Frank-gate memo written in status doc.

---

## AL8 — Self-Improving Agents (generate + validate new prompts/workflows/tools/code; keep only wins)

**Definition:** the system authors *artifacts* — new prompt variants, new workflow graphs, new tools, code patches — validates them against baseline, and retains only improvements. Everything flows through the PR pipeline.

**Already in tree:** `self-improvement/` (engine, improvement-loop, pattern-detector, auto-research), `self-build/` (orchestrator, auto-fix-trigger, review-pr, path-guard, protected-paths, deployment-hook), `evolution/code-evolver.ts`, `learning/agent-config-evolver.ts` + `proposal-store.ts` + `lesson-consensus.ts`, skill workshop (Spec 9 packaging/versioning/rollback), `forge/`.

**Work items:**
- **AL8.1 Self-improvement audit.** Trace one improvement through the existing `improvement-loop.ts`: what triggers it, what it generates, what validates it, what adopts it. Same for `self-build/auto-fix-trigger` (autobugfix). Verdicts + a data-flow diagram in the status doc. Expected finding: pieces exist; the generate→validate→retain contract is uneven across artifact types.
- **AL8.2 Uniform improvement pipeline.** One contract for all four artifact types (prompt, workflow-graph, tool, code patch): `propose (with rationale + eval plan) → sandbox-validate (build+tests+targeted evals, trust-tier Docker sandbox for generated code) → bench vs baseline (AL7 backbone; judge independence) → PR with eval evidence attached → human or gated auto-merge → deploy → post-deploy watch (auto-revert on regression alert)`. Implement as a thin layer over `self-build/orchestrator.ts` + `proposal-store.ts`; artifact-type plugins provide generate/validate.
- **AL8.3 Tool self-authoring.** Reuse Spec-9 skill packaging as the delivery vehicle for generated tools/skills: generated tool = versioned skill package with lockfile pin + `.versions` rollback; registered only after sandbox validation; capability-registry entry required (the textproc CATEGORY_MAP gotcha — new categories need the map entry, test for it).
- **AL8.4 Retention ledger.** Every adopted improvement gets a ledger row: baseline score, candidate score, eval set hash, adoption PR, revert ref. Quarterly (cron) re-validation of retained improvements against the current bench — improvements that no longer beat baseline get FLAGGED for review (not auto-reverted; never-drop rule).
- **AL8.5 Hard boundaries (tests, not docs):** path-guard blocks proposals touching PROTECTED_PATHS/identity/constitution (extend `path-guard.ts` tests); generated code runs only in the trust-tier sandbox until merged through review; generated PR bodies/self-authored text on the control path passes quarantine; per-day proposal budget (count + tokens).
- **AL8.6 FRANK GATE — auto-merge scope.** Everything above ships with **human merge required**. Separately present Frank a proposal for narrow auto-merge (e.g., prompt-variant PRs whose full eval suite passes with ≥N% margin): exact class, eval bar, daily cap, kill switch, auto-revert condition. Default: no auto-merge.

**DONE MEANS:** one artifact of each of the 4 types driven through the full pipeline in dev (cite PRs/eval evidence — human-merged); path-guard + sandbox + budget tests green; retention ledger populated with ≥1 row + the quarterly re-check cron registered (flag-OFF); Frank-gate memo filed.

---

## AL9 — Recursive Self-Improvement (the improved system architects the next generation)

**Definition:** the improvement *process itself* becomes an improvable artifact — the system proposes changes to its own generators, validators, eval suites, and pipeline policies. Each generation's pipeline is versioned; generation N's pipeline builds generation N+1's artifacts.

**This rung is deliberately conservative. It is meta-level AL8, with strictly MORE gating, not less.**

**Work items:**
- **AL9.1 Pipeline-as-artifact.** Version the AL8 pipeline configuration (generator prompts, validator thresholds, eval-suite composition, adoption bars) as a single reviewable artifact (`pipeline-manifest` in-repo, semver). The running pipeline pins one manifest version; changing the manifest = a PR like any other.
- **AL9.2 Meta-proposals.** Extend AL8.2 with a fifth artifact type: `pipeline-change`. The system may propose manifest changes (e.g., "add eval case X, raise adoption bar for tool artifacts, replace generator prompt v3→v4") with evidence from the retention ledger + failure analysis. **Meta-proposals are ALWAYS human-merged — no auto-merge class exists for them, ever.**
- **AL9.3 Generation ledger.** Record lineage: manifest vN produced artifacts {A…}; their aggregate outcome scores attribute back to vN. This is the evidence a meta-proposal must cite. Report as a Telemetry-tab generational scorecard.
- **AL9.4 Eval-suite self-expansion (the safe recursive loop).** The one recursion allowed to run semi-autonomously: the system proposes NEW eval cases from observed prod failures (each failure → candidate eval case → human-reviewed batch weekly). Growing the test set is the lowest-risk, highest-value recursion — it makes every other rung's gate stronger. Eval-case *removal or weakening* is meta-level and human-only (never-weaken-tests rule).
- **AL9.5 Independence stack.** The validator judging generation N+1 artifacts must not be authored by generation N+1 (no self-grading): manifest changes to validators take effect only for artifacts proposed AFTER the manifest merge, enforced by pinning artifact→manifest-version at proposal time. Test this ordering.
- **AL9.6 FRANK GATE — rung activation.** AL9 code ships entirely flag-OFF (`SUDO_AL_META=0`). Activation memo to Frank must include: worst-case analysis (what happens if the generator degrades the validator?), the rollback story (manifest revert = full pipeline rollback), and the human-merge guarantee. No GO → AL9.4 (eval expansion, human-reviewed) may still run alone if Frank approves that narrower slice.

**DONE MEANS:** manifest extracted + pinned (pure refactor PR, behavior unchanged, proven by AL8 regression tests); one meta-proposal generated in dev citing ledger evidence and human-merged; generation ledger renders on Telemetry tab; ordering test (AL9.5) green; activation memo filed.

---

## AL10 — Open-Ended Evolution (expand capabilities, discover abstractions, restructure)

**Definition:** not optimizing a fixed objective — the system scans for new opportunities (unmet user demand, new model capabilities, adjacent problem spaces), proposes new capability *directions*, and restructures itself as opportunities emerge.

**This rung ships as a PROPOSAL ENGINE, not an autonomous builder.** Open-endedness lives in what it can *suggest*; Frank owns what gets *built*. (Doctrine: users retain final authority; SIGNALS.md already encodes the demand-side half of this.)

**Work items:**
- **AL10.1 Frontier ledger.** `docs/FRONTIER.md` + backing store: machine-appended opportunity entries `{date, signal, evidence, proposed capability, est. cost, est. value, dependencies}`. Sources: SIGNALS.md entries (usage beyond design), failure clusters from the learning store, eval-saturation signals ("bench maxed → objective exhausted, propose harder objective"), model-release deltas (new model capabilities that unlock previously-blocked items — bitter-lesson scanning), and `auto-research.ts` findings (quarantined).
- **AL10.2 Abstraction miner.** Periodic (cron, budgeted, flag-OFF) analysis of the retention + generation ledgers and the codebase graph (`graphify` output) for recurring patterns: N similar tools → propose one general engine; N similar workflow subgraphs → propose a reusable graph template. Output = frontier-ledger entries + optionally a draft ADR (Problem/Alternatives/Decision/Tradeoffs skeleton). Capability > feature; engine > workflow — this is that doctrine, automated as *suggestion*.
- **AL10.3 Restructure proposals.** Architecture-level suggestions (merge swarm/ into agents/, split a god node, retire a scaffold) arrive as draft ADRs referencing graphify god-node/community data. Always human-decided; the system may attach a mechanical-refactor PR ONLY after ADR approval, through the AL8 pipeline.
- **AL10.4 Objective proposals.** When an optimization objective saturates or conflicts (quality up, cost 5×), propose objective changes with evidence. Objectives are config the system may *propose against* but never *edit* — same manifest discipline as AL9.
- **AL10.5 Quarterly frontier review ritual.** A generated review pack (frontier ledger ranked by est. value/cost, generational scorecard, saturation report) delivered to Frank via existing channels; his picks become normal roadmap features with IDs. The loop closes through the human, by design.
- **AL10.6 FRANK GATE — standing scan budget.** The scanners (AL10.1 sources, AL10.2 miner) cost tokens on a schedule. Per-scan and per-month budget memo to Frank; flag-OFF until GO.

**DONE MEANS:** frontier ledger live with ≥3 real entries mined from existing SIGNALS/learning data (no synthetic filler); one abstraction-miner run in dev producing ≥1 defensible proposal (cite the pattern evidence); one full review pack generated; all scanners flag-OFF pending gate.

---

## Execution order for Opus

1. **Campaign 0 (1 session):** create `docs/AGENTIC_LADDER_STATUS.md` from the skeleton committed alongside this doc; run the AL1–AL5 audits (AL1.1, AL2.1, AL4.1, AL5.1 in parallel worktrees if needed); fill verdict tables. **No build PRs until the audit verdicts exist.**
2. **Campaign 1:** AL7.1 (eval backbone) + AL1 gap-fixes — the measurement substrate everything else needs.
3. **Campaign 2:** AL2 → AL3 → AL4 (the deterministic execution stack), small PRs, each rung's DONE MEANS met before the next.
4. **Campaign 3:** AL5 → AL6 (collaboration + adaptation, shadow-first).
5. **Campaign 4:** AL7 complete → Frank gate memo → AL8 build (human-merge only) → Frank gate memo.
6. **Campaign 5:** AL9 → AL10 (flag-OFF deliverables + activation memos).

Per-session protocol: read the status ledger first; check `docs/AGENTIC_LADDER_QA.md` for answered questions; pick the next OPEN item in order; ship small PRs with AL-ids in titles (`feat(AL3.2): graph executor`); update the ledger; leave the tree clean.
