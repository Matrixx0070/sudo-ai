/**
 * @file acp/acp-main.ts
 * @description ACP stdio agent — boot + wiring.
 *
 * Loaded via a dynamic import from acp-cli.ts AFTER the stdout-protection env
 * (SUDO_LOG_STDERR / DOTENV_CONFIG_QUIET) is set, so the logger and dotenv here
 * keep stdout clean for the JSON-RPC channel.
 *
 * Slice 1 is chat-only: drives sudo-ai's multi-provider Brain and streams
 * `agent_message_chunk` updates. Tools / agent-loop, fs + terminal delegation,
 * session/load, and permission round-trips are follow-up slices.
 *
 * Optional env: SUDO_ACP_MODEL — pin a model string (default: Brain smart-routing).
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

  const backend = new BrainAcpBackend(brain, model);
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
