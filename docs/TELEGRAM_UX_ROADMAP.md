# Telegram / Agent-UX Roadmap — TX1–TX28

**Mission.** Make Sudo-Ai's primary surface (Telegram, generalizing to all channels)
feel like a Fable-family product: interruptible, steerable, honest, visual, and —
at the far end — an agent you run like a colleague, a team, and an institution.

**Read `docs/TELEGRAM_UX_ROADMAP_STATUS.md` first each session — never reconstruct
state from memory.** Feature IDs TX1–TX28 are stable; use them in commits/PRs.

## Principles (binding)

1. **Bitter lesson.** One general mechanism over N special cases; design for the
   model 6 months out. The model authors UI (A2UI mapping) rather than us
   hand-coding layouts per feature.
2. **Every feature ships behind a kill switch**, default matching current prod
   behavior. Owner-tier actions stay owner-gated; nothing widens the public
   surface without an explicit gate review (grok-MCP precedent).
3. **Live-verify discipline.** A TX item is DONE only when exercised on the real
   Telegram surface (screenshots or logs cited), not when tests pass.
4. **Budgets.** Every background/proactive lane declares per-run + per-day spend
   budgets; exhaustion halts gracefully and reports (CLAUDE.md invariant 10).
5. **Reuse.** The repo already contains most machinery (run-registry, steer
   buffer, swarm, A2UI, feedback store, AL ladder, identity manifest, earning
   lanes). TX work is *unmasking* it into chat — never parallel plumbing.

## Phase 0 — Foundation (SHIPPED 2026-07-29, commits a96b467c / 621d6237 / 6ae966bc)

Live-verified in prod: instant 👀 ack; compact working card
(`✻ **Searching the web**` + `12s · web › search…`, pulse glyphs, semantic
headlines, `SUDO_TG_TIMELINE_DETAIL=1` step list); brain-level token streaming
(`SUDO_BRAIN_STREAM`, solo-path only, pre-delta fallback, poison-on-failover);
markdown→Telegram-HTML rendering (`telegram-format.ts`); long-reply planner
(chunks / `.md` file past `SUDO_TG_FILE_THRESHOLD`); expandable "Read More"
blockquotes (`SUDO_TG_READMORE`); feedback keyboard attached to the reply
(no carrier-bubble litter).

---

## Tier 1 — Control while it works

- **TX1 — Stop/Steer on the working card.** Inline ⏹ Stop button aborts the
  active run via the run-registry abort handle; card finalizes to
  `⏹ Stopped • 40s • 3 steps`. Replying to the working card mid-run routes the
  text into the GW-5 steer buffer (currently unwired on the Telegram cli path)
  instead of queueing a new turn. Flags: `SUDO_TG_STOP_BUTTON`,
  reuse `SUDO_MIDRUN_STEER`.
- **TX2 — 👎 closes the loop.** Tapping Bad triggers an immediate regeneration:
  the agent receives its own reply + rejection signal + optional one-tap reason
  (Wrong / Too long / Missed the point), edits a `v2` revision in place, links
  the feedback row to the revision outcome. Flag: `SUDO_TG_BAD_REGEN`.
- **TX3 — Per-turn detail toggle.** "Details" inline button on the working card
  flips compact ↔ step-list rendering for THAT turn (callback-driven), replacing
  the process-wide env toggle for interactive use.

## Tier 2 — Output beyond prose

- **TX4 — Inline artifacts.** Turns that produce charts/tables/documents post
  the rendered image/file in-flow (rich-output suite + canvas renderer exist);
  data/source folds into the expandable quote beneath.
- **TX5 — Stream into the fold.** Once streamed text passes the Read More
  threshold mid-write, continue streaming *inside* the collapsed blockquote so
  the bubble never becomes a wall even while writing (sink edit formatting).

## Tier 3 — Ambient presence

- **TX6 — Pinned live status card.** One pinned, continuously-edited "◉ Sudo-Ai"
  message: current activity, background jobs, spend vs budget, last incident.
  HEALTH alerts (disk-88% style) fold into it instead of new bubbles.
- **TX7 — Morning digest.** One bubble: bold headline + expandable sections
  (overnight crons, memory highlights, commitments due) from daily-log +
  commitments extractor.

## Tier 4 — Trust chrome

- **TX8 — Provenance footer (opt-in).** Last line `fable-5 · 14s · $0.004 · 3
  tools` from brain usage data. Superseded long-term by TX28 receipts.

---

## Moonshots — interaction-model changes

- **TX9 (M1) — Mission Control.** Missions as the unit of work: multi-hour runs
  with a living mission card (phases, checkpoints, artifacts-as-they-complete)
  and inline **Approve / Redirect / Abort** at genuine decision points.
  Telegram forum topics: one topic per mission, auto-created; general chat
  stays clean. Builds on run-lanes, swarm, steer buffer, journal.
- **TX10 (M1b) — Checkpoint approval protocol.** The formal "agent asks, owner
  taps" seam (callback-driven), reused by TX19/TX24/TX26 gates. Harness-enforced:
  the artifact/attestation must exist before unblocking (CLAUDE.md invariant 8).
- **TX11 (M2) — Live browser screenshots in the card.** During browser tools,
  editMessageMedia swaps real screenshots into the working card (~3s cadence) —
  an animated view of the agent actually working.
- **TX12 (M2b) — Video-note debrief.** Mission end: circular Telegram video from
  the Playwright session recording + TTS narration ("compared three vendors,
  picked B because…"). ffmpeg + existing TTS.
- **TX13 (M3) — Generative Telegram UI.** Map the A2UI closed schema onto
  Telegram primitives: model-authored inline keyboards, choice cards, and
  reply-markup forms per turn. One general mapping; the model decides when a
  reply should be an interface.
- **TX14 (M4a) — Visible memory.** Replies that used memory carry a
  "🧠 used: …" expandable; `/memory` card with tap-to-correct/forget
  (two-reader consensus rules for surgery per CLAUDE.md invariant 9).
- **TX15 (M4b) — Ambient agency with evidence.** Webhook/email/cron events open
  conversations with the evidence attached ("CI failed 12 min ago — diff
  attached, want a fix branch?"). Budgeted, owner-only.
- **TX16 (M5) — Self-tuning voice.** Feedback + regen outcomes feed the
  outcome-gated learning loop, pointed at presentation (length, structure,
  fold thresholds, voice-note usage). Per-owner learned style.
- **TX17 — Cross-channel continuity surfaced.** Start on Telegram, continue via
  email/web with visible thread state (cross-channel memory exists; make the
  handoff explicit and user-visible).
- **TX18 — Voice conversation mode.** Voice-note in → voice+text out with
  waveform, sustained across turns (TTS + transcription exist; add the mode
  latch per chat).

---

## Horizons — what the agent is

### H1 — The Colleague (TX19–TX21)

- **TX19 — Overnight self-improvement with one-tap Deploy.** Nightly bounded
  runs propose improvements, grade them on the verifiability ladder (rungs 0–3
  code-graded; ADR 0002), and surface a morning card: "built X — 14 tests,
  rung-3 verified, diff attached — **[Deploy] [Discard]**". Rides AL1–AL10
  (COMPLETE, flag-off) + TX10 approvals. Frank gate absolute; deploy = the
  existing supervised merge path, never direct-to-prod.
- **TX20 — Anticipatory work.** World-model (world-goals/attention subsystems)
  + bounded overnight budget pre-does work: briefs, drafted replies, prepared
  options. Morning = inbox of finished work to accept/discard.
- **TX21 — Pre-decision options.** For detected upcoming decisions, the agent
  prepares an options card (with TX13 UI) before being asked.

### H2 — The Team (TX22–TX23)

- **TX22 — Named agent team in a group.** A Telegram group with N distinct bot
  identities (Researcher / Builder / Operator personas), each with its own
  working card; delegation via sessions.send visible in-thread; owner steers
  anywhere. Assembly of: multi-token adapters, router, persona system,
  inter-agent messaging (hop≤3).
- **TX23 — Team standups.** Mission cards (TX9) become per-agent standups in
  the group; the Operator agent owns the pinned status (TX6) for the fleet.

### H3 — The Institution (TX24–TX27)

- **TX24 — The board meeting.** Weekly P&L card from earning/business/finance
  subsystems; agent proposes capped-spend revenue experiments
  ("$15 to test lane X — **[Approve]**"), reports actuals, kills losers.
  All spend behind TX10 approvals + budget invariants.
- **TX25 — /soul.** Identity card from the signed manifest + constitution:
  who I am, what changed this year, drift-pulse status, cryptographically
  attested. Read-only over frozen surfaces (CLAUDE.md invariant 4).
- **TX26 — Succession ceremony.** Model upgrades run the successor gate +
  verifiability ladder on the owner's real workload, results in an expandable
  card, owner taps to promote. Judge independence hard rule (invariant 7).
- **TX27 — Institutional memory report.** Quarterly "what I learned / what I'd
  change" narrative from ledgers + memory, as a document artifact.

### The stitching thread

- **TX28 — Tap-to-verify provenance.** Any claim in any reply expands to the
  evidence that produced it (tool output, source, calculation) — per-claim
  receipts as a UI primitive. Long-term successor to TX8; pairs with the
  verifiability ladder for graded confidence.

---

## Sequencing (recommended)

1. **TX1 + TX2** (control) → 2. **TX11** (screenshot streaming — demo apex) →
3. **TX9 + TX10** (Mission Control + approvals, unlocks the horizons) →
4. **TX13** (generative UI) → 5. **TX19** (Deploy cards — compounds everything) →
6. TX6/TX7/TX14/TX15 (presence + memory) → 7. H2 team → 8. H3 institution.

Gap-repair rule: if a TX item needs a missing platform capability, land the
platform repair first (own PR), then the TX feature — never inline forks.
