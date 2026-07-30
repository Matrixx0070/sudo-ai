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
| TX7 | Morning digest | **BUILT flag-off** (#996, 2026-07-30) | morning-digest.ts + cli daily timer; spend/cron/brain-domains/missions/checkpoints; zero llm calls; SUDO_TG_MORNING_DIGEST + SUDO_TG_DIGEST_HOUR_UTC; DIG-1..4. Live-verify on activation |
| TX8 | Provenance footer | SUPERSEDED | by TX28 (built 2026-07-30) — toast beats an always-on footer |
| TX9 | Mission Control | **BUILT flag-off v1** (#994, 2026-07-30) | mission-control.ts: sqlite missions, living card (post/edit seam), auto-advancing phases, Approve/Redirect/Abort via TX10, restart re-attach; MC-1..9; SUDO_TG_MISSION_CONTROL; forum-topic group = operator step (TELEGRAM_MISSION_GROUP_ID); v2 = mission tool + cli transport wiring |
| TX10 | Checkpoint approval protocol | **BUILT + DEPLOYED** (#993, 2026-07-30) | checkpoint-protocol.ts (persisted artifact, HOLD-on-timeout, restart-safe) + tx10: TG route + boot init (live: \"TX10: checkpoint protocol initialised\" in prod log); CP-1..7 |
| TX11 | Live browser screenshots in card | **DONE** (live-verified) | `SUDO_TG_BROWSER_VIEW=1` in prod; `SUDO_TG_BROWSER_VIEW_KEEP=0` (bubble deleted at turn end — Frank's call). Verified 2026-07-29: working card `✻ Reading a page · 1m 09s · browser › scrape…` with a SEPARATE photo bubble beneath showing the real Wikipedia Apollo 11 page, captioned with the live URL; logs show `Screencast started fps:2` then `Screencast stopped` at teardown; delete-on-teardown confirmed on the KEEP=0 run. A text card can NEVER become media, hence the separate bubble. Frames reuse `screencastManager` (the /admin MJPEG source); an already-active cast is reused and never stopped. Unchanged frames skipped (sha1). PRIVACY: owner + DM only. 16 unit tests |
| TX12 | Video-note debrief | OPEN | Playwright video + TTS + ffmpeg |
| TX13 | Generative Telegram UI | **BUILT flag-off** (#997, 2026-07-30) | telegram-genui.ts: closed-schema→md+keyboards, token registry (64-byte cap), taps → same [CANVAS EVENT] wire as web; canvas.render TG fallback; SUDO_TG_GENUI; GENUI-1..5; forms read-only v1 |
| TX14 | Visible memory (🧠 used, /memory card) | OPEN | invariant 9 applies to surgery |
| TX15 | Ambient agency with evidence | OPEN | budgeted, owner-only |
| TX16 | Self-tuning voice | OPEN | outcome-gated learning exists |
| TX17 | Cross-channel continuity surfaced | OPEN | |
| TX18 | Voice conversation mode | OPEN | |
| TX19 | Overnight self-improvement + Deploy cards | **BUILT flag-off v1** (#998, 2026-07-30) | overnight-improve.ts: nightly gated run (#988 fail-closed gate) → deploy card → TX10 checkpoint; Deploy = approval ARTIFACT only (AL8.6 no auto-apply); SUDO_TX19_OVERNIGHT/HOUR_UTC; T19-1..6. Frank gate absolute on activation |
| TX20 | Anticipatory work | BLOCKED-by-policy | Frank's standing no-autonomous-spend decision; mechanism exists flag-off (outcome-gated learning campaign) |
| TX21 | Pre-decision options | COVERED by TX10+TX13 (2026-07-30) | the mechanism (choice keyboards + persisted decisions) shipped; remaining = prompt-side adoption, no new code |
| TX22 | Named agent team in a group | OPEN | needs N bot tokens (operator step) |
| TX23 | Team standups | OPEN | |
| TX24 | Board meeting (P&L + capped experiments) | OPEN | budget invariants + TX10 |
| TX25 | /soul identity card | **BUILT** (2026-07-30) | soul-card.ts summary + per-file sha256 provenance; owner-only /soul; invariant-4 read-only; SOUL-1..3. Live-verify: Frank taps /soul |
| TX26 | Succession ceremony | OPEN | judge independence hard rule |
| TX27 | Institutional memory report | OPEN | |
| TX28 | Tap-to-verify provenance | **BUILT flag-off v1** (2026-07-30) | provenance.ts: 🔍 button on reply keyboard → live traces.db toast (model/ok/latency/time); SUDO_TG_PROVENANCE; PROV-1..4; ADR-0002 rung slots in when grading ships |

Open operational debt: disk 89%. (Branch-unpushed debt CLEARED 2026-07-29 —
pushed, merged to main via #970, prod deployed to `63e1cf73`.)

## Post-merge re-verification (2026-07-29, after the 84-commit main merge)

Prod ran 84 commits behind main until 2026-07-29. Because TX1–TX11 have **no
automated coverage**, the tier was re-proven live on the real Telegram surface
after the deploy, driven over CDP against Frank's Telegram Web session.

**Token streaming (P0) — RE-PROVEN.** This was the merge's one dangerous
conflict: main wrapped the brain call in `runWithLoopStep` while INLINING the
request literal, which would have silently dropped the `_onTextDelta` hook the
branch attaches to a hoisted `brainReq`. Resolved as a union. Proof — the reply
bubble's text sampled every 400ms:

```
+2414ms  len= 35   ✢ Thinking … 0s   [Stop] [Details]
+4424ms  len= 29   "The deep"        [Stop] [Details]   <- partial text mid-stream
+5634ms  len=734   full paragraph
+6036ms  len=736   + Good/Bad/Skip keyboard
```

An 8-character fragment at 4.4s that became 734 chars at 5.6s. Had streaming
broken, the bubble would have jumped from `✢ Thinking` straight to the full text
with no intermediate state. **`tsc` and all 12,166 tests pass either way — only
this sampling distinguishes them.**

Re-proven in the same trace/screenshot: TX1 Stop, TX3 Details, the P0 working
card with pulse glyph + elapsed timer, the 👀 ack, the feedback keyboard riding
the LAST bubble, and TX6's pinned live status card (`◉ Sudo-Ai — live status
🔶 working — telegram:8087386717 · 52s ⏰ Cron: 24 active · all gre…`).

Verification recipe (reusable): launch Chrome `--user-data-dir=/root/chrome_profile
--remote-debugging-port=9222` on `DISPLAY=:10`, then drive raw CDP from Node 22
(global `WebSocket` + `Runtime.evaluate`). GOTCHAS: playwright's
`connectOverCDP` hangs against this profile and its `browser.close()` kills the
whole browser; the chrome-devtools MCP drives its own dead instance; the real
message box is `.input-message-input[data-peer-id]` (the bare selector matches a
hidden fake that swallows clicks); web.telegram.org/k/ needs ~10–20s to hydrate.

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


## 2026-07-30 — all-roadmaps run additions (Fable, autonomous)

TX7/TX9/TX10/TX13/TX19/TX25/TX28 built (see table). Deferred-with-rationale (OPEN, not dropped — never-drop rule):
- TX12 video-note, TX18 voice mode: media pipelines needing live TG verification beyond flag-off provability.
- TX14 visible memory, TX27 institutional report: buildable v1s; queued behind the 07-30 telegram.ts merge-train.
- TX15 ambient / TX16 self-tuning voice / TX17 continuity / TX23 standups / TX24 board / TX26 succession: compose on TX9/TX10/TX22 + budget activations; several gated on operator steps or spend policy.
- TX22: needs N bot tokens (operator).

DONE bar reminder: table rows above marked BUILT are flag-off; roadmap DONE = live-verified on TG after Frank activates flags.
