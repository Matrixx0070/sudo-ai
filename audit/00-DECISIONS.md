# 00-DECISIONS — calls made instead of asking

Format: `D-nn | decision | reasoning | reversibility`

---

## D-01 | Interpret "the top of what the audit says to build" as scoped to YouTube autonomy, not general repo health
The brief's Phase 1 capability list is entirely YouTube-operations vocabulary (channel setup, YPP,
Studio ops, thumbnails, RPM). So the audit subject is: *can SUDO-AI run an autonomous YouTube
channel business*, using the existing repo as the substrate. Not a general architecture review.
Reversible: yes — the inventory work is reusable either way.

## D-02 | Repo is read-only in Part One, enforced by convention not by tooling
No git checkout/stash/install during Phase 0-4. Only `./audit/**` is written. The pre-existing dirty
files (`src/llm/client.ts` modified, plus 4 untracked scratch files) are LEFT ALONE — they belong to
a prior session (memory: `client.ts` deploys need stash-ff-pop). I will not clean them up.
Reversible: n/a.

## D-03 | Branch cut point
Part Two branches `sudo-ai/yt-autonomy` from **current HEAD a928d526** as instructed, not from `main`.
HEAD is on `feat/grok-web-chat-brain`. Cutting from HEAD means the branch carries unmerged Grok-seat
work. Chose HEAD anyway because the brief said "cut from the current HEAD" explicitly.
The dirty working-tree files are NOT carried into commits (they stay unstaged).
Reversible: yes — rebase onto main later.

## D-04 | Subagent fan-out unavailable — running the audit single-threaded
At 16:36Z I launched 3 read-only inventory subagents. All three returned immediately with
`You're out of usage credits. Run /usage-credits to keep using Fable 5` and zero tool uses.
Consequence: no parallel fan-out. The entire audit is done in one context by me, which means
I must be economical — I read the files that decide the verdict, not every file in the repo.
Where that forces a coverage cut, the affected capability row is marked **UNVERIFIED** rather
than guessed. Reversible: yes — re-run inventory with credits restored.

## D-05 | Took all four P0 items, stopped before P1
`04-ROADMAP.md` Phase A is GAP-01, GAP-02, GAP-04a, GAP-03. All four shipped. I did not start P1
because `pnpm verify` is red for pre-existing environmental reasons (see D-07) and building further
on an unverifiable baseline is worse than stopping. The brief asked for depth over coverage.

## D-06 | BLOCKED: `src/core/tools/builtin/meta/comment-engine.ts` reads YOUTUBE_OAUTH_TOKEN directly
`src/core/tools/builtin/meta/` is in `PROTECTED_PATHS` (`protected-paths.ts:32`). That wrapper still
reads the static env token and so still dies at the 1h mark. I routed around it: the underlying
`src/core/youtube/comment-engine.ts` (unprotected) now uses the refreshing provider, so the
capability is fixed at the source. The protected wrapper needs a one-line migration by someone with
authority to edit protected paths. **Requires Frank.**

## D-07 | `pnpm verify` reported RED, not massaged to green
6 tests across 5 files fail in this working tree. I did NOT fix them, skip them, or quietly omit
them. Instead I proved they are not mine: worktree at base `a928d526` with identical `data/`,
`workspace/`, and the same uncommitted `src/llm/client.ts`, running the same five files —
**identical failure set, zero mine-only regressions.** Detail in `06-BUILD-REPORT.md`.
Reasoning: a false "verify green" is exactly the kind of claim the brief called the worst thing to
hand over. Reversible: yes, once the other session commits or reverts `src/llm/client.ts`.

## D-08 | Policy gate built as a library, not yet wired onto the publish path
`assessPublishCandidate()` is complete and tested but nothing calls it before upload. Wiring it
requires a publish orchestrator that does not exist yet, which is a P1-sized piece of work. What
stands between the system and a real channel today is `SUDO_YT_PUBLISH_ENABLED` (default OFF).
Listed as next-action #1 in `06-BUILD-REPORT.md`. Reversible: yes.

## D-09 | No new dependencies
The similarity check is plain word-trigram Jaccard rather than an embedding call. Zero deps added,
deterministic, testable offline, and good enough for the "one template, 200 videos" case that
actually matters. Embeddings can be swapped in behind the same signature later.

## D-10 | Did not add policy-gate.ts to PROTECTED_PATHS despite arguing it belongs there
By the same logic as `veto-gate.ts`, a safety gate an agent can edit is not a safety gate. But
`protected-paths.ts` is itself protected, so I cannot add it. Surfaced as a recommendation in
`06-BUILD-REPORT.md`. **Requires Frank.**

## D-11 | Verification pass 2 — closed the UNVERIFIED rows, and shipped GAP-15
Frank asked for trend-radar to be read and the UNVERIFIED rows closed. Done; results in
`02-CAPABILITIES.md` § VERIFICATION PASS 2. Two findings changed the roadmap:
- `competitor-monitor.ts:157` prompted the model to "generate 1-3 **realistic** activity alerts"
  and stored them as observations. Disabled immediately (GAP-15) rather than filed — same call as
  GAP-04a, same reasoning: invented observations get believed.
- `cost-tracker.ts:361 checkBudget()` has **zero callers**, confirming A-04. Roadmap B6 upgraded
  P1 → P0; it is now the highest-priority unstarted item.
I was wrong about trend-radar and said so in the doc: it makes real HTTP calls and uses no model.

## D-12 | Kept the now-unused `brain` constructor param on CompetitorMonitor
Removing it would be the clean deletion, but the only caller is
`src/core/tools/builtin/meta/competitor-tool.ts:99`, under a PROTECTED path I must not edit. Kept
the parameter as `_brain` with a doc comment saying it is inert and when to drop it. Deletion
deferred, not forgotten. Reversible: yes, once the protected caller is migrated.

## D-13 | Built YouTube + X trend scanners; deliberately did NOT build TikTok
Frank pointed out the scanners missed the platforms the business runs on. Decisions:
- **YouTube: built and live-proven** against the real API with the real key. 1 quota unit via
  `chart=mostPopular`, never `search.list`. Charged to the GAP-02 ledger.
- **X: built but credential-gated.** X removed the free tier on 2026-02-06; trends are ~$0.010/call.
  I will not commit Frank to recurring spend, so it no-ops without `X_API_BEARER_TOKEN`. The
  response shape is UNVERIFIED (needs a paid token to exercise) and is labelled so in the source.
- **TikTok: not built, on purpose.** No official trending/hashtag endpoints exist; the Research API
  is approval-gated, academic-only and bans commercial use. The only implementable options were
  scraping or asking a model to guess. Given GAP-04a and GAP-15, adding a third fabrication source
  would have been the worst possible call. Documented in the module header instead.

## D-14 | Fixed Reddit's silent death rather than restoring it
The live probe found Reddit returns **403 Blocked** (datacenter IPs), so it contributed 0 of 64
items while reporting success — every failure logged at `debug`. I made it loud (WARN naming the
403 + the OAuth requirement) but did NOT restore it: that needs an OAuth app-only credential, which
is Frank's to create. Making a dead source visible is mine; provisioning a credential is not.
This also corrects my PASS 2 write-up, which called Reddit working based on reading the code.

## D-15 | Evaluated headless X scraper repos for trends — REJECTED for trends, on evidence
Frank asked whether the headless X libraries on GitHub would work for our case. I tested them
rather than reading READMEs.

**What I checked (npm, published source, live calls — 2026-08-01):**
| Package | Version / last publish | Trends? |
|---|---|---|
| `@the-convocation/twitter-scraper` | 0.22.3, 2026-04-01 | `getTrends()` present |
| `agent-twitter-client` (elizaOS family) | 0.0.18, **2025-06-15 — 14 months stale** | fork of the above |
| `rettiwt-api` | 7.1.2, 2026-06-23 (actively maintained) | **no trends support at all** |

`elizaOS/agent-twitter-client` 404s on GitHub. The many `agent-twitter-client-*` forks are all
derivatives of `@the-convocation/twitter-scraper`.

**Live test result — this is the decision:**
- `getTrends()` → **HTTP 404**. It calls `api.x.com/2/guide.json`, which is retired
  (raw curl also returns 400, not 401/403).
- Same library, same session, `getProfile('elonmusk')` → **SUCCESS**, 241,106,917 followers.

So guest auth works fine; **the trends endpoint specifically is gone.** The library is not broken —
X removed the thing we wanted. Reaching trends now means the logged-in GraphQL explore endpoints,
i.e. a real X account + `auth_token`/`ct0` cookies + probably residential proxies. Published
reporting puts the breakage cadence at every 2–4 weeks as X rotates guest tokens and GraphQL ids,
and the library's own README warns "any account you log into with this library is subject to being
banned at any time."

**Decision: do not adopt for trends.** The official endpoint I already built costs ~$0.010/call
(~$7/month hourly). Paying $7 beats an unmaintained, ToS-violating, ban-risking lane that breaks
monthly — and that does not even do trends without an account. This repo has already paid for this
lesson twice: the Grok Cloudflare/Turnstile fight, and the statsig drift that broke a working
minter in production **today**. Adding a third scraped lane on a hostile platform is repeating it.
Also note the parser is positionally brittle by construction
(`instructions[1].addEntries.entries[1].content.timelineModule.items`).

**What IS worth taking from this:** guest-mode profile and tweet reading works, free, right now.
If the goal is X signal rather than X *trends*, reading ~20 curated niche accounts as a guest is
cheaper, more stable, and better-targeted than a global trending list. Logged as an option, not
built — see 06-BUILD-REPORT next-actions.

No dependency was added to the repo; the evaluation ran in /tmp and was cleaned up.

## D-16 | Grok seat CAN do X search — live-proven, citations independently verified
Frank's call. Probed the logged-in Grok web seat (app-chat lane) rather than theorising.

**Finding 1 — no `toolOverrides` key is needed.** The UI's "X search" toggle does not map to a
required payload field. Setting `disableSearch: false` on
`/rest/app-chat/conversations/new` is sufficient; Grok auto-invokes X/web search when the query
warrants it. The first variant tried (`toolOverrides: {}`) succeeded, so the other candidate keys
(`xSearch`, `xPostAnalyze`, `xMediaSearch`) were never needed.

**Finding 2 — the call natively invoked a tool, not narrated one.** The python bridge already
records raw-frame markers for exactly this reason (`grok_web_replay.py`, `MARKER_KEYS`). Result:
`toolMarkers: ["webSearchResults"]` — objective server-side proof. Response also carried
`<grok:render card_type="citation_card">` inline citation cards.

**Finding 3 — the citations are REAL, verified by an independent tool with a control.**
Grok returned 5 structured `{handle, postUrl, topic}` records. I checked every post id with the
guest-mode `@the-convocation/twitter-scraper` (a *different* lane), plus a deliberately fabricated
id as a control:

```
REAL   stary_nick       author=@stary_nick     | "Bardzoo dobry pomysł ... AI o Powstaniu."
REAL   oceanmindai      author=@oceanmindai    | "AI isn't just the future—it's revolutionizing..."
REAL   SingleCharming   author=@SingleCharming | "AMAZON: REDEFINING COMMERCE, CLOUD ... AI"
REAL   harari_yuval     author=@harari_yuval   | "The AI revolution has only just begun..."
REAL   mfaisal_khatri   author=@mfaisal_khatri | "Free resources to learn AI: ..."
ABSENT CONTROL-FAKE     (no tweet object returned)
```
5/5 resolved with matching authors and matching topics; the fabricated id did not resolve, so the
test discriminates. **This is materially different from GAP-04a/GAP-15** — those invented data with
no external referent; this returns externally verifiable artifacts.

**Cost: $0.** Runs on the SuperGrok weekly pool seat already paid for. No scraping by us, no ToS
exposure, and it removes the ~$7/month official-X-API argument entirely.

**Caveats that must shape the design, not be waved away:**
1. The *posts* are verifiable; Grok's **ranking claim ("5 most-discussed") is model judgment and is
   NOT a measurement.** Store the post URLs and topics; never store the ordering as a metric.
2. No engagement counts returned → cannot be scored numerically like HN/Reddit/YouTube items.
3. ~2 minutes per call. A discovery source, never a hot-path one.
4. Depends on the statsig oracle + `grok-warm-browser` pm2 process — the lane that drifted TODAY.
   Already owned and monitored, but it is a real fragility.

**Recommended design (NOT yet built — needs a call on the dependency):**
Grok discovers → guest scraper verifies each cited post exists → only verified posts are admitted.
That is two independent readers agreeing before admission, i.e. the `CLAUDE.md` invariant-9 pattern,
and it is the only shape in which model-sourced trend data belongs in this system.
Open question for Frank: admitting that design means adding a Twitter scraping library to
production dependencies. I did not add it unilaterally — see D-15 for why I am cautious about that
class of dependency.

## D-17 | Installed mitmproxy and cracked the Grok Business WS protocol — no X-search field exists
Frank: "use burp suite or any relevant tool, install it if not available." Burp/mitmproxy were both
absent; installed **mitmproxy 12.2.3** via pip and used it as an explicit HTTP proxy.

**Result: the six earlier CDP attempts failed because there is no send POST.** Business chat runs
over a **WebSocket** — `wss://grok.com/ws/mgw/?uid=<uid>` — with an OpenAI-Realtime-style protocol
(`session.create` → `conversation.item.create` → `response.create` + `ping`). That is invisible to
HTTP-request interception, which is exactly what I kept doing. Full protocol in
`docs/GROK_WEB_CAPTURE_2026-08-01.md`.

**The answer to the original question: there is NO X-search payload field.** Nothing in
`session.create`'s options is a web/X search toggle — only `connector_ids` (MCP),
`enable_image_generation`, `disable_artifact`, `force_concise`, side-by-side flags. This
independently confirms D-16 from a different angle: search is not a flag, Grok invokes it itself.
Two methods now agree, so I consider this closed.

**New finding — `castle_request_token`.** Every `response.create` carries a ~14 KB Castle (castle.io)
anti-bot token, distinct from `x-statsig-id`. So the WS lane needs a *second* browser-bound oracle.
Given this project lost a day to statsig drift on 2026-08-01, **the WS lane is not worth migrating
to**; the REST `/rest/app-chat/conversations/new` door stays the right one — statsig-only,
live-proven, and already does X search.

**Two operational lessons recorded rather than buried:**
1. Cloning the 5.5 GB `grok-warm-profile` to get a logged-in session got the process **OOM-killed**.
   Copying just `Local State` + `Default/Cookies` (500 KB) works and is the correct recipe.
2. `pkill -f "<pattern>"` killed my own shell twice (exit 144) because the pattern matched the
   bash `-c` command line. Kill by PID from `pgrep -x` instead.

**Safety:** the production `grok-warm-browser` statsig oracle was never touched — separate throwaway
profile, separate debug port. Verified after: CDP 9223 → 200, `curl_cffi` imports, bridge returns
valid JSON, live session probe `{"ok":true,"status":200}`. The pip install downgraded
`opentelemetry-proto` and `typing-extensions`; flagged in the doc, prod bridge verified unaffected.

## D-18 | Frank was right — `x_search` IS a real xAI API tool; I had been looking in the wrong place
Frank: "So you did not find any x search tool or api endpoints? I think you're just capturing
grok.com — also try console.x.ai." Correct on both counts.

**Found and live-proven:** `POST https://api.x.ai/v1/responses` with
`tools:[{type:"x_search", allowed_x_handles, excluded_x_handles, from_date, to_date,
enable_image_understanding, enable_video_understanding}]`, model `grok-4.5`. One probe returned
HTTP 200 with 3 real X post URLs + citations. The old Live Search (`search_parameters`) was retired
2026-01-12 → 410 Gone; the Agent Tools API replaces it. Full detail:
`docs/XAI_X_SEARCH_AND_CONSOLE_2026-08-01.md`.

**Measured cost, not estimated:** $0.0442 for that one call (response self-reports
`cost_in_usd_ticks`; 1 tick = 1e-10 USD, cross-checked against component math to within a cent).
Rates: $5 per 1,000 tool invocations + $2/$6 per Mtok on grok-4.5. **The agent chose 4 `x_search`
calls for ONE question**, so cost scales with model decisions, not request count — hourly polling
≈ $32/month. Anything wiring this in must cap `max_tool_calls` and sit behind the enforced spend cap
(B6, still the top open P0, because `checkBudget()` has zero callers).

**This does not contradict D-16/D-17, it completes them.** grok.com's chat genuinely has no
X-search payload field — that finding was right about the *seat lane*. I simply never asked whether
the *metered API* exposed the tool explicitly. It does. Net result: two viable X sources — the seat
lane at $0 marginal with no controls, and the API lane at ~$0.044/query with handle and date
filtering (which is what competitor monitoring actually wants).

**console.x.ai captured too.** Next.js RSC app; the real API is gRPC-web:
`prod_mc_billing.UISvc/{AnalyzeBillingItems,GetAmountToPay,ListPrepaidBalanceChanges}` and
`auth_mgmt.AuthManagement/{GetTeam,ListUserInvitations}`. Team id
`56504cd4-…` matches the `scopeId` in grok.com's MCP connector calls — same tenant, confirmed.
**`GetAmountToPay` breaks out "us-west-2 API grok-4.5 X searches" as its own billing line**, so
x_search spend is independently observable — the exact hook the standing money guard needs.
Decoding the proto frames programmatically is UNVERIFIED and unbuilt; endpoints and request shapes
are known. No credentials, balances or emails recorded.

**Lesson, third instance today after Reddit and castle: check the vendor's documented API before
reverse-engineering their UI.** Reverse engineering is the fallback, not the opening move.

## D-19 | Money guard built on the DOCUMENTED Management API, not the console gRPC
Frank asked me to decode console.x.ai's billing gRPC. I applied the lesson from D-18 first and
checked for a documented API — **there is one**, so I did not decode the gRPC.

`https://management-api.x.ai/v1/billing/teams/{team_id}/…` — paths **verified live** (they return
401 "Please ensure you use a valid management key", not 404):
`postpaid/invoice/preview` · `postpaid/spending-limits` · `prepaid/balance` · `prepaid/top-up` ·
`invoices` · `billing-info` · `payment-method` · `usage`.

Replaying `prod_mc_billing.UISvc/*` would have meant grpc-web+proto framing, cookie auth and no
schema — brittle, and it breaks on the next console build. The REST API is the supported surface.

**Built:** `src/llm/xai-billing.ts` + 22 tests. Semantics chosen deliberately:
- **unconfigured ⇒ `inactive`** — must not break lanes that work today;
- **configured but unreadable ⇒ `block`** — a guard that degrades to "allow" on an API error is
  exactly how `cost-tracker.checkBudget()` fails; not repeating it;
- **over the operator cap or xAI's hard limit ⇒ `block`**;
- unrecognised response ⇒ `block`, never "$0 spent". `extractUsd` returns `null` rather than `0` so
  "no amount found" and "amount is zero" can never be confused.

**Wired, not just built.** `callIR` (`transport.ts`) now calls `assertXaiSpendAllowed()` on the
`xai` / `xai-oauth` providers. A verdict nobody acts on was the whole complaint about `checkBudget`;
shipping another one would have been indefensible. Memoised 120s, so no per-call HTTP round-trip —
and a `block` verdict is cached too, so a billing outage cannot become a stampede.

**Response field names are UNVERIFIED** — this project holds no management key, so shapes could not
be exercised. Extraction tries several plausible names and fails closed on none matching. Honest
status: the transport is proven, the parsing is not.

**BLOCKER for Frank (owner-only):** create a management key at *xAI Console → Settings → Management
Keys* (it is NOT `XAI_API_KEY`; the API key returns 401 here — verified). Then set
`XAI_MANAGEMENT_KEY`, `XAI_TEAM_ID=56504cd4-01d0-49a9-9a6b-88ebbc2b36c7`, and optionally
`SUDO_XAI_SPEND_CAP_USD`. Until then the guard is `inactive` and spend is NOT verified.

**Caught by an existing test, correctly:** my first version imported `../core/shared/logger.js`,
breaking `grok-extraction-boundary` — `src/llm/{grok,xai}-*.ts` must reach host services only via
`grok-runtime.ts`. Fixed to use the seam. Good invariant; it did its job.

## D-20 | Wired the policy gate onto the publish path — and found it was doubly inert
Returning to the YouTube roadmap, next-action #1 was "wire the policy gate; it is a library nobody
calls." Verified before building: grep for `assessPublishCandidate` outside its own file returned
**only the re-export in index.ts**. Nobody called it.

**Worse, and not in the original write-up:** there was **no store of published scripts**, so the
gate's cross-video similarity check — the one that actually maps to YouTube's inauthentic-content
policy — had an empty corpus, would score 0 against nothing, and would have passed every templated
script even once wired. A gate nobody calls, checking against a corpus that does not exist, is not a
gate. Both halves are now built (`src/core/youtube/publish.ts`).

**The invariant is asserted, not asserted-in-a-comment.** Production-readiness gate 3 in
`04-ROADMAP.md` demands a test proving no bypass exists. `publish.test.ts` includes a source-level
check that `opts.upload(` appears **exactly once** and that the `verdict !== 'pass'` guard precedes
it, plus behavioural tests that the uploader is never invoked on block, on hold (judge threw), or on
a thin script.

**Real bug found by the tests, fixed in source not in the test:** `recent()` ordered only by
`published_at`, which has millisecond resolution — two videos recorded in the same millisecond came
back in arbitrary order, silently changing *which* prior videos the similarity check sees once the
corpus exceeds the limit. Added a `rowid DESC` tiebreaker.

Layering is deliberate, outermost first: `SUDO_YT_PUBLISH_ENABLED` (default OFF) → GAP-02 quota
reservation → policy gate (fails closed) → upload. `realUploader()` lazy-imports the tool so those
guards stay the outer defences rather than being duplicated.

Also: a failed upload does **not** record to the corpus — a video that never went live must not
poison future similarity checks.

18 new tests (71 across the youtube suites). Full suite 12,863 pass, same 6 pre-existing failures.

## D-21 | B6 CLOSED — media spend caps, and the half nobody had noticed
B6 was scoped as "wire `cost-tracker.checkBudget()`, which has zero callers." On opening it, a
second and worse defect: **the paid media tools recorded nothing at all.** `video-tools`,
`factory-tools`, `image-tools` and `thumbnail-tool` each returned 0 hits for any cost-tracker
reference. So a Luma/Runway/Kling retry loop could bill indefinitely while every meter in the
system read $0 — wiring the check alone would have enforced a cap against a number that was
structurally always zero.

`src/core/billing/media-spend.ts` does both: **records** paid media calls into the cost tracker and
**enforces** a per-job and per-day cap. Wired into `media.video-generate` (all three providers) and
`media.shorts-factory` (DALL·E + TTS).

**Caps default ON**, unlike `xai-billing` (D-19). The distinction is deliberate: there, being
unconfigured means we genuinely cannot *measure*; here measurement is local SQLite and always
available, so shipping disabled would be the exact failure being fixed. Defaults $10/day and
$2/video — generous against the audit's ~$4.24/video estimate — with `SUDO_MEDIA_CAP_DISABLE=1` as
a deliberately ugly escape hatch.

**Gate 8 satisfied by execution, not by reading.** The roadmap demands "a test that drives it to the
cap and asserts refusal". `media-spend.test.ts` runs a 100-iteration retry storm and asserts it is
halted after **5** calls on the per-job cap and **2** on the daily cap, with recorded spend never
exceeding either.

Two design points worth recording:
- Failures are recorded too. A generation that errored after the provider accepted it was still
  billed, and an unrecorded spend is an unenforced cap on the retry that follows.
- `shorts-factory` checks the whole projected cost (image + TTS) up front, so a run is refused
  before the first paid call rather than halfway through with an orphaned billed image.
- Unreadable spend ⇒ refuse, never "$0 spent" — same rule as D-19.

The unit costs are **estimates from published pricing, not billed amounts**, and are documented as
such: they exist to bound a runaway loop, where being 30% wrong still stops the storm. Callers that
know the real figure pass `costUsd`.

12 tests. Full suite 12,875 pass, same 6 pre-existing failures. **Phase A is now complete.**

## D-22 | GAP-08 CLOSED — the search.list quota bomb, and a second call site the guard found
`feedback/youtube-api.ts:75` paginated `search.list` at **100 quota units a page**, up to 200 ids —
**400 units per invocation, 4% of the entire daily allowance**, on the default path of
`youtube-analytics.ts:129`. It could starve the upload lane and surface only as a 403 hours later.

Replaced with a two-tier ladder:
1. **Channel RSS** (`youtube.com/feeds/videos.xml?channel_id=…`) — **0 units**, no API key,
   ~15 most-recent videos, which satisfies most callers outright.
2. **`playlistItems.list`** on the uploads playlist (channel id `UC…` → `UU…`) — **1 unit per 50**,
   only when more depth is genuinely needed.

Worst case **4 units where it was 400 — a 100× reduction**; typical case 0.

**The grep guard paid for itself immediately.** Roadmap gate 9 requires "`search.list` is not
called, verified by grep in CI", so I wrote `tests/youtube/no-search-list.test.ts` to scan all of
`src/`. It failed on first run against a **second call site I had not found by reading**:
`comment-api.ts:144 fetchRecentVideoIds`. Since `CommentEngine.fetchAllRecent()` calls it and then
fetches comments per video, every comment sweep opened with 100 units before doing any useful work.
Fixed the same way. The dead `YTSearchResponse`/`YTSearchItem` types were deleted with it so nothing
can quietly reintroduce the call.

`quota-ledger.ts` is the one allowlisted mention — it defines the cost and denies the method by
default, so it must name it.

Also fixed a bug I introduced while writing this: the log line compared `ids === rss.slice(...)`,
an array identity check that is always false, so the `source` field would have always read
`playlistItems`. Replaced with a tracked flag.

3 guard tests. Full suite 12,878 pass, same 6 pre-existing failures.

## D-23 | GAP-05 CLOSED — videos.update, built around the footgun rather than exposing it
Metadata was **write-once**: set at upload, never changeable, because no `videos.update` existed
anywhere in the repo. Title iteration is among the highest-leverage YouTube optimisations and it was
structurally unavailable. At 50 units it is also the cheapest experimentation actuator we have —
title A/B needs no Studio automation and no thumbnail deploy.

**The whole module is shaped by one hazard.** `videos.update` is a **full replace, not a patch**:
sending `{snippet:{title}}` does not update the title, it replaces the snippet and **blanks the
description, tags and categoryId**. Run over a channel, that destroys every description you have.
`categoryId` compounds it — the API *requires* it on update, so omitting it fails outright.

So `src/core/youtube/metadata.ts` never lets a caller build the request. It always
read-modify-writes: `videos.list` (1 unit) → `mergeSnippet()` → `videos.update` (50 units) = 51
total. **There is no exported path that skips the read**, and the test asserts the PUT body carries
the full merged snippet including fields the caller never mentioned.

Design decisions worth recording:
- **Reject, never truncate.** A >100-char title errors with "this is not truncated for you". The
  existing upload tool still does `title.slice(0,100)` — silent mangling — which is now the
  inconsistent one; noted for a follow-up rather than changed under this commit.
- **No-op detection**: a patch matching current metadata skips the 50-unit write and returns
  `unchanged` after spending only the 1-unit read.
- **Read failure ⇒ no write.** Never guess the current snippet.
- **Validation before network** — an invalid patch costs zero quota and zero requests.
- Clearing a description is still possible, but only by passing `description: ''` explicitly.
  Deliberate, not accidental.
- Gated by `SUDO_YT_PUBLISH_ENABLED` (default OFF) — one flag for "may touch the real channel",
  rather than a second switch to forget.

**Registered as a tool**, `social.youtube-update-metadata`, not left as a library. Three times today
the defect has been "built but nothing calls it" (policy gate, checkBudget, and the media recorder);
shipping a fourth would have been indefensible. Registration verified programmatically, not assumed.

19 tests. Full suite 12,897 pass, same 6 pre-existing failures.

## D-24 | GAP-06 CLOSED — YPP readiness, designed around what the API cannot see
Nothing tracked progress toward monetisation. Every input already existed in the working
`social.youtube-analytics` tool; the missing piece was the model turning numbers into
"how far, and when".

**The design decision that makes this honest.** Three YPP requirements have **no API whatsoever**
(audit Gate 2): two-step verification, a linked AdSense account, and no active Community Guidelines
strikes. A readiness model that quietly assumed them satisfied would report ELIGIBLE for a channel
YouTube will refuse — the worst possible outcome, because it sends a human to click Apply and be
rejected. So they are first-class criteria with status `human-verify`, and **overall readiness can
never reach `eligible` while any is unconfirmed**; the best it reports is `thresholds-met`, with the
action naming exactly which ones to go check. Asserted by test for each of the three individually.

Other deliberate choices:
- **`null` ≠ `0`.** An unmeasured metric reports "not measured", never "no progress". Nothing
  measured at all ⇒ verdict `unknown`, pointing at the credential rather than implying a dead channel.
- **No fabricated projections.** Flat or unknown growth returns `null` for the eligibility date and
  says "no projection", rather than inventing one. When both rates are known the projection uses the
  **slower** constraint, since that is what actually binds.
- Early access is reported separately and states plainly that it is **NOT ad revenue** — it unlocks
  fan funding only, which is easy to misread as monetisation.
- Thresholds carry the 2026-08-01 verified numbers: 1,000 subs + (4,000 watch hours/12mo OR 10M
  Shorts views/90d); early access 500 subs + 3 uploads/90d + (3,000 hours OR 3M Shorts views).

Cost: **1 quota unit** (`channels.list`). The Analytics API is not charged against the Data API quota.

**UNVERIFIED:** the Shorts view count uses the documented `creatorContentType==shorts` Analytics
filter, unexercised without a live token. It nulls out cleanly if unsupported — which is the correct
failure, since an unmeasured metric must not read as zero.

Registered as `social.youtube-ypp-readiness` and verified programmatically, not assumed — the
fifth time this session that "built but nothing calls it" was the thing to avoid.

19 tests. Full suite 12,916 pass, same 6 pre-existing failures.
