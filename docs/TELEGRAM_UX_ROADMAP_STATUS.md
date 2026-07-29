# Telegram / Agent-UX Roadmap — STATUS LEDGER

Read this before any TX work. Update this file in the same PR as the feature.
Spec: `docs/TELEGRAM_UX_ROADMAP.md`. DONE requires live verification on the
real Telegram surface (cite evidence), not just green tests.

| ID | Title | Status | Evidence / notes |
|----|-------|--------|------------------|
| P0 | Foundation (card, streaming, md→HTML, long-reply, Read More, 👀 ack) | **DONE** | Commits a96b467c, 621d6237, 6ae966bc; live-verified via Telegram Web on display :10, 2026-07-29 (weather turn, 26k report → .md, DNS Read More) |
| TX1 | Stop/Steer on working card | **DONE** (live-verified) | `SUDO_TG_STOP_BUTTON=1` in prod. Verified 2026-07-29 on Telegram Web + Frank on phone: taps produced `⏹ Stopped • 27s • 1 step`, `• 31s • 5 steps`, `• 1m 21s • 9 steps`; abort honored at the loop iteration boundary; reply suppressed. Steer leg (SUDO_MIDRUN_STEER=1, queue mode `steer`) enabled but NOT separately live-proven |
| TX2 | 👎 regenerates (v2 in place) | **DONE** (live-verified) | `SUDO_TG_BAD_REGEN=1`. Verified 2026-07-29: 👎 → toast "Noted — what was wrong?" + reason keyboard (Wrong/Too long/Missed the point/Skip) → "Too long" → reply edited IN PLACE, materially shorter, `↻ v2` marker, fresh feedback keyboard. Regen prompt de-`[system]`-ised (tripped our own injection detector) |
| TX3 | Per-turn detail toggle | **DONE** (live-verified) | `SUDO_TG_DETAIL_TOGGLE=1`. Verified 2026-07-29: toast "🔎 Step detail on", label flipped to ▪ Compact, card switched to the live step list (`✓ browser › fetch · 2s`, `✗ browser › fetch · 1s`, `… +2 earlier steps`) |
| TX4 | Inline artifacts | **PARTIAL** (captions live-verified) | `SUDO_TG_ARTIFACTS=1`. Verified: PDF artifact delivered with caption "ai coding assistants comparison 2026". Data-fold path not separately exercised live |
| TX5 | Stream into the fold | **PARTIAL** (fold live-verified) | `SUDO_TG_STREAM_FOLD=1`. Read More blockquotes render + expand correctly on long replies; mid-stream latch (fold engaging DURING the stream) not isolated live |
| TX6 | Pinned live status card | **DONE** (live-verified) | `SUDO_TG_STATUS_PIN=1`. Pinned card live in owner DM: `🟢 idle · Cron 24 active · Today $66/$100 · no incidents`, self-updating; HEALTH alerts fold with a ×N counter instead of new bubbles |
| TX7 | Morning digest | OPEN | |
| TX8 | Provenance footer | OPEN | superseded long-term by TX28 |
| TX9 | Mission Control (forum topics, living mission card) | OPEN | |
| TX10 | Checkpoint approval protocol | OPEN | prerequisite for TX19/TX24/TX26 |
| TX11 | Live browser screenshots in card | OPEN | editMessageMedia; ~3s cadence |
| TX12 | Video-note debrief | OPEN | Playwright video + TTS + ffmpeg |
| TX13 | Generative Telegram UI (A2UI mapping) | OPEN | |
| TX14 | Visible memory (🧠 used, /memory card) | OPEN | invariant 9 applies to surgery |
| TX15 | Ambient agency with evidence | OPEN | budgeted, owner-only |
| TX16 | Self-tuning voice | OPEN | outcome-gated learning exists |
| TX17 | Cross-channel continuity surfaced | OPEN | |
| TX18 | Voice conversation mode | OPEN | |
| TX19 | Overnight self-improvement + Deploy cards | OPEN | AL1–AL10 COMPLETE flag-off; ADR 0002 rungs; Frank gate absolute |
| TX20 | Anticipatory work | OPEN | world-goals/attention flagged off in prod (no autonomous spend) |
| TX21 | Pre-decision options | OPEN | |
| TX22 | Named agent team in a group | OPEN | needs N bot tokens (operator step) |
| TX23 | Team standups | OPEN | |
| TX24 | Board meeting (P&L + capped experiments) | OPEN | budget invariants + TX10 |
| TX25 | /soul identity card | OPEN | read-only over frozen surfaces |
| TX26 | Succession ceremony | OPEN | judge independence hard rule |
| TX27 | Institutional memory report | OPEN | |
| TX28 | Tap-to-verify provenance | OPEN | pairs with verifiability ladder |

Open operational debt: branch `feat/grok-web-chat-brain` unpushed; disk 89%.

## Platform fixes found while verifying TX1-TX6 (2026-07-29)

- **Dead inline buttons (all of them, for months).** The custom poll loop
  requested `allowed_updates=["message"]` AND skipped updates without
  `.message`, so no `callback_query` ever reached the bot — the 👍👎⏭
  feedback keyboard was decorative and TX1/TX3 inherited the dead path.
  Fixed: `POLL_ALLOWED_UPDATES` + dispatch guard (`0d428754`), 4 regression tests.
- **Literal `**bold**` in long replies.** Budgets counted markdown SOURCE while
  Telegram counts the RENDERED body; a 4090-char source rendered to 4373 chars
  → 400 → silent plain-text fallback. Fixed: `renderMdWithinLimit` +
  `MD_SOURCE_CHUNK_LIMIT`/`DEFAULT_CHUNK_LIMIT` 3600 (`08d10990`); the
  HTML-failure catches now log instead of swallowing.
- **Feedback keyboard on the wrong bubble.** On chunked replies it rode the
  first bubble (scrolled out of view); now rides the last (`767fb177`).
