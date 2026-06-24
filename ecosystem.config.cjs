/**
 * PM2 Ecosystem Config — SUDO-AI v5 (Wave 5 P3)
 *
 * Process: sudo-ai-v5
 * Entry:   pnpm cli  (= tsx src/cli.ts — headless gateway + agent stack)
 * Ports:   GATEWAY_PORT=18900, WEB_CHAT on :18900
 *
 * PORTABLE: CWD and log paths are derived from SUDO_AI_HOME env var or the
 * directory containing this file (__dirname). No hardcoded /root paths.
 * To override: set SUDO_AI_HOME=/your/path before running pm2.
 *
 * All secrets come from config/.env (loaded by dotenv at boot).
 * The pm2 env block below can override individual vars (override: false means
 * .env wins when the var is already set in the shell environment).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const CWD = process.env.SUDO_AI_HOME || __dirname;

// Load config/.env so tokens can live outside the tracked ecosystem file.
// config/.env is gitignored; ecosystem.config.cjs is NOT.
const dotenvPath = path.join(__dirname, 'config', '.env');
if (fs.existsSync(dotenvPath)) {
  require('dotenv').config({ path: dotenvPath });
}
if (!process.env['GATEWAY_TOKEN']) {
  process.stderr.write('[ecosystem] FATAL: GATEWAY_TOKEN is not set. Set it in config/.env.\n');
  process.exit(1);
}

module.exports = {
  apps: [
    {
      // ---- Identity ----
      name: 'sudo-ai-v5',          // pm2 process name
      namespace: 'default',

      // ---- Entrypoint ----
      // Run the daemon as a SINGLE node process that pm2 directly manages:
      //   node --import tsx src/cli.ts
      // WAS `pnpm cli` → pnpm → `sh -c tsx src/cli.ts` → tsx → node. pnpm/sh do NOT
      // forward SIGTERM to their grandchildren, so on `pm2 restart` the node daemon
      // re-parented to PID 1 (orphaned) and kept holding gateway :18900, serving STALE
      // code — restarts silently no-op'd (see project-orphaned-daemon-stale-port).
      // Direct node means pm2's SIGTERM hits the daemon itself → clean restart, no orphan.
      script: 'src/cli.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',

      // ---- Working directory ----
      cwd: CWD,

      // ---- Process management ----
      instances: 1,                 // single instance — Telegram bot cannot fan-out
      exec_mode: 'fork',            // fork mode (not cluster — ESM + native addons)
      autorestart: true,            // restart on crash
      max_restarts: 5,              // cap crash-loop restarts before pm2 gives up
      min_uptime: "30s",            // must stay alive 10 s to count as stable start
      restart_delay: 10000,          // ms between restart attempts
      kill_timeout: 8000,           // grace for SIGTERM shutdown (save sessions / close DBs) before SIGKILL

      // ---- Logging ----
      time: true,                               // prefix every log line with timestamp
      log_date_format: 'YYYY-MM-DD HH:mm:ss',   // ISO-style timestamps
      out_file: path.join(CWD, 'data/logs/sudo-ai-v5-out.log'),
      error_file: path.join(CWD, 'data/logs/sudo-ai-v5-err.log'),
      merge_logs: false,            // keep stdout and stderr separate for debugging

      // ---- Environment ----
      // Secrets are NOT stored here — they live in config/.env (relative to CWD).
      // ConfigLoader uses dotenv with override:false, so vars set here take precedence.
      env: {
        NODE_ENV: 'production',

        // ---- Cost budget guardrails: DISABLED by operator request ----
        // `off` ⇒ Infinity (see src/core/billing/daily-budget.ts and
        // src/core/self-build/orchestrator.ts). This turns off, in one place:
        //   - the system.self-diagnostic API-cost FAIL/warn status,
        //   - the intelligence.daily-brief "API costs high" nag,
        //   - the daemon quota-warning events (detectQuotaWarning),
        //   - the self-build loop's daily LLM spend gate.
        // None of these ever *capped* spend — they only reported/aborted on it.
        // Re-enable by setting a positive dollar figure (e.g. '5' / '20').
        SUDO_DAILY_BUDGET_USD: 'off',
        SUDO_DAILY_LLM_BUDGET_USD: 'off',

        // ---- GitHub connector tools (opt-in) ----
        // Enables the github.* agent tools (commit / push / open_pr / merge_pr /
        // pr_status) — see src/core/tools/builtin/github/. They wrap local git +
        // the already-authenticated gh CLI. merge_pr only merges when the PR's
        // required CI checks are green. Default OFF (group not registered); set
        // to '0' to disable.
        SUDO_GITHUB_TOOLS: '1',

        // ---- Real-repo exec (opt-in) ----
        // Enables system.exec target:"repo" — an allowlisted, read-and-verify-only
        // command set (pnpm/npm test|lint|build, read-only git, rg/ls/wc, read-only
        // pm2) run against the REAL repo via execFile (no shell), bypassing the
        // /workspace sandbox. Default-deny allowlist in
        // src/core/security/approval/repo-allowlist.ts; every attempt audited to
        // data/exec-audit.jsonl. NO mutation / restart / network / installs.
        // Unset (or '0') = disabled.
        SUDO_REPO_EXEC: '1',

        // ---- Claude-Code context parity (raised 2026-06-24 per operator) ----
        // Match Claude Code's large working context instead of SUDO's tight
        // defaults. These four govern the WORKING SET fed to the model each turn
        // (the full history always lives in mind.db; only the working set is
        // bounded). Higher = richer context but higher per-turn token cost +
        // latency (especially on the glm-5.2 failover path). Revert any single
        // value to shrink it back. Code defaults: window 12, budget 60K, fork
        // 160K chars / 80 msgs.
        //   - WINDOW_SIZE: non-system messages kept per brain call (was 40)
        //   - MAX_CONTEXT_TOKENS: working token budget; compaction fires at 80%
        //   - FORK_*: when a session rotates to a fresh one (kept near, under, the budget)
        SUDO_AGENT_WINDOW_SIZE: process.env['SUDO_AGENT_WINDOW_SIZE'] || '200',
        SUDO_MAX_CONTEXT_TOKENS: process.env['SUDO_MAX_CONTEXT_TOKENS'] || '200000',
        SUDO_FORK_THRESHOLD_CHARS: process.env['SUDO_FORK_THRESHOLD_CHARS'] || '600000',
        SUDO_FORK_MESSAGE_COUNT: process.env['SUDO_FORK_MESSAGE_COUNT'] || '250',
        // Messages reloaded into the working set on a cold reload (restart/eviction).
        // Code default 100 (~7-8 turns once per-turn system blocks are counted);
        // 500 restores far more conversation after a restart. Budget + compaction
        // bound what actually reaches the model.
        SUDO_HYDRATE_MESSAGE_LIMIT: process.env['SUDO_HYDRATE_MESSAGE_LIMIT'] || '500',

        // Raise V8 old-space heap: glm-5.2's large thinking-model contexts over
        // long drill turns OOM-crashed the ~4GB default heap (FATAL: JavaScript
        // heap out of memory). 8GB gives headroom. Opus never hit this.
        NODE_OPTIONS: '--max-old-space-size=8192',

        // Add wasmtime to PATH for WASM sandbox tool execution
        PATH: `${process.env.PATH}:/root/.wasmtime/bin`,

        // Gateway listens on 18900.
        GATEWAY_PORT: '18900',

        // Web chat attaches to the gateway server (:18900/chat, :18900/chat/ws).
        // No second port is opened; WEB_CHAT_PORT is obsolete and ignored.
        WEB_CHAT_ENABLED: 'true',
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || '',
        WEB_CHAT_ALLOWED_ORIGINS: 'http://127.0.0.1:18900,http://localhost:18900',
        SUDO_AI_CORS_ORIGINS: 'http://127.0.0.1:18900,http://localhost:18900',

        // GATEWAY_TOKEN protects /v1/admin/* endpoints including synth-probe.
        // Wave 2.2h-tail security HIGH-1: must be set or admin endpoints are unauthenticated.
        GATEWAY_TOKEN: process.env['GATEWAY_TOKEN'] || '',

        // Admin REST API (/api/admin/*) — read-only enabled on prod 2026-06-20 (PR #331).
        // SUDO_ADMIN_API must live in this env block: gateway/server.ts reads it at
        // module-load (ADMIN_API_ON), before ConfigLoader loads config/.env. The token
        // value lives in config/.env (gitignored); fail-closed if unset. Danger routes
        // (service/restart, service/stop, system/backup, system/restore) stay 403 until
        // SUDO_ADMIN_API_DANGER=1.
        SUDO_ADMIN_API: '1',
        SUDO_AI_DASHBOARD_TOKEN: process.env['SUDO_AI_DASHBOARD_TOKEN'] || '',

        // Background-shell tools (gap #10): system.shell.start/poll/kill. Default OFF;
        // enabled on prod 2026-06-20 (PR #333). Reuses the EXEC_APPROVAL_MODE gate +
        // sandbox of system.exec. Danger subset (process.exit-style) N/A here.
        SUDO_BG_SHELL: '1',

        // Local Whisper STT model (PR #352). Code default is onnx-community/
        // whisper-base; bumped to whisper-medium-ONNX here 2026-06-20 for the
        // best dictation accuracy. Measured on prod: ~5s warm CPU inference for
        // a ~4.6s clip (vs ~3.6s small / ~1.7s base); the FIRST call ever pays a
        // one-time ~37s weight download, then cached on disk. Offline, key-free.
        // STT stays local-only unless SUDO_STT_CLOUD=1; disable local Whisper
        // with SUDO_WHISPER_STT=0. Drop back to whisper-small for lower latency.
        SUDO_WHISPER_MODEL: process.env['SUDO_WHISPER_MODEL'] || 'onnx-community/whisper-medium-ONNX',

        // Semantic memory compaction (gap #8): at the end of each auto-dream cycle,
        // collapse same-source near-duplicate chunks (cosine >= 0.92) into one canonical
        // row — DELETES the younger duplicate and sums applied_count. Wired in PR #337;
        // enabled on prod here 2026-06-20. Evergreen-protected, same-source-only, capped
        // 500/run, fail-open. Requires OPENAI_API_KEY (no-op without; key lives in config/.env).
        SUDO_SEMANTIC_COMPACT: '1',

        // Native tool correction (gap #7): when an MCP tool call fails, auto-correct to
        // the SUDO-AI native equivalent and re-dispatch (e.g. shell_execute -> system.exec,
        // filesystem_read_file -> coder.read-file, code_search -> coder.grep). Default OFF;
        // enabled on prod here 2026-06-20 (wired in PR #336). Read per-call in registry.execute,
        // fail-open (any error returns the original MCP failure). All 6 native targets verified
        // registered. Leave SUDO_NATIVE_TOOL_CORRECTION unset (=0 would hard-disable correction).
        SUDO_NATIVE_TOOL_CORRECTION_FALLBACK: '1',

        // Completion verification (orphan wiring, PR #340): after each turn, run a cheap
        // NO-LLM heuristic check of the final response for phantom completion (placeholder /
        // truncated / too-short / does-not-address-request) and surface a confidence signal.
        // Default OFF; enabled on prod here 2026-06-20. Observable-only (never alters the
        // response), fail-open, no API cost. Read per-turn in the agent loop's post-run region.
        SUDO_COMPLETION_VERIFY: '1',

        // Somatic markers (orphan wiring PR #344 + trigger fix PR #346): at each interaction end,
        // persist learned trigger→emotion associations (somatic_markers) when emotion intensity >= 0.6.
        // Trigger keywords come from the user's last message (the earlier getActiveConcepts source was
        // empty live → no-op). Default OFF; enabled on prod here 2026-06-20. Additive learning, fail-open,
        // ZDR-gated, NO LLM cost. NOTE: somatic_markers has no retention cap yet (follow-up).
        SUDO_CONSCIOUSNESS_SOMATIC_MARKERS: '1',

        // Pins /.well-known/agentskills.json 'registry' field origin — MUST NOT trust request headers (Wave 10 P1 HIGH-1).
        SUDO_PUBLIC_BASE_URL: 'http://127.0.0.1:18900',

        // DATA_DIR — directory for per-domain SQLite databases.
        // Required by AgentLoop (audit.db, veto-overrides.db) and CommitmentAuditor.
        DATA_DIR: path.join(CWD, 'data'),

        // Ollama Cloud configuration — single LLM brain: deepseek-v4-pro:cloud
        SUDO_DEFAULT_MODEL: 'ollama/deepseek-v4-pro:cloud',
        SUDO_FALLBACK_MODEL: 'ollama/qwen3.5:latest',
        OLLAMA_URL: 'https://ollama.com/v1',

        // Disable parallel racing — use consensus mode instead (saves tokens on cloud models)
        // Consciousness ticks and background tasks use sequential failover, not race.
        SUDO_BRAIN_RACE_DISABLE: '1',

        // Disable consensus too. Brain.getCloudProfiles() only treats
        // `ollama/*` profiles as "cloud" candidates, so when the chain has
        // any ollama model in the fallback chain (as kimi-k2.7-code now is
        // for outage protection — PR #221), consensus picks kimi as the
        // "winner" even though opus is configured primary. selectedModel
        // shows opus, activeModel shows kimi, switched=true on every turn.
        // Disabling consensus forces strict sequential failover:
        //   primary[0]=opus -> primary[1]=sonnet -> fallback=kimi
        // which matches the owner's intent (#216, #220, #221).
        SUDO_BRAIN_CONSENSUS_DISABLE: '1',

        // Opt-in high-stakes strategy upgrade (PR #242, 2026-06-17): when set
        // to 'debate' or 'tree-search', any brain.call passing
        // { tier: 'high-stakes' } that didn't pin opts.strategy gets routed
        // through the Blue/Red/Revise pipeline (#239) or N-candidate
        // verifier-guided tree search (#240). First wire-in is
        // task-decomposer — one-shot per complex user request, where a wrong
        // decomposition derails the whole downstream task. Other tagged call
        // sites adopt automatically as they're added.
        // Kill-switch: unset (or any non-debate/tree-search value) → single.
        // Cost note: debate adds ~15–30s + ~3× tokens per upgraded call;
        // tree-search adds ~60–90s + ~6× tokens. Worth it on the one-shot
        // paths; do NOT set for hot inner loops.
        SUDO_BRAIN_HIGH_STAKES_STRATEGY: 'debate',

        // Auto-plan: invokes task-decomposer on complex user requests
        // (5+ tool calls expected) and injects the parsed steps as a
        // SYSTEM message before the agent loop runs. Opt-in because the
        // decomposition micro-call costs an extra LLM round per turn.
        // Combined with SUDO_BRAIN_HIGH_STAKES_STRATEGY=debate above, the
        // decomposition call routes through Blue/Red/Revise (PR #242
        // wire-in). Flipped on 2026-06-18 to exercise the upgrade on
        // live Telegram traffic — heuristic gate (isComplexRequest) keeps
        // simple turns out of the decomposition path so the cost is
        // bounded.
        SUDO_AUTO_PLAN: '1',

        // Autopilot mode (owner ask 2026-06-17): raise the LoopGuard
        // consecutive-tool-iteration ceiling so a single turn can chain
        // many tool calls (langchain-agent-style ReAct loops) instead of
        // getting cut off at 15. Default in #219 was 15; bumping to 50
        // gives ~3× the headroom while keeping the absolute outer
        // agents.maxIterations:150 safety ceiling intact. Real runaway
        // tool loops still trigger long before 50; legitimate
        // multi-step research can now finish without artificial cutoff.
        SUDO_LOOP_MAX_CONSECUTIVE_TOOL_ITERS: '50',

        // Web chat token — set explicitly so relay scripts can authenticate
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || 'sudo-ai-relay-token-2026',

        // Autonomous mode: all tools auto-approved (kill-switch: set to '0' to re-enable approval gates)
        SUDO_AUTO_APPROVE: '1',

        // Bash allowlist fast-path: ApprovalManager auto-approves a strict
        // allowlist of read-only commands (ls, pwd, cat, grep, git status/log/diff, ...)
        // without consulting the policy store or sending a confirmation prompt.
        // Defense-in-depth: DANGEROUS_PREFIXES still runs BEFORE the fast-path;
        // the metachar veto (no ;&|<>`$()"') rejects chaining/substitution/redirection/quotes.
        // Kill-switch: SUDO_BASH_ALLOWLIST_FASTPATH=0 disables.
        SUDO_BASH_ALLOWLIST_FASTPATH: process.env['SUDO_BASH_ALLOWLIST_FASTPATH'] || '1',

        // Safe-service-restart fast-path: auto-approves the EXACT shape
        // `pm2|systemctl restart|reload <unit>` (3 tokens, no metachars) so the
        // agent can self-heal the daemon without a prompt. Every other mutating
        // command stays gated. Principled narrow allowlist that still applies
        // even if SUDO_AUTO_APPROVE is set back to '0'. Kill-switch: set to '0'.
        SUDO_EXEC_SAFE_RESTART: process.env['SUDO_EXEC_SAFE_RESTART'] || '1',

        // Episodic-memory dedup: byte-identical summaries recorded within the
        // window (default 24h) strengthen the prior episode instead of inserting
        // a duplicate. Collapses heartbeat-replay bloat. Kill-switch: set to '0'.
        SUDO_EPISODIC_DEDUP: process.env['SUDO_EPISODIC_DEDUP'] || '1',

        // Consciousness world-model: predict-then-resolve surprise loop (tool_use
        // forecast per turn, confidence prior seeded from the learned base rate).
        // Was previously set only in PM2's saved process def, so a restart from
        // this file would silently disable it — pinned here. Kill-switch: '0'.
        SUDO_CONSCIOUSNESS_WORLD_MODEL: process.env['SUDO_CONSCIOUSNESS_WORLD_MODEL'] || '1',

        // Comms idempotency: a re-dispatched send (email/message) that already
        // succeeded within the window is suppressed instead of double-sending.
        // Window via SUDO_COMMS_IDEMPOTENCY_WINDOW_MS (default 1h). Kill-switch: '0'.
        SUDO_COMMS_IDEMPOTENCY: process.env['SUDO_COMMS_IDEMPOTENCY'] || '1',

        // Adapter-layer guard for raw live replies (telegram/whatsapp) — separate
        // from the tool-layer guard above. Suppresses an identical live reply to
        // the same peer within the window. Fail-open. Kill-switch: '0'.
        SUDO_COMMS_ADAPTER_IDEMPOTENCY: process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] || '1',

        // Trace replay capture: persist size-capped raw tool args/result (and
        // model params) on execution traces so runs become replay-capable for
        // the eval harness. Cap via SUDO_TRACE_CAPTURE_MAX_BYTES (default 16KB).
        // Kill-switch: '0' (traces then keep only hashes, as before).
        SUDO_TRACE_CAPTURE: process.env['SUDO_TRACE_CAPTURE'] || '1',

        // Memory contradiction resolution: a newer structured fact about the
        // same subject (type+name) supersedes older ones, so recall returns the
        // current value instead of coexisting contradictions. Superseded records
        // are kept for audit, not deleted. Kill-switch: '0'.
        SUDO_MEMORY_SUPERSEDE: process.env['SUDO_MEMORY_SUPERSEDE'] || '1',

        // Free-text chunk contradiction resolution (#7): a newly dreamed fact
        // (auto-dream, source='learning') that semantically contradicts an
        // earlier one supersedes it — embedding cosine narrows to same-subject,
        // a Claude judge confirms opposition. Threshold validated for
        // text-embedding-3-small at 0.65 (override: SUDO_CHUNK_CONTRADICT_SIM).
        // Superseded chunks are kept for audit + excluded from recall.
        // Kill-switch: '0'.
        SUDO_CHUNK_CONTRADICT: process.env['SUDO_CHUNK_CONTRADICT'] || '1',

        // Corpus vector backfill (#RAG): after each dream, embed active chunks
        // that have no chunks_vec row and upsert them, so hybrid-search's vector
        // path actually returns results instead of silent BM25-only fallback.
        // Bounded per run, self-healing. Requires sqlite-vec loaded + an
        // embedding key. Kill-switch: '0'.
        SUDO_VECTOR_BACKFILL: process.env['SUDO_VECTOR_BACKFILL'] || '1',

        // Failure-learner durable store: persist the failure log + prevention
        // rules to mind.db so lessons survive a restart (default is process-
        // lifetime in-memory). Pairs with the recovery producer (fail→success
        // records a solution+rule) so the WHY memory accumulates across
        // sessions. Kill-switch: '0' (reverts to in-memory).
        SUDO_FAILURE_LEARNER_DB: process.env['SUDO_FAILURE_LEARNER_DB'] || '1',

        // Recovery reader: on a tool failure, prepend any prior-recovery
        // prevention rule/solution (recorded for the same tool+error) to the
        // tool result the model sees, so it applies the past fix before
        // retrying. Closes the read side of the learning loop. Fail-open.
        // Kill-switch: '0'.
        SUDO_FAILURE_PREVENTION_HINT: process.env['SUDO_FAILURE_PREVENTION_HINT'] || '1',

        // Fold dropped role:'system' messages into the model input (cache-safe:
        // persona prefix stays cached, folded content rides a separate uncached
        // system message). Without this, ~38 in-loop guidance/safety injections
        // (auto-plan PLAN, brief, prompt-injection warning, veto/loop-guard,
        // compaction + session-fork summaries) are silently dropped by
        // toSDKMessages and never reach the model. Per-turn cost ≈ the windowed
        // in-loop system messages. Kill-switch: '0'.
        SUDO_FOLD_SYSTEM_MESSAGES: process.env['SUDO_FOLD_SYSTEM_MESSAGES'] || '1',

        // Mythos Tier C swarm-rescue (PR #442/#443) + its StuckDetector trigger,
        // enabled 2026-06-24 after a verified live stuck-scenario test. When a
        // repeated-identical-tool-error streak is detected (a task signal, not
        // model identity), subsequent brain calls in that turn escalate to the
        // `debate` strategy to break the rut. StuckDetector also aborts a turn
        // after 5 consecutive identical errors. Thresholds use code defaults
        // (warn 3 / abort 5). Kill-switch: set either flag to '0'. The two
        // threshold keys are set explicitly to the code defaults so a `--update-env`
        // restart overwrites any earlier runtime override (pm2 does not unset
        // keys removed from this file).
        SUDO_STUCK_DETECTOR: process.env['SUDO_STUCK_DETECTOR'] || '1',
        SUDO_SWARM_RESCUE: process.env['SUDO_SWARM_RESCUE'] || '1',
        SUDO_STUCK_DETECTOR_WARN_THRESHOLD: process.env['SUDO_STUCK_DETECTOR_WARN_THRESHOLD'] || '3',
        SUDO_STUCK_DETECTOR_ABORT_THRESHOLD: process.env['SUDO_STUCK_DETECTOR_ABORT_THRESHOLD'] || '5',

        // Skip loopback/diagnostic web turns (127.0.0.1, ::1, localhost) from the
        // daily activity log so local probes / health checks / manual gateway
        // tests don't pollute the "## Today" prompt injection. Default-off in
        // code; enabled here because this deployment's loopback traffic is all
        // diagnostic (real users arrive via Telegram/cron). Extra peers via
        // SUDO_DIAGNOSTIC_PEERS. Kill-switch: '0'.
        SUDO_SKIP_DIAGNOSTIC_DAILY_LOG: process.env['SUDO_SKIP_DIAGNOSTIC_DAILY_LOG'] || '1',

        // Prompt-cache discipline: deterministic tool ordering + stable system-prompt prefix +
        // explicit Anthropic cache_control breakpoints (anthropic/* models only). Saves ~40% on
        // cached input tokens. Kill-switch: SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE=1 keeps the
        // stable prefix but skips explicit breakpoints; SUDO_PROMPT_CACHE=0 disables fully.
        SUDO_PROMPT_CACHE: process.env['SUDO_PROMPT_CACHE'] || '1',

        // Auto-update configuration (kill-switch: SUDO_UPDATE_DISABLE=1 disables entirely)
        SUDO_UPDATE_DISABLE: process.env['SUDO_UPDATE_DISABLE'] || '0',
        SUDO_UPDATE_CHANNEL: process.env['SUDO_UPDATE_CHANNEL'] || 'latest',
        SUDO_UPDATE_INTERVAL_MS: process.env['SUDO_UPDATE_INTERVAL_MS'] || '1800000',
        SUDO_UPDATE_AUTO_APPLY: process.env['SUDO_UPDATE_AUTO_APPLY'] || '1',
        SUDO_UPDATE_HEALTH_GATE: process.env['SUDO_UPDATE_HEALTH_GATE'] || '1',
        SUDO_UPDATE_MAX_VERSION: process.env['SUDO_UPDATE_MAX_VERSION'] || '',
        SUDO_UPDATE_SKIP_VERSIONS: process.env['SUDO_UPDATE_SKIP_VERSIONS'] || '',

        // IDE Bridge (kill-switch: SUDO_IDE_BRIDGE_DISABLE=1 disables entirely)
        SUDO_IDE_BRIDGE_DISABLE: process.env['SUDO_IDE_BRIDGE_DISABLE'] || '0',
        SUDO_BRIDGE_JWT_TTL_MS: process.env['SUDO_BRIDGE_JWT_TTL_MS'] || '3600000',
      },
    },

    // ---- Staging instance — Wave 2.2b tool.synthesize kill-switch testing ----
    // Not started automatically by pm2 — DevOps starts this manually for validation.
    // Runs on GATEWAY_PORT=18901 to avoid colliding with prod.
    // The tool-synthesize kill-switch is intentionally ONLY in this staging block;
    // it must NEVER appear in apps[0] (production).
    {
      // ---- Identity ----
      name: 'sudo-ai-v5-staging',     // distinct pm2 process name — never conflicts with prod
      namespace: 'default',

      // ---- Entrypoint ----
      script: 'pnpm',
      args: 'cli',
      interpreter: 'none',            // pnpm is the interpreter; pm2 must not wrap it

      // ---- Working directory ----
      cwd: CWD,

      // ---- Process management ----
      instances: 1,                   // single instance
      exec_mode: 'fork',              // fork mode (not cluster)
      autorestart: false,             // staging: do not auto-recover; fail visibly
      max_restarts: 3,
      min_uptime: "30s",
      restart_delay: 10000,            // ms between restart attempts

      // ---- Logging ----
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: path.join(CWD, 'data/logs/sudo-ai-v5-staging-out.log'),
      error_file: path.join(CWD, 'data/logs/sudo-ai-v5-staging-err.log'),
      merge_logs: false,              // keep stdout and stderr separate

      // ---- Environment ----
      // Secrets are NOT stored here — they live in config/.env.
      // DATA_DIR points at data-staging/ so staging SQLite files never pollute prod.
      env: {
        NODE_ENV: 'staging',

        // Staging gateway port — 18901 avoids collision with prod :18900.
        GATEWAY_PORT: '18901',

        // Web chat enabled on staging gateway.
        WEB_CHAT_ENABLED: 'true',
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || '',
        WEB_CHAT_ALLOWED_ORIGINS: 'http://127.0.0.1:18901,http://localhost:18901',
        SUDO_AI_CORS_ORIGINS: 'http://127.0.0.1:18901,http://localhost:18901',

        // GATEWAY_TOKEN — same as prod, enables admin endpoint auth on staging for synth-probe.
        GATEWAY_TOKEN: process.env['GATEWAY_TOKEN'] || '',

        // Pins /.well-known/agentskills.json 'registry' field origin — MUST NOT trust request headers (Wave 10 P1 HIGH-1).
        SUDO_PUBLIC_BASE_URL: 'http://127.0.0.1:18901',

        // Isolated staging data directory — separate SQLite databases from prod.
        DATA_DIR: path.join(CWD, 'data-staging'),

        // Ollama Cloud configuration — single LLM brain: deepseek-v4-pro:cloud
        SUDO_DEFAULT_MODEL: 'ollama/deepseek-v4-pro:cloud',
        SUDO_FALLBACK_MODEL: 'ollama/qwen3.5:latest',
        OLLAMA_URL: 'https://ollama.com/v1',

        // Web chat token
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || 'sudo-ai-relay-token-2026',

        // Autonomous mode: all tools auto-approved (kill-switch: set to '0' to re-enable approval gates)
        SUDO_AUTO_APPROVE: '1',

        // Bash allowlist fast-path (see prod block for full rationale).
        // Enabled on staging so any UX regression surfaces here before prod.
        SUDO_BASH_ALLOWLIST_FASTPATH: process.env['SUDO_BASH_ALLOWLIST_FASTPATH'] || '1',

        // Prompt-cache discipline (see prod block for full rationale). Default ON on staging
        // so any cache-related regression surfaces here before reaching prod.
        SUDO_PROMPT_CACHE: process.env['SUDO_PROMPT_CACHE'] || '1',

        // Kill-switch: enables tool.synthesize pipeline (bwrap sandbox + AST analysis).
        // MUST remain staging-only — never copy to apps[0] production env block.
        SUDO_TOOL_SYNTHESIZE_ENABLED: '1',

        // Kill-switch: disables Telegram getUpdates polling on staging to prevent
        // 409 Conflict with prod (both share the same TELEGRAM_BOT_TOKEN).
        // Will take effect at the 14:00Z seal-soak gate restart.
        SUDO_TELEGRAM_DISABLE: '1',

        // Auto-update configuration — disabled on staging by default
        SUDO_UPDATE_DISABLE: '1',
        SUDO_UPDATE_CHANNEL: 'stable',

        // IDE Bridge — disabled on staging
        SUDO_IDE_BRIDGE_DISABLE: '1',
        SUDO_BRIDGE_JWT_TTL_MS: '3600000',
      },
    },
  ],
};
