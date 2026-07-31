# ADR-0006: Demote the KAIROS→arsenal repair loop from timer-driven to demand-driven

Status: **Accepted** — Frank GO 2026-07-31 ("Go on ADR-0006"), Alternative B.
Implemented behind `SUDO_KAIROS_REPAIR_DEMAND_ONLY` (timer demotion) +
`SUDO_KAIROS_WEEKLY_DIGEST` / `SUDO_KAIROS_DIGEST_CRON` (weekly budgeted digest
→ `kairos/digest-<date>` git branch). Pending-proposal triage:
`scripts/adr0006-triage-proposals.mts`.

Date: 2026-07-31

## Problem

KAIROS (consciousness tick, ~5 min cadence) autonomously drives `coder.arsenal` full-pipeline
dry runs (~80k tokens in / up to 32,768 out per run) whenever it observes oversized files or
tsc errors. Three generations of waste controls have now been bolted onto this loop:

1. 2026-07-29a — persist the dry-run proposal instead of dropping it (sink seam).
2. 2026-07-29b — in-memory dedupe latch after the loop burned 6.5M input tokens in one day
   (~31% of all ollama use) while ollama was load-bearing for the brain.
3. 2026-07-31 — disk-persisted latch + drift-proof key + per-day budget, after six daemon
   restarts in one morning were live-proven to wipe the in-memory latch and re-run the full
   pipeline six times for an unchanged observation (443 excess duplicate LLM calls over 7
   days; tripped the `cache_dup_rate` watchdog).

Meanwhile the output channel is dead: 65 proposals accumulated in `data/proposals.db` since
07-29, all `pending`, zero reviewed — adoption is deliberately gated off in prod
(no autonomous code changes). The loop produces work nobody consumes, on a timer.

## Comparison point

Claude Code — the strongest working reference for agentic coding UX — has **no autonomous
background refactor daemon at all**. Detection of complexity debt is deterministic
(lint-shaped, zero model calls); model-driven refactoring is exclusively demand-driven
(`/simplify`, `/code-review --fix`); work products land as reviewable git diffs, not a
parallel proposal store. Nothing burns tokens without a user turn behind it.

## Alternatives

- **A. Keep the timer loop with the 2026-07-31 mitigations.** Status quo after the fixes PR.
  Cost is now bounded (≤4 runs/day) but still buys unreviewed artifacts.
- **B. Demote to demand-driven + weekly budgeted digest (recommended).**
  - Kairos keeps OBSERVING (large-file / tsc checks stay — they are cheap and deterministic)
    and keeps surfacing observations on the Telemetry tab.
  - The arsenal ANALYSIS run fires only (a) on owner command, or (b) from a weekly cron with
    a declared budget, producing ONE digest proposal as a git branch, not a proposals.db row.
  - The 65 pending rows are triaged once: anything against files that have since changed is
    purged as stale.
- **C. Delete the repair loop entirely.** Rejected: drops a working capability
  (observation → one-command repair) — violates the never-drop-capabilities rule.

## Decision

Proposed: **B**. Bitter-lesson reading: a handcrafted heuristic loop that pre-computes
answers to questions nobody asked is exactly the scaffold class; the model 6 months out is
better invoked on demand against the live codebase than pre-run every 5 minutes against a
drifting one.

## Tradeoffs

- (+) Ends the recurring burn class instead of re-bounding it each incident.
- (+) Proposals become git-native and actually reviewable.
- (−) Loses "a proposal is already waiting when you look" latency — judged worthless while
  the review channel has a 0% drain rate.
- (−) Small migration cost: cron wiring + proposals.db triage.

## Consequences

- The fixes PR (latch persistence, drift-proof key, `SUDO_KAIROS_REPAIR_MAX_PER_DAY`) ships
  regardless — it is Alternative A hardening and remains correct under B (the budget then
  bounds the cron instead).
- On GO: implement B behind a flag, default matching current behaviour until live-verified;
  file the proposals.db triage as part of the same slice.
