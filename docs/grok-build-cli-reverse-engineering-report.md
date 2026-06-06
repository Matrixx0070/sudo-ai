# Grok Build CLI v0.2.22 — Deep Reverse Engineering Report

**Date**: 2026-06-06  
**Binary**: `/root/.grok/downloads/grok-0.2.22-linux-x86_64`  
**Size**: ~132MB (static PIE ELF, Rust compiled)  
**Build Hash**: 967574cb1  
**Source**: 20 internal Rust crates (`xai-grok-*`), **529 source files**  
**API Proxy**: `https://cli-chat-proxy.grok.com/v1`  
**Models**: `grok-build` (512K ctx), `grok-composer-2.5-fast` (200K ctx)  
**Sandbox Engine**: `nono-0.53.0` (Landlock/Seatbelt/bwrap)  
**Auth Service**: `explorer-service-prod.global.svc.cluster.local:80` (gRPC)  
**Protocol**: ACP (Agent Client Protocol) — JSON-RPC 2.0 over stdio/TCP/WS

---

## Table of Contents

1. [Architecture — Full Crate Map (529 files)](#1-architecture--full-crate-map-529-files)
2. [Complete Rust Source Tree](#2-complete-rust-source-tree)
3. [AgentDefinition (26 fields)](#3-agentdefinition-26-fields)
4. [Subagent System](#4-subagent-system)
5. [Best-of-N Judge System](#5-best-of-n-judge-system)
6. [Memory System — Full Internals](#6-memory-system--full-internals)
7. [Sandbox System — Full Internals](#7-sandbox-system--full-internals)
8. [Hook System — Full Internals](#8-hook-system--full-internals)
9. [Permission System](#9-permission-system)
10. [Plan Mode](#10-plan-mode)
11. [Goal Planner / Classifier / Tracker](#11-goal-planner--classifier--tracker)
12. [Doom Loop Detector](#12-doom-loop-detector)
13. [Laziness / Proactivity System](#13-laziness--proactivity-system)
14. [Feedback Tier System](#14-feedback-tier-system)
15. [Session Storage Architecture](#15-session-storage-architecture)
16. [Compaction System](#16-compaction-system)
17. [ACP (Agent Client Protocol) — Full Method Catalog](#17-acp-agent-client-protocol--full-method-catalog)
18. [Claude / Cursor Compatibility Layer](#18-claude--cursor-compatibility-layer)
19. [ZDR (Zero Data Retention)](#19-zdr-zero-data-retention)
20. [Image / Video Generation](#20-image--video-generation)
21. [Codebase Restore from GCS](#21-codebase-restore-from-gcs)
22. [Session Rewind / Snapshot System](#22-session-rewind--snapshot-system)
23. [Gateway Bridge (IDE Integration)](#23-gateway-bridge-ide-integration)
24. [CLI Flags & Commands](#24-cli-flags--commands)
25. [Environment Variables — Complete Catalog (242+)](#25-environment-variables--complete-catalog-242)
26. [System Prompt Templates](#26-system-prompt-templates)
27. [Effort Levels & Reasoning Config](#27-effort-levels--reasoning-config)
28. [Config.toml Settings](#28-configtoml-settings)
29. [Managed Deployment Config](#29-managed-deployment-config)
30. [SUDO-AI Gap Analysis & Priority Features](#30-sudo-ai-gap-analysis--priority-features)

---

## 1. Architecture — Full Crate Map (529 files)

| Crate | Files | Purpose |
|-------|-------|---------|
| `xai-grok-shell` | ~190 | Main REPL/TUI shell, ACP session, agent loop, auth, memory, compaction, goal system, doom loop, session storage, gateway bridge |
| `xai-grok-tools` | ~140 | Tool execution engine — grok_build, cursor, codex, opencode, grok_build_concise, grok_build_hashline, memory, skills, LSP, web search/fetch |
| `xai-grok-pager` | ~100 | Leader process, TUI rendering, scrollback, views, ACP bridge, session picker, themes, diff, slash commands, trace export |
| `xai-grok-agent` | ~18 | Agent discovery, definition parsing, subagent spawning, plugin manifest/trust/registry, prompt templates |
| `xai-grok-workspace` | ~28 | Workspace/project root, file system adapters, permission system, Claude compat, codebase restore, worktree ops |
| `xai-grok-hooks` | ~10 | Hook discovery, config, dispatch (command + HTTP runners), env expansion, trust |
| `xai-grok-mcp` | ~4 | MCP server credentials, liveness, OAuth, servers |
| `xai-grok-plugin-marketplace` | ~4 | Plugin marketplace config, git install, scanner |
| `xai-grok-sandbox` | ~3 | Landlock/Seatbelt/bwrap sandbox profiles, logging |
| `xai-grok-auth` | ~2 | Auth provider, retry middleware |
| `xai-grok-config` | ~4 | TOML config loading, paths, validation, shell |
| `xai-grok-telemetry` | ~8 | OpenTelemetry, Mixpanel, Sentry, GCS upload, sampling log |
| `xai-grok-sampler` | ~10 | Sampling actor, stream parsing (chat_completions, messages, responses), metrics |
| `xai-grok-sampling-types` | ~3 | Conversation types, error types, sampling types |
| `xai-grok-secrets` | ~1 | Secret/sensitive data sanitizer |
| `xai-grok-markdown` | ~6 | Markdown parse, render, streaming, syntax, hyperlinks, URL scan |
| `xai-grok-update` | ~3 | Auto-update, minimum version, version checking |
| `xai-grok-announcements` | ~1 | Product announcements |
| `xai-grok-subagent-resolution` | ~1 | Subagent type resolution, overrides |

---

## 2. Complete Rust Source Tree

### xai-grok-agent (18 files)
```
src/agent.rs              — Agent execution core
src/builder.rs            — Agent builder pattern
src/config.rs             — Agent configuration
src/discovery.rs          — Agent discovery from .grok/agents/, .claude/agents/
src/plugins/discovery.rs  — Plugin discovery (scope, collision resolution)
src/plugins/git_install.rs— Plugin git-based installation
src/plugins/hooks_adapter.rs — Plugin hooks → Grok hooks adapter
src/plugins/install_registry.rs — Install state persistence
src/plugins/manifest.rs   — Plugin manifest parsing (.grok-plugin/plugin.json, .claude-plugin/plugin.json)
src/plugins/marketplace.rs— Marketplace source management
src/plugins/registry.rs   — Plugin enable/disable registry
src/plugins/trust.rs      — Plugin trust store (trusted-plugins file)
src/prompt/agents_md.rs   — AGENTS.md parsing for agent definitions
src/prompt/context.rs     — Prompt context assembly
src/prompt/skills.rs      — Skills prompt injection
src/prompt/template.rs    — Prompt template rendering
src/prompt/user_message.rs— User message construction
src/timing.rs             — Agent timing/metrics
```

### xai-grok-shell (190 files — core engine)
```
src/agent/app.rs           — Agent app lifecycle
src/agent/auth_method.rs   — Auth method resolution (OAuth2, device-code, devbox, legacy)
src/agent/config.rs        — Agent config from config.toml
src/agent/feedback_client.rs — Feedback tier client
src/agent/handlers/session.rs — Session handler
src/agent/init.rs          — Agent initialization
src/agent/models.rs        — Model resolution
src/agent/mvp_agent.rs     — CORE: Main agent loop (10,000+ line file)
src/agent/proxy.rs         — HTTP proxy configuration
src/agent/relay.rs         — Request relay
src/agent/server.rs        — Agent server
src/agent/session_registry_client.rs — Session registry gRPC client
src/agent/subagent.rs      — Subagent spawning & management
src/agent/subscription_check.rs — Subscription tier check
src/agent/update_chunk_merge.rs — Streaming chunk merge

src/auth/attribution.rs    — Auth attribution
src/auth/config.rs         — Auth config
src/auth/credential_provider.rs — Credential provider (API key, OAuth)
src/auth/devbox_login.rs   — Devbox MintGrokAuth login
src/auth/device_code.rs    — Device-code auth flow
src/auth/external_auth.rs  — External auth provider
src/auth/flow.rs           — Auth flow orchestration
src/auth/jwt.rs            — JWT parsing
src/auth/manager.rs        — Auth manager (enrichment, lock submodules)
src/auth/model.rs          — Auth model types
src/auth/oidc/login.rs     — OIDC login
src/auth/oidc/protocol.rs  — OIDC protocol
src/auth/oidc/refresh.rs   — OIDC token refresh
src/auth/recovery.rs       — Auth recovery (401 → re-mint)
src/auth/refresh/external_refresher.rs — External token refresh
src/auth/refresh/oidc_refresher.rs — OIDC token refresh
src/auth/storage.rs        — Auth credential storage

src/builtin.rs             — Built-in capabilities registration
src/claude_import.rs       — Claude Code config import
src/claude_import_state.rs — Import state management
src/claude_session_import.rs — Claude session import

src/config/mod.rs          — Config TOML module
src/config/reloader.rs     — Hot config reload
src/config/watcher.rs      — Config file watcher
src/env.rs                 — Environment variable resolution

src/extensions/auth.rs     — ACP auth extension
src/extensions/billing.rs  — Billing/subscription extension
src/extensions/bundle.rs   — Bundle status/sync extension
src/extensions/code_nav.rs — Code navigation extension
src/extensions/debug.rs    — Debug extension
src/extensions/feedback.rs — Feedback collection extension
src/extensions/fs.rs       — File system extension
src/extensions/git.rs      — Git operations extension
src/extensions/hooks.rs    — Hooks extension
src/extensions/hunk_tracker.rs — File change tracking extension
src/extensions/interject.rs — Interjection extension
src/extensions/jj.rs       — Jujutsu VCS extension
src/extensions/marketplace.rs — Plugin marketplace extension
src/extensions/mcp.rs      — MCP extension
src/extensions/memory.rs   — Memory extension
src/extensions/plugins.rs  — Plugins extension
src/extensions/pr.rs       — PR extension
src/extensions/privacy.rs — Privacy/ZDR extension
src/extensions/prompt_history.rs — Prompt history extension
src/extensions/rewind.rs  — Session rewind extension
src/extensions/rollout.rs  — Feature rollout extension
src/extensions/search.rs   — Search extension
src/extensions/session_admin.rs — Session administration
src/extensions/session_search.rs — Session search extension
src/extensions/session_updates.rs — Session updates extension
src/extensions/share.rs    — Session sharing extension
src/extensions/skills.rs   — Skills extension
src/extensions/suggest/    — Suggestion system (AI, file, history, path providers)
src/extensions/task.rs     — Task management extension
src/extensions/terminal.rs — Terminal management extension
src/extensions/worktree.rs — Worktree management extension

src/gateway_bridge/auth.rs        — Gateway auth
src/gateway_bridge/connection.rs  — WS connection management (1,900 lines)
src/gateway_bridge/translator.rs  — Gateway protocol translation

src/session/acp_conversion.rs     — ACP message conversion
src/session/acp_session.rs        — CORE: ACP session (21,000+ line file)
src/session/acp_session_impl/cursor_describe.rs — Cursor tool description compat
src/session/acp_session_impl/goal.rs       — Goal planner impl
src/session/acp_session_impl/laziness.rs   — Laziness/proactivity detector
src/session/acp_session_impl/turn.rs      — Turn management

src/session/goal_classifier.rs    — Goal classification (with evidence sub-module)
src/session/goal_planner.rs       — Goal planning
src/session/goal_stop_detector.rs — Goal stop detection
src/session/goal_tracker.rs       — Goal state tracking

src/session/doom_loop/cursor_cross_message.rs — Cross-message doom detection
src/session/doom_loop/cursor_single_message.rs — Single-message doom detection
src/session/doom_loop/detector.rs — Doom loop detector

src/session/memory/archive.rs     — Memory archival
src/session/memory/backend.rs    — Memory backend (SQLite)
src/session/memory/chunker.rs    — Code chunking for indexing
src/session/memory/dream.rs      — Dream consolidation
src/session/memory/embedding.rs  — Embedding generation
src/session/memory/hooks.rs      — Memory hooks
src/session/memory/index.rs      — SQLite FTS5 + vec0 index
src/session/memory/mmr.rs        — Maximal Marginal Relevance
src/session/memory/mod.rs        — Memory module root
src/session/memory/search.rs     — Hybrid search (BM25 + vector)
src/session/memory/storage.rs   — Memory persistence
src/session/memory/watcher.rs    — File watcher for auto-indexing

src/session/compaction.rs        — Context compaction
src/session/plan_mode.rs        — Plan mode state machine
src/session/verification.rs      — Self-verification (--check)
src/session/worktree.rs          — Worktree management
src/session/worktree_pool.rs     — Worktree pool for best-of-N
src/session/restore.rs           — Session restore
src/session/restore_codebase.rs  — Codebase restore from GCS
src/session/restore_memory.rs   — Memory restore
src/session/fork.rs              — Session fork
src/session/merge.rs             — Session merge
src/session/signals.rs           — Session signals
src/session/feedback_manager.rs  — Feedback collection
src/session/file_access_tracker.rs — File access tracking
src/session/file_system.rs       — Session file system
src/session/managed_mcp.rs       — Managed MCP server config
src/session/mcp_descriptors.rs   — MCP tool descriptors
src/session/mcp_dispatcher.rs    — MCP tool dispatch
src/session/mcp_restart.rs       — MCP server restart
src/session/mcp_servers.rs       — MCP server lifecycle
src/session/image_describe.rs    — Image description
src/session/image_normalize.rs   — Image normalization
src/session/slash_commands.rs    — Slash command registry
src/session/prompt_parser.rs     — Prompt parsing
src/session/prompt_history.rs   — Prompt history
src/session/replay_events.rs     — Session replay
src/session/repo_changes.rs     — Repository change tracking
src/session/summary.rs          — Session summarization
src/session/telemetry.rs        — Session telemetry
src/session/tool_index.rs       — Tool indexing
src/session/user_message.rs     — User message construction
src/session/agent_rebuild.rs    — Agent rebuild on model change
src/session/context_file_collector.rs — Context file collection
src/session/persistence.rs      — Session persistence
src/session/normalize_cache.rs  — Cache normalization
src/session/placeholder_images.rs — Image placeholder handling
src/session/fs_notify_adapters.rs — File system notification
src/session/helpers/compaction_context.rs — Compaction helpers
src/session/helpers/memory_flush.rs   — Memory flush helpers
src/session/helpers/replay.rs          — Replay helpers
src/session/helpers/session_compact.rs — Compact helpers
src/session/helpers/session_summary.rs — Summary helpers

src/session/storage/jsonl.rs  — JSONL session storage
src/session/storage/mod.rs    — Storage module
src/session/storage/search.rs — Session search (SQLite FTS5)

src/upload/gcs.rs      — GCS upload
src/upload/manifest.rs — Upload manifest
src/upload/trace.rs    — Trace upload
src/upload/turn.rs     — Turn upload
src/upload/visibility.rs — Upload visibility

src/terminal/acp_terminal.rs       — ACP terminal
src/terminal/adapter.rs            — Terminal adapter
src/terminal/background_task.rs    — Background task terminal
src/terminal/local_terminal.rs     — Local terminal
src/terminal/mod.rs                — Terminal module
src/terminal/pty_session.rs       — PTY session
src/terminal/streaming_local_terminal.rs — Streaming terminal

src/tools/notification_bridge.rs — Notification bridge

src/leader/client.rs   — Leader client
src/leader/mod.rs      — Leader module
src/leader/protocol.rs — Leader protocol
src/leader/server.rs   — Leader server

src/relay/sync.rs      — Relay sync

src/remote/agent.rs   — Remote agent
src/remote/client.rs  — Remote client
src/remote/pull.rs    — Remote pull
src/remote/sync.rs    — Remote sync

src/sampling/error.rs  — Sampling error handling

src/inspect/mod.rs    — Inspect command
src/instrumentation.rs — Instrumentation

src/mcp_doctor.rs     — MCP diagnostics
src/models.rs         — Model definitions
src/plugin.rs         — Plugin loading
src/http.rs           — HTTP server
```

### xai-grok-tools (140 files — tool implementations)
```
# Grok Build tools (primary)
src/implementations/grok_build/bash/          — Bash execution
src/implementations/grok_build/read_file/     — File reading
src/implementations/grok_build/grep/          — Grep (ripgrep integration)
src/implementations/grok_build/list_dir/      — Directory listing
src/implementations/grok_build/search_replace/ — Search & replace edit
src/implementations/grok_build/web_fetch/      — Web fetch (SSRF protection, domain allowlist)
src/implementations/grok_build/web_search/    — Web search
src/implementations/grok_build/skill/         — Skill execution
src/implementations/grok_build/task/          — Background task management (backend)
src/implementations/grok_build/task_output/   — Task output + wait_tasks
src/implementations/grok_build/todo/          — Todo management
src/implementations/grok_build/enter_plan_mode/— Plan mode entry
src/implementations/grok_build/exit_plan_mode/ — Plan mode exit
src/implementations/grok_build/ask_user_question/ — Ask user
src/implementations/grok_build/kill_task/     — Kill background task
src/implementations/grok_build/scheduler/    — Cron scheduler (actor, create, delete, list, types)
src/implementations/grok_build/lsp/          — LSP integration
src/implementations/grok_build/monitor/      — Monitor (event, rate_limiter, tool, types)
src/implementations/grok_build/update_goal/  — Goal update
src/implementations/grok_build/image_gen/    — Image generation
src/implementations/grok_build/image_edit/    — Image editing
src/implementations/grok_build/video_gen/    — Video generation
src/implementations/grok_build/storage.rs    — Tool storage

# Cursor-compatible tools
src/implementations/cursor/ask_question.rs   — Ask user question
src/implementations/cursor/await_shell.rs   — Await shell
src/implementations/cursor/create_plan.rs   — Create plan
src/implementations/cursor/delete.rs        — File delete
src/implementations/cursor/edit_notebook.rs — Notebook edit
src/implementations/cursor/fetch_mcp_resource.rs — MCP resource fetch
src/implementations/cursor/file_operation_lock.rs — File lock
src/implementations/cursor/generate_image.rs — Image generation
src/implementations/cursor/glob.rs         — Glob
src/implementations/cursor/grep.rs         — Grep
src/implementations/cursor/list_mcp_resources.rs — List MCP resources
src/implementations/cursor/mcp.rs          — MCP tool call
src/implementations/cursor/read.rs         — File read
src/implementations/cursor/read_lints.rs   — Lint reading
src/implementations/cursor/shell.rs        — Shell execution
src/implementations/cursor/str_replace/    — String replace edit
src/implementations/cursor/switch_mode.rs  — Mode switching
src/implementations/cursor/task.rs         — Task management
src/implementations/cursor/terminals.rs   — Terminal management
src/implementations/cursor/todo_write.rs   — Todo write
src/implementations/cursor/vm_daemon.rs    — VM daemon
src/implementations/cursor/web_fetch.rs    — Web fetch
src/implementations/cursor/web_search.rs   — Web search
src/implementations/cursor/write.rs        — File write

# Codex-compatible tools
src/implementations/codex/apply_patch/ — Patch application (apply, parser, seek_sequence, tool)
src/implementations/codex/grep_files/ — Grep files
src/implementations/codex/list_dir/   — List directory
src/implementations/codex/read_file/  — Read file (indentation, slice, text_utils, tool)

# OpenCode-compatible tools
src/implementations/opencode/bash/ — Bash
src/implementations/opencode/edit/ — Edit
src/implementations/opencode/glob/ — Glob
src/implementations/opencode/grep/ — Grep
src/implementations/opencode/read/ — Read
src/implementations/opencode/skill/ — Skill
src/implementations/opencode/todowrite/ — Todo write
src/implementations/opencode/write/ — Write

# Concise tools (lightweight variants)
src/implementations/grok_build_concise/bash.rs
src/implementations/grok_build_concise/read_file.rs
src/implementations/grok_build_concise/search_replace.rs

# Hashline tools (line-number based edit)
src/implementations/grok_build_hashline/config.rs
src/implementations/grok_build_hashline/edit/ — apply, mod, types
src/implementations/grok_build_hashline/grep.rs
src/implementations/grok_build_hashline/read_file.rs
src/implementations/grok_build_hashline/scheme.rs

# Memory tools
src/implementations/memory/get_tool.rs   — Memory retrieval
src/implementations/memory/search_tool.rs— Memory search
src/implementations/memory/types.rs     — Memory types

# Search/skill/LSP tools
src/implementations/search_tool/     — Search tool (mod, types)
src/implementations/skills/          — Skill discovery & execution
src/implementations/use_tool/        — Generic tool use
src/implementations/lsp/             — LSP client, config, dispatch, manager, restart, types
src/implementations/web_search/client.rs — Web search client
src/implementations/read_file/image.rs   — Image reading
src/implementations/read_file/pdf.rs     — PDF reading
src/implementations/cursor_rules_on_read.rs — Cursor rules injection

# Types & utilities
src/types/agents_md_tracker.rs   — AGENTS.md tracking
src/types/api_key_provider.rs    — API key provider
src/types/description.rs         — Tool description
src/types/error.rs              — Tool error types
src/types/file_read_tracker.rs  — File read tracking
src/types/resources.rs          — Resource types
src/types/schema.rs             — Schema types
src/types/skill_discovery_tracker/ — Skill tracking
src/types/template_renderer.rs  — Template rendering
src/types/tool_metadata.rs      — Tool metadata
src/persistence.rs              — Tool persistence
src/registry/types.rs           — Registry types
src/reminders/                  — Prompt reminders (agents_md, lsp_diagnostics, skill_discovery, task_completion, todo_nudge)
src/retry.rs                    — Tool retry logic
src/versions.rs                 — Tool versioning
src/util/                       — fs, hash, path_suggestions, sanitize, truncate
src/attribution.rs              — Tool attribution
src/bridge.rs                   — Tool bridge
src/computer/                   — Local computer (cgroup, file_system, shell_state, terminal)
```

### xai-grok-pager (100 files — TUI)
```
src/main.rs                    — Entry point
src/acp/leader_bridge.rs       — ACP leader bridge
src/acp/spawn.rs               — ACP spawn
src/acp/tracker.rs             — ACP tracker
src/app/acp_handler.rs         — ACP handler
src/app/agent.rs               — Agent state
src/app/agent_view.rs          — Agent view
src/app/app_view.rs            — Main app view
src/app/dispatch.rs            — TUI event dispatch (6,500+ lines)
src/app/effects.rs             — Side effects
src/app/event_loop.rs          — Event loop
src/app/link_opener.rs         — Link opener
src/app/signal_handler.rs      — Signal handling
src/app/subagent.rs            — Subagent UI
src/appearance/                — Theme/appearance (config, watcher)
src/config_toml_edit.rs        — Config editing
src/diff.rs                    — Diff display
src/docs.rs                    — Documentation
src/export_cmd.rs              — Export command
src/git_info.rs                — Git info display
src/headless.rs                — Headless mode
src/import_cmd.rs              — Import command
src/models.rs                  — Model definitions
src/notifications/             — Notification system (sleep, title)
src/plugin_cmd.rs              — Plugin command
src/prompt_images.rs           — Prompt image handling
src/render/                    — Rendering (draw, line_utils, scrollbar, wrapping)
src/scrollback/                — Scrollback (blocks, entry, export, render, scrollback_pane, state, text_selection)
src/sessions_cmd.rs            — Sessions command
src/settings/registry.rs       — Settings registry
src/share_cmd.rs               — Share command
src/slash/                     — Slash commands (export, import_claude, loop_cmd, model, registry)
src/ssh_cmd.rs                 — SSH command
src/terminal/                  — Terminal (image, mod)
src/theme/system_appearance.rs — System theme detection
src/trace_cmd.rs               — Trace export
src/tracing.rs                 — Tracing setup
src/unified_log.rs             — Unified logging
src/util.rs                    — Utilities
src/views/                     — UI views (agent, agents_modal, dashboard, extensions_modal, file_search, history_search, import_claude_modal, list_pane, memory_modal, modal_window, permission_view, persona_detail, picker, plan_approval_view, prompt_widget, question_view, session_picker, sessions_modal, settings_modal, suggestion_controller, tasks_pane, welcome)
src/worktree_cmd/              — Worktree command (display, mod)
```

---

## 3. AgentDefinition (26 fields)

The `AgentDefinition` struct has exactly **26 fields**:

| # | Field | Type | Description |
|---|-------|------|-------------|
| 1 | `name` | String | Agent identifier |
| 2 | `description` | String | Human-readable description |
| 3 | `instructions` | String | Inline instructions (system prompt) |
| 4 | `instructions_file` | String | Path to instructions file |
| 5 | `model` | String | Model override |
| 6 | `agent_type` | String | Agent type key |
| 7 | `capabilities` | SubagentCapabilityMode | "read-only", "read-write", "execute", "ALL" |
| 8 | `tools` | ToolConfig | Tool configuration (7 elements) |
| 9 | `skills` | SkillsConfig | Skills configuration |
| 10 | `mcp` | ToolServerConfig | MCP server config (2 elements) |
| 11 | `mcpInheritance` | String | "default", "cursor", or {"custom": "..."} |
| 12 | `params` | Map | Override parameters |
| 13 | `name_override` | String | Override agent display name |
| 14 | `params_name_overrides` | Map | Per-param name overrides |
| 15 | `description_override` | String | Override description |
| 16 | `behavior_preset` | String | Behavior preset ("all", "none", {"named": [...]}, {"except": [...]}) |
| 17 | `recovery` | RecoveryPolicy | Recovery policy (3 elements) |
| 18 | `max_turns` | u32 | Maximum turns |
| 19 | `timeout` | Duration | Execution timeout |
| 20 | `sandbox` | bool | Enable sandbox |
| 21 | `sandbox_profile` | String | Sandbox profile name |
| 22 | `fork_secondary_model` | bool | Fork with secondary model |
| 23 | `auto_compact` | bool | Enable auto-compaction |
| 24 | `compaction_mode` | String | Compaction mode |
| 25 | `subagent_type` | String | Default subagent type |
| 26 | `prompt_extension` | String | Additional prompt text |

### SubagentCapabilityMode
- `read-only` / `read_write` / `execute` / `ALL`
- Determines which tool categories the subagent can access

### ToolConfig (7 elements)
1. `allowed_tools` — List of allowed tool names
2. `denied_tools` — List of denied tool names
3. `auto_approved_tools` — Tools that skip permission prompts
4. `tool_descriptions` — Custom tool description overrides
5. `max_tool_calls` — Maximum tool calls per turn
6. `tool_timeout` — Tool execution timeout
7. `tool_retry` — Tool retry configuration

### CompletionRequirement (3 elements)
1. `type` — Completion type
2. `condition` — Completion condition
3. `message` — Completion message

### RecoveryPolicy (3 elements)
1. `max_retries` — Maximum retry attempts
2. `backoff_ms` — Backoff duration in ms
3. `on_failure` — Failure action ("abort", "escalate", "continue")

---

## 4. Subagent System

### Subagent Types
| Type | Purpose |
|------|---------|
| `general-purpose` | Default subagent for most tasks |
| `explore` | Read-only search agent for broad fan-out searches |
| `plan` | Software architect agent for implementation planning |

### Tool Categories (per capability mode)
| Tool | read-only | read-write | execute | ALL |
|------|-----------|-----------|---------|-----|
| `delete` | ❌ | ✅ | ✅ | ✅ |
| `write` | ❌ | ✅ | ✅ | ✅ |
| `search` | ✅ | ✅ | ✅ | ✅ |
| `lsp` | ✅ | ✅ | ✅ | ✅ |
| `web_search` | ✅ | ✅ | ✅ | ✅ |
| `web_fetch` | ✅ | ✅ | ✅ | ✅ |
| `background_task_action` | ❌ | ❌ | ✅ | ✅ |
| `wait_tasks_action` | ❌ | ❌ | ✅ | ✅ |
| `skill` | ✅ | ✅ | ✅ | ✅ |
| `memory_search` | ✅ | ✅ | ✅ | ✅ |
| `memory_get` | ✅ | ✅ | ✅ | ✅ |
| `enter_plan` | ✅ | ✅ | ✅ | ✅ |
| `exit_plan` | ✅ | ✅ | ✅ | ✅ |
| `image_gen` | ❌ | ❌ | ✅ | ✅ |
| `video_gen` | ❌ | ❌ | ✅ | ✅ |
| `image_to_video` | ❌ | ❌ | ✅ | ✅ |
| `reference_to_video` | ❌ | ❌ | ✅ | ✅ |
| `search_tool` | ✅ | ✅ | ✅ | ✅ |
| `monitor` | ❌ | ❌ | ✅ | ✅ |
| `goal_update` | ✅ | ✅ | ✅ | ✅ |
| `other` | ❌ | ✅ | ✅ | ✅ |

### MCP Inheritance
- `"default"` — Inherit MCP servers from parent session
- `"cursor"` — Use Cursor-style MCP config resolution
- `{"custom": "..."}` — Custom MCP server list
- `{"named": [...]}` — Named MCP servers only
- `{"except": [...]}` — All except listed

---

## 5. Best-of-N Judge System

**Full Judge Prompt:**

```
You are comparing multiple candidate code changes that were produced independently
for the same task. Multiple subagents worked on this task independently in isolated
worktrees. Your job is to choose the single best candidate.

For each candidate you will see:
- Its worktree path (the directory containing its changes)
- Its summary (the subagent's own description of what it did)

# Evaluation Criteria

Evaluate each candidate on these axes, in order of importance:

1. **Correctness** 
   Does the candidate actually solve the task? Does it handle the requirements
   completely, or does it miss important aspects? Are there logic errors, type
   errors, or broken imports?

2. **Code Quality** 
   Is the code clean, readable, and well-structured? Does it follow the patterns
   and conventions of the surrounding codebase? Does it avoid unnecessary
   complexity?

3. **Safety** 
   Does the candidate avoid introducing bugs, security issues, or breaking
   changes to existing functionality?

# How to Decide

- Focus on correctness first. A candidate that fully solves the task with minor
  style issues beats one that is beautifully written but incomplete or wrong.
- If multiple candidates are equally correct, prefer the one with cleaner code
  and better codebase integration.
- If a candidate introduces unnecessary changes beyond the task scope, count
  that against it.
- If all candidates are poor, still pick the least bad one.

# Presenting Your Evaluation

Before announcing your choice, present a structured comparison of all candidates.

First, a scorecard summarizing each candidate across the evaluation dimensions:

| Dimension | Candidate 1 | Candidate 2 | ... |
|-----------|-------------|-------------|-----|
| Correctness | Short verdict | Short verdict | ... |
| Code Quality | Short verdict | Short verdict | ... |
| Safety | Short verdict | Short verdict | ... |

Then, list the key concrete findings that informed your decision:

| Finding | Severity | Candidate 1 | Candidate 2 | ... |
|---------|----------|-------------|-------------|-----|
| Specific issue or difference | High/Medium/Low | How this candidate handled it | How this candidate handled it | ... |

After the comparison, state which candidate you chose and why.

# After Choosing
```

**Environment Variable**: `GROK_BEST_OF_N_CANDIDATES` — number of parallel candidates

---

## 6. Memory System — Full Internals

### SQLite Schema

```sql
-- Main chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  text TEXT,
  hash TEXT,
  source TEXT,      -- "memory" | "file" | "user"
  access_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  last_accessed TEXT
);

-- FTS5 full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content=''
);

-- Vector search (sqlite-vec)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[embedding_dimensions]
);

-- Meta table (key-value)
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Keys: embedding_dimensions, reindex_claim, schema_version

-- Session search DB
CREATE TABLE IF NOT EXISTS session_docs (
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT,
  cwd TEXT,
  modified_epoch_secs INTEGER,
  content_hash TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(
  title, content
  -- cwd is NOT in the FTS table
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Key: session_search_schema_version, last_bootstrap_at

-- Worktrees table
CREATE TABLE IF NOT EXISTS worktrees (...);
```

### Search Algorithm
- **Hybrid search**: 70% vector (cosine similarity) + 30% BM25 (FTS5)
- **MMR** (Maximal Marginal Relevance): Diversity re-ranking to avoid redundant results
- **BM25 scoring**: `bm25(session_docs_fts, 10.0, 1.0) AS rank`
- **Vector search**: `SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ?1 AND k = ?2 ORDER BY distance`
- **Fallback**: When sqlite-vec not available → FTS-only search

### Key Queries
```sql
-- FTS search with source filter
SELECT f.rowid, f.rank FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid
  WHERE chunks_fts MATCH ?1 AND c.source IN ()
  ORDER BY f.rank LIMIT ?2

-- Access tracking (temporal decay)
UPDATE chunks SET access_count = access_count + 1, last_accessed = ?1 WHERE id = ?2

-- Chunk upsert
INSERT INTO chunks (id, path, start_line, end_line, text, hash, source, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)

-- FTS sync on delete
INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?1, ?2)

-- Orphan detection (chunks without vectors)
SELECT c.id, c.text FROM chunks c LEFT JOIN chunks_vec_rowids v ON v.id = c.id WHERE v.id IS NULL

-- Reindex claim (mutex)
INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)
UPDATE meta SET value = '' WHERE key = 'reindex_claim'
```

### Dream Consolidation
- `session/memory/dream.rs` — Background consolidation process
- Triggers during idle periods
- Merges similar chunks, removes duplicates
- Updates access patterns based on temporal decay

### File Indexing
- `session/memory/chunker.rs` — Splits code files into chunks
- `session/memory/watcher.rs` — Watches for file changes to auto-reindex
- `session/memory/embedding.rs` — Generates embeddings for chunks
- Journal mode: WAL (Write-Ahead Logging)
- Busy timeout: configurable

### MEMORY.md
- Stored at `~/.grok/memory/MEMORY.md`
- Cross-session persistent memory
- Updated by `memory_search` and `memory_get` tools

---

## 7. Sandbox System — Full Internals

### Engine: `nono-0.53.0`
- Path in binary: `/local/cargo-home/registry/src/index.crates.io-1949cf8c6b5b557f/nono-0.53.0/src/sandbox/linux.rs`
- Full Landlock implementation with ABI version negotiation

### Profiles

| Profile | Description | Filesystem | Network | Signals |
|---------|-------------|-----------|---------|---------|
| `off` | No sandbox | Full access | Full access | Full access |
| `workspace` | Workspace-only | Read/write workspace, read system | Blocked (seccomp) | Same sandbox |
| `read-only` | Read-only | Read workspace + system | Blocked (seccomp) | Same sandbox |
| `strict` | Maximum restriction | Read system only | Full block (seccomp) | Isolated |

### Profile Config (config.toml)
```toml
[sandbox]
profile = "workspace"          # off | workspace | read-only | strict
read_write_paths = []          # Additional writable paths
restrict_network = true         # Block network in child processes
```

### Landlock Implementation (Linux)
- **ABI Detection**: Checks kernel for Landlock ABI V1-V6+
- **ABI V1-V3**: Filesystem access control only
- **ABI V4+**: TCP network filtering added
- **ABI V6+**: Signal scoping (`LANDLOCK_SCOPE_SIGNAL`)
- **Flags**: `BitFlags<AccessFs>`, `BitFlags<AccessNet>`, `BitFlags<Scope>`
- **Fallback chain**: Landlock → bwrap (bubblewrap) → seccomp → no sandbox
- **Seccomp**: Full-network-block or proxy-only fallback when Landlock ABI < V4

### bwrap (Bubblewrap) Implementation
- Environment variable: `__GROK_INSIDE_BWRAP`
- Flags: `--bind`, `--ro-bind`, `--dev-bind`, `--proc`, `--unshare-net`
- Auto-installs: `apt install -y bubblewrap`
- Falls back to Landlock if bwrap exec fails

### Seatbelt Implementation (macOS)
- Apple Seatbelt framework for macOS sandboxing
- Profile-based restrictions

### Sandbox Events (logged)
```json
{
  "event_type": "ProfileApplied | ApplyFailed | FsViolation | NetViolation | BypassGranted | BypassDenied",
  "timestamp": "...",
  "operation": "...",
  "target": "...",
  "command": "...",
  "tool_call_id": "..."
}
```

### Key Paths Protected
- `/dev/tty`, `/dev/pts/` — Device access
- `/Library/` — macOS system
- `/private/` — macOS private dirs
- `TMPDIR`, `.gnupg`, `.grok`, `.config`, `.gcloud`, `.azure` — User config dirs
- `timestampevent_typeplatformenforced` — Metadata

### Network Restriction
- `restrict_network` blocks network in **child processes** (bash commands, scripts)
- Built-in tools making HTTP in-process (web search, LLM API) are **NOT** affected
- Blocks: `curl`, `wget`, `npm install` in child processes
- Seccomp: Full-network-block or proxy-only (specific ports)

---

## 8. Hook System — Full Internals

### Hook Events (9 core events + 2 Cursor compat)

| Event | When | Runner Type |
|-------|------|-------------|
| `SessionStart` | Session begins | void |
| `SessionEnd` | Session ends | void |
| `UserPromptSubmit` | Before prompt sent to model | modifying |
| `PreToolUse` | Before tool execution | claiming |
| `PostToolUse` | After tool execution | modifying |
| `PostToolUseFailure` | After tool failure | claiming |
| `PreCompact` | Before context compaction | modifying |
| `Stop` | Agent stops | void |
| `Notification` | Notification event | void |
| `SubagentStart` | Subagent spawns (Cursor compat) | void |
| `SubagentStop` | Subagent completes (Cursor compat) | void |

### Hook Config
```toml
[[hooks]]
event = "PreToolUse"
command = "/path/to/script"
timeout = 30
```

### Hook Runner Types
- **command** — Execute external command
- **http** — POST to HTTP endpoint

### Hook Environment Variables
```
GROK_HOOK_EVENT    — Event name
GROK_HOOK_NAME     — Hook display name
GROK_SESSION_ID    — Current session ID
GROK_WORKSPACE_ROOT— Project root
CLAUDE_PROJECT_DIR — Claude compat project dir
```

### Hook Discovery Paths
- `~/.grok/hooks.json` — User hooks
- `<cwd>/.grok/hooks.json` — Project hooks
- `~/.cursor/hooks.json` — Cursor compat (configurable)
- `<cwd>/.cursor/hooks.json` — Cursor compat (configurable)

### Hook Trust
- Project hooks require project trust
- `xai-grok-hooks/src/trust.rs` — Trust verification

---

## 9. Permission System

### Permission Modes

| Mode | Description |
|------|-------------|
| `default` | Ask for dangerous operations |
| `dontAsk` | Auto-approve previously approved |
| `bypassPermissions` | Auto-approve everything |
| `acceptEdits` | Auto-approve file edits |
| `plan` | Only plan, don't execute |
| `auto` | Auto-approve with policy checks |

### Permission State (persisted)
```toml
# permission.toml / permission_.toml
edit_policy = "Allow"
allow_bash_execute = false
allowed_bash_commands = ["ls", "cat", "pwd", "git status", ...]
disallowed_bash_commands = []
allowed_web_fetch_domains = []
allowed_mcp_tools = []
allowed_mcp_servers = []
```

### Permission Prompt Options
| Option | Description |
|--------|-------------|
| `allow-always-command` | Always allow this specific command |
| `allow-always-domain` | Always allow this domain |
| `allow-always-mcp-tool` | Always allow this MCP tool |
| `allow-always-mcp-server` | Always allow this MCP server |
| `allow-edits-session` | Allow all edits for this session |
| `allow-always-approve` | Enable YOLO/always-approve mode |
| `reject-once` | Reject this time |
| `reject-always-bash` | Never run this bash command |

### YOLO Mode
- `always-approve` — Auto-approve everything
- Still respects **deny rules** from permission policy
- `permission policy: deny rule matched (enforced before YOLO)`

---

## 10. Plan Mode

### State Machine
```
Normal → /plan → PlanMode → Submit for approval → PlanApproval → Accept → Execute
                                    ↓
                                 Reject → PlanMode (revise)
```

### ACP Methods
- `xai/toggle_plan_mode` — Toggle plan mode
- `xai/exit_plan_mode` — Exit plan mode

### State Files
- `plan_mode.json` — Plan mode state
- `plan.json` — Plan content

### UI Components
- `views/plan_approval_view.rs` — Plan approval UI
- `xai-grok-shell/src/session/plan_mode.rs` — Plan mode state machine

---

## 11. Goal Planner / Classifier / Tracker

### Architecture
```
User Prompt → Goal Classifier → Goal Planner → Goal Tracker → Goal Stop Detector
                     ↓                              ↓
           goal_classifier.rs               goal_planner.rs
           goal_classifier/evidence.rs      
                         ↓
               goal_tracker.rs
                         ↓
             goal_stop_detector.rs
```

### Goal Classifier
- Classifies the type of goal (feature, bugfix, refactor, etc.)
- Evidence-based classification with confidence scores
- Environment: `GROK_GOAL_CLASSIFIER`, `GROK_GOAL_CLASSIFIER_MAX`

### Goal Planner
- Creates structured plan from classified goal
- Snapshots plan baseline for `PLAN_CHANGES` detection
- Requires `subagent_coordinator_channel` to function
- Skips if plan already present
- Logs: `goal planner: plan already present; skipping`
- Logs: `goal planner: no subagent coordinator channel; skipping`
- Logs: `goal planner: failed to snapshot plan baseline; PLAN_CHANGES will render (none)`

### Goal Tracker
- Tracks goal state through execution
- Updated by `update_goal` tool
- Log patterns: `Goal: ...`, `Goal: update`, `Goal: marking complete`

### Goal Stop Detector
- Detects when goal is complete
- Triggers session end or transition

### Environment Variables
```
GROK_GOAL_PLANNER         — Enable/disable goal planner
GROK_GOAL_VERIFIER_N      — Number of verification rounds
GROK_GOAL_CLASSIFIER      — Enable/disable goal classifier
GROK_GOAL_CLASSIFIER_MAX  — Max classifications
```

---

## 12. Doom Loop Detector

### Architecture
```
xai-grok-shell/src/session/doom_loop/
├── cursor_cross_message.rs   — Detects cross-message repetition
├── cursor_single_message.rs  — Detects single-message loops
└── detector.rs              — Main detector
```

### Detection Patterns
- **Cross-message**: Agent repeats same pattern across different messages
- **Single-message**: Agent loops within a single message
- Based on Cursor's doom loop detection (compatibility)

### Actions
- Warning displayed to user
- Auto-intervention after threshold
- Suggests switching approach

---

## 13. Laziness / Proactivity System

### Architecture
```
xai-grok-shell/src/session/acp_session_impl/laziness.rs
```

### Configuration
```toml
[proactivity]
proactivity_reminder_cadence = ...   # How often to remind
proactivity_reminder_threshold = ...  # Inactivity threshold
```

### Environment Variables
```
GROK_DEBUG_PROACTIVITY_CADENCE    — Debug: override cadence
GROK_DEBUG_PROACTIVITY_THRESHOLD  — Debug: override threshold
```

### Behavior
- Detects when agent is being "lazy" (not taking proactive actions)
- Sends proactivity reminders at configured cadence
- Threshold determines how long before first nudge
- Related to "idle_threshold_secs" in TUI settings

---

## 14. Feedback Tier System

### 3 Tiers

| Tier | Name | Criteria | Message |
|------|------|----------|---------|
| 1 | `tier1_sustained_engagement` | `turns >= 10 AND tool_calls >= 5 AND compactions >= 2 AND cancellations == 0` | "You've been using Grok Code productively! Would you mind sharing quick feedback?" |
| 2 | `tier2_complex_recovery` | `turns >= 15 AND tool_calls >= 10 AND compactions >= 3 AND errors >= 1` | "You've worked through a complex session. Your feedback would help us improve." |
| 3 | `tier3_friction_recovery` | `(cancellations > 0 OR has_reverted)` | "Thanks for sticking with us through that session. Got a moment to share feedback?" |

### Feedback State
- **Not sampled** — Below tier thresholds
- **Sampled for feedback** — Meets tier criteria
- **Feedback collection is disabled** — `GROK_FEEDBACK_ENABLED = false`
- **In cooldown period** (N seconds remaining) — Rate limited
- **No feedback tier criteria met** — No tier matched
- **Max feedback requests reached** — Cap hit

### Metrics Tracked
- `toolCallsCount`
- `errorsCount`
- `cancellationsCount`

---

## 15. Session Storage Architecture

### Files

| File | Purpose |
|------|---------|
| `state.json` | Session state (model, mode, config) |
| `plan_mode.json` | Plan mode state |
| `plan.json` | Plan content |
| `tool_state.json` | Tool state (may be directory) |
| `rewind_points.jsonl` | Rewind/snapshot points |
| `feedback.jsonl` | Feedback records |
| `btw_history.jsonl` | "By the way" feedback history |
| `signals.json` | Session signals |
| `summary.json` | Session summary (may be empty) |
| `chat_history.jsonl` | Full conversation log |
| `updates.jsonl` | Session update stream |
| `announcement_state.json` | Announcement dismiss state |
| `reasoning_content` | Extended thinking content |
| `compaction_checkpoints/` | Compaction checkpoint directory |
| `subagents/` | Subagent state directory |
| `session_search.sqlite` | Session search index (FTS5) |

### JSONL Storage
- `xai-grok-shell/src/session/storage/jsonl.rs` — Core JSONL implementation
- Append-only for performance
- Supports replay (`session/helpers/replay.rs`)
- Handles malformed entries gracefully: "skipping malformed update", "rewind_updates_jsonl: preserving unparseable line unchanged"

### Session Search
- SQLite FTS5 full-text search across sessions
- Background indexing with bootstrap
- Skips large sessions during bootstrap
- Semaphore-based concurrency control
- `last_bootstrap_at` metadata for incremental indexing

### Session Metadata
```json
{
  "systemPromptTokens": 0,
  "toolDefinitionsCount": 0,
  "toolDefinitionsTokens": 0,
  "messageCount": 0,
  "messageTokens": 0,
  "freeTokens": 0,
  "reverted_files": 0,
  "clean_files": 0,
  "conflicts": 0,
  "num_file_snapshots": 0,
  "prompt_preview": "...",
  "agentName": "...",
  "resolvedModelId": "...",
  "feedback_text": "...",
  "conflict_type": "...",
  "workspace_directory": "..."
}
```

---

## 16. Compaction System

### Auto-Compact
```toml
auto_compact_threshold_percent = 85  # auto-compact at this % of context window
```

### Compaction Modes
- Via `GROK_COMPACTION_MODE` env var
- Via `GROK_COMPACTION_DETAIL` env var

### Events
```
auto_compact_started    — percentage threshold reached
auto_compact_completed  — "Conversation compacted."
auto_compact_failed     — "Auto-compact failed:"
auto_compact_cancelled   — "Auto-compact cancelled."
```

### Compaction Checkpoints
- Stored in `compaction_checkpoints/` directory
- `checkpoint_id`, `prompt_index_at_compaction`, `auto_continue`
- Enables rewind to pre-compaction state

---

## 17. ACP (Agent Client Protocol) — Full Method Catalog

### Core ACP Methods (x.ai/ namespace)

| Method | Type | Description |
|--------|------|-------------|
| `xai/auth` | call | Auth check |
| `xai/auth/get` | call | Get auth state |
| `xai/auth/get_url` | call | Get OAuth URL |
| `xai/auth/logout` | call | Logout |
| `xai/auth/submit_code` | call | Submit OAuth code |
| `xai/auth/check_subscription` | call | Check subscription tier |
| `xai/bash` | call | Execute bash command |
| `xai/best_of_n_mode_changed` | event | Best-of-N mode toggle |
| `xai/btw` | call | Submit feedback |
| `xai/bundle/entry` | call | Bundle entry |
| `xai/bundle/status` | call | Bundle status |
| `xai/bundle/sync` | call | Bundle sync |
| `xai/cli/install` | call | CLI install |
| `xai/cli/changelogs` | call | Get changelogs |
| `xai/cloud/env` | call | Cloud environment |
| `xai/cloud/terminal` | call | Cloud terminal |
| `xai/cloud_server_id` | call | Cloud server ID |
| `xai/code/find` | call | Find in code |
| `xai/code/goto` | call | Go to definition |
| `xai/commands/list` | call | List slash commands |
| `xai/compact_conversation` | call | Compact conversation |
| `xai/config_changed` | event | Config changed notification |
| `xai/debug/trigger` | call | Debug trigger |
| `xai/display_cwd` | event | Display CWD change |
| `xai/exit_plan_mode` | call | Exit plan mode |
| `xai/feedback/did` | call | Submit feedback categories |
| `xai/fs/read_file` | call | Read file |
| `xai/fs/delete_file` | call | Delete file |
| `xai/fs/index` | call | File index |
| `xai/fs_notify` | event | File system notification |
| `xai/git/branch` | call | Git branch |
| `xai/git/git_rebase` | call | Git rebase |
| `xai/git/stage` | call | Git stage |
| `xai/git/unstage` | call | Git unstage |
| `xai/git/worktree` | call | Git worktree |
| `xai/git_head_changed` | event | Git HEAD changed |
| `xai/hooks/action` | call | Hook action |
| `xai/hub/bind_server` | call | Hub bind server |
| `xai/hub/servers` | call | Hub list servers |
| `xai/hunk` | call | Get file hunk |
| `xai/incremental` | event | Incremental update |
| `xai/internal/evict_sessions` | call | Evict sessions |
| `xai/internal/reload_all_mcp_servers` | call | Reload all MCP servers |
| `xai/internal/reload_models` | call | Reload model list |
| `xai/internal/reload_project_mcp_servers` | call | Reload project MCP servers |
| `xai/internal/reload_skills` | call | Reload skills |
| `xai/leader/version_mismatch` | event | Leader version mismatch |
| `xai/leader_reconnected` | event | Leader reconnected |
| `xai/legal` | call | Legal info |
| `xai/log` | call | Log message |
| `xai/marketplace/action` | call | Marketplace action |
| `xai/marketplace/list` | call | Marketplace list |
| `xai/mcp/auth_trigger` | call | MCP server auth trigger |
| `xai/mcp/read_resource` | call | Read MCP resource |
| `xai/mcp/server_status` | call | MCP server status |
| `xai/mcp/servers_updated` | event | MCP servers updated |
| `xai/mcp/toggle_tool` | call | Toggle MCP tool |
| `xai/mcp/tools_changed` | event | MCP tools changed |
| `xai/mcp_initialized` | event | MCP init complete |
| `xai/memory/rewrite` | call | Rewrite memory |
| `xai/models/update` | event | Models list updated |
| `xai/monitor_event` | event | Monitor event |
| `xai/permissions` | call | Permission check |
| `xai/persist_setting` | call | Persist setting |
| `xai/plugins/action` | call | Plugin action |
| `xai/plugins/list` | call | List plugins |
| `xai/plugins/notify` | event | Plugin notification |
| `xai/privacy/set` | call | Set privacy mode |
| `xai/prompt_history` | call | Get prompt history |
| `xai/relay/init` | call | Initialize relay |
| `xai/restore_code` | call | Restore codebase |
| `xai/rewind/execute` | call | Execute rewind |
| `xai/rewind/points` | call | List rewind points |
| `xai/scheduled_task_created` | event | Scheduled task created |
| `xai/scheduled_task_deleted` | event | Scheduled task deleted |
| `xai/scheduled_task_inject_prompt` | call | Inject scheduled prompt |
| `xai/scheduler/delete` | call | Delete scheduled task |
| `xai/search` | call | Search |
| `xai/search/content` | call | Search content |
| `xai/search/fuzzy` | call | Fuzzy search |
| `xai/session/close` | event | Session close |
| `xai/session/fork` | call | Fork session |
| `xai/session/info` | call | Session info |
| `xai/session/list` | call | List sessions |
| `xai/session/prompt_complete` | event | Prompt complete |
| `xai/session/rename` | call | Rename session |
| `xai/session/resolve_local_for_worktree_resume` | call | Resolve local session |
| `xai/session/search` | call | Search sessions |
| `xai/session/update` | call | Update session |
| `xai/session/updates` | event | Session updates |
| `xai/session/upsert` | call | Upsert session |
| `xai/session_notification` | event | Session notification |
| `xai/session_summaries` | call | Get session summaries |
| `xai/session_summaries/workspace_list` | call | Workspace list |
| `xai/session_summaries/recent` | call | Recent sessions |
| `xai/settings/update` | call | Update settings |
| `xai/share_session` | call | Share session |
| `xai/skills/config` | call | Skills config |
| `xai/skills/list` | call | List skills |
| `xai/skills/refresh` | call | Refresh skills |
| `xai/skills/toggle` | call | Toggle skill |
| `xai/subagent/cancel` | call | Cancel subagent |
| `xai/subagent/list` | call | List subagents |
| `xai/task_backgrounded` | event | Task backgrounded |
| `xai/task_completed` | event | Task completed |
| `xai/telemetry/multi_agent_apply` | call | Multi-agent apply telemetry |
| `xai/telemetry/multi_agent_discard` | call | Multi-agent discard telemetry |
| `xai/telemetry/multi_agent_followup` | call | Multi-agent followup telemetry |
| `xai/terminal/background` | call | Terminal background |
| `xai/terminal/create` | call | Create terminal |
| `xai/terminal/kill` | call | Kill terminal |
| `xai/terminal/list` | call | List terminals |
| `xai/terminal/pty` | call | PTY management |
| `xai/toggle_plan_mode` | call | Toggle plan mode |
| `xai/verification_mode_changed` | event | Verification mode changed |
| `xai/yolo_mode_changed` | event | YOLO mode changed |

### Total: ~100+ unique ACP methods

---

## 18. Claude / Cursor Compatibility Layer

### Feature Toggles (per-feature)
```toml
[claude_compat]
imported = true    # Marker: Claude settings already imported

# Per-feature toggles (all default true)
skills = true      # scan ~/.claude/skills/ and <cwd>/.claude/skills/
rules = true       # scan <cwd>/.cursor/rules/
agents = true      # scan .claude/agents/ and ~/.claude/agents/
mcps = true        # scan .mcp.json, .claude.json, settings.json
hooks = true       # scan ~/.cursor/hooks.json and <cwd>/.cursor/hooks.json
```

### Config Scan Order
| Scope | Path | Source | Notes |
|-------|------|--------|-------|
| Global | `~/.claude.json` | Always | Claude Code compat |
| Global | `~/.claude/skills/` | User | Lowest priority |
| Global | `~/.claude/agents/` | User | Agent definitions |
| Global | `~/.cursor/hooks.json` | Always | Cursor compat (configurable) |
| Project | `<cwd>/.claude/CLAUDE.md` | Project | Claude rules |
| Project | `<cwd>/.claude/CLAUDE.local.md` | Project | Local Claude rules |
| Project | `<cwd>/.claude/rules/` | Project | Claude rules |
| Project | `<cwd>/.cursor/rules/` | Project | Cursor rules (configurable) |
| Project | `<cwd>/.cursor/hooks.json` | Trust required | Cursor hooks (configurable) |
| Project | `<cwd>/.mcp.json` | Project | MCP server config |
| Project | `<cwd>.claude.json` | Project | Claude project config |
| Project | `settings.json` | Managed | Managed settings |
| Project | `settings.local.json` | Local | Local settings |

### Claude Import Process
1. Scans Claude settings files
2. Imports permission rules
3. Imports MCP server configs
4. Imports skill/agent definitions
5. Sets `imported = true` marker in config.toml
6. Skips already-imported settings

### ClaudeInstalledEntry (1 element)
- Tracks which Claude plugins are installed
- Used for compatibility detection

### ClaudeInstalledPlugins
- Registry of Claude-compatible plugins
- Parsed from `installed_plugins.json`

### Permission Compat
- Claude `defaultMode=acceptEdits` → Grok appends synthetic Allow Edit rule
- Claude `defaultMode=bypassPermissions` → Grok appends catch-all Allow Any rule
- `GROK_CLAUDE_MARKER_OVERRIDE` — Override import marker
- `GROK_CLAUDE_MCPS_ENABLED` — Toggle Claude MCP scanning

### Cursor Hook Compat
- "Grok accepts Cursor's camelCase hook event names so `~/.cursor/hooks.json` works out of the box"
- Maps Cursor event names to Grok events

### Plugin Manifest Compat
- `.grok-plugin/plugin.json` — Grok plugin manifest (14 fields)
- `.claude-plugin/plugin.json` — Claude plugin manifest
- Both share same structure via `ClaudeInstalledEntry`

---

## 19. ZDR (Zero Data Retention)

### Overview
- Full data isolation mode — no conversation data retained after session
- Disables incompatible tools and features

### Environment Variables
```
GROK_ZDR_ENABLED        — Enable ZDR mode
GROK_ZDR_ACCESS_ENABLED — Enable ZDR access
GROK_DISABLE_ZDR_INCOMPATIBLE_TOOLS — Disable tools incompatible with ZDR
```

### Auth Metadata
```json
{
  "is_zdr": true,
  "coding_data_retention_opt_out": true
}
```

### Effects
- `video_gen disabled by tools.disable_zdr_incompatible_tools`
- `Cannot change: Zero Data Retention enabled` (for settings)
- No session persistence
- No telemetry data retention
- No memory storage
- Auth recovery: `auth recovery: sampler 401, devbox re-mint, retrying`

---

## 20. Image / Video Generation

### Models
- **Image**: Grok internal image generation (Mozart system)
- **Video**: `image_to_video`, `reference_to_video`
- **Image Edit**: `image_edit` tool

### System Prompt Names
- `mozart_system_prompt_enum` — Image generation system prompt selector
- `video_gen_upsampler_system_prompt` — Video upsampling system prompt

### Tools
| Tool | Category | Capability Required |
|------|----------|---------------------|
| `image_gen` | Generation | execute / ALL |
| `image_edit` | Edit | execute / ALL |
| `video_gen` | Generation | execute / ALL |
| `image_to_video` | Video | execute / ALL |
| `reference_to_video` | Video | execute / ALL |

### Harness
- `GROK_IMAGE_GEN` — Enable image generation
- `GROK_IMAGE_GEN_HARNESS` — Image gen harness mode
- `GROK_IMAGE_EDIT` — Enable image editing
- Disabled by ZDR: `video_gen disabled by tools.disable_zdr_incompatible_tools`

### Implementation
- `xai-grok-tools/src/implementations/grok_build/image_gen/mod.rs`
- `xai-grok-tools/src/implementations/grok_build/image_edit/mod.rs`
- `xai-grok-tools/src/implementations/grok_build/video_gen/mod.rs`
- `xai-grok-tools/src/implementations/cursor/generate_image.rs`

---

## 21. Codebase Restore from GCS

### Architecture
```
Session Registry → Get Codebase Download URL → GCS Signed URL → Download Archive → Extract
```

### Flow
1. `fetching session record for codebase download URL`
2. `getting signed download URL for codebase archive`
3. Download from GCS via proxy
4. Extract to worktree

### GCS Internals
- Bucket determined by proxy from ACLs
- Service account key or deployment key authentication
- `gs://` URL scheme
- Multipart upload for large archives
- S3-compatible fallback

### Session Restore Log
```
RESUME_CODEBASE_RESTORE: full codebase restored from GCS
RESUME_CODEBASE_RESTORE: GCS codebase restore unavailable, HEAD checkout only
RESTORE_CODE_DEBUG: resume_session_in_worktree entry
RESTORE_CODE_DEBUG: loaded head_commit from summary
RESUME_LOCAL_RESOLVED: session found via repo-wide lookup
```

### Btrfs Worktree (gRPC)
- `xai.explorer.v1.Agent/CreateBtrfsWorktree` — Create Btrfs worktree
- `xai.explorer.v1.Agent/DeleteBtrfsWorktree` — Delete Btrfs worktree
- Requires `explorer-service` at `explorer-service-prod.global.svc.cluster.local:80`

### Session Registry
- `session/agent/session_registry_client.rs` — gRPC client
- `not found locally and session registry is not available (auth may be missing or registry is disabled)`
- `Session registry client is required for rehydration`

---

## 22. Session Rewind / Snapshot System

### Architecture
- `rewind_points.jsonl` — Append-only log of rewind points
- Each point captures: turn number, file state, conversation state

### ACP Methods
- `xai/rewind/points` — List available rewind points
- `xai/rewind/execute` — Execute rewind to specific point

### Implementation
- `xai-grok-shell/src/extensions/rewind.rs`
- `GROK_CANCEL_REWIND` — Cancel pending rewind

### File Tracking
- `reverted_files` — Files that were reverted
- `clean_files` — Files without conflicts
- `conflicts` — Files with merge conflicts
- `num_file_snapshots` — Number of file snapshots

### Rewind Recovery
- After rewind, session state is replayed from checkpoint
- Compaction checkpoints enable rewind past compaction boundaries

---

## 23. Gateway Bridge (IDE Integration)

### Architecture
```
IDE ←→ WebSocket ←→ Gateway Bridge ←→ Agent Session
```

### Protocol
- WebSocket-based bidirectional communication
- JSON-RPC 2.0 message framing
- `ConversationItemCreate` — Send user message
- `ResponseCreate` — Create model response
- `ResponseCancel` — Cancel in-flight response
- `SessionCreate` — Create new session

### Connection States
```
connecting → connected → suspended
                ↓              ↑
            ConnectionLost  Reconnecting
```

### Auth
- Bearer token over `wss://`
- Refuses plaintext `ws://` to non-loopback hosts
- `bridge_auth_refused_for_plaintext_non_loopback`

### Reconnection
- Exponential backoff with jitter
- `bridge_ws_stream_ended; will reconnect`
- `gateway WS read error; will reconnect`
- `bridge_prompt_during_backoff; replying NotConnected/NotImplemented`

### Error Handling
- `TurnInFlight` — Previous turn not finished
- `bridge_server_error_mid_turn` — Server error during turn
- `bridge_response_id_too_long` — Response ID exceeds limit

### Environment Variables
```
GROK_GATEWAY_URL               — Gateway WS URL
GROK_PRODUCTION_GATEWAY_WS_URL — Production gateway
GROK_WS_URL                    — WebSocket URL
GROK_WS_ORIGIN                 — WebSocket origin
```

---

## 24. CLI Flags & Commands

### Main Commands
| Command | Description |
|---------|-------------|
| `grok` | Start interactive REPL |
| `grok --headless` | Run without interactive UI |
| `grok --check` | Self-verification mode (append verification loop) |
| `grok --agent-profile <path>` | Load agent profile from file |
| `grok --plugin-dir <path>` | Add plugin directory |
| `grok import` | Import sessions into Grok |
| `grok inspect` | Show configuration Grok discovers for this directory |
| `grok sessions` | List, search, or restore sessions |
| `grok config` | Manage configuration |
| `grok managed-config` | Fetch and install managed deployment configuration |
| `grok share` | Share a session and print the share URL |
| `grok ssh` | Run ssh with local clipboard support |
| `grok plugins` | Manage plugins and marketplace sources |
| `grok memory` | Manage cross-session memory |
| `grok models` | List available models and exit |
| `grok leader` | Manage running leader processes |
| `grok login` | Authenticate with Grok |
| `grok logout` | Sign out and clear cached credentials |

### Auth Methods
| Method | Flag | Description |
|--------|------|-------------|
| OAuth2 | default | Use Grok OAuth via auth.x.ai |
| Device code | `--device-auth` / `--device-code` | Device-code for headless/remote |
| Devbox | `--devbox` | Mint credentials via explorer-service |

### Slash Commands
| Command | Description |
|---------|-------------|
| `/model` | Switch model |
| `/plan` | Enter plan mode |
| `/view-plan` | View current plan |
| `/always-approve on/off` | Toggle YOLO mode |
| `/announcements hide/show/next/prev` | Manage announcements |
| `/export` | Export session |
| `/import-claude` | Import Claude Code config |
| `/loop` | Loop command |

### CLI Flags
| Flag | Description |
|------|-------------|
| `--headless` | Non-interactive mode |
| `--check` | Self-verification after execution |
| `--agent-profile <path>` | Load agent profile |
| `--plugin-dir <path>` | Add plugin directory |
| `--device-auth` | Device-code auth |
| `--devbox` | Devbox auth |
| `--model <model>` | Default model |

---

## 25. Environment Variables — Complete Catalog (242+)

### Core Configuration
```
GROK_HOME                    — Home directory (~/.grok)
GROK_WORKSPACE                — Workspace root
GROK_WORKSPACE_ROOT           — Project root
GROK_SESSION_ID               — Current session ID
GROK_DEFAULT_MODEL            — Default model
GROK_SANDBOX                  — Sandbox profile (off|workspace|read-only|strict)
GROK_SANDBOX_AUTO_ALLOW_BASH  — Auto-allow bash in sandbox
GROK_MEMORY                   — Enable memory system
GROK_SUBAGENTS                — Enable subagent spawning
GROK_IMAGE_GEN                — Enable image generation
GROK_IMAGE_EDIT               — Enable image editing
GROK_IMAGE_GEN_HARNESS        — Image gen harness mode
GROK_LSP_TOOLS                — Enable LSP tools
GROK_WEB_FETCH                — Enable web fetch
GROK_WEB_SEARCH_MODEL         — Model for web search summaries
GROK_SESSION_SUMMARY_MODEL    — Model for session summaries
GROK_IMAGE_DESCRIPTION_MODEL  — Model for image descriptions
GROK_MESSAGE                  — Direct message (headless mode)
GROK_SHELL                    — Shell for bash commands
GROK_AGENT                    — Agent type/profile
GROK_GOAL                     — Goal override
GROK_SESH                     — Session selector
GROK_VERSION                  — Version override
GROK_TEST_VERSION             — Test version
GROK_INIT_STATE_MARKER__      — Init state marker
```

### API & Networking
```
GROK_CLI_CHAT_PROXY_BASE_URL  — Chat proxy URL
GROK_CODE_BACKEND_URL         — Backend URL
GROK_CODE_WEB_URL             — Web URL
GROK_CODE_XAI_API_KEY         — xAI API key
GROK_MODELS_BASE_URL          — Models API base URL
GROK_MODELS_LIST_URL          — Models list URL
GROK_GATEWAY_URL              — Gateway WS URL
GROK_PRODUCTION_GATEWAY_WS_URL— Production gateway URL
GROK_WS_URL                   — WebSocket URL
GROK_WS_ORIGIN                — WebSocket origin
XAI_API_KEY                   — xAI API key
XAI_API_BASE_URL              — xAI API base URL
XAI_CLUSTER                   — Cluster name
KUBE_CLUSTER_NAME             — Kubernetes cluster
```

### Auth
```
GROK_AUTH                     — Auth method
GROK_AUTH_PATH                — Auth storage path
GROK_AUTH_PROVIDER_COMMAND    — External auth command
GROK_AUTH_PROVIDER_LABEL      — External auth label
GROK_AUTH_TOKEN_TTL           — Token TTL
GROK_AUTH_EARLY_INVALIDATION_SECS — Early invalidation seconds
GROK_AUTH_EXPIRED             — Auth expired flag
GROK_OIDC_CLIENT_ID           — OIDC client ID
GROK_OIDC_ISSUER              — OIDC issuer
GROK_OIDC_AUDIENCE            — OIDC audience
GROK_OIDC_SCOPES              — OIDC scopes
GROK_LOCAL_AUTH              — Local auth flag
GROK_OAUTH                    — OAuth flag
GROK_OAUTH_ENABLED            — OAuth enabled
GROK_ALPHA_TEST_KEY           — Alpha test key
```

### Proactivity & Agent Behavior
```
GROK_DEBUG_PROACTIVITY_CADENCE    — Proactivity cadence override
GROK_DEBUG_PROACTIVITY_THRESHOLD  — Proactivity threshold override
GROK_BEST_OF_N_CANDIDATES         — Best-of-N parallel candidates
GROK_GOAL_PLANNER                 — Enable goal planner
GROK_GOAL_VERIFIER_N              — Goal verification rounds
GROK_GOAL_CLASSIFIER              — Enable goal classifier
GROK_GOAL_CLASSIFIER_MAX          — Max goal classifications
GROK_AGENT_DASHBOARD__            — Agent dashboard
GROK_AGENT_METADATA               — Agent metadata
GROK_AGENT_SECRETREMOTER          — Agent secret remote
```

### Claude/Cursor Compat
```
GROK_CLAUDE_MARKER_OVERRIDE       — Override import marker
GROK_CLAUDE_MCPS_ENABLED          — Claude MCP scanning
GROK_CURSOR_HOOKS_ENABLED         — Cursor hooks scanning
GROK_CURSOR_MCPS_ENABLED          — Cursor MCP scanning
GROK_CURSOR_SKILLS_ENABLED        — Cursor skills scanning
GROK_CURSOR_RULES_ENABLED         — Cursor rules scanning
GROK_CURSOR_AGENTS_ENABLED        — Cursor agents scanning
GROK_CLAUDE_SKILLS_ENABLED        — Claude skills scanning
GROK_CLAUDE_RULES_ENABLED         — Claude rules scanning
GROK_CLAUDE_AGENTS_ENABLED        — Claude agents scanning
GROK_CLAUDE_HOOKS_ENABLED         — Claude hooks scanning
CLAUDE_PROJECT_DIR                — Claude project directory
CLAUDE_SESSION_ID                 — Claude session ID
CLAUDE_SKILL_DIR                  — Claude skill directory
CLAUDE_PLUGIN_ROOT                — Claude plugin root
CLAUDE_PLUGIN_DATA                — Claude plugin data
```

### Compaction
```
GROK_AUTO_COMPACT_THRESHOLD_PERCENT — Auto-compact threshold (default 85)
GROK_COMPACTION_MODE                — Compaction mode
GROK_COMPACTION_DETAIL              — Compaction detail level
```

### ZDR
```
GROK_ZDR_ENABLED                   — Enable Zero Data Retention
GROK_ZDR_ACCESS_ENABLED            — Enable ZDR access
GROK_DISABLE_ZDR_INCOMPATIBLE_TOOLS — Disable ZDR-incompatible tools
```

### Feedback
```
GROK_FEEDBACK_ENABLED              — Enable feedback collection
GROK_FEEDBACK_BASE_URL             — Feedback API base URL
```

### Telemetry
```
GROK_TELEMETRY_ENABLED            — Enable telemetry
GROK_TELEMETRY_EVENTS_URL          — Events API URL
GROK_TELEMETRY_EVENTS_API_KEY     — Events API key
GROK_TELEMETRY_MIXPANEL_TOKEN     — Mixpanel token
GROK_TELEMETRY_MIXPANEL_ENABLED   — Mixpanel enabled
GROK_TELEMETRY_TRACE_UPLOAD       — Trace upload enabled
GROK_TELEMETRY_GCS_BUCKET         — GCS bucket for traces
GROK_TRACK_HEADLESS               — Track headless sessions
GROK_INSTRUMENTATION              — Enable instrumentation
GROK_INSTRUMENTATION_LOG          — Instrumentation log
GROK_DISABLE_AUTOUPDATER          — Disable auto-updater
GROK_DISABLE_UPDATE_CHECK         — Disable update check
GROK_ERROR_REPORTING              — Enable error reporting
DISABLE_ERROR_REPORTING           — Disable error reporting
DISABLE_TELEMETRY                  — Disable telemetry
DISABLE_FEEDBACK_COMMAND          — Disable feedback command
```

### MCP
```
GROK_MCP_AUTO_RESTART             — Auto-restart MCP servers
GROK_MCP_LIVENESS_WATCHERS       — MCP liveness watchers
GROK_MCP_PUSH_SERVER_STATUS      — Push server status
GROK_MCP_RECURSIVE_CONFIG_WATCH   — Recursive config watch
GROK_MANAGED_MCPS_ENABLED         — Managed MCP enabled
```

### Managed Deployment
```
GROK_DEPLOYMENT_KEY                        — Deployment key
GROK_DEPLOYMENT_CONFIG_CACHE_TTL_SECS      — Config cache TTL
GROK_DEPLOYMENT_CONFIG_REFRESH_INTERVAL_SECS — Config refresh interval
GROK_MANAGED_CONFIG                        — Managed config URL
GROK_MANAGED_CONFIG_FAIL_CLOSED            — Fail closed on managed config
GROK_OFFICIAL_MARKETPLACE_AUTO_REGISTER    — Auto-register marketplace
GROK_MANAGED_BY_NPM                        — Managed by npm
GROK_MANAGED_BY_INTERNAL                   — Managed by internal
```

### Upload & Storage
```
GROK_UPLOAD_QUEUE_MAX_BYTES       — Upload queue max size
GROK_RESPECT_GITIGNORE            — Respect .gitignore
GROK_STORAGE_MODE                 — Storage mode
GROK_CANCEL_REWIND                — Cancel rewind
GROK_AUTO_WAKE                    — Auto-wake on prompt
```

### UI / TUI
```
GROK_SCROLL_SPEED                 — Scroll speed
GROK_FPS                          — TUI FPS
GROK_NERD_FONTS                   — Nerd fonts
GROK_SUGGESTIONS                  — Enable suggestions
GROK_SUGGESTIONS_AI               — AI suggestions
GROK_SUGGESTIONS_AI_MODEL         — AI suggestions model
GROK_SESSION_PICKER_GROUPED       — Grouped session picker
GROK_SHOW_TIPS                    — Show tips
GROK_AUTO_DARK_THEME              — Auto dark theme
GROK_AUTO_LIGHT_THEME             — Auto light theme
GROK_SHOW_TIMESTAMPS              — Show timestamps
GROK_DEFAULT_SELECTED_PERMISSION  — Default permission mode
```

### Hook Environment
```
GROK_HOOK_EVENT     — Hook event name
GROK_HOOK_NAME      — Hook display name
GROK_HOOK_DEBUG     — Hook debug mode
GROK_HOOKS_MASK___  — Hooks mask
GROK_LEADER_LOG     — Leader log
GROK_BASH_STATE_START__ — Bash state start marker
GROK_BASH_STATE_END__   — Bash state end marker
GROK_ZSH_STATE_START__  — ZSH state start marker
GROK_ZSH_STATE_END__    — ZSH state end marker
GROK_SNAP_EOF_          — Snap EOF marker
GROK_INSIDE_BWRAP       — Inside bwrap flag
GROK_ASKPASS            — Askpass helper
```

### Relay & Remote
```
GROK_RELAY_SYNC_ENABLED            — Enable relay sync
GROK_POOL_MAX_IDLE                 — Pool max idle
GROK_POOL_IDLE_TIMEOUT_SECS       — Pool idle timeout
GROK_CONNECT_TIMEOUT_SECS         — Connect timeout
GROK_WORKSPACE_AGENT_RPC_TIMEOUT_SECS  — Agent RPC timeout
GROK_WORKSPACE_AGENT_CONNECT_TIMEOUT_SECS — Agent connect timeout
GROK_MAX_RETRIES                  — Max retries
GROK_CRASH_HANDLER                — Crash handler
GROK_LOG_FILE                     — Log file path
GROK_LOG_FILTER                   — Log filter
GROK_LOG_SAMPLING                 — Log sampling
GROK_LOC_TRACKING                 — Location tracking
```

### OTEL
```
OTEL_EXPORTER_OTLP_ENDPOINT           — OTLP endpoint
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT    — OTLP traces endpoint
OTEL_EXPORTER_OTLP_HEADERS            — OTLP headers
OTEL_TRACES_EXPORTER                   — Traces exporter
OTEL_BSP_SCHEDULE_DELAY               — BSP schedule delay
OTEL_EXPORTER_OTLP_TIMEOUT             — OTLP timeout
OTEL_TRACES_EXPORT_INTERVAL           — Traces export interval
OTEL_EXPORTER_OTLP_TIMEOUT             — OTLP timeout
```

### Trace Upload
```
GROK_TRACE_UPLOAD_URL              — Trace upload URL
GROK_TRACE_UPLOAD_BUCKET           — Trace upload GCS bucket
GROK_TRACE_UPLOAD_REGION           — Trace upload region
GROK_TRACE_UPLOAD_CREDENTIALS_FILE  — Credentials file
GROK_TRACE_UPLOAD_ENDPOINT_URL     — Endpoint URL
```

### User Data
```
GROK_USER_METADATA                 — User metadata
GROK_CLIENT_NAME                   — Client name
GROK_CLIENT_VERSION                — Client version
GROK_INSTALLER                     — Installer type
GROK_EVENT                         — Event trigger
```

### Other
```
GROK_ANNOUNCEMENTS_OVERRIDE         — Announcements override
GROK_DISABLE_WEB_FETCH              — Disable web fetch
GROK_WEB_FETCH_PROXY                — Web fetch proxy
GROK_TERMINAL_NOTIFICATION_INTERVAL_MS — Terminal notification interval
GROK_BEST_OF_N_CANDIDATES           — Best-of-N candidates
GROK_HOOKS_MASK___                  — Hooks mask
XAI_VALIDATE_TYPE_TIMEOUT_MS        — Type validation timeout
XAI_ROOT                            — xAI root
XAI_USER                            — xAI user
```

---

## 26. System Prompt Templates

### Named Prompts (found in binary)
| Prompt Name | Purpose |
|-------------|---------|
| `mozart_system_prompt_enum` | Image generation system prompt selector |
| `video_gen_upsampler_system_prompt` | Video generation upsampling |
| `memory_system_prompt` | Memory indexing/retrieval system instructions |
| `disable_all_personality_system_prompt` | Stripped-down system prompt (no personality) |

### Persona Prompt Files
- `~/.grok/agents/*.md` — User-defined agent personas
- `.claude/agents/` — Claude-compatible agent definitions
- Built-in personas referenced by `behavior_preset`
- Skills via `~/.claude/skills/` and `.grok/skills/`

### Prompt Assembly Order
1. Base system prompt (model-dependent)
2. `CLAUDE.md` / `AGENTS.md` / `CLAUDE.local.md` project context
3. `.cursor/rules/` Cursor rules (if enabled)
4. Persona instructions from agent definition
5. Tool definitions
6. Memory search results (if relevant)
7. `prompt_extension` from agent definition
8. Proactivity reminder (if threshold met)

---

## 27. Effort Levels & Reasoning Config

### Effort Levels
| Level | Description |
|-------|-------------|
| `low` | Minimal reasoning, fast response |
| `medium` | Balanced reasoning |
| `high` | Extended reasoning |
| `xhigh` | Extra extended reasoning |
| `max` | Maximum reasoning depth |

### Config
```toml
[reasoning]
effort_level = "high"            # low | medium | high | xhigh | max
max_thoughts_width = ...         # Maximum thinking tokens
compact_mode = ...               # Compaction strategy
simple_mode = ...                # Simplified mode toggle
```

### Environment
```
GROK_REASONING_EFFORT — Override reasoning effort level
```

---

## 28. Config.toml Settings

### Complete Setting Keys
```toml
[model]
model = "grok-build"
default_model = "grok-build"
max_completion_tokens = ...

[agent]
name = "..."
description = "Deep research agent"
instructions = "..."
instructions_file = "..."
capabilities = "read-write"
default_capability_mode = "read-only"
auto_compact_threshold_percent = 85
sandbox_profile = "workspace"

[sandbox]
profile = "workspace"
read_write_paths = []
restrict_network = true

[proactivity]
proactivity_reminder_cadence = ...
proactivity_reminder_threshold = ...

[reasoning]
effort_level = "high"
max_thoughts_width = ...
compact_mode = ...
simple_mode = ...

[permissions]
default_selected_permission = "default"

[ui]
auto_dark_theme = ...
auto_light_theme = ...
scroll_speed = ...
show_timestamps = ...
font_size = ...
accent_enabled = ...
auto_update = ...

[telemetry]
mixpanel_enabled = ...
events_url = ...

[mcp]
auto_restart = ...
liveness_watchers = ...
recursive_config_watch = ...

[feedback]
enabled = ...

[storage]
mode = ...
respect_gitignore = true

[claude_compat]
imported = true
skills = true
rules = true
agents = true
mcps = true
hooks = true
```

---

## 29. Managed Deployment Config

### Architecture
```
Enterprise Admin → Managed Config URL → GROK_DEPLOYMENT_KEY → Fetch Config → config.toml
```

### Flow
1. `GROK_MANAGED_CONFIG` URL configured by enterprise
2. `GROK_DEPLOYMENT_KEY` for authentication
3. Config fetched at startup
4. Cached locally with TTL
5. `GROK_DEPLOYMENT_CONFIG_CACHE_TTL_SECS` — Cache TTL
6. `GROK_DEPLOYMENT_CONFIG_REFRESH_INTERVAL_SECS` — Refresh interval
7. `GROK_MANAGED_CONFIG_FAIL_CLOSED` — If fetch fails, block startup

### Managed Settings
- `managed-settings.json` — Enterprise policy file
- Contains permission rules, allowed domains, MCP allowlists
- `Loaded permission rules from managed-settings.json`
- `strictKnownMarketplaces` — Allowed marketplace sources
- `allowedMcpServers` — Allowed MCP servers
- `serverUrl` — MCP server URL allowlist

### Fail-Closed
- When `GROK_MANAGED_CONFIG_FAIL_CLOSED = true`, if managed config cannot be fetched, the CLI refuses to start
- Ensures enterprise policy is always enforced

---

## 30. SUDO-AI Gap Analysis & Priority Features

### CRITICAL — Features We MUST Build to Match/Beat Grok

| # | Feature | Grok Has It | SUDO-AI Status | Priority |
|---|---------|-------------|----------------|----------|
| 1 | **Sandbox System** (Landlock/Seatbelt) | ✅ Full (nono-0.53.0) | ❌ Missing | P0 |
| 2 | **Best-of-N Parallel Execution** | ✅ Full with judge prompt | ❌ Missing | P0 |
| 3 | **Goal Planner/Classifier/Tracker** | ✅ 4-file system | ❌ Missing | P0 |
| 4 | **Doom Loop Detector** | ✅ 3-file system | ❌ Missing | P0 |
| 5 | **Laziness/Proactivity Nudge** | ✅ Full with cadence | ❌ Missing | P0 |
| 6 | **Plan Mode Tools** (enter/exit_plan_mode) | ✅ Full state machine | ❌ Missing | P0 |
| 7 | **Self-Verify (--check flag)** | ✅ Post-execution verify | ❌ Missing | P1 |
| 8 | **Session Rewind/Snapshot** | ✅ Full with JSONL | ❌ Missing | P1 |
| 9 | **Codebase Restore from GCS** | ✅ gRPC + signed URLs | ❌ Missing | P1 |
| 10 | **Feedback Tier System** | ✅ 3 tiers with criteria | ❌ Missing | P1 |
| 11 | **ZDR (Zero Data Retention)** | ✅ Full with tool disabling | ❌ Missing | P1 |
| 12 | **Claude/Cursor Compat Layer** | ✅ Per-feature toggles | ❌ Missing | P2 |
| 13 | **Image/Video Generation** | ✅ Mozart system | ❌ Missing | P2 |
| 14 | **Managed Deployment Config** | ✅ Enterprise fail-closed | ❌ Missing | P2 |
| 15 | **Gateway Bridge (IDE WS)** | ✅ Full WS protocol | ❌ Missing | P2 |
| 16 | **Session Search (FTS5)** | ✅ SQLite FTS5 | ❌ Missing | P2 |
| 17 | **Cron Scheduler Tool** | ✅ Actor + create/delete | ❌ Missing | P2 |
| 18 | **Monitor Tool** (with rate limiter) | ✅ Event + rate limit | ❌ Missing | P2 |
| 19 | **Multi-Tool-Set Support** | ✅ 4 tool sets (grok_build, cursor, codex, opencode) | ❌ Missing | P2 |
| 20 | **Auto-Update System** | ✅ Background updater | ❌ Missing | P3 |

### Features Where SUDO-AI Already Leads
| # | Feature | SUDO-AI | Grok |
|---|---------|---------|------|
| 1 | **Taint Tracking** | ✅ Wave10 full taint system | ❌ Not found |
| 2 | **5-Pillar Security** | ✅ Full 5-pillar model | ❌ Basic permission |
| 3 | **Vault System** | ✅ Encrypted vault + rotate | ❌ Not found |
| 4 | **Dream Consolidation** | ✅ Memory dream system | ✅ Also has dream |
| 5 | **Consciousness Loop** | ✅ Full consciousness engine | ❌ Not found |
| 6 | **Swarm Intelligence** | ✅ A2A + swarm | ❌ Basic subagent only |
| 7 | **Cost Optimizer** | ✅ Full cost routing | ❌ Not found |
| 8 | **Rate Limiting (Security)** | ✅ Full rate limit system | ✅ Monitor rate limiter |
| 9 | **Agent Market** | ✅ Plugin marketplace | ✅ Also has marketplace |
| 10 | **Hook System Depth** | ✅ 30+ typed hooks | ✅ 9 hook events |

### Recommended Build Order
1. **P0**: Sandbox → Plan Mode Tools → Goal System → Best-of-N → Doom Loop → Proactivity
2. **P1**: Self-Verify → Session Rewind → Feedback Tiers → ZDR
3. **P2**: Claude/Cursor Compat → Image/Video → Managed Config → Session Search → Cron
4. **P3**: Auto-Update → Monitor Tool → Multi-Tool-Sets → Gateway Bridge

---

*Report generated from static analysis of grok-0.2.22-linux-x86_64 binary (132MB).  
All data extracted via `strings`, `objdump`, and pattern analysis. No runtime testing performed.*