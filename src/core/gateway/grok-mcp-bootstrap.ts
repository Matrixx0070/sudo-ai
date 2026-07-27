/**
 * @file grok-mcp-bootstrap.ts
 * @description Startup wiring for the grok-web-mcp brain lane (ADR 0001). Runs
 * OUTSIDE the hot path: starts the hardened public MCP server, then registers +
 * per-user CONNECTS + discovers the connector on grok's side, and publishes the
 * resulting connectorId to the provider via env (SUDO_GROK_WEB_MCP_CONNECTOR_ID)
 * — the injected-callback seam that keeps src/llm free of core/gateway imports.
 *
 * Idempotent per (name, team scope): connectors/create returns the same id, and
 * connect is safe to repeat. Fail-loud: a not-ready connector or empty tool
 * discovery aborts so the operator sees it before flipping the routing flag.
 *
 * The public server binds loopback; `publicBaseUrl` is the internet-reachable
 * origin a reverse proxy / cloudflared tunnel fronts it with. serverUrl is a
 * plain param → the endpoint is replaceable (escape velocity) with a config edit.
 */

import type { ToolRegistry } from '../tools/registry.js';
import type { HookManager } from '../hooks/index.js';
import { createLogger } from '../shared/logger.js';
import { createMcpPublicServer, type McpPublicServer } from './mcp-public-server.js';
import {
  createGrokMcpConnector,
  connectGrokMcpConnector,
  discoverGrokMcpTools,
  removeGrokMcpConnector,
  type GrokMcpTool,
} from '../../llm/grok-mcp-connector.js';

const log = createLogger('gateway:grok-mcp-bootstrap');

/** Grok connector-lifecycle functions, injectable for tests (default = real). */
export interface GrokMcpLifecycle {
  create: typeof createGrokMcpConnector;
  connect: typeof connectGrokMcpConnector;
  discover: typeof discoverGrokMcpTools;
  remove: typeof removeGrokMcpConnector;
}

export interface GrokMcpBoundaryOptions {
  registry: ToolRegistry;
  /** REQUIRED explicit readonly tool allowlist (CSV) — enforced by the server. */
  exposedTools: string;
  /** Internet-reachable origin fronting the loopback server (no trailing /rpc). */
  publicBaseUrl: string;
  /** Capability token — also the URL path segment. */
  token: string;
  /** grok team scope id that holds the SuperGrok sub. */
  teamId: string;
  connectorName: string;
  port?: number;
  hooks?: HookManager;
  lifecycle?: GrokMcpLifecycle;
  /**
   * OPTIONAL single full-control tool (agent.command) exposed past the
   * readonly-only rule so Grok app-chat can DRIVE the agent, not just query it.
   * Absent = strictly-readonly boundary (default). See mcp-public-server.ts.
   */
  commandTool?: string;
}

export interface GrokMcpBoundary {
  connectorId: string;
  serverUrl: string;
  tools: GrokMcpTool[];
  stop(): Promise<void>;
}

const ENV_CONNECTOR_ID = 'SUDO_GROK_WEB_MCP_CONNECTOR_ID';

/**
 * Filter a requested CSV allowlist to tools ACTUALLY registered + readonly at
 * this boot. Some tools register conditionally (env/feature-gated) or are
 * config-disabled, so a hard fail on one absent name would take down the whole
 * boundary. Dropping = LESS exposure = fail-safe. Pure + exported for testing.
 */
export function resolveBoundaryAllowlist(
  registry: ToolRegistry,
  exposedTools: string,
): { valid: string[]; dropped: string[] } {
  const requested = exposedTools.split(',').map((s) => s.trim()).filter(Boolean);
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const name of requested) {
    const def = registry.get(name);
    if (def && def.safety === 'readonly') valid.push(name);
    else dropped.push(name);
  }
  return { valid, dropped };
}

function defaultLifecycle(): GrokMcpLifecycle {
  return {
    create: createGrokMcpConnector,
    connect: connectGrokMcpConnector,
    discover: discoverGrokMcpTools,
    remove: removeGrokMcpConnector,
  };
}

/**
 * Stand up the whole grok-web-mcp boundary and return a handle. On any failure
 * the partially-started server is torn down before rethrowing.
 */
export async function startGrokMcpBoundary(opts: GrokMcpBoundaryOptions): Promise<GrokMcpBoundary> {
  const lc = opts.lifecycle ?? defaultLifecycle();
  const serverUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/mcp/${opts.token}/rpc`;

  // Filter to tools present + readonly at boot (see resolveBoundaryAllowlist).
  // The security primitive (mcp-public-server) still enforces strictly on what
  // it receives; only genuinely-present readonly tools ever reach it.
  const { valid, dropped } = resolveBoundaryAllowlist(opts.registry, opts.exposedTools);
  if (dropped.length > 0) {
    log.warn({ dropped, kept: valid }, 'grok-web-mcp: dropped unregistered/non-readonly tools from the allowlist');
  }
  const commandTool = opts.commandTool?.trim() || undefined;
  // A boundary with no readonly tools is fine IFF the full-control command tool
  // is present — that alone is a complete "drive the agent" surface.
  if (valid.length === 0 && !commandTool) {
    throw new Error(
      `grok-web-mcp: none of the allowlisted tools are registered+readonly at boot (requested: ${opts.exposedTools})`,
    );
  }
  if (commandTool && !opts.registry.get(commandTool)) {
    throw new Error(
      `grok-web-mcp: commandTool "${commandTool}" is not registered — is SUDO_GROK_WEB_MCP_COMMAND=1 set so agent.command loads?`,
    );
  }

  // Construction enforces the readonly allowlist (throws before we touch grok).
  const server: McpPublicServer = createMcpPublicServer({
    token: opts.token,
    exposedTools: valid.join(','),
    registry: opts.registry,
    ...(commandTool ? { commandTool } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.port ? { port: opts.port } : {}),
  });
  await server.start();

  let connectorId = '';
  try {
    connectorId = await lc.create(opts.connectorName, opts.teamId, serverUrl);
    await lc.connect(opts.teamId, connectorId);
    const tools = await lc.discover(opts.teamId, connectorId);
    if (tools.length === 0) {
      throw new Error('grok discovered ZERO tools from the connector (unreachable endpoint or empty allowlist?)');
    }
    process.env[ENV_CONNECTOR_ID] = connectorId;
    log.info(
      { connectorId, serverUrl, tools: tools.map((t) => t.name), port: server.port },
      'grok-web-mcp boundary ready (connector registered, connected, discovered)',
    );
    return {
      connectorId,
      serverUrl,
      tools,
      async stop(): Promise<void> {
        if (process.env[ENV_CONNECTOR_ID] === connectorId) delete process.env[ENV_CONNECTOR_ID];
        await lc.remove(opts.teamId, connectorId).catch((e) => log.warn({ err: String(e) }, 'connector remove failed'));
        await server.stop();
      },
    };
  } catch (err) {
    // Roll back: remove a half-created connector and stop the server.
    if (connectorId) await lc.remove(opts.teamId, connectorId).catch(() => {});
    await server.stop();
    throw err;
  }
}
