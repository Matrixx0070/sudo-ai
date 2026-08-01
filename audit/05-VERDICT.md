# 05 — VERDICT

**Build it. Cap it at L4. Budget $500 and 3 weeks to find out if anyone watches.**

---

## Achievable autonomy level: **L4**

Not L5, and anyone who tells you L5 is available for YouTube hasn't read the AdSense tax forms or
been through an appeal. Identity, payment, and enforcement correspondence are legally human-bound.
The honest number for the recurring human cost is **~90 minutes of one-time setup and ~20 minutes a
month** thereafter. That is a good deal. It is not zero, and the brief was right to suspect that
zero was wrong.

Today the system is at **L1**. Not L2 — because `YOUTUBE_OAUTH_TOKEN` is a static access token
(`src/core/tools/builtin/social/youtube-tools.ts:45`) that expires in an hour, so the system cannot
complete two unattended operations in a row. The gap between L1 and L4 is roughly **three weeks of
focused work**, and the first day of it is worth more than the other twenty combined.

## The three things that decide whether this works

**1. Distribution, not engineering.** Nothing in this repo, and nothing in this roadmap, makes
people watch. The economics in Gate 5 are comfortable — break-even is ~530 views per video at the
metered rate and ~$400 of production stands between you and the first revenue dollar. But you need
**~80,000 views and 1,000 subscribers before YouTube pays anything at all**, and no amount of
pipeline quality guarantees that. This is a cheap lottery ticket attached to a competent execution
engine. Treat it as such: the engineering risk is small and the market risk is total.

**2. The policy gate.** YouTube's inauthentic-content enforcement is **channel-level** — one bad
batch retroactively endangers everything already published. The system as it stands can publish six
times a day with zero policy checks, which means it can destroy the asset faster than it builds it.
And the single most production-ready piece of the content pipeline, `media.shorts-factory`
(`src/core/tools/builtin/media/factory-tools.ts:34`, a static DALL-E image held under an OpenAI TTS
track via `ffmpeg -loop 1 -tune stillimage` at `:105`), produces **precisely the artifact the policy
demonetises**. That is the most important sentence in this audit. The most finished thing in the
repo is aimed at the wrong target.

**3. Whether it can hold a credential for more than an hour.** GAP-01. It is a day of work, the
correct pattern already exists in this codebase at `src/core/gdrive/auth.ts:59`, and until it is
done every other capability here is a demo.

## What I'd do with my own capital

I'd fund it, because the downside is a few hundred dollars and three weeks, and the upside is a
compounding asset. But I'd change the shape of the bet in three ways:

**Build Phase A first and publish nothing while doing it.** Auth, quota ledger, policy gate, and
killing the fabricated CTR. Four items, three or four days, zero videos produced. It will feel like
no progress. It is the only part of this plan that is genuinely load-bearing.

**Then hand-make ten videos before automating production.** Not through the pipeline — by hand,
with the system assisting. If ten good videos don't find an audience, the pipeline was never the
problem and you've saved yourself the two weeks that GAP-07 (the long-form render orchestrator, the
largest item here) would have cost. If they do find an audience, you now know exactly what the
pipeline needs to produce, which is information you do not currently have.

**Never file for a quota increase.** Six uploads a day is more than the policy environment wants
you to publish anyway, and filing volunteers the operation for a compliance audit. Gate 1 and Gate 4
point the same direction: **fewer, more varied videos**. Let them.

## What I'd fix in the codebase regardless of whether this ships

Three things, named plainly, because they're wrong on their own terms:

- **`src/core/youtube/thumbnail-ab.ts:296` writes a hardcoded `0.04` CTR for every variant and
  stores it as measured.** `selectWinner()` then picks a winner from identical numbers. Every other
  stub in this repo announces itself — `comment-engine.ts:203` literally returns `[STUB] Would
  reply…` and `success: false`. This one lies, and lies confidently. Disable it today.
- **`src/core/feedback/youtube-api.ts:75` paginates `search.list` at 100 quota units per call.**
  It can consume the entire daily budget in 100 iterations and the only symptom will be 403s on
  upload with no obvious cause.
- **`@remotion/renderer` and a whole `src/remotion/` composition tree are carried as dependencies
  that no code in `src/**` imports.** Either wire it (GAP-07 needs a renderer and this one is
  already paid for) or delete it. Carrying it unwired is the worst of both.

The rest of the code is better than I expected. The upload implementation is correct including the
resumable-session handshake, the analytics client is well-built and returns genuinely usable
structured data, the video-generate provider adapters are clean, and the gdrive OAuth module is
exactly right. This is not a repo of stubs. It is a repo with a small number of specific,
citable defects and one strategic mismatch.

## Verdict

**Proceed.** Build Phase A. Do not build the content factory until the policy gate exists.

Proceeding to PART TWO with the P0 set: GAP-01, GAP-02, GAP-04a, GAP-03.
