# 06 — BUILD REPORT

**Branch:** `sudo-ai/yt-autonomy` · **Cut from:** `a928d526` · **HEAD:** `e1e96ebb`
**Range:** `a928d526..e1e96ebb` — **35 commits**
**Last refreshed:** 2026-08-02. *Supersedes the original version of this file, which described only
the first four Phase-A items and had become actively misleading.*

**8 new source files (2,002 lines) · 13 new test files (164 tests) · 4 tools registered.**
`pnpm lint` clean. Full suite **12,916 pass / 6 fail**, all six pre-existing and proven so.

---

## THE ONE-PARAGRAPH VERSION

The audit said the system was at **L1** — it could not complete two unattended operations in a row,
could not account for the resources it spent, and could not tell you whether what it was about to
publish would get the channel demonetised. All three are now false. Phase A is complete and four
Phase-B items are done. What has *not* changed: the system still cannot produce a video worth
publishing (GAP-07), and the verdict's ceiling of **L4** stands.

The recurring theme across the run is worth stating once: **every roadmap item turned out to be
worse than its entry said, and the thing that found the extra defect was always *running* something
— never reading it.**

---

## WHAT SHIPPED

### Phase A — "it can act unattended at all" (all P0, complete)

| Item | Commit | What it closed |
|---|---|---|
| **GAP-01** OAuth refresh | `fbbb5bc1` | `YOUTUBE_OAUTH_TOKEN` was a static access token — every YouTube write died ~1h after a human pasted it. `src/core/youtube/auth.ts` (283 lines): refresh-token grant, `0600` cache, rotation-aware, fails loud on `invalid_grant`. Tests drive a fake clock across the expiry boundary. |
| **GAP-02** Quota ledger | `2149b120` | Nothing counted API units. `quota-ledger.ts` (244): Pacific-day bucketing via the IANA zone (a fixed −8 mis-buckets 8 months a year), a publish reserve reads cannot draw on, `search.list` denied by default. |
| **GAP-04a** Fabricated CTR | `2149b120` | `thumbnail-ab.ts` wrote a hardcoded `measured_ctr = 0.04` and `impressions = viewCount` into the columns real measurements occupy. Views are not impressions and 0.04 was not measured. Now records nothing it cannot measure. |
| **GAP-03** Policy gate | `c938a23b`, `b803c945` | Channel-level enforcement makes this safety-critical. Two commits because the first shipped only the library — see "the recurring defect" below. |
| **GAP-15** Fabricated competitor alerts | `f885732a` | `checkActivity()` prompted the model to *"generate 1-3 **realistic** activity alerts"* and stored them as observations, with zero network calls. Worse than the CTR stub: varied, specific prose that reads as intelligence. Deleted; the honest fallback is now the only path. |
| **B6** Enforced spend caps | `1386d621` | See below — this was two defects, not one. |

### Phase B — "it can measure and iterate"

| Item | Commit | What it closed |
|---|---|---|
| **GAP-08** `search.list` quota bomb | `a3c5b4ce` | 400 quota units per invocation (100/page × 4) on the **default** path. Replaced by channel RSS (**0 units**) → `playlistItems.list` (1 unit/50). 100× reduction. |
| **GAP-05** `videos.update` | `8e091a36` | Metadata was write-once; titles could never be revised. `metadata.ts` (245) always read-modify-writes because `videos.update` is a **full replace** that blanks omitted fields. |
| **GAP-06** YPP readiness | `e1e96ebb` | `ypp-readiness.ts` (217). Three requirements have no API at all, so they are `human-verify` criteria and the model can never report `eligible` while any is unconfirmed. |
| **B3 partial / trend sources** | `51a4ce4c` | YouTube trending scanner (1 quota unit, live-proven) + X scanner (paid, off by default). Found Reddit dead — 403 from datacenter IPs, failing silently at `debug`. |

### Supporting work

- **`src/llm/xai-billing.ts`** (`7b9c16bc`, 339 lines) — the xAI half of the money guard, on the
  **documented** Management API rather than the console's undocumented gRPC. Wired into `callIR`.
  **Inactive until an operator mints a management key.**
- **`scripts/capture/mitm-capture.py`** (`27020356`, `2c08fffe`) — reusable full-fidelity traffic
  capture (HTTP bodies + WebSocket both directions). Built after six failed CDP attempts; it
  revealed Grok Business chat is a WebSocket, which is why nothing HTTP-based ever saw it.

**One commit I cannot attribute to this run:** `559720bf perf(grok): cut the statsig cold path from
~28s to ~30ms` (08-01 19:46) touches `grok-statsig-oracle.ts` / `grok-statsig-pool.ts`, files this
run never edited, doing work this run never performed. It is present on the branch and its tests
pass. Flagged rather than claimed.

---

## THE RECURRING DEFECT: "built but nothing calls it"

This pattern appeared **five times**, and is the single most useful thing to carry forward:

1. **`cost-tracker.checkBudget()`** — computes a correct budget verdict. Zero callers. Ever.
2. **The policy gate** — shipped as a library in `c938a23b`; nothing invoked it. Worse, there was no
   published-script corpus, so its cross-video similarity check scored 0 against nothing and would
   have passed every templated script *even once wired*. Both halves fixed in `b803c945`.
3. **Media spend recording** — `video-tools`, `factory-tools`, `image-tools` and `thumbnail-tool` all
   returned **zero** hits for any cost-tracker reference. So wiring `checkBudget` alone would have
   enforced a cap against a number that was structurally always zero.
4. **GAP-05** — nearly shipped as a library; registered as `social.youtube-update-metadata` instead.
5. **GAP-06** — same; registered as `social.youtube-ypp-readiness`.

From item 3 onward, registration was **verified programmatically**, not assumed.

---

## PRODUCTION-READINESS GATES (`04-ROADMAP.md`)

**Passing: 3, 4, 6, 7, 8, 9, 13, 16.**

| # | Gate | Evidence |
|---|---|---|
| 3 | No publish path bypasses the policy gate | `publish.test.ts` asserts at **source level** that `opts.upload(` appears exactly once and the verdict guard precedes it |
| 4 | Gate fails closed | judge throws ⇒ `hold` ⇒ uploader never invoked |
| 6 | Zero fabricated metrics | GAP-04a + GAP-15 both deleted; regression tests assert no network call and no invented values |
| 7 | Quota ledgered, upload reserve protected | reserve asymmetry tested both directions |
| 8 | Spend caps **halt** | a 100-iteration retry storm halts after **5** calls (per-job) / **2** (daily) |
| 9 | `search.list` not called, grep-verified in CI | `no-search-list.test.ts` scans all of `src/` |
| 13 | YPP readiness tracked + alerting | `ypp-readiness.test.ts` |
| 16 | Kill switch, default OFF | `SUDO_YT_PUBLISH_ENABLED`, tested for every non-`'1'` value |

**Still open:** 1, 2 (need a real refresh token in place), 5 (AI disclosure not implemented),
10, 11 (pipeline checkpointing / upload resume), 12 (dashboard), 14, 15 (need real operation).

---

## TEST COVERAGE OF NEW CODE

| File | Tests |
|---|---|
| `tests/llm/xai-billing.test.ts` | 22 |
| `tests/youtube/metadata.test.ts` | 19 |
| `tests/youtube/ypp-readiness.test.ts` | 19 |
| `tests/awareness/trend-radar-youtube-x.test.ts` | 18 |
| `tests/youtube/auth.test.ts` | 17 |
| `tests/youtube/policy-gate.test.ts` | 16 |
| `tests/billing/media-spend.test.ts` | 12 |
| `tests/youtube/publish.test.ts` | 12 |
| `tests/youtube/quota-ledger.test.ts` | 11 |
| `tests/youtube/upload-killswitch.test.ts` | 7 |
| `tests/youtube/competitor-no-fabrication.test.ts` | 5 |
| `tests/youtube/no-search-list.test.ts` | 3 |
| `tests/youtube/thumbnail-ab-no-fabrication.test.ts` | 3 |
| **Total** | **164** |

The tests are behavioural, not shape-asserting — each drives the failure mode its code exists to
prevent. Three found real bugs in my own code: same-millisecond corpus ordering (`publish.ts`), an
array-identity comparison that was always false (`comment-api.ts`), and a second `search.list` call
site that reading had missed (`comment-api.ts`).

---

## `pnpm verify` — RED, with zero regressions, unchanged from the original report

`pnpm lint` (tsc) **passes clean**. `pnpm test`: **12,916 pass, 6 fail** across 5 files —
`cw0-brief-instrumentation`, `system-prompt-inject-caps` (×2), `gdrive/cli`, `cw6-homeostat`,
`llm/transport`.

**All six are pre-existing and were proven so**, not assumed: a worktree at base `a928d526` with
identical `data/`, `workspace/` and the same uncommitted `src/llm/client.ts` produced the
**identical failure set**. The `llm/transport` one is caused by that uncommitted file adding an
on-disk xAI key fallback, which breaks its "missing API key" assertion. It belongs to another
session; I left it alone throughout.

The count has been re-checked after every commit in this run and has never moved off six.

---

## WHAT IS STILL STUBBED OR ABSENT

- **GAP-07 — long-form production.** The largest open item. `media.shorts-factory` still produces a
  static image with a voiceover — the audit's headline finding, and precisely the artifact Gate 4
  demonetises. `src/remotion/` compositions remain unwired.
- **GAP-04b — real thumbnail A/B.** Honest but inert: it measures nothing and there is still **no
  `thumbnails.set` call anywhere in the repo**, so a variant cannot be deployed.
- **Comment replies** reach real code now but have no rate limiter and no safety filter.
- **Upload** still `readFileSync`s the whole video and has no resume (GAP-11).
- **Two Analytics clients** still exist and will drift (GAP-12).
- **AI-disclosure flag** not implemented (gate 5). `selfDeclaredMadeForKids` is the COPPA flag, not
  the synthetic-media one.

---

## NEEDS AN OPERATOR (owner-only, cannot be done from here)

1. **YouTube OAuth refresh token** — the Gate-3 one-time consent flow. Until then GAP-01 is
   structurally correct but unexercised against a real account.
2. **xAI management key** — Console → Settings → Management Keys. **Not** `XAI_API_KEY` (verified:
   it returns 401 on all three billing endpoints). Until then the xAI spend guard is `inactive` and
   xAI spend is **not** being verified.
3. **Reddit OAuth app-only credential** — or accept that trend source stays dead.
4. **Two protected-path items** I could not touch: `builtin/meta/comment-engine.ts` still reads the
   static token, and `policy-gate.ts` arguably belongs in `PROTECTED_PATHS` by the same logic as
   `veto-gate.ts` — an agent that can edit its own policy gate can publish anything.

---

## WHAT I'D WANT A SECOND PAIR OF EYES ON

1. **The 0.6 similarity threshold** is still calibrated on synthetic fixtures, not real scripts.
   Unchanged since the first report and still the weakest number in the system.
2. **Media unit costs are estimates**, documented as such. They bound a runaway loop rather than do
   accounting — being 30% wrong still stops the storm, but they are not billing truth.
3. **xAI billing response field names are UNVERIFIED** — no management key, so the shapes were never
   exercised. Transport proven, parsing not.
4. **The Shorts-views metric** uses the documented `creatorContentType==shorts` filter, unexercised.
5. **Quota reservation is not atomic across processes.** Single-process today; needs a transaction if
   the publish lane is ever forked.
6. **`social.youtube-upload` still does `title.slice(0,100)`** — silent truncation — while the new
   metadata tool rejects over-length titles outright. The upload tool is now the inconsistent one.

---

## EXACT NEXT THREE

1. **GAP-04b — real thumbnail A/B.** Needs `thumbnails.set` (50 units) to deploy plus Analytics
   `impressions` / `impressionClickThroughRate` to measure. The OAuth plumbing already exists; only
   the metric names change. Turns a disabled fake into the second experimentation actuator.
2. **Fix the upload tool's silent title truncation**, for consistency with GAP-05. Ten minutes.
3. **GAP-07 — long-form orchestrator.** The big one. Before writing it, evaluate
   `digitalsamba/claude-code-video-toolkit` (1,883★, MIT, actively maintained) as a **reference
   architecture** — its economics land inside the audit's Gate 5 estimate and its output is
   multi-scene with motion and captions, i.e. the shape that does not trip Gate 4. Not a drop-in
   (Python + cloud GPU), but it may save a week of design.

---

## CREDENTIAL HYGIENE

Unchanged and re-verified: zero credentials in code, config or tests. All new secrets are env-only
(`YOUTUBE_OAUTH_*`, `XAI_MANAGEMENT_KEY`, `X_API_BEARER_TOKEN`). The token cache is `0600` under
`data/`, which is gitignored (`git check-ignore` confirmed). Only token *lengths* and expiry
timestamps are ever logged. Everything touching a live account or real money is behind a
default-OFF flag — `SUDO_YT_PUBLISH_ENABLED`, `X_API_BEARER_TOKEN` absence, `XAI_MANAGEMENT_KEY`
absence — with the single deliberate exception of the media spend **caps**, which default **ON**
because a money guard that ships disabled is the exact failure being fixed.

**I did not turn anything on.**
