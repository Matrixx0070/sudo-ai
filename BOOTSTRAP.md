# BOOTSTRAP.md — First-Run Guide

Welcome. This guide walks you from a fresh clone to a running SUDO-AI instance. It takes about 15 minutes if you already have API keys, longer if you need to create them.

---

## Prerequisites

Before you start, confirm you have these installed:

| Requirement | Minimum Version | Check |
|---|---|---|
| Node.js | 20.x | `node --version` |
| pnpm | 8.x | `pnpm --version` |
| Git | any | `git --version` |

**Optional (enables more features):**

| Dependency | Why | Install |
|---|---|---|
| Docker | Containerized deployment | https://docs.docker.com/get-docker/ |
| Playwright (Chromium) | Browser tools (search, scrape, screenshot) | auto-installed on first use |
| ffmpeg | Video/audio manipulation (super.ffmpeg tool) | `apt install ffmpeg` or `brew install ffmpeg` |

---

## Step 1 — Installation

```bash
# Clone the repository
git clone https://github.com/sudo-ai/sudo-ai.git
cd sudo-ai

# Install all dependencies
pnpm install
```

The install pulls about 400MB of dependencies including Electron, Playwright, and all LLM SDKs. This is normal.

---

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

## Step 3 — Configuration

### Create the environment file

```bash
cp config/.env.example config/.env
```

Open `config/.env` in any text editor and fill in your keys:

```bash
# Required — at least one LLM provider
XAI_API_KEY=xai-your-key-here
OPENAI_API_KEY=sk-your-key-here

# Required if using Telegram
TELEGRAM_BOT_TOKEN=7234567890:AAF-your-token-here
TELEGRAM_CHAT_ID=123456789

# Optional providers
ANTHROPIC_API_KEY=sk-ant-your-key-here
GEMINI_API_KEY=AIza-your-key-here

# API server (OpenAI-compatible endpoint)
API_PORT=3000
SUDO_AI_API_TOKEN=choose-a-secret-token

# Web chat (optional) — served at http://localhost:18900/chat (no separate port needed)
WEB_CHAT_ENABLED=true
```

**Security note:** `config/.env` is listed in `.gitignore`. Never commit it. Never share it. Your API keys are the only thing standing between your account and unauthorized charges.

### Review the runtime config

`config/sudo-ai.json5` controls everything except secrets. The defaults are sensible — you only need to change things if you want to:

- Use a different primary model (edit `models.primary[0].id`)
- Enable Discord or WhatsApp (set `channels.discord.enabled: true` and add your bot token)
- Add scheduled cron jobs (add entries to `cron.jobs`)
- Change the agent's timezone (edit `meta.timezone`)

The full field reference is in [docs/configuration.md](docs/configuration.md).

### Step — Operator identity config (Wave 6A, optional)

Wave 6A adds an identity anchor that lets the operator describe the agent's role, values, and tool restrictions in plain config files. These files are **optional** — if absent, the system boots normally with all identity fields set to `null`.

To create them from the provided templates:

```bash
cp config/core-identity.md.example       config/core-identity.md
cp config/values.json.example            config/values.json
cp config/hard-prohibitions.yaml.example config/hard-prohibitions.yaml
```

Then edit each file:

- `config/core-identity.md` — free text describing the operator's intended use case and identity context.
- `config/values.json` — a flat or nested JSON object of operator-defined key/value settings.
- `config/hard-prohibitions.yaml` — a YAML list of tool names that trigger an advisory log entry when called.

The loader validates only file structure (valid JSON, valid YAML, non-empty text). Content is never interpreted or enforced by the system — policy decisions are the operator's responsibility.

---

## Step 4 — First Run

Run in headless CLI mode (no Electron window, logs to terminal):

```bash
pnpm cli
```

You should see output like this:

```
[cli] SUDO-AI v3 boot sequence starting
[config] Config loaded name=SUDO-AI tz=UTC
[mind-db] MindDB initialized vecLoaded=true
[brain] Brain initialized
[security] SecurityGuard initialized ownerCount=1
[rag] RAG engine attached to brain
[knowledge] Knowledge Graph + Zettelkasten initialized
[tool-registry] ToolRegistry initialized with all tools toolCount=61
[agent-loop] AgentLoop initialized maxIterations=32
[consciousness] Consciousness layer booted
[telegram] TelegramAdapter started
[api-server] OpenAI-compatible API server started port=3000
[cron] CronScheduler started
[heartbeat] HeartbeatRunner started
[cli] SUDO-AI v3 is online
```

If you see `SUDO-AI v3 is online` — it is running.

**To run as a desktop app (Electron):**

```bash
pnpm start
```

This opens a window with the web chat UI. The system tray icon lets you keep it running in the background when the window is closed.

---

## Step 5 — Verify It Works

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

## What to Try Next

Once the agent is running, try these:

```
# Via Telegram or Web UI:

Search the web for today's news about AI
Write a Python script that fetches my public IP
Take a screenshot of https://example.com
What is the disk usage on this machine?
Create a cron job that sends me a daily summary at 9am
```

The agent will use its tools autonomously to complete each request. Watch the terminal to see which tools it calls and in what order.

For architecture details, see [docs/architecture.md](docs/architecture.md).
For the full configuration reference, see [docs/configuration.md](docs/configuration.md).

---

## Documentation Index

- `docs/architecture.md` — system architecture and module overview
- `docs/configuration.md` — full field reference for `config/sudo-ai.json5` and `.env`
- `docs/api-reference.md` — OpenAI-compatible HTTP API
- `docs/wave6a.md` — Wave 6A primitives (identity, audit chain, inspection queue)
