# 06 — BUILD REPORT

**Branch:** `sudo-ai/yt-autonomy`
**Cut from:** `a928d526` (HEAD of `feat/grok-web-chat-brain`, per the brief)
**Commit range:** `a928d526..c938a23b` — 3 commits
**Scope taken:** all four P0 items from `04-ROADMAP.md` Phase A. P1 not started (see "What I skipped").

```
fbbb5bc1  feat(youtube): OAuth refresh provider (GAP-01)
2149b120  feat(youtube): quota ledger + stop fabricating thumbnail CTR (GAP-02, GAP-04a)
c938a23b  feat(youtube): pre-publish policy gate + publish kill switch (GAP-03)
```

---

## WHAT I BUILT

### 1. `src/core/youtube/auth.ts` — OAuth refresh provider (GAP-01) · 283 lines
The blocker. Every YouTube write read `process.env['YOUTUBE_OAUTH_TOKEN']` as a static access
token; Google expires those in ~1 hour, so unattended operation was categorically impossible.

Provides `getYouTubeAccessToken()`: refresh-token grant against `oauth2.googleapis.com/token`,
in-memory + `0600` file cache, 60-second expiry skew, rotation-aware (a refresh token returned by
Google supersedes the configured one and is carried forward across restarts). Fails loudly on
`invalid_grant` with the "re-run consent" hint rather than returning a stale token.

Mirrors the pattern already correct at `src/core/gdrive/auth.ts:59` **without importing it** —
`CLAUDE.md` invariant 3 keeps `core/gdrive` out of other subsystems. Uses a direct POST rather than
a `googleapis` OAuth2 client object: one endpoint, one grant type, and a plain call lets tests
inject a fetch instead of mocking a library.

Legacy `YOUTUBE_OAUTH_TOKEN` still works so nothing breaks, with a warning that it cannot renew.

**Wired into:** `social.youtube-upload`, `social.youtube-analytics`, `CommentEngine.postReply`.

### 2. `src/core/youtube/quota-ledger.ts` — daily quota accounting (GAP-02) · 244 lines
Nothing counted API units. `videos.insert` costs 1,600 of a 10,000/day allowance and `search.list`
costs 100 — so ~100 searches silently make the day's upload impossible, presenting as a 403 at 3am.

`QuotaLedger` provides `spend()` / `canAfford()` / `status()` / `breakdown()` over SQLite:
- **Pacific-day bucketing** via the IANA zone (`America/Los_Angeles`), not a fixed UTC offset — a
  hardcoded -8 would mis-bucket eight months of the year by an hour.
- **Publish reserve**: 1,600 units are held back and only `videos.insert` may draw on them, so a
  chatty analytics job cannot starve the publish lane. This asymmetry is the point of the module.
- **`search.list` denied by default**, with the zero-unit RSS alternative named in the error.

### 3. `src/core/youtube/policy-gate.ts` — pre-publish gate (GAP-03) · 207 lines
YouTube enforces the inauthentic-content policy at the **channel** level, so one templated batch
retroactively endangers the whole back catalogue. Publishing 6×/day with no check can destroy the
asset faster than it builds it.

`assessPublishCandidate()` returns `pass` | `block` | `hold`. It targets **sameness, not AI
authorship** — the policy explicitly permits synthetic narration of an original script.
- Word-trigram Jaccard similarity against recently published scripts (threshold 0.6, deliberately
  cautious: a false block costs a rewrite, a false pass costs the channel).
- Structural minimums — empty/thin script reads as a slideshow; an over-length title is **rejected
  rather than silently truncated** (the upload tool's `title.slice(0,100)` quietly mangles).
- Optional independent judge (caller pins the route, per `CLAUDE.md` invariant 7).
- **Fails closed:** a judge that throws returns `hold`, never `pass`. `mayPublish()` approves only
  an explicit `pass`.

No new dependencies — the similarity check is plain code. Embeddings can be swapped in later.

### 4. GAP-04a — stopped the fabricated CTR
`thumbnail-ab.ts:_fetchAndStoreCtr` wrote a hardcoded `measured_ctr = 0.04` and
`impressions = viewCount` for **every** variant, into the same DB columns a real measurement would
occupy. Views are not impressions and 0.04 was not measured; nothing downstream could tell the
invention from data. It now records nothing it cannot measure and makes no network call.

### 5. Publish kill switch — `SUDO_YT_PUBLISH_ENABLED`, default OFF
Per the brief, everything touching a live account stays off. `social.youtube-upload` refuses unless
the flag is exactly `'1'`, returns what it *would* have uploaded, and spends no quota while
disabled. It also now spends `videos.insert` against the ledger **before** starting, so an
exhausted quota fails fast instead of after a long PUT.

---

## TESTS

**54 new tests across 5 files, 727 lines.** All green.

| File | Tests | Covers |
|---|---|---|
| `tests/youtube/auth.test.ts` | 17 | Refresh, caching, rotation, invalid_grant, non-JSON, fail-not-fallback. **Drives a fake clock across the 1-hour expiry boundary** — the exact thing that was broken. |
| `tests/youtube/quota-ledger.test.ts` | 13 | Pacific bucketing incl. a PST-vs-PDT pair, day rollover, reserve asymmetry both directions, search denial, and the "100 searches exhaust the day" case that motivated it. |
| `tests/youtube/policy-gate.test.ts` | 16 | Similarity maths, near-duplicate blocking, structural checks, judge rejection, **judge-throws ⇒ hold**, short-circuit ordering. |
| `tests/youtube/thumbnail-ab-no-fabrication.test.ts` | 3 | Regression: no `0.04`, no winner from no data, no network call. |
| `tests/youtube/upload-killswitch.test.ts` | 5 | Default-off, off for any non-`'1'` value, no quota spent while off, quota refusal before upload. |

Coverage is behavioural, not shape-asserting — each test drives the failure mode the code exists to
prevent.

---

## `pnpm verify` — HONEST STATUS: **RED, with zero regressions from my work**

I am not going to claim green. Here is exactly what I ran and what came back.

- `pnpm lint` (= `tsc --noEmit`): **PASS**, clean.
- `pnpm build`: not independently exercised past the failing test step.
- `pnpm test`: **1058 files / 12,800 tests pass; 6 tests across 5 files fail.**

**None of the failures are mine, and I proved it rather than asserting it.** I created a worktree at
the base commit `a928d526`, symlinked the same `data/` and `workspace/` directories, copied in the
same uncommitted `src/llm/client.ts`, and ran the identical five files at base and on my branch:

```
BASE (a928d526)                          MINE (c938a23b)
tests/agent/cw0-brief-instrumentation    tests/agent/cw0-brief-instrumentation
tests/gdrive/cli                         tests/gdrive/cli
tests/health/cw6-homeostat               tests/health/cw6-homeostat
tests/llm/transport                      tests/llm/transport

DIFF (mine-only regressions): <empty>
```

**Identical failure sets. Zero regressions.**

Root causes, as far as I traced them:
- `tests/llm/transport.test.ts` — caused by the **uncommitted `src/llm/client.ts` in the working
  tree** (another session's work). It adds an on-disk xAI key fallback to `getProviderApiKey`, so
  the "missing API key → throw" assertion no longer holds when `data/xai-apikey.json` exists. I left
  that file alone per D-02.
- `tests/gdrive/cli`, `cw0-brief-instrumentation`, `cw6-homeostat` — snapshot/state tests reading
  real on-disk `data/` and `workspace/` content that has drifted from the pinned expectations.
- The two extra `system-prompt-inject-caps` failures seen only in the full parallel run are
  test-pollution; they pass in isolation on both base and branch.

My own 54 tests pass in every configuration tried, including a clean detached worktree.

---

## WHAT I SKIPPED, AND WHY

- **All P1/P2 items.** The brief said depth over coverage and P1 only if P0 finished with nothing
  flaky. P0 finished clean, but `pnpm verify` is red for environmental reasons I did not create and
  should not silently paper over. Starting P1 on top of an unverifiable baseline would have been the
  wrong call. Three working things, as asked.
- **GAP-07 (long-form render orchestrator)** — the largest item in the roadmap, and correctly
  sequenced *after* the policy gate. Building a faster content factory before the gate exists is
  building faster in the wrong direction.
- **GAP-04b (real thumbnail A/B)** — needs `thumbnails.set` plus Analytics `impressions`. Deliberately
  left disabled rather than half-built; the fabrication is stopped, which was the urgent part.
- **Nothing was BLOCKED by `protected-paths.ts`.** I checked: `src/core/youtube/` and
  `src/core/tools/builtin/social/` are both unprotected. `src/core/tools/builtin/meta/` *is*
  protected and contains a YouTube comment-engine wrapper I did not touch — it reads
  `YOUTUBE_OAUTH_TOKEN` directly and should be migrated to the new provider by someone with the
  authority to edit protected paths. **Logged as the one BLOCKED item.**

## WHAT'S STILL STUBBED

- `thumbnail-ab.ts` A/B is now *honest* but *inert* — it measures nothing and cannot deploy a
  thumbnail. It should be considered disabled until GAP-04b.
- `CommentEngine.postReply` reaches real code now, but has no rate limiter and no safety filter, so
  it must not run unattended (GAP-10).
- The policy gate is **built and tested but not yet on the publish path** — nothing calls it before
  `social.youtube-upload`. The kill switch is what currently stands between the system and a real
  channel. Wiring the gate in is the first item below.

---

## WHAT I'D WANT A SECOND PAIR OF EYES ON

1. **The 0.6 similarity threshold is a guess.** It is calibrated against my synthetic fixtures, not
   against real scripts. It should be tuned on a real corpus before anyone trusts it. Logged in
   `00-ASSUMPTIONS.md`.
2. **Quota reservation is not atomic across processes.** Two daemons could both pass `canAfford`
   and both spend. Single-process today, but it needs a transaction if the publish lane is ever
   forked.
3. **`getYouTubeAccessToken` has no in-flight dedupe** — concurrent callers on a cold cache will each
   perform a refresh. Harmless (Google tolerates it) but wasteful.
4. **Whether the policy gate belongs on a protected path.** It is a safety-critical component by the
   same logic as `veto-gate.ts`, and an agent that can edit its own policy gate can publish anything.
   I did not add it to `PROTECTED_PATHS` because that file is itself protected. **Frank's call.**

---

## EXACT NEXT THREE THINGS

1. **Wire the policy gate into the publish path.** Build the publish orchestrator that calls
   `assessPublishCandidate()` and refuses to invoke `social.youtube-upload` on anything but `pass`,
   plus a test asserting no bypass path exists (production-readiness gate 3 in `04-ROADMAP.md`).
   Without this the gate is a library nobody calls.
2. **GAP-08 — delete the `search.list` pagination** at `src/core/feedback/youtube-api.ts:75` and
   replace it with the zero-quota channel RSS feed. Small, strictly cheaper, removes the live quota
   bomb. The ledger now guards the *new* call sites but that one predates it.
3. **GAP-05 — `videos.update`.** Metadata is write-once today, so titles can never be revised. At 50
   units it is the cheap experimentation actuator and it unlocks title A/B without any Studio
   automation. Must read-modify-write the full `snippet` — a partial update erases omitted fields.

Then GAP-06 (YPP readiness) as a quick win before touching GAP-07.

---

## CREDENTIAL HYGIENE

- Zero credentials in code, config, or tests. Verified by grep over `src/core/youtube/` and
  `tests/youtube/`: no hardcoded secrets.
- All new secrets are env-var only: `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`,
  `YOUTUBE_OAUTH_REFRESH_TOKEN`, `YOUTUBE_TOKEN_FILE`.
- The token cache is written at `0600`, defaults to `data/youtube-oauth.json` (gitignored path
  convention), and **must not** be placed in `ecosystem.config.cjs` — that file enumerates env and
  is committed.
- Only token *lengths* and expiry timestamps are logged, never token material.
- Everything touching a live account is behind `SUDO_YT_PUBLISH_ENABLED`, default OFF. **I did not
  turn it on.**
