# Architecture — SUDO-AI v3

This document describes the system architecture: boot sequence, module dependencies, data flow, and database schema.

---

## Boot Sequence

The boot sequence is the same whether running in CLI mode (`pnpm cli`) or Electron mode (`pnpm start`). The Electron mode adds steps 8–10 for the desktop window and tray.

```
Step 1   ConfigLoader
         Reads config/sudo-ai.json5 (JSON5 format)
         Validates against TypeBox schema (src/core/config/schema.ts)
         Sets up file watcher for hot-reload (debounce: 300ms)

Step 2   MindDB
         Opens data/mind.db (SQLite via better-sqlite3)
         Loads sqlite-vec extension for vector search
         Runs schema migrations

Step 3   ClaudeTokenManager (optional)
         If Claude credentials exist: loads OAuth token
         Sets ANTHROPIC_AUTH_TOKEN env var for Brain
         Starts background auto-refresh

Step 4   Brain
         Initialises AI SDK providers (xAI, OpenAI, Anthropic, Google, Groq)
         Reads primary model pool from config
         Sets up ModelFailover with tiered cooldown schedules

Step 5   SecurityGuard
         Loads injection detection patterns
         Initialises rate limiter with owner-exempt list
         Opens data/logs/security.log for audit writes

Step 6   CostTracker
         Tracks token usage and estimated USD cost per session

Step 7   RAGEngine
         Connects to MindDB for vector + full-text search
         Attaches to Brain (brain.setRAGEngine)

Step 8   KnowledgeGraph + Zettelkasten
         Opens data/knowledge.db
         Connects to workspace/notes/ as Obsidian-compatible vault
         Wires to RAGEngine

Step 9   ToolRegistry
         Auto-discovers tools in src/core/tools/builtin/
         Registers superpowers from src/core/superpowers/
         Disables tools listed in config.tools.disabled

Step 10  MultiAgentOrchestrator
         Registers system.spawn-agent tool
         Enables sub-agent spawning during agent runs

Step 11  SessionManager
         Manages conversation sessions backed by MindDB

Step 12  AgentLoop
         Wraps Brain + ToolRegistry + SessionManager
         Enforces maxIterations cap (default: 32)

Step 13  ConsciousnessOrchestrator
         Boots 20 consciousness modules
         Attaches SleepCycle (memory consolidation)
         Attaches SelfEvolution (capability growth)
         Rebuilds AgentLoop with consciousness context

Step 14  Channel Adapters
         TelegramAdapter — if TELEGRAM_BOT_TOKEN is set
         WebAdapter — if WEB_CHAT_ENABLED=true (attaches to gateway :18900/chat)
         [Electron only] ElectronAdapter — always enabled

Step 15  HttpServer
         OpenAI-compatible API at port 3000 (or API_PORT)

Step 16  CronScheduler + HeartbeatRunner
         Loads scheduled jobs from config.cron.jobs
         Heartbeat checks job health every 30 minutes

[Electron only]
Step 17  BrowserWindow — loads UI from web adapter (port 3001) or file://
Step 18  TrayManager — system tray icon with start/stop/quit menu
Step 19  IPC handlers — Electron renderer <-> main process bridge
```

---

## Unified Gateway (single-port model)

All user-facing traffic — including web chat HTML, the chat WebSocket, and all admin/agent REST endpoints — is served from a single port (default 18900) by the gateway server. WebAdapter registers listeners directly on that server via `WebAdapter.attach(server)` rather than opening its own port. Chat HTML is available at `GET /chat`, the chat WebSocket at `ws://.../chat/ws`, and the existing JSON-RPC WebSocket remains at `ws://.../ws`. The `claude-proxy` on port 3003 is an internal loopback shim only (not user-facing) and is a separate concern. See `docs/gateway-unified.md` for the full endpoint reference.

---

## Module Dependency Graph

```
ConfigLoader
    |
    +-- MindDB <-----------+
    |                      |
    +-- Brain              |    ConsciousnessDB
    |    |                 |         |
    |    +-- RAGEngine ----+    ConsciousnessOrchestrator
    |    |    |                      |
    |    |    +-- KnowledgeGraph     +-- SleepCycle
    |    |    +-- Zettelkasten       +-- SelfEvolution
    |    |
    |    +-- ModelFailover
    |    +-- CostTracker
    |
    +-- SecurityGuard
    |    +-- RateLimiter
    |    +-- InjectionPatterns
    |
    +-- ToolRegistry
    |    +-- Builtin tools (49)
    |    +-- Superpowers (12)
    |    +-- MultiAgentOrchestrator
    |
    +-- SessionManager
    |    |
    |    +-- AgentLoop
    |         +-- Brain
    |         +-- ToolRegistry
    |         +-- SessionManager
    |         +-- ConsciousnessOrchestrator (optional)
    |         +-- SecurityGuard (optional)
    |
    +-- MessageRouter
         +-- TelegramAdapter
         +-- WebAdapter
         +-- ElectronAdapter (Electron only)
         +-- DiscordAdapter (if enabled)
         +-- WhatsAppAdapter (if enabled)
```

---

## Data Flow

### Incoming Message

```
User sends message
    |
    v
Channel Adapter (Telegram / Web / Electron / Discord)
    |
    v
MessageRouter.setHandler callback
    |
    v
SessionManager.getOrCreate(channel, peerId)
    |-- Creates new session if first contact
    +-- Returns existing session with message history
    |
    v
ConsciousnessOrchestrator.getConsciousnessContext()
    |-- Reads 20 module states from consciousness.db
    +-- Returns context string injected into system prompt
    |
    v
AgentLoop.run(sessionId, userMessage)
    |
    +-- Iteration loop (up to maxIterations = 32):
    |    |
    |    v
    |    Brain.call(messages)
    |    |-- Assembles system prompt (SOUL.md + persona + mood + consciousness context)
    |    |-- Calls primary LLM via AI SDK
    |    |-- Falls back to next model on error
    |    |-- Returns: content OR tool_calls
    |    |
    |    +-- If tool_calls:
    |         |
    |         v
    |         SecurityGuard.validateToolCall(toolName, args)
    |         |-- Blocks dangerous exec patterns
    |         |-- Blocks cloud metadata endpoints
    |         |-- Allows if safe
    |         |
    |         v
    |         ToolRegistry.execute(toolName, args, context)
    |         |-- Runs the tool implementation
    |         |-- Returns ToolResult {ok, output, artifacts}
    |         |
    |         v
    |         Append tool result to messages
    |         Continue loop
    |
    +-- Loop ends when: LLM returns text (no tool calls) OR maxIterations reached
    |
    v
AgentLoop returns final text response
    |
    v
Channel Adapter sends reply to user
    |
    v
SessionManager.save(session)
    |-- Writes updated message history to mind.db
```

### Session End / Consciousness Consolidation

```
Session ends (Ctrl+C / shutdown signal)
    |
    v
ConsciousnessOrchestrator.shutdown()
    |
    v
SleepCycle.consolidate()
    |-- Reads episodic memory from consciousness.db
    |-- Compresses repeated patterns
    |-- Promotes lessons to wisdom store
    |-- Prunes redundant data
    |
    v
Write module states to consciousness.db
    |
    v
Next session boot reads these states
    -- Agent resumes, not restarts
```

---

## Database Schema Overview

### mind.db (SQLite)

Primary operational database. All structured state lives here.

| Table | Purpose |
|---|---|
| `sessions` | Conversation sessions per channel+peer |
| `messages` | Per-session message history (role, content, timestamp) |
| `tasks` | Task queue: id, description, status, priority, created_at, completed_at |
| `tool_logs` | Tool execution records: tool_name, args_hash, output_preview, duration_ms |
| `cost_logs` | Token usage: provider, model, input_tokens, output_tokens, estimated_usd |
| `errors` | Runtime errors: context, input_hash, message, resolution_status |
| `skills` | Compiled skill inventory: name, version, created_at, last_used, pass_rate |
| `relationships` | Per-user relationship data: trust ratings, interaction history |
| `cron_health` | Cron job runs: job_id, ran_at, duration_ms, exit_code, error |
| `vector_index` | sqlite-vec virtual table for embedding search |

### consciousness.db (SQLite)

Consciousness module state, written at session end and read at startup.

| Table | Purpose |
|---|---|
| `body_states` | Embodied state snapshots (EmotionTag, DriveState, BodyState) |
| `thoughts` | Cognitive stream entries (ThoughtTier: surface/deep/meta) |
| `episodes` | Episodic memory records with significance scores |
| `predictions` | Prospective memory: expected future events |
| `user_models` | Theory of mind: per-user belief/goal models |
| `attention_signals` | Attention director history |
| `consolidation_log` | Sleep cycle consolidation records |

### data/knowledge.db (SQLite)

Knowledge graph for concept relationships.

| Table | Purpose |
|---|---|
| `nodes` | Concept nodes: id, label, type, properties JSON |
| `edges` | Directed relationships: source_id, target_id, relation_type, weight |
| `embeddings` | Per-node vector embeddings for semantic search |

### workspace/notes/ (Markdown files)

Zettelkasten notes in Obsidian-compatible format. Each note has YAML frontmatter with id, tags, and links. The KnowledgeGraph indexes these automatically.

---

## Plugin System

SUDO-AI's plugin model is based on three extension points:

### 1. Tool Plugins

Add a new tool by creating a file in `src/core/tools/builtin/<category>/` that exports a `ToolDefinition`:

```typescript
// src/core/tools/builtin/system/my-tool.ts
import type { ToolDefinition } from '../../types.js';

export const myTool: ToolDefinition = {
  name: 'system.my-tool',
  description: 'What this tool does',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input value' },
    },
    required: ['input'],
  },
  execute: async (args, context) => {
    // implementation
    return { ok: true, output: 'result' };
  },
};
```

The `loadBuiltinTools` loader auto-discovers all exported `ToolDefinition` objects from the builtin directories. No registration step needed beyond creating the file.

### 2. Channel Plugins

Implement the `ChannelAdapter` interface and register with `MessageRouter`:

```typescript
import type { ChannelAdapter } from '../core/channels/adapter.js';

class MyChannelAdapter implements ChannelAdapter {
  readonly channelType = 'mychannel';
  // implement: start(), stop(), send(), onMessage()
}

router.registerAdapter(new MyChannelAdapter());
```

### 3. Lifecycle Hooks

The `HookManager` provides lifecycle event hooks for plugins that need to react to system events without being in the critical path:

```typescript
import { HookManager } from '../core/hooks/index.js';

hooks.on('agent:turn:start', (ctx) => { /* ... */ });
hooks.on('agent:turn:end', (ctx) => { /* ... */ });
hooks.on('tool:execute', (ctx) => { /* ... */ });
```
