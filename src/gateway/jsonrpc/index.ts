/**
 * @file src/gateway/jsonrpc/index.ts
 * @description Entry point for the FleetView JSON-RPC gateway (gap #25 slice 3).
 *
 * Reads env config, then attaches a JsonRpcConnection to process.stdin /
 * process.stdout. Misconfig fails honestly on stderr + exit 1 — no JSON-RPC
 * envelope on the way out, because the consumer hasn't opened a session yet.
 *
 * Invoke via `pnpm gateway:fleetview` (uses tsx — same dev-runnable pattern as
 * the TUI; no separate build target this slice).
 */

import { readConfigFromEnv } from './fetcher.js';
import { startGatewayServer } from './server.js';

async function main(): Promise<void> {
  const cfgResult = readConfigFromEnv();
  if (!cfgResult.ok) {
    process.stderr.write(`gateway-fleetview: ${cfgResult.error}\n`);
    process.exit(1);
  }

  startGatewayServer(process.stdin, process.stdout, cfgResult.config);

  // Lifecycle: clean exit on parent stdin close OR explicit termination.
  // Matches src/core/acp/acp-main.ts so subprocess hosts (systemd, Docker,
  // Claude Code's own teardown) behave consistently across the two surfaces.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

void main();
