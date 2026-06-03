/**
 * @file mcp-registry.ts
 * @description Upgrade 43 — MCP (Model Context Protocol) Server Registry.
 *
 * Tracks external MCP servers: registration, connection state, trust tiers,
 * and per-tool enable/disable filtering.
 * All state is in-process; persistence can be layered on top by callers.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('plugins:mcp-registry');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type McpTrustTier = 'bundled' | 'indexed' | 'unreviewed';

export interface McpToolInfo {
  name: string;
  description?: string;
  enabled: boolean;
  discoveredAt?: string;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  description?: string;
  status: McpServerStatus;
  trustTier: McpTrustTier;
  transport?: 'stdio' | 'http' | 'sse' | 'websocket';
  tools: Map<string, McpToolInfo>;
  addedAt: string;
  lastConnectedAt?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// In-process registry
// ---------------------------------------------------------------------------

const servers: Map<string, McpServer> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new MCP server. Generates a unique time-based ID.
 *
 * @param name        - Human-readable server name.
 * @param url         - Base URL of the MCP server.
 * @param description - Optional description.
 * @param trustTier   - Trust tier (default: 'unreviewed').
 * @param transport   - Transport type (default: 'http').
 * @returns The registered McpServer record.
 */
export function registerMcpServer(
  name: string,
  url: string,
  description?: string,
  trustTier: McpTrustTier = 'unreviewed',
  transport: 'stdio' | 'http' | 'sse' | 'websocket' = 'http',
): McpServer {
  if (!name || typeof name !== 'string') throw new Error('McpRegistry: name is required');
  if (!url || typeof url !== 'string') throw new Error('McpRegistry: url is required');

  const id = `mcp-${Date.now()}`;
  const server: McpServer = {
    id,
    name,
    url,
    description,
    status: 'disconnected',
    trustTier,
    transport,
    tools: new Map(),
    addedAt: new Date().toISOString(),
  };

  servers.set(id, server);
  log.info({ id, name, url, trustTier, transport }, 'MCP server registered');
  return server;
}

/**
 * Remove a server from the registry by ID.
 * @returns `true` if the server existed and was removed.
 */
export function removeMcpServer(id: string): boolean {
  const removed = servers.delete(id);
  if (removed) log.info({ id }, 'MCP server removed');
  return removed;
}

/** Return all registered servers. */
export function listMcpServers(): McpServer[] {
  return Array.from(servers.values());
}

/** Lookup a single server by ID. */
export function getMcpServer(id: string): McpServer | undefined {
  return servers.get(id);
}

/**
 * Update server connection status.
 * No-ops silently if the ID is unknown.
 */
export function updateServerStatus(id: string, status: McpServerStatus): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'updateServerStatus: unknown server id');
    return;
  }
  const oldStatus = s.status;
  s.status = status;
  if (status === 'connected') {
    s.lastConnectedAt = new Date().toISOString();
  }
  log.info({ id, name: s.name, oldStatus, newStatus: status }, 'Server status updated');
}

/**
 * Mark a server as connected.
 * No-ops silently if the ID is unknown.
 */
export function connectMcpServer(id: string): void {
  updateServerStatus(id, 'connected');
}

/** Mark a server as disconnected. */
export function disconnectMcpServer(id: string): void {
  updateServerStatus(id, 'disconnected');
}

/** Mark a server as having an error. */
export function setServerError(id: string, error: string): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'setServerError: unknown server id');
    return;
  }
  s.status = 'error';
  s.lastError = error;
  log.error({ id, name: s.name, error }, 'Server error recorded');
}

/** Return only servers that are currently connected. */
export function getConnectedServers(): McpServer[] {
  return Array.from(servers.values()).filter((s) => s.status === 'connected');
}

/** Update server trust tier. */
export function setServerTrustTier(id: string, tier: McpTrustTier): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'setServerTrustTier: unknown server id');
    return;
  }
  s.trustTier = tier;
  log.info({ id, name: s.name, tier }, 'Server trust tier updated');
}

// ---------------------------------------------------------------------------
// Tool management
// ---------------------------------------------------------------------------

/**
 * Update the list of discovered tools for a server.
 * @param id - Server ID
 * @param tools - Array of tool info objects
 */
export function updateServerTools(id: string, tools: McpToolInfo[]): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'updateServerTools: unknown server id');
    return;
  }
  s.tools = new Map(tools.map(t => [t.name, { ...t, discoveredAt: new Date().toISOString() }]));
  log.info({ id, toolCount: tools.length }, 'Server tools updated');
}

/** Get tools for a server. */
export function getServerTools(id: string): McpToolInfo[] {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'getServerTools: unknown server id');
    return [];
  }
  return Array.from(s.tools.values());
}

/** Get only enabled tools for a server. */
export function getEnabledServerTools(id: string): McpToolInfo[] {
  return getServerTools(id).filter(t => t.enabled);
}

/**
 * Enable or disable a specific tool on a server.
 * @param id - Server ID
 * @param toolName - Tool name to toggle
 * @param enabled - Whether to enable or disable
 * @returns `true` if the tool was found and updated
 */
export function setToolEnabled(id: string, toolName: string, enabled: boolean): boolean {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'setToolEnabled: unknown server id');
    return false;
  }
  const tool = s.tools.get(toolName);
  if (!tool) {
    log.warn({ id, tool: toolName }, 'setToolEnabled: tool not found');
    return false;
  }
  tool.enabled = enabled;
  log.info({ id, tool: toolName, enabled }, 'Tool enabled/disabled');
  return true;
}

/** Get server status summary for admin dashboard. */
export function getServerStatusSummary(): Array<{
  id: string;
  name: string;
  status: McpServerStatus;
  trustTier: McpTrustTier;
  transport: string;
  toolCount: number;
  enabledToolCount: number;
}> {
  return Array.from(servers.values()).map(s => ({
    id: s.id,
    name: s.name,
    status: s.status,
    trustTier: s.trustTier,
    transport: s.transport ?? 'http',
    toolCount: s.tools.size,
    enabledToolCount: Array.from(s.tools.values()).filter(t => t.enabled).length,
  }));
}
