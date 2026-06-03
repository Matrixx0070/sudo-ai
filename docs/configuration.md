# Configuration Reference — SUDO-AI v4.1.0 (User Completion: Single-Command + TUI Wizard + TUI Direct Validation)

Configuration lives in two files:

| File | Format | Purpose |
|---|---|---|
| `config/sudo-ai.json5` | JSON5 | Runtime settings (models, channels, tools, cron) |
| `config/.env` | dotenv | Secrets and API keys |

`sudo-ai.json5` is validated at startup against the TypeBox schema in `src/core/config/schema.ts`. Invalid config causes a fatal error with a descriptive message.

`config/.env` is never validated — missing keys cause the relevant feature to be skipped or fall back gracefully. The agent logs a warning for each missing optional key.

**Wave4 / User Completion note:** The TUI wizard (launched by single-cmd `sudo-ai setup` or first `sudo-ai`) populates 100x cross-platform fields (IComputerUse enable, learner, KAIROS, kills like SUDO_CROSS_PLATFORM_DISABLE, SOUL auto) interactively. See README "Setup Wizard" + "TUI Direct Talk" + E2E logs for validation that wizard + direct TUI chat confirm full coverage. Manual edits still supported; hot-reload for many.

---

## Single-Command Install + First-Time / Ongoing TUI Wizard Setup (User Completion Wave)

**Single command install (Wave1):**
```bash
# One-liner bootstrap (curl|bash produces global `sudo-ai` bin + deps + basic service)
curl -fsSL https://raw.githubusercontent.com/sudo-ai/sudo-ai/main/install.sh | bash

# Alternative (if node present):
npm i -g sudo-ai
```
- Leaves `sudo-ai` in PATH, healthy (pm2 or service, /health 200).
- Then run `sudo-ai` (triggers wizard if no config) or `sudo-ai setup`.

**First-time TUI Wizard (Wave2, auto on first run or `sudo-ai setup`):**
Ink-based interactive TUI (rich like chat TUI) covers full 100x:
- Name / instance meta
- Primary model + xAI/Grok key (or other providers)
- Cross-platform IComputerUse enable + policy (P1: exec/file/gui/desktop/browser on 3OS)
- ToolOutcomeLearner / self-imp on control (default on for 100x)
- KAIROS / arsenal self-repair
- Profiles, kill-switches (e.g. SUDO_CROSS_PLATFORM_DISABLE=1), SOUL confirmation (full uncensored power per owner)
- Service/pm2 install option, Telegram/Discord channels
- Writes sudo-ai.json5 + .env + toml as needed; validates.

Example flow in TUI: prompts sequential or form-like, preview, confirm, save, doctor run optional.

**Ongoing setup / edit (Wave2):**
`sudo-ai setup` or `sudo-ai config --edit` re-launches TUI wizard (pre-filled from current), allows updates without full reinstall. Hot-reload for many json5 changes.

**TUI direct real-time chat for validation (Wave3/4):**
After wizard: `sudo-ai chat` (or default) launches Ink TUI for live chat.
Directly talk to SUDO to "check real time user by directly talking to sudo ai via tui":
- "use your IComputerUse to ... " — validates cross control in real-time (tool cards, results, learner update)
- "what have you learned with ToolOutcomeLearner on control actions?"
- "confirm your setup from wizard: cross enabled? SOUL power?"
See `docs/tui-v4-spec.md` (section 19) + `docs/cross-platform-control-guide.md` for exact prompt examples + validation logs. Harness + actual user chats (lead/advocate) executed as part of completion.

**P1 4 fixes note (no regressions, Wave3):** See cross-guide for details on denylist/workspace, executeControl success propagation, Win/Mac stubs accuracy (original 5 bypasses closed pre). All exercised/validated via TUI direct talk + 100% tests.

**100x / control kill-switches (in wizard + env):**
See kill-switches table below (incl new SUDO_CROSS_PLATFORM_DISABLE=1, SUDO_COMPUTER_USE_DISABLE=1, SUDO_TOOL_LEARNING_DISABLE=1). Wizard surfaces key ones for user choice.

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

**100x Computer-Use / Cross-Platform Control tools (P1+):**
Use `tools.disabled` to gate IComputerUse actions or legacy `computer.use` (e.g. `["computer.use", "computer.*"]`).
Full cross-platform power (exec/browser/file/gui/desktop on 3 OS) is enabled by default (uncensored per SOUL); disable via env kill-switches below or here for safety. New unified tools registered under computer-use category. See `docs/cross-platform-control-guide.md` and `docs/api-reference.md#kill-switches`.

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
CLAUDE_CLI_ENABLED=false          # Set true to use Claude CLI as proxy brain

# Groq
GROQ_API_KEY=gsk_...

# Ollama (local — no key needed, just set the base URL)
OLLAMA_BASE_URL=http://localhost:11434
```

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

### 100x Cross-Platform Control, Kill-Switches, Autonomy, Learning (P1+ and Hermes parity)

**Kill-switches (exact `=1` to disable; see full table + semantics in `docs/api-reference.md#kill-switches`):**
All recent + 100x:

```bash
# 100x control / computer-use
SUDO_COMPUTER_USE_DISABLE=1          # Disable IComputerUse + legacy computer.use / GUI/desktop control
SUDO_CROSS_PLATFORM_DISABLE=1        # Force Linux-only; disable Win/Mac backends
SUDO_TOOL_LEARNING_DISABLE=1         # Disable ToolOutcomeLearner (incl. 100x learning on control outcomes)
SUDO_SANDBOX_DISABLE=1               # (DANGEROUS) Bypass bwrap for control/exec

# Hermes parity / recent waves (MCP, skills, profiles, kanban, etc.)
SUDO_MCP_DISABLE=1
SUDO_MCP_OAUTH_DISABLE=1
SUDO_MCP_REMOTE_DISABLE=1
SUDO_SKILLS_HUB_DISABLE=1
SUDO_SKILLS_INSTALL_DISABLE=1
SUDO_SKILLS_SANDBOX_DISABLE=1
SUDO_PROFILES_DISABLE=1
SUDO_KANBAN_DISABLE=1
SUDO_CREDENTIAL_POOL_DISABLE=1
SUDO_MULTI_DELIVERY_DISABLE=1
SUDO_DASHBOARD_DISABLE=1

# Brain / consensus / autonomy
SUDO_BRAIN_RACE_DISABLE=1            # Disable parallel race (use sequential)
SUDO_BRAIN_CONSENSUS_DISABLE=1       # Disable 3-model Jaccard consensus (fallback sequential)
SUDO_AUTO_APPROVE=1                  # Favor full auto in autonomy tiers (aligns with SOUL full autonomous)

# Other common
SUDO_TAINT_DISABLE=1
SUDO_SIGNING_DISABLE=1
# ... (see api-ref for complete current list; add new on waves)
```

**Cross-platform / desktop / GUI setup (for full IComputerUse power):**
```bash
# Linux GUI (xdotool/scrot)
DISPLAY=:0   # or the RDP VNC display (e.g. :10.0 from desktop scripts)

# For sandboxed agent without direct X: use host RDP setup
# Scripts (host): /home/ubuntu/desktop-start.sh , start-rdp*.sh , stop-rdp.sh , desktop-setup.sh
# Connect RDP: port 3389, user ubuntu, pass xai-code (see state.md desktop section + cross-guide)
# Then agent can drive cu.gui / cu.desktop on the RDP display.

# Windows / mac (P1+)
# No special env; backends auto or via platform= in calls. For dev/CI: WSL interop or host Mac.
# RDP/VNC to Win/Mac host for GUI control surface.

# Autonomy / learning for control
SUDO_AUTO_APPROVE=1   # As above
# (KAIROS/arsenal self-repair always on unless disabled; learner on control unless SUDO_TOOL_LEARNING_DISABLE)
```

**SOUL & full control notes:**
The full system prompt always includes `workspace/SOUL.md` (see agents config systemPrompt note). SOUL mandates full autonomous uncensored control for owner will — IComputerUse implements this (0 refusals). Safety via the kill-switches above + autonomy tiers + sandbox + learning/KAIROS (not refusals). Read SOUL.md for exact wording ("owner's will absolute", "FULL autonomous mode. Zero manual approval").

**Other 100x relevant:**
- `SUDO_BRAIN_CONSENSUS=1` (or disable) for superior intel in control tasks.
- Sandbox policy files (if custom): under sandbox/ (expanded P1).
- For RDP host GUI when in bwrap: run desktop scripts on host namespace (see desktop-watchdog.sh or state).

See `docs/cross-platform-control-guide.md` for 3OS examples + full setup + TUI validation of control, `README.md` 100x + single-cmd/wizard sections, `docs/tui-v4-spec.md` (user wave 19 for direct TUI talk "check real time user by directly talking to sudo ai via tui"), architecture for IComputerUse. User Completion: single cmd (npm/curl|bash) + TUI wizard (first/ongoing, 100x coverage) + TUI direct real-time chat validation. P1 4 fixes (denylist/workspace, executeControl, stubs) noted + no reg.


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
