/**
 * PM2 Ecosystem Config — SUDO-AI v5 federation peer-a
 *
 * Role:   Primary federation node (port 18900 — same as the default primary process).
 *         Configure peer-a alongside peer-b for cross-instance audit event publishing.
 *
 * Usage:
 *   pm2 start ops/federation/ecosystem-peer-a.config.cjs
 *
 * Federation flow:
 *   peer-a outbound: publishes to peer-b on port 18901 using TOKEN_A_TO_B.
 *   peer-a inbound:  accepts events bearing TOKEN_B_TO_A in Authorization: Bearer.
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
      name: 'sudo-ai-peer-a',  // pm2 process name — distinct from 'sudo-ai-v5' default
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
      out_file: path.join(CWD, 'data/logs/sudo-ai-peer-a-out.log'),
      error_file: path.join(CWD, 'data/logs/sudo-ai-peer-a-err.log'),
      merge_logs: false,

      // ---- Environment ----
      // Secrets (SUDO_ADMIN_TOKEN, ANTHROPIC_API_KEY, etc.) must come from the
      // shell environment or config/.env — never hardcoded here.
      env: {
        NODE_ENV: 'production',

        // Gateway port for peer-a (same as primary default — 18900).
        // peer-b will reference this port.
        PORT: '18900',
        GATEWAY_PORT: '18900',

        // Instance identifier — used as the federation source label.
        // Must be unique across all peers in the cluster.
        SUDO_INSTANCE_ID: 'peer-a',

        // Data directory — kept at default to reuse primary's DB.
        DATA_DIR: path.join(CWD, 'data'),

        // Claude proxy port — must not collide with peer-b (3005).
        CLAUDE_PROXY_PORT: '3003',

        // Disable web chat to avoid port conflict.
        WEB_CHAT_ENABLED: 'false',
        WEB_CHAT_PORT: '3004',

        // ---- Federation outbound ----
        // peer-a publishes to peer-b on 18901 using TOKEN_A_TO_B.
        // SECURITY: Replace demo tokens with cryptographically random secrets (32+ bytes).
        //   openssl rand -hex 32
        // In production the token values must be set as env vars, not here.
        SUDO_FEDERATION_PEERS: '[{"name":"peer-b","url":"http://localhost:18901","token":"demo_fed_token_a"}]',

        // ---- Federation inbound ----
        // peer-a accepts events from peer-b bearing TOKEN_B_TO_A.
        SUDO_FEDERATION_INBOUND_TOKENS: '["demo_fed_token_b"]',

        // Admin token — MUST be overridden by SUDO_ADMIN_TOKEN in shell env.
        // This placeholder prevents the gateway from starting in open-admin mode.
        // The real token is read from config/.env or the shell environment.
        // SUDO_ADMIN_TOKEN: (set in shell before running pm2)
      },
    },
  ],
};
