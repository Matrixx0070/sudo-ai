/**
 * @file tools/mcp-routes.ts
 * @description REST API routes for MCP server management.
 *
 * Provides admin endpoints for registering, connecting, and managing
 * MCP servers and their tools.
 */

import { createLogger } from '../shared/logger.js';
import {
  listMcpServers,
  getMcpServer,
  registerMcpServer,
  removeMcpServer,
  updateServerStatus,
  connectMcpServer,
  disconnectMcpServer,
  setServerError,
  getServerTools,
  setToolEnabled,
  getServerStatusSummary,
  McpTrustTier,
} from '../plugins/mcp-registry.js';
import { MCPAdapter, MCPServerConfig } from './mcp-adapter.js';

const log = createLogger('tools:mcp-routes');

// ---------------------------------------------------------------------------
// In-memory adapter registry (for active connections)
// ---------------------------------------------------------------------------

const activeAdapters: Map<string, MCPAdapter> = new Map();

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/admin/mcp/servers
 * List all registered MCP servers with their status.
 */
export async function handleListServers(): Promise<{
  status: number;
  body: unknown;
}> {
  // Check kill-switch
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return {
      status: 503,
      body: { error: 'MCP functionality disabled via SUDO_MCP_DISABLE' },
    };
  }

  const servers = getServerStatusSummary();
  return {
    status: 200,
    body: { servers },
  };
}

/**
 * POST /v1/admin/mcp/servers
 * Register a new MCP server.
 * Body: { name, url, description?, transport?, trustTier?, oauth?, accessToken?, toolFilter? }
 */
export async function handleRegisterServer(body: unknown): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return {
      status: 503,
      body: { error: 'MCP functionality disabled via SUDO_MCP_DISABLE' },
    };
  }

  if (!body || typeof body !== 'object') {
    return {
      status: 400,
      body: { error: 'Request body required' },
    };
  }

  const req = body as Record<string, unknown>;
  const name = req['name'] as string | undefined;
  const url = req['url'] as string | undefined;
  const description = req['description'] as string | undefined;
  const transport = req['transport'] as 'stdio' | 'http' | 'sse' | 'websocket' | undefined;
  const trustTier = req['trustTier'] as McpTrustTier | undefined;

  if (!name || typeof name !== 'string') {
    return { status: 400, body: { error: 'name is required (string)' } };
  }
  if (!url || typeof url !== 'string') {
    return { status: 400, body: { error: 'url is required (string)' } };
  }
  if (transport && !['stdio', 'http', 'sse', 'websocket'].includes(transport)) {
    return { status: 400, body: { error: 'transport must be stdio, http, sse, or websocket' } };
  }
  if (trustTier && !['bundled', 'indexed', 'unreviewed'].includes(trustTier)) {
    return { status: 400, body: { error: 'trustTier must be bundled, indexed, or unreviewed' } };
  }

  try {
    const server = registerMcpServer(
      name,
      url,
      description,
      trustTier ?? 'unreviewed',
      transport ?? 'http',
    );

    log.info({ id: server.id, name }, 'Server registered via REST');

    return {
      status: 201,
      body: { server: { ...server, tools: Array.from(server.tools.values()) } },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Failed to register server');
    return { status: 500, body: { error: msg } };
  }
}

/**
 * DELETE /v1/admin/mcp/servers/:id
 * Unregister an MCP server.
 */
export async function handleDeleteServer(serverId: string): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return {
      status: 503,
      body: { error: 'MCP functionality disabled via SUDO_MCP_DISABLE' },
    };
  }

  // Disconnect first if connected
  const adapter = activeAdapters.get(serverId);
  if (adapter) {
    try {
      await adapter.disconnect();
      activeAdapters.delete(serverId);
    } catch (err) {
      log.warn({ id: serverId, err: err instanceof Error ? err.message : String(err) }, 'Error disconnecting server');
    }
  }

  const removed = removeMcpServer(serverId);
  if (!removed) {
    return { status: 404, body: { error: 'Server not found' } };
  }

  return { status: 200, body: { success: true, id: serverId } };
}

/**
 * POST /v1/admin/mcp/servers/:id/connect
 * Connect to an MCP server.
 */
export async function handleConnectServer(serverId: string, body: unknown): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return { status: 503, body: { error: 'MCP functionality disabled' } };
  }

  const server = getMcpServer(serverId);
  if (!server) {
    return { status: 404, body: { error: 'Server not found' } };
  }

  // Check if already connected
  if (server.status === 'connected') {
    return { status: 200, body: { alreadyConnected: true, id: serverId } };
  }

  // Check if we have an active adapter
  let adapter = activeAdapters.get(serverId);
  if (!adapter) {
    // Create adapter from server config
    const config: MCPServerConfig = {
      id: serverId,
      transport: server.transport ?? 'http',
      baseUrl: server.url,
      accessToken: (body as Record<string, unknown> | undefined)?.['accessToken'] as string | undefined,
      oauth: (body as Record<string, unknown> | undefined)?.['oauth'] as MCPServerConfig['oauth'],
    };

    adapter = new MCPAdapter(config);
    activeAdapters.set(serverId, adapter);
  }

  try {
    updateServerStatus(serverId, 'connecting');
    await adapter.connect();

    // Discover tools
    const tools = await adapter.listTools();

    // Update registry with discovered tools
    const toolInfos = tools.map(t => ({
      name: t.name,
      description: t.description,
      enabled: t.enabled,
    }));

    // Import updateServerTools - need to add to exports
    // For now, we'll connect without updating tools
    connectMcpServer(serverId);

    log.info({ id: serverId, toolCount: tools.length }, 'Server connected');

    return {
      status: 200,
      body: {
        success: true,
        id: serverId,
        tools: tools.map(t => ({ name: t.name, enabled: t.enabled })),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ id: serverId, err: msg }, 'Failed to connect server');
    setServerError(serverId, msg);
    return { status: 500, body: { error: msg } };
  }
}

/**
 * POST /v1/admin/mcp/servers/:id/disconnect
 * Disconnect from an MCP server.
 */
export async function handleDisconnectServer(serverId: string): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return { status: 503, body: { error: 'MCP functionality disabled' } };
  }

  const server = getMcpServer(serverId);
  if (!server) {
    return { status: 404, body: { error: 'Server not found' } };
  }

  const adapter = activeAdapters.get(serverId);
  if (adapter) {
    try {
      await adapter.disconnect();
      activeAdapters.delete(serverId);
    } catch (err) {
      log.warn({ id: serverId, err: err instanceof Error ? err.message : String(err) }, 'Error disconnecting');
    }
  }

  disconnectMcpServer(serverId);
  log.info({ id: serverId }, 'Server disconnected');

  return { status: 200, body: { success: true, id: serverId } };
}

/**
 * GET /v1/admin/mcp/servers/:id/tools
 * List discovered tools for a server.
 */
export async function handleListTools(serverId: string): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return { status: 503, body: { error: 'MCP functionality disabled' } };
  }

  const server = getMcpServer(serverId);
  if (!server) {
    return { status: 404, body: { error: 'Server not found' } };
  }

  // Try to get tools from active adapter first
  const adapter = activeAdapters.get(serverId);
  if (adapter) {
    const tools = adapter.getCachedTools();
    return {
      status: 200,
      body: {
        serverId,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          enabled: t.enabled,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  // Fall back to registry
  const tools = getServerTools(serverId);
  return {
    status: 200,
    body: { serverId, tools },
  };
}

/**
 * POST /v1/admin/mcp/servers/:id/tools/:toolName/toggle
 * Enable or disable a specific tool.
 */
export async function handleToggleTool(
  serverId: string,
  toolName: string,
  body: unknown,
): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return { status: 503, body: { error: 'MCP functionality disabled' } };
  }

  const server = getMcpServer(serverId);
  if (!server) {
    return { status: 404, body: { error: 'Server not found' } };
  }

  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'Request body required' } };
  }

  const req = body as Record<string, unknown>;
  const enabled = req['enabled'] as boolean | undefined;

  if (typeof enabled !== 'boolean') {
    return { status: 400, body: { error: 'enabled (boolean) is required' } };
  }

  // Update in adapter if connected
  const adapter = activeAdapters.get(serverId);
  if (adapter) {
    adapter.setToolEnabled(toolName, enabled);
  }

  // Update in registry
  const updated = setToolEnabled(serverId, toolName, enabled);
  if (!updated) {
    return { status: 404, body: { error: 'Tool not found' } };
  }

  log.info({ id: serverId, tool: toolName, enabled }, 'Tool toggled via REST');

  return {
    status: 200,
    body: { success: true, serverId, tool: toolName, enabled },
  };
}

/**
 * GET /v1/admin/mcp/servers/:id/status
 * Get detailed status for a single server.
 */
export async function handleGetServerStatus(serverId: string): Promise<{
  status: number;
  body: unknown;
}> {
  if (process.env['SUDO_MCP_DISABLE'] === '1') {
    return { status: 503, body: { error: 'MCP functionality disabled' } };
  }

  const server = getMcpServer(serverId);
  if (!server) {
    return { status: 404, body: { error: 'Server not found' } };
  }

  const adapter = activeAdapters.get(serverId);
  const isConnected = adapter?.isConnected() ?? false;

  return {
    status: 200,
    body: {
      server: {
        ...server,
        tools: Array.from(server.tools.values()),
        isConnected,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration helper
// ---------------------------------------------------------------------------

/**
 * Register all MCP routes on a router.
 * Expected router interface:
 *   router.get(path, handler)
 *   router.post(path, handler)
 *   router.delete(path, handler)
 */
export function registerMcpRoutes(router: {
  get: (path: string, handler: (req: { params: Record<string, string>; body?: unknown }) => Promise<{ status: number; body: unknown }>) => void;
  post: (path: string, handler: (req: { params: Record<string, string>; body?: unknown }) => Promise<{ status: number; body: unknown }>) => void;
  delete: (path: string, handler: (req: { params: Record<string, string>; body?: unknown }) => Promise<{ status: number; body: unknown }>) => void;
}): void {
  router.get('/v1/admin/mcp/servers', async () => handleListServers());
  router.post('/v1/admin/mcp/servers', async (req) => handleRegisterServer(req.body));
  router.delete('/v1/admin/mcp/servers/:id', async (req) => handleDeleteServer(req.params['id']));
  router.post('/v1/admin/mcp/servers/:id/connect', async (req) => handleConnectServer(req.params['id'], req.body));
  router.post('/v1/admin/mcp/servers/:id/disconnect', async (req) => handleDisconnectServer(req.params['id']));
  router.get('/v1/admin/mcp/servers/:id/tools', async (req) => handleListTools(req.params['id']));
  router.get('/v1/admin/mcp/servers/:id/status', async (req) => handleGetServerStatus(req.params['id']));
  router.post('/v1/admin/mcp/servers/:id/tools/:toolName/toggle', async (req) =>
    handleToggleTool(req.params['id'], req.params['toolName'], req.body)
  );

  log.info('MCP REST routes registered');
}
