# 00-ASSUMPTIONS — things I could not verify and assumed anyway

Every item here is a place where a wrong assumption changes a conclusion. Ranked by how much damage
being wrong would do.

---

## A-01 | The 0.6 similarity threshold in the policy gate is a guess
`policy-gate.ts` blocks at Jaccard ≥ 0.6 on word trigrams. That number is calibrated against
synthetic fixtures I wrote, **not against real scripts**, and I have no corpus of real published
YouTube scripts to tune it on. It is deliberately biased toward false blocks (a rewrite costs
minutes; a templated video reaching a monetised channel costs the channel).
**Damage if wrong:** either nuisance blocking, or — worse — templated content sliding through.
**How to close:** run it over 50 real scripts and look at the score distribution.

## A-02 | Unit-economics inputs are market averages, not measured costs
Gate 5 in `01-VIABILITY.md` uses ~$0.20/1k chars for ElevenLabs, ~$0.04/image, $3/$15 per Mtok, and
a $8 planning RPM. These come from published pricing and 2026 niche RPM reporting, not from a bill
this project has actually paid. The ~3-minute average view duration used to derive the ~80,000-view
runway is a reasonable faceless-channel figure, **not a measurement**.
**Damage if wrong:** the ~$400 pre-revenue figure could be 2–3× off. Still not fatal at that scale,
which is why the gate passes regardless.

## A-03 | RESOLVED — closed in VERIFICATION PASS 2 (see 02-CAPABILITIES)
Rows #2, #3, #4, #16, #20 and cost-control were all opened and closed on 2026-08-01T17:40Z.
**My suspicion about trend-radar was wrong** — it makes real HTTP calls to Hacker News, Reddit and
Google Trends with deterministic scoring and no model. But `competitor-monitor.ts:157` turned out to
be a *worse* fabrication than the CTR stub (it prompts for "realistic" alerts and stores them as
observations) → **GAP-15**. Only `browser/auth.ts` remains unread, deliberately: Gate 2 rules Studio
automation off the publish path, so it changes no verdict.

### Original text of A-03, kept for the audit trail
Subagent fan-out died on credits (D-04), so I read the files that decide the verdict and left the
rest explicitly unread rather than guessing. Specifically NOT opened:
`src/core/awareness/trend-radar.ts` + `trend-radar-scanners.ts`, `competitive/competitor-monitor.ts`,
`social/social-intelligence.ts`, `business/analytics.ts`, `skills/content/viral-hook/`,
`tools/builtin/browser/auth.ts`, and most of `outcomes/`, `learning/`, `self-improvement/`.
**The single most important open question:** does trend-radar make real HTTP calls to real sources,
or does it prompt a model to imagine trends and return the text as data? Given `thumbnail-ab.ts:296`
existed in this repo, I would not assume the former.
**Damage if wrong:** capability #4 could be L0 rather than L4-achievable.

## A-04 | RESOLVED — CONFIRMED, and it is worse than an assumption
`cost-tracker.ts:361 checkBudget()` computes `{ exceeded, current, limit }` correctly and **has zero
callers**. Grep for `checkBudget|exceedsDailyBudget|isOverBudget|overBudget` across `src/`: no call
sites. The daily spend budget is a pure reporting function nothing acts on — no code path stops work
on exhaustion. Violates `CLAUDE.md` invariant 10. **Roadmap B6 upgraded P1 → P0.** Not an
over-scope; an under-scope.

## A-05 | RESOLVED — partly wrong; the scheduler is better than I assumed
`src/core/cron/scheduler.ts` has per-job consecutive-error tracking, exponential backoff
(`backoffFor`, `:321`) and auto-disable after `MAX_CONSECUTIVE_ERRORS` (`:313`). Real durability at
the *job* level. What is genuinely absent is **per-stage checkpointing within a job** — a pipeline
that dies at render restarts from zero and re-pays for completed stages. B5 stands but is rescoped
to "pipeline checkpointing", not "build a scheduler".

## A-06 | Quota costs are current
`QUOTA_COSTS` uses Google's published figures (insert 1600, search 100, update 50, list 1,
thumbnails.set 50). Google has changed these before and gives little notice.
**How to close:** assert against a live 403 body, or re-check the docs quarterly.

## A-07 | "Google account creation cannot be automated" is taken as settled
I did not test it and will not. It violates the Google ToS and is phone/CAPTCHA-gated regardless.
Gate 3 is built on this. I am confident, but it is an assumption, not an experiment.

## A-08 | Test failures are environmental, proven by differential run — but the root causes are partly inferred
I proved **zero regressions** by running the same five files at base and on branch with identical
env (see 06). The *causes* are partly inference: I confirmed the uncommitted `src/llm/client.ts`
adds an on-disk xAI key fallback that plausibly explains `tests/llm/transport.test.ts`, but I did
not run it with that file reverted (D-02: not mine to touch). `cw0`, `cw6-homeostat` and
`gdrive/cli` I attribute to drifted on-disk `data/`/`workspace/` state **without proving it**.
**Damage if wrong:** low — the differential result stands on its own regardless of cause.

## A-09 | The publish reserve default of 1,600 units assumes one upload per day
`QuotaLedger` reserves exactly one `videos.insert`. A channel publishing twice a day needs 3,200.
Configurable via `publishReserve`, but the default encodes a strategy choice — which, per Gates 1
and 4 both pointing at *fewer, more varied* videos, I think is the right default.

## A-10 | RESOLVED — `data/` is gitignored, verified
Assumed, then checked: `git check-ignore -v data/youtube-oauth.json` → `.gitignore:30: data/`.
The token cache and quota DB cannot be committed. This matters more than the other items here,
because that file holds a refresh token with upload scope on a potentially monetised channel — the
most sensitive credential this project would ever hold. **No longer an assumption.**
