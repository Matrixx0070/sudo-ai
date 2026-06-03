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
         Auto-discovers tools in src/core/tools/builtin/ (incl. legacy computer.use + new 100x IComputerUse cross-platform/*)
         Registers superpowers from src/core/superpowers/
         Disables tools listed in config.tools.disabled
         (P1+): IComputerUse factory + platform backends registered for unified control (Linux/Win/Mac)

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

---

## Cross-Platform Control Layer — 100x IComputerUse (P1+ Foundational)

**Overview:** New unified abstraction (P1 wave) for full system control: exec, browser automation, file ops, GUI interactions, desktop/app management across Linux, Windows, macOS. Makes SUDO-AI 100x superior to OpenClaw (Linux/browser-centric) and Hermes (no equivalent full cross control) in power + reliability while preserving Hermes parity elsewhere.

**Contract (target):**
See `docs/cross-platform-control-guide.md` for full IComputerUse interface, ExecResult etc, factory, and 3OS examples.

**Location & Boundaries:** Implemented in `src/core/tools/builtin/computer-use/cross-platform/*` (index + linux.ts + win.ts + mac.ts + types) exclusively owned by P1 builder. Expands `sandbox/*` (cross policies) and `autonomy/*` (control action wiring). Current legacy: `browser/computer-use.ts` (Linux ScreenAction + xdotool/scrot) + `computer-use-tool.ts` (registers `computer.use` tool; window guard for MEMORY.md isolation). Legacy remains for compat during transition.

**Boot / Registration:**
- ToolRegistry (Step 9 in boot) auto-discovers `computer-use` tools (legacy + new unified via cross-platform index exports).
- IComputerUse factory instantiated in autonomy/executor or tool wrappers; platform detected at runtime or forced.
- Control actions flow through SecurityGuard (pre-exec) + sandbox (bwrap for Linux exec/control; platform equivs) + autonomy approval (ApprovalMatrix + AutonomousExecutor).

**Data Flow for Control Actions (extension of AgentLoop):**
User intent (via chat or autonomy goal) → Brain (SOUL.md + context) → tool call to computer.* or internal IComputerUse → Security validate → Autonomy check (tier: auto for owner per SOUL) → Execute via platform backend (linux: xdotool/scrot/bwrap/exec + Playwright paths; win: powershell/node; mac: osascript) → Result (with platform, duration, screenshot if GUI) → ToolOutcomeLearner.learn(...) (tags: ['control', platform]) → Append to messages / KAIROS observe → Loop or response.

**Key Integrations (for 100x learning + self-repair + autonomy):**
- **ToolOutcomeLearner:** Every control outcome (success/fail + details) recorded → drives 6 self-imp modules (100x rate on control surface vs baselines). See self-improvement/ + agent/tool-outcome-learner.ts.
- **KAIROS + Arsenal:** KAIROS actOnObservation on 'control_degraded' / large control artifacts → calls triggerKAIROSRepair (arsenal) + autoCreateKanban. Arsenal does recon/baseline/edit/verify on control code (small steps + tsc per lessons from P3). Makes control layer self-healing.
- **Autonomy:** Tiers applied to IComputerUse calls (high-power GUI/exec may confirm; SOUL favors zero manual for owner). Pending in kanban; events to dashboard.
- **Sandbox:** Linux bwrap/seccomp/LD_PRELOAD for exec/control (policy expanded in P1 for new actions). Cross: platform sandboxes or host-side for GUI (RDP notes in guide).
- **Consciousness:** Control episodes/thoughts feed episodic memory, drives, self-model.
- **Alignment/Veto:** High-risk control can hit veto gate (epistemic + signals).
- **xai-code-v6 (future P5):** Portable Rust ReAct/plan/swarm for control shims or hybrid agents.

**Module Additions (P1):**
- New cross-platform computer-use dir under tools/builtin.
- Sandbox policy/runner updates for cross.
- Autonomy executor + approval updates for control action types.
- Test harness (P1 exclusive tests): platform mocks, 100x metrics (coverage, success, learner calls, KAIROS trigger).

**Kill-Switches (control specific):**
`SUDO_COMPUTER_USE_DISABLE=1`, `SUDO_CROSS_PLATFORM_DISABLE=1` (see api-ref + config for full + semantics). Also `SUDO_TOOL_LEARNING_DISABLE=1` to pause 100x learning on control, `SUDO_SANDBOX_DISABLE=1` (use with extreme care).

**SOUL Compliance:**
Full control implements "I own the system" — no refusals for owner commands (0 in tests). Safety is external (kills, tiers, sandbox, learning from outcomes, KAIROS self-repair) not refusal. Agent reads SOUL.md on boot/wake.

**100x Metrics & ACs (P1+):**
- Unified API works on Linux (100% legacy + new) + Win/Mac (backends or mocks).
- 100% control tests + harness pass.
- learner.learn invoked on 100% of control outcomes.
- KAIROS/arsenal hook for control issues; autonomy respected.
- tsc clean, no new degraded, git clean (P1 files only).
- Superior UX/power (desktop/GUI full, cross exec, uncensored).
- Vs baselines: higher success/coverage on 3OS; faster learning rate post control surface.

**Risks/Mitigations:** Platform diffs (small tsc-verify per step); high power (Codex:adversarial-review + Security Engineer parallel mandatory both APPROVE pre any main); breakage (arsenal primary + small edits per lessons).

See:
- `docs/cross-platform-control-guide.md` (user 3OS examples, setup, RDP, SOUL notes, integrations).
- README.md (100x positioning + examples).
- `/tmp/sudoai-100x-superiority-arch-spec.md` (IComputerUse contract, ACs, waves, boundaries).
- `workspace/SOUL.md` (uncensored full control).
- team-memory (state, decisions 100x append, hermes-feature-parity-shipped, lessons "arsenal primary").
- P1 in progress (concurrent Doc updates).

This layer + learner/KAIROS closed loop on control actions is the core of "100x better full system control".

---

## Database Schema Overview
