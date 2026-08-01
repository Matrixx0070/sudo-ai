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

## A-03 | Several capability rows in 02 are UNVERIFIED
Subagent fan-out died on credits (D-04), so I read the files that decide the verdict and left the
rest explicitly unread rather than guessing. Specifically NOT opened:
`src/core/awareness/trend-radar.ts` + `trend-radar-scanners.ts`, `competitive/competitor-monitor.ts`,
`social/social-intelligence.ts`, `business/analytics.ts`, `skills/content/viral-hook/`,
`tools/builtin/browser/auth.ts`, and most of `outcomes/`, `learning/`, `self-improvement/`.
**The single most important open question:** does trend-radar make real HTTP calls to real sources,
or does it prompt a model to imagine trends and return the text as data? Given `thumbnail-ab.ts:296`
existed in this repo, I would not assume the former.
**Damage if wrong:** capability #4 could be L0 rather than L4-achievable.

## A-04 | I assumed the cost-tracker's daily budget does not actually halt execution
`src/core/billing/cost-tracker.ts:360` has a daily-USD-budget *check*. I did not trace whether any
caller acts on it. I wrote the roadmap as if it does not enforce.
**Damage if wrong:** I over-scoped roadmap item B6. Cheap error.

## A-05 | I assumed no durable job queue backs the publish path
No YouTube reference appeared in the `src/core/cron/` listing and I did not read the scheduler.
The system view in 03 and roadmap item B5 both assume publishing is fire-and-forget.
**Damage if wrong:** B5 is redundant. Cheap error.

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
