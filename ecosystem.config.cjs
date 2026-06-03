/**
 * PM2 Ecosystem Config — SUDO-AI v5 (Wave 5 P3)
 *
 * Process: sudo-ai-v5
 * Entry:   pnpm cli  (= tsx src/cli.ts — headless gateway + agent stack)
 * Ports:   GATEWAY_PORT=18900        (18800 occupied by another process)
 *          CLAUDE_PROXY_PORT=3003    (3002 occupied by the 18800 process)
 *          WEB_CHAT enabled          (attached to gateway :18900 — no second port)
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
      // pnpm cli = tsx src/cli.ts (headless, no Electron)
      script: 'pnpm',
      args: 'cli',
      interpreter: 'none',          // pnpm is the interpreter; pm2 must not wrap it

      // ---- Working directory ----
      cwd: CWD,

      // ---- Process management ----
      instances: 1,                 // single instance — Telegram bot cannot fan-out
      exec_mode: 'fork',            // fork mode (not cluster — ESM + native addons)
      autorestart: true,            // restart on crash
      max_restarts: 5,              // cap crash-loop restarts before pm2 gives up
      min_uptime: "30s",            // must stay alive 10 s to count as stable start
      restart_delay: 10000,          // ms between restart attempts

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

        // Add wasmtime to PATH for WASM sandbox tool execution
        PATH: `${process.env.PATH}:/root/.wasmtime/bin`,

        // Gateway listens on 18900 (18800 occupied by the original sudo-ai process).
        // Overrides default in src/core/gateway/server.ts.
        GATEWAY_PORT: '18900',

        // Claude proxy (local Anthropic API shim) defaults to 3002.
        // 3002 is already occupied by the process on 18800 — use 3003 instead.
        // Configured in src/core/brain/claude-proxy.ts.
        CLAUDE_PROXY_PORT: '3003',

        // Web chat attaches to the gateway server (:18900/chat, :18900/chat/ws).
        // No second port is opened; WEB_CHAT_PORT is obsolete and ignored.
        WEB_CHAT_ENABLED: 'true',
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || '',
        WEB_CHAT_ALLOWED_ORIGINS: 'http://127.0.0.1:18900,http://localhost:18900,https://sudoapi.shop',
        SUDO_AI_CORS_ORIGINS: 'https://sudoapi.shop,http://127.0.0.1:18900,http://localhost:18900',

        // GATEWAY_TOKEN protects /v1/admin/* endpoints including synth-probe.
        // Wave 2.2h-tail security HIGH-1: must be set or admin endpoints are unauthenticated.
        GATEWAY_TOKEN: process.env['GATEWAY_TOKEN'] || '',

        // Pins /.well-known/agentskills.json 'registry' field origin — MUST NOT trust request headers (Wave 10 P1 HIGH-1).
        SUDO_PUBLIC_BASE_URL: 'https://sudoapi.shop',

        // Brain/SUDOAPI provider target. Must be set in pm2 env (not only .env)
        // because src/core/brain/sudoapi-provider.ts reads this at module load,
        // before dotenv has populated process.env. Default fallback is
        // http://127.0.0.1:18800 which ECONNREFUSED-storms the log.
        SUDOAPI_GATEWAY_URL: 'https://sudoapi.shop',

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

        // Web chat token — set explicitly so relay scripts can authenticate
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || 'sudo-ai-relay-token-2026',
      },
    },

    // ---- Staging instance — Wave 2.2b tool.synthesize kill-switch testing ----
    // Not started automatically by pm2 — DevOps starts this manually for validation.
    // Runs on GATEWAY_PORT=18901 and CLAUDE_PROXY_PORT=3004 to avoid colliding with prod.
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

        // Claude proxy port — 3004 avoids collision with prod :3003.
        CLAUDE_PROXY_PORT: '3004',

        // Web chat enabled on staging gateway.
        WEB_CHAT_ENABLED: 'true',
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || '',
        WEB_CHAT_ALLOWED_ORIGINS: 'http://127.0.0.1:18901,http://localhost:18901,https://sudoapi.shop',
        SUDO_AI_CORS_ORIGINS: 'https://sudoapi.shop,http://127.0.0.1:18900,http://localhost:18900',

        // GATEWAY_TOKEN — same as prod, enables admin endpoint auth on staging for synth-probe.
        GATEWAY_TOKEN: process.env['GATEWAY_TOKEN'] || '',

        // Pins /.well-known/agentskills.json 'registry' field origin — MUST NOT trust request headers (Wave 10 P1 HIGH-1).
        SUDO_PUBLIC_BASE_URL: 'https://sudoapi.shop',

        // Brain/SUDOAPI provider target — same upstream as prod.
        SUDOAPI_GATEWAY_URL: 'https://sudoapi.shop',

        // Isolated staging data directory — separate SQLite databases from prod.
        DATA_DIR: path.join(CWD, 'data-staging'),

        // Ollama Cloud configuration — single LLM brain: deepseek-v4-pro:cloud
        SUDO_DEFAULT_MODEL: 'ollama/deepseek-v4-pro:cloud',
        SUDO_FALLBACK_MODEL: 'ollama/qwen3.5:latest',
        OLLAMA_URL: 'https://ollama.com/v1',

        // Web chat token
        WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'] || 'sudo-ai-relay-token-2026',

        // Kill-switch: enables tool.synthesize pipeline (bwrap sandbox + AST analysis).
        // MUST remain staging-only — never copy to apps[0] production env block.
        SUDO_TOOL_SYNTHESIZE_ENABLED: '1',

        // Kill-switch: disables Telegram getUpdates polling on staging to prevent
        // 409 Conflict with prod (both share the same TELEGRAM_BOT_TOKEN).
        // Will take effect at the 14:00Z seal-soak gate restart.
        SUDO_TELEGRAM_DISABLE: '1',
      },
    },
  ],
};
