# BOOTSTRAP.md — First-Run Guide

SUDO-AI is a persistent, owner-controlled autonomous agent that runs on your machine. It connects to one or more LLM providers, keeps memory across sessions, and can use a large tool set (200+ tools) to browse the web, run code, manage files and processes, send messages, and operate the system within the privileges you grant it.

This guide takes you from zero to a running, validated install in about 5-10 minutes once you have your API keys ready.

> **Platform support:** Linux is fully supported. Windows and macOS are experimental — the non-Linux system-control backends are currently stubs.

---

## Prerequisites

| Requirement | Minimum Version | Check |
|---|---|---|
| Node.js | 20.x | `node --version` |
| Git | any | `git --version` |

**Optional (enables more features):**

| Dependency | Why | Install |
|---|---|---|
| Docker | Containerized deployment | https://docs.docker.com/get-docker/ |
| Playwright (Chromium) | Browser tools | auto on first use, or `npx playwright install chromium` |
| ffmpeg | Video tools | `apt install ffmpeg` or `brew install ffmpeg` |

---

## Step 1 — Install

```bash
npm i -g @matrixx0070/sudo-ai
```

Or use the bootstrap one-liner (when available), which also handles Node/pnpm on supported Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Matrixx0070/sudo-ai/main/install.sh | bash
```

This installs the `sudo-ai` global binary and pulls dependencies.

**For development / contributors (clone path):**

```bash
git clone https://github.com/Matrixx0070/sudo-ai.git
cd sudo-ai
pnpm install   # (or npm install)
```

---

## Step 2 — Get API Keys

You need at least one LLM provider key. xAI is recommended as the primary because it offers a large context window at low cost.

### xAI (Recommended Primary)

1. Go to [console.x.ai](https://console.x.ai)
2. Sign in or create an account
3. Navigate to API Keys and create a new key
4. Copy the key — it starts with `xai-`

**Cost:** Grok 4.1 Fast runs at $0.20 input / $0.50 output per million tokens. A typical conversation costs fractions of a cent.

### OpenAI (Required for Embeddings)

The RAG pipeline and vector search require OpenAI embeddings (`text-embedding-3-small`).

1. Go to [platform.openai.com](https://platform.openai.com)
2. Navigate to API Keys and create a new secret key
3. Copy the key — it starts with `sk-`

**Cost:** text-embedding-3-small costs $0.02 per million tokens — negligible.

### Telegram Bot (Recommended Channel)

Telegram is the easiest channel to test with. It works on any device and does not require a server.

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts (choose a name and username)
3. BotFather gives you a token like `7234567890:AAF...` — copy it

**Get your Telegram user ID:**
1. Search for `@userinfobot` in Telegram
2. Send it any message — it replies with your numeric user ID. Copy it.

### Optional Keys

| Provider | Where to get | Env variable |
|---|---|---|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com) | `ANTHROPIC_API_KEY` |
| Google (Gemini) | [aistudio.google.com](https://aistudio.google.com) | `GEMINI_API_KEY` |
| ElevenLabs (voice) | [elevenlabs.io](https://elevenlabs.io) | `ELEVENLABS_API_KEY` |

---

## Step 3 — Run the Setup Wizard

```bash
sudo-ai setup
# or simply:
sudo-ai          # launches the wizard automatically when no config exists
```

If there is no config yet, this launches an interactive Ink-based TUI wizard that covers:

- Agent name
- Models and provider auth (xAI recommended as primary)
- Cross-platform system control (IComputerUse) enable/disable
- Tool-outcome learning (self-improvement) toggle
- Background monitoring and self-repair
- Profiles and channels
- Safety controls: approval tiers and kill-switches

The wizard writes `config/sudo-ai.json5` and `config/.env`, validates the config, and can optionally run a health check.

**To edit later:** re-run `sudo-ai setup` (or `sudo-ai config --edit`). The wizard pre-fills your current values so you can update individual fields. Many `sudo-ai.json5` changes hot-reload without a restart.

See [docs/configuration.md](docs/configuration.md) for the full field reference, including the available kill-switches and approval-tier settings.

**Security note:** Keys live in `config/.env`, which is gitignored. Never commit or share it.

---

## Step 4 — Chat

```bash
sudo-ai chat
```

This launches the real-time Ink TUI for live, interactive chat. Responses and tool-call cards stream as the agent works.

To run headless (server mode with channels and the HTTP API), run `sudo-ai` after setup is complete.

**Example prompts to try:**

```
Search the web for today's news about AI
What is the disk usage on this machine?
List the files in the current directory
```

The agent uses its tools autonomously to answer. Watch the TUI cards for live tool calls and results.

---

## Step 5 — Verify It Works

### Health check

With the agent running, confirm the gateway is up:

```bash
curl http://127.0.0.1:18900/health
```

You should get an HTTP 200 response.

### Via Telegram

1. Open Telegram and find your bot (created with BotFather)
2. Send: `Hello, what tools do you have?`
3. The bot should respond within a few seconds describing its capabilities

If it does not respond:
- Check that `TELEGRAM_BOT_TOKEN` is correct in `config/.env`
- Check that `TELEGRAM_CHAT_ID` matches your Telegram user ID
- Look at the terminal output for error messages

### Via Web UI (if enabled)

Set `WEB_CHAT_ENABLED=true` in `config/.env`, then open `http://127.0.0.1:18900/chat` in your browser and send a message.

### Via API

```bash
curl -X POST http://127.0.0.1:18900/v1/chat/completions \
  -H "Authorization: Bearer $SUDO_AI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "xai/grok-4-1-fast-non-reasoning", "messages": [{"role": "user", "content": "ping"}]}'
```

---

## Where config and data live

| Path | Contents |
|---|---|
| `config/sudo-ai.json5` | Runtime settings: models, channels, tools, cron jobs |
| `config/.env` | Secrets and API keys (gitignored) |
| `data/logs/` | Structured logs (`data/logs/security.log` for security events) |
| `data/sessions/`, `data/cache/`, `data/media/` | Session state, cache, and media |
| `mind.db` | Memory, knowledge graph, and cost tracking |

---

## Key CLI Commands

| Command | What it does |
|---|---|
| `sudo-ai setup` | Run the setup wizard (first-time or edit) |
| `sudo-ai config --edit` | Re-open the wizard pre-filled with current config |
| `sudo-ai chat` | Launch the interactive TUI chat |
| `sudo-ai` | Run headless (or launch the wizard if no config exists) |

---

## Troubleshooting

### "MindDB initialized vecLoaded=false"

The vector search extension (`sqlite-vec`) failed to load — usually a native module rebuild issue.

```bash
pnpm rebuild
# or
npx @electron/rebuild
```

RAG still works via full-text search; vector search is unavailable until the extension loads.

### "Brain initialized" but no responses

Usually means your API key is missing or invalid. Check:
1. `config/.env` has the correct key for your primary provider
2. The key has credits and has not been revoked
3. The model ID in `config/sudo-ai.json5` exists (e.g. `xai/grok-4-1-fast-non-reasoning`)

### "Telegram adapter failed to initialize"

Check that `TELEGRAM_BOT_TOKEN` in `config/.env` is the full token from BotFather (format: `numbers:letters`). Verify the bot has not been deleted or revoked in BotFather.

### "Consciousness layer failed to boot"

Non-fatal. The agent runs without the consciousness layer if the module fails. Check that the `data/` directory exists and is writable:

```bash
mkdir -p data/logs data/sessions data/cache data/media
```

### Playwright / browser tools not working

Playwright needs Chromium:

```bash
npx playwright install chromium
```

### High memory usage

Normal when the consciousness layer and knowledge graph are active. `mind.db` can grow over time. To compact, send the agent:

```
/tools system.backup
```

### Log location

Structured logs go to `data/logs/`. Security events go to `data/logs/security.log`. Runtime logs stream to stdout.

---

## What to Try Next

```
Search the web for today's news about AI
What is the disk usage on this machine?
Summarize the files in this directory
Write and run a small script that prints the current time
```

The agent uses its tools autonomously to complete these tasks, running with the privileges you grant it. Safety controls — sandboxing, approval tiers, kill-switches, and audit logging — govern what it can do.

---

## Documentation Index

- [docs/architecture.md](docs/architecture.md) — system architecture and module overview
- [docs/configuration.md](docs/configuration.md) — full field reference for `config/sudo-ai.json5` and `.env`
- [docs/api-reference.md](docs/api-reference.md) — OpenAI-compatible HTTP API
- [docs/wave6a.md](docs/wave6a.md) — identity, audit chain, and inspection queue primitives
