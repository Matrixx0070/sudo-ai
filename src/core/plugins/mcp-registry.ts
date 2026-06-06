/**
 * @file mcp-registry.ts
 * @description Upgrade 43 — MCP (Model Context Protocol) Server Registry.
 *
 * Tracks external MCP servers: registration, connection state, tool management,
 * trust tiers, and lookup.
 * All state is in-process; persistence can be layered on top by callers.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('plugins:mcp-registry');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Trust tier classification for MCP servers. */
export type McpTrustTier = 'bundled' | 'indexed' | 'unreviewed';

/** Transport type for MCP servers. */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'websocket';

/** Server connection status. */
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** A single tool exposed by an MCP server. */
export interface McpTool {
  name: string;
  description?: string;
  enabled: boolean;
  inputSchema?: unknown;
}

/** Summary entry for server status listing. */
export interface McpServerSummary {
  id: string;
  name: string;
  url: string;
  status: McpServerStatus;
  trustTier: McpTrustTier;
  transport: McpTransport;
  toolCount: number;
  enabledToolCount: number;
  error?: string;
}

/** A registered MCP server with full state. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  description?: string;
  status: McpServerStatus;
  trustTier: McpTrustTier;
  transport: McpTransport;
  tools: Map<string, McpTool>;
  error?: string;
  addedAt: string;
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
 * @param trustTier   - Trust tier (default 'unreviewed').
 * @param transport   - Transport type (default 'http').
 * @returns The registered McpServer record.
 */
export function registerMcpServer(
  name: string,
  url: string,
  description?: string,
  trustTier: McpTrustTier = 'unreviewed',
  transport: McpTransport = 'http',
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

// ---------------------------------------------------------------------------
// Server status management
// ---------------------------------------------------------------------------

/**
 * Update a server's connection status.
 * No-ops silently if the ID is unknown.
 */
export function updateServerStatus(id: string, status: McpServerStatus): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'updateServerStatus: unknown server id');
    return;
  }
  s.status = status;
  log.debug({ id, status }, 'Server status updated');
}

/**
 * Mark a server as connected.
 * No-ops silently if the ID is unknown (avoids throwing on race conditions).
 */
export function connectMcpServer(id: string): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'connectMcpServer: unknown server id');
    return;
  }
  s.status = 'connected';
  s.error = undefined;
  log.info({ id, name: s.name }, 'MCP server connected');
}

/** Mark a server as disconnected. */
export function disconnectMcpServer(id: string): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'disconnectMcpServer: unknown server id');
    return;
  }
  s.status = 'disconnected';
  log.info({ id, name: s.name }, 'MCP server disconnected');
}

/** Return only servers that are currently connected. */
export function getConnectedServers(): McpServer[] {
  return Array.from(servers.values()).filter((s) => s.status === 'connected');
}

// ---------------------------------------------------------------------------
// Trust tier management
// ---------------------------------------------------------------------------

/**
 * Set the trust tier for a server.
 * No-ops silently if the ID is unknown.
 */
export function setServerTrustTier(id: string, tier: McpTrustTier): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'setServerTrustTier: unknown server id');
    return;
  }
  s.trustTier = tier;
  log.info({ id, tier }, 'Server trust tier updated');
}

// ---------------------------------------------------------------------------
// Error tracking
// ---------------------------------------------------------------------------

/**
 * Set an error message on a server (e.g. from a failed connection).
 * No-ops silently if the ID is unknown.
 */
export function setServerError(id: string, error: string): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'setServerError: unknown server id');
    return;
  }
  s.error = error;
  s.status = 'error';
  log.warn({ id, error }, 'Server error set');
}

// ---------------------------------------------------------------------------
// Tool management
// ---------------------------------------------------------------------------

/**
 * Update the tool list for a server. Replaces the existing tool set.
 * No-ops silently if the ID is unknown.
 */
export function updateServerTools(id: string, tools: McpTool[]): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'updateServerTools: unknown server id');
    return;
  }
  s.tools.clear();
  for (const tool of tools) {
    s.tools.set(tool.name, tool);
  }
  log.info({ id, toolCount: tools.length }, 'Server tools updated');
}

/**
 * Get all tools for a server.
 * Returns an empty array if the server is unknown.
 */
export function getServerTools(id: string): McpTool[] {
  const s = servers.get(id);
  if (!s) return [];
  return Array.from(s.tools.values());
}

/**
 * Get only enabled tools for a server.
 * Returns an empty array if the server is unknown.
 */
export function getEnabledServerTools(id: string): McpTool[] {
  const s = servers.get(id);
  if (!s) return [];
  return Array.from(s.tools.values()).filter((t) => t.enabled);
}

/**
 * Enable or disable a specific tool on a server.
 * @returns `true` if the tool was found and updated, `false` otherwise.
 */
export function setToolEnabled(id: string, toolName: string, enabled: boolean): boolean {
  const s = servers.get(id);
  if (!s) return false;

  const tool = s.tools.get(toolName);
  if (!tool) return false;

  tool.enabled = enabled;
  log.debug({ id, toolName, enabled }, 'Tool enabled state toggled');
  return true;
}

// ---------------------------------------------------------------------------
// Status summary
// ---------------------------------------------------------------------------

/**
 * Get a summary of all registered servers (for listing endpoints).
 */
export function getServerStatusSummary(): McpServerSummary[] {
  return Array.from(servers.values()).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    status: s.status,
    trustTier: s.trustTier,
    transport: s.transport,
    toolCount: s.tools.size,
    enabledToolCount: Array.from(s.tools.values()).filter((t) => t.enabled).length,
    error: s.error,
  }));
}