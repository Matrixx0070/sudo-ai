/**
 * PM2 Ecosystem Config — SUDO-AI v5 federation peer-b
 *
 * Role:   Secondary federation node (port 18901).
 *         Runs alongside peer-a to prove cross-instance audit event propagation.
 *
 * Usage:
 *   pm2 start ops/federation/ecosystem-peer-b.config.cjs
 *
 * Federation flow:
 *   peer-b outbound: publishes to peer-a on port 18900 using TOKEN_B_TO_A.
 *   peer-b inbound:  accepts events bearing TOKEN_A_TO_B in Authorization: Bearer.
 *
 * Secrets: SUDO_ADMIN_TOKEN must be set in the environment before pm2 start.
 *          All federation tokens below are demo values. Replace before production use.
 *          See ops/federation/README.md for production token guidance.
 *
 * Wave 8C — federation cross-instance handshake.
 */

'use strict';

const path = require('path');

// CWD is the project root — defaulting to two levels above this file's location.
// Override by setting SUDO_AI_HOME before running pm2.
const CWD = process.env.SUDO_AI_HOME || path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      // ---- Identity ----
      name: 'sudo-ai-peer-b',  // pm2 process name — must differ from peer-a and sudo-ai-v5
      namespace: 'federation',

      // ---- Entrypoint (mirrors primary ecosystem.config.cjs) ----
      script: 'pnpm',
      args: 'cli',
      interpreter: 'none',     // pnpm is not a node script — pm2 must not wrap it

      // ---- Working directory ----
      cwd: CWD,

      // ---- Process management ----
      instances: 1,            // single instance — Telegram bot cannot fan-out
      exec_mode: 'fork',       // fork mode required for ESM + native addons (better-sqlite3)
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      restart_delay: 3000,

      // ---- Logging ----
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Peer-b gets its own log files to separate output from peer-a.
      out_file: '/tmp/sudo-ai-peer-b-data/logs/sudo-ai-peer-b-out.log',
      error_file: '/tmp/sudo-ai-peer-b-data/logs/sudo-ai-peer-b-err.log',
      merge_logs: false,

      // ---- Environment ----
      // Secrets (SUDO_ADMIN_TOKEN, ANTHROPIC_API_KEY, etc.) must come from the
      // shell environment or config/.env — never hardcoded here.
      env: {
        NODE_ENV: 'production',

        // peer-b listens on 18901 (18900 is used by peer-a / primary).
        PORT: '18901',
        GATEWAY_PORT: '18901',

        // Instance identifier — must be unique across all peers.
        SUDO_INSTANCE_ID: 'peer-b',

        // Separate data directory prevents DB collision with peer-a.
        // /tmp path is safe for ephemeral testing; use a persistent path for production.
        DATA_DIR: '/tmp/sudo-ai-peer-b-data',

        // Claude proxy port — 3005 avoids collision with peer-a (3003).
        CLAUDE_PROXY_PORT: '3005',

        // Disable web chat to avoid port conflict.
        WEB_CHAT_ENABLED: 'false',
        WEB_CHAT_PORT: '3006',  // spare port as defence-in-depth

        // Brain target.
        SUDOAPI_GATEWAY_URL: 'https://sudoapi.shop',

        // ---- Federation outbound ----
        // peer-b publishes to peer-a on 18900 using TOKEN_B_TO_A.
        // SECURITY: Replace demo tokens with cryptographically random secrets (32+ bytes).
        //   openssl rand -hex 32
        SUDO_FEDERATION_PEERS: '[{"name":"peer-a","url":"http://localhost:18900","token":"demo_fed_token_b"}]',

        // ---- Federation inbound ----
        // peer-b accepts events from peer-a bearing TOKEN_A_TO_B.
        SUDO_FEDERATION_INBOUND_TOKENS: '["demo_fed_token_a"]',

        // Admin token — MUST be overridden by SUDO_ADMIN_TOKEN in shell env.
        // The real token is read from config/.env or the shell environment.
        // SUDO_ADMIN_TOKEN: (set in shell before running pm2)
      },
    },
  ],
};
