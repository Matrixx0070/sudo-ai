# 02 — INVENTORY + CAPABILITY MATRIX

Method: files opened and read, not inferred. Every EXISTS/PARTIAL claim carries `path:line`.
Coverage caveat: subagent fan-out was unavailable (see D-04), so this is a single-threaded read
targeting the files that decide each verdict. Rows I could not confirm by reading are marked
**UNVERIFIED** rather than guessed.

---

## Autonomy level definitions

| Level | Meaning |
|---|---|
| **L0** | Manual. A human does it; the system has no code for it. |
| **L1** | Assisted. The system generates a draft/suggestion; a human executes every step. |
| **L2** | Human-executed with machine loop. System can perform the action but every invocation is human-triggered and human-approved. |
| **L3** | Supervised autonomy. System runs on a schedule and acts, but a human approves before anything becomes externally visible or irreversible. |
| **L4** | **Bounded autonomy.** System runs unattended within a declared envelope (budget, rate, policy). Human handles exceptions and identity/legal events only. |
| **L5** | Unbounded autonomy. No human, ever, including provisioning, payments, and appeals. |

Per Gate 3 in `01-VIABILITY.md`, **L5 is unreachable for YouTube** — identity, AdSense tax forms, and
appeals are legally human-bound. **L4 is the real ceiling.** Every "achievable" column below is
capped accordingly.

---

## THE HEADLINE FINDING

> The repo has **one** working end-to-end video pipeline: `media.shorts-factory`
> (`src/core/tools/builtin/media/factory-tools.ts:34`). Read the body: it generates **one static
> DALL-E image** (`:73`), lays **one OpenAI TTS track** over it (`:87`), and uses ffmpeg
> `-loop 1 -tune stillimage` (`:105-117`) to hold that single frame for the duration of the audio.
>
> That output — a still image with synthetic narration, produced from a fixed template with no
> structural variation between runs — is a **precise description of the artifact YouTube's
> inauthentic-content policy demonetises** (Gate 4: "made with a template with little to no
> variation", "slideshows", "easily replicable at scale").
>
> The single most production-ready piece of the content pipeline is aimed directly at the one
> policy that ends the business. This is not a bug in the code; the code does what it says. It is a
> strategy/policy mismatch, and it is the most important thing in this audit.

---

## CAPABILITY MATRIX

Legend — Maturity: `prod` (used in anger) / `works` (real, correct, untested in anger) /
`fragile` / `stub` / `none`.

### 1. Channel setup & branding
- **Status: ABSENT.** No code creates a channel, sets a banner, handle, or watermark.
- Grep for `youtube/v3/channelBanners`, `channels?part=brandingSettings` update: **no hits.**
- Missing: everything. Per Gate 3 this is correctly a human touchpoint; only the branding *assets*
  (banner/avatar image generation) are automatable, and `media.thumbnail-generate`
  (`src/core/tools/builtin/media/thumbnail-tool.ts:16`, real `sharp` compositing at `:63`) could be
  repurposed for that.
- **Current L0 → Achievable L1** (generate assets, human uploads). Correctly out of scope.

### 2. Niche & competitor intel
- **Status: PARTIAL, and quota-hazardous.**
- `src/core/competitive/competitor-monitor.ts` exists — **UNVERIFIED**, not opened in this pass.
- `src/core/feedback/youtube-api.ts:70 listChannelVideoIds()` is real and calls the live Data API —
  **but it calls `/search` (`:75`) inside a `pageToken` pagination loop.** `search.list` costs
  **100 units**. This function can consume the entire 10,000-unit daily quota in 100 iterations and
  will silently starve the upload lane. This is a **live defect against Gate 1**, cited: `src/core/feedback/youtube-api.ts:75`.
  The correct implementation is the zero-quota RSS feed or `playlistItems.list` on the uploads
  playlist (1 unit).
- `src/core/feedback/youtube-api.ts:93` uses `videos.list` correctly (1 unit, batched IDs). Good.
- **Current L2 → Achievable L4**, after the `search.list` removal.

### 3. Content strategy
- **Status: ABSENT as a system.** No module owns "what should this channel publish and why".
  `src/core/skills/content/viral-hook/` exists — **UNVERIFIED**. There is no channel-level content
  plan, no format portfolio, no calendar tied to a strategy.
- This is the gap that Gate 4 makes existential: without a strategy object enforcing *structural
  variation across videos*, the system defaults to templated output.
- **Current L0/L1 → Achievable L3.**

### 4. Trend detection
- **Status: PARTIAL — UNVERIFIED whether measured or invented.**
- `src/core/awareness/trend-radar.ts` + `trend-radar-scanners.ts` exist. I did not open them in this
  pass. **The decisive question — does it make real HTTP calls to real trend sources, or does it
  prompt a model to imagine trends and return the text as data — is UNVERIFIED.** Given the pattern
  seen elsewhere in this repo (see the CTR stub below), I would not assume the former without
  reading it. Flagging for the next pass.
- `social.trend-scanner` is registered (`src/core/tools/builtin/social/index.ts:38`).
- **Current UNVERIFIED → Achievable L4.**

### 5. Scripting
- **Status: EXISTS via the general agent, ABSENT as a controlled component.**
- The repo's LLM substrate is mature (`src/llm/`, multi-provider IR + adapters + policy). Producing
  a script is trivially within reach.
- What's missing is everything that makes scripting *safe at volume*: no per-video originality
  check, no cross-video similarity check, no structural-variation enforcement. Nothing stops the
  system emitting 200 scripts off one skeleton.
- **Current L2 → Achievable L4** (with GAP-03 in place).

### 6. Asset generation
- **Status: EXISTS, real.** `media.thumbnail-generate` composites real images with `sharp`
  (`thumbnail-tool.ts:48-63`). `media.video-generate` (`video-tools.ts:115`) makes real, correct
  API calls to Luma (`:145`), Runway (`:164`), and Kling (`:181`) with real polling loops. This is
  competent, well-written code.
- Limits: video-generate produces **5-second 9:16 clips** from paid APIs. It is a b-roll generator,
  not a long-form producer.
- **Current L2 → Achievable L4.**

### 7. Video production
- **Status: PARTIAL, and pointed the wrong way.** See THE HEADLINE FINDING.
- `media.shorts-factory` (`factory-tools.ts:34`): real and complete, produces static-image-plus-VO.
- `media.video-edit` (`video-tools.ts:50`) delegates to a real ffmpeg engine
  (`src/core/superpowers/ffmpeg-tools.ts`, invoked at `video-tools.ts:42-52`). Real primitives:
  convert, trim, merge, extract-audio, add-subtitles, compress, gif, text-overlay.
- **`src/remotion/` exists with real compositions** (`Root.tsx`, `shorts/AITutorialShort.tsx`,
  `characters/*.tsx`) and `@remotion/renderer` is a real dependency — **but no TypeScript in `src/`
  imports Remotion to render anything.** The only `src/**` hits for "remotion" are a system-prompt
  section (`src/core/brain/system-prompt.ts:585`) and a string in a regex
  (`src/core/feedback/store.ts:63`). **The Remotion render path is unwired.** A capable renderer
  is sitting in the repo with no code calling it.
- Missing for real long-form: multi-scene timeline assembly, per-beat visual pacing, captions burn,
  music bed, B-roll sequencing. The ffmpeg primitives exist; the **orchestrator does not**.
- **Current L2 (shorts only, wrong shape) → Achievable L4.**

### 8. Thumbnails
- **Status: generation EXISTS; A/B testing is BROKEN, not merely partial.**
- Generation is real (`thumbnail-tool.ts:63`).
- `src/core/youtube/thumbnail-ab.ts` — **three independent defects, all cited:**
  1. **It cannot deploy a thumbnail.** Grep across all of `src/` for `thumbnails.set` /
     `youtube/v3/thumbnails`: **zero hits.** There is no code anywhere in this repo that uploads a
     thumbnail to YouTube. An A/B test that cannot set the thing being tested is not a test.
  2. **It cannot measure CTR.** `_fetchAndStoreCtr` (`thumbnail-ab.ts:254`) fetches public
     `videos?part=statistics` and then, at **`thumbnail-ab.ts:296`**, writes a **hardcoded constant**:
     `stmt.run(views, 0.04, variant.id)` — every variant gets `measured_ctr = 0.04`. The comment
     above it is honest ("Stub CTR = 0.04 (industry avg) unless we have OAuth data"), but the
     consequence is that `selectWinner()` (`:171`) compares identical values across all variants.
     **CORRECTION (verified after first draft, on reading `:187-198`):** `selectWinner` *does*
     detect the tie and returns `null` rather than crowning variant A. Credit where due — my first
     draft overstated this and the code is better than I said. The real defect stands and is still
     serious: the fabricated `0.04` and `impressions = viewCount` are written into the same DB
     columns a real measurement would occupy, so any downstream reader sees invented numbers
     presented as measured data.
     `viewCount` is also not impressions — that is a second invention in the same statement.
  3. It loops over N variants (`:257`) issuing N identical requests for the same `test.videoId`
     (`:263`), wasting quota to fetch the same row repeatedly.
- Real CTR requires the **Analytics API** (`impressions`, `impressionClickThroughRate` metrics),
  which the repo already has OAuth plumbing for at `youtube-tools.ts:177` — it simply isn't used here.
- **Current L0 (worse than nothing — it fabricates) → Achievable L3** (Studio Test&Compare is
  UI-only per Gate 2; API-side thumbnail swap + Analytics CTR read is achievable at L4).

### 9. Metadata & SEO
- **Status: PARTIAL — write-once only.**
- Metadata is set at upload time (`youtube-tools.ts:58-61`: snippet title/description/tags/categoryId).
- **There is no `videos.update` call anywhere in `src/`.** Grep confirms the only PUT to a YouTube
  host is the resumable upload body itself (`youtube-tools.ts:89`). Consequence: **the system can
  never revise a title, description, or tag set after publishing.** Title iteration is one of the
  highest-leverage optimisations on YouTube, and it is structurally unavailable.
- `title.slice(0, 100)` (`:59`) silently truncates rather than validating — a title over 100 chars
  is quietly mangled.
- **Current L2 → Achievable L4.**

### 10. Scheduling & publishing
- **Status: EXISTS and is genuinely good — with one fatal auth flaw.**
- `social.youtube-upload` (`youtube-tools.ts:17`) implements the **correct two-step resumable
  upload**: init with `X-Upload-Content-Type`/`-Length` (`:63-76`), read the session URL from the
  `location` header (`:83`), PUT the body (`:88`). Errors are surfaced with response text, not
  swallowed (`:78-81`, `:95-98`). It defaults `privacyStatus` to `private` (`:39`) and sets
  `requiresConfirmation: true` (`:22`). This is careful, correct code.
- **THE FATAL FLAW — GAP-01.** Auth is `process.env['YOUTUBE_OAUTH_TOKEN']` (`:45`), read as a
  **static OAuth 2.0 access token**. Google access tokens expire in **~1 hour**. Grep for
  `refresh_token` across the YouTube surface: **zero hits.** There is no refresh, no client
  id/secret, no token store.
  **Therefore: every YouTube write capability in this repo stops working one hour after a human
  pastes a token.** Unattended operation is not degraded — it is impossible. This single line caps
  the entire system at **L2** regardless of everything else built on top.
  The fix pattern already exists in-repo: `src/core/gdrive/auth.ts:59 createOAuthClient()` does it
  correctly, including rotated-token persistence at `0600` via the `client.on('tokens', …)` handler
  (`gdrive/auth.ts:72-81`) and a loopback consent flow (`:100+`). This is a solved problem in this
  codebase, just not for YouTube.
- `readFileSync(videoPath)` (`:87`) loads the **entire video into memory** before PUT. Fine at
  100 MB, an OOM at 2 GB. Also, a resumable upload that isn't resumed on failure is just a
  two-request upload — the retry/Range machinery is not implemented.
- Real scheduler infrastructure exists (`src/core/cron/scheduler.ts`, `cron-manager.ts`,
  `src/core/scheduling/smart-scheduler.ts`) — **not wired to publishing (UNVERIFIED whether any job
  targets YouTube; no YouTube reference found in the cron directory listing).**
- **Current L2 (hard-capped by auth) → Achievable L4.**

### 11. Studio ops
- **Status: ABSENT.** No Studio automation exists. Playwright is a real dependency and
  `src/core/tools/builtin/browser/auth.ts` exists (**UNVERIFIED** — not opened), but nothing drives
  studio.youtube.com.
- Per Gate 2, this is correctly assist-only and must never sit on the publish path.
- **Current L0 → Achievable L2/L3** (best-effort, human-fallback).

### 12. Analytics interpretation
- **Status: EXISTS, real, and the strongest YouTube surface in the repo.**
- `social.youtube-analytics` (`youtube-tools.ts:127`) hits the real Analytics API v2
  (`:177`) with a correct report map (`:156-162`) covering overview, top-videos, traffic-sources,
  demographics, **and revenue** (`estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm`, `:161`).
  It reshapes `columnHeaders`+`rows` into structured objects (`:195-197`) and returns them in
  `data` — genuinely usable by an agent.
- It even distinguishes "API not enabled" from a generic 403 (`:184-186`). Thoughtful.
- `src/core/earning/tracker.ts:33` independently hits the same Analytics base with its own
  `getAccessToken()`. **Two parallel implementations of the same client** — duplication that will
  drift.
- Same GAP-01 auth flaw applies (`:144`).
- **Current L2 → Achievable L4.**

### 13. Experimentation & A/B
- **Status: BROKEN.** See #8. The only A/B system in the repo fabricates its measurements
  (`thumbnail-ab.ts:296`). There is no title A/B, no thumbnail deploy, no experiment registry, no
  statistical significance test anywhere.
- **Current L0 → Achievable L3.**

### 14. Community management
- **Status: PARTIAL — read is real, write is an explicit stub.**
- `src/core/youtube/comment-engine.ts`: real SQLite schema (`:60-71`), real fetch via
  `fetchCommentThreads` (`:92`), sentiment tagging, `responded` tracking (`markResponded`, `:214`).
  Solid read side.
- **Write side is a self-declared stub**: `postReply` (`:194`) returns
  `[STUB] Would reply to comment …` (`:203`) when `YOUTUBE_OAUTH_TOKEN` is absent — and per GAP-01
  that token is always absent within an hour. `postCommentReply` (`comment-api.ts`) is real code,
  but it is unreachable in practice.
  Credit where due: **this stub is honest** — it returns `success: false` and says so. Contrast
  with `thumbnail-ab.ts:296`, which returns fabricated data as success. That contrast is the
  quality gradient of this codebase.
- `generateReplySuggestions` (`:222`) delegates to `comment-helpers.ts` — **UNVERIFIED** whether
  LLM-backed or canned strings.
- Community *posts* have no API at all (Gate 2). **Current L1 → Achievable L4 for comments.**

### 15. Monetization readiness
- **Status: ABSENT.** Nothing tracks subscribers vs 1,000, watch-hours vs 4,000, Shorts views vs
  10M, strike status, or 2SV state. No YPP readiness model exists.
- All the input data is already reachable via the working Analytics tool (#12) — this is a small,
  high-value gap.
- **Current L0 → Achievable L4** (monitoring/alerting; the *application click* stays human per Gate 3).

### 16. Revenue optimization
- **Status: PARTIAL.** `src/core/earning/tracker.ts` pulls real revenue metrics (`:104 pullMetrics`,
  `:193 pullAllMetrics`) into SQLite (`:290`). `src/core/finance/revenue-tracker.ts` and
  `src/core/business/analytics.ts` exist — **UNVERIFIED**.
- There is data collection but **no optimisation loop**: nothing reads revenue-per-video and changes
  what gets made next. And with no `videos.update` (#9) and no working A/B (#13), there is no
  actuator to optimise *with*.
- **Current L1 → Achievable L3.**

### 17. Copyright & policy compliance
- **Status: ABSENT. This is the most dangerous absence in the repo.**
- No pre-publish policy check. No inauthentic-content self-assessment. No music/footage licence
  tracking. No AI-disclosure flag (`selfDeclaredMadeForKids` is set at `youtube-tools.ts:60`, but
  that is the COPPA flag, **not** the synthetic-media disclosure).
- Gate 4 established that **enforcement is channel-level**: one bad batch retroactively endangers
  every video on the channel. A system that can publish 6×/day with no policy gate is a system that
  can destroy the asset faster than it can build it.
- **Current L0 → Achievable L4. This is P0.**

### 18. Risk detection
- **Status: substrate EXISTS, YouTube application ABSENT.**
- Generic machinery is real and non-trivial: `src/core/agent/veto-gate.ts`,
  `alignment-aggregator.ts`, `src/core/security/discordance-detector.ts`,
  `src/core/cognition/trust-tier-tracker.ts` — all in `PROTECTED_PATHS`
  (`src/core/self-build/protected-paths.ts:20-25`), i.e. treated as safety-critical.
- None of it knows anything about YouTube. **Current L0 for this domain.**

### 19. Account health
- **Status: ABSENT.** No strike monitoring, no channel-standing check, no quota-consumption ledger,
  no upload-limit awareness. Per Gate 1 a quota ledger is mandatory and there is none.
- A generic health/watchdog subsystem exists (`src/core/health/`, and memory records a live
  watchdog shipped in #1063) — **not extended to YouTube (UNVERIFIED, no YouTube reference found).**
- **Current L0 → Achievable L4.**

### 20. Learning from performance history
- **Status: PARTIAL — collection real, loop absent.**
- `src/core/feedback/store.ts` classifies content into a `'youtube'` bucket (`:63`), so a
  YouTube-aware feedback path was intended. `src/core/outcomes/`, `src/core/learning/`,
  `src/core/self-improvement/` exist — **UNVERIFIED whether advisory-only or actually closed-loop.**
  Repo memory (`project-outcome-gated-learning`) records `WORLD_STATE_GOALS` and `SELF_EVAL_ADOPT`
  set to `0` in production specifically to prevent autonomous spend — i.e. **the learning loop is
  deliberately disabled in prod.**
- **Current L1 → Achievable L3.**

### 21. Adaptation to algorithm change
- **Status: ABSENT, and largely unbuildable.** No system detects a YouTube ranking or policy shift.
- Honest assessment: this is not really an engineering capability. The achievable version is
  *anomaly detection on your own metrics* (CTR/retention step-changes) plus *policy-page change
  monitoring* — both are real and small. "Adapting to the algorithm" beyond that is marketing copy.
- **Current L0 → Achievable L2** (detect + alert; adaptation stays human).

---

## SCORECARD

| # | Capability | Status | Now | Achievable |
|---|---|---|---|---|
| 1 | Channel setup & branding | ABSENT | L0 | L1 |
| 2 | Niche & competitor intel | PARTIAL (quota defect) | L2 | L4 |
| 3 | Content strategy | ABSENT | L1 | L3 |
| 4 | Trend detection | PARTIAL (UNVERIFIED) | ? | L4 |
| 5 | Scripting | PARTIAL | L2 | L4 |
| 6 | Asset generation | EXISTS | L2 | L4 |
| 7 | Video production | PARTIAL (wrong shape) | L2 | L4 |
| 8 | Thumbnails | gen EXISTS / A/B **BROKEN** | L0 | L3 |
| 9 | Metadata & SEO | PARTIAL (write-once) | L2 | L4 |
| 10 | Scheduling & publishing | EXISTS (**auth-capped**) | L2 | L4 |
| 11 | Studio ops | ABSENT | L0 | L2 |
| 12 | Analytics interpretation | EXISTS | L2 | L4 |
| 13 | Experimentation & A/B | **BROKEN** | L0 | L3 |
| 14 | Community management | read real / write stubbed | L1 | L4 |
| 15 | Monetization readiness | ABSENT | L0 | L4 |
| 16 | Revenue optimization | PARTIAL | L1 | L3 |
| 17 | Copyright & policy compliance | **ABSENT** | L0 | L4 |
| 18 | Risk detection | substrate only | L0 | L3 |
| 19 | Account health | ABSENT | L0 | L4 |
| 20 | Learning from history | PARTIAL (off in prod) | L1 | L3 |
| 21 | Adaptation to algo change | ABSENT | L0 | L2 |

**Aggregate today: L1.** Not L2 — because #10's one-hour token expiry means the system cannot
complete a second unattended cycle. **Aggregate achievable: L4**, gated on the P0 set in `03-GAPS.md`.

---

## HONEST ASSESSMENT OF THE CODEBASE

What is genuinely good: the upload implementation, the analytics client, the video-generate
provider adapters, the ffmpeg wrapper, and the gdrive OAuth module are all careful, correct,
well-factored code with real error surfacing. This is not a repo of stubs.

What is weak, named plainly:
1. **`thumbnail-ab.ts:296` fabricates measurements and stores them as real.** Every other stub in
   this repo announces itself; this one lies. It should be disabled until it can measure.
2. **`feedback/youtube-api.ts:75` will eat the entire API quota** via `search.list` pagination.
3. **The Remotion renderer is dead weight** — a heavyweight dependency and a `src/remotion/`
   composition tree that nothing in `src/**` imports.
4. **Two Analytics clients** (`youtube-tools.ts:177`, `earning/tracker.ts:33`) will drift apart.
5. **The one working video pipeline builds the one artifact the policy demonetises.**
6. **`YOUTUBE_OAUTH_TOKEN` as a static env string** is the kind of shortcut that reads fine in a
   demo and makes unattended operation categorically impossible. It is one small module away from
   being fixed, and until it is, nothing else in this domain matters.
