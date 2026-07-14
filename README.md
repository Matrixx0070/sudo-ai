# SUDO-AI

[![CI](https://github.com/Matrixx0070/sudo-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/Matrixx0070/sudo-ai/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-4.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Docker%20%7C%20CLI-success)

> CI runs lint, build, the full test suite, and the LLM gateway conformance golden matrix (`tests/conformance`) on every push and PR.

**SUDO-AI is a persistent, self-hosted autonomous agent platform.** It runs continuously on a machine you control, remembers across sessions, connects to any major LLM provider with automatic failover, and can browse the web, write and run code, manage files and processes, send messages, and operate your system — all under your control, with sandboxing, approval tiers, kill-switches, and audit logging as safety controls.

It is built for power users who want a capable, owner-operated agent on their own infrastructure rather than a hosted chatbot.

> **Scope & responsibility.** SUDO-AI can run with full system privileges. It is designed for a single trusted owner on their own machine. You are responsible for how you configure and use it — review the approval tiers, sandbox, and kill-switches before granting broad permissions, and only enable integrations you're authorized to use.

---

## Highlights

- **Multi-LLM brain** with automatic failover across 6 providers and an OpenAI-compatible API.
- **Persistent memory** across restarts: SQLite-backed stores with hybrid vector + full-text search.
- **Continuous "consciousness" layer** of background cognitive modules (episodic/procedural/semantic memory, self-model, drives, emotional state, and more).
- **200+ tools** across coder, browser, system, and comms categories, plus MCP server support.
- **9 messaging channels** (Telegram built-in; Discord, Slack, Signal, Matrix, IRC, Email, SMS, Web, and an opt-in WhatsApp adapter).
- **Multi-agent orchestration**: role-based sub-agents and a swarm decomposer.
- **Self-improvement loop**: records tool outcomes and learns model/tool policies from execution traces.
- **Security stack**: prompt-injection scanning, a Linux `bwrap` sandbox, an encrypted credential vault, an approval matrix, and audit logs.

> SUDO-AI is under active development. Some advanced subsystems are experimental or opt-in (noted below). Cross-platform system control is fully implemented on **Linux**; Windows and macOS backends are **experimental**.

---

## Quick start

### Install (global CLI)

```bash
npm i -g @matrixx0070/sudo-ai
sudo-ai quickstart  # interactive first-run wizard (providers, channels, options)
sudo-ai chat      # talk to the agent in a terminal UI
```

The CLI is installed as `sudo-ai`. On macOS, see [docs/INSTALL-macos.md](docs/INSTALL-macos.md) for the Mac-specific install path and sandbox notes. Check health with:

```bash
curl http://127.0.0.1:18900/health   # expect 200 OK
sudo-ai doctor                       # environment / config checks
sudo-ai status                       # running service status
```

### From source (contributors)

```bash
git clone https://github.com/Matrixx0070/sudo-ai.git
cd sudo-ai
pnpm install
pnpm build
pnpm start        # or: pnpm cli  (headless from source)
```

### Minimal `.env`

Copy `config/.env.example` to `config/.env` and set at least one provider plus a channel:

```bash
XAI_API_KEY=your-xai-key
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-telegram-user-id
```

See [docs/configuration.md](docs/configuration.md) for the full field reference.

---

## Features

### Brain — multi-LLM with automatic failover

- **6 providers:** xAI (Grok), OpenAI, Anthropic (Claude), Google (Gemini), Groq, Ollama.
- **Primary model pool:** an ordered list with automatic failover on error, rate-limit, or billing failure.
- **Tiered cooldowns:** transient errors back off (1 min → 1 hr); billing errors back off longer (5 hr → 24 hr).
- **Optional consensus mode:** cross-checks an answer across multiple models (Jaccard similarity).
- **Cost tracking:** per-call token usage and estimated USD cost logged to `mind.db`.
- **Personas and moods:** configurable personality modes and temperature modifiers.
- **OpenAI-compatible API:** mounted on the unified gateway at `/v1/*`.

### Consciousness — continuous background modules

A layer of cognitive modules runs between and during sessions, persisting to `data/consciousness.db`:

| Module | Function |
|---|---|
| Cognitive Stream | Background inner monologue (micro / medium / deep cadence) |
| Episodic Memory | What happened, when, and with whom; consolidated over time |
| Procedural Memory | Compiles repeated tool sequences into reusable procedures |
| Semantic Memory | World knowledge and domain facts |
| Self-Model | Capability self-assessment |
| Drive System | Intrinsic motivations: curiosity, mastery, autonomy, connection |
| Theory of Mind | Per-user trait modeling |
| Emotional State | Valence/affect signals arising from experience |
| Attention & Spreading-Activation | Focus allocation and concept association |
| Temporal-Self | Past / present / future self snapshots |

Several modules (e.g. procedural learning, world-model prediction, semantic consolidation, sleep-cycle consolidation) are **opt-in via environment flags** so you can enable only what you want. See [docs/configuration.md](docs/configuration.md).

### Tools — 200+ capabilities

- **Coder:** read/write/edit files, glob, grep, git, npm, project scaffold, code review, test runner, debugger.
- **Browser:** search, navigate, scrape, screenshot, interact, form-fill, downloads, vision.
- **System:** exec/shell, process, service, docker, cron, disk, network, ssh, backup, credential manager.
- **Comms:** email, Slack, SMS, Discord, Telegram, webhook.
- **MCP:** connect external [Model Context Protocol](https://modelcontextprotocol.io) servers as tool sources.

System and shell tools run through an **approval matrix** (auto / notify / confirm / never tiers) and, on Linux, an optional `bwrap` sandbox.

### Channels — connect from anywhere

| Channel | Status | Notes |
|---|---|---|
| Telegram | Built-in | Bot API via grammy, slash commands |
| Web | Built-in | HTTP + WebSocket on the gateway port (`/chat`) |
| Discord | Available | Enable with `DISCORD_TOKEN` |
| Slack | Available | Enable with `SLACK_BOT_TOKEN` |
| Signal | Available | via `signal-cli` |
| Matrix | Available | HTTP long-polling |
| IRC | Available | raw TCP |
| Email | Available | IMAP + SMTP |
| SMS | Available | Twilio |
| WhatsApp | Opt-in | Uses Baileys (unofficial WhatsApp Web). **Against WhatsApp ToS** — disabled unless you set `SUDO_WHATSAPP_ENABLE=1`. Use at your own risk. |

### Knowledge — retrieval pipeline

- **Hybrid retrieval:** vector search (SQLite + optional `sqlite-vec`, 1536-dim embeddings) blended with full-text BM25, plus temporal decay and MMR re-ranking. Degrades gracefully to BM25 when embeddings are unavailable.
- **Content-addressed chunks** with SHA-256 deduplication.
- **Knowledge graph** in `data/knowledge.db`.

### Multi-agent — orchestration

- **Role-based sub-agents** (architect, coder, researcher, reviewer, debugger, tester, and more).
- **Task decomposition** into parallel sub-tasks via a swarm orchestrator.
- **Kanban queue** (SQLite-backed) with a periodic dispatcher, stale-task reclaim, and dependency promotion.
- **`system.spawn-agent`** creates isolated sub-agents on demand (bounded concurrency).

### Self-improvement

- **ToolOutcomeLearner** records the outcome of every tool call and feeds several learning sinks (failure analysis, improvement loop, skill discovery, trust-tier tracking, confidence calibration).
- **Trace-driven policy** learns preferred model/tool combinations from execution history.
- Confidence calibration is tracked with Brier scoring.

### Security — defense in depth

- **Prompt-injection scanning** on memory writes (multi-pattern detection; configurable strict/sanitize/off modes).
- **Dangerous-action blocking** for destructive exec patterns and cloud-metadata endpoints.
- **Sandbox:** Linux `bwrap` process isolation with a secret-env denylist and sensitive-path denylist.
- **Credential vault:** AES-256-GCM at rest (PBKDF2), with masked-on-store / plaintext-only-on-get handling.
- **Approval matrix + kill-switches:** per-tool tiers and `SUDO_*_DISABLE=1` env flags to turn subsystems off.
- **Audit logging** of security events.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the security model.

### Scheduled tasks — built-in cron

- Standard cron expressions plus interval and one-shot jobs.
- Each job runs as an isolated agent turn with its own session.
- A watchdog runs periodic health checks; job health is logged to `mind.db`.

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
                (multi-LLM,         (200+ tools,
                 failover)           MCP adapter)
                    └─────────┬─────────┘
                           AgentLoop
                     (gated ReACT loop)
                              |
              ┌───────────────┼───────────────┐
           Channels      Consciousness    Knowledge
          (Telegram,    (background        (hybrid RAG
           Web, ...)     modules)           + graph)
              |
         MessageRouter
              |
         User / Operator
```

**Message flow:** user message → channel adapter → MessageRouter → AgentLoop → Brain (LLM call) → tool execution (looped) → response assembled → channel adapter → user.

**Memory flow:** every turn writes to `mind.db`; session end triggers consciousness consolidation.

---

## Configuration

| File | Purpose |
|---|---|
| `config/.env` | API keys and secrets (never committed) |
| `config/sudo-ai.json5` | Runtime configuration (safe to commit without keys) |

See [docs/configuration.md](docs/configuration.md) for the full reference and the list of `SUDO_*` feature flags.

---

## CLI commands

| Command | Description |
|---|---|
| `sudo-ai` | Start (runs the setup wizard on first run, otherwise the TUI) |
| `sudo-ai chat` | Launch the real-time terminal UI |
| `sudo-ai quickstart` | First-time / ongoing configuration wizard |
| `sudo-ai status` / `doctor` / `init` / `config` | Service health, environment checks, init, edit |
| `sudo-ai start` / `stop` | Manage the background service |
| `pnpm cli` | Headless run from source (dev) |
| `pnpm build` / `test` / `lint` | Build, run tests (vitest), type-check (tsc) |

**Telegram slash commands:** `/status`, `/tools`, `/cost`, `/reset`, and more.

---

## API

SUDO-AI runs a unified gateway (default port `18900`) serving the web UI, a WebSocket interface, and an OpenAI-compatible HTTP API:

```bash
# Chat completion
curl -X POST http://localhost:18900/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "xai/grok-4-fast-non-reasoning",
    "messages": [{"role": "user", "content": "What files are in /tmp?"}]
  }'

# List models
curl http://localhost:18900/v1/models -H "Authorization: Bearer $GATEWAY_TOKEN"
```

Set `GATEWAY_PORT` in `config/.env` to change the port. See [docs/api-reference.md](docs/api-reference.md).

---

## Docker

```bash
docker compose up -d        # start
docker compose logs -f sudo-ai
docker compose down         # stop
```

The container runs headless. Mount `./config` and `./data` as volumes to persist configuration and memory.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code standards, and the pull-request process.

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature`.
3. Run `pnpm lint` and `pnpm test` before submitting.
4. Open a pull request describing what changed and why.

---

## License

MIT — see [LICENSE](LICENSE).
