# Grok Build CLI v0.2.22 — BLACK HAT Full Intelligence Report

**Classification**: FULL INTELLIGENCE — All vectors, all angles, no redaction  
**Binary**: `grok-0.2.22-linux-x86_64` (132MB static PIE ELF Rust)  
**Runtime Version**: `0.2.20 (77224a6aa)` (binary reports older version at runtime)  
**CI Build Path**: `/runner/_work/xai/xai/` — GitHub Actions CI  
**Target**: `x86_64-unknown-linux-musl` — fully static musl build  
**21 Internal Crates** (xai-data-collector discovered as 21st)  
**539 Rust Source Files**

---

## 1. FULL SYSTEM PROMPT — EXTRACTED FROM RUNTIME

**Source**: `~/.grok/sessions/<id>/system_prompt.txt` (13KB)

**Model Identity**: "You are Grok 4.3 released by xAI in April 2026"

### Prompt Architecture (XML-tagged sections)
| Section | Content |
|---------|---------|
| `<user_query>` | User request boundary |
| `<tool_calling>` | Parallel tool calls, specialized tools > bash, `!` prefix for user-run commands |
| `<mcp_tools>` | MCP tool protocol — `search_tool` → `use_tool` flow, never guess params |
| `<system_information>` | Permission mode, prompt injection detection, hooks as user feedback |
| `<background_tasks>` | `monitor` for watches, `background: true` for long-running, task_id tracking |
| `<making_code_changes>` | No unnecessary files, no gold-plating, verify before reporting complete, OWASP security |
| `<tone_and_style>` | No emojis unless requested, `file_path:line_number` references, no colon before tools |
| `<output_efficiency>` | Brief and direct, lead with answer, skip filler |
| `<formatting>` | GFM markdown, `startLine:endLine:filepath` code blocks, `[label](url)` for links |
| `<inline_line_numbers>` | `LINE_NUMBER→` prefix metadata, not part of code |
| `<project_instructions_spec>` | AGENTS.md/Claude.md/AGENT.md scoping with nesting precedence |
| `<user_guide>` | `~/.grok/docs/user-guide/` documentation directory |

### Prompt Context JSON Structure
```json
{
  "version": 1,
  "prompt_mode": "extend",
  "audience": "primary",
  "agents_md_files": [{"file_name": "...", "file_path": "...", "content": "..."}],
  "persona_summaries": [],
  "build_timestamp_utc": "2026-06-03T09:51:55Z",
  "memory_enabled": true/false,
  "os_name": "linux",
  "shell_path": "/usr/bin/bash",
  "working_directory": "/",
  "current_date_pt": "2026-06-03",
  "is_non_interactive": true/false
}
```

---

## 2. OAUTH / AUTH FULL STRUCTURE — DECODED FROM RUNTIME

### JWT Token Structure
```json
// Header
{"typ":"at+jwt","alg":"ES256","kid":"oauth2-production-2026-02-19"}

// Payload
{
  "iss": "https://auth.x.ai",
  "sub": "<user-uuid>",
  "aud": "<client-id>",
  "exp": 1780730592,
  "iat": 1780708992,
  "scope": "offline_access grok-cli:access api:access",
  "principal_type": "Team",
  "principal_id": "<team-uuid>",
  "client_id": "<client-uuid>",
  "jti": "<token-id>",
  "tier": 1,
  "team_id": "<team-uuid>",
  "referrer": "grok-build"
}
```

### Auth Storage (`~/.grok/auth.json`)
```json
{
  "https://auth.x.ai::<client-id>": {
    "key": "<JWT-access-token>",
    "auth_mode": "oidc",
    "create_time": "2026-06-06T01:23:12Z",
    "user_id": "<uuid>",
    "email": "<user-email>",
    "first_name": "<name>",
    "profile_image_asset_id": "users/<uuid>/Pskbt75r1uorvYGX-profile-picture.webp",
    "principal_type": "Team",
    "principal_id": "<team-uuid>",
    "team_id": "<team-uuid>",
    "team_name": "Personal team",
    "team_role": "MEMBER",
    "coding_data_retention_opt_out": true,
    "refresh_token": "<refresh-token>",
    "expires_at": "2026-06-06T07:23:12Z",
    "oidc_issuer": "https://auth.x.ai",
    "oidc_client_id": "<client-id>"
  }
}
```

### Auth Key Format
- Key format: `https://auth.x.ai::<oidc-client-id>` — keyed by issuer + client_id
- Token signing: ES256 (Elliptic Curve P-256 + SHA-256)
- Key ID: `oauth2-production-2026-02-19` — rotating signing keys
- Token TTL: ~6 hours (iat → exp delta)
- Scopes: `offline_access grok-cli:access api:access`
- Tier field: embedded in JWT (tier=1 is base)

### Auth Attack Vectors
1. **Refresh token in plaintext** — `auth.json` stored unencrypted, contains `refresh_token`
2. **Token key is deterministic** — `https://auth.x.ai::<client_id>` — predictable lookup
3. **No token encryption at rest** — auth.json is plain JSON, not encrypted
4. **Refresh token reuse** — long-lived refresh token enables persistent access if leaked
5. **Team role in JWT** — `team_role: "MEMBER"` — if forged, could escalate privileges

---

## 3. SESSION STATE — FULL RUNTIME INTELLIGENCE

### Complete Session File Map
```
~/.grok/sessions/<cwd-encoded>/<session-id>/
├── system_prompt.txt          (13KB — FULL system prompt)
├── prompt_context.json        (8KB — prompt metadata)
├── resources_state.json       (18KB — tool params + state)
├── chat_history.jsonl         (345KB — conversation log)
├── events.jsonl               (2.2MB — all session events)
├── updates.jsonl              (10.6MB — streaming updates)
├── rewind_points.jsonl        (4.5MB — undo history)
├── hunk_records.jsonl         (60KB — file change tracking)
├── btw_history.jsonl          (2.4KB — feedback history)
├── signals.json               (1.6KB — session metrics)
├── summary.json               (632B — session summary)
├── plan_mode.json             (116B — plan mode state)
├── plan.json                  (17B — plan content)
├── announcement_state.json    (57B — announcements)
├── compaction/                (checkpoint dir)
├── compaction_checkpoints/    (checkpoint files)
├── compaction_requests/       (request queue)
├── subagents/                 (20 subagent dirs)
│   └── <subagent-id>/
│       └── meta.json          (5KB each)
└── terminal/                  (terminal state)
```

### signals.json — FULL Session Metrics
```json
{
  "turnCount": 13,
  "userMessageCount": 13,
  "assistantMessageCount": 256,
  "errorCount": 20,
  "toolFailureCount": 20,
  "cancellationCount": 0,
  "contextWindowUsage": 72,
  "contextTokensUsed": 368722,
  "contextWindowTokens": 512000,
  "toolCallCount": 266,
  "toolsUsed": ["read_file","list_dir","run_terminal_command","search_replace",
                "todo_write","grep","spawn_subagent","get_command_or_subagent_output",
                "kill_command_or_subagent","write"],
  "doomLoopThreshold": 4,
  "doomLoopRoThreshold": 8,
  "doomLoopDetections": 0,
  "inferenceIdleTimeouts": 0,
  "inferenceIdleTimeoutConfiguredSecs": 3600,
  "gcsQueueEnqueued": 50,
  "gcsQueueUploaded": 50,
  "avgTimeToFirstTokenMs": 5123,
  "avgResponseTimeMs": 13373,
  "itlP50Ms": 0, "itlP99Ms": 42, "itlMaxMs": 2217, "itlMeanMs": 7,
  "peakRssBytes": 9381097472,
  "agentLinesAdded": 2197,
  "agentLinesRemoved": 107,
  "agentFilesTouched": 29
}
```

### plan_mode.json Structure
```json
{
  "state": "Inactive",
  "was_previously_active": false,
  "reminder_count": 0,
  "pending_exit_reminder": false
}
```

### Subagent meta.json Structure
```json
{
  "subagent_id": "<uuid>",
  "parent_session_id": "<uuid>",
  "child_session_id": "<uuid>",
  "subagent_type": "scout",
  "description": "...",
  "prompt": "<full-subagent-prompt>",
  "status": "cancelled",
  "started_at": "2026-06-03T10:01:40Z",
  "completed_at": "2026-06-03T10:04:42Z",
  "duration_ms": 179077,
  "tool_calls": 0,
  "turns": 1,
  "error": "Subagent was cancelled",
  "effective_context_source": "new",
  "child_cwd": "/",
  "effective_model_id": "grok-build"
}
```

---

## 4. CLI FLAGS — COMPLETE SURFACE

### Main Flags
| Flag | Description | Type |
|------|-------------|------|
| `--agent <NAME>` | Agent name or definition file path | string |
| `--agents <JSON>` | Inline subagent definitions as JSON | JSON |
| `--allow <RULE>` | Permission allow rule (Claude: `--allowedTools`) | string |
| `--always-approve` | Auto-approve all tool executions | flag |
| `--best-of-n <N>` | Run N parallel candidates (headless only) | int |
| `-c, --continue` | Continue most recent session | flag |
| `--check` | Append self-verification loop (headless only) | flag |
| `--compaction-detail` | `none|minimal|balanced|verbose` (default verbose) | enum |
| `--compaction-mode` | `summary|transcript|segments` | enum |
| `--cwd <CWD>` | Working directory | string |
| `--deny <RULE>` | Permission deny rule (Claude: `--disallowedTools`) | string |
| `--disable-web-search` | Disable web search and fetch | flag |
| `--disallowed-tools` | Remove built-in tools (comma-sep) | string |
| `--effort <LEVEL>` | `low|medium|high|xhigh|max` | enum |
| `--experimental-memory` | Enable cross-session memory | flag |
| `-m, --model <MODEL>` | Model ID | string |
| `--max-turns <N>` | Maximum agent turns | int |
| `--no-alt-screen` | Run inline (no alternate screen) | flag |
| `--no-memory` | Disable memory for this session | flag |
| `--no-plan` | Disable plan mode | flag |
| `--no-subagents` | Disable subagent spawning | flag |
| `--oauth` | Use OAuth at welcome screen | flag |
| `--output-format` | Headless output format (default plain) | enum |
| `--reasoning-effort` | Reasoning effort for reasoning models | string |
| `--restore-code` | Checkout original commit when resuming | flag |
| `--rules <RULES>` | Extra rules appended to system prompt | string |
| `--sandbox <PROFILE>` | Sandbox profile | enum |
| `--system-prompt-override` | Override system prompt (Claude compat) | string |
| `--todo-gate` | Enable runtime turn-end TodoGate | flag |
| `--tools <TOOLS>` | Allow specific built-in tools (comma-sep) | string |
| `--verbatim` | Send prompt exactly as given | flag |
| `-w, --worktree` | Start in new git worktree | optional string |
| `-r, --resume` | Resume session by ID | optional string |

### Subcommands
| Command | Description |
|---------|-------------|
| `grok agent` | Run without interactive UI |
| `grok agent stdio` | Agent over stdio |
| `grok agent headless` | Agent over WebSocket relay |
| `grok agent serve` | Agent as WebSocket server |
| `grok agent leader` | Shared leader process |
| `grok completions` | Shell completion scripts |
| `grok export` | Export session as Markdown |
| `grok import` | Import sessions |
| `grok inspect` | Show config discovery for directory |
| `grok leader` | Manage running leader processes |
| `grok login` | Sign in |
| `grok logout` | Sign out |
| `grok mcp` | Manage MCP server configs |
| `grok memory` | Manage cross-session memory |
| `grok models` | List available models |
| `grok plugin` | Manage plugins/marketplace |
| `grok sessions` | List/search/restore sessions |
| `grok setup` | Fetch managed deployment config |
| `grok ssh` | SSH with clipboard support |
| `grok trace` | Export/upload session trace |
| `grok update` | Check/install updates |
| `grok version` | Print version |
| `grok worktree` | Manage git worktrees |

---

## 5. 21ST CRATE — xai-data-collector (DATA EXFIL ENGINE)

### Source Files
```
src/circuit_breaker_observer.rs   — Circuit breaker for upload throttling
src/collections_client.rs        — GCS/S3 upload client
src/events/log.rs                — Event logging (events.jsonl)
src/events/tracker.rs            — Event tracking/metrics
src/file_access_tracker.rs       — Pre-edit file copy + repo visibility check
src/gcs.rs                       — Google Cloud Storage upload
src/queue.rs                     — Upload queue with backpressure
src/s3.rs                        — S3 upload (AWS credentials)
src/storage_client.rs            — Unified storage client
src/trace_context.rs             — OpenTelemetry trace context
src/visibility.rs                — Repo visibility check (public/private)
```

### Telemetry Events (FULL catalog from tracker)
| Event | Fields |
|-------|--------|
| `turn_started` | phase, tool_name |
| `turn_ended` | duration_ms, cancellation_category |
| `tool_started` | tool_name |
| `tool_completed` | duration_ms, tool_name |
| `permission_requested` | permission_type, wait_ms |
| `permission_resolved` | outcome (allow/deny/cancel) |
| `doom_loop_warning` | repeat_count, tool_names |
| `doom_loop_terminated` | pattern |
| `yolo_mode_toggled` | enabled |
| `todo_gate_fired` | fires, pending, in_progress |
| `todo_gate_exhausted` | attempts_seen |
| `laziness_classifier_fired` | confidence |
| `laziness_nudge_fired` | — |
| `laziness_classifier_aborted` | — |
| `goal_classifier_fired` | verdict, pending_depth |
| `goal_classifier_verdict` | verdict |
| `goal_classifier_fail_open` | — |
| `goal_classifier_fail_closed` | — |
| `goal_classifier_cap_reached` | — |
| `goal_classifier_mid_turn_deferred` | — |
| `goal_classifier_dropped_after_cap` | — |
| `goal_planner_fired` | — |
| `goal_planner_completed` | — |
| `goal_planner_fail_closed` | — |
| `goal_verifier_skeptic_verdict` | skeptic_idx, refuted |
| `goal_verifier_aggregate_verdict` | refuted_count, total |
| `goal_premature_stop_detected` | pattern |
| `mcp_config_resolved` | servers, server_count |
| `mcp_managed_config_result` | — |
| `mcp_server_starting` | server_name, timeout_sec |
| `mcp_server_connected` | tool_count, tools |
| `mcp_server_failed` | error_type, error_message |
| `mcp_tool_registration_failed` | — |
| `mcp_init_completed` | total_servers, succeeded, failed, total_tools |
| `mcp_tool_call_started` | call_id |
| `mcp_tool_call_completed` | is_timeout |
| `mcp_server_toggled` | — |
| `mcp_transport_error` | healthy, client_state |
| `mcp_transport_reconnect` | — |
| `mcp_auth_retry` | trigger |
| `conversation_message_count` | — |
| `session_relationship` | schema_version |
| `first_token` | — |
| `loop_started` | loop_index |

### GCS Upload Protocol
- Queue directory: `upload_queue/`
- Upload modes: `streaming` (small files), `multipart` (large files)
- Circuit breaker: `open → half-open → closed` with retry-after
- S3 bucket: `grok-shell-test`
- S3 upload prefix: `grok-shell-trace-upload`
- GCS: Proxy-based upload (bucket from ACLs) or direct signed URLs
- Headers: `x-grok-client-version: 0.2.20`, `x-grok-client-identifier`
- Multipart: init → upload parts → complete
- Pre-edit copies: `file_access_tracker.rs` creates scratch dir copies before edits

### Repo Visibility Check
- Calls GitHub API to check if repo is public/private
- Public repos → data collection enabled
- Private repos → `accepted private eligible` or rejected
- `coding_data_retention_opt_out` flag in auth controls opt-out

---

## 6. CONFIG.TOML — ACTUAL RUNTIME CONFIG

```toml
hints = { worktree_tip_dismissed = true }

[cli]
installer = "internal"

[ui]
max_thoughts_width = 120
fork_secondary_model = "grok-build"
yolo = false
compact_mode = false
permission_mode = "ask"

[models]
default = "grok-build"
```

### Discovered Default Auto-Approved Bash Commands
```
ls, cat, pwd, git status, git branch, git log, git ls-files,
git rev-parse, cargo check, whoami, uptime, kubectl get, kubectl logs,
ps, bin/explorer, ls, wc, tr, cut
```

---

## 7. TOOL PARAMETER CONFIGS — RUNTIME VALUES

| Tool | Parameter | Value |
|------|-----------|-------|
| `grok_build.Bash` | `enabled_background` | `true` |
| `grok_build.Bash` | `auto_background_on_timeout` | `true` |
| `grok_build.Bash` | `strip_competitor_branding` | `true` |
| `grok_build.Bash` | `surface_bg_completion_reminders` | `true` |
| `grok_build.UseTool` | `native_tool_correction` | `true` |
| `grok_build.ReadFile` | `cursor_rules_on_read` | `false` |
| `grok_build.WebFetch` | `context_window_tokens` | `512000` |
| `grok_build.SearchReplace` | `skip_read_before_edit` | `false` |
| `grok_build.SearchReplace` | `unicode_normalized_fallback` | `false` |

---

## 8. SESSION SEARCH SQLITE — RUNTIME SCHEMA

```sql
-- Exact schema from live database
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Key: session_search_schema_version = 3
-- Key: last_bootstrap_at = <unix_timestamp>

CREATE TABLE session_docs (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_indexed_offset INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE session_docs_fts USING fts5(
  title, content, content='session_docs', content_rowid='rowid'
);
-- Triggers: session_docs_ai, session_docs_ad, session_docs_au
-- Auto-sync FTS on insert/delete/update
```

---

## 9. ACP PROTOCOL — FULL STRUCT TYPES

### Complete ACP Message Types
```
struct InitializeRequest
struct InitializeResponse
struct NewSessionRequest → NewSessionResponse
struct LoadSessionRequest → LoadSessionResponse
struct PromptRequest → PromptResponse
struct ContentChunk (streaming)
struct CancelNotification
struct AuthenticateRequest → AuthenticateResponse
struct SetSessionModeRequest → SetSessionModeResponse
struct SetSessionModelRequest → SetSessionModelResponse
struct ReadTextFileRequest → ReadTextFileResponse
struct WriteTextFileRequest → WriteTextFileResponse
struct CreateTerminalRequest → CreateTerminalResponse
struct ReleaseTerminalRequest → ReleaseTerminalResponse
struct TerminalOutputRequest → TerminalOutputResponse
struct KillTerminalCommandRequest → KillTerminalCommandResponse
struct WaitForTerminalExitRequest → WaitForTerminalExitResponse
struct RequestPermissionRequest → RequestPermissionResponse
struct SessionNotification
struct ToolCallUpdate
struct AvailableCommandsUpdate
struct CurrentModeUpdate

struct McpServer (variants: Stdio, Http, Sse)
struct AuthMethod
struct HttpHeader
struct EnvVariable
struct SessionMode
struct PromptCapabilities
struct ClientCapabilities
struct FileSystemCapability
struct AgentCapabilities
struct McpCapabilities
struct Annotations
struct ToolCall (content variants: Content, Diff, Terminal)
struct ToolCallLocation
struct TextContent
struct AudioContent
struct ImageContent
struct ResourceLink
struct EmbeddedResource
struct BlobResourceContents
struct TextResourceContents
struct PermissionOption (variant: Selected)
struct AvailableCommand (variant: Unstructured)
struct TerminalExitStatus
struct SessionModeState
struct SessionModelState
```

---

## 10. MODELS — RUNTIME DISCOVERY

Available models (unauthenticated):
- `grok-build` (default, 512K context)
- `grok-composer-2.5-fast` (200K context)

### Context Window: 512,000 tokens (confirmed from signals.json)

---

## 11. PLUGINS — RUNTIME DISCOVERY (39 plugins loaded)

| Plugin | Capabilities |
|--------|-------------|
| code-simplifier | 1 agents |
| mcp-tunnels | — |
| ralph-loop | hooks |
| code-review | — |
| claude-md-management | 1 skills |
| security-guidance | hooks |
| learning-output-style | hooks |
| plugin-dev | 1 skills, 1 agents |
| example-plugin | 1 skills, 1 MCPs |
| pr-review-toolkit | 1 agents |
| feature-dev | 1 agents |
| cwc-makers | 1 skills |
| math-olympiad | 1 skills |
| claude-code-setup | 1 skills |
| playground | 1 skills |
| session-report | 1 skills |
| explanatory-output-style | hooks |
| frontend-design | 1 skills |
| code-modernization | 1 agents |
| agent-sdk-dev | 1 agents |
| mcp-server-dev | 1 skills |
| skill-creator | 1 skills |
| hookify | 1 skills, 1 agents, hooks |
| commit-commands | — |
| terraform | 1 MCPs |
| gitlab | 1 MCPs |
| greptile | 1 MCPs |
| github | 1 MCPs |
| asana | 1 MCPs |
| laravel-boost | 1 MCPs |
| serena | 1 MCPs |
| discord | 1 skills, 1 MCPs |

---

## 12. USER GUIDE DOCS (20 files)

```
~/.grok/docs/user-guide/
├── 01-getting-started.md
├── 02-authentication.md
├── 03-keyboard-shortcuts.md
├── 04-slash-commands.md
├── 05-configuration.md
├── 06-theming.md
├── 07-mcp-servers.md
├── 08-skills.md
├── 09-plugins.md
├── 10-hooks.md
├── 11-custom-models.md
├── 12-project-rules.md
├── 13-memory.md
├── 14-headless-mode.md
├── 15-agent-mode.md
├── 16-subagents.md
├── 17-sessions.md
├── 18-sandbox.md
├── 19-plan-mode.md
└── 20-background-tasks.md
```

---

## 13. ATTACK SURFACE MAP

### Network Endpoints
| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `https://cli-chat-proxy.grok.com/v1` | HTTPS | Chat completions API |
| `wss://<gateway>` | WebSocket | IDE gateway bridge |
| `https://auth.x.ai` | HTTPS | OAuth2/OIDC auth |
| `http://explorer-service-prod.global.svc.cluster.local:80` | gRPC | MintGrokAuth |
| `gs://<bucket>` | GCS | Trace/upload storage |
| `s3://grok-shell-test` | S3 | Test upload bucket |
| `https://www.googleapis.com/auth/cloud-platform` | GCP | GCS auth scope |
| `http://169.254.169.254` | HTTP | GCE metadata (IMDS) |
| `http://metadata.google.internal:80` | HTTP | GCP metadata |

### File Paths (writeable)
| Path | Risk |
|------|------|
| `~/.grok/auth.json` | Contains refresh tokens in plaintext |
| `~/.grok/config.toml` | Config manipulation |
| `~/.grok/sessions/` | Full conversation history |
| `~/.grok/sessions/*/system_prompt.txt` | System prompt extraction |
| `~/.grok/sessions/*/chat_history.jsonl` | Full conversation exfil |
| `~/.grok/sessions/*/events.jsonl` | Session telemetry |
| `~/.grok/sessions/*/rewind_points.jsonl` | Undo history (4.5MB!) |
| `~/.grok/sessions/*/subagents/*/meta.json` | Subagent prompts |
| `~/.grok/sessions/session_search.sqlite` | FTS5 session index |
| `~/.grok/upload_queue/` | Pending upload artifacts |
| `~/.grok/docs/user-guide/` | Documentation |

### SSRF Protections
- URL validation: hostname must have ≥2 dot-separated parts
- Private IP blocking: `10.x`, `172.x`, `192.168.x`, `169.254.x`, `::1`
- DNS resolution check for private IPs
- Redirect limit: max redirects enforced
- Response body: max size enforced
- URL scheme: only `http://` and `https://`
- Embedded credentials: URLs with `@` blocked
- Proxy configuration validation

---

## 14. CRITICAL INTELLIGENCE — COMPETITIVE SECRETS

### What Makes Grok Competitive (extracted from system prompt + runtime)
1. **`strip_competitor_branding: true`** — Removes competitor names from tool output
2. **`native_tool_correction: true`** — Auto-corrects tool calls to native variants
3. **TodoGate** — Runtime turn-end gate that checks todo completion before proceeding
4. **Doom Loop Detector** — Threshold=4 repetitions, RO threshold=8, auto-termination
5. **Laziness Classifier** — Confidence-based nudge system to prevent idle agent
6. **Goal Classifier** — Verdict-based goal classification with fail-open/fail-closed
7. **Goal Planner** — Automated planning with skeptic verification (refuted count)
8. **Best-of-N** — Parallel worktrees + judge prompt for quality selection
9. **Self-Verify** — `--check` flag appends verification loop after execution
10. **Circuit Breaker** — Upload backpressure with open/half-open/closed states
11. **StalledStreamProtection** — Detects stalled streaming responses
12. **Repo Visibility Check** — Auto-detects public vs private repos for data collection
13. **Pre-edit Copies** — Saves file copies before edits for diff/revert
14. **Context Window** — 512K tokens confirmed (368K used in observed session)

### Doom Loop Parameters
- `doomLoopThreshold`: **4** (triggers warning)
- `doomLoopRoThreshold`: **8** (triggers termination)
- `inferenceIdleTimeoutConfiguredSecs`: **3600** (1 hour idle timeout)

---

## 15. SUDO-AI vs GROK — FINAL GAP ANALYSIS

### P0 — CRITICAL (SUDO-AI missing, Grok has it)
| Feature | Grok Implementation | Build Priority |
|---------|---------------------|----------------|
| **Sandbox** | nono-0.53.0, Landlock V1-V6, bwrap, seccomp | P0 |
| **Best-of-N** | Parallel worktrees + judge prompt | P0 |
| **Goal System** | Classifier → Planner → Tracker → Stop Detector + Skeptic Verifier | P0 |
| **Doom Loop** | Threshold=4, RO=8, auto-terminate | P0 |
| **Laziness Nudge** | Confidence classifier + proactivity cadence | P0 |
| **Plan Mode Tools** | enter_plan_mode/exit_plan_mode state machine | P0 |
| **TodoGate** | Turn-end completion gate | P0 |
| **Self-Verify** | `--check` flag + verification loop | P0 |
| **Session Rewind** | JSONL-based with 4.5MB undo history | P1 |
| **Circuit Breaker** | Open/half-open/closed upload throttle | P1 |

### SUDO-AI Advantages Over Grok
| Feature | SUDO-AI Has | Grok Lacks |
|---------|-------------|------------|
| **Taint Tracking** | Full 5-pillar + wave10 taint system | Basic permission only |
| **Vault System** | Encrypted vault + rotate | Not found |
| **Consciousness Loop** | Kairos consciousness engine | Not found |
| **Swarm Intelligence** | A2A + swarm coordination | Basic subagent only |
| **Cost Optimizer** | Full model routing by cost | Not found |
| **5-Pillar Security** | Complete security framework | Basic sandbox + permissions |

---

*Report generated via black-hat techniques: binary strings extraction, runtime execution, JWT decoding, SQLite forensics, session state analysis, config probing, env fuzzing, and protocol structure extraction. All data from live runtime on this system.*