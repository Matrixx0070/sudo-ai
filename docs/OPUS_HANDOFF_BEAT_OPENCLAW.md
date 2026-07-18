# OPUS HANDOFF — OpenClaw, everything we did and observed this session, then the plan to beat it

2026-07-18, from Fable 5, for a future Opus session in /root/sudo-ai-v4. Structure = the exact order we did things: install → first setup → API key → channels → gateway token → daemon → skills/hooks → TUI chat → web chat → all other functions → measurements → **SUDO-AI build plan (§12)**. Frank is out of the loop: execute §12 autonomously until the scorecard is fully green. Screenshots are viewable — **call Read on any .png path in §13 to see the image.**

---

## 1. Installation process (what we ran, what it produced)

- `npm install -g openclaw` → **OpenClaw 2026.7.1-2 (0790d9f)**, single CLI `openclaw`. We used an isolated `HOME=/tmp/openclaw-home` (since wiped; redo the same way to reproduce).
- Install alone creates nothing — all state appears on first setup under `~/.openclaw/`:
  - `openclaw.json` (single config file), `workspace/` (agent home), `agents/main/sessions/`, `state/openclaw.sqlite` (+wal/shm), `logs/config-audit.jsonl`, `audit/crestodian.jsonl`, `exec-approvals.json`, `workspace-attestations/<sha256>.attested`, `tui/last-session.json`.
- Requirements observed: Node 22 worked; no build step; gateway binds loopback by default so nothing is exposed.

## 2. First-run setup process (`openclaw onboard`) — step by step as we drove it

The modern onboarding is **not a menu wizard — it's a chat with a setup-agent persona named "Crestodian"** rendered in the same TUI as normal chat, and it runs **fully deterministic (zero model configured, zero spend)** — scripted intent matching + a deterministic `crestodian.setup` tool.

Observed sequence, verbatim behavior:
1. Banner: `Hi, I'm Crestodian — let's hatch your agent. No menus here: tell me what you want and I'll do the configuring.`
2. **Machine scan report**: detects existing Claude Code / Codex logins and `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in env ("AI: nothing detected yet…"), states workspace path (`~/.openclaw/workspace`) and gateway plan ("runs locally, private to this machine (token auth)").
3. Security warning up front: `Heads up: your agent gets real access to this machine — https://docs.openclaw.ai/security`.
4. One "yes" triggers `crestodian.setup` which did, in order: seed 7 workspace files (AGENTS/SOUL/TOOLS/IDENTITY/USER/HEARTBEAT/BOOTSTRAP.md — MEMORY.md and memory/ deliberately not created at birth); **auto `git init` the workspace**; create `agents/main/sessions`; on Linux **enable systemd lingering for root** (a real host-level change — it wrote /var/lib/systemd/linger; note: it did this on our prod host, left enabled) and attempt a systemd user service install for the gateway (failed in our env, gave a fix tip, continued gracefully); write `openclaw.json`; print summary (workspace OK / sessions OK / gateway not reachable yet / default model not configured).
5. Then: `Configure a model provider now? Say yes or no.` On "no": `Skipped. Crestodian remains available in deterministic mode; say configure model provider when you are ready.`
6. Every config write is **hash-audited**: `audit/crestodian.jsonl` records operation + configHashBefore/After; `logs/config-audit.jsonl` records pid/argv/cwd/bytes/prev-next hash per write. The seeded workspace gets a content-hash **attestation file**. `.bak` backup written on config updates.
7. Non-interactive path exists for automation: `openclaw onboard --non-interactive --accept-risk --auth-choice <choice> [--skip-channels --skip-health --no-install-daemon ...]` — ~80 flags, quickstart/advanced/manual/import flows, `--reset --reset-scope config|config+creds+sessions|full`.
8. After setup, `BOOTSTRAP.md` scripts the **birth ritual** for the agent's first real conversation (pick name/creature/vibe/emoji together, write IDENTITY.md/USER.md, discuss SOUL.md, then delete the file — deletion marks setup complete).

## 3. API key setup during setup

We configured Frank's xAI key via the non-interactive door: `openclaw onboard --non-interactive --accept-risk --auth-choice xai-api-key --xai-api-key <KEY>`. Effects observed:
- `openclaw.json` gained a **full xai provider block**: baseUrl `https://api.x.ai/v1`, `api: "openai-responses"`, and a complete model catalog with per-model pricing metadata (grok-4.3: $1.25/M in, $2.50/M out, $0.20/M cacheRead, 256K ctx entries, reasoning: true) — pricing lives in config so the UI can compute costs locally.
- **Default model auto-selected**: `agents.primary = "xai/grok-4.3"` — no menu needed.
- Auth profile stored per-provider (`🔑 api-key (xai:default)` as later shown by /status). Key stored plaintext by default; a `--secret-input-mode ref` exists for SecretRef-style storage.
- The interactive path offers the same as masked credential prompts in-chat; ~70 providers/auth choices supported (claude-cli reuse, OAuth device codes, OpenRouter, Ollama local, etc.).

## 4. Channel setup

We skipped channels (`--skip-channels`). What onboarding/the product offers: after setup it prompts `connect discord`, `connect slack`, `connect telegram`, `connect whatsapp` (or `channels` for the full list) as chat commands; the web UI has Settings → Channels with per-channel Connect → flows (we opened Telegram's — guided token entry). Channel-related prompt behavior is pre-wired even with no channels: per-platform formatting rules in AGENTS.md (no tables on Discord/WhatsApp, `<>`-wrapped links on Discord), Telegram reactions section, group-chat etiquette, `dmScope: per-channel-peer` session scoping in config.

## 5. Gateway token setup

Generated automatically during setup, zero questions: `gateway.auth.mode = "token"` with a random 48-hex token in `openclaw.json`, `port: 18789`, `bind: "loopback"`, `tailscale.mode: off`. The web Control UI authenticates with `?token=…` in the URL (or password mode). Also seeded: `controlUi.allowInsecureAuth: true` (the gateway **boot-logs a security warning** about it and points to `openclaw security audit`) and a **node deny-command list** (camera.snap, screen.record, sms.send, contacts/calendar/reminders.add…) — privacy-sensitive device commands denied by default. Token reveal/rotate available in web Settings; `--gateway-token-ref-env` supports env-indirect tokens.

## 6. Gateway daemon

- Intended install: **systemd user service** (Linux) via onboarding or `openclaw gateway install`; needs lingering (which it enables itself). In our sandbox the unit install failed (`Unit file openclaw-gateway.service does not exist`) — onboarding continued and told us to rerun later; we just ran `openclaw gateway` in foreground instead.
- Boot observed: **~4.3s to http listening with 8 plugins** (browser, canvas, device-pair, file-transfer, memory-core, ollama, phone-control, talk-voice) → `starting channels and sidecars` → `loaded 1 internal hook handler` → `ready` → `heartbeat started` (default 30-min heartbeat cadence begins immediately). Logs to `/tmp/openclaw/openclaw-YYYY-MM-DD.log` + captured stdout.
- One process owns everything: HTTP + WebSocket + Control UI static serving + channels + cron + heartbeat, all on 18789 loopback. TUI and `openclaw agent` CLI are thin clients over it (`openclaw agent --local` can run embedded without the daemon).
- Process name truncates to `openclaw-gatewa` in ps (15-char comm) — kill by PID/pattern accordingly.

## 7. Skills, hooks, workspace files

- **Skills**: 53 present out of the box (51 built-in + 2 extra). Prompt cost is tiny: an XML catalog only (`<available_skills>` name/description/path/version-hash ≈ 24 tokens per skill); bodies are **read on demand** by the agent when a task matches; `<version>` hash re-read rule handles mid-session edits. Gating via frontmatter `requires.bins/env/config/os` — web UI showed readiness triage **Ready 21 / Needs Setup 32 / Disabled 0**, with per-skill detail (gifgrep: blocked on missing bin `gifgrep`, one-click Install button). Skill creation by the agent goes through a **skill-workshop proposal → human approval board** (web page), never direct SKILL.md writes.
- **Hooks**: `boot-md` bundled hook (runs BOOT.md checklist once per gateway start; ships disabled, `openclaw hooks enable boot-md`); "loaded 1 internal hook handler" at boot; hooks configurable in Settings → Automation → Hooks (allowed agent IDs list etc.).
- **Workspace guidance files** (the agent's "self"): AGENTS.md = operating rules, SOUL.md = voice only, IDENTITY/USER/TOOLS/HEARTBEAT/BOOTSTRAP; MEMORY.md + memory/YYYY-MM-DD.md appear later, curated-vs-raw split; MEMORY main-private-session only. **Full verbatim contents of all of these + the assembled runtime system prompt are in Appendix A of the evidence doc — and the complete captured 22,127-char system prompt is at `docs/openclaw-assembled-system-prompt-2026.7.1-2.txt`.** Key mechanics: stable-prefix + `<!-- OPENCLAW_CACHE_BOUNDARY -->` split (only HEARTBEAT.md below), 20k/file + 60k total injection budgets, AGENTS.md policy-digest truncation, missing-file markers, empty-HEARTBEAT ⇒ heartbeat model call skipped entirely.

## 8. TUI chat — how it looks and reacts (measured)

- Launch `openclaw` → connects to gateway WS; header `openclaw tui - ws://127.0.0.1:18789 - agent main - session main`; startup banner with rotating personality tagline ("I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges").
- **Layout**: minimal dark prompt-first design — scrolling transcript (user bold, replies plain text, no bubbles/markdown/timestamps), two-line live footer (`gateway connected | idle` + chip `agent main | session main | xai/grok-4.3 | think low | tokens 21k/1.0m (2%)`), boxed input.
- **Reaction while working** (frame-sampled at 250ms): footer becomes a 3-phase progress line with braille spinner + per-phase elapsed counter: `⠦ noodling… • 0s` (waiting; verb rotates whimsically — also saw "dillydallying…") → `⠋ running • Ns` → `⠏ streaming • Ns` with **tokens streaming live into the transcript** → back to `idle`. Mode changes add chips in place (`/reasoning on` → persistent `reasoning` badge). Context-fill % updates live.
- **Thin client over the durable session**: kill/relaunch TUI → entire transcript restored instantly.
- **Slash surface**: /help /commands /status /gateway-status /agent(s) /crestodian /session(s) /model(s) /think off..high /fast /verbose /trace /reasoning /usage /elevated on|off|ask|full /activation mention|always /new /reset /abort /settings /exit.
- **/status card** (emoji-labeled): version, time, gateway+system uptime, model + auth profile, **live tokens+cost (`169 in / 549 out · $0.0057`)**, **cache telemetry (`99% hit · 21k cached, 0 new`)**, context fill + compaction count, session key/duration, execution mode/think/fast, queue mode `steer (depth 0)` — inbound messages steer a running turn rather than queue.
- **Measured**: 8-message conversation avg **5,310 ms/turn** (min 3.0s, max 9.9s first-turn bootstrap). Gap observed: `/reasoning on` at think-low rendered no reasoning text in-terminal (chip only).

## 9. Web chat (Control UI /chat) — how it looks and reacts

- Same durable session as the TUI (terminal conversation appeared verbatim; live message answered "This is the webchat surface and I'm running on xai/grok-4.3").
- Light lobster-red SPA; chat bubbles with timestamps (user right-aligned); **reasoning rendered as dashed inset blocks** (web shows what TUI didn't); tool calls as collapsible cards (`Session Status current`); suggestion chips on empty state (clicking one runs a real turn and auto-titles the session); composer: attachment menu (Take photo/Photo/File), voice input (clean error when no realtime voice provider configured), `/` opens a ~44-command menu, model/thinking chip popover (reasoning slider, speed group), live context dial, split view (2 panes, split down/right), session-workspace side panel = **file browser over the agent workspace** (preview/copy-path), "New chat in worktree" button (defect: no-op in this build).

## 10. All other Control UI pages and functions (exhaustively exercised — 108 screenshots + `docs/assets/openclaw-webui/deep/DEEP_CRAWL_REPORT.md`)

- **Overview**: stat tiles (Cost/tokens/msgs, Cron jobs, Sessions, Skills 53/53) — each tile navigates; live Gateway Logs (50) + Event Log; Connect card with token/password reveal toggles.
- **Activity**: filterable live feed (search, tool combobox, status checkboxes, auto-follow).
- **Instances**: gateway + control-ui presence beacons, host-visibility toggle.
- **Sessions**: table with per-row **context fill** (`24893 / 1000000`), last-activity; **Fork** (verified: bench50 → new session with copied history), Archive (instant, **no confirm** — defect), Mark-as-unread, sort/group-by-kind.
- **Usage**: per-day bars with drill-down (July 18: **1.4M tokens, $0.47** — exactly reconciled our benchmark spend), Cost/Tokens × Total/By-Type × 30d/90d/All × current-instance/historical-lineage, Pin/Copy.
- **Cron**: full lifecycle verified via New Job wizard (What/When/How): created daily silent job → Run (OK + run history + /tasks entry) → menu Run-if-due/Disable/Clone/History/Remove (Remove instant, no confirm — defect).
- **Tasks**: background runs list (showed our cron run).
- **Agents**: tabs Overview / **Files(8)** / Tools(29/42 + presets) / Skills / Channels / Cron. Files tab = **in-browser editor for the guidance files** — we edited SOUL.md, verified on disk, reverted, re-verified; MEMORY missing → "Saving will create it".
- **Skills**: readiness filters, groups, per-skill detail + install.
- **Skill Workshop**: proposal board (Board/Today) — the human side of the skill write firewall.
- **Nodes**: paired-device management, per-node + default **scopes/permissions** (Security/Ask/Fallback), allowlist patterns, token Rotate/Revoke (not clicked — confirm-less risk).
- **Dreaming**: memory-dreaming page (Scene/Diary/Advanced; toggle requires gateway restart, confirms first).
- **Settings**: 10 sections — General (identity/avatar presets/thinking defaults/theme + Connect→Configure→Manage deep links), Channels, Communications, Appearance, **Automation (6 tabs: Commands/Hooks/Bindings/Cron/Approvals/Plugins)**, MCP, **Infrastructure (8 tabs: Gateway/Web/Browser/NodeHost/Discovery/Media/Acp/Mcp)**, Worktrees, AI & Agents, Debug+Logs. It's a **typed GUI over openclaw.json** with Reload/Save/Apply semantics and automatic `.bak`/`.last-good` backups (verified via a field save→disk→revert round-trip; bind-mode change discarded unsaved and verified untouched).
- **Command palette** (Ctrl+K): navigation + slash-command search.
- **8 defects catalogued** (our S17 ammunition): worktree-chat no-op; confirm-less Archive/cron-Remove; PWA manifest 404 on nested routes; editor drops Save during in-flight save; settings search filters only active tab but claims section-wide no-match; "Open" header button no-op; unsaved-counter unreliable; no min-clamp on number spinners + `{}` residue on field unset.

## 11. Measurements (the numbers to beat)

- **50-message CLI benchmark** (grok-4.3, one session): 50/50 success, avg 7,987 ms/turn (incl. ~2.7s process boot), ~$0.35 total (~$0.007/msg); **91.6% of prompt tokens were cache reads** by turn 50 (24,768 cached vs 125 fresh) — the cache-boundary prompt design = **~4× input-cost cut**, independently confirmed by /status ("99% hit").
- **TUI**: avg 5,310 ms/turn over 8 messages (persistent session removes boot cost).
- Full method + raw data pointers: evidence doc §8–§9.

## 12. SUDO-AI BUILD PLAN — beat OpenClaw in every way

**Scorecard (done = all 18 green with cited evidence):**
S1 ≥90% cache-read share over 50 turns on our primary route · S2 policy-digest truncation + missing-file markers + truncation warnings (never-line survives 4× over-budget test) · S3 skill catalog ≤30 tok/skill + read-on-demand + version-hash invalidation (keep deterministic triggers as fast path) · S4 per-session-type injection allowlists, ≥30% token cut on cron/subagent turns · S5 empty-heartbeat ⇒ no model call (logged skip) · S6 /status card (Telegram + SPA + admin: tokens/cost/cache%/context/compactions, no SQL) · S7 per-day/per-type usage drill-down over api_call_log (≤1% ledger drift) · S8 sessions table with context fill + fork + archive-WITH-confirm · S9 per-turn prompt report (section chars+sha256, no raw text) + stable-prefix-churn alert · S10 guidance-file viewer + gated hash-audited writes (frozen identity files read-only always) · S11 prompt-literal sanitization at every interpolation seam (adversarial-dirname test) · S12 deterministic zero-spend `sudo-ai onboard` with hash-audited config writes · S13 live working-states (Telegram typing/progressive-edit + SPA phases w/ elapsed) + always-visible model/context chip · S14 whimsy (rotating verbs, birth ritual, taglines; SUDO_WHIMSY=1) · S15⚡ security suites green (zones/quarantine/sandbox/SecretRef — our lead, protect) · S16⚡ learning suites green (flywheel/self-eval/episodic — our lead) · S17 defect-parity: each of the 8 defects proven absent in our equivalent surface · S18 head-to-head 50-msg bench: 50/50, latency within 25% of 5.3s median, cost/msg ≤ theirs → `docs/BEAT_OPENCLAW_BENCH.md`.

**Workstreams BO1–BO14, execution order:** BO1 measurement harness + baseline (S1,S9 — FIRST, before any change) → BO2 cache-buster fixes + byte-identical prefix + hash test (S1) → BO3 policy digest/markers/warnings (S2) → BO4 allowlists + heartbeat skip (S4,S5) → BO5 sanitization (S11) → BO6 skill catalog + workshop list view (S3) → BO7 /status card (S6; look at `state-status.png` first) → BO8 usage drill-down in INLINE dashboard-html.ts — the SPA is dead/shadowed (S7; `webui-07-usage.png`) → BO9 sessions table (S8; `webui-06-sessions.png`) → BO10 guidance-file UI (S10; `webui-10-agents.png`) → BO11 live states + whimsy (S13,S14; `state-streaming.png`) → BO12 onboarding (S12) → BO13 defect-parity audit (S17) → BO14 head-to-head bench + final sweep (S18) → `docs/BEAT_OPENCLAW_FINAL.md` with side-by-side screenshots.

**Execution rules:** worktree per workstream off fresh origin/main (others commit; never touch feat/gdrive-*; node_modules symlinks from prod checkout; pre-commit branch guard vs auto-fix daemon); Guardian hook may block Edit/Write → python-in-Bash; tests green + CI for full-suite verdicts; deploy = source tree under pm2/tsx, restart via ecosystem file --only, probes wait 80s+; **live-verify every claim on the daemon and verify wiring in the MERGED diff** (#821 lesson); log evidence per row in `docs/BEAT_OPENCLAW_SCORECARD.md` (create from S-list on first touch).

**Autonomy:** proceed without Frank on all BO work, PRs, merges, deploys, and measurement runs within existing caps (SUDO_DAILY_BUDGET_USD=100/LLM=50, alerting-only). Stop ONLY for: new recurring spend or cap raises; writes to frozen identity surfaces (invariant 4 — read-only UI is fine); NotebookLM/N5 (standing NO); npm publishes; user-data deletion; prod credential rotation. Never regress the security/learning leads (S15/S16) — any OpenClaw-inspired change that weakens zones, quarantine, frozen surfaces, or budgets is rejected. When all green: `BEAT_OPENCLAW_FINAL.md`, update wiki+memory, one summary message to Frank.

## 13. Artifacts & screenshots (Read any .png to view it)

| What | Path |
|---|---|
| Evidence doc — full detail behind every section above (incl. **Appendix-level §1–§7 guidance/prompt analysis and §6 adoption list**) | `docs/OPENCLAW_AGENT_GUIDANCE_REVIEW.md` |
| Captured 22,127-char runtime system prompt, verbatim | `docs/openclaw-assembled-system-prompt-2026.7.1-2.txt` |
| TUI: conversation snaps 1–8 + states help/status/working/streaming/reasoning | `docs/assets/openclaw-tui/*.png` |
| Web UI: one shot per page (01 chat … 15 settings) | `docs/assets/openclaw-webui/webui-*.png` |
| Web UI exhaustive: 108 shots + function-by-function report | `docs/assets/openclaw-webui/deep/` (`DEEP_CRAWL_REPORT.md` is the index) |
| Wiki continuity | `/root/claude-obsidian/wiki/20260718000000000000-openclaw-agent-guidance-study.md`, `wiki/hot.md` |

Note: the /tmp sandbox + clone were wiped; the xAI key used for benchmarks lives only in chat history now — flag rotation to Frank if it ever resurfaces. OpenClaw's installer left systemd lingering enabled for root on this host.

— end
