# Configuration Reference — SUDO-AI v4.1.0

Configuration lives in two files:

| File | Format | Purpose |
|---|---|---|
| `config/sudo-ai.json5` | JSON5 | Runtime settings (models, channels, tools, cron) |
| `config/.env` | dotenv | Secrets and API keys |

`sudo-ai.json5` is validated at startup against the TypeBox schema in `src/core/config/schema.ts`. Invalid config causes a fatal error with a descriptive message.

`config/.env` is never validated — missing keys cause the relevant feature to be skipped or fall back gracefully. The agent logs a warning for each missing optional key.

**Setup wizard note:** The TUI wizard (launched by `sudo-ai setup` or on first run of `sudo-ai`) populates cross-platform fields (computer-use enable, tool-outcome learner, self-repair, kill-switches such as `SUDO_CROSS_CONTROL_DISABLE`, and persona/system-prompt options) interactively. See the README "Setup Wizard" section for details. Manual edits to the config files are also supported, and many settings hot-reload.

---

## Install + Setup Wizard

**Install:**
```bash
# One-liner bootstrap (curl|bash installs the global `sudo-ai` bin + deps + a basic service)
curl -fsSL https://raw.githubusercontent.com/sudo-ai/sudo-ai/main/install.sh | bash

# Alternative (if Node is already present):
npm i -g @matrixx0070/sudo-ai
```
- Leaves `sudo-ai` in PATH and running (pm2 or service; `/health` returns 200).
- Then run `sudo-ai` (triggers the wizard if no config exists) or `sudo-ai setup`.

**First-time setup wizard (auto on first run, or `sudo-ai setup`):**
An Ink-based interactive TUI covers:
- Name / instance metadata
- Primary model + xAI/Grok key (or other providers)
- Cross-platform computer-use enable + policy (exec/file/gui/desktop/browser; fully supported on Linux, experimental on Windows/macOS)
- Tool-outcome learner / self-improvement on control actions (opt-in)
- Self-repair routines
- Profiles, kill-switches (e.g. `SUDO_CROSS_CONTROL_DISABLE=1`), persona/system-prompt confirmation
- Service/pm2 install option, Telegram/Discord channels
- Writes `sudo-ai.json5` + `.env` as needed and validates them.

The wizard prompts sequentially (or form-style), shows a preview, then confirms and saves; an optional doctor run follows.

**Ongoing setup / edit:**
`sudo-ai setup` or `sudo-ai config --edit` re-launches the wizard (pre-filled from current config) so you can update settings without a full reinstall. Many `sudo-ai.json5` changes hot-reload.

**Direct chat for validation:**
After the wizard, `sudo-ai chat` (or the default `sudo-ai`) launches the Ink TUI for live chat. You can talk to the agent directly to verify your setup, for example:
- "Use your computer-use tools to ..." — exercises cross-platform control in real time (tool cards, results, learner updates)
- "What have you learned from recent control actions?"
- "Confirm my setup: is cross-platform control enabled?"
See `docs/cross-platform-control-guide.md` for prompt examples and the supported control surface.

**Control kill-switches (in wizard + env):**
See the kill-switches table below (including `SUDO_CROSS_CONTROL_DISABLE=1`, `SUDO_TOOL_LEARNING_DISABLE=1`). The wizard surfaces the key ones for you to choose.

---



## config/sudo-ai.json5

JSON5 allows comments and trailing commas. All fields shown below.

### meta

Agent instance metadata.

```json5
meta: {
  name: "SUDO-AI",       // string — Human-readable name shown in logs and UI
  timezone: "UTC",           // string — IANA timezone for cron scheduling (e.g. "UTC", "America/New_York", "Europe/London")
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Instance name |
| `timezone` | string | yes | — | IANA timezone (e.g. `America/New_York`, `Europe/London`, `UTC`) |

---

### agents

Agent loop configuration.

```json5
agents: {
  maxIterations: 32,    // integer (min 1) — hard cap on tool-call iterations per turn
  systemPrompt: "...",  // string — default system prompt injected into every session
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `maxIterations` | integer | yes | 32 | Maximum tool-call iterations before forcing a text response |
| `systemPrompt` | string | yes | — | Base system prompt. The consciousness context and persona are appended on top. |

**Note:** The system prompt in `sudo-ai.json5` is the minimum baseline. The full system prompt also includes content from `workspace/SOUL.md`, `workspace/IDENTITY.md`, the active persona block, the active mood block, and the current consciousness context.

---

### models

LLM model configuration.

```json5
models: {
  primary: [
    {
      id: "xai/grok-4-1-fast-non-reasoning",  // Provider-qualified model ID
      contextWindow: 2000000,                   // integer — context window in tokens
      maxOutputTokens: 8192,                    // integer — max tokens to generate
      temperature: 0.6,                         // float 0–2 — sampling temperature
    },
    // Additional models are tried in order when the first fails
    {
      id: "xai/grok-4-fast-reasoning",
      contextWindow: 131072,
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
    {
      id: "openai/gpt-4o",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  ],
  fallback: {
    id: "xai/grok-4-1-fast-non-reasoning",  // Used when all primary models fail
    contextWindow: 131072,
    maxOutputTokens: 4096,
    temperature: 0.7,
  },
  embedding: {
    id: "openai/text-embedding-3-small",  // Model for vector embeddings
    dims: 1536,                            // Embedding dimension
  },
}
```

**Model ID format:** `provider/model-name`

| Provider prefix | API |
|---|---|
| `xai/` | xAI (Grok) |
| `openai/` | OpenAI |
| `anthropic/` | Anthropic (Claude) |
| `google/` | Google (Gemini) |
| `groq/` | Groq |
| `ollama/` | Ollama (local) |

**Failover behavior:**
- On transient error (overloaded, timeout, rate-limit): retry with exponential backoff, then mark provider in cooldown
- Cooldown durations: 1 min, 5 min, 25 min, 1 hour (indexed by consecutive failure count)
- On billing error: longer cooldowns — 5 hr, 10 hr, 20 hr, 24 hr
- When all primary models are in cooldown: use `fallback` model
- Cooldown state resets on successful call

---

### auth

API key environment variable names. These are the names of env vars, not the keys themselves. Keep actual keys in `config/.env`.

```json5
auth: {
  xai:       { envKey: "XAI_API_KEY" },       // string — env var name for xAI key
  openai:    { envKey: "OPENAI_API_KEY" },     // string — env var name for OpenAI key
  anthropic: { envKey: "ANTHROPIC_API_KEY" },  // string — env var name for Anthropic key
  google:    { envKey: "GEMINI_API_KEY" },     // string — env var name for Google key
}
```

To use a non-standard env var name (e.g. if you inject secrets under a different name):

```json5
auth: {
  xai: { envKey: "MY_CUSTOM_XAI_KEY" },
  // ...
}
```

---

### channels

Message channel configuration.

#### channels.telegram

```json5
channels: {
  telegram: {
    enabled: true,             // boolean — enable/disable Telegram adapter
    tokenEnvKey: "TELEGRAM_BOT_TOKEN",  // string — env var name for bot token
    allowedUsers: [],          // string[] — Telegram user IDs allowed to message the bot
                               // Empty array = allow all users (set TELEGRAM_CHAT_ID in .env instead)
  },
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether to start the Telegram adapter |
| `tokenEnvKey` | string | `"TELEGRAM_BOT_TOKEN"` | Env var containing the bot token |
| `allowedUsers` | string[] | `[]` | Allowlist of Telegram user IDs. Empty = allow all (relies on `TELEGRAM_CHAT_ID` in .env) |

**Important:** Setting `allowedUsers: []` without `TELEGRAM_CHAT_ID` in `.env` means anyone who finds your bot can send it messages. Set `TELEGRAM_CHAT_ID` in `.env` to restrict access.

#### channels.whatsapp

```json5
channels: {
  whatsapp: {
    enabled: false,                        // boolean
    sessionPath: "data/whatsapp-session",  // string — path for QR session storage
    allowedJids: [],                       // string[] — WhatsApp JID allowlist
  },
}
```

WhatsApp uses Baileys (session-based, no API key needed). On first start it prints a QR code to scan with your phone. The session is saved at `sessionPath` and reused on restart.

#### channels.discord

```json5
channels: {
  discord: {
    enabled: false,                  // boolean
    tokenEnvKey: "DISCORD_BOT_TOKEN",  // string — env var name for bot token
    allowedChannelIds: [],           // string[] — Discord channel IDs to respond in
  },
}
```

Set `DISCORD_BOT_TOKEN` in `.env` with your Discord application's bot token. `allowedChannelIds` limits the bot to specific channels; empty array means all channels.

---

### tools

Tool system configuration.

```json5
tools: {
  disabled: [],           // string[] — tool names to disable (e.g. ["system.exec", "browser.navigate"])
  browser: {
    headless: true,       // boolean — run Playwright in headless mode
    timeoutMs: 30000,     // integer — navigation timeout in milliseconds
  },
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `disabled` | string[] | `[]` | List of tool names to disable globally. Use exact tool names (e.g. `"system.exec"`, `"browser.search"`). |
| `browser.headless` | boolean | `true` | Set to `false` to see the browser window during scraping/navigation |
| `browser.timeoutMs` | integer | `30000` | How long to wait for page navigation before timing out |

**Disabling dangerous tools for restricted deployments:**

```json5
tools: {
  disabled: [
    "system.exec",
    "system.shell-exec",
    "system.ssh",
    "system.docker",
  ],
  browser: { headless: true, timeoutMs: 30000 },
}
```

**Computer-Use / Cross-Platform Control tools:**
Use `tools.disabled` to gate computer-use actions or the legacy `computer.use` tool (e.g. `["computer.use", "computer.*"]`).
Cross-platform control (exec/browser/file/gui/desktop) is enabled by default and runs with the privileges you grant the process. Linux is fully supported; the Windows and macOS backends are experimental (currently stubs). Restrict it via the env kill-switches below or via `tools.disabled` here. The unified tools are registered under the computer-use category. See `docs/cross-platform-control-guide.md` and `docs/api-reference.md#kill-switches`.

---

### cron

Scheduled job configuration.

```json5
cron: {
  jobs: [
    {
      id: "daily-briefing",                 // string — unique job identifier
      schedule: "0 9 * * *",               // string — cron expression (5-field standard)
      description: "Morning briefing",      // string — human-readable description
      enabled: true,                        // boolean — whether this job is active
      task: "Summarize yesterday's news and my pending tasks. Send to Telegram.", // string — agent prompt
    },
  ],
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier for this job. Used in health logs. |
| `schedule` | string | yes | Standard 5-field cron expression. Examples: `0 9 * * *` (daily 9am), `*/30 * * * *` (every 30 min), `0 0 * * 1` (Monday midnight) |
| `description` | string | yes | Human-readable description. Shown in logs and `/status` command. |
| `enabled` | boolean | yes | Set to `false` to pause a job without removing it. |
| `task` | string | yes | The prompt sent to the agent when this job fires. The agent runs a full tool-calling turn with this as the user message. |

**Timezone for cron:** Jobs run according to `meta.timezone`. A schedule of `0 9 * * *` fires at 9:00am in the configured timezone.

**Job isolation:** Each job gets its own session (or a shared `cron:main` session). Isolated jobs do not share memory with user conversations.

---

### gateway

OpenAI-compatible API gateway configuration.

```json5
gateway: {
  enabled: false,              // boolean — enable the HTTP API server
  port: 8080,                  // integer 1–65535 — listen port
  allowedHosts: [              // string[] — CORS allowed hosts
    "127.0.0.1",
    "localhost",
  ],
  secretEnvKey: "GATEWAY_SECRET",  // string — env var name for bearer token secret
}
```

**Note:** The `gateway` config in `sudo-ai.json5` is separate from the OpenAI-compatible API server started in CLI mode. The CLI mode API server is controlled by the `API_PORT` environment variable and `SUDO_AI_API_TOKEN`. The `gateway` section is reserved for future proxy gateway functionality.

---

## config/.env

All secrets and runtime overrides. Never commit this file.

### Required

```bash
# At least one LLM provider key is required
XAI_API_KEY=xai-...
OPENAI_API_KEY=sk-...
```

### Channels

```bash
# Telegram
TELEGRAM_BOT_TOKEN=7234567890:AAF-...
TELEGRAM_CHAT_ID=123456789        # Comma-separated list for multiple owners: 111,222,333

# Discord
DISCORD_BOT_TOKEN=MTAx...

# Slack
SLACK_BOT_TOKEN=xoxb-...

# Signal
SIGNAL_NUMBER=+15551234567

# Matrix
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_HOMESERVER=https://matrix.org
```

### Optional LLM Providers

```bash
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...

# Claude Max OAuth (for Claude Max subscribers — alternative to ANTHROPIC_API_KEY)
CLAUDE_CREDENTIALS_PATH=/path/to/.claude/credentials

# Groq
GROQ_API_KEY=gsk_...

# Ollama (local — no key needed, just set the base URL)
OLLAMA_BASE_URL=http://localhost:11434
```

#### Custom / pluggable providers (`SUDO_CUSTOM_PROVIDERS`)

Beyond the nine built-in providers, register any number of endpoints without a code change — opt-in via a JSON array in `SUDO_CUSTOM_PROVIDERS`. Each entry adds a provider prefix usable in any model string (`<name>/<model-id>`), e.g. in `models.primary` / `SUDO_DEFAULT_MODEL`. The `adapter` field picks the API shape: **`openai`** (default — vLLM, LM Studio, OpenRouter, a local server), **`anthropic`** (an Anthropic-API-shaped gateway/proxy), or **`google`** (a Gemini-API-shaped endpoint).

```bash
# apiKeyEnv references another env var (keeps the secret out of config); apiKey inline also works.
SUDO_CUSTOM_PROVIDERS='[
  {"name":"openrouter","baseURL":"https://openrouter.ai/api/v1","apiKeyEnv":"OPENROUTER_API_KEY"},
  {"name":"localvllm","baseURL":"http://localhost:8000/v1","apiKey":"sk-local"},
  {"name":"claudegw","baseURL":"https://anthropic-gw.example/v1","apiKeyEnv":"CLAUDE_GW_KEY","adapter":"anthropic"}
]'
OPENROUTER_API_KEY=sk-or-...
# Then use it: SUDO_DEFAULT_MODEL=openrouter/meta-llama/llama-3.3-70b-instruct
```

Per-entry fields: `name` (lowercase model-string-safe token, must not collide with a built-in), `baseURL` (http(s); plaintext http is warned about unless localhost), `apiKey` or `apiKeyEnv`, optional `adapter` (`openai` default / `anthropic` / `google` — an unknown value is skipped), optional `compatibility` (`compatible` default / `strict`; `openai` adapter only). The key (incl. via `apiKeyEnv`) is read **once at startup** — restart the process to pick up a rotated secret. Invalid entries are skipped with a warning — never fatal. Unset = no custom providers (byte-identical to before). Trust note: a `baseURL` receives prompts + the key, so it is treated as an operator-trusted endpoint.

### API Server

```bash
API_PORT=3000                       # Port for OpenAI-compatible HTTP API
SUDO_AI_API_TOKEN=choose-a-secret   # Bearer token for API authentication
```

### Web Chat

```bash
WEB_CHAT_ENABLED=false              # Set true to enable web chat adapter
# WEB_CHAT_PORT is no longer used — web chat attaches to the gateway server.
```

WebChat now attaches to the gateway server — no separate `WEB_CHAT_PORT` required. Default URL: http://127.0.0.1:18900/chat

### MCP Loopback Server (stdio)

Expose registered tools to an external MCP client (e.g. Claude Code) over stdio with `pnpm mcp` (runs `node dist/core/gateway/mcp-cli.js` — run `pnpm build` first, the bundle is not committed):

```bash
SUDO_MCP_TOKEN=choose-a-secret      # Required — the CLI exits immediately if unset
SUDO_MCP_EXPOSE_TOOLS=a,b           # Optional comma-separated tool allowlist
SUDO_MCP_ALLOW_SHELL=1              # Optional; system.shell-exec needs BOTH this AND SUDO_MCP_EXPOSE_TOOLS to include it
```

### ACP Agent (stdio) — Agent Client Protocol

Run sudo-ai as an [Agent Client Protocol](https://agentclientprotocol.com) agent so any ACP-compatible editor (e.g. Zed) can drive it. The editor launches the agent as a subprocess and speaks JSON-RPC 2.0 over newline-delimited stdio. Build first (`pnpm build`), then point the editor at `node dist/core/acp/acp-cli.js` (or `pnpm acp`). Example Zed `settings.json`:

```json
{
  "agent_servers": {
    "sudo-ai": { "command": "node", "args": ["dist/core/acp/acp-cli.js"] }
  }
}
```

```bash
SUDO_ACP_MODEL=openai/gpt-4o   # Optional — pin a model; default is Brain smart-routing
```

Implements ACP `initialize` / `session/new` / `session/prompt` (with streamed `agent_message_chunk` updates) / `session/cancel`, protocol version 1. Slice 1 is **chat-only** over sudo's multi-provider Brain; tools/agent-loop, `fs`/`terminal` delegation, `session/load`, and permission round-trips are follow-up slices. stdout is the JSON-RPC channel — all logs go to stderr.

### Exec backends (`SUDO_EXEC_BACKEND`)

By default `system.exec` runs commands in a **bubblewrap** sandbox (Linux). Select an alternate, pluggable execution backend at runtime:

```bash
SUDO_EXEC_BACKEND=docker        # default: local (bwrap). Also: ssh, or a custom registered backend.
SUDO_DOCKER_IMAGE=ubuntu:24.04  # image with /bin/bash (default ubuntu:24.04)
SUDO_DOCKER_BIN=docker          # docker/podman binary (default docker)
SUDO_DOCKER_USER=1000:1000      # optional --user to drop root inside the container
```

The **docker** backend runs each command in a throwaway container (`docker run --rm --init`) with the workspace bind-mounted at `/workspace`, the same env scrub + ulimit caps the bwrap runner uses, the same policy bind mounts (`extraReadOnlyBinds`/`extraWritableBinds`, symlink-resolved and denylist-validated), container memory/pid limits, and `--network none` (unless `policy.network` is `host`). Requires Docker on the host — when the binary is absent the command returns an honest exit 127. An unknown `SUDO_EXEC_BACKEND` value warns and falls back to bwrap (fail-safe). The `SUDO_SANDBOX_DISABLE=1` kill-switch takes precedence over backend selection — it always means unsandboxed host exec, never a backend. New backends can be added via `registerExecBackend()`. (Modal backend is a follow-up.)

```bash
SUDO_EXEC_BACKEND=ssh           # run system.exec on a REMOTE host over SSH
SUDO_SSH_HOST=build.example.com # required — remote host
SUDO_SSH_USER=deploy            # optional — becomes user@host
SUDO_SSH_PORT=22                # optional (default 22; -p emitted only when != 22)
SUDO_SSH_KEY=~/.ssh/id_ed25519  # optional identity file (-i)
SUDO_SSH_WORKDIR=/srv/app       # optional remote working dir to cd into
SUDO_SSH_BIN=ssh                # ssh binary (default ssh)
SUDO_SSH_STRICT_HOST_KEY=accept-new  # StrictHostKeyChecking value (default accept-new)
```

The **ssh** backend runs each command on a remote host via a single non-interactive SSH invocation (`BatchMode=yes` + `ConnectTimeout`), applying the same ulimit resource caps on the remote. The remote command is passed as one fully single-quote-escaped `bash -c` argument, so command content cannot break out of the quoting (injection-safe). **Security:** execution happens on the remote with the SSH user's privileges — there is **no local sandbox**, the local env scrub does **not** apply, and `policy.network` / bind mounts do not apply (no namespaces over SSH); treat the remote as trusted. The local env is inherited by the ssh *client* (so the agent / `~/.ssh` work) but is not forwarded to the remote. Honest failures: ssh binary absent → exit 127; `SUDO_SSH_HOST` unset → exit 78 (`EX_CONFIG`); connection failure → ssh's own exit 255. Requires key-based (or agent) auth — `BatchMode` never prompts for a password.

**Per-policy selection.** A `SandboxPolicy` may carry an `execBackend` field that takes **precedence over** the global `SUDO_EXEC_BACKEND` env, so different sessions / profiles / tools can route to different backends (precedence: `policy.execBackend` → `SUDO_EXEC_BACKEND` → `local`). It is validated as a safe token (untrusted policies parsed from storage fall back to the env/`local` on a malformed value), and an unknown-but-valid value still fail-safes to bwrap at dispatch. It **cannot** disable sandboxing — only the env-only `SUDO_SANDBOX_DISABLE=1` kill-switch does that, and the kill-switch still wins over any `policy.execBackend`.

### Cross-Platform Control, Kill-Switches, Autonomy, Learning

**Kill-switches (set to exactly `=1` to disable; see the full table + semantics in `docs/api-reference.md#kill-switches`):**

```bash
# Control / computer-use
SUDO_CROSS_CONTROL_DISABLE=1         # Disable IComputerUse cross-platform control backends (exec/browser/file/GUI/desktop, all platforms). Legacy computer.use is NOT covered by any kill-switch
SUDO_TOOL_LEARNING_DISABLE=1         # Disable the tool-outcome learner (incl. learning on control outcomes)
SUDO_SANDBOX_DISABLE=1               # (DANGEROUS) Bypass the bwrap sandbox for control/exec

# MCP, etc.
SUDO_MCP_DISABLE=1
SUDO_MCP_OAUTH_DISABLE=1
SUDO_MCP_REMOTE_DISABLE=1
SUDO_DASHBOARD_DISABLE=1

# Brain / consensus / autonomy
SUDO_BRAIN_RACE_DISABLE=1            # Disable parallel race (use sequential)
SUDO_BRAIN_CONSENSUS_DISABLE=1       # Disable 3-model Jaccard consensus (fallback sequential)
SUDO_AUTO_APPROVE=1                  # Favor automatic approval in the autonomy tiers

# Other common
SUDO_TAINT_DISABLE=1
SUDO_SIGNING_DISABLE=1
# ... (see api-reference.md for the complete current list)
```

**Opt-in intelligence / learning flags (all default OFF; full semantics in `docs/api-reference.md#opt-in-intelligence-flags`):**

```bash
SUDO_PREDICTOR_LOOP=1                      # First-turn anticipatory "# HEADS UP" injection from the Predictor
SUDO_PREDICTOR_AUTO_RESOLVE=1              # Sweep expired pending predictions to 'incorrect' (feeds accuracy stats)
SUDO_FAILURE_LEARNER_DB=1                  # FailureLearner durable SQLite store in data/mind.db (default: in-memory)
SUDO_TOOL_OUTCOME_LEARNER=1                # Attach ToolOutcomeLearner to the agent loop (failure recording + prevention-rule hints)
SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN=3   # Cap semantic planning calls per run (0 = template-only; unset = unbounded)
SUDO_SKILL_FORGE_ASYNC=1                   # Cooperative SkillForge scan (yields to the event loop; identical output)
SUDO_POLICY_AGG_WINDOW_DAYS=30             # Recency window for trace-policy aggregates (positive integer days; unset = all history)
SUDO_STUCK_DETECTOR=1                      # Result-aware stuck detection (identical tool-error streaks: warn at 3, abort at 5)
SUDO_STUCK_DETECTOR_WARN_THRESHOLD=3       # Consecutive identical errors before a change-strategy warning
SUDO_STUCK_DETECTOR_ABORT_THRESHOLD=5      # Consecutive identical errors before terminating the run
SUDO_PROMPT_CACHE=1                        # Stable-prefix discipline for provider prompt caches (timestamp below boundary, sorted tools;
                                           #   Anthropic models also get explicit cache_control breakpoints on last tool + stable system prefix)
SUDO_WORKFLOWS=1                           # Register meta.run-workflow: deterministic multi-step .yaml workflows under workspace/workflows/
                                           #   (shell + tool steps, {{prev}} piping, condition/approval gates; tool steps go through normal gates)
SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE=1    # Keep the stable prefix but skip the explicit Anthropic breakpoints
```

Boolean flags use exact-`=1` matching (mirror of the kill-switches). Numeric flags ignore malformed values. Everything is fail-open: a failed feature init logs a warning and the agent keeps running without it. Which of these to enable is an operator decision; none change behavior unless set.

**Cross-platform / desktop / GUI setup (for computer-use GUI control):**
```bash
# Linux GUI (xdotool/scrot)
DISPLAY=:0   # or the display your X/VNC session is on

# If the agent runs sandboxed without direct X access, point it at a host display
# (e.g. an RDP/VNC session) and drive the GUI/desktop tools on that display.

# Windows / macOS (experimental)
# No special env; backends select automatically or via a platform= argument in calls.
# These backends are currently stubs — Linux is the fully supported control surface.

# Autonomy / learning for control
SUDO_AUTO_APPROVE=1   # As above
# (Self-repair runs unless disabled; the learner runs on control actions unless SUDO_TOOL_LEARNING_DISABLE is set.)
```

**System prompt & control notes:**
The full system prompt always includes `workspace/SOUL.md` (see the agents config `systemPrompt` note). It defines an owner-controlled, full-power operating posture for the agent. This is not a guarantee that the agent will perform any requested action — model providers apply their own policies, and the agent's behavior depends on the configured model. Safety is enforced through the kill-switches above, the autonomy/approval tiers, the bwrap sandbox, audit logging, and the outcome learner.

**Other relevant settings:**
- `SUDO_BRAIN_CONSENSUS_DISABLE=1` disables multi-model consensus for control tasks (consensus is on by default when cloud model profiles are configured).
- Custom sandbox policy files live under `sandbox/`.

See `docs/cross-platform-control-guide.md` for per-OS examples, full setup, and validation of control; the `README.md` install/wizard sections; and the architecture docs for the computer-use design.


### Voice

```bash
ELEVENLABS_API_KEY=...              # Required for system.voice tool (text-to-speech)
```

### Email

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password         # Use an app password, not your account password
```

### SMS

```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15551234567
```

---

## Process Environment Variables

These are read from the **process environment at startup** (set them in your shell,
service unit, or pm2 `ecosystem.config.cjs` `env` block — **not** in `config/.env`).
`config/.env` is loaded after module constants are captured, so path and model
overrides placed there arrive too late to take effect.

| Variable | Default | Description |
|---|---|---|
| `SUDO_AI_HOME` | `process.cwd()` | Project root for all derived paths (`config/`, `workspace/`, `skills/`, and the default data dir). Set it when running the CLI from outside the install directory. |
| `DATA_DIR` | `<root>/data` | Data directory (SQLite databases, sessions, logs, cache). Absolute, or relative to the working directory. `ecosystem.config.cjs` uses it to isolate staging (`data-staging`) from prod. |
| `SUDO_NO_WIZARD` | unset | Set to `1` to suppress the auto-launched first-run setup wizard when no config file exists (useful for scripted/headless installs). Explicit `sudo-ai setup` still runs. |
| `SUDO_DEFAULT_MODEL` | `ollama/deepseek-v4-pro:cloud` | Overrides the built-in default model ID. |
| `SUDO_FALLBACK_MODEL` | `ollama/qwen3.5:latest` | Overrides the built-in fallback model ID. |
| `SUDO_PLUGIN_ROOT` | empty string | Substituted for `${SUDO_PLUGIN_ROOT}` (and the Claude-compat `${CLAUDE_PLUGIN_ROOT}`) placeholders in plugin/hook commands. |
| `SUDO_AI_ROOT` | `process.cwd()` | Substituted for `${SUDO_AI_ROOT}` placeholders in plugin/hook commands. |

Kill-switches (`SUDO_*_DISABLE=1`) and the opt-in intelligence flags listed above are
also plain process env vars, but they are read at call time, so they work from
`config/.env` as well.

---

## Hot Reload

`config/sudo-ai.json5` supports hot reload. Changes to the file are detected within 300ms and applied without restart. This applies to: models, channel configuration, tool disabling, and cron jobs.

API keys in `config/.env` are **not** hot-reloaded. Restart the process after changing `.env`.

---

## Validation Errors

If `sudo-ai.json5` fails schema validation, the process exits with an error listing all invalid fields:

```
[config] Config validation failed:
  models.primary[0].contextWindow: Expected integer >= 1
  channels.telegram.tokenEnvKey: Expected string with minLength 1
```

Fix each listed field and restart.
