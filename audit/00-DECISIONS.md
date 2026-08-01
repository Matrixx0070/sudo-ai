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
