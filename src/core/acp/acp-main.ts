/**
 * @file acp/acp-main.ts
 * @description ACP stdio agent — boot + wiring.
 *
 * Loaded via a dynamic import from acp-cli.ts AFTER the stdout-protection env
 * (SUDO_LOG_STDERR / DOTENV_CONFIG_QUIET) is set, so the logger and dotenv here
 * keep stdout clean for the JSON-RPC channel.
 *
 * Slice 1 was chat-only. Slice 2 (gap #26) added the protocol pieces for tool
 * dispatch + `session/request_permission` round-trip. Slice 3 wires a curated
 * `AcpToolHost` over the standard ACP `fs/*` + `terminal/*` client methods:
 *
 *   - fs.read_text_file / fs.write_text_file
 *   - terminal.create / terminal.output / terminal.wait_for_exit /
 *     terminal.kill / terminal.release
 *
 * Trust contract: writes / spawns / kills require `session/request_permission`;
 * reads / waits / releases do not. The standalone ACP process does NOT load the
 * full sudo-ai ToolRegistry (which depends on cli.ts boot scaffolding); this
 * curated set is enough for an editor-driven coding agent and follows the ACP
 * spec exactly.
 *
 * Permission gate (`requestPermission`) reaches the client over
 * `session/request_permission`; fs/terminal tool calls reach the client over
 * their respective spec methods. Both use {@link JsonRpcConnection.sendRequest}.
 *
 * Optional env:
 *   SUDO_ACP_MODEL — pin a model string (default: Brain smart-routing).
 *   SUDO_ACP_TOOLS — set to `0` to disable the fs/terminal tool host and
 *                    revert to slice-1 chat-only behavior.
 */

import { ConfigLoader } from '../config/loader.js';
import { Brain } from '../brain/brain.js';
import { JsonRpcConnection } from './jsonrpc.js';
import { AcpServer } from './acp-server.js';
import path from 'node:path';
import { BrainAcpBackend, type AcpBackendOptions } from './brain-backend.js';
import { makeJsonRpcClientFacade } from './client-facade.js';
import { SessionStore } from './session-store.js';
import { DATA_DIR } from '../shared/paths.js';
import { buildAcpToolHost } from './tools/index.js';
import type { RequestPermissionParams, RequestPermissionResult } from './types.js';

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
  const toolsEnabled = process.env['SUDO_ACP_TOOLS'] !== '0';
  const sessionStoreEnabled = process.env['SUDO_ACP_PERSIST'] !== '0';

  const conn = new JsonRpcConnection(process.stdin, process.stdout);

  // Slice 4: per-session JSON store under <DATA_DIR>/acp-sessions/. Enabling
  // this lights up `session/load` and survives process restarts. Disabled via
  // SUDO_ACP_PERSIST=0 for editors that don't want disk persistence (the
  // store is also harmless: it falls back to in-memory if writes fail).
  const sessionStore = sessionStoreEnabled
    ? new SessionStore({ baseDir: path.join(DATA_DIR, 'acp-sessions') })
    : undefined;

  // Build the curated fs/terminal tool host over the ACP client facade.
  // Permission round-trips reach the client via server.requestPermission(...)
  // (`session/request_permission`); fs/terminal tool calls reach the client
  // via their spec methods (fs/read_text_file, etc.). server is constructed
  // below; the closure captures it so the requestPermission lambda binds at
  // call time.
  let server: AcpServer | undefined;
  const backendOptions: AcpBackendOptions = {
    ...(model ? { model } : {}),
    ...(sessionStore ? { sessionStore } : {}),
  };
  if (toolsEnabled) {
    // Build the facade + host lazily so SUDO_ACP_TOOLS=0 reverts to the
    // slice-1 chat-only behavior without constructing them at all (verifier
    // MED 1 — the discarded objects were a future-reader trap).
    const facade = makeJsonRpcClientFacade(conn);
    const host = buildAcpToolHost({ facade });
    backendOptions.tools = {
      host,
      requestPermission: (params: RequestPermissionParams): Promise<RequestPermissionResult> => {
        if (!server) {
          throw new Error('AcpServer not constructed yet');
        }
        return server.requestPermission(params);
      },
    };
  }

  const backend = new BrainAcpBackend(brain, backendOptions);
  server = new AcpServer(conn, backend, { agentName: 'sudo-ai', agentVersion: version });
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
