/**
 * @file mcp-registry.ts
 * @description Upgrade 43 — MCP (Model Context Protocol) Server Registry.
 *
 * Tracks external MCP servers: registration, connection state, and lookup.
 * All state is in-process; persistence can be layered on top by callers.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('plugins:mcp-registry');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpServer {
  id: string;
  name: string;
  url: string;
  description?: string;
  tools?: string[];
  connected: boolean;
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
 * @returns The registered McpServer record.
 */
export function registerMcpServer(
  name: string,
  url: string,
  description?: string,
): McpServer {
  if (!name || typeof name !== 'string') throw new Error('McpRegistry: name is required');
  if (!url || typeof url !== 'string') throw new Error('McpRegistry: url is required');

  const id = `mcp-${Date.now()}`;
  const server: McpServer = {
    id,
    name,
    url,
    description,
    connected: false,
    addedAt: new Date().toISOString(),
  };

  servers.set(id, server);
  log.info({ id, name, url }, 'MCP server registered');
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
 * Mark a server as connected.
 * No-ops silently if the ID is unknown (avoids throwing on race conditions).
 */
export function connectMcpServer(id: string): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'connectMcpServer: unknown server id');
    return;
  }
  s.connected = true;
  log.info({ id, name: s.name }, 'MCP server connected');
}

/** Mark a server as disconnected. */
export function disconnectMcpServer(id: string): void {
  const s = servers.get(id);
  if (!s) {
    log.warn({ id }, 'disconnectMcpServer: unknown server id');
    return;
  }
  s.connected = false;
  log.info({ id, name: s.name }, 'MCP server disconnected');
}

/** Return only servers that are currently connected. */
export function getConnectedServers(): McpServer[] {
  return Array.from(servers.values()).filter((s) => s.connected);
}
