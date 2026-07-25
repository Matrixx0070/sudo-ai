/**
 * @file grok-mcp-connector.ts
 * @description NATIVE MCP tool-calling for the free grok.com app-chat lane —
 * the fix for prompt-emulation's proven unreliability (2026-07-25 incident:
 * consumer persona narrated "browser tool executing..." instead of calling a
 * real tool). grok's backend supports registering MCP servers as team
 * "connectors"; once attached to a conversation, grok calls the connector's
 * tools SERVER-SIDE — sanctioned, no persona fight (RE'd + proven end-to-end,
 * docs/STATSIG_RERE_2026-07-25.md sibling research; see memory
 * reference-grok-web-brain-feasibility.md "PATH A CRACKED").
 *
 * Cookie-only, statsig-FREE (registration/discovery/removal). Only the actual
 * conversation turn that USES the connector needs a statsig mint (chatGrokWeb
 * already handles that).
 *
 * TRUST BOUNDARY: `serverUrl` must be an internet-reachable HTTPS endpoint —
 * grok's CLOUD calls it directly (never the browser). The endpoint itself
 * (src/core/gateway/mcp-http-transport.ts) is the hardened side of this
 * boundary: capability-token auth, stateless re-validation, narrow tool
 * allowlist. This module only handles connector lifecycle on grok's side.
 */

import { callGrokWebBridge, type GrokWebCreds } from './grok-web-bridge.js';
import { getGrokWebSessionManager, type GrokWebSessionManager } from './grok-web-session-manager.js';

export interface GrokMcpDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokWebBridge;
}

function defaultDeps(): GrokMcpDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokWebBridge };
}

async function credsOf(deps: GrokMcpDeps): Promise<GrokWebCreds> {
  const s = await deps.manager.ensureHealthy();
  return { cookie: s.cookie, userAgent: s.userAgent };
}

export interface GrokMcpTool {
  name: string;
  remoteName?: string;
  title?: string;
  description?: string;
  jsonSchema?: unknown;
}

/**
 * Register (idempotent by name+scope — re-create to flip fields) an MCP
 * connector on the team scope. `serverUrl` must be reachable by grok's
 * backend, not just this host.
 */
export async function createGrokMcpConnector(
  name: string,
  teamId: string,
  serverUrl: string,
  deps: GrokMcpDeps = defaultDeps(),
): Promise<string> {
  const r = await deps.bridge({ op: 'mcp_connector_create', name, teamId, serverUrl }, await credsOf(deps));
  if (!r.ok || !r.connectorId) {
    throw new Error(`grok MCP connector create failed: ${r.errorClass ?? 'error'}${r.detail ? ` (${r.detail})` : ''}`);
  }
  return r.connectorId;
}

/**
 * Per-user "Connect" — mark a registered MCP connector authValid:true for the
 * calling user. REQUIRED before grok's model will invoke the connector's tools
 * in chat (RE'd 2026-07-25: team-scope create + discovery are NOT enough; the UI
 * "Connect" button performs this per-user activation). Idempotent.
 */
export async function connectGrokMcpConnector(
  teamId: string,
  connectorId: string,
  deps: GrokMcpDeps = defaultDeps(),
): Promise<void> {
  const r = await deps.bridge({ op: 'mcp_connect', teamId, connectorId }, await credsOf(deps));
  if (!r.ok) {
    throw new Error(`grok MCP connect failed: ${r.errorClass ?? 'error'}${r.detail ? ` (${r.detail})` : ''}`);
  }
}

/** List the tools a registered MCP connector exposes (as grok sees them). */
export async function discoverGrokMcpTools(
  teamId: string,
  connectorId: string,
  deps: GrokMcpDeps = defaultDeps(),
): Promise<GrokMcpTool[]> {
  const r = await deps.bridge({ op: 'mcp_discover', teamId, connectorId }, await credsOf(deps));
  if (!r.ok) throw new Error(`grok MCP discover failed: ${r.errorClass ?? 'error'}${r.detail ? ` (${r.detail})` : ''}`);
  return r.mcpTools ?? [];
}

/** Deregister an MCP connector. */
export async function removeGrokMcpConnector(
  teamId: string,
  connectorId: string,
  deps: GrokMcpDeps = defaultDeps(),
): Promise<void> {
  const r = await deps.bridge({ op: 'mcp_connector_remove', teamId, connectorId }, await credsOf(deps));
  if (!r.ok) throw new Error(`grok MCP connector remove failed: ${r.errorClass ?? 'error'}${r.detail ? ` (${r.detail})` : ''}`);
}
