# Handoff — everything that needs FRANK (2026-07-30, all-roadmaps run)

## 2026-07-31 DELEGATION EXECUTED (Frank: "I will allow you make all decisions on this doc")

Fable decided + executed every decidable item. Decision record:

| Item | Decision | Outcome |
|---|---|---|
| SUDO_SEMANTIC_COMPACT (auto-DELETE dups, invariant-9 tension) | **RETIRED (=0)** | #1024 write-time gate covers new dups without surgery |
| Retroactive twin cleanup | **EXECUTED via two-reader consensus** (scripts/memory-consensus-batch.mts, PR #1029) | 91 superseded (audit-preserving), 23 escalations skipped; retrieval: raw hybrid 28/63→35/68, RAG path 20/50→26/53 |
| Retroactive evergreen marking | **EXECUTED via same consensus batch** | 221 facts marked durable (decay-exempt), 38 escalations skipped |
| Nightly AgentBench cron | **BUILT + ACTIVATED** (PR #1029, SUDO_BENCH_NIGHTLY=1, 04:00 UTC) | budgets: $2/run, 10 tasks, alert <70% pass; first results in bench.db after tonight |
| SUDO_AGENT_RUN_MAX_USD / TG flags / TX19 / AL_META / AL_FRONTIER / FLYWHEEL_APPLY / GDRIVE / GW-5 / GW-11 | already ACTIVE in prod (stale list) | verified via pm2 env 2026-07-31 |
| PRs #969 / #936 / #836 | already closed/merged (stale list) | verified via gh |
| Escape hatches | left alone as instructed | — |

Pre-surgery backup: /root/eval-scratch/mind-pre-consensus.db. Consensus report artifacts: data/consensus-batch-*.json (escalations listed for optional human review — no action required).

STILL PHYSICALLY YOURS (accounts/devices, cannot be delegated to me):
Anthropic org OAuth console flip; OpenAI billing; GCP setup for Drive drills; TX22 bot tokens; TELEGRAM_MISSION_GROUP_ID supergroup; phone-side TG taps.

All autonomously-completable roadmap work is done (ledger below). Every item
here needs your account, your money, your tokens, or your explicit GO — per
the invariants none of it was self-approved.

## Account-side outages (blocking 2 of 4 brain domains)
1. **Anthropic org OAuth block** — console setting `oauth_not_allowed_for_organization`
   (403). Token itself valid. Until flipped, the chain runs glm → gemini only
   (failure-domain failover #982 keeps it to one wire call).
2. **OpenAI billing** — `insufficient_quota`. Also degrades embeddings to
   BM25/MiniLM (circuit breaker handling it; err-log noise every ~20 min).

## Flag activations (mechanisms built + tested, default OFF — your call)

### Added 2026-07-31 (retrieval/memory campaign #1021-#1025)
- **SUDO_SEMANTIC_COMPACT is ON in prod and auto-DELETES near-dup chunks** (post-dream pass; merged 0 recently but maxAppliedCount=731 shows large historical merges). This predates invariant 9 (two-reader consensus for automated memory surgery) and is in tension with it — your call: leave as-is (grandfathered), gate it behind consensus, or turn it off now that the #1024 write-time gate prevents new dups (LIVE-PROVEN 06:50Z: 3 suppressions, twins bumped, 1 fresh fact).
- **Nightly AgentBench cron** — NOT BUILT (corrected ledger: bench is on-demand only, bench.db empty). Wiring it = recurring model spend; needs your GO + a declared per-run/per-day budget (invariant 10).
- **Retroactive memory surgery** (needs two-reader consensus + your GO, invariant 9): (a) semantic-compactor pass over the 263 existing >=0.95-cosine twin facts (SUDO_SEMANTIC_COMPACT); (b) retroactive is_evergreen marking of durable historical facts.
- FYI activated autonomously (reversible/$0/observable, per your fully-autonomous directive): SUDO_MEMORY_NEAR_DUP=1 (write-time near-dup gate, uncommitted prod ecosystem.config.cjs edit). RAG decay half-life 30->90d + EVERGREEN sentinel shipped in #1025.
- FIXED live outage: pptxgenjs missing from prod node_modules (pptx.create broken; nightly self-test 2/6 alert) — deploys adding deps MUST run pnpm install; done + daemons restarted.
- `SUDO_AGENT_RUN_MAX_USD=<value>` — per-run spend halt (#990). Suggest 2–5.
- `SUDO_TG_MISSION_CONTROL=1` (+ optional `TELEGRAM_MISSION_GROUP_ID` — create
  a topics-enabled supergroup, add the bot as admin) — TX9 mission cards.
- `SUDO_TG_MORNING_DIGEST=1` (+ `SUDO_TG_DIGEST_HOUR_UTC`, default 7) — TX7.
- `SUDO_TG_GENUI=1` — TX13 canvas → Telegram keyboards.
- `SUDO_TG_PROVENANCE=1` — TX28 🔍 provenance toast.
- `SUDO_TX19_OVERNIGHT=1` (+ `SUDO_TX19_HOUR_UTC`, default 3) — nightly
  self-improve + deploy card. Deploy taps only APPROVE; applying stays manual
  (AL8.6). **Frank gate absolute.**
- Standing from earlier campaigns: `SUDO_AL_META`, `SUDO_AL_FRONTIER`,
  `SUDO_GDRIVE` re-enable ceremony (P0–P3 landed; blob-GC sweep runs after).
- Escape hatches added (leave alone unless something breaks):
  `SUDO_FAILOVER_DOMAINS=0`, `SUDO_APPROVAL_HEADLESS_ALLOW=1`,
  `SUDO_VETO_FAILOPEN_HIGH=1`.

## Live-verification taps (2 minutes on your phone)
- `/soul` → identity card (TX25).
- Glance at the pinned status card → `· domains X/Y` suffix (#984).
- After activating any TX flag above: per-feature DONE = live-verified on TG.

## Operator steps parked from before
- GCP setup for Drive live drills (gdrive-setup.md); canary planting; phone demo.
- TX22 named agent team: N bot tokens.
- F87 FRANK GATE (core roadmap); N5 stays DO-NOT-BUILD per your 2026-07-17 decision.
- Pre-existing open PRs not touched (not this run's work): #969 (verify content
  vs merged #970 then close), #936 stream-sink fix, #836 canary runbook docs.

## What shipped this run (2026-07-29 → 07-30)
- **07-29 incident chain (#982–#987, deployed):** failure-domain failover
  (ADR 0003), fast-path↔registry, domain health card, FTS event-loop-freeze
  fix, fork-input cap, skill.search crash fix.
- **07-30 ladder gap fixes (#988–#991, #995, deployed):** no-gate fail-closed,
  headless approvals deny, park→notify (both engines), per-run spend cap,
  VetoGate risk-tiered posture.
- **07-30 TX roadmap (#993, #994, #996, #997, #998 + TX25 + TX28):** checkpoint
  protocol (LIVE in prod boot log), mission control v1, morning digest,
  generative TG UI, overnight deploy cards, /soul, provenance toast.
- Post-deploy proofs: policy_decisions 356 rows live; shadow-resolver active.
- Status docs refreshed in this PR; deliberately-deferred TX items carry
  written rationale (nothing dropped).
