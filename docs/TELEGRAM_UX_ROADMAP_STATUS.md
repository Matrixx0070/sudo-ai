# Telegram / Agent-UX Roadmap — STATUS LEDGER

Read this before any TX work. Update this file in the same PR as the feature.
Spec: `docs/TELEGRAM_UX_ROADMAP.md`. DONE requires live verification on the
real Telegram surface (cite evidence), not just green tests.

| ID | Title | Status | Evidence / notes |
|----|-------|--------|------------------|
| P0 | Foundation (card, streaming, md→HTML, long-reply, Read More, 👀 ack) | **DONE** | Commits a96b467c, 621d6237, 6ae966bc; live-verified via Telegram Web on display :10, 2026-07-29 (weather turn, 26k report → .md, DNS Read More) |
| TX1 | Stop/Steer on working card | **BUILT** (flag-off, awaiting live verify) | `SUDO_TG_STOP_BUTTON` (default OFF). cli Telegram path now beginRun/endRun on the run-registry; ⏹ Stop button on the working card (`tx1:stop:<runKey>`, owner-only) aborts via the steering channel — honored at the loop's next ITERATION BOUNDARY (post-tool/pre-model-call), not instantly; card finalizes to `⏹ Stopped • 40s • 3 steps`. Steering: with `SUDO_MIDRUN_STEER=1` (+ GW-5 queue mode resolving to `steer`) mid-run inbound text is pushed to the steer buffer BEFORE the coalescer. New `src/core/channels/telegram-run-controls.ts`; 34 new tests. NOT live-verified |
| TX2 | 👎 regenerates (v2 in place) | **BUILT** (flag-off, awaiting live verify) | `SUDO_TG_BAD_REGEN` (default OFF). Owner 👎 swaps the keyboard for one-tap reasons (Wrong / Too long / Missed the point / Skip reasons; `tx2:reason:<feedbackId>:<code>`); a reason tap triggers ONE bounded revision turn (RegenGuard, peer-queue-serialized, skipped while a run is active), edits the reply in place with a `↻ v2` tail + fresh feedback keyboard. Outcome linked via follow-up feedback rows (`regen-requested:` / `regen-complete:` keyed by feedbackId in session_id). Seam: `telegram.setRegenerateHandler` wired from cli.ts. NOT live-verified |
| TX3 | Per-turn detail toggle | OPEN | |
| TX4 | Inline artifacts | OPEN | rich-output suite exists |
| TX5 | Stream into the fold | **BUILT** (flag-off, awaiting live verify) | `SUDO_TG_STREAM_FOLD=1`; `stream-fold.ts` latch decider wired into the cli sink edit callback; status renders never fold; `SUDO_TG_READMORE=0` master-off; 12 unit tests |
| TX6 | Pinned live status card | **BUILT** (flag-off, awaiting live verify) | `SUDO_TG_STATUS_PIN=1`; `status-pin.ts` controller (owner-DM card, data/status-pin.json persistence, 60s cadence + run/health event bumps, ≥15s min-gap); non-critical HEALTH alerts fold into the card, critical failures still bubble; 14 unit tests |
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

Open operational debt noted at roadmap creation: branch `feat/grok-web-chat-brain`
unpushed (3 UX commits + grok-lane work); disk 89% (HEALTH alert firing).
