/**
 * @file acp/acp-main.ts
 * @description ACP stdio agent — boot + wiring.
 *
 * Loaded via a dynamic import from acp-cli.ts AFTER the stdout-protection env
 * (SUDO_LOG_STDERR / DOTENV_CONFIG_QUIET) is set, so the logger and dotenv here
 * keep stdout clean for the JSON-RPC channel.
 *
 * Slice 1 was chat-only. Slice 2 (gap #26) lands the protocol pieces for
 * tool dispatch + ACP `session/request_permission` round-trip + the new
 * `session/update` variants (tool_call, tool_call_update, thought). The
 * tool-dispatch path is live in BrainAcpBackend whenever a tool host is
 * injected; this entry intentionally does NOT inject one yet because a
 * standalone ACP subprocess does not boot the cli.ts dependencies (provider
 * keys, session manager, hook manager, plugin loader) that the real
 * ToolRegistry needs. Wiring a host (or a curated read-only subset) is
 * slice 3 work, alongside fs/terminal client methods.
 *
 * Optional env:
 *   SUDO_ACP_MODEL — pin a model string (default: Brain smart-routing).
 */

import { ConfigLoader } from '../config/loader.js';
import { Brain } from '../brain/brain.js';
import { JsonRpcConnection } from './jsonrpc.js';
import { AcpServer } from './acp-server.js';
import { BrainAcpBackend } from './brain-backend.js';

export async function runAcpServer(): Promise<void> {
  let brain: Brain;
  try {
    const loader = new ConfigLoader();
    await loader.load();
    brain = new Brain(loader.get());
  } catch (err) {
    process.stderr.write(`[acp] config load failed, using env-only brain: ${String(err)}\n`);
    brain = new Brain(null);
  }

  const version = process.env['npm_package_version'] ?? '0.0.0';
  const model = process.env['SUDO_ACP_MODEL'] || undefined;

  // Slice 2: no real tool host wired here yet (see file header). The backend
  // collapses to slice 1 chat-only behavior when `tools` is omitted.
  const backend = new BrainAcpBackend(brain, model ? { model } : {});
  const conn = new JsonRpcConnection(process.stdin, process.stdout);
  const server = new AcpServer(conn, backend, { agentName: 'sudo-ai', agentVersion: version });
  server.start();

  process.stderr.write('[acp] sudo-ai ACP agent ready on stdio\n');

  // Long-lived editor subprocess: log stray rejections to stderr (never stdout)
  // and stay alive rather than crashing the session on a background failure.
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[acp] unhandledRejection: ${String(err)}\n`);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  // Editor disconnected — stdin closed.
  process.stdin.on('end', () => process.exit(0));
}
