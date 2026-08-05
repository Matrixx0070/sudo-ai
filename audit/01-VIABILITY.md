# 01 — VIABILITY GATE

Date of research: 2026-08-01. All external facts web-verified today; sources listed per gate.
Subject: can SUDO-AI (`/root/sudo-ai-v4`) run an autonomous YouTube channel business?

**VERDICT: PASS — with two gates that reshape the product, and one that caps autonomy below L5.**

No gate is fatal. But three of the five come back materially different from the naive assumption,
and the differences are the whole design. Read the per-gate verdicts, not just the header.

---

## GATE 1 — YouTube Data API quota. **PASS, comfortably.**

Facts:
- Default allocation per Google Cloud project: **10,000 quota units/day**, resetting midnight Pacific.
- `videos.insert` costs **1,600 units**. → **6 uploads/day** is the hard ceiling on default quota
  (10,000 ÷ 1,600 = 6.25).
- `search.list` costs **100 units** — this is the quota killer, not uploads. 100 searches = the entire
  daily budget. Any "competitor scanning" or "trend discovery" built on `search.list` will starve
  the upload lane.
- Cheap reads (`videos.list`, `channels.list`, `commentThreads.list`) are **1 unit** each.
- Quota increases are requested via Google Cloud Console and require an **audit** (Google's
  "Quota and Compliance Audits" process).

Verdict for this use case: **6 uploads/day is not the constraint.** A single channel publishing
1–2×/day uses 1,600–3,200 units, leaving 6,800+ units for metadata reads. The default allowance is
*sufficient for 1–3 channels* without ever filing for an increase.

Would a quota increase be granted? **Assume no, and design not to need one.** The compliance audit
asks what the app does and who the users are; "one operator mass-publishing AI-generated video to
their own channels" is precisely the profile that gets declined or deprioritised. Filing an audit
also volunteers the operation for human review. **Recommendation: never file. Stay under default.**

Design consequences (these are real constraints, not notes):
- **Never call `search.list`.** Use RSS (`youtube.com/feeds/videos.xml?channel_id=…`, zero quota) and
  `videos.list`/`channels.list` by ID (1 unit) for competitor intel.
- Budget quota as a first-class resource with a hard daily accounting ledger. There is currently no
  such ledger in the repo (see GAP-04).

Sources: [Google — YouTube Data API getting started](https://developers.google.com/youtube/v3/getting-started),
[Google — Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits),
[Phyllo — YouTube API limits 2026](https://www.getphyllo.com/post/youtube-api-limits-how-to-calculate-api-usage-cost-and-fix-exceeded-api-quota),
[SocialCrawl — 100 searches burn 10,000 units](https://www.socialcrawl.dev/blog/youtube-data-api-2026)

---

## GATE 2 — Surfaces with no API. **PASS, but this is where autonomy actually dies.**

The Data API covers upload, metadata, playlists, captions, and comments. The Analytics API covers
most reporting including `estimatedRevenue`. Everything below has **no public API** and is
Studio-UI-only:

| Surface | API? | Only route | Fragility |
|---|---|---|---|
| Thumbnail Test & Compare (A/B) | **No** | Studio UI | High |
| Community posts | **No** | Studio UI | High |
| YPP application / enrollment | **No** | Studio UI | High — one-time |
| Strike appeals, monetization appeals | **No** | Studio UI | High — rare, high-stakes |
| AdSense linking + tax/payment forms | **No** | AdSense UI | One-time, identity-bound |
| Some Studio-only analytics cards | **No** | Studio UI | Medium |
| Channel branding (banner, watermark, handle) | Partial | Mostly Studio UI | Low — one-time |

Honest pricing of browser automation for these:
- The repo already has Playwright as a real dependency and a durable-browser-profile subsystem
  (memory + `src/core/tools/builtin/browser/auth.ts` — see 02-CAPABILITIES for citations).
  So the *capability* exists.
- But Google actively fights automation on its own properties. The repo's own history is the
  evidence: the Grok seat required defeating Cloudflare Turnstile, and a **statsig algorithm drift
  on 2026-08-01 (today) broke a working pure-Node minter in production**, forcing a fallback to a
  persistent warm *browser* oracle (`project-statsig-algorithm-drift-2026-08-01`). That is exactly
  the failure mode Studio automation will have, on Google's home turf, where detection is better.
- Realistic expectation: **a Studio automation lane will break every few weeks and will require a
  human to re-authenticate after a challenge.** Anything scheduled through it must degrade to
  "queue the request and alert a human", never to "silently skip".

**This gate does not kill the project. It kills L5.** The Studio-only surfaces are exactly the
surfaces that matter at the two moments that decide whether the business exists (YPP enrolment, and
appealing an enforcement action) — and both are identity-bound moments where a human *should* be in
the loop anyway.

**Design consequence:** treat Studio automation as a *best-effort assist lane*, never as a
dependency of the publishing path. The publishing path uses the API only. This is a hard
architectural line and it is the single most important structural decision in this audit.

---

## GATE 3 — Account provisioning. **The honest answer is: zero human touchpoints is wrong.**

The brief asked me to say so if zero is wrong. It is wrong.

Automated Google account creation violates the Google Terms of Service, and is independently gated
by phone verification and CAPTCHA regardless of intent. Building it would be both a ToS breach and
a fragile arms race. **I am not building it and I am not recommending it.**

### MINIMUM VIABLE HUMAN TOUCHPOINT SET

These are the touchpoints that cannot be removed. Everything not on this list should be automated.

**One-time, per channel (≈60–90 minutes of human time, total):**
1. **Create the Google account** — manually, with a real phone number tied to a real identity.
2. **Create the YouTube channel + handle.**
3. **Enable 2-step verification** (a hard YPP requirement).
4. **Create the Google Cloud project, enable Data API v3 + Analytics API, create the OAuth client.**
5. **Complete the OAuth consent flow once** in a browser and hand the resulting *refresh token* to
   the system. This is the single most important handoff — see GAP-01, because the repo cannot
   currently accept one.
6. **Link AdSense + submit tax/identity forms** at YPP time. Legally identity-bound. Never automatable.
7. **Click "Apply" for YPP** in Studio when thresholds are met.

**Recurring, unavoidable (≈15–30 min/month at steady state):**
8. **Re-auth after a security challenge** on any browser-driven lane. Unpredictable, event-driven.
9. **Appeals and policy correspondence** — rare, but must be human.
10. **Publish approval**, for as long as the operator wants it. This is a *choice*, not a
    requirement — and my recommendation is to keep it for the first ~30 videos, then drop it.

**Assessment:** ~90 minutes of setup and ~20 min/month of supervision. That is a genuinely small
number and it does not threaten viability. What it does mean is that **the honest ceiling is L4
(autonomous within a bounded operating envelope, human on exceptions), not L5.** Anyone claiming L5
for a YouTube operation is either ignoring identity/payment law or hasn't hit an appeal yet.

---

## GATE 4 — Inauthentic content policy vs YPP eligibility. **PASS — and this gate is widely misreported.**

Facts, verified today:
- On **2025-07-15** YouTube renamed "repetitious content" to **"inauthentic content"**. TeamYouTube
  stated this was a **clarification of a longstanding rule, not a new policy**. The widely-shared
  "YouTube banned AI content in July 2025" claim is false.
- What is actually demonetised: **mass-produced or repetitive** content — "made with a template with
  little to no variation across videos", "easily replicable at scale", slideshows without meaningful
  narration, commentary, or educational substance.
- What is explicitly **fine**: **"an AI or cloned voice narrating an original script is not a policy
  violation"**, and a synthetic voice over stock footage does not even require the AI disclosure label.
- **Enforcement is at the CHANNEL level**, reviewing main theme, most-viewed videos, newest uploads,
  and metadata as a whole — not video-by-video.

YPP thresholds (verified today): **1,000 subscribers** + (**4,000 public watch hours/12mo** OR
**10M Shorts views/90d**), plus **2-step verification**, **no active strikes**, and a **linked
AdSense account**. There is an early-access tier at 500 subs / 3,000 hours that unlocks fan funding
but **no ad revenue**.

**Verdict: an AI-produced channel CAN monetize. The shape it must take is dictated by this gate:**
1. **Original script per video is mandatory** — not a template with slots filled. The
   "one template, 200 videos" architecture is the *specific thing* that gets demonetised.
2. **Synthetic narration is fine.** TTS is not the risk. Templating is.
3. **Variation must be structural, not cosmetic** — different formats, lengths, framings, not just
   different nouns in the same skeleton.
4. Because enforcement is channel-level, **one bad batch poisons the whole channel**, including
   already-published good videos. This makes a pre-publish policy gate a P0 safety requirement, not
   a nice-to-have (GAP-03).
5. Volume is a liability, not an asset. **1–2 genuinely differentiated videos/day beats 6 templated
   ones**, and it also happens to fit inside the API quota from Gate 1. The two constraints agree.

Sources: [SubSub — inauthentic content policy](https://www.subsub.io/blog/youtube-inauthentic-content-policy-2025),
[Knolli — AI monetization policy](https://www.knolli.ai/post/youtube-ai-monetization-policy-2025),
[YTGrowth — real rules vs made-up ones](https://ytgrowth.io/blog/youtube-ai-policy),
[Google Support — YPP overview & eligibility](https://support.google.com/youtube/answer/72851),
[vidIQ — YPP requirements 2026](https://vidiq.com/blog/post/youtube-partner-program-guide/)

---

## GATE 5 — Unit economics. **PASS on per-video margin. The real number is the pre-revenue sunk cost.**

Reference unit: one **8-minute faceless explainer** in a high-RPM niche (finance / tech-AI),
~1,200 words of narration, ~20 visual beats, 3 thumbnail variants.

### Cost per video — metered lane (all paid APIs), showing the arithmetic

| Line | Basis | Cost |
|---|---|---|
| Research + script (multi-pass) | ~150k input + ~25k output tok @ $3/$15 per Mtok | $0.45 + $0.38 = **$0.83** |
| TTS narration | ~7,000 chars @ ~$0.20/1k chars (ElevenLabs low tier) | **$1.40** |
| Visuals | 20 images @ ~$0.04 | **$0.80** |
| Thumbnails | 3 variants @ ~$0.04 | **$0.12** |
| Render (Remotion, CPU) | ~30 min VPS CPU, amortised | **$0.10** |
| Storage + egress | ~500 MB, VPS-amortised | **$0.01** |
| Subtotal | | **$3.26** |
| Retry/failure overhead | +30% (renders fail, scripts get rejected by the policy gate) | **+$0.98** |
| **Fully loaded** | | **≈ $4.24 / video** |

### Cost per video — lean lane (the one this repo can actually run)

The repo has `src/core/voice/kokoro.ts` (local TTS, $0 marginal) and flat-rate model seats
(Claude OAuth seat, Grok seat) rather than metered API billing. Substituting:

| Line | Cost |
|---|---|
| Script (flat-rate seat, marginal ≈ 0) | **$0.00–0.20** |
| TTS (Kokoro, local) | **$0.00** |
| Visuals (generated or stock) | **$0.00–0.80** |
| Render + storage | **$0.11** |
| Retry overhead +30% | **+$0.10–0.33** |
| **Fully loaded** | **≈ $0.20 – $1.45 / video** |

### Against revenue

Realistic **RPM for faceless finance/tech explainers: $6–13**; blended finance content runs
$10–25 but that skews to face-led, US-heavy channels. **Use $8 RPM as the planning number.**

- Break-even, metered lane: $4.24 / $8 × 1,000 = **530 views per video.**
- Break-even, lean lane: **~25–180 views per video.**

Per-video margin is not the problem. **The problem is the pre-revenue period**, and this is the
number that actually matters:

> To reach 4,000 public watch hours = 240,000 watch-minutes. At a realistic ~3-minute average view
> duration for a faceless channel, that is **~80,000 views**, plus 1,000 subscribers, before the
> channel earns its first cent.

At 1.5 videos/day that is a ~90–150 video runway. Sunk production cost before first revenue:

- Metered lane: **~$400–650.**
- Lean lane: **~$30–200.**

**Verdict: PASS.** The capital at risk to find out whether this works is *hundreds of dollars, not
thousands*. That is a cheap experiment. The binding risk is not cost — it is **distribution**:
whether ~100 AI-produced videos attract 80,000 views at all. Nothing in the economics protects
against "nobody watches", and no amount of engineering in this repo changes that. The correct
framing is that this is a **cheap lottery ticket with a competent execution engine**, and it should
be capitalised and reasoned about as such.

Sources: [OutlierKit — profitable niches, real RPM data](https://outlierkit.com/blog/most-profitable-youtube-niches),
[FluxNote — RPM by niche USA 2026](https://fluxnote.io/guides/youtube-rpm-by-niche-usa-2026),
[OutlierKit — YouTube niches guide](https://outlierkit.com/resources/youtube-niches-guide/)

---

## GATE SUMMARY

| # | Gate | Verdict | Reshapes the design? |
|---|---|---|---|
| 1 | API quota | PASS | Yes — **`search.list` is banned**; 6 uploads/day ceiling; never file for an increase |
| 2 | No-API surfaces | PASS | Yes — **Studio automation is assist-only, never on the publish path**; caps at L4 |
| 3 | Account provisioning | PASS | Yes — **zero human touchpoints is wrong**; ~90 min setup + ~20 min/month |
| 4 | Inauthentic content | PASS | Yes — **per-video original scripts mandatory**; channel-level enforcement makes a pre-publish gate P0 |
| 5 | Unit economics | PASS | No — margin is fine; **~$400 at risk pre-revenue**; real risk is distribution, not cost |

**PROCEED TO PHASE 1.**

The three reshapes worth carrying forward: *quota discipline forbids search*, *the publish path must
be API-only*, and *the policy gate is a safety-critical component because enforcement is channel-wide*.
