# Telegram / Agent-UX Roadmap — STATUS LEDGER

Read this before any TX work. Update this file in the same PR as the feature.
Spec: `docs/TELEGRAM_UX_ROADMAP.md`. DONE requires live verification on the
real Telegram surface (cite evidence), not just green tests.

| ID | Title | Status | Evidence / notes |
|----|-------|--------|------------------|
| P0 | Foundation (card, streaming, md→HTML, long-reply, Read More, 👀 ack) | **DONE** | Commits a96b467c, 621d6237, 6ae966bc; live-verified via Telegram Web on display :10, 2026-07-29 (weather turn, 26k report → .md, DNS Read More) |
| TX1 | Stop/Steer on working card | OPEN | run-registry abort + GW-5 steer buffer exist; unwired on cli Telegram path |
| TX2 | 👎 regenerates (v2 in place) | OPEN | feedback store + ids exist |
| TX3 | Per-turn detail toggle | OPEN | |
| TX4 | Inline artifacts | OPEN | rich-output suite exists |
| TX5 | Stream into the fold | OPEN | |
| TX6 | Pinned live status card | OPEN | folds HEALTH alerts (disk-88% spam precedent) |
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
