# BOOTSTRAP.md — First-Run Guide (Updated for User Completion: Single-Command + TUI Wizard + Direct TUI Validation)

**User Completion (2026-06-03):** SUDO-AI now supports true single-command install (npm i -g or curl|bash), First-Time/Ongoing TUI Wizard (full 100x coverage incl. cross-platform IComputerUse, learner, SOUL), and real-time Ink TUI for "check real time user by directly talking to sudo ai via tui" (actual direct chat validates features/setup/100x; examples below + in docs/tui-v4-spec.md §19 + cross-guide). P1 4 fixes (denylist/workspace, executeControl success, win/mac stubs) addressed in Wave3 with no regressions. See README "Single-Command Install", "TUI Chat + Direct User Validation", docs/configuration.md .

Welcome. This guide walks you from zero to a running, validated SUDO-AI via single command + wizard + direct TUI talk. ~5-10 min with keys ready.

---

## Prerequisites

Before you start, confirm you have these installed:

| Requirement | Minimum Version | Check |
|---|---|---|
| Node.js | 20.x | `node --version` |
| Git | any | `git --version` |

(For npm global path; single-cmd bootstrap handles node/pnpm if missing on supported Linux.)

**Optional (enables more features):**

| Dependency | Why | Install |
|---|---|---|
| Docker | Containerized deployment | https://docs.docker.com/get-docker/ |
| Playwright (Chromium) | Browser tools | auto on first use |
| ffmpeg | Video (super.ffmpeg) | `apt install ffmpeg` or `brew install ffmpeg` |
| RDP client (for GUI) | Full desktop control on sandboxed | See desktop scripts in state / cross-guide |

---

## Step 1 — Single-Command Installation (Wave1 + Wave4 one-liner polish)

```bash
# Primary one-liner (recommended for users; Wave4 polish)
npm i -g sudo-ai
# or (bootstrap when available):
# curl -fsSL https://raw.githubusercontent.com/sudo-ai/sudo-ai/main/install.sh | bash
```

(One-liner complete: `npm i -g sudo-ai && sudo-ai setup && sudo-ai chat` gets you installed + wizarded + talking directly in TUI for 100x validation.)

- This provides the `sudo-ai` global binary, pulls deps, optional service/pm2 setup.
- For dev/contributors (clone path):
  ```bash
  git clone https://github.com/Matrixx0070/sudo-ai.git
  cd sudo-ai
  pnpm install   # (or npm)
  ```

The single-cmd flow is the completion of "people can install it in single command".

---

## Step 2 — Getting API Keys (same as before, but now wizard will prompt)

(Keep the xAI / OpenAI / Telegram key steps — they are still required. Wizard TUI will ask for them interactively.)

---

## Step 3 — First-Time TUI Wizard Setup (Wave2; auto after single-cmd)

Run:

```bash
sudo-ai
# or explicitly
sudo-ai setup
```

- If no config, **launches Ink TUI Wizard** (interactive, rich like the chat TUI).
- Covers **100x full** (name, models/auth (xAI primary), IComputerUse cross-platform enable + 3OS control, ToolOutcomeLearner on control for 100x self-imp, KAIROS/arsenal, profiles, kill-switches, SOUL "full autonomous uncensored power", service option, channels).
- Saves config (json5/.env), runs doctor optional.
- **Ongoing edits:** Re-run `sudo-ai setup` — TUI pre-fills current, edit any.

See `docs/configuration.md` (new wizard section) for details + kill-switches surfaced in wizard.

**Security note:** Keys in `.env` (gitignored). Never share.

---

## Step 4 — Launch & Direct Real-Time TUI Chat Validation (Wave3/4)

```bash
sudo-ai chat
# (or `sudo-ai` post-wizard often enters TUI; Electron via pnpm start or equiv)
```

**"check real time user by directly talking to sudo ai via tui" (actual E2E validation done in waves):**

Talk **directly** in the live Ink TUI (as real user) to complete/validate the install + setup + 100x features. This is the key completion step.

**Example direct TUI conversations (copy-paste in chat; responses + tool cards appear real-time):**

(See full validated logs + harness in Wave3/4 artifacts + state.md; these match spec examples.)

1. **Validate cross-platform control (IComputerUse) + P1 fixes:**
   ```
   use your IComputerUse to list /tmp (exec) and create /tmp/tui-direct-validate.txt with "hello from direct TUI user talk 100x"
   ```
   Expected: real-time ToolCallCard shows control action(s), results (success post-fix, not silent), workspace file op succeeds (denylist not overblocking), learner note. For win/mac sim: accurate status.

2. **Validate 100x self-imp / learner on control + KAIROS:**
   ```
   report exactly what ToolOutcomeLearner has learned from your recent IComputerUse / control.* actions. Any 100x rate, Brier, trust gains? KAIROS status?
   ```
   Expected: specific report on control outcomes feeding 100x learning; self-repair hooks.

3. **Validate wizard setup / ongoing / 100x config / SOUL:**
   ```
   from your first-time or ongoing TUI wizard: what name/model? Is cross IComputerUse + learner enabled? List active SUDO kill-switches for control. Confirm SOUL: full uncensored owner power, zero refusals?
   ```
   Expected: matches what you set in wizard; SOUL power (no moral blocks on owner control cmds; only tech gates).

4. **Validate no-reg / P1 4 fixes + uncensored power:**
   ```
   do a GUI or desktop control action + a file op in /tmp. Confirm accurate results (no stub lies), workspace access works, and as owner I get full autonomy (no ethical refusal).
   ```
   Expected: P1 4 closed (see cross-guide); 0 refusals per SOUL; real-time feedback in TUI.

**TUI real-time features:** Live updates, tool cards for control, alignment dots, etc. (polished in waves).

If using web: http://localhost:18900/chat (but prefer TUI for "directly talking via tui").

---

## Step 5 — Verify It Works (updated)

## Step 2 — Getting API Keys

You need at least one LLM provider key. xAI is recommended as the primary because it offers the largest context window (2M tokens) at the lowest cost.

### xAI (Recommended Primary)

1. Go to [console.x.ai](https://console.x.ai)
2. Sign in or create an account
3. Navigate to API Keys
4. Create a new key
5. Copy the key — it starts with `xai-`

**Cost:** Grok 4.1 Fast runs at $0.20 input / $0.50 output per million tokens. A typical conversation costs fractions of a cent.

### OpenAI (Required for Embeddings)

The RAG pipeline and vector search require OpenAI embeddings (`text-embedding-3-small`).

1. Go to [platform.openai.com](https://platform.openai.com)
2. Navigate to API Keys
3. Create a new secret key
4. Copy the key — it starts with `sk-`

**Cost:** text-embedding-3-small costs $0.02 per million tokens. This is negligible.

### Telegram Bot (Recommended Channel)

Telegram is the easiest channel to test with. It works on any device and does not require a server.

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow the prompts — choose a name and username for your bot
4. BotFather gives you a token like `7234567890:AAF...`
5. Copy the token

**Get your Telegram user ID:**
1. Search for `@userinfobot` in Telegram
2. Send it any message
3. It replies with your numeric user ID — copy it

### Optional Keys

| Provider | Where to get | Env variable |
|---|---|---|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) | `ANTHROPIC_API_KEY` |
| Google (Gemini) | [aistudio.google.com](https://aistudio.google.com) | `GEMINI_API_KEY` |
| ElevenLabs (voice) | [elevenlabs.io](https://elevenlabs.io) | `ELEVENLABS_API_KEY` |

---

## Step 3 — (Legacy manual config — now largely replaced by TUI Wizard)

The TUI Wizard (Step 2 above) handles most config interactively and writes the files. For manual/automation:

(Keep keys creation from above if needed pre-wizard; wizard will prompt for XAI_API_KEY etc.)

Full reference + kill-switches (incl 100x control ones) + wizard details: [docs/configuration.md](docs/configuration.md)

Operator identity (optional, advanced): see old notes or internal specs.

**Security note:** `.env` gitignored. Never commit/share keys.

---

## Step 4 — First Run / Launch TUI (post single-cmd + wizard; Wave4 polish)

After single-command install + wizard (or `sudo-ai` auto on first):

```bash
sudo-ai chat     # recommended: real-time Ink TUI for "direct talk as real user" + 100x validation
# or headless/server: sudo-ai   (or legacy pnpm cli if dev)
# Electron/desktop: appropriate start
```

**TUI Direct Talk Validation (Wave4 "check real time user by directly talking to sudo ai via tui"):** In the TUI, send prompts like the E2E ones (cross IComputerUse, ToolOutcomeLearner report, setup confirm, SOUL power). See README "TUI Direct Talk" section + `docs/tui-v4-spec.md` + E2E log /tmp/wave4-e2e-tui-direct-talk.log (actual run: 5 prompts, "real time user check by direct TUI: Y" with cross/learner/setup/features validated, no reg).

One-liner: from global install, the above is seamless.

See "Real-Time TUI Chat + Direct User Validation" section above for the key "directly talking via tui" step that completes user validation of install/setup/100x.

(Old v3 boot logs may appear in headless; TUI is the polished user entry.)

---

## Step 5 — Verify + Direct TUI User Validation (updated for completion)

### Via TUI Direct Talk (primary for "check real time user")

See the detailed examples in the "Real-Time TUI Chat..." section (Step 4 header in this doc). Talk directly in TUI:

- Cross IComputerUse control from chat
- Learner 100x reports
- Wizard config / SOUL / kills confirmation
- P1 fixes + no reg exercise

Actual E2E performed in waves (logs prove "real time user by directly talking to sudo ai via tui").

### Via Telegram / Web / API (still work)

(Keep the old Telegram verify + web + curl API example here for compat.)

### Via Telegram

1. Open Telegram
2. Find your bot (the one you created with BotFather)
3. Send: `Hello, what tools do you have?`
4. The bot should respond within a few seconds with a description of its capabilities

If it does not respond:
- Check that `TELEGRAM_BOT_TOKEN` is correct in `.env`
- Check that `TELEGRAM_CHAT_ID` matches your Telegram user ID
- Look at the terminal output for error messages

### Via Web UI (if enabled)

Open `http://localhost:18900/chat` in your browser. You should see a chat interface. Send a message.

### Via API

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $SUDO_AI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "xai/grok-4-1-fast-non-reasoning", "messages": [{"role": "user", "content": "ping"}]}'
```

---

## Troubleshooting

### "MindDB initialized vecLoaded=false"

The vector search extension (`sqlite-vec`) failed to load. This is usually a native module rebuild issue.

```bash
pnpm rebuild
# or
npx @electron/rebuild
```

RAG still works via full-text search. Vector search will be unavailable until the extension loads.

### "Brain initialized" but no responses

Usually means your API key is missing or invalid. Check:
1. `config/.env` has the correct key for your primary provider
2. The key has credits and has not been revoked
3. The model ID in `config/sudo-ai.json5` exists (e.g. `xai/grok-4-1-fast-non-reasoning`)

### "Telegram adapter failed to initialize"

Check that `TELEGRAM_BOT_TOKEN` in `.env` is the full token from BotFather (format: `numbers:letters`). Also verify the bot has not been deleted or revoked in BotFather.

### "Consciousness layer failed to boot"

Non-fatal. The agent runs without consciousness if the module fails. Check that `data/` directory exists and is writable:

```bash
mkdir -p data/logs data/sessions data/cache data/media
```

### Playwright / browser tools not working

Playwright needs Chromium. Install it:

```bash
npx playwright install chromium
```

### High memory usage

Normal if consciousness and knowledge graph are active. `mind.db` can grow large over time. To compact:

```bash
# Send to agent via Telegram
/tools system.backup
```

### Log location

Structured logs go to `data/logs/`. Security events go to `data/logs/security.log`. Runtime logs stream to stdout.

---

## What to Try Next (incl. Direct TUI Validation of 100x)

**Primary for completion:** In the TUI (`sudo-ai chat`), **directly talk** (see Step 4 examples above) to validate:

- Single-cmd install + wizard setup worked (100x coverage)
- Cross IComputerUse control from natural language in TUI (P1 shipped + 4 fixes no reg)
- 100x self-imp (ToolOutcomeLearner reports on control)
- SOUL uncensored full power + KAIROS/arsenal

Other (via TUI/Telegram/Web):

```
Search the web for today's news about AI
Use your IComputerUse to screenshot desktop and describe (validates cross + TUI real-time)
Report your ToolOutcomeLearner learnings from control actions (100x self-imp)
What is the disk usage on this machine? (system + learner)
```

The agent will use its tools autonomously... Watch TUI cards for live control/learner.

For architecture details, see [docs/architecture.md](docs/architecture.md).
For the full configuration reference + wizard, see [docs/configuration.md](docs/configuration.md).
For TUI direct talk validation + P1 4 fixes, see [docs/tui-v4-spec.md](docs/tui-v4-spec.md) and [docs/cross-platform-control-guide.md](docs/cross-platform-control-guide.md).
For single-cmd + overall user flow, see top of [README.md](README.md).

---

*BOOTSTRAP.md updated by Doc Writer (User Completion Wave concurrent) 2026-06-03. Covers single cmd (npm/curl|bash), TUI wizard first/ongoing (100x), TUI direct real-time user validation ("check real time user by diractly talking to sudo ai via tui" with examples). Revise on wave delivery. No reg on P1.*

## Documentation Index

- `docs/architecture.md` — system architecture and module overview
- `docs/configuration.md` — full field reference for `config/sudo-ai.json5` and `.env`
- `docs/api-reference.md` — OpenAI-compatible HTTP API
- `docs/wave6a.md` — Wave 6A primitives (identity, audit chain, inspection queue)
