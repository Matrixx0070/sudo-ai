# 04 — ROADMAP

Sequencing rationale in one line: **make it authenticate, make it safe, make it measurable, then
make it good.** Anything that produces content before the policy gate exists is building inventory
that may destroy the channel it's published to.

---

## PHASE A — "It can act unattended at all"  (P0, ~3–4 days)

Nothing in this phase produces a single video. That is deliberate. Today the system cannot complete
two unattended operations in a row, cannot account for the resource it spends, and cannot tell you
whether what it's about to publish will get the channel demonetised. Those three facts have to
change before content work means anything.

| Item | GAP | Size | Why here |
|---|---|---|---|
| A1. YouTube OAuth refresh module | GAP-01 | S (1d) | Hard blocker. Every other item depends on it. |
| A2. Quota ledger + `search.list` deny-guard | GAP-02 | S-M (1d) | Prevents silent starvation of the publish lane. |
| A3. Stop the fabricated CTR | GAP-04a | XS (1h) | Removes actively-misleading data. Cheapest high-value fix in the repo. |
| A4. Pre-publish policy gate | GAP-03 | M (1-2d) | Channel-level enforcement makes this safety-critical, not optional. |

**Phase A exit test:** the system refreshes its own token across an hour boundary, refuses an
operation it cannot afford, blocks a deliberately-templated script, and never reports an unmeasured
CTR as measured. All four provable without touching a real channel.

## PHASE B — "It can measure and iterate"  (P1, ~3–5 days)

| Item | GAP | Size | Why here |
|---|---|---|---|
| B1. `videos.update` metadata tool | GAP-05 | S | The cheap actuator. Title A/B needs no Studio automation. |
| B2. Kill `search.list`, RSS/playlistItems intel | GAP-08 | S | Removes the quota bomb; strictly cheaper and faster. |
| B3. YPP readiness model + alerting | GAP-06 | S | Tells the human when to click Apply. Cheap, all inputs exist. |
| B4. Real thumbnail A/B (`thumbnails.set` + Analytics CTR) | GAP-04b | M | Replaces the disabled fake with the real thing. |
| B5. Durable job store for the publish pipeline | (unlisted in 03; surfaced in system view) | M | A crash mid-pipeline currently discards paid generation. Precondition for unattended. |
| B6. Hard per-video and per-day spend cap, enforced | GAP-nn / invariant 10 | S | An unbounded retry against Luma/Runway is the fastest way to lose real money. |

## PHASE C — "It can produce something worth publishing"  (P1, ~1-2 weeks)

| Item | GAP | Size |
|---|---|---|
| C1. Long-form scene-graph → timeline → render orchestrator (wire Remotion) | GAP-07 | **L** |
| C2. Content strategy object enforcing structural variation across videos | GAP-03/#3 | M |
| C3. Streaming upload + resume | GAP-11 | S-M |

C1 is the largest item in this document and should not be started until Phase A is green — building
a better content factory while the policy gate is missing is building faster in the wrong direction.

## PHASE D — Optimisation and long tail  (P2)

D1 experiment registry with real significance testing (GAP-09) · D2 comment replies with rate limit
+ safety filter (GAP-10) · D3 dedupe the two Analytics clients (GAP-12) · D4 account-health/strike
monitoring (GAP-13) · D5 Studio assist lane, best-effort only (GAP-14).

---

## PRIORITISED BACKLOG

| ID | Item | GAP | Size | Tag |
|---|---|---|---|---|
| A1 | OAuth refresh + token persistence | GAP-01 | S | **P0** |
| A2 | Quota ledger + search guard | GAP-02 | S-M | **P0** |
| A3 | Disable fabricated CTR | GAP-04a | XS | **P0** |
| A4 | Pre-publish policy gate | GAP-03 | M | **P0** |
| B1 | videos.update metadata | GAP-05 | S | P1 |
| B2 | RSS competitor intel | GAP-08 | S | P1 |
| B3 | YPP readiness | GAP-06 | S | P1 |
| B4 | Real thumbnail A/B | GAP-04b | M | P1 |
| B5 | Durable publish job store | — | M | P1 |
| B6 | Enforced spend caps | — | S | P1 |
| C1 | Long-form render orchestrator | GAP-07 | L | P1 |
| C2 | Content strategy / variation | GAP-03 | M | P1 |
| C3 | Upload streaming + resume | GAP-11 | S-M | P2 |
| D1 | Experiment registry | GAP-09 | M | P2 |
| D2 | Comment replies live | GAP-10 | S | P2 |
| D3 | Dedupe Analytics clients | GAP-12 | S | P2 |
| D4 | Account health / strikes | GAP-13 | S-M | P2 |
| D5 | Studio assist lane | GAP-14 | M | P2 |

---

## DEFINITION OF "PRODUCTION-READY AUTONOMOUS YOUTUBE OPERATION"

These are gates, not aspirations. **All must pass** before this runs unattended on a real account
with real money. Each is stated so it can be executed, not argued about.

**Identity & auth**
1. The system refreshes its own OAuth token across at least a 24-hour unattended window with zero
   human input, proven by log evidence.
2. The refresh token lives in a `0600` file outside the repo, is absent from `ecosystem.config.cjs`,
   git history, and all log output. Verified by grep.

**Safety**
3. Every publish path passes the policy gate. There is **no** code path from agent decision to
   `videos.insert` that bypasses it. Verified by a test that asserts the bypass does not exist.
4. The policy gate fails **closed**: on judge error/timeout, the publish is held, never released.
5. AI-disclosure is set correctly on every upload where required.
6. Zero fabricated metrics. Any unmeasured value is NULL/`unmeasured`, never a plausible constant.

**Resource control**
7. Daily quota consumption is ledgered, and the upload lane's 1,600 units are reserved before any
   discretionary read spends them.
8. A hard per-video and per-day USD cap **halts** the pipeline on exhaustion — proven by a test that
   drives it to the cap and asserts refusal, not by reading the code.
9. `search.list` is not called. Verified by grep in CI.

**Reliability**
10. The publish pipeline is checkpointed per stage; a kill -9 mid-render resumes without re-paying
    for completed stages.
11. Upload failure retries with resume; a 500 MB upload survives a network interruption.
12. Publish success rate, policy-block rate, quota consumption, and cost-per-published-video are all
    observable on a dashboard.

**Business**
13. YPP readiness is tracked and the human is alerted at threshold.
14. 30 consecutive videos published with zero policy strikes and zero human interventions other than
    the Gate-3 minimum set.
15. Cost per published video is measured and below the break-even view count for the niche
    (`01-VIABILITY.md` Gate 5: <530 views at the metered rate).

**Kill switch**
16. A single flag stops all publishing immediately, and it is the default state on deploy.
