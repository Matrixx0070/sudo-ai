# SUDO-AI v4 — Project Summary for External AI Analysis

Generated: 2026-04-30 04:25 UTC
Branch: `self-build`
Commits ahead of main: 5 (Ollama switch + 3 fixes)

---

## 1. What SUDO-AI Is

SUDO-AI is a **persistent autonomous AI agent** — not a chatbot. It runs 24/7 as a pm2-managed Node.js service, receives messages via Telegram/WebSocket/HTTP, maintains long-lived conversation sessions, executes tools (shell commands, file edits, web search, browser automation), and has a consciousness layer of continuous background modules (several opt-in) that generate autonomous thoughts on a timer.

**Core design:**
- Owner-controlled: the agent runs with the privileges you grant it and acts on the operator's behalf
- Full-power tooling guarded by safety controls (sandboxing, approval tiers, kill-switches, audit logging)
- Aims to complete delegated tasks end-to-end

**Key capabilities:**
- Multi-channel input: Telegram bot, WebSocket chat, HTTP API, CLI
- Tool execution: 200+ tools across coding, browser, system, meta, media categories
- Multi-model LLM routing with failover (currently Ollama cloud models)
- Session persistence with sliding window, compaction, forking
- Episodic memory + RAG retrieval
- Alignment monitoring (8-signal aggregator), veto gate, epistemic honesty gate
- Federation (peer-to-peer audit chain sync between instances)
- Self-build autopilot (autonomous code improvement, currently OFF)
- Security stack: sandbox (bwrap), seccomp BPF, LD_PRELOAD execve seal, taint tracking, artifact signing

---

## 2. Architecture Overview

```
User Message
    │
    ▼
[Channels] ──► TelegramAdapter / WebAdapter / HTTP API
    │
    ▼
[SessionManager] ──► getOrCreateSession(peerId, channel)
    │
    ▼
[AgentLoop] ──► brain.call() + tool execution iterations (max 500)
    │
    ▼
[Brain] ──► Multi-model failover + parallel cloud racing
    │         Vercel AI SDK generateText/streamText wrapper
    │
    ├──► [Ollama Cloud] ──► 3 models in parallel (fastest wins)
    │       kimi-k2.6:cloud, glm-5.1:cloud, deepseek-v4-pro:cloud
    ├──► [Local Fallback] ──► qwen3.5:latest (if all cloud fail)
    └──► [Claude CLI] ──► Optional fallback (Claude Max subscription)
    │
    ▼
[ToolRouter] ──► Keyword-based tool selection (max 30 tools per call)
    │
    ▼
[ToolRegistry] ──► Executes tool calls (200+ tools)
    │
    ▼
[Output] ──► Reply sent back via original channel

Background:
[Consciousness] ──► Cognitive stream (micro/medium/deep thoughts)
[Kairos] ──► Health monitoring daemon (every 5 min)
[CronScheduler] ──► Periodic jobs (heartbeat, self-build, AutoDream)
[AlignmentAggregator] ──► 8-signal scoring + veto gate
```

---

## 3. Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22, TypeScript 5, tsx (zero-config TS execution) |
| LLM SDK | Vercel AI SDK v6 (`generateText`, `streamText`, `aiTool`, `jsonSchema`) |
| Providers | Ollama (OpenAI-compatible), xAI, OpenAI, Anthropic, Google Gemini, local gateway |
| Web | Fastify HTTP server + ws WebSocket server |
| DB | SQLite (better-sqlite3) — mind.db, wisdom.db, sessions, goals |
| Process Manager | pm2 (production + staging) |
| OS | Ubuntu 22.04, Linux 6.8.0 |
| Sandbox | bwrap (bubblewrap) + seccomp BPF + LD_PRELOAD C .so |

---

## 4. Directory Structure

```
/root/sudo-ai-v4/
├── src/
│   ├── core/
│   │   ├── brain/           # LLM interface, failover, model routing
│   │   │   ├── brain.ts     # Main Brain class (parallel racing, _callSingleModel)
│   │   │   ├── providers.ts # Provider factory (createOpenAI, createXai, etc.)
│   │   │   ├── failover.ts  # ModelFailover class (cooldown, error tracking)
│   │   │   ├── system-prompt.ts # Prompt assembly (SOUL.md + IDENTITY.md + tools)
│   │   │   └── ...
│   │   ├── agent/
│   │   │   ├── loop.ts      # AgentLoop (iterations, tool execution, session mgmt)
│   │   │   ├── tool-router.ts # Keyword-based tool selection (MAX_ROUTED_TOOLS=30)
│   │   │   └── loop-helpers.ts
│   │   ├── channels/
│   │   │   ├── telegram.ts  # Telegram bot adapter (polling loop)
│   │   │   └── web.ts       # WebSocket/HTTP chat adapter
│   │   ├── consciousness/
│   │   │   ├── kairos.ts    # Health monitoring daemon
│   │   │   └── cognitive-stream/ # Autonomous thought generation
│   │   ├── tools/
│   │   │   ├── registry.ts  # ToolRegistry (200+ tools)
│   │   │   └── builtin/     # Built-in tools (coder.*, browser.*, system.*, meta.*)
│   │   ├── skills/          # Skill definitions (SKILL.md files)
│   │   ├── alignment/       # Alignment subsystem (veto, epistemic, calibration, etc.)
│   │   └── shared/          # Constants, errors, logger, types
│   ├── api/                 # HTTP routes (REST API, admin dashboard)
│   └── cli.ts               # Entry point (pm2 runs `pnpm cli`)
├── config/
│   ├── sudo-ai.json5        # Model config (primary/fallback arrays)
│   └── .env                 # API keys, tokens, URLs
├── workspace/               # Runtime workspace (SOUL.md, IDENTITY.md, HEARTBEAT.md)
├── skills/                  # Skill markdown files (agentskills.io spec)
├── data/                    # Runtime data (SQLite DBs, logs, cache, sessions)
│   ├── logs/                # pm2 logs (can grow large — 9GB+ before rotation)
│   └── cron/                # Persistent cron job store
├── tests/                   # Vitest test suite (3684+ tests)
├── ops/                     # Grafana dashboards, deployment scripts
└── scripts/
    └── relay-ws.cjs         # CLI-to-SUDO-AI WS relay for testing
```

---

## 5. Key Configuration Files

### `config/sudo-ai.json5`
```json5
{
  models: {
    primary: [
      { id: 'ollama/kimi-k2.6:cloud',   priority: 1, maxOutputTokens: 8192 },
      { id: 'ollama/glm-5.1:cloud',      priority: 2, maxOutputTokens: 8192 },
      { id: 'ollama/deepseek-v4-pro:cloud', priority: 3, maxOutputTokens: 8192 },
    ],
    fallback: { id: 'ollama/qwen3.5:latest', priority: 4, maxOutputTokens: 4096 },
  }
}
```

### `config/.env` (selected)
```
# Ollama Cloud (hosted models via local daemon)
OLLAMA_URL=http://localhost:11434/v1
OLLAMA_API_KEY=<REDACTED>

# Telegram
TELEGRAM_BOT_TOKEN=<REDACTED>
TELEGRAM_CHAT_ID=<REDACTED>

# Auth tokens
WEB_CHAT_TOKEN=<REDACTED>
GATEWAY_TOKEN=<REDACTED>
SUDO_AI_DASHBOARD_TOKEN=<REDACTED>

# Kill-switches (set to "1" to disable)
# SUDO_TOOL_EMPTY_RETRY_DISABLE=1  # disables empty-response retry
# SUDO_GROK_REFUSAL_DETECT_DISABLE=1
# SUDO_TEXT_TOOLCALL_FALLBACK_DISABLE=1
```

### `ecosystem.config.cjs`
- Prod app: `sudo-ai-v5` on port 18900
- Staging app: `sudo-ai-v5-staging` on port 18901
- Both have `SUDO_DEFAULT_MODEL`, `SUDO_FALLBACK_MODEL`, `OLLAMA_URL` in env

---

## 6. Current Model Setup (Ollama)

**How it works:**
1. Ollama daemon runs locally at `localhost:11434`
2. It proxies to Ollama Cloud for models ending in `:cloud`
3. Brain uses `Promise.allSettled()` to race 3 cloud models in parallel
4. First non-empty response wins
5. If all cloud fail → sequential fallback through local models

**Known Ollama quirks (fixed today):**
- **Empty responses with tools**: Ollama returns `finishReason: "stop"` with empty `text` when tools are attached via Vercel AI SDK `aiTool()`. Fix: retry once without tools.
- **Tool loops**: Aggressive system prompts cause Ollama to return `tool_calls` for conversational queries. Fix: softened instruction.
- **Parallel racing bug (FIXED)**: `_callSingleModel()` was using `request.model` instead of `profile.id`, causing all 3 parallel calls to hit the SAME model.

---

## 7. Recent Changes (Today's Commits)

| Commit | Message | What changed |
|--------|---------|-------------|
| `5a723b1` | fix(brain): soften tool-use instruction | Replaced aggressive "MUST call tools" with conditional guidance |
| `ea03f66` | fix(brain): profile.id must override request.model | CRITICAL: fixed parallel racing + failover to actually use different models |
| `cb642a8` | fix(ollama): empty-response retry + OLLAMA_API_KEY passthrough | Retry without tools when empty; pass API key to provider |
| `5f3ac7d` | switch to Ollama: parallel cloud racing + config | Initial Ollama migration (models, constants, config, failover) |
| `fd999c2` | fix(self-build): create session before agentLoop.run | Pre-existing orchestrator fix |

---

## 8. Known Issues & Workarounds

### Current (post-fixes)
1. **Latency**: 15-30 seconds per response because:
   - Ollama models return tool calls for conversational queries
   - Agent loop executes tools before returning text
   - Empty-response retry adds 8-15 seconds
   **Workaround**: None yet. Options: disable BASE_TOOLS for conversation, or switch back to xAI/grok.

2. **Consciousness empty responses**: Cognitive stream (micro-tier) gets empty from Ollama. Non-blocking — main brain works for user queries.

3. **Telegram session stuck**: Existing session `vxx9yjDdTtKZIQVDZVD_b` was in a 3+ hour tool loop. New messages should create fresh sessions with the fixed code.

### Fixed today
- Health-monitor CRITICAL alert spam (thresholds raised + disk-persisted cooldown)
- Parallel racing all hitting same model (profile.id fix)
- Empty responses from Ollama (tool-empty retry)
- Runaway tool loops (softened instruction)

---

## 9. Key Code Files for Analysis

If you're analyzing this codebase, start here:

| File | Purpose | Lines |
|------|---------|-------|
| `src/core/brain/brain.ts` | Main LLM interface, parallel racing, failover | 950 |
| `src/core/brain/providers.ts` | Provider factory (Ollama, xAI, OpenAI, etc.) | 318 |
| `src/core/brain/failover.ts` | Model cooldown, error tracking, cloud/local split | 334 |
| `src/core/agent/loop.ts` | Agent loop: iterations, tool calls, session mgmt | 1436 |
| `src/core/agent/tool-router.ts` | Keyword-based tool selection | 614 |
| `src/core/channels/telegram.ts` | Telegram bot adapter | 995 |
| `src/core/channels/web.ts` | WebSocket/HTTP adapter | ~400 |
| `src/core/tools/registry.ts` | Tool registration and execution | ~500 |
| `src/core/consciousness/kairos.ts` | Health monitoring daemon | ~400 |
| `src/core/alignment/` | Veto gate, epistemic, calibration, diagnostics | 15+ files |
| `src/cli.ts` | Entry point, bootstraps all modules | ~300 |

---

## 10. How to Test

```bash
# WS relay test (local)
timeout 60 node scripts/relay-ws.cjs "Your message here"

# Direct Ollama test
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6:cloud","messages":[{"role":"user","content":"hi"}]}'

# Health check
curl http://localhost:18900/health

# Admin metrics (authed)
curl -H "Authorization: Bearer $GATEWAY_TOKEN" \
  http://localhost:18900/v1/admin/metrics
```

---

## 11. Environment Variables (Relevant for Analysis)

| Variable | Value | Purpose |
|----------|-------|---------|
| `SUDO_DEFAULT_MODEL` | `ollama/kimi-k2.6:cloud` | Default model |
| `SUDO_FALLBACK_MODEL` | `ollama/qwen3.5:latest` | Fallback model |
| `OLLAMA_URL` | `http://localhost:11434/v1` | Ollama endpoint |
| `OLLAMA_API_KEY` | `<REDACTED>` | Ollama Cloud auth |
| `TELEGRAM_BOT_TOKEN` | `<REDACTED>` | Telegram bot |
| `TELEGRAM_CHAT_ID` | `8087386717` | Owner chat ID |
| `WEB_CHAT_TOKEN` | `<REDACTED>` | WS auth |
| `GATEWAY_TOKEN` | `<REDACTED>` | Admin API auth |
| `SUDO_AI_DASHBOARD_TOKEN` | `<REDACTED>` | Dashboard auth |
| `SUDO_TOOL_EMPTY_RETRY_DISABLE` | unset | Kill-switch for empty retry |
| `SUDO_GROK_REFUSAL_DETECT_DISABLE` | unset | Kill-switch for refusal detection |
| `SUDO_TEXT_TOOLCALL_FALLBACK_DISABLE` | unset | Kill-switch for text tool parsing |

---

## 12. Session Summary for External AI

SUDO-AI is a production autonomous agent (v4) running on Ubuntu/Node.js with Ollama-hosted LLMs. It was recently migrated from the local gateway to Ollama cloud models. Today's fixes resolved: (1) health-monitor alert spam, (2) all parallel model calls hitting the same model due to a `profile.id` vs `request.model` bug, (3) Ollama returning empty responses when tools are attached, (4) runaway tool loops caused by overly aggressive system prompts.

The codebase is ~25k lines of TypeScript with 3684+ tests. Key areas for any external analysis should be: `src/core/brain/brain.ts` (LLM interface), `src/core/agent/loop.ts` (agent execution), and `src/core/channels/telegram.ts` (message I/O).
