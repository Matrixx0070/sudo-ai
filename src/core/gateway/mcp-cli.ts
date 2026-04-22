/**
 * @file mcp-cli.ts
 * @description MCP Loopback Server CLI entrypoint.
 *
 * Usage: node dist/core/gateway/mcp-cli.js
 *
 * Required env:
 *   SUDO_MCP_TOKEN   — bearer token for auth
 *
 * Optional env:
 *   SUDO_MCP_EXPOSE_TOOLS  — comma-separated tool allowlist
 *   SUDO_MCP_ALLOW_SHELL   — set to '1' to expose system.shell-exec
 *   LOG_LEVEL              — pino log level (default: info)
 */

import { ToolRegistry } from '../tools/registry.js';
import { HookManager } from '../hooks/index.js';
import { createMCPServerFromEnv } from './mcp-server.js';

// Boot sequence: build registry, attach hooks, start server.
async function main(): Promise<void> {
  const registry = new ToolRegistry();

  // Attempt to load the global registry if the agent has already initialised it.
  const globalRegistry = ToolRegistry.getGlobal();
  const effectiveRegistry = globalRegistry ?? registry;

  const hooks = new HookManager();

  const server = createMCPServerFromEnv(effectiveRegistry, hooks);

  process.on('SIGINT', async () => {
    process.stderr.write('[mcp-cli] Received SIGINT — stopping\n');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    process.stderr.write('[mcp-cli] Received SIGTERM — stopping\n');
    await server.stop();
    process.exit(0);
  });

  await server.start();
}

main().catch((err) => {
  process.stderr.write(`[mcp-cli] Fatal error: ${String(err)}\n`);
  process.exit(1);
});
