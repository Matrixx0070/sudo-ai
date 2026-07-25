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
}

export interface GrokMcpBoundary {
  connectorId: string;
  serverUrl: string;
  tools: GrokMcpTool[];
  stop(): Promise<void>;
}

const ENV_CONNECTOR_ID = 'SUDO_GROK_WEB_MCP_CONNECTOR_ID';

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

  // Construction enforces the readonly allowlist (throws before we touch grok).
  const server: McpPublicServer = createMcpPublicServer({
    token: opts.token,
    exposedTools: opts.exposedTools,
    registry: opts.registry,
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
