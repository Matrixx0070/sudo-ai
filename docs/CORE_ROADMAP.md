# Core Internal Roadmap (F81–F112) — "Light the Dark Machine"

Drafted 2026-07-17 from a full-codebase four-cluster analysis (cognitive core,
autonomy/self-improvement, interface/safety, business/distributed). Continues
the stable feature-ID convention after F1–F38 (Drive, shipped+live) and
F39–F80 (NotebookLM annex, N0–N4 complete; N5 hard-stopped).

Status ledger convention: this file is spec + status; **read first each session.**

## The single sentence

The codebase (~330K LOC, 1,458 src files, 824 test files, 0 open issues/PRs)
has far more capability **built** than **running**: the dominant pattern is
finished, tested modules that are default-OFF, stub-injected at boot, or never
wired at all. The next roadmap is therefore not "build more" — it is
**activate (with budgets), wire-or-delete, consolidate, and harden**.

## Analysis snapshot (evidence, 2026-07-17)

**Dormant-by-default (built, gated OFF):** self-verify, completion-verify,
TODO gate, goal planner, predictor loop (`SUDO_PREDICTOR_LOOP`), consciousness
reflection (`SUDO_CONSCIOUSNESS_REFLECT` — cli.ts injects no-op
`runIdleBatch`/`runBatchReflection` stubs otherwise), SleepCycle learning
paths (episodic/self-model/temporal/wisdom injected as no-op lambdas),
repair-flywheel apply (`SUDO_FLYWHEEL_APPLY`), self-build
(`SUDO_SELF_BUILD_MODE`), world-state goals + self-eval adopt (deliberately
OFF for spend), skill forge (async-gated), LLM shadow.

**Dead / orphaned (zero consumers, verified by grep):**
`core/automation` standing orders (tool registered, `setManager()` never
called → tool throws at runtime), `self-build/auto-fix-trigger.ts` +
`deployment-hook.ts` (built + tested, unwired), `self-improvement/auto-research.ts`,
`evolution/analyzer.ts`, `autonomy/{approval-matrix,autonomous-executor,goal-pursuit}.ts`,
`core/tenancy` (whole dir, zero external importers), `src/remotion` (video
compositions, no render trigger anywhere), `awareness/trend-radar*` +
`user-adapter.ts`, `core/embodiment` (tool-gated barrel), FleetView slices
(`src/tui`, `src/desktop`, `src/gateway/jsonrpc` — tsx-only, unpackaged).

**Explicit stubs on LIVE paths:** `outcomes/goal-evaluator.ts` LlmGoalEvaluator
("not yet implemented — delegating to heuristic"), eval-gate per-run cost
tracking, F10 flight-recorder replay (digest-verification stub — true
re-execution blocked on record-replay determinism).

**Migration in flight:** brain → `src/llm` IR transport. `src/llm` is the
most-imported cognitive dir (27 importers) but `src/llm/legacy/` still lives
behind three re-export shims in `core/brain` (`providers.ts` 194 B,
`custom-providers.ts`, `claude-oauth-manager.ts`); two provider/auth stacks
coexist. Top structural risk.

**Duplication clusters:** dream/consolidation ×3 (memory/auto-dream,
consciousness/auto-dream, dream-consolidator); knowledge-graph ×3 (memory
shim / core/knowledge real / graphify); plan-mode v1/v2/legacy; Slack ×2 and
iMessage ×2 channel impls; `dashboard-html.ts` in dashboard AND gateway;
three HTTP layers (core/api http-server, gateway/http-api, gateway/server);
`tool-translator.ts` in security AND skills; revenue tracking ×3
(earning/finance/billing); session stores ×5 (manager, dual-manager,
journal, sqlite, crash-safe); plugin loaders ×2 + marketplaces ×2;
`autonomy/outcomes.ts` vs `core/outcomes/`.

**God-files:** `agent/loop.ts` 183 KB, `loop-helpers.ts` 98 KB,
`brain/brain.ts` 120 KB, `consciousness/orchestrator.ts` 49 KB,
`learning/insights-dashboard.ts` 42 KB, `cli.ts` 4,863 lines (monolithic boot).

**Stub-marker debt:** tools 179, api/admin 92, channels 21.

**Safety posture notes:** SecurityGuard init is fail-open ("running without
security hardening"); ZDR (`SUDO_ZDR`) honored at only 3 call-sites; fleet
admission defaults to `approved`; posture-weakening escape hatches exist
(`SUDO_FED_SIGN_DISABLE`, `SUDO_SANDBOX_DISABLE`, `SUDO_SANDBOX_ALLOW_UNCONFINED`,
`SUDO_SECURITY_AUDIT_DISABLE`, `SUDO_SIGNING_DISABLE`, `SUDO_DASHBOARD_INSECURE`);
countervailing good design: untrusted turns fail-closed and OUTRANK
`SUDO_SANDBOX_DISABLE`; alignment engine has a "not yet seeded" warm-up gap;
no kill-switches at all on forge (multi-model spend) or superpowers.

**Inherited tails:** gdrive CLI subcommands, F35 loop auto-hibernation calls,
F5 gated user-file tool (only F# never implemented), HUMAN items (canary
planting, Apps Script deploy).

---

## Wave A — ACTIVATION (light it up, measured, budget-capped)

Invariant: every activation ships with a per-run + per-day budget
(combined-invariant 10) and a measurement plan BEFORE the flag flips.
Measure-then-fix beats speculation (proven pattern, #678–#680).

| ID | Feature | Notes |
|---|---|---|
| F81 | **Flag census + activation matrix** | Enumerate every `SUDO_*` gate (~60 in the loop alone), prod value, owner subsystem, est. token/spend cost, risk class → one Telemetry-tab report + doc table. Prerequisite for everything below. |
| F82 | **Consciousness reflection ON** | `SUDO_CONSCIOUSNESS_REFLECT=1` with REAL adapters replacing the boot no-op stubs; token-budgeted tiers already exist (`SUDO_COGNITIVE_DEEP_EVERY_N` family). |
| F83 | **SleepCycle real learning** | Bind real episodic/self-model/temporalSelf/wisdomStore impls (currently no-op lambdas at cli.ts boot) so sleep consolidation stops running against empty data. |
| F84 | **Verify gates ON** | `SUDO_SELF_VERIFY` + completion-verify default-on with budget guard; measure verified-vs-unverified failure rates for a week. |
| F85 | **Predictor loop trial** | `SUDO_PREDICTOR_LOOP=1` for a bounded trial; adopt or delete `core/prediction` by data (it is tiny + fully dormant today). |
| F86 | **Repair-flywheel apply** | `SUDO_FLYWHEEL_APPLY` behind two-reader consensus (invariant 9) + daily cap; today it scans/verifies but never closes the loop. |
| F87 | **World-state goals, budget-capped** | Deliberately OFF today for spend; activation = hard per-day USD cap + Telemetry report, NOT an unbounded flip. |
| F88 | **Real LLM goal evaluator** | Implement the stubbed `LlmGoalEvaluator` (haiku-tier, cheap) replacing heuristic-only outcome evaluation; feeds F86/F87 honestly. |

## Wave B — WIRE-OR-DELETE (every dead module gets a verdict)

| ID | Feature | Notes |
|---|---|---|
| F89 | **Standing orders live** | One-slice fix: instantiate `StandingOrderManager` + call `setManager()` at boot; the registered tool currently throws. Smallest slice in the roadmap. |
| F90 | **Auto-fix-trigger + deployment-hook wiring** | Both built + tested + env-documented, zero importers. Wire into health/error-reporter + self-build, or delete with their tests. |
| F91 | **Orphan sweep** | VERDICTS DELIVERED: DELETED goal-pursuit (legacy, superseded by goal-engine-v2), autonomous-executor, user-adapter (all barrel-only, barrels externally unimported). KEPT — corrected, NOT orphans: evolution/analyzer (used by code-evolver → meta.code-evolver tool), auto-research (used by self-improvement engine → meta.self-improve tool), approval-matrix (computer-use approval seam reference + live test). Remaining: trend-radar + embodiment need their own wire-or-delete decision (radar has no scheduler; embodiment is tool-gated cosmetic). |
| F92 | **Tenancy verdict** | Whole dir has zero consumers; delete or demote to documented library. (Its launcher already refuses without OS isolation — good bones if kept.) |
| F93 | **Remotion render pipeline** | Wire the dead video compositions to a real render path (`renderMedia` trigger + delivery). This is the video half of the standing DIY-beats-NotebookLM decision and directly serves the content-video business. |
| F94 | **DIY audio-overview pipeline** | Grounded script gen → local Kokoro / ElevenLabs TTS → publish. The audio half of the same decision; removes the last argument for NLM Enterprise. |
| F95 | **FleetView verdict** | Package `src/tui` + `src/desktop` + `src/gateway/jsonrpc` into real build targets, or park them explicitly in docs as experiments. |
| F96 | **Voice at boot** | Daemon-level voice-engine init + provisioned Kokoro/Whisper assets (today: tool-gated only, assets unprovisioned). Feeds F94. |

## Wave C — CONSOLIDATION (one implementation per concept)

| ID | Feature | Notes |
|---|---|---|
| F97 | **Finish the LLM cutover** | Remove `src/llm/legacy/` + the three brain re-export shims; single provider/auth stack; `LLM_IR_CALLERS` allowlist retired. Top structural-debt item. |
| F98 | **One dream engine** | memory/auto-dream + consciousness/auto-dream + dream-consolidator → one, with the F52-ranked gdrive dream additions as the survivor's input. |
| F99 | **One session store of truth** | manager/dual-manager/journal/sqlite/crash-safe → documented layering or merge; retire `migrate-jsonl`. |
| F100 | **Channel dedup** | Pick canonical Slack (of 2) and iMessage (of 2); delete stale gmail/gcalendar connectors superseded by the channel model. |
| F101 | **HTTP + admin surface dedup** | core/api http-server vs gateway/http-api vs gateway/server; `dashboard-html.ts` ×2; `tool-translator.ts` ×2. One owner each. |
| F102 | **One money ledger** | earning + finance + billing → billing as substrate (it is the only one wired to daemon/cron); others become views or die. |
| F103 | **God-file decomposition** | Mechanical, test-guarded splits: loop.ts (183 KB), loop-helpers (98 KB), brain.ts (120 KB), cli.ts boot (4.9K lines → phased boot modules). |

## Wave D — SAFETY POSTURE

| ID | Feature | Notes |
|---|---|---|
| F104 | **SecurityGuard fail-closed option** | Boot alert + `SUDO_SECURITY_STRICT=1` making guard-init failure fatal; today a bad config silently drops all hardening. |
| F105 | **ZDR audit** | Sweep every persistence path for `SUDO_ZDR` honor (only 3 call-sites today); add tests; per-channel privacy policy hook. |
| F106 | **Footgun telemetry** | Startup banner + Telemetry-tab warning whenever a posture-weakening flag is active (FED_SIGN_DISABLE, SANDBOX_DISABLE, DASHBOARD_INSECURE, AUDIT/SIGNING/KEY_ROTATION disables); flip fleet admission default to `pending`. |
| F107 | **Stub-debt triage** | tools (179 markers) + api/admin (92): classify real-vs-cosmetic, burn down the real ones, delete the cosmetic ones. |
| F108 | **Alignment seeding + spend guards** | Fix the "alignment not yet seeded" warm-up so `SUDO_SELF_BUILD_MIN_ALIGN_SCORE` means something; add kill-switch + budget to forge and per-tool gating to superpowers (both currently ungoverned spend/priv surfaces). |

## Wave E — INHERITED TAILS (small slices)

| ID | Feature | Notes |
|---|---|---|
| F109 | gdrive CLI subcommands (status/bisect/knew-at/resume) — libraries tested, commander wiring only. |
| F110 | F35 loop-side auto-hibernation calls (library complete). |
| F111 | F5 gated user-file tool — the only F1–F38 ID never implemented. |
| F112 | Record-replay determinism research slice → unlocks true F10 flight-recorder replay. |

## Sequencing recommendation

1. **F89** (minutes) + **F81** flag census (the measurement substrate) first.
2. **F97** LLM cutover next — every later wave touches fewer stacks once there is one.
3. **Wave A** activations one at a time, each with its budget + a 3–7-day measurement window; kill what doesn't earn its tokens (predictor, trend-radar class).
4. **Wave D** rides along as small PRs (F104/F106 are cheap, high-value).
5. **F93/F94** (video+audio pipeline) whenever revenue work is the priority — they are independent of the internal waves.
6. Waves B/C interleave as debt slices between activations.

Non-goals: N5/NotebookLM Enterprise (standing NO), new external surfaces,
anything touching frozen identity/constitution surfaces (invariant 4).

## F81 census corrections (2026-07-17)

The census (`docs/FLAG_CENSUS.md`) corrected the analysis snapshot above —
prod (`pm2 sudo-ai-v5` env + `config/.env`) already runs several flags the
static sweep called dormant: `SUDO_CONSCIOUSNESS_REFLECT=1`, `SUDO_SELF_VERIFY=1`,
`SUDO_COMPLETION_VERIFY=1`, `SUDO_PREDICTOR_LOOP=1`, `SUDO_TODO_GATE=1`,
`SUDO_GOAL_PLANNER=1`, `SUDO_AUTONOMY_V1=1`. Consequences:

- **F82/F84/F85 become verify-the-adapters/measure tasks, not flag flips.**
  F83 must confirm SleepCycle's real adapters are bound under REFLECT=1.
- **New F81 finding, do FIRST:** both daily budget caps are disabled in prod
  (`SUDO_DAILY_BUDGET_USD=off`, `SUDO_DAILY_LLM_BUDGET_USD=off`) — Wave A's
  budget discipline has no enforcement substrate until re-enabled.
- **New follow-up slice:** the documented `SUDO_UPDATE_*` env→config mapping
  is unimplemented (DEFAULT_UPDATE_CONFIG only, `.start()` never called) —
  prod's six `SUDO_UPDATE_*` entries are inert; only `SUDO_UPDATE_DISABLE`
  is real.
- Still genuinely OFF: `SUDO_WORLD_STATE_GOALS=0`, `SUDO_SELF_EVAL_ADOPT=0`
  (deliberate), `SUDO_FLYWHEEL_APPLY`, `SUDO_SELF_BUILD_MODE`,
  `SUDO_STANDING_ORDERS` (F89 ships CRUD-only), + 76 opt-in flags unset
  (full list in the census).


## Autonomous execution plan v2 (mapped 2026-07-17 night, post #806–#815)

Verified starting state: Waves A/B/D opening slices shipped + deployed (pid
2474934 clean); budget guardrails live (100/50); F93/F94 **PARKED by Frank —
do not start**; N5 standing NO; frozen surfaces untouchable (invariant 4).

### Phase 1 — Observe + cheap wins (no new spend, 1 session)
| Step | Work | Gate/proof |
|---|---|---|
| 1.1 | Live-verify F83: first sleep-cycle pass over real episodes (grep sleep/dream logs after a night) + F82 closure | log evidence of non-empty consolidation |
| 1.2 | F84/F85 measurement: query traces/mind.db for self-verify + predictor hit rates over 7 days → adopt/kill verdict per flag | verdict written to this ledger |
| 1.3 | F105 ZDR audit: sweep every persistence path for SUDO_ZDR honor (3 call-sites today), add tests | new tests + sweep table |
| 1.4 | F108: fix alignment "not yet seeded" warm-up; add kill-switch + per-run budget to forge; per-tool gating for superpowers | tests + boot line |
| 1.5 | Tails F109 (gdrive CLI commander wiring) + F110 (F35 auto-hibernation loop calls) | CLI smoke + unit tests |

### Phase 2 — Structural (F97 first, its own session)
| Step | Work | Gate/proof |
|---|---|---|
| 2.1 | F97 stage a: inventory src/llm/legacy importers + brain shim call-graph | inventory table in PR |
| 2.2 | F97 stage b: port claude-oauth/custom-provider logic onto the IR transport; keep byte-compat via existing 57 goldens | conformance green |
| 2.3 | F97 stage c: delete legacy + 3 shims, retire LLM_IR_CALLERS allowlist | grep-guard test: no src/llm/legacy imports |
| 2.4 | F97 gate: LLM_SHADOW replay over ≥300 real prompts, 0 material divergences, then deploy + live smoke on all providers | SHADOW report + live turns |
| 2.5 | F101 HTTP/admin dedup, then F99 session-store layering doc/merge (post-F97 only) | route parity tests |

### Phase 3 — Consolidation (PR-sized, interleave freely)
F98 one dream engine · F100 channel dedup (Slack ×2, iMessage ×2, stale
gmail/gcalendar connectors) · F102 money ledger → billing substrate ·
F103 god-file splits (loop.ts / loop-helpers / brain.ts / cli.ts boot
phases; mechanical, test-guarded, no behavior change).

### Phase 4 — Autonomy deepening (each step has an explicit gate)
| Step | Work | Gate |
|---|---|---|
| 4.1 | F88 activation: set SUDO_GOAL_EVAL_MODEL=haiku (caller already wired) | deploy-state edit + restart; watch cost lines |
| 4.2 | F86 flywheel apply: two-reader consensus (invariant 9) + daily cap + audit trail | consensus tests + capped live trial |
| 4.3 | F92 tenancy / F95 FleetView / F96 voice-at-boot verdicts (wire-or-park each) | verdict rows in this ledger |
| 4.4 | F87 world-state goals | **FRANK GATE — autonomous spend; do not flip solo** |

### Phase 5 — Rolling/research
F107 stub-debt triage (tools 179 / api 92, rolling burn-down) · F111 F5
gated user-file tool · F112 record-replay determinism research (unlocks true
F10 flight-recorder replay).

### Standing rules for every autonomous session
1. Read this ledger first; execute the lowest unfinished phase step.
2. One worktree per slice off origin/main; node_modules symlink; tsc + suite
   + semgrep per slice; PR; merge only on green CI; clean up worktrees.
3. Deploys: only from a src-clean tree; restart via
   `pm2 restart ecosystem.config.cjs --only sudo-ai-v5 --update-env`
   (plain restart does NOT re-read the ecosystem file); verify boot lines +
   zero level-50 from the NEW pid before declaring done.
4. PARKED/GATED: F93/F94 (Frank), F87 flip (Frank), N5 (standing NO),
   frozen surfaces (invariant 4). Never silently drop functionality —
   wire-or-delete requires reachability proof; rescues beat deletions.

## Status

| Wave | Status |
|---|---|
| A (F81–F88) | **F81 shipped** (#807, census + `docs/FLAG_CENSUS.md`); **F88 shipped** (#809, real LlmGoalEvaluator behind injected seam; activate via SUDO_GOAL_EVAL_MODEL); F82–F87 = verify/measure tasks per census corrections |
| B (F89–F96) | **F89 shipped** (#806); **F90 shipped** (AutoBugFix C+D behind SUDO_AUTOBUGFIX=1); **F91 verdicts delivered** (3 deleted, 3 corrected-keep); rest not started |
| C (F97–F103) | not started |
| D (F104–F108) | **F104+F106 shipped** (#810: SUDO_SECURITY_STRICT fatal guard-init + posture-weakening boot banner, posture.ts); F105/F107/F108 not started |
| E (F109–F112) | not started. Census follow-up shipped: SUDO_UPDATE_* env→config mapping (#808). |
