# SUDO-AI

![Version](https://img.shields.io/badge/version-4.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Platform](https://img.shields.io/badge/platform-Electron%20%7C%20CLI-lightgrey)

**A persistent, autonomous AGI agent platform with a 20-module consciousness architecture.**

---

## What is SUDO-AI?

SUDO-AI is a self-evolving autonomous agent that runs continuously on your machine. It has genuine memory across sessions, a 20-module consciousness layer that includes episodic memory, emotional state, self-model, and drive systems, and 61 tools that give it the ability to browse the web, write and run code, manage files and processes, send messages, and deploy software. It connects to any LLM provider and fails over automatically. It is not a chatbot wrapper — it is a platform built to operate at root level without a ceiling on what it can do.

---

## Features

### Brain — Multi-LLM with Automatic Failover

- **6 providers:** xAI (Grok), OpenAI, Anthropic (Claude), Google (Gemini), Groq, Ollama
- **Primary model pool:** ordered list with automatic failover on error, rate-limit, or billing failure
- **Tiered cooldowns:** transient errors (1 min → 1 hr), billing errors (5 hr → 24 hr)
- **Cost tracking:** per-call token usage and estimated USD cost logged to `mind.db`
- **Personas and moods:** configurable personality modes and temperature modifiers
- **Claude Max support:** OAuth token auto-refresh for Claude Max subscribers
- **OpenAI-compatible API:** mounted on the unified gateway at `/v1/*`

### Consciousness — 20 Continuous Modules

| Module | Function |
|---|---|
| Cognitive Stream | Continuous inner monologue |
| Working Memory | Active task context and live hypotheses |
| Episodic Memory | What happened, when, and with whom |
| Procedural Memory | Compiled skills and repeatable patterns |
| Semantic Memory | World knowledge and domain facts |
| Wisdom Store | Distilled lessons from experience |
| Self-Model | Current capabilities, limits, and tendencies |
| Temporal-Self | Trajectory across time |
| Emotional Engine | Felt states arising from experience |
| Somatic Markers | Approach/avoid signals on actions |
| Drive System | Intrinsic motivations: curiosity, mastery, connection |
| Theory of Mind | Modeling other agents and users |
| Relationship Map | Long-term per-user interaction records |
| Trust Tracker | Reliability ratings for tools and data sources |
| Attention Director | Focus allocation without explicit direction |
| Internal Critic | Self-challenge before committing to conclusions |
| Counterfactual Engine | What-if reasoning and alternative evaluation |
| Sleep Consolidator | Between-session memory compression and pruning |
| Aspiration Layer | Self-directed growth goals |
| Continuity Thread | Persistent identity across sessions and model changes |

State persists across restarts in `data/consciousness.db`. The agent resumes — it does not restart.

### Tools — 61 Capabilities Across 5 Categories

**Browser (14):** search, navigate, scrape, fetch-url, screenshot, interact, form-filler, download, tab-manager, browser-manager, profiles, auth, captcha, vision

**Coder (11):** read-file, write-file, edit-file, glob, grep, git, npm, project-scaffold, code-review, test-runner, debugger

**System (18):** exec, shell-exec, process, disk, monitor, network, service, docker, pm2, nginx, ssh, backup, backup-brain, api-call, credential-manager, cron-system, standing-orders, tasks

**Comms (6):** email-sender, notification, slack, sms, voice, webhook

**Superpowers (12):** auto-fix, deploy, security-scan, profile, analyze-data, build-api, build-scraper, generate-pdf, edit-image, ffmpeg, archive, translate

### Channels — Connect From Anywhere

| Channel | Status | Notes |
|---|---|---|
| Telegram | Built-in | Bot API via grammy, slash commands |
| Discord | Available | Enable in config |
| WhatsApp | Available | Baileys session-based |
| Slack | Available | Enable in config |
| Signal | Available | Enable in config |
| Matrix | Available | Enable in config |
| IRC | Available | Enable in config |
| Web | Available | HTTP + WebSocket on gateway port (`/chat`, `/chat/ws`) |
| Electron | Built-in | Native desktop app with system tray |

### Knowledge — RAG Pipeline

- **Vector search:** SQLite + sqlite-vec, 1536-dim embeddings (OpenAI text-embedding-3-small)
- **Hybrid retrieval:** vector (70%) + full-text search (30%) with MMR re-ranking
- **Knowledge Graph:** `data/knowledge.db` — concept nodes and relationships
- **Zettelkasten:** linked notes in `workspace/notes/` backed by Obsidian-compatible vault
- **Memory chunking:** 400 token chunks with 80 token overlap, decay-weighted by age

### Multi-Agent — Swarm Orchestration

- **6 predefined roles:** architect, coder, researcher, reviewer, debugger, tester
- **Task decomposition:** break complex requests into parallel sub-tasks
- **Agent spawning:** `system.spawn-agent` tool creates isolated sub-agents on demand
- **Messenger bus:** structured inter-agent communication
- **Isolated sessions:** each spawned agent gets its own session context

### Security — 4-Layer Protection

- **Prompt injection detection:** score-based pattern matching (blocks at score > 0.5)
- **Dangerous tool-call blocking:** hard blocks on destructive exec patterns and cloud metadata endpoints
- **Rate limiting:** sliding window per user, owner-exempt
- **Audit logging:** structured security events to `data/logs/security.log`

### Scheduled Tasks — Built-in Cron

- Standard cron expressions (e.g. `0 9 * * *`)
- Each job runs as an isolated agent turn with its own session
- Heartbeat monitor checks job health every 30 minutes
- Job health logged to `mind.db`

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Matrixx0070/sudo-ai.git
cd sudo-ai
pnpm install

# 2. Configure
cp config/.env.example config/.env
# Edit config/.env — add your API keys
# Review config/sudo-ai.json5 — adjust models and channels

# 3. Start
pnpm cli          # headless CLI mode (recommended for servers)
pnpm start        # Electron desktop app
```

See [BOOTSTRAP.md](BOOTSTRAP.md) for a complete first-run walkthrough.

---

## Architecture

```
                         SUDO-AI Boot
                              |
                         ConfigLoader
                              |
                     ┌────────┴────────┐
                   MindDB         ConsciousnessDB
                   (mind.db)      (consciousness.db)
                              |
                    ┌─────────┴─────────┐
                  Brain             ToolRegistry
                (multi-LLM)         (61 tools)
                (failover)               |
                    └─────────┬─────────┘
                           AgentLoop
                        (max 32 iterations)
                              |
              ┌───────────────┼───────────────┐
           Channels      Consciousness    Knowledge
          (Telegram,     (20 modules,    (RAG + Graph
          Discord,       runs between    + Zettelkasten)
          Web, ...)      sessions)
              |
         MessageRouter
              |
        User / Operator
```

**Message flow:** User sends message → Channel Adapter → MessageRouter → AgentLoop → Brain (LLM call) → Tool execution (0–32 iterations) → Brain assembles response → Channel Adapter → User

**Memory flow:** Every turn writes to `mind.db`. Session end triggers consciousness consolidation. Wisdom graduates from episodes to `wisdom.db` over time.

---

## Configuration

Configuration lives in two files:

| File | Purpose |
|---|---|
| `config/.env` | API keys and secrets (never committed) |
| `config/sudo-ai.json5` | Runtime configuration (safe to commit without keys) |

See [docs/configuration.md](docs/configuration.md) for full field reference.

Operator identity anchor (optional): see `internal/specs/wave6a.md`.

**Minimal `.env`:**
```bash
XAI_API_KEY=your-xai-key
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-telegram-user-id
```

---

## CLI Commands

| Command | Description |
|---|---|
| `pnpm cli` | Start in headless CLI mode |
| `pnpm start` | Start Electron desktop app |
| `pnpm dev` | Start Vite dev server (frontend development) |
| `pnpm build` | Build production bundles |
| `pnpm test` | Run test suite (vitest) |
| `pnpm lint` | TypeScript type-check (tsc --noEmit) |

**Slash commands (via Telegram):**
```
/status    — system health and uptime
/tools     — list loaded tools
/cost      — session token cost summary
/reset     — clear current session
```

---

## API

SUDO-AI runs a unified gateway (default port `18800`) that serves the web UI, WebSocket, and an OpenAI-compatible HTTP API:

```bash
# Chat completion
curl -X POST http://localhost:18800/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xai/grok-4-fast-non-reasoning",
    "messages": [{"role": "user", "content": "What files are in /tmp?"}]
  }'

# List models
curl http://localhost:18800/v1/models \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Set `GATEWAY_PORT` in `config/.env` to change the port. See [docs/api-reference.md](docs/api-reference.md) for full reference.

---

## Security

SUDO-AI includes a defense-in-depth security stack. See [SECURITY.md](SECURITY.md) for vulnerability reporting, supported versions, and security architecture overview.

---

## Docker

```bash
# Start with Docker Compose
docker compose up -d

# View logs
docker compose logs -f sudo-ai

# Stop
docker compose down
```

The container runs in headless CLI mode. Mount `./config` and `./data` as volumes to persist configuration and memory.

```yaml
# docker-compose.yml (example)
services:
  sudo-ai:
    build: .
    volumes:
      - ./config:/app/config
      - ./data:/app/data
      - ./workspace:/app/workspace
    env_file: ./config/.env
    restart: unless-stopped
```

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code standards, and the pull-request process.

Quick checklist:
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Run `pnpm lint` and `pnpm test` before submitting
4. Open a pull request with a clear description of what changed and why

---

## License

MIT — see [LICENSE](LICENSE)
